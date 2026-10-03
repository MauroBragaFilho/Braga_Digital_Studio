'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-wf-'));
process.env.BMD_LOGS_DIR = path.join(tmp, 'logs');
const WaveformService = require('../src/core/projects/WaveformService');

const ffmpeg = path.join(__dirname, '..', 'data', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const hasFfmpeg = fs.existsSync(ffmpeg);

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeService(name) {
  return new WaveformService({ ffmpegPath: ffmpeg, cacheDir: path.join(tmp, name) });
}

test('migra o cache JSON antigo para binário sob demanda, entregando o mesmo formato', async () => {
  const svc = makeService('legacy');
  const legacy = {
    version: 1, uuid: 'abc', stream_index: 0, duration: 3.5, peaks_per_second: 100,
    peaks: [0, 0.5, 1, 0.25, 0.0039]
  };
  fs.writeFileSync(svc.getLegacyCachePath('abc'), JSON.stringify(legacy));
  assert.ok(svc.hasCache('abc'));

  const out = await svc.readCache('abc');
  assert.deepStrictEqual(out, legacy, 'o JSON legado é devolvido como estava');
  await new Promise((r) => setTimeout(r, 50)); // unlink do legado é assíncrono
  assert.ok(fs.existsSync(svc.getCachePath('abc')), 'cache binário criado');
  assert.ok(!fs.existsSync(svc.getLegacyCachePath('abc')), 'JSON legado removido após migrar');

  const again = await svc.readCache('abc');
  assert.strictEqual(again.peaks_per_second, 100);
  assert.strictEqual(again.duration, 3.5);
  assert.strictEqual(again.peaks.length, 5);
  assert.ok(again.peaks.every((p, i) => Math.abs(p - legacy.peaks[i]) <= 1 / 255), 'quantização de 1 byte (<= 1/255)');
});

test('cache binário corrompido é descartado (retorna null)', async () => {
  const svc = makeService('corrupt');
  fs.writeFileSync(svc.getCachePath('bad'), Buffer.from('lixo qualquer que nao e um wfm'));
  assert.strictEqual(await svc.readCache('bad'), null);
});

test('deleteCache remove binário e legado; hasCache reflete', () => {
  const svc = makeService('del');
  fs.writeFileSync(svc.getCachePath('x', 2), Buffer.alloc(30));
  fs.writeFileSync(svc.getLegacyCachePath('x', 2), '{}');
  assert.ok(svc.hasCache('x', 2));
  svc.deleteCache('x', 2);
  assert.ok(!svc.hasCache('x', 2));
});

test('gera picos reais com o ffmpeg, grava .wfm pequeno e relê do cache', { skip: !hasFfmpeg && 'data/ffmpeg ausente' }, async () => {
  const svc = makeService('real');
  const media = path.join(tmp, 'tone.wav');
  // 4 s: 2 s de tom + 2 s de silêncio
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "sine=f=440:r=16000:d=4,volume='lt(t,2)':eval=frame", media]);
  assert.strictEqual(r.status, 0);

  const wf = await svc.getOrGenerate({ uuid: 'tone', filePath: media, peaksPerSecond: 50 });
  assert.strictEqual(wf.peaks_per_second, 50);
  assert.ok(Math.abs(wf.peaks.length - 200) <= 2, `esperava ~200 picos, veio ${wf.peaks.length}`);
  const loud = wf.peaks.slice(10, 90);
  const quiet = wf.peaks.slice(110, 190);
  assert.ok(Math.min(...loud) > 0.08, 'trecho com tom tem picos altos');
  assert.ok(Math.max(...quiet) < 0.02, 'trecho silencioso tem picos ~0');

  const file = svc.getCachePath('tone');
  assert.ok(fs.existsSync(file));
  assert.ok(fs.statSync(file).size < 24 + 210, 'cache binário: 24 bytes + 1 byte/pico');

  const cached = await svc.getOrGenerate({ uuid: 'tone', filePath: path.join(tmp, 'nao-usado.wav'), peaksPerSecond: 50 });
  assert.deepStrictEqual(cached.peaks, wf.peaks, 'segunda chamada vem do cache (arquivo de origem nem é aberto)');

  // resolução diferente => regenera
  const wf2 = await svc.getOrGenerate({ uuid: 'tone', filePath: media, peaksPerSecond: 100 });
  assert.strictEqual(wf2.peaks_per_second, 100);
});
