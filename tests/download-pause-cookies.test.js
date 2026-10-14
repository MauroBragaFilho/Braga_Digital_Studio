'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DownloadManager = require('../src/services/downloadService');
const { inspectCookiesFile, cookiesFileFor, isYouTubeUrl } = require('../src/services/youtubeCookies');
const SettingsManager = require('../src/core/settings/SettingsManager');

const { readPauseSettings, pickPauseMs } = DownloadManager;

// ---------------------------------------------------------------- pausa entre downloads

test('pausa: padrão 10 s a 3 min, ligada', () => {
  assert.deepEqual(readPauseSettings({}), { enabled: true, minSec: 10, maxSec: 180 });
});

test('pausa: valores inválidos voltam ao padrão e mínimo nunca passa do máximo', () => {
  assert.deepEqual(readPauseSettings({ downloadPauseMinSec: 'x', downloadPauseMaxSec: null }), { enabled: true, minSec: 10, maxSec: 180 });
  assert.deepEqual(readPauseSettings({ downloadPauseMinSec: 90, downloadPauseMaxSec: 30 }), { enabled: true, minSec: 90, maxSec: 90 });
  assert.equal(readPauseSettings({ downloadPauseMaxSec: 99999 }).maxSec, 600);
  assert.equal(readPauseSettings({ downloadPauseEnabled: false }).enabled, false);
});

test('pausa: o sorteio fica sempre dentro da faixa', () => {
  const range = { minSec: 10, maxSec: 180 };
  assert.equal(pickPauseMs(range, () => 0), 10000);
  assert.equal(pickPauseMs(range, () => 1), 180000);
  for (let i = 0; i < 500; i++) {
    const ms = pickPauseMs(range);
    assert.ok(ms >= 10000 && ms <= 180000, String(ms));
  }
});

function manager(settings = {}) {
  const m = Object.create(DownloadManager.prototype);
  require('node:events').EventEmitter.call(m);
  m.isPaused = false;
  m.getSettings = () => settings;
  return m;
}

test('espera entre itens: termina sozinha, avisa início e fim', async () => {
  const m = manager();
  const events = [];
  m.on('downloads:wait', (e) => events.push(e));
  const t0 = Date.now();
  const done = await m._waitBetweenItems(300);
  assert.equal(done, true);
  assert.ok(Date.now() - t0 >= 280);
  assert.ok(events[0].until > t0 && events.at(-1).until === null);
  assert.equal(m.getWaitState().until, null);
});

test('espera entre itens: "pular" e "pausar" encerram antes do tempo', async () => {
  const m = manager();
  setTimeout(() => m.skipWait(), 100);
  const t0 = Date.now();
  assert.equal(await m._waitBetweenItems(60000), false);
  assert.ok(Date.now() - t0 < 2000);

  const m2 = manager();
  setTimeout(() => { m2.isPaused = true; }, 100);
  const t1 = Date.now();
  assert.equal(await m2._waitBetweenItems(60000), false);
  assert.ok(Date.now() - t1 < 2000);
});

test('configurações: pausa tem padrão e é validada ao salvar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-pause-'));
  const sm = new SettingsManager(dir, dir);
  const d = sm.load();
  assert.equal(d.downloadPauseEnabled, true);
  assert.equal(d.downloadPauseMinSec, 10);
  assert.equal(d.downloadPauseMaxSec, 180);
  const saved = sm.save({ downloadPauseMinSec: 500, downloadPauseMaxSec: 20, downloadPauseEnabled: 'sim' });
  assert.equal(saved.downloadPauseEnabled, false); // só true booleano liga
  assert.equal(saved.downloadPauseMinSec, 500);
  assert.equal(saved.downloadPauseMaxSec, 500); // máximo nunca menor que o mínimo
  assert.equal(sm.save({ downloadPauseMinSec: 'abc' }).downloadPauseMinSec, 500); // inválido é ignorado
});

// ---------------------------------------------------------------- cookies do YouTube

function cookiesFile(lines) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bds-ck-')), 'youtube_cookies.txt');
  fs.writeFileSync(f, `# Netscape HTTP Cookie File\n${lines.join('\n')}\n`);
  return f;
}
const row = (domain, name, expiry) => `${domain}\tTRUE\t/\tTRUE\t${expiry}\t${name}\tvalor`;
const FUTURE = Math.floor(Date.now() / 1000) + 86400 * 30;
const PAST = Math.floor(Date.now() / 1000) - 3600;

test('cookies: sessão da conta válida é reconhecida, com a data de validade', () => {
  const f = cookiesFile([row('.youtube.com', '__Secure-3PSID', FUTURE), row('.youtube.com', 'PREF', FUTURE)]);
  const info = inspectCookiesFile(f);
  assert.equal(info.valid, true);
  assert.equal(info.expiresAt, FUTURE * 1000);
});

