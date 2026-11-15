'use strict';

// FFmpeg para placa NVIDIA: qual pacote baixar conforme o driver, e o conserto automático (troca única para a versão estável)
// quando o NVENC falha por versão de driver. Computadores onde a placa funciona (ou sem NVIDIA) nunca são tocados.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { candidatesFor, oldNvidiaDriver, nvidiaDriverMajor, MASTER, STABLE } = require('../src/infrastructure/external-tools/FfmpegChannel');
const { FfmpegAutoFix, isNvencVersionError, isDevBuildVersion, MAX_TRIES } = require('../src/infrastructure/external-tools/FfmpegAutoFix');
const { resolveDownloadUrl } = require('../src/infrastructure/external-tools/ToolSources');

test('pacote certo para o driver: estável só com NVIDIA abaixo de 610 (ou NVENC que já falhou)', () => {
  assert.equal(oldNvidiaDriver(597), true);
  assert.equal(oldNvidiaDriver(610), false);
  assert.equal(oldNvidiaDriver(null), false);
  assert.equal(candidatesFor(null)[0], MASTER, 'sem NVIDIA: desenvolvimento');
  assert.equal(candidatesFor(612)[0], MASTER, 'driver novo: desenvolvimento');
  assert.equal(candidatesFor(597)[0], STABLE[0], 'driver antigo: estável');
  assert.equal(candidatesFor(612, true)[0], STABLE[0], 'NVENC já falhou aqui: estável');
  assert.ok(candidatesFor(597).includes(MASTER), 'a de desenvolvimento fica como último recurso');
});

test('fonte do FFmpeg no Windows: a URL segue o driver e só usa o que a release publica', () => {
  const url = (ctx) => resolveDownloadUrl('ffmpeg', null, 'win32', 'x64', ctx);
  assert.match(url(null), /ffmpeg-master-latest-win64-gpl\.zip$/);
  assert.match(url({ driver: 597 }), /ffmpeg-n8\.1-latest-win64-gpl-8\.1\.zip$/);
  assert.match(url({ driver: 597, available: new Set([STABLE[1], MASTER]) }), /n9\.0/, 'a 8.1 saiu da release: vale a próxima');
  assert.match(url({ preferStable: true, available: new Set() }), /n8\.1/, 'lista vazia não filtra');
  assert.match(resolveDownloadUrl('ffprobe', null, 'win32', 'x64', { driver: 597 }), /n8\.1/, 'ffprobe vem no mesmo pacote');
  assert.match(resolveDownloadUrl('ffmpeg', null, 'linux', 'x64', { driver: 597 }), /linux64/, 'Linux não muda');
});

test('driver NVIDIA lido do nvidia-smi: o menor número principal; sem a ferramenta, null', async () => {
  const run = async () => '597.06\n572.16\n';
  assert.equal(await nvidiaDriverMajor({ run, platform: 'win32', env: {} }), 572);
  assert.equal(await nvidiaDriverMajor({ run: async () => { throw new Error('não existe'); }, platform: 'win32', env: {} }), null);
  assert.equal(await nvidiaDriverMajor({ run: async () => 'lixo', platform: 'linux' }), null);
});

test('detecção do erro do NVENC e da versão de desenvolvimento', () => {
  assert.equal(isNvencVersionError('[h264_nvenc] Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0'), true);
  assert.equal(isNvencVersionError('The minimum required Nvidia driver for nvenc is 610.00 or newer'), true);
  assert.equal(isNvencVersionError('Cannot load nvcuda.dll'), false);
  assert.equal(isDevBuildVersion('ffmpeg version N-123456-gabcdef1234-20261114 Copyright'), true);
  assert.equal(isDevBuildVersion('ffmpeg version n8.1-3-gabc Copyright'), false);
  assert.equal(isDevBuildVersion(null), false);
});

function fix(over = {}) {
  const calls = { update: [], saved: [], fixed: 0 };
  let settings = over.settings || {};
  const updater = { ffmpegPreferStable: false, update: async (...a) => { calls.update.push(a); if (over.updateFails) throw new Error('sem rede'); } };
  const af = new FfmpegAutoFix({
    updater,
    getSettings: () => settings,
    saveSettings: (p) => { calls.saved.push(p); settings = { ...settings, ...p }; },
    getFfmpegVersion: async () => (over.version === undefined ? 'ffmpeg version N-1-gabc' : over.version),
    isBusy: () => Boolean(over.busy),
    onFixed: () => { calls.fixed++; },
    logger: { info() {}, warn() {} },
    now: () => over.now || 1000
  });
  return { af, calls, updater, get settings() { return settings; } };
}
const NVENC_ERR = '[h264_nvenc] Driver does not support the required nvenc API version';

test('conserto: NVENC falhou por driver antigo com FFmpeg de desenvolvimento → troca uma vez pela estável e lembra', async () => {
  const f = fix();
  const r = await f.af.check(NVENC_ERR);
  assert.equal(r.acao, 'trocou');
  assert.deepEqual(f.calls.update, [['ffmpeg', null, { force: true }]]);
  assert.equal(f.updater.ffmpegPreferStable, true);
  assert.equal(f.settings.ffmpegCanal, 'estavel');
  assert.equal(f.settings.ffmpegAutoFix.tentativas, 1);
  assert.equal(f.calls.fixed, 1);
  // um novo app já nasce no canal estável
  const g = fix({ settings: { ffmpegCanal: 'estavel' } });
  g.af.applyChannel();
  assert.equal(g.updater.ffmpegPreferStable, true);
});

test('conserto: não mexe quando não é o caso (outro erro, já estável, ocupado, limite de tentativas, intervalo)', async () => {
  assert.equal((await fix().af.check('Cannot load nvcuda.dll')).acao, 'nada');
  assert.equal((await fix({ version: 'ffmpeg version n8.1-1-gabc' }).af.check(NVENC_ERR)).acao, 'nada');
  assert.equal((await fix({ version: null }).af.check(NVENC_ERR)).acao, 'nada', 'sem saber a versão, não troca');
  const busy = fix({ busy: true });
  assert.equal((await busy.af.check(NVENC_ERR)).acao, 'aguardando');
  assert.equal(busy.calls.update.length, 0);
  assert.equal(busy.calls.saved.length, 0, 'ocupado: nem anota tentativa');
  assert.equal((await fix({ settings: { ffmpegAutoFix: { tentativas: MAX_TRIES, ultima: 0 } } }).af.check(NVENC_ERR)).acao, 'nada');
  assert.equal((await fix({ now: 1000, settings: { ffmpegAutoFix: { tentativas: 1, ultima: 500 } } }).af.check(NVENC_ERR)).acao, 'aguardando');
});

test('conserto: falha no download anota a tentativa (sem laço) e devolve o motivo; chamadas em paralelo trocam uma vez só', async () => {
  const f = fix({ updateFails: true });
  const r = await f.af.check(NVENC_ERR);
  assert.equal(r.acao, 'falhou');
  assert.equal(f.settings.ffmpegAutoFix.tentativas, 1);
  assert.equal(f.calls.fixed, 0);
  const g = fix();
  const [a, b] = await Promise.all([g.af.check(NVENC_ERR), g.af.check(NVENC_ERR)]);
  assert.deepEqual([a.acao, b.acao].sort(), ['nada', 'trocou']);
  assert.equal(g.calls.update.length, 1);
});
