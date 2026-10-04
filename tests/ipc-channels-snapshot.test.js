'use strict';

// Rede de segurança para refatorações do main (ex.: divisão do bootstrap.js em src/ipc/*):
// compara a lista ORDENADA de todos os canais ipcMain.handle e de todos os eventos enviados ao
// renderer (send/_send*/sendThrottled com canal literal) com o snapshot em
// tests/fixtures/ipc-channels.json. Nenhum canal pode sumir ou aparecer sem que o snapshot seja
// atualizado de propósito:  UPDATE_IPC_SNAPSHOT=1 npm test -- (rode só este arquivo)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT = path.join(__dirname, 'fixtures', 'ipc-channels.json');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (path.extname(e.name) === '.js') out.push(full);
  }
  return out;
}

// Remove comentários preservando literais simples (mesma abordagem do ipc-wiring.test.js).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

// Canais registrados pelo registrador central (src/ipc/channelRegistry.js): `handle('canal', ...)` nos
// arquivos de src/ipc. Registros diretos `ipcMain.handle('canal', ...)` continuam sendo contados (e o
// teste ipc-registry.test.js garante que não existam fora do registrador).
const REGISTRY_FILE = path.join('src', 'ipc', 'channelRegistry.js');
const isIpcModule = (f) => path.relative(ROOT, f).startsWith(path.join('src', 'ipc') + path.sep) && path.relative(ROOT, f) !== REGISTRY_FILE;
const HANDLE_RE = /(?<![\w$.])handle\(\s*(['"`])([^'"`]+)\1/g;

function channelsOf(f, src) {
  const out = [];
  for (const m of src.matchAll(/ipcMain\.handle\(\s*(['"`])([^'"`]+)\1/g)) out.push(m[2]);
  if (isIpcModule(f)) for (const m of src.matchAll(HANDLE_RE)) out.push(m[2]);
  return out;
}

function collect() {
  const files = [path.join(ROOT, 'main.js'), ...walk(path.join(ROOT, 'src'))];
  const handlers = new Set();
  const events = new Set();
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const c of channelsOf(f, src)) handlers.add(c);
    for (const m of src.matchAll(/(?<![\w$])(?:_?send\w*)\(\s*(['"`])([^'"`]+)\1/g)) events.add(m[2]);
  }
  return {
    handlers: [...handlers].sort(),
    events: [...events].sort()
  };
}

test('snapshot: canais ipcMain.handle e eventos ao renderer permanecem idênticos', () => {
  const current = collect();
  if (process.env.UPDATE_IPC_SNAPSHOT === '1') {
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify(current, null, 2) + '\n', 'utf8');
    return;
  }
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const diff = (a, b) => a.filter((x) => !b.includes(x));
  assert.deepEqual(diff(expected.handlers, current.handlers), [], 'handlers PERDIDOS');
  assert.deepEqual(diff(current.handlers, expected.handlers), [], 'handlers NOVOS (atualize o snapshot se for intencional)');
  assert.deepEqual(diff(expected.events, current.events), [], 'eventos PERDIDOS');
  assert.deepEqual(diff(current.events, expected.events), [], 'eventos NOVOS (atualize o snapshot se for intencional)');
  assert.deepEqual(current, expected);
});

test('snapshot: nenhum canal ipcMain.handle é registrado duas vezes', () => {
  const files = [path.join(ROOT, 'main.js'), ...walk(path.join(ROOT, 'src'))];
  const seen = new Map();
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const c of channelsOf(f, src)) seen.set(c, (seen.get(c) || 0) + 1);
  }
  const dup = [...seen].filter(([, n]) => n > 1).map(([c]) => c);
  assert.deepEqual(dup, []);
});
