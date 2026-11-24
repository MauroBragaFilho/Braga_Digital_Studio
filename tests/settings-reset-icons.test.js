'use strict';

// Configurações: mecanismo único do "Restaurar padrão" (botão-ícone que só aparece quando o valor difere do padrão)
// e setas do menu lateral visíveis só no hover e no foco.
//   - os 13 resets por campo (11 de FIELD_DEFAULTS + 2 pausas), o das imagens de LUTs e o da ordem do menu lateral;
//   - cada botão: ícone com aria-label e title, texto "Restaurar padrão" em span oculto, foco volta ao campo;
//   - o das pastas (Downloads e Conversor) tem o próprio arquivo: settings-restore-folders.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { mountScreen, settle, SCREENS_DIR } = require('./helpers/renderer-harness');

const html = fs.readFileSync(path.join(SCREENS_DIR, 'settings.html'), 'utf8');
const css = fs.readFileSync(path.join(SCREENS_DIR, 'settings.css'), 'utf8');
const { document: staticDoc } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

const FIELD_IDS = [
  'themeSelect', 'defaultStartScreenInput', 'deadlineNotifyLeadDaysInput', 'deadlineNotifyTimeInput', 'preferredGpuVendorInput',
  'converterDefaultFormatInput', 'converterDefaultCodecInput', 'converterDefaultResolutionInput', 'converterDefaultVideoBitrateInput',
  'converterDefaultAudioBitrateInput', 'cacheMaxSizeInput'
];

test('HTML: os botões estáticos de restaurar são ícones escondidos, com texto oculto, aria-label e title', () => {
  const ids = ['restoreDownloadFoldersButton', 'restoreConverterFolderButton', 'sidebarOrderResetButton', 'lutPreviewImageResetBtn'];
  for (const id of ids) {
    const btn = staticDoc.getElementById(id);
    assert.ok(btn, id);
    assert.ok(btn.classList.contains('st-reset-icon') && btn.classList.contains('hidden'), `${id}: ícone escondido de início`);
    assert.ok(!btn.classList.contains('st-reset-field'), `${id}: sem a classe dos botões criados por código (o setupFieldDefaults os apagaria)`);
    assert.ok(btn.dataset.resetKind, `${id}: marcador do tipo de comparação`);
    assert.ok(btn.getAttribute('aria-label')?.startsWith('Restaurar'), `${id}: aria-label`);
    assert.ok(btn.getAttribute('title')?.startsWith('Restaurar padrão'), `${id}: title`);
    assert.match(btn.querySelector('.st-sr')?.textContent || '', /^Restaurar (ordem )?padrão$/, `${id}: texto oculto`);
    assert.equal(btn.querySelector('.material-symbols-rounded')?.getAttribute('aria-hidden'), 'true', `${id}: ícone decorativo`);
  }
  // LUTs: o padrão é "vazio"; a ordem do menu é calculada
  assert.equal(staticDoc.getElementById('lutPreviewImageResetBtn').dataset.resetKind, 'empty');
  assert.equal(staticDoc.getElementById('lutPreviewImageResetBtn').dataset.resetFields, 'lutPreviewImageInput');
  assert.equal(staticDoc.getElementById('sidebarOrderResetButton').dataset.resetKind, 'order');
  // as linhas ao redor dos botões somem junto com eles
  for (const id of ['restoreDownloadFoldersButton', 'restoreConverterFolderButton', 'sidebarOrderResetButton']) {
    const row = staticDoc.getElementById(id).closest('[data-reset-row]');
    assert.ok(row && row.classList.contains('hidden'), `${id}: linha escondida de início`);
  }
});

