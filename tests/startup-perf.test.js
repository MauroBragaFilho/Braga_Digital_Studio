'use strict';

// Inicialização otimizada: ordem das etapas de segundo plano, requires sob demanda, portão do renderer,
// execução fora da thread principal e o diagnóstico BDS_PERF (desligado por padrão).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ─── Etapas de segundo plano ────────────────────────────────────────────────────────────────

test('buildBackgroundSteps: todas as tarefas de segundo plano continuam existindo, na ordem esperada', () => {
  const { buildBackgroundSteps } = require('../src/bootstrap/startup');
  const steps = buildBackgroundSteps({ services: {}, paths: {}, appPaths: {}, settingsManager: {}, getMainWindow: () => null });
  assert.deepEqual(steps.map(([name]) => name), ['watchers', 'bdsm-auth', 'discovery', 'deadlines', 'cache-maintenance']);
  for (const [, fn] of steps) assert.equal(typeof fn, 'function');
});

test('startBackgroundServices: roda cada etapa na ordem, cede o processo entre elas e não perde nenhuma após uma falha', async () => {
  const { startBackgroundServices } = require('../src/bootstrap/startup');
  const events = [];
  const steps = [
    ['a', () => events.push('a')],
    ['falha', () => { events.push('falha'); throw new Error('boom'); }],
    ['c', () => events.push('c')],
  ];
  const ran = await startBackgroundServices({}, { steps, yieldFn: async () => { events.push('yield'); } });
  assert.deepEqual(ran, ['a', 'falha', 'c']);
  assert.deepEqual(events, ['a', 'yield', 'falha', 'yield', 'c', 'yield']);
});

