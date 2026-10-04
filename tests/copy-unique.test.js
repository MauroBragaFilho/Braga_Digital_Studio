'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyFileUnique } = require('../src/infrastructure/hardware/copyUnique');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bds-copy-')); }

test('copia para um nome novo e reporta progresso', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.bin'), Buffer.alloc(1000, 1));
  fs.mkdirSync(path.join(d, 'out'));
  const seen = [];
  const r = await copyFileUnique(path.join(d, 'a.bin'), path.join(d, 'out'), 'a.bin', (c, t) => seen.push([c, t]));
  assert.equal(r.skipped, false);
  assert.equal(fs.statSync(r.dest).size, 1000);
  assert.deepEqual(seen.at(-1), [1000, 1000]);
  assert.deepEqual(fs.readdirSync(path.join(d, 'out')), ['a.bin']); // sem .part sobrando
});

test('nunca sobrescreve um arquivo diferente com o mesmo nome', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.bin'), Buffer.alloc(1000, 1));
  fs.mkdirSync(path.join(d, 'out'));
  fs.writeFileSync(path.join(d, 'out', 'a.bin'), 'outro conteudo');
  const r = await copyFileUnique(path.join(d, 'a.bin'), path.join(d, 'out'), 'a.bin');
  assert.equal(path.basename(r.dest), 'a (2).bin');
  assert.equal(fs.readFileSync(path.join(d, 'out', 'a.bin'), 'utf8'), 'outro conteudo');
});

test('mesmo nome e tamanho: considera já importado e pula', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.bin'), Buffer.alloc(500, 1));
  fs.mkdirSync(path.join(d, 'out'));
  fs.writeFileSync(path.join(d, 'out', 'a.bin'), Buffer.alloc(500, 9));
  const r = await copyFileUnique(path.join(d, 'a.bin'), path.join(d, 'out'), 'a.bin');
  assert.equal(r.skipped, true);
  assert.deepEqual(fs.readdirSync(path.join(d, 'out')), ['a.bin']);
});

test('erro de leitura rejeita e não deixa parcial', async () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'out'));
  await assert.rejects(copyFileUnique(path.join(d, 'inexistente.bin'), path.join(d, 'out'), 'x.bin'));
  assert.deepEqual(fs.readdirSync(path.join(d, 'out')), []);
});
