'use strict';

// CacheService: tetos por categoria, teto global, LRU (touch), limpeza por categoria e arquivos temporários velhos.
// O teto de previews já é coberto em library-media-hardening.test.js (RK-047); aqui o resto.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CacheService = require('../src/core/CacheService');

const KB = 1024;

function setup(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-cache-'));
  const dirs = {
    dataDir,
    thumbnailsDir: path.join(dataDir, 'thumbs'),
    waveformsDir: path.join(dataDir, 'waves'),
    tempDir: path.join(dataDir, 'tmp-main') // != dataDir/temp (no Windows 'Temp' e 'temp' seriam a mesma pasta)
  };
  for (const d of [dirs.thumbnailsDir, dirs.waveformsDir, dirs.tempDir]) fs.mkdirSync(d, { recursive: true });
  const svc = new CacheService(dirs, options);
  const cleanup = () => fs.rmSync(dataDir, { recursive: true, force: true });
  return { svc, dirs, cleanup };
}

/** Cria arquivo de `kb` KB com idade `ageSec` (atime e mtime iguais, para o LRU ser determinístico). */
function put(dir, name, kb, ageSec) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, Buffer.alloc(kb * KB, 1));
  const t = new Date(Date.now() - ageSec * 1000);
  fs.utimesSync(f, t, t);
  return f;
}

test('getCacheInfo soma por categoria (inclui o "temp" minúsculo do dataDir) e o total', () => {
  const { svc, dirs, cleanup } = setup();
  try {
    put(dirs.thumbnailsDir, 'a.jpg', 10, 5);
    put(dirs.waveformsDir, 'w.wfm', 20, 5);
    put(dirs.tempDir, 't.tmp', 30, 5);
    fs.mkdirSync(path.join(dirs.dataDir, 'temp'), { recursive: true });
    put(path.join(dirs.dataDir, 'temp'), 'u.tmp', 40, 5);
    const info = svc.getCacheInfo();
    const by = Object.fromEntries(info.categories.map((c) => [c.key, c.sizeBytes]));
    assert.equal(by.thumbnails, 10 * KB);
    assert.equal(by.waveforms, 20 * KB);
    assert.equal(by.temp, 70 * KB);
    assert.equal(info.totalBytes, 100 * KB);
  } finally { cleanup(); }
});

test('teto de waveforms: remove os mais antigos primeiro e para ao ficar sob o teto', () => {
  const { svc, dirs, cleanup } = setup({ autoClean: true, maxSizeMB: 0, waveformsMaxMB: 40 / 1024 }); // 40 KB
  try {
    put(dirs.waveformsDir, 'velho.wfm', 20, 300);
    put(dirs.waveformsDir, 'meio.wfm', 20, 200);
    put(dirs.waveformsDir, 'novo.wfm', 20, 100);
    const r = svc.autoCleanIfNeeded();
    assert.equal(r.trimmed, true);
    assert.deepEqual(fs.readdirSync(dirs.waveformsDir).sort(), ['meio.wfm', 'novo.wfm']);
  } finally { cleanup(); }
});

test('LRU de verdade: touch() salva um arquivo velho de ser removido', () => {
  const { svc, dirs, cleanup } = setup({ autoClean: true, maxSizeMB: 0, waveformsMaxMB: 40 / 1024 });
  try {
    const velho = put(dirs.waveformsDir, 'velho.wfm', 20, 300);
    put(dirs.waveformsDir, 'meio.wfm', 20, 200);
    put(dirs.waveformsDir, 'novo.wfm', 20, 100);
    svc.touch(velho); // usado agora
    svc.autoCleanIfNeeded();
    assert.deepEqual(fs.readdirSync(dirs.waveformsDir).sort(), ['novo.wfm', 'velho.wfm']);
  } finally { cleanup(); }
});

test('teto global: corta proporcionalmente, pelos mais antigos, e respeita autoClean=false', () => {
  const { svc, dirs, cleanup } = setup({ autoClean: false, maxSizeMB: 120 / 1024, waveformsMaxMB: 0 }); // 120 KB
  try {
    put(dirs.thumbnailsDir, 't1.jpg', 30, 400);
    put(dirs.thumbnailsDir, 't2.jpg', 30, 300);
    put(dirs.thumbnailsDir, 't3.jpg', 30, 10);
    put(dirs.tempDir, 'x1.tmp', 30, 400);
    put(dirs.tempDir, 'x2.tmp', 30, 300);
    put(dirs.tempDir, 'x3.tmp', 30, 10);
    assert.deepEqual(svc.autoCleanIfNeeded(), { trimmed: false }, 'desligado: não mexe');
    assert.equal(fs.readdirSync(dirs.thumbnailsDir).length, 3);

    svc.updateSettings({ autoClean: true });
    const r = svc.autoCleanIfNeeded();
    assert.equal(r.trimmed, true);
    assert.ok(svc.getCacheInfo().totalBytes <= 120 * KB, 'ficou dentro do teto');
    assert.deepEqual(fs.readdirSync(dirs.thumbnailsDir).sort(), ['t2.jpg', 't3.jpg'], 'só o mais antigo de cada categoria saiu');
    assert.deepEqual(fs.readdirSync(dirs.tempDir).sort(), ['x2.tmp', 'x3.tmp']);
  } finally { cleanup(); }
});

