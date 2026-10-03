'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeOptions, SUPPORTED_EXTENSIONS, asciiRelative } = require('../src/core/modules/WhisperCppRunner');

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

test('precisa de ao menos uma saída; palavras, linhas, idioma e pasta de saída são validados', () => {
  assert.strictEqual(codeOf(() => normalizeOptions({ files: [audio], srt: false })), 'NO_OUTPUT');
  assert.strictEqual(codeOf(() => normalizeOptions({ files: [audio], maxWords: 99 })), 'BAD_OPTION');
  assert.strictEqual(codeOf(() => normalizeOptions({ files: [audio], lines: 3 })), 'BAD_OPTION');
  assert.strictEqual(codeOf(() => normalizeOptions({ files: [audio], language: 'pt; calc' })), 'BAD_OPTION');
  assert.strictEqual(codeOf(() => normalizeOptions({ files: [audio], outDir: 'relativa' })), 'BAD_PATH');
});

test('opções válidas normalizam sem erro; padrões: legenda ligada, 2 linhas, português', () => {
  assert.doesNotThrow(() => normalizeOptions({ files: [audio], maxWords: 10 }));
  assert.ok(SUPPORTED_EXTENSIONS.has('.mp3'));
  const o = normalizeOptions({ files: [audio] });
  assert.deepStrictEqual([o.srt, o.md, o.lines, o.language, o.forceCpu], [true, false, 2, 'pt', false]);
  assert.strictEqual(normalizeOptions({ files: [audio], language: 'AUTO' }).language, 'auto');
});

test('asciiRelative: só devolve caminho relativo em ASCII (o whisper-cli não aceita acentos nos argumentos)', () => {
  const base = path.join(os.tmpdir(), 'Usuários', 'João', 'dados', 'whisper');
  const work = path.join(base, 'work', 'whisper_1');
  assert.strictEqual(asciiRelative(work, path.join(base, 'models', 'turbo', 'model.bin')), path.join('..', '..', 'models', 'turbo', 'model.bin')); // o acento fica no trecho comum
  assert.strictEqual(asciiRelative(work, path.join(base, 'modelos ção', 'model.bin')), null);
  if (process.platform === 'win32') {
    const other = os.tmpdir().toUpperCase().startsWith('Z:') ? 'Y:' : 'Z:';
    assert.strictEqual(asciiRelative(work, `${other}\\modelos\\model.bin`), null); // outro disco: não há caminho relativo
  }
});
