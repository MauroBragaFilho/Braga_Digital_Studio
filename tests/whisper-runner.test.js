'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeOptions, SUPPORTED_EXTENSIONS } = require('../src/core/modules/WhisperEngineRunner');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-wer-'));
const audio = path.join(dir, 'a.mp3');
fs.writeFileSync(audio, 'x');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('sem arquivos -> NO_FILES', () => {
  assert.strictEqual(codeOf(() => normalizeOptions({})), 'NO_FILES');
});

test('caminho relativo e URL são rejeitados', () => {
  assert.strictEqual(codeOf(() => normalizeOptions({ files: ['a.mp3'] })), 'BAD_PATH');
  assert.strictEqual(codeOf(() => normalizeOptions({ files: ['https://x.com/a.mp3'] })), 'BAD_PATH');
});

test('extensão não suportada e arquivo inexistente', () => {
  const txt = path.join(dir, 'a.txt');
  fs.writeFileSync(txt, 'x');
  assert.strictEqual(codeOf(() => normalizeOptions({ files: [txt] })), 'BAD_FORMAT');
  assert.strictEqual(codeOf(() => normalizeOptions({ files: [path.join(dir, 'nao.mp3')] })), 'NOT_FOUND');
});

test('precisa de ao menos uma saída e maxWords limitado', () => {
  assert.strictEqual(codeOf(() => normalizeOptions({ files: [audio], srt: false })), 'NO_OUTPUT');
  assert.strictEqual(codeOf(() => normalizeOptions({ files: [audio], maxWords: 99 })), 'BAD_OPTION');
  assert.strictEqual(codeOf(() => normalizeOptions({ files: [audio], outDir: 'relativa' })), 'BAD_PATH');
});

test('opções válidas normalizam sem erro', () => {
  assert.doesNotThrow(() => normalizeOptions({ files: [audio], maxWords: 10 }));
  assert.ok(SUPPORTED_EXTENSIONS.has('.mp3'));
});