test('startup.js não carrega descoberta de dispositivos, câmera Sony nem notificador de prazos ao ser requerido', () => {
  const child = spawnSync(process.execPath, ['-e', `
    process.env.BMD_LOGS_DIR = require('node:os').tmpdir();
    require(${JSON.stringify(path.join(ROOT, 'src', 'bootstrap', 'startup.js'))});
    const loaded = Object.keys(require.cache).map((f) => f.replace(/\\\\/g, '/'));
    const heavy = ['core/devices/DeviceDiscoveryService', 'core/devices/SonyCameraService', 'infrastructure/desktop/DeadlineNotifier', 'core/database/database', 'core/library/ThumbnailRegenService', 'bonjour-service'];
    const found = heavy.filter((h) => loaded.some((f) => f.includes(h)));
    process.stdout.write(JSON.stringify(found));
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), []);
});

// ─── main.js: janela primeiro, núcleo depois ────────────────────────────────────────────────

test('main.js: o Bootstrap só é requerido dentro de initBootstrap (depois da janela) e o portão abre após o init', () => {
  const main = read('main.js').split('\r\n').join('\n');
  const requires = [...main.matchAll(/require\('\.\/src\/bootstrap'\)/g)];
  assert.equal(requires.length, 1, 'um único require do Bootstrap');
  const fnStart = main.indexOf('async function initBootstrap()');
  const fnEnd = main.indexOf('\n}\n', fnStart);
  assert.ok(requires[0].index > fnStart && requires[0].index < fnEnd, 'require do Bootstrap dentro de initBootstrap');
  assert.doesNotMatch(main, /^const logger = require\(/m, 'logger não é carregado antes do ready');
  const order = ['createWindow({ load: true })', 'await initBootstrap()', "bootstrap.init()", 'rendererGate.open(mainWindow)'];
  let pos = -1;
  for (const marker of order) {
    const idx = main.indexOf(marker, pos + 1);
    assert.ok(idx > pos, `ordem em whenReady: ${marker}`);
    pos = idx;
  }
});

// ─── Portão de inicialização do renderer ────────────────────────────────────────────────────

function runGate(timers = []) {
  const win = {};
  vm.runInNewContext(read('renderer/boot-gate.js'), { window: win, setTimeout: (fn, ms) => { timers.push([fn, ms]); return 1; }, Promise });
  return win.__bdsGate;
}

test('boot-gate.js: a promessa só resolve quando o main chama go(), e go() é idempotente', async () => {
  const timers = [];
  const gate = runGate(timers);
  let opened = false;
  gate.promise.then(() => { opened = true; });
  await Promise.resolve();
  assert.equal(opened, false);
  assert.equal(gate.go(), true);
  assert.equal(gate.go(), true);
  await gate.promise;
  assert.equal(opened, true);
  // rede de segurança: um temporizador longo abre o portão sozinho
  assert.equal(timers.length, 1);
  assert.ok(timers[0][1] >= 30000);
});

test('index.html carrega o portão (síncrono) antes do app.js, e o app.js espera o portão e trata DOMContentLoaded já passado', () => {
  const html = read('renderer/index.html');
  const gateIdx = html.indexOf('<script src="./boot-gate.js"></script>');
  const appIdx = html.indexOf('<script src="./app.js" type="module"></script>');
  assert.ok(gateIdx > 0 && appIdx > gateIdx);
  const app = read('renderer/app.js');
  assert.match(app, /if \(window\.__bdsGate\) await window\.__bdsGate\.promise;/);
  assert.match(app, /if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', startApp\);\s*else startApp\(\);/);
  assert.ok(!/document\.addEventListener\('DOMContentLoaded', \(\) =>/.test(app), 'sem listener anônimo antigo');
});

// ─── execução fora da thread principal ──────────────────────────────────────────────────────

test('execOffThread: mesma assinatura de callback do exec (stdout, erro com código de saída)', async () => {
  const { execOffThread } = require('../src/infrastructure/hardware/offThreadExec');
  const node = `"${process.execPath}"`;
  const ok = await new Promise((resolve) => execOffThread(`${node} -e "process.stdout.write('olá')"`, { encoding: 'utf8', windowsHide: true, timeout: 20000 }, (err, stdout) => resolve({ err, stdout })));
  assert.equal(ok.err, null);
  assert.equal(ok.stdout, 'olá');
  const bad = await new Promise((resolve) => execOffThread(`${node} -e "process.exit(3)"`, { encoding: 'utf8', windowsHide: true, timeout: 20000 }, (err, stdout) => resolve({ err, stdout })));
  assert.ok(bad.err instanceof Error);
  assert.equal(bad.err.code, 3);
});

test('execOffThread: variáveis de ambiente (env) chegam ao processo filho', async () => {
  const { execOffThread } = require('../src/infrastructure/hardware/offThreadExec');
  const out = await new Promise((resolve) => execOffThread(`"${process.execPath}" -e "process.stdout.write(process.env.BDS_TESTE)"`,
    { encoding: 'utf8', windowsHide: true, timeout: 20000, env: { ...process.env, BDS_TESTE: 'valor' } }, (err, stdout) => resolve(stdout)));
  assert.equal(out, 'valor');
});

test('provedores Windows de dispositivos usam execOffThread (nunca exec direto no processo principal)', () => {
  for (const rel of ['src/infrastructure/hardware/windows/WindowsMtpProvider.js', 'src/infrastructure/hardware/windows/WindowsStorageProvider.js']) {
    const src = read(rel);
    assert.match(src, /execOffThread\(/);
    assert.doesNotMatch(src, /[^\w.]exec\(/);
  }
});

// ─── Diagnóstico BDS_PERF ───────────────────────────────────────────────────────────────────

test('startupPerf desligado (sem BDS_PERF): funções são no-ops e nada é patchado', () => {
  const child = spawnSync(process.execPath, ['-e', `
    delete process.env.BDS_PERF;
    const Module = require('node:module'); const load = Module._load;
    const cp = require('node:child_process'); const exec = cp.exec;
    const perf = require(${JSON.stringify(path.join(ROOT, 'src', 'infrastructure', 'diagnostics', 'startupPerf.js'))});
    const r = perf.time('x', () => 42);
    perf.mark('a'); perf.expect(['t']); perf.done('t');
    process.stdout.write(JSON.stringify({ enabled: perf.enabled, r, untouched: Module._load === load && cp.exec === exec }));
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { enabled: false, r: 42, untouched: true });
});

test('startupPerf ligado (BDS_PERF=1): grava marcos, requires, atrasos e término das tarefas', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bds-perf-')), 'perf.json');
  const child = spawnSync(process.execPath, ['-e', `
    const perf = require(${JSON.stringify(path.join(ROOT, 'src', 'infrastructure', 'diagnostics', 'startupPerf.js'))});
    perf.mark('inicio');
    require('node:os');
    require(${JSON.stringify(path.join(ROOT, 'src', 'services', 'timeUtils.js'))});
    perf.time('trabalho', () => 1);
    perf.expect(['a', 'b']); perf.done('a'); perf.done('b');
    perf.flushSync();
  `], { encoding: 'utf8', env: { ...process.env, BDS_PERF: '1', BDS_PERF_FILE: out } });
  assert.equal(child.status, 0, child.stderr);
  const data = JSON.parse(fs.readFileSync(out, 'utf8'));
  const names = data.marks.map((m) => m.name);
  assert.ok(names.includes('process:main-js-start') && names.includes('inicio') && names.includes('trabalho') && names.includes('bg:all-done'));
  assert.equal(typeof data.allDoneMs, 'number');
  assert.ok(Array.isArray(data.requires) && data.requires.some((r) => /timeUtils/.test(r.file)));
  assert.ok(Array.isArray(data.lags) && Array.isArray(data.spawns));
  assert.deepEqual(Object.keys(data.bg).sort(), ['a', 'b']);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

test('startupPerf: nenhuma chamada direta a ipcMain (registro de canais continua só no registrador)', () => {
  assert.doesNotMatch(read('src/infrastructure/diagnostics/startupPerf.js'), /ipcMain/);
});
