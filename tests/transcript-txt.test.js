'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildText } = require('../src/core/transcription/subtitles');
const { normalizeOptions } = require('../src/core/modules/WhisperCppRunner');

test('buildText: uma linha por trecho, sem tempos e sem linhas vazias', () => {
  const out = buildText({ segments: [
    { start: 0, text: '  Olá,   mundo. ' },
    { start: 2, text: '' },
    { start: 3, text: 'Segunda\nfrase.' },
  ] });
  assert.equal(out, 'Olá, mundo.\nSegunda frase.\n');
});

test('buildText: sem fala devolve texto vazio', () => {
  assert.equal(buildText({ segments: [] }), '');
  assert.equal(buildText(), '');
});

test('normalizeOptions: só TXT já é uma saída válida; nenhuma saída é recusada', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-txt-'));
  const media = path.join(dir, 'a.mp4');
  fs.writeFileSync(media, 'x');
  const base = { files: [media] };
  assert.doesNotThrow(() => normalizeOptions({ ...base, srt: false, md: false, txt: true }));
  assert.throws(() => normalizeOptions({ ...base, srt: false, md: false, txt: false }), /ao menos uma saída/);
});
