'use strict';

// Estrutura e acessibilidade da tela de Configurações (settings.html): abas ligadas às seções, rótulos nos campos,
// ajustes avançados recolhidos, diálogos com título e nenhum id repetido.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'screens', 'settings.html'), 'utf8');
const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

test('cada aba aponta para uma seção existente e a seção "Sobre e licenças" existe', () => {
  const tabs = [...document.querySelectorAll('.settings-tab')];
  assert.ok(tabs.length >= 10);
  for (const tab of tabs) assert.ok(document.getElementById(tab.dataset.tab), `sem seção para ${tab.dataset.tab}`);
  assert.ok(tabs.some((t) => t.dataset.tab === 'settingsAboutView'));
});

test('a navegação é agrupada (Preferências, Recursos, Aplicativo)', () => {
  const groups = [...document.querySelectorAll('.st-nav-group')].map((n) => n.textContent.trim());
  assert.deepEqual(groups, ['Preferências', 'Recursos', 'Aplicativo']);
});

test('não há ids repetidos', () => {
  const ids = [...document.querySelectorAll('[id]')].map((n) => n.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, []);
});

test('todo campo de pasta e todo campo numérico tem rótulo associado ou aria-label', () => {
  const fields = [...document.querySelectorAll('input[type=text], input[type=number], input[type=url], input[type=time], select')]
    .filter((el) => !el.closest('.hidden') && el.id !== 'settingsSearch');
  const missing = fields.filter((el) => !(document.querySelector(`label[for="${el.id}"]`) || el.getAttribute('aria-label')));
  assert.deepEqual(missing.map((el) => el.id), []);
});

test('todo botão tem texto ou aria-label', () => {
  const bad = [...document.querySelectorAll('button')].filter((b) => !(b.textContent.replace(/\b(?:[a-z_]+)\b(?=\s*$)/g, '').trim() || b.getAttribute('aria-label')));
  assert.deepEqual(bad.map((b) => b.id || b.className), []);
});

test('todo botão só com ícone (campos de caminho, restaurar padrão, fechar) tem aria-label e title', () => {
  const iconOnly = [...document.querySelectorAll('button')].filter((b) => {
    const clone = b.cloneNode(true);
    clone.querySelectorAll('.material-symbols-rounded, .st-sr').forEach((n) => n.remove());
    return clone.textContent.trim() === '';
  });
  assert.ok(iconOnly.length >= 10, 'há botões só com ícone para conferir');
  const bad = iconOnly.filter((b) => !(b.getAttribute('aria-label') && b.getAttribute('title')));
  assert.deepEqual(bad.map((b) => b.id || b.className), []);
});

test('ajustes avançados ficam em blocos recolhidos (details sem open)', () => {
  const adv = [...document.querySelectorAll('details.st-advanced')];
  assert.ok(adv.length >= 3);
  for (const d of adv) assert.equal(d.hasAttribute('open'), false);
});

test('diálogos têm role, título associado e botão de fechar acessível', () => {
  for (const modal of document.querySelectorAll('.settings-modal-overlay')) {
    assert.equal(modal.getAttribute('role'), 'dialog', modal.id);
    assert.ok(document.getElementById(modal.getAttribute('aria-labelledby')), `${modal.id} sem título associado`);
  }
  assert.ok(document.getElementById('modalSettingsLeave'), 'falta o aviso de alterações não salvas');
  // todo diálogo com botão de fechar o expõe com nome acessível e título, e só o aviso de saída tem decisão de verdade
  // (3 opções, Esc próprio); os demais fecham por X, Esc e clique fora, sem um "Cancelar" duplicado
  for (const modal of document.querySelectorAll('.settings-modal-overlay')) {
    if (modal.id === 'modalSettingsLeave') continue;
    const close = modal.querySelector('.settings-modal-header .settings-modal-close');
    assert.ok(close, `${modal.id} sem botão de fechar (X)`);
    assert.equal(close.getAttribute('aria-label'), 'Fechar', `${modal.id}: X sem aria-label`);
    assert.match(close.id, /Close/, `${modal.id}: o Esc usa o botão cujo id tem "Close"`);
    assert.equal(modal.querySelector('.settings-modal-header').querySelector('button'), close, `${modal.id}: o X vem antes de qualquer outro botão`);
    const cancel = [...modal.querySelectorAll('button')].filter((b) => /cancelar/i.test(b.textContent) || /Cancel/.test(b.id));
    assert.deepEqual(cancel.map((b) => b.id), [], `${modal.id}: sem botão Cancelar`);
  }
});

test('o servidor de atualizações próprio fica no bloco avançado e aceita só https (validação no JS)', () => {
  const input = document.getElementById('updateServerUrlInput');
  assert.ok(input && input.closest('details.st-advanced'));
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'screens', 'settings.js'), 'utf8');
  assert.match(js, /protocol !== 'https:'/);
});
