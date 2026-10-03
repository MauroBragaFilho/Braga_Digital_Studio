'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { WHISPER_MODELS, DEFAULT_MODEL_ID, getModel } = require('../src/core/modules/WhisperCatalog');

test('catálogo tem modelos ggml com campos obrigatórios e ids únicos', () => {
  assert.ok(WHISPER_MODELS.length > 0);
  const ids = new Set();
  for (const m of WHISPER_MODELS) {
    assert.ok(m.id && m.label && m.repo && m.file, `modelo incompleto: ${JSON.stringify(m)}`);
    assert.match(m.file, /^ggml-[a-z0-9._-]+\.bin$/, `arquivo ggml inesperado: ${m.file}`);
    assert.ok(m.dtw, `falta o nome do modelo para o alinhamento de palavras (DTW): ${m.id}`);
    assert.ok(m.sizeBytes > 0);
    assert.ok(!ids.has(m.id), `id duplicado: ${m.id}`);
    ids.add(m.id);
  }
});

test('modelo padrão existe e getModel devolve null para id desconhecido', () => {
  assert.ok(getModel(DEFAULT_MODEL_ID));
  assert.strictEqual(getModel('nao-existe'), null);
});

test('nomes de DTW são os que o whisper.cpp conhece', () => {
  const known = new Set(['tiny', 'base', 'small', 'medium', 'large.v3', 'large.v3.turbo']);
  for (const m of WHISPER_MODELS) assert.ok(known.has(m.dtw), `${m.id}: DTW desconhecido (${m.dtw})`);
});
