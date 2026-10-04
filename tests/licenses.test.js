'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'config', 'third-party-licenses.json'), 'utf8'));
const TXT = path.join(ROOT, 'assets', 'licenses', 'THIRD_PARTY_LICENSES.txt');
const all = [...list.bundled, ...list.runtime];

test('listas de licenças não estão vazias e trazem as dependências diretas', () => {
  assert.ok(list.bundled.length > 5);
  assert.ok(list.runtime.length >= 9);
  const names = list.bundled.map((i) => i.name);
  for (const dep of Object.keys(require('../package.json').dependencies)) assert.ok(names.includes(dep), `falta ${dep}`);
  assert.ok(names.some((n) => /^Electron/.test(n)));
});

test('cada item tem nome, versão, licença e link https, sem campos vazios', () => {
  for (const i of all) {
    for (const f of ['id', 'name', 'version', 'license', 'url']) assert.ok(typeof i[f] === 'string' && i[f].trim(), `${i.id || i.name}: ${f} vazio`);
    assert.match(i.url, /^https:\/\//, `${i.name}: link não é https`);
  }
  assert.equal(new Set(all.map((i) => i.id)).size, all.length, 'IDs duplicados');
});

test('o arquivo de texto existe e contém as licenças principais', () => {
  const txt = fs.readFileSync(TXT, 'utf8');
  assert.match(txt, /Permission is hereby granted, free of charge/);
  for (const i of all) assert.ok(txt.includes(`ID: ${i.id}\n`) || txt.includes(`ID: ${i.id}\r\n`), `sem bloco de ${i.name}`);
  for (const n of ['FFmpeg', 'yt-dlp', 'untrunc', 'whisper.cpp']) assert.ok(txt.includes(n));
});

test('o arquivo de licenças entra no pacote (assets/**/* e não excluído)', () => {
  const files = require('../package.json').build.files;
  assert.ok(files.includes('assets/**/*'));
  assert.ok(!files.some((f) => f.startsWith('!') && /assets|licenses/i.test(f)));
});

test('o canal IPC lê só por ID conhecido e recusa caminho arbitrário', () => {
  const { getLicenseText } = require('../src/ipc/licensesHandlers');
  assert.match(getLicenseText(list.bundled[0].id), /\S/);
  for (const bad of ['..\\..\\package.json', '../../package.json', 'C:\\Windows\\win.ini', '/etc/passwd', 'inexistente']) {
    assert.throws(() => getLicenseText(bad), /não encontrado/);
  }
  const { CHANNELS } = require('../src/ipc/channels');
  const { validateArgs } = require('../src/ipc/schema');
  assert.throws(() => validateArgs(CHANNELS['licenses:getText'].args, ['../../x']));
  assert.throws(() => validateArgs(CHANNELS['licenses:getText'].args, ['C:\\Windows\\win.ini']));
});
