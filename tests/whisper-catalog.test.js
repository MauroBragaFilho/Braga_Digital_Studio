'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { WHISPER_MODELS, DEFAULT_MODEL_ID, getModel } = require('../src/core/modules/WhisperCatalog');

test('catálogo tem modelos com campos obrigatórios e ids únicos', () => {
  assert.ok(WHISPER_MODELS.length > 0);
  const ids = new Set();
  for (const m of WHISPER_MODELS) {
    assert.ok(m.id && m.label && m.repo, `modelo incompleto: ${JSON.stringify(m)}`);
    assert.ok(m.sizeBytes > 0);
    assert.ok(!ids.has(m.id), `id duplicado: ${m.id}`);
    ids.add(m.id);
  }
});

test('modelo padrão existe e getModel devolve null para id desconhecido', () => {
  assert.ok(getModel(DEFAULT_MODEL_ID));
  assert.strictEqual(getModel('nao-existe'), null);
});