test('teto global em versão assíncrona também fica dentro do limite', async () => {
  const { svc, dirs, cleanup } = setup({ autoClean: true, maxSizeMB: 50 / 1024, waveformsMaxMB: 30 / 1024 });
  try {
    put(dirs.waveformsDir, 'w1.wfm', 25, 300);
    put(dirs.waveformsDir, 'w2.wfm', 25, 100);
    put(dirs.thumbnailsDir, 't1.jpg', 40, 200);
    const r = await svc.autoCleanIfNeededAsync();
    assert.equal(r.trimmed, true);
    const info = await svc.getCacheInfoAsync();
    assert.ok(info.totalBytes <= 50 * KB, `total ${info.totalBytes}`);
    assert.ok(!fs.existsSync(path.join(dirs.waveformsDir, 'w1.wfm')), 'teto de waveforms tira o mais velho');
  } finally { cleanup(); }
});

test('abaixo do teto nada é removido', () => {
  const { svc, dirs, cleanup } = setup({ autoClean: true, maxSizeMB: 10 });
  try {
    put(dirs.thumbnailsDir, 'a.jpg', 100, 100);
    assert.deepEqual(svc.autoCleanIfNeeded(), { trimmed: false });
    assert.equal(fs.readdirSync(dirs.thumbnailsDir).length, 1);
  } finally { cleanup(); }
});

test('clearCache(categoria) limpa só aquela categoria; sem argumento limpa tudo', () => {
  const { svc, dirs, cleanup } = setup();
  try {
    put(dirs.thumbnailsDir, 'a.jpg', 10, 1);
    fs.mkdirSync(path.join(dirs.waveformsDir, 'sub'));
    put(path.join(dirs.waveformsDir, 'sub'), 'w.wfm', 20, 1);
    const r = svc.clearCache('waveforms');
    assert.equal(r.totalBytesFreed, 20 * KB);
    assert.equal(fs.existsSync(path.join(dirs.thumbnailsDir, 'a.jpg')), true);
    assert.equal(fs.existsSync(path.join(dirs.waveformsDir, 'sub')), false, 'pasta vazia também some');
    const all = svc.clearCache();
    assert.equal(all.totalBytesFreed, 10 * KB);
    assert.equal(svc.getCacheInfo().totalBytes, 0);
    assert.equal(svc.clearCache('nao-existe').totalBytesFreed, 0);
  } finally { cleanup(); }
});

test('cleanStaleTempFiles remove só temporários velhos e nunca toca em thumbnails/waveforms', async () => {
  const { svc, dirs, cleanup } = setup();
  try {
    const velho = put(dirs.tempDir, 'velho.tmp', 5, 7200);
    const novo = put(dirs.tempDir, 'novo.tmp', 5, 10);
    const thumbVelha = put(dirs.thumbnailsDir, 'velha.jpg', 5, 99999);
    const r = svc.cleanStaleTempFiles(3600 * 1000);
    assert.equal(r.filesRemoved, 1);
    assert.equal(fs.existsSync(velho), false);
    assert.equal(fs.existsSync(novo), true);
    assert.equal(fs.existsSync(thumbVelha), true);

    const velho2 = put(dirs.tempDir, 'velho2.tmp', 5, 7200);
    const r2 = await svc.cleanStaleTempFilesAsync(3600 * 1000);
    assert.equal(r2.filesRemoved, 1);
    assert.equal(fs.existsSync(velho2), false);
    assert.equal(fs.existsSync(novo), true);
  } finally { cleanup(); }
});

test('updateSettings ignora valores inválidos (negativos, tipos errados)', () => {
  const { svc, cleanup } = setup({ maxSizeMB: 100 });
  try {
    svc.updateSettings({ maxSizeMB: -1, autoClean: 'sim', waveformsMaxMB: '5', previewsMaxMB: -3 });
    assert.equal(svc.maxSizeMB, 100);
    assert.equal(svc.autoClean, false);
    assert.equal(svc.waveformsMaxMB, 200);
    assert.equal(svc.previewsMaxMB, 300);
    svc.updateSettings({ maxSizeMB: 0, autoClean: true, waveformsMaxMB: 7 });
    assert.equal(svc.maxSizeMB, 0);
    assert.equal(svc.autoClean, true);
    assert.equal(svc.waveformsMaxMB, 7);
  } finally { cleanup(); }
});

test('_formatBytes usa unidades legíveis', () => {
  const { svc, cleanup } = setup();
  try {
    assert.equal(svc._formatBytes(0), '0 B');
    assert.equal(svc._formatBytes(1536), '1.50 KB');
    assert.equal(svc._formatBytes(5 * 1024 * 1024), '5.00 MB');
  } finally { cleanup(); }
});

test('getCacheInfo não soma duas vezes quando data/Temp e data/temp são a mesma pasta (Windows)', { skip: process.platform !== 'win32' }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-cache-'));
  try {
    const dirs = { dataDir, thumbnailsDir: path.join(dataDir, 'thumbs'), waveformsDir: path.join(dataDir, 'waves'), tempDir: path.join(dataDir, 'Temp') };
    for (const d of [dirs.thumbnailsDir, dirs.waveformsDir, dirs.tempDir]) fs.mkdirSync(d, { recursive: true });
    put(dirs.tempDir, 't.tmp', 10, 5);
    const temp = new CacheService(dirs).getCacheInfo().categories.find((c) => c.key === 'temp');
    assert.equal(temp.sizeBytes, 10 * KB);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
