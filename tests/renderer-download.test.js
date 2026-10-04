'use strict';

// Contrato da tela Downloads: o elemento #statusText existe e recebe as mensagens de status.
// Monta o shell real (index.html + app.js): é o app.js que liga `els.statusText` ao DOM da tela.
// Arquivo próprio: o app.js é importado uma única vez por processo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mountScreen, settle, SCREENS_DIR } = require('./helpers/renderer-harness');

test('download.html tem #statusText (role=status)', () => {
  const html = fs.readFileSync(path.join(SCREENS_DIR, 'download.html'), 'utf8');
  assert.match(html, /id="statusText"/);
});

test('Downloads: #statusText recebe "Pronto." na montagem e as mensagens de ação', async () => {
  const h = await mountScreen('download', { shell: true });
  try {
    await settle(30);
    const status = h.document.getElementById('statusText');
    assert.ok(status, '#statusText presente');
    assert.equal(status.textContent, 'Pronto.');

    // adicionar à fila sem URL: mensagem de orientação aparece no statusText
    const urlInput = h.document.getElementById('urlInput');
    assert.ok(urlInput, '#urlInput presente');
    urlInput.value = '';
    const btn = h.document.getElementById('metadataButton') || h.document.querySelector('[id*="addQueue"], [id*="AddQueue"]');
    assert.ok(btn, 'botão de adicionar à fila presente');
    btn.dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(30);
    assert.match(status.textContent, /Cole um link/);
  } finally {
    await h.cleanup();
  }
});
