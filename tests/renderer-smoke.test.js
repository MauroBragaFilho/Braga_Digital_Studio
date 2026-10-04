'use strict';

// Smoke de montagem: toda tela de produção carrega o HTML + JS (ESM) com window.bds simulado e
// o initScreen() termina sem exceção. Exclui recovery e montage (fora do escopo desta rede). O assistente de IA não é tela: tem teste próprio (renderer-ai-assistant).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mountScreen, settle, SCREENS_DIR } = require('./helpers/renderer-harness');

const EXCLUIDAS = new Set(['recovery', 'montage']);
const telas = fs.readdirSync(SCREENS_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => f.slice(0, -3))
  .filter((t) => !EXCLUIDAS.has(t) && fs.existsSync(`${SCREENS_DIR}/${t}.html`))
  .sort();

test('descobre as telas de produção', () => {
  assert.ok(telas.length >= 10, `telas encontradas: ${telas.join(', ')}`);
});

for (const tela of telas) {
  test(`smoke: ${tela} monta e executa initScreen sem exceção`, async () => {
    const h = await mountScreen(tela, { init: false });
    try {
      assert.equal(typeof h.mod.initScreen, 'function', `${tela}.js deve exportar initScreen`);
      await h.mod.initScreen();
      await settle(30);
      const first = h.errors[0];
      assert.equal(h.errors.length, 0, `rejeição não tratada: ${first && (first.stack || first)}`);
      assert.ok(h.document.getElementById(`${tela}View`), 'container da tela presente');
    } finally {
      await h.cleanup();
    }
  });
}
