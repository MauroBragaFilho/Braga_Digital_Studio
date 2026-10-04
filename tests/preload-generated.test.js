'use strict';

// O preload.js é GERADO de src/ipc/channels.js (scripts/generate-preload.js). Estes testes provam que:
//   1. o arquivo no repositório é exatamente o que o gerador produz (mesma verificação de `npm run verify:preload`);
//   2. a superfície pública (window.bds) continua idêntica à do preload escrito à mão, registrada em
//      tests/fixtures/preload-surface.json (chaves, aridade, canal e argumentos de cada função, desinscrição).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { generate, verify } = require('../scripts/generate-preload');
const { CHANNELS, EVENTS } = require('../src/ipc/channels');
const { extractSurface } = require('./helpers/preload-surface');

const PRELOAD = path.join(ROOT, 'preload.js');

test('preload.js confere com o que o gerador produz (verify:preload)', () => {
  const r = verify();
  assert.ok(r.ok, 'preload.js está desatualizado: rode "npm run generate:preload"');
});

test('o comando verify:preload (--check) sai com 0 quando confere', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-preload.js'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('o gerador é determinístico e declara que o arquivo é gerado', () => {
  assert.equal(generate(), generate());
  assert.match(fs.readFileSync(PRELOAD, 'utf8'), /ARQUIVO GERADO por scripts\/generate-preload\.js/);
});

test('uma edição manual do preload seria detectada', () => {
  const current = fs.readFileSync(PRELOAD, 'utf8');
  const tampered = current.replace("ipcRenderer.invoke('settings:get')", "ipcRenderer.invoke('settings:save')");
  assert.notEqual(tampered, current);
  const norm = (s) => s.replace(/\r\n/g, '\n');
  assert.notEqual(norm(tampered), norm(generate()));
});

test('superfície pública de window.bds idêntica ao snapshot do preload original', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'preload-surface.json'), 'utf8'));
  const actual = extractSurface(fs.readFileSync(PRELOAD, 'utf8'), PRELOAD);
  assert.deepEqual(Object.keys(actual), Object.keys(expected), 'chaves de window.bds mudaram');
  for (const key of Object.keys(expected)) {
    assert.deepEqual(actual[key], expected[key], `window.bds.${key} mudou`);
  }
});

test('a tabela explica toda a superfície: cada função do preload vem de CHANNELS/EVENTS ou é utilitário fixo', () => {
  const surface = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'preload-surface.json'), 'utf8'));
  const fromTable = new Set();
  for (const m of Object.values(CHANNELS)) for (const a of m.api) fromTable.add(typeof a === 'string' ? a : a.name);
  for (const [name] of EVENTS) fromTable.add(name);
  const FIXOS = new Set(['getPathForFile', 'removeAllListeners']);
  const fns = Object.entries(surface).filter(([, v]) => v.type === 'function').map(([k]) => k);
  const unexplained = fns.filter((k) => !fromTable.has(k) && !FIXOS.has(k));
  assert.deepEqual(unexplained, []);
  const missing = [...fromTable].filter((k) => !fns.includes(k));
  assert.deepEqual(missing, [], 'a tabela declara nomes que não existem no preload');
});

test('o preload gerado só carrega "electron" (exigência do sandbox)', () => {
  const src = fs.readFileSync(PRELOAD, 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['electron']);
});
