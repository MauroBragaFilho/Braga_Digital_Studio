'use strict';

// Remover silêncio agora vive dentro do projeto (janela aberta pela barra de seleção da aba Arquivos); a tela
// própria "Remover Silêncio" deixou de existir. Testes estáticos: nada de id solto entre o código e o HTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const read = (rel) => fs.readFileSync(path.join(R, rel), 'utf8');

test('todo id usado por workspace/silence.js existe no HTML do projeto', () => {
  const js = read('screens/workspace/silence.js');
  const html = read('screens/project_workspace.html');
  const ids = new Set([...js.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]));
  for (const id of ['wsSelSilence', 'wsSilenceModal', 'wsSilRun', 'wsSilStop', 'wsSilMode', 'wsSilThreshold', 'wsSilMin', 'wsSilFolder', 'wsSilFiles']) {
    assert.ok(ids.has(id), `o código deveria usar ${id}`);
  }
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `falta o id ${id} no project_workspace.html`);
});

test('a aba Arquivos liga a janela e a tela antiga não existe mais', () => {
  assert.match(read('screens/workspace/files.js'), /import \{ bindSilence \} from '\.\/silence\.js'/);
  assert.match(read('screens/workspace/files.js'), /bindSilence\(\);/);
  for (const f of ['silence.html', 'silence.js', 'silence.css']) assert.equal(fs.existsSync(path.join(R, 'screens', f)), false, f);
  assert.doesNotMatch(read('index.html'), /data-view="silence"/);
  assert.doesNotMatch(read('screens/home.html'), /data-target="silence"/);
});

test('usa o mesmo serviço de antes e não mexe no arquivo original', () => {
  const js = read('screens/workspace/silence.js');
  for (const api of ['processSilence', 'cancelSilence', 'onSilenceProgress', 'onSilenceFinished', 'silenceGetState']) assert.match(js, new RegExp(api), api);
  assert.match(js, /outFolder/, 'sempre grava numa pasta de destino');
  assert.match(js, /kindOf\(m\) !== 'photo'/, 'fotos ficam de fora');
});