test('cookies: só rastreamento (sem cookie de conta) ou expirados não valem', () => {
  assert.equal(inspectCookiesFile(cookiesFile([row('.youtube.com', 'PREF', FUTURE), row('.youtube.com', 'YSC', 0)])).valid, false);
  const expired = inspectCookiesFile(cookiesFile([row('.youtube.com', 'SID', PAST), row('.youtube.com', '__Secure-3PSID', PAST)]));
  assert.equal(expired.valid, false);
  assert.match(expired.reason, /expirada/);
  assert.equal(inspectCookiesFile(path.join(os.tmpdir(), 'nao-existe-bds.txt')).valid, false);
  assert.equal(inspectCookiesFile(null).valid, false);
});

test('cookies: cookie de sessão (sem data) e linha #HttpOnly_ contam como válidos', () => {
  const f = cookiesFile([`#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalor`]);
  const info = inspectCookiesFile(f);
  assert.equal(info.valid, true);
  assert.equal(info.expiresAt, null);
});

test('cookies: só entregues a links do YouTube', () => {
  const f = cookiesFile([row('.youtube.com', 'SID', FUTURE)]);
  assert.equal(cookiesFileFor('https://www.youtube.com/watch?v=abc', f), f);
  assert.equal(cookiesFileFor('https://youtu.be/abc', f), f);
  assert.equal(cookiesFileFor('https://exemplo.com/video', f), null);
  assert.equal(cookiesFileFor('https://youtube.com.evil.example/x', f), null);
  assert.equal(isYouTubeUrl('nao é url'), false);
});

test('cookies: o arquivo relido muda de resultado quando é atualizado', () => {
  const f = cookiesFile([row('.youtube.com', 'SID', PAST)]);
  assert.equal(inspectCookiesFile(f).valid, false);
  fs.writeFileSync(f, `${row('.youtube.com', 'SID', FUTURE)}\n`);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f, later, later);
  assert.equal(inspectCookiesFile(f).valid, true);
});

// ---------------------------------------------------------------- codec do vídeo baixado

test('codec do vídeo: automático mantém o seletor padrão de MP4', () => {
  const { buildVideoFormat } = DownloadManager;
  assert.equal(buildVideoFormat('best', 'auto'), 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best');
  assert.equal(buildVideoFormat('1080', undefined), 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/best[height<=1080]');
});

test('codec do vídeo: H.264, H.265 e AV1 tentam o codec primeiro e caem no automático', () => {
  const { buildVideoFormat } = DownloadManager;
  const auto = buildVideoFormat('best', 'auto');
  const h264 = buildVideoFormat('best', 'h264');
  assert.ok(h264.startsWith('bv*[vcodec^=avc1]+ba[ext=m4a]/'));
  assert.ok(h264.endsWith(`/${auto}`));
  assert.ok(buildVideoFormat('720', 'av1').includes('bv*[height<=720][vcodec^=av01]+ba'));
  const h265 = buildVideoFormat('best', 'h265');
  assert.ok(h265.includes('[vcodec^=hev1]') && h265.includes('[vcodec^=hvc1]'));
  assert.equal(buildVideoFormat('best', 'vp9'), auto, 'valor desconhecido vira automático');
});

test('codec do vídeo: configuração aceita só as quatro opções', () => {
  const sm = Object.create(SettingsManager.prototype);
  for (const c of DownloadManager.VIDEO_CODECS) assert.equal(sm._sanitize({ downloadVideoCodec: c }).downloadVideoCodec, c);
  assert.equal('downloadVideoCodec' in sm._sanitize({ downloadVideoCodec: 'vp9' }), false);
});

test('codec do vídeo: rótulo lido do ffprobe (nome do codec e altura)', () => {
  const { videoCodecLabel } = DownloadManager;
  assert.equal(videoCodecLabel({ codec_type: 'video', codec_name: 'h264', height: 1080 }), 'H.264 · 1080p');
  assert.equal(videoCodecLabel({ codec_type: 'video', codec_name: 'hevc', height: 2160 }), 'H.265 · 2160p');
  assert.equal(videoCodecLabel({ codec_type: 'video', codec_name: 'av1', height: 720 }), 'AV1 · 720p');
  assert.equal(videoCodecLabel({ codec_type: 'video', codec_name: 'prores' }), 'PRORES');
  assert.equal(videoCodecLabel({ codec_type: 'audio', codec_name: 'aac' }), '');
  assert.equal(videoCodecLabel(undefined), '');
});