test('CSS: o ícone de restaurar usa tokens, foco visível e esconde com .hidden; as setas usam opacidade (focáveis)', () => {
  const bloco = (re) => { const m = css.match(re); assert.ok(m, String(re)); return m[0]; };
  const icon = bloco(/\.st-reset-icon\s*\{[^}]*\}/);
  assert.match(icon, /var\(--radius-pill\)/);
  assert.doesNotMatch(icon, /#[0-9a-fA-F]{3,8}\b/, 'sem hex solto');
  assert.match(css, /\.st-reset-icon:focus-visible\s*\{[^}]*outline/);
  assert.match(css, /\.st-reset-icon\.hidden\s*\{\s*display:\s*none/);
  assert.match(css, /\.st-sr\s*\{[^}]*clip:\s*rect/);
  // setas e alça: só no hover/foco, em opacidade (display/visibility tirariam as setas do teclado) e só onde há hover
  const media = bloco(/@media \(hover: hover\)\s*\{[\s\S]*?\n\}/);
  assert.match(media, /\.st-order-item:not\(\.is-fixed\) \.st-order-move[^{]*\{[^}]*opacity:\s*0/);
  assert.match(media, /\.st-order-item:hover \.st-order-move/);
  assert.match(media, /\.st-order-item:focus-within \.st-order-move/);
  assert.match(media, /\.st-order-grip/);
  assert.doesNotMatch(media, /display:\s*none|visibility:\s*hidden/);
});

test('Restaurar padrão por campo, LUTs e ordem do menu: só aparecem quando difere, foco volta ao campo', async () => {
  const h = await mountScreen('settings', {
    shell: true,
    bds: {
      getSettings: async () => ({
        theme: 'light', cacheMaxSizeMB: 500, converterDefaultVideoBitrate: 10, downloadPauseMinSec: 10, downloadPauseMaxSec: 180,
        uploadPauseMinSec: 60, uploadPauseMaxSec: 300, lutPreviewImage: ''
      })
    }
  });
  try {
    await settle(80);
    const doc = h.document;
    const $ = (id) => doc.getElementById(id);
    const focados = [];
    h.window.HTMLElement.prototype.focus = function focus() { focados.push(this.id || this.className); };
    const fire = (el, type) => el.dispatchEvent(new h.window.Event(type, { bubbles: true }));
    const resetOf = (id) => [...doc.querySelectorAll('.st-reset-icon[data-targets]')]
      .find((b) => JSON.parse(b.dataset.targets).some(([t]) => t === id));
    const hidden = (btn) => btn.classList.contains('hidden');

    // ---- os 13 resets por campo: ícone com texto oculto, aria-label e title; só visíveis quando difere
    const buttons = [...doc.querySelectorAll('.st-reset-icon[data-targets]')];
    assert.equal(buttons.length, 13, '11 campos + 2 pausas');
    for (const btn of buttons) {
      assert.equal(btn.dataset.resetKind, 'fields');
      assert.ok(btn.classList.contains('st-reset-field'), 'criado por código: o setupFieldDefaults o refaz sem duplicar');
      assert.match(btn.getAttribute('aria-label'), /^Restaurar o padrão de .+/);
      assert.match(btn.title, /^Restaurar padrão: .+/);
      assert.equal(btn.querySelector('.st-sr')?.textContent, 'Restaurar padrão');
      assert.equal(btn.type, 'button');
    }
    for (const id of FIELD_IDS) assert.ok(resetOf(id), `reset de ${id}`);
    assert.ok(resetOf('downloadPauseMaxInput') && resetOf('uploadPauseMaxInput'), 'pausas');

    // tema salvo "light" difere do padrão "dark": botão visível; clicar restaura, esconde e devolve o foco ao campo
    const theme = resetOf('themeSelect');
    assert.equal($('themeSelect').value, 'light');
    assert.equal(hidden(theme), false);
    assert.equal(theme.title, 'Restaurar padrão: Escuro');
    theme.click();
    assert.equal($('themeSelect').value, 'dark');
    assert.equal(hidden(theme), true, 'no padrão, o botão some');
    assert.equal(focados.at(-1), 'themeSelect', 'o foco volta ao campo');
    $('themeSelect').value = 'light';
    fire($('themeSelect'), 'change');
    assert.equal(hidden(theme), false, 'mudar de novo traz o botão de volta');

    // pausa entre downloads: um botão para os dois campos
    const pause = resetOf('downloadPauseMaxInput');
    assert.equal(hidden(pause), true, '10 a 180 s é o padrão');
    $('downloadPauseMinInput').value = '30';
    fire($('downloadPauseMinInput'), 'input');
    assert.equal(hidden(pause), false);
    pause.click();
    assert.equal($('downloadPauseMinInput').value, '10');
    assert.equal($('downloadPauseMaxInput').value, '180');
    assert.equal(hidden(pause), true);
    assert.equal(focados.at(-1), 'downloadPauseMinInput');

    // ---- LUTs: o padrão é "sem imagem"; o botão só aparece com uma imagem escolhida
    const lut = $('lutPreviewImageResetBtn');
    assert.equal(hidden(lut), true, 'sem imagem escolhida, nada a restaurar');
    $('lutPreviewImageInput').value = 'D:/Imagens/referencia.png';
    fire($('lutPreviewImageInput'), 'input');
    assert.equal(hidden(lut), false);
    lut.click();
    assert.equal($('lutPreviewImageInput').value, '');
    assert.equal($('settingsLutPreviewThumb').getAttribute('src'), './assets/lut_preview.jpg');
    assert.equal(hidden(lut), true);
    assert.equal(focados.at(-1), 'lutPreviewImageInput');

    // ---- ordem do menu lateral: só aparece quando a ordem difere da padrão
    const order = $('sidebarOrderResetButton');
    const row = order.closest('[data-reset-row]');
    const views = () => [...$('sidebarOrderList').children].map((li) => li.dataset.view);
    const padrao = views();
    assert.equal(hidden(order), true);
    assert.equal(row.classList.contains('hidden'), true, 'a linha do botão também');
    assert.ok(padrao.length > 3, 'o menu tem telas para reordenar');
    // setas: botões só com ícone, então aria-label e title com o nome da tela; focáveis (opacidade, nunca tabindex -1)
    const setas = [...doc.querySelectorAll('#sidebarOrderList .st-order-move')];
    assert.equal(setas.length, 2 * (padrao.length - 1), 'duas setas por tela móvel; a Home é fixa e não tem');
    assert.equal(doc.querySelectorAll('#sidebarOrderList .is-fixed .st-order-move').length, 0);
    for (const seta of setas) {
      const nome = seta.closest('.st-order-item').querySelector('.st-order-label').textContent;
      const acao = seta.dataset.dir === '-1' ? 'para cima' : 'para baixo';
      assert.equal(seta.getAttribute('aria-label'), `Mover ${nome} ${acao}`);
      assert.equal(seta.title, seta.getAttribute('aria-label'), 'title igual ao aria-label');
      assert.equal(seta.type, 'button');
      assert.equal(seta.hasAttribute('tabindex'), false, 'segue na ordem do Tab');
      assert.equal(seta.querySelector('.material-symbols-rounded')?.getAttribute('aria-hidden'), 'true');
    }
    const down = $('sidebarOrderList').children[1].querySelector('[data-dir="1"]');
    assert.ok(down && !down.disabled, 'seta de descer da primeira tela móvel');
    down.click();
    assert.notDeepEqual(views(), padrao);
    assert.equal(hidden(order), false, 'ordem diferente: o botão aparece');
    assert.equal(row.classList.contains('hidden'), false);
    order.click();
    assert.deepEqual(views(), padrao, 'volta à ordem original');
    assert.equal(hidden(order), true);
    assert.equal(row.classList.contains('hidden'), true);
    assert.equal(focados.at(-1), 'st-order-move', 'o foco vai para uma seta da lista');

    // ---- com uma só tela móvel não há setas (a Home é fixa)
    for (const btn of doc.querySelectorAll('.sidebar .tabs .tab-button')) {
      if (!['home', 'settings'].includes(btn.getAttribute('data-view'))) btn.classList.add('hidden');
    }
    await h.mod.onLeave();
    assert.deepEqual(views(), ['home', 'settings']);
    assert.equal(doc.querySelectorAll('#sidebarOrderList .st-order-move').length, 0, 'nada a mover: sem setas');
    assert.equal(doc.querySelectorAll('#sidebarOrderList .st-order-item').length, 2);
  } finally {
    await h.cleanup();
  }
});
