'use strict';

// Carga preguiçosa do winston no logService (otimização de abertura): o require do serviço não carrega o
// winston, as linhas emitidas antes disso entram numa fila e chegam ao arquivo do dia com o horário original,
// inclusive quando o processo sai antes de o winston carregar. Cada caso roda num processo filho limpo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'logService.js');

/** Roda `code` num node novo com BMD_LOGS_DIR próprio; devolve { out, lines } (linhas JSON do arquivo do dia). */
function runChild(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-logtest-'));
  try {
    const r = spawnSync(process.execPath, ['-e', `const logger = require(${JSON.stringify(SERVICE)});\n${code}`], {
      env: { ...process.env, BMD_LOGS_DIR: dir, ELECTRON_RUN_AS_NODE: '' },
      encoding: 'utf8',
      timeout: 20000
    });
    assert.equal(r.status, 0, r.stderr);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
    const lines = files.flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    return { out: r.stdout.trim().split(/\r?\n/).pop(), lines };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('logService: require não carrega o winston; log enfileirado só carrega ao pedir', () => {
  const { out } = runChild(`
    const has = () => Object.keys(require.cache).some((k) => /node_modules[\\\\/]winston[\\\\/]/.test(k));
    const before = has();
    logger.info('a');
    logger.warn('b', { x: 1 });
    const queued = !has() && !logger.isLoaded();
    logger.flushNow();
    console.log(JSON.stringify({ before, queued, after: has(), loaded: logger.isLoaded() }));
  `);
  assert.deepEqual(JSON.parse(out), { before: false, queued: true, after: true, loaded: true });
});

test('logService: fila mantém ordem, metadata e horário original ao gravar', async () => {
  const { lines } = runChild(`
    logger.info('primeira');
    logger.warn('segunda', { codigo: 7 });
    logger.error(new Error('terceira'));
    const t0 = Date.now();
    while (Date.now() - t0 < 60) {}              // garante horários distintos dos da gravação
    logger.flushNow();
    logger.info('quarta (já com winston)');
    setTimeout(() => process.exit(0), 400);      // dá tempo ao stream de arquivo do winston
  `);
  const msgs = lines.map((l) => l.message);
  assert.equal(msgs[0], 'primeira');
  assert.equal(msgs[1], 'segunda');
  assert.equal(lines[1].codigo, 7);
  assert.equal(lines[1].level, 'warn');
  assert.match(msgs[2], /terceira/);
  assert.equal(lines[2].level, 'error');
  assert.ok(msgs.includes('quarta (já com winston)'));
  // o horário da fila é o da emissão (anterior ao da gravação), em ordem
  assert.ok(lines[0].timestamp <= lines[1].timestamp);
  assert.ok(lines[1].timestamp < lines[3].timestamp);
  assert.ok(lines.every((l) => !('__bdsTs' in l)));
});

test('logService: saída do processo com fila pendente grava de forma síncrona (sem perder linhas)', () => {
  const { lines } = runChild(`
    logger.info('antes de sair', { token: 'abc123' });
    logger.error('erro antes de sair');
  `);
  const msgs = lines.map((l) => l.message);
  assert.deepEqual(msgs, ['antes de sair', 'erro antes de sair']);
  assert.equal(lines[1].level, 'error');
  assert.ok(lines.every((l) => typeof l.timestamp === 'string' && l.timestamp.length > 20));
});

test('logService: demais propriedades do logger (log, level) carregam o winston sob demanda', () => {
  const { out } = runChild(`
    const lvl = logger.level;
    console.log(JSON.stringify({ lvl, loaded: logger.isLoaded(), hasLog: typeof logger.log === 'function' }));
  `);
  assert.deepEqual(JSON.parse(out), { lvl: 'info', loaded: true, hasLog: true });
});
