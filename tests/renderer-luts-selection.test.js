'use strict';

// Tela de LUTs (S3): seleção múltipla (Ctrl/Shift+clique, círculo do cartão, Ctrl+A, Esc em camadas, teclado acessível),
// rodapé "Selecionado: N", resumo no inspetor, barra de ações em lote e exclusão em lote com UMA confirmação.
// Harness: linkedom + window.bds simulado.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mountScreen, settle, SCREENS_DIR } = require('./helpers/renderer-harness');

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const lut = (relPath, extra = {}) => {
  const parts = relPath.split('/');
  const name = parts.pop();
  return {
    id: null, name, displayName: name.replace(/\.cube$/i, ''), path: `C:\\LUTs\\${relPath.split('/').join('\\')}`, relPath,
    folder: parts.join('/'), depth: parts.length, size: 1000, modifiedAt: NOW, ...extra
  };
};
const HEADER = { ok: true, title: 'T', size: 17, is1D: false, domainMin: null, domainMax: null, totalEntries: 4913, preview: [[0, 0, 0]] };

/** window.bds com uma lista mutável: `items` é o que o disco "tem" agora. */
function bdsFor(items, extra = {}) {
  return {
    listLuts: async () => ({ folder: 'C:\\LUTs', items: items.map((i) => ({ ...i })), problems: [] }),
    getLutHeader: async () => HEADER,
    parseLutCube: async () => ({ ok: false, code: 'NO_SIZE', reason: 'Falta a linha de tamanho.' }),
    getPathForFile: (f) => f.path,
    ...extra
  };
}
async function mount(items, extra = {}) {
  const h = await mountScreen('luts', { bds: bdsFor(items, extra) });
  await settle(30);
  return h;
}

const $ = (h, sel) => h.document.querySelector(sel);
const $$ = (h, sel) => [...h.document.querySelectorAll(sel)];
const hasClass = (el, c) => el.classList.contains(c);
const cards = (h) => $$(h, '#lutsGrid .lut-card');
const title = (card) => card.querySelector('.lut-card-title').textContent;
const selectedNames = (h) => cards(h).filter((c) => hasClass(c, 'selected')).map(title);
const card = (h, name) => cards(h).find((c) => title(c) === name);
const mouse = (h, el, mods = {}) => el.dispatchEvent(Object.assign(new h.window.Event('click', { bubbles: true }), mods));
const click = (h, el) => mouse(h, el);
const press = (h, el, k, mods = {}) => {
  const ev = Object.assign(new h.window.Event('keydown', { bubbles: true, cancelable: true }), { key: k, ...mods });
  el.dispatchEvent(ev);
  return ev;
};
const key = (h, k, extra = {}) => { let prevented = false; h.mod.onKeyDown({ key: k, target: h.document.body, preventDefault() { prevented = true; }, ...extra }); return prevented; };
const ft = (h) => $(h, '#ftSelected').textContent;
const bar = (h) => $(h, '#lutSelectionBar');
const barShown = (h) => !hasClass(bar(h), 'hidden');

/** Parser simulado: uma LUT 3D 2x2x2 válida (precisa abrir a prévia e a tela cheia). */
const GOOD_PARSED = { ok: true, size: 2, is1D: false, data: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]], title: null, domainMin: null, domainMax: null, totalEntries: 8, preview: [] };
const parseGood = async (p) => ({ ...GOOD_PARSED, path: p });

const SIX = () => ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'].map((n) => lut(`${n}.cube`));

// ─── Marcar com o mouse ──────────────────────────────────────────────────────────────────────────

test('clique comum marca só uma; Ctrl+clique alterna sem tirar as outras; rodapé, barra e resumo acompanham', async () => {
  const h = await mount(SIX());
  try {
    assert.equal($(h, '#lutsGrid').getAttribute('aria-multiselectable'), 'true');
    assert.equal(ft(h), '0 LUTs');
    assert.ok(!barShown(h));
    assert.ok(hasClass($(h, '#lutsInspector'), 'hidden'), 'sem seleção o inspetor fica escondido');

    click(h, card(h, 'A1.cube'));
    await settle(10);
    assert.ok(!hasClass($(h, '#lutsInspector'), 'hidden'), 'com uma LUT marcada o inspetor aparece');
    assert.deepEqual(selectedNames(h), ['A1.cube']);
    assert.equal($(h, '#ftSelected').textContent, '1 LUT');
    assert.equal($(h, '#insName').textContent, 'A1.cube');
    assert.ok(!barShown(h), 'a barra só aparece com 2 ou mais');

    mouse(h, card(h, 'C3.cube'), { ctrlKey: true });
    await settle(10);
    assert.deepEqual(selectedNames(h), ['A1.cube', 'C3.cube']);
    assert.equal($(h, '#ftSelected').textContent, '2 LUTs');
    assert.ok(barShown(h));
    assert.equal($(h, '#lutSelCount').textContent, '2 selecionadas');
    assert.ok(hasClass($(h, '#lutsInspector'), 'inspector-multiple'));
    assert.ok(!hasClass($(h, '#insMulti'), 'hidden'));
    assert.equal($(h, '#insMultiTitle').textContent, '2 LUTs selecionadas');
    assert.match($(h, '#insMultiSize').textContent, /^Tamanho total: 1.95 KB$/);
    assert.deepEqual($$(h, '#insMultiList li').map((li) => li.textContent), ['A1.cube', 'C3.cube']);
    assert.ok(cards(h).every((c) => c.getAttribute('aria-selected') === (hasClass(c, 'selected') ? 'true' : 'false')));

    mouse(h, card(h, 'A1.cube'), { metaKey: true }); // Cmd no Mac
    await settle(10);
    assert.deepEqual(selectedNames(h), ['C3.cube']);
    assert.ok(!barShown(h));
    assert.ok(hasClass($(h, '#insMulti'), 'hidden'));
    assert.ok(!hasClass($(h, '#lutsInspector'), 'inspector-multiple'));
    assert.equal($(h, '#insName').textContent, 'C3.cube', 'voltando a uma só, o inspetor volta a mostrá-la');
    assert.equal($(h, '#ftSelected').textContent, '1 LUT');

    click(h, card(h, 'E5.cube')); // clique comum troca tudo por uma só
    await settle(10);
    assert.deepEqual(selectedNames(h), ['E5.cube']);
  } finally { await h.cleanup(); }
});

test('o círculo do cartão alterna sem teclas auxiliares e soma à seleção', async () => {
  const h = await mount(SIX());
  try {
    const circle = (name) => card(h, name).querySelector('.lut-checkbox');
    assert.equal(circle('B2.cube').getAttribute('aria-hidden'), 'true');
    click(h, circle('B2.cube'));
    await settle(10);
    click(h, circle('D4.cube'));
    await settle(10);
    assert.deepEqual(selectedNames(h), ['B2.cube', 'D4.cube']);
    assert.ok(barShown(h));
    assert.ok(hasClass($(h, '#lutsGrid'), 'has-selection'), 'com seleção, todos os círculos ficam à mostra');
    click(h, circle('B2.cube'));
    await settle(10);
    assert.deepEqual(selectedNames(h), ['D4.cube']);
    click(h, circle('D4.cube'));
    await settle(10);
    assert.deepEqual(selectedNames(h), []);
    assert.ok(!hasClass($(h, '#lutsGrid'), 'has-selection'));
  } finally { await h.cleanup(); }
});

test('Shift+clique marca o intervalo entre a âncora e o clique (nos dois sentidos); Ctrl+Shift soma ao que já estava', async () => {
  const h = await mount(SIX());
  try {
    click(h, card(h, 'B2.cube'));
    mouse(h, card(h, 'D4.cube'), { shiftKey: true });
    await settle(10);
    assert.deepEqual(selectedNames(h), ['B2.cube', 'C3.cube', 'D4.cube']);
    mouse(h, card(h, 'A1.cube'), { shiftKey: true }); // a âncora continua sendo B2
    await settle(10);
    assert.deepEqual(selectedNames(h), ['A1.cube', 'B2.cube']);

    mouse(h, card(h, 'F6.cube'), { ctrlKey: true }); // nova âncora: F6
    mouse(h, card(h, 'D4.cube'), { shiftKey: true, ctrlKey: true });
    await settle(10);
    assert.deepEqual(selectedNames(h).sort(), ['A1.cube', 'B2.cube', 'D4.cube', 'E5.cube', 'F6.cube']);
    assert.equal($(h, '#ftSelected').textContent, '5 LUTs');
  } finally { await h.cleanup(); }
});

test('Shift+clique sem âncora vale como clique comum', async () => {
  const h = await mount(SIX());
  try {
    mouse(h, card(h, 'C3.cube'), { shiftKey: true });
    await settle(10);
    assert.deepEqual(selectedNames(h), ['C3.cube']);
  } finally { await h.cleanup(); }
});

const TREE = () => [
  lut('Raiz1.cube'), lut('Raiz2.cube'),
  lut('Looks/L1.cube'), lut('Looks/L2.cube'),
  lut('Outra/O1.cube'), lut('Outra/O2.cube')
];
const heads = (h) => $$(h, '#lutsGrid .lut-group-head');

test('Shift+clique segue a ordem da tela e pula o que o filtro esconde e os grupos recolhidos', async () => {
  const h = await mount(TREE());
  try {
    // ordem na tela: Sem pasta (Raiz1, Raiz2), Looks (L1, L2), Outra (O1, O2)
    const looks = heads(h).find((x) => x.dataset.folder === 'Looks');
    click(h, looks.querySelector('[data-action="toggle"]')); // recolhe Looks
    await settle(10);
    click(h, card(h, 'Raiz2.cube'));
    mouse(h, card(h, 'O1.cube'), { shiftKey: true });
    await settle(10);
    assert.deepEqual(selectedNames(h).sort(), ['O1.cube', 'Raiz2.cube'], 'as LUTs do grupo recolhido não entram no intervalo');
  } finally { await h.cleanup(); }
});

test('recolher um grupo tira da seleção as LUTs dele: contagem, rodapé, barra e Delete só valem para o que se vê', async () => {
  const calls = [];
  const h = await mount(TREE(), { deleteManyLuts: async (paths) => { calls.push(paths); return { trashed: paths.length, missing: 0, failed: [] }; } });
  try {
    click(h, card(h, 'L1.cube'));
    mouse(h, card(h, 'L2.cube'), { ctrlKey: true });
    mouse(h, card(h, 'O1.cube'), { ctrlKey: true });
    await settle(10);
    assert.deepEqual(selectedNames(h).sort(), ['L1.cube', 'L2.cube', 'O1.cube']);
    assert.ok(barShown(h));
    assert.equal(ft(h), '3 LUTs');

    const looks = heads(h).find((x) => x.dataset.folder === 'Looks');
    click(h, looks.querySelector('[data-action="toggle"]')); // recolhe Looks, que tem 2 das 3 marcadas
    await settle(10);
    assert.deepEqual(selectedNames(h), ['O1.cube'], 'as LUTs escondidas saem da seleção');
    assert.equal(ft(h), '1 LUT');
    assert.ok(!barShown(h), 'com uma só marcada a barra de lote some');
    assert.equal($(h, '#insName').textContent, 'O1.cube', 'o inspetor passa a mostrar a que sobrou');

    // reabrir o grupo não traz a marcação de volta, e Delete com duas marcadas de novo pega só o que se vê
    click(h, heads(h).find((x) => x.dataset.folder === 'Looks').querySelector('[data-action="toggle"]'));
    await settle(10);
    assert.deepEqual(selectedNames(h), ['O1.cube']);
    mouse(h, card(h, 'Raiz1.cube'), { ctrlKey: true });
    mouse(h, card(h, 'L1.cube'), { ctrlKey: true });
    await settle(10);
    click(h, heads(h).find((x) => x.dataset.folder === 'Looks').querySelector('[data-action="toggle"]'));
    await settle(10);
    h.window.bdsModal.confirm = async (msg) => { h.dialogs.confirms.push(String(msg)); return true; };
    assert.equal(key(h, 'Delete'), true);
    await settle(40);
    assert.match(h.dialogs.confirms[0], /^Mover 2 LUTs/, 'a confirmação conta só as visíveis');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].map((p) => p.split(/[\\/]/).pop()).sort(), ['O1.cube', 'Raiz1.cube']);
  } finally { await h.cleanup(); }
});

test('a busca tira da seleção o que ela esconde (a ação em lote nunca age no que não se vê)', async () => {
  const h = await mount(SIX());
  try {
    click(h, card(h, 'A1.cube'));
    mouse(h, card(h, 'C3.cube'), { ctrlKey: true });
    await settle(10);
    assert.ok(barShown(h));
    const search = $(h, '#lutSearchInput');
    search.value = 'C3';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await settle(260);
    assert.deepEqual(selectedNames(h), ['C3.cube']);
    assert.ok(!barShown(h));
    assert.equal($(h, '#ftSelected').textContent, '1 LUT');
    assert.equal($(h, '#insName').textContent, 'C3.cube');
  } finally { await h.cleanup(); }
});

// ─── Teclado ─────────────────────────────────────────────────────────────────────────────────────

test('Ctrl/Cmd+A seleciona o que está visível; cede ao campo de texto e a qualquer janela aberta', async () => {
  const h = await mount(TREE());
  try {
    const looks = heads(h).find((x) => x.dataset.folder === 'Looks');
    click(h, looks.querySelector('[data-action="toggle"]'));
    await settle(10);

    assert.equal(key(h, 'a', { ctrlKey: true, target: $(h, '#lutSearchInput') }), false, 'no campo de texto o Ctrl+A é do campo');
    assert.deepEqual(selectedNames(h), []);

    h.window.bdsModal.isOpen = () => true;
    assert.equal(key(h, 'a', { ctrlKey: true }), false, 'com um diálogo aberto não age');
    h.window.bdsModal.isOpen = () => false;
    assert.deepEqual(selectedNames(h), []);

    assert.equal(key(h, 'a', { ctrlKey: true }), true);
    await settle(10);
    assert.deepEqual(selectedNames(h).sort(), ['O1.cube', 'O2.cube', 'Raiz1.cube', 'Raiz2.cube'], 'sem as do grupo recolhido');
    assert.equal($(h, '#ftSelected').textContent, '4 LUTs');

    key(h, 'Escape');
    await settle(10);
    assert.deepEqual(selectedNames(h), []);
    assert.equal(key(h, 'A', { metaKey: true }), true, 'Cmd+A no Mac também');
    await settle(10);
    assert.equal(selectedNames(h).length, 4);
    assert.equal(key(h, 'a', { ctrlKey: true, shiftKey: true }), false, 'Ctrl+Shift+A não é "selecionar tudo"');
  } finally { await h.cleanup(); }
});

test('Esc em camadas: primeiro o menu, depois a janela, depois a tela cheia, e só por último limpa a seleção', async () => {
  const h = await mount(SIX(), { parseLutCube: parseGood });
  try {
    click(h, card(h, 'A1.cube'));
    mouse(h, card(h, 'B2.cube'), { ctrlKey: true });
    await settle(10);
    assert.equal(selectedNames(h).length, 2);

    // menu do cartão aberto: o Esc só fecha o menu
    click(h, card(h, 'A1.cube').querySelector('[data-action="menu"]'));
    await settle(10);
    assert.ok(!hasClass($(h, '#lutCardMenu'), 'hidden'));
    assert.equal(selectedNames(h).length, 2, 'abrir o menu de uma LUT marcada mantém a seleção');
    assert.equal(key(h, 'Escape'), true);
    assert.ok(hasClass($(h, '#lutCardMenu'), 'hidden'));
    assert.equal(selectedNames(h).length, 2);

    // um diálogo do aplicativo aberto: o Esc não limpa a seleção
    h.window.bdsModal.isOpen = () => true;
    assert.equal(key(h, 'Escape'), false);
    h.window.bdsModal.isOpen = () => false;
    assert.equal(selectedNames(h).length, 2);

    // campo de texto: o Esc é do campo
    assert.equal(key(h, 'Escape', { target: $(h, '#lutSearchInput') }), false);
    assert.equal(selectedNames(h).length, 2);

    // por último, a seleção
    assert.equal(key(h, 'Escape'), true);
    await settle(10);
    assert.deepEqual(selectedNames(h), []);
    assert.equal(ft(h), '0 LUTs');
    assert.equal(key(h, 'Escape'), false, 'sem seleção o Esc não faz nada');

    // tela cheia: o Esc a fecha e a seleção (uma LUT) continua; o seguinte limpa
    click(h, card(h, 'C3.cube'));
    await settle(30);
    click(h, $(h, '#btnFullscreenLut'));
    await settle(10);
    assert.ok(!hasClass($(h, '#lutFullscreenModal'), 'hidden'));
    assert.equal(key(h, 'Escape'), true);
    assert.ok(hasClass($(h, '#lutFullscreenModal'), 'hidden'));
    assert.deepEqual(selectedNames(h), ['C3.cube']);
    assert.equal(key(h, 'Escape'), true);
    await settle(10);
    assert.deepEqual(selectedNames(h), []);
  } finally { await h.cleanup(); }
});

test('teclado no cartão: Ctrl+Espaço alterna, Shift+seta estende a partir da LUT em foco, Enter marca só uma', async () => {
  const h = await mount(SIX());
  try {
    const focusOn = (name) => card(h, name);
    press(h, focusOn('B2.cube'), ' ', { ctrlKey: true });
    press(h, focusOn('D4.cube'), 'Enter', { ctrlKey: true });
    await settle(10);
    assert.deepEqual(selectedNames(h), ['B2.cube', 'D4.cube']);

    press(h, focusOn('D4.cube'), 'ArrowRight', { shiftKey: true }); // âncora D4: D4..E5
    await settle(10);
    assert.deepEqual(selectedNames(h), ['D4.cube', 'E5.cube']);
    press(h, focusOn('E5.cube'), 'ArrowRight', { shiftKey: true });
    await settle(10);
    assert.deepEqual(selectedNames(h), ['D4.cube', 'E5.cube', 'F6.cube']);
    press(h, focusOn('F6.cube'), 'ArrowLeft', { shiftKey: true });
    press(h, focusOn('E5.cube'), 'ArrowLeft', { shiftKey: true });
    await settle(10);
    assert.deepEqual(selectedNames(h), ['D4.cube'], 'voltar com Shift+seta encolhe o intervalo');

    // seta sem Shift só move o foco (a seleção fica)
    press(h, focusOn('D4.cube'), 'ArrowRight');
    await settle(10);
    assert.deepEqual(selectedNames(h), ['D4.cube']);

    press(h, focusOn('A1.cube'), 'Enter'); // Enter comum: só esta
    await settle(10);
    assert.deepEqual(selectedNames(h), ['A1.cube']);
    press(h, focusOn('C3.cube'), ' ', { shiftKey: true }); // Shift+Espaço: até esta
    await settle(10);
    assert.deepEqual(selectedNames(h), ['A1.cube', 'B2.cube', 'C3.cube']);
  } finally { await h.cleanup(); }
});

test('Shift+seta sem seleção começa na LUT em foco', async () => {
  const h = await mount(SIX());
  try {
    press(h, card(h, 'C3.cube'), 'ArrowDown', { shiftKey: true });
    await settle(10);
    assert.deepEqual(selectedNames(h), ['C3.cube', 'D4.cube']);
  } finally { await h.cleanup(); }
});

test('com uma janela aberta o teclado do cartão não marca nada', async () => {
  const h = await mount(SIX());
  try {
    h.window.bdsModal.isOpen = () => true;
    press(h, card(h, 'B2.cube'), 'Enter', { ctrlKey: true });
    await settle(10);
    assert.deepEqual(selectedNames(h), []);
  } finally { await h.cleanup(); }
});

test('F2 renomeia só com uma LUT marcada; com várias é ignorado', async () => {
  const prompts = [];
  const h = await mount(SIX());
  try {
    h.window.bdsModal.prompt = async (...a) => { prompts.push(a); return null; };
    click(h, card(h, 'A1.cube'));
    mouse(h, card(h, 'B2.cube'), { ctrlKey: true });
    await settle(10);
    assert.equal(key(h, 'F2'), false);
    await settle(10);
    assert.equal(prompts.length, 0);
    mouse(h, card(h, 'B2.cube'), { ctrlKey: true });
    await settle(10);
    assert.equal(key(h, 'F2'), true);
    await settle(10);
    assert.equal(prompts.length, 1);
  } finally { await h.cleanup(); }
});

// ─── Barra de ações ──────────────────────────────────────────────────────────────────────────────

test('barra de ações: só com 2 ou mais, com "Adicionar a um projeto…", "Excluir" e "Limpar seleção"; sem botão fixo novo no topo', async () => {
  const h = await mount(SIX());
  try {
    assert.equal(bar(h).getAttribute('role'), 'toolbar');
    assert.ok(!barShown(h));
    assert.deepEqual([...bar(h).querySelectorAll('button')].map((b) => b.textContent.split(/\s+/).filter(Boolean).join(' ')), ['playlist_add Adicionar a um projeto…', 'delete Excluir', 'Limpar seleção']);
    // o cabeçalho continua com os mesmos controles (nada novo fixo no topo)
    assert.equal($$(h, '.luts-header button').length, 6);
    click(h, card(h, 'A1.cube'));
    await settle(10);
    assert.ok(!barShown(h));
    mouse(h, card(h, 'B2.cube'), { ctrlKey: true });
    await settle(10);
    assert.ok(barShown(h));
    click(h, $(h, '#btnSelClear'));
    await settle(10);
    assert.ok(!barShown(h));
    assert.deepEqual(selectedNames(h), []);
  } finally { await h.cleanup(); }
});

test('textos da barra, do resumo e do menu: português, sem emoji e sem nomes de programas internos', async () => {
  const h = await mount(SIX());
  try {
    const text = ['#lutSelectionBar', '#insMulti', '#lutGroupMenu', '#lutCardMenu'].map((s) => $(h, s).textContent).join(' ');
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(text));
    assert.ok(!/SHA|hash|walkTree|ffmpeg|sqlite|manifest/i.test(text));
    assert.match(text, /Limpar seleção/);
    assert.equal($$(h, '#lutSelectionBar button').every((b) => b.textContent.trim()), true, 'todo botão tem nome');
  } finally { await h.cleanup(); }
});

test('resumo no inspetor: contagem, tamanho total e só os 5 primeiros nomes (por textContent, nunca como HTML)', async () => {
  const list = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7'].map((n, i) => lut(`${n}.cube`, { size: 1024 * 1024 * (i + 1) }));
  list[0] = lut('<img src=x onerror=alert(1)>.cube', { size: 1024 * 1024 });
  const h = await mount(list);
  try {
    key(h, 'a', { ctrlKey: true });
    await settle(10);
    assert.equal($(h, '#insMultiTitle').textContent, '7 LUTs selecionadas');
    assert.equal($(h, '#insMultiSize').textContent, 'Tamanho total: 28 MB');
    const items = $$(h, '#insMultiList li').map((li) => li.textContent);
    assert.equal(items.length, 6);
    assert.equal(items[0], '<img src=x onerror=alert(1)>.cube');
    assert.equal(items[5], 'e mais 2');
    assert.equal($$(h, '#insMultiList img').length, 0);
    assert.equal($$(h, '#lutsGrid img[onerror]').length, 0);
  } finally { await h.cleanup(); }
});

// ─── Menus: cartão e pasta ───────────────────────────────────────────────────────────────────────

test('menu do cartão pelo teclado: o ⋮ fica fora do Tab, Menu/Shift+F10 abre, setas e Home/End andam e o foco volta ao cartão', async () => {
  const revealed = [];
  const h = await mount(SIX(), { revealLut: async (p) => { revealed.push(p); return true; } });
  // linkedom não tem foco real: um "activeElement" simulado, alimentado por focus()
  const foco = { atual: null };
  Object.defineProperty(h.document, 'activeElement', { configurable: true, get: () => foco.atual });
  const proto = h.window.Element.prototype;
  const original = proto.focus;
  proto.focus = function focar() { foco.atual = this; };
  try {
    for (const c of cards(h)) {
      const dots = c.querySelector('[data-action="menu"]');
      assert.equal(dots.getAttribute('tabindex'), '-1', 'o ⋮ de cada cartão não é parada de Tab (a grade tem uma só)');
      assert.equal(dots.getAttribute('aria-hidden'), 'true', 'sem botão dentro do cartão que é uma opção da lista');
    }
    const menu = $(h, '#lutCardMenu');
    const items = () => [...menu.querySelectorAll('button')].filter((b) => !hasClass(b, 'hidden'));
    const a1 = card(h, 'A1.cube');
    a1.focus();

    assert.equal(press(h, a1, 'F10').defaultPrevented, false, 'F10 sem Shift não faz nada');
    assert.ok(hasClass(menu, 'hidden'));
    assert.equal(press(h, a1, 'F10', { shiftKey: true }).defaultPrevented, true);
    await settle(10);
    assert.ok(!hasClass(menu, 'hidden'), 'Shift+F10 abre o menu da LUT em foco');
    assert.deepEqual(selectedNames(h), ['A1.cube'], 'o menu age sobre a LUT em foco');
    assert.ok(foco.atual === items()[0], 'o foco vai para o primeiro item');

    const list = items();
    press(h, foco.atual, 'ArrowDown');
    assert.ok(foco.atual === list[1]);
    press(h, foco.atual, 'End');
    assert.ok(foco.atual === list.at(-1));
    press(h, foco.atual, 'ArrowDown');
    assert.ok(foco.atual === list[0], 'dá a volta');
    press(h, foco.atual, 'ArrowUp');
    assert.ok(foco.atual === list.at(-1));
    press(h, foco.atual, 'Home');
    assert.ok(foco.atual === list[0]);

    press(h, foco.atual, 'Escape');
    assert.ok(hasClass(menu, 'hidden'));
    assert.ok(foco.atual === a1, 'Esc devolve o foco ao cartão de origem');

    assert.equal(press(h, a1, 'ContextMenu').defaultPrevented, true);
    await settle(10);
    assert.ok(!hasClass(menu, 'hidden'), 'a tecla Menu também abre');
    click(h, menu.querySelector('[data-action="reveal"]'));
    await settle(10);
    assert.ok(hasClass(menu, 'hidden'));
    assert.equal(revealed.length, 1);
    assert.ok(foco.atual === a1, 'depois de escolher uma ação o foco também volta ao cartão');

    // aberto pelo ⋮ com o mouse, o foco também volta ao cartão (não ao botão fora do Tab)
    click(h, a1.querySelector('[data-action="menu"]'));
    await settle(10);
    press(h, foco.atual, 'Escape');
    assert.ok(foco.atual === a1);
  } finally { proto.focus = original; await h.cleanup(); }
});

test('menu do cartão dentro de uma seleção múltipla: só "Excluir N LUTs", e age sobre todas', async () => {
  const deleted = [];
  const items = SIX();
  const h = await mount(items, {
    deleteManyLuts: async (paths) => { deleted.push(paths); return { trashed: paths.length, missing: 0, failed: [] }; }
  });
  try {
    click(h, card(h, 'A1.cube'));
    mouse(h, card(h, 'B2.cube'), { ctrlKey: true });
    await settle(10);
    click(h, card(h, 'A1.cube').querySelector('[data-action="menu"]'));
    await settle(10);
    const menu = $(h, '#lutCardMenu');
    assert.ok(hasClass(menu.querySelector('[data-action="rename"]'), 'hidden'));
    assert.ok(hasClass(menu.querySelector('[data-action="reveal"]'), 'hidden'));
    assert.equal(menu.querySelector('[data-action="delete"]').textContent.trim().replace(/^delete\s*/, ''), 'Excluir 2 LUTs');
    click(h, menu.querySelector('[data-action="delete"]'));
    await settle(30);
    assert.equal(h.dialogs.confirms.length, 1);
    assert.deepEqual(deleted, [[items[0].path, items[1].path]]);

    // menu de uma LUT que NÃO está marcada: seleciona só ela e volta ao menu completo
    click(h, card(h, 'E5.cube').querySelector('[data-action="menu"]'));
    await settle(10);
    assert.deepEqual(selectedNames(h), ['E5.cube']);
    assert.ok(!hasClass(menu.querySelector('[data-action="rename"]'), 'hidden'));
    assert.equal(menu.querySelector('[data-action="delete"]').textContent.trim().replace(/^delete\s*/, ''), 'Excluir');
  } finally { await h.cleanup(); }
});

test('menu da pasta: "Selecionar as LUTs desta pasta" marca o grupo (e abre o que estava recolhido)', async () => {
  const h = await mount(TREE());
  try {
    const looks = () => heads(h).find((x) => x.dataset.folder === 'Looks');
    click(h, looks().querySelector('[data-action="toggle"]'));
    await settle(10);
    assert.ok(cards(h).filter((c) => hasClass(c, 'lut-collapsed')).length === 2);
    click(h, looks().querySelector('[data-action="group-menu"]'));
    await settle(10);
    click(h, $(h, '#lutGroupMenu [data-action="select-folder"]'));
    await settle(10);
    assert.deepEqual(selectedNames(h).sort(), ['L1.cube', 'L2.cube']);
    assert.ok(cards(h).every((c) => !hasClass(c, 'lut-collapsed')), 'o grupo foi aberto');
    assert.ok(barShown(h));
    assert.equal($(h, '#ftSelected').textContent, '2 LUTs');
  } finally { await h.cleanup(); }
});

// ─── Excluir em lote ─────────────────────────────────────────────────────────────────────────────

test('Excluir da barra: UMA confirmação com a contagem e os nomes, um envio e o resumo do que foi movido', async () => {
  const items = SIX();
  const calls = [];
  const h = await mount(items, {
    deleteManyLuts: async (paths) => {
      calls.push(paths);
      for (const p of paths) items.splice(items.findIndex((i) => i.path === p), 1);
      return { trashed: paths.length, missing: 0, failed: [] };
    },
    deleteLut: async () => { throw new Error('uma LUT só usa o outro canal'); }
  });
  try {
    click(h, card(h, 'B2.cube'));
    mouse(h, card(h, 'D4.cube'), { shiftKey: true });
    await settle(10);
    click(h, $(h, '#btnSelDelete'));
    await settle(60);
    assert.equal(h.dialogs.confirms.length, 1);
    assert.match(h.dialogs.confirms[0], /^Mover 3 LUTs para a lixeira\?/);
    for (const n of ['B2.cube', 'C3.cube', 'D4.cube']) assert.ok(h.dialogs.confirms[0].includes(n), n);
    assert.ok(!h.dialogs.confirms[0].includes('A1.cube'));
    assert.deepEqual(calls.map((c) => c.length), [3]);
    assert.deepEqual(cards(h).filter((c) => !hasClass(c, 'hidden')).map(title), ['A1.cube', 'E5.cube', 'F6.cube']);
    assert.deepEqual(selectedNames(h), []);
    assert.ok(!barShown(h));
    assert.equal($(h, '#ftSelected').textContent, '0 LUTs');
    assert.equal($(h, '#lutsNoticeText').textContent, '3 LUTs movidas para a lixeira.');
    assert.match($(h, '#lutsNotice').className, /tone-success/);
  } finally { await h.cleanup(); }
});

test('a tecla Delete com várias marcadas também faz uma confirmação só; cancelar não exclui nada e mantém a seleção', async () => {
  const calls = [];
  const h = await mount(SIX(), { deleteManyLuts: async (paths) => { calls.push(paths); return { trashed: paths.length, missing: 0, failed: [] }; } });
  try {
    key(h, 'a', { ctrlKey: true });
    await settle(10);
    h.window.bdsModal.confirm = async (msg) => { h.dialogs.confirms.push(String(msg)); return false; };
    assert.equal(key(h, 'Delete'), true);
    await settle(30);
    assert.equal(h.dialogs.confirms.length, 1);
    assert.match(h.dialogs.confirms[0], /^Mover 6 LUTs/);
    assert.deepEqual(calls, []);
    assert.equal(selectedNames(h).length, 6, 'a seleção continua');
    assert.ok(barShown(h));
  } finally { await h.cleanup(); }
});

test('a confirmação lista só os primeiros nomes ("e mais N") e nunca usa HTML', async () => {
  const items = Array.from({ length: 12 }, (_, i) => lut(`L${String(i + 1).padStart(2, '0')}.cube`));
  const h = await mount(items, { deleteManyLuts: async (paths) => ({ trashed: paths.length, missing: 0, failed: [] }) });
  try {
    key(h, 'a', { ctrlKey: true });
    await settle(10);
    click(h, $(h, '#btnSelDelete'));
    await settle(40);
    const msg = h.dialogs.confirms[0];
    assert.match(msg, /^Mover 12 LUTs para a lixeira\?/);
    assert.equal((msg.match(/^• /gm) || []).length, 8);
    assert.match(msg, /e mais 4/);
  } finally { await h.cleanup(); }
});

test('resultado misto: movidas, "já não existia" e as que falharam; o que falhou continua selecionado', async () => {
  const items = SIX();
  const h = await mount(items, {
    deleteManyLuts: async (paths) => {
      // A1 vai; B2 já não existia; C3 falha; os demais vão
      const gone = [items[0].path, items[3].path, items[4].path, items[5].path];
      for (const p of gone) { const i = items.findIndex((x) => x.path === p); if (i >= 0) items.splice(i, 1); }
      return { trashed: 4, missing: 1, failed: [{ path: paths[2], reason: 'Não foi possível mover a LUT para a Lixeira.' }] };
    }
  });
  try {
    key(h, 'a', { ctrlKey: true });
    await settle(10);
    click(h, $(h, '#btnSelDelete'));
    await settle(60);
    const lines = $(h, '#lutsNoticeText').textContent.split('\n');
    assert.deepEqual(lines, [
      '4 LUTs movidas para a lixeira.',
      '1 LUT já não existia na pasta.',
      '1 LUT não pôde ser movida: C3.cube (Não foi possível mover a LUT para a Lixeira.).'
    ]);
    assert.match($(h, '#lutsNotice').className, /tone-warning/);
    assert.deepEqual(cards(h).filter((c) => !hasClass(c, 'hidden')).map(title), ['B2.cube', 'C3.cube']);
    // B2 sumiu do disco entre as duas cargas? não: continua; as duas que a lista ainda tem seguem selecionadas
    assert.deepEqual(selectedNames(h), ['B2.cube', 'C3.cube']);
    assert.ok(barShown(h));
  } finally { await h.cleanup(); }
});

test('exclusão em lote que falha de vez mostra o erro em português e mantém tudo como estava', async () => {
  const h = await mount(SIX(), { deleteManyLuts: async () => { throw new Error('Error invoking remote method \'luts:deleteMany\': Error: Há outra operação em andamento.'); } });
  try {
    key(h, 'a', { ctrlKey: true });
    await settle(10);
    click(h, $(h, '#btnSelDelete'));
    await settle(60);
    const text = $(h, '#lutsNoticeText').textContent;
    assert.match(text, /Há outra operação em andamento\./);
    assert.ok(!/Error invoking/.test(text));
    assert.match($(h, '#lutsNotice').className, /tone-danger/);
    assert.equal(selectedNames(h).length, 6);
    assert.equal(cards(h).filter((c) => !hasClass(c, 'hidden')).length, 6);
  } finally { await h.cleanup(); }
});

test('1200 LUTs excluídas de uma vez: blocos de 500, uma confirmação só e o andamento no aviso', async () => {
  const items = Array.from({ length: 1200 }, (_, i) => lut(`Lote/L${String(i).padStart(4, '0')}.cube`));
  const sizes = [];
  const progress = [];
  let h;
  h = await mount(items, {
    deleteManyLuts: async (paths) => {
      sizes.push(paths.length);
      progress.push($(h, '#lutsNoticeText').textContent);
      const gone = new Set(paths);
      for (let i = items.length - 1; i >= 0; i--) if (gone.has(items[i].path)) items.splice(i, 1);
      return { trashed: paths.length, missing: 0, failed: [] };
    }
  });
  try {
    assert.equal(cards(h).length, 1200);
    key(h, 'a', { ctrlKey: true });
    await settle(30);
    assert.equal($(h, '#ftSelected').textContent, '1200 LUTs');
    click(h, $(h, '#btnSelDelete'));
    await settle(400);
    assert.equal(h.dialogs.confirms.length, 1);
    assert.match(h.dialogs.confirms[0], /^Mover 1200 LUTs/);
    assert.deepEqual(sizes, [500, 500, 200]);
    assert.match(progress[1], /500 de 1200/);
    assert.match(progress[2], /1000 de 1200/);
    assert.equal($(h, '#lutsNoticeText').textContent, '1200 LUTs movidas para a lixeira.');
    assert.equal(cards(h).length, 0);
    assert.equal(items.length, 0);
    assert.equal($(h, '#ftSelected').textContent, '0 LUTs');
  } finally { await h.cleanup(); }
});

test('uma LUT só continua usando o canal e a mensagem de antes (nome, sem lista)', async () => {
  const deleted = [];
  const h = await mount(SIX(), { deleteLut: async (p) => { deleted.push(p); return true; }, deleteManyLuts: async () => { throw new Error('não é para usar'); } });
  try {
    click(h, card(h, 'B2.cube'));
    await settle(10);
    click(h, $(h, '#btnDeleteLut'));
    await settle(40);
    assert.deepEqual(h.dialogs.confirms, ['Mover "B2.cube" para a lixeira?']);
    assert.deepEqual(deleted, ['C:\\LUTs\\B2.cube']);
  } finally { await h.cleanup(); }
});

// ─── Recarga, foco e regras puras ────────────────────────────────────────────────────────────────

test('ao recarregar a lista a seleção segue as LUTs que ainda existem (objetos novos) e perde as que sumiram', async () => {
  const items = SIX();
  const h = await mount(items);
  try {
    click(h, card(h, 'A1.cube'));
    mouse(h, card(h, 'B2.cube'), { ctrlKey: true });
    mouse(h, card(h, 'C3.cube'), { ctrlKey: true });
    await settle(10);
    assert.equal($(h, '#ftSelected').textContent, '3 LUTs');
    items.splice(1, 1); // B2 some do disco
    click(h, $(h, '#btnRefreshLuts'));
    await settle(60);
    assert.deepEqual(selectedNames(h), ['A1.cube', 'C3.cube']);
    assert.equal($(h, '#ftSelected').textContent, '2 LUTs');
    assert.equal($(h, '#insMultiTitle').textContent, '2 LUTs selecionadas');
    items.splice(0, 1); // A1 também some: sobra uma só e o inspetor volta a mostrá-la
    click(h, $(h, '#btnRefreshLuts'));
    await settle(60);
    assert.deepEqual(selectedNames(h), ['C3.cube']);
    assert.equal($(h, '#insName').textContent, 'C3.cube');
    assert.ok(!barShown(h));
  } finally { await h.cleanup(); }
});

test('foco: "Limpar seleção" e "Excluir" na barra não deixam o foco sem lugar', async () => {
  const items = SIX();
  const h = await mount(items, {
    deleteManyLuts: async (paths) => {
      for (const p of paths) items.splice(items.findIndex((i) => i.path === p), 1);
      return { trashed: paths.length, missing: 0, failed: [] };
    }
  });
  // linkedom não tem foco real: um "activeElement" simulado, alimentado por focus()
  const foco = { atual: null };
  Object.defineProperty(h.document, 'activeElement', { configurable: true, get: () => foco.atual });
  const proto = h.window.Element.prototype;
  const original = proto.focus;
  proto.focus = function focar() { foco.atual = this; };
  try {
    click(h, card(h, 'B2.cube'));
    mouse(h, card(h, 'C3.cube'), { ctrlKey: true });
    await settle(10);
    const clear = $(h, '#btnSelClear');
    clear.focus();
    assert.ok(foco.atual === clear, 'o botão está em foco');
    click(h, clear);
    await settle(10);
    assert.ok(foco.atual && foco.atual.classList.contains('lut-card'), 'o foco foi para um cartão (a barra sumiu)');
    assert.equal(title(foco.atual), 'C3.cube', 'o cartão em que a pessoa estava (a âncora)');

    // excluir pela barra: o foco vai para o cartão que ocupa o lugar do primeiro excluído
    click(h, card(h, 'B2.cube'));
    mouse(h, card(h, 'C3.cube'), { ctrlKey: true });
    await settle(10);
    const del = $(h, '#btnSelDelete');
    del.focus();
    click(h, del);
    await settle(80);
    assert.ok(foco.atual && foco.atual.classList.contains('lut-card'), 'o foco ficou num cartão');
    assert.equal(title(foco.atual), 'D4.cube');
  } finally { proto.focus = original; await h.cleanup(); }
});

test('selection.js: intervalo, resumo, âncora e poda (regras puras)', async () => {
  const mod = await import(pathToFileURL(path.join(SCREENS_DIR, 'luts', 'selection.js')).href);
  const order = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(mod.rangePaths(order, 'b', 'd'), ['b', 'c', 'd']);
  assert.deepEqual(mod.rangePaths(order, 'd', 'b'), ['b', 'c', 'd']);
  assert.deepEqual(mod.rangePaths(order, 'c', 'c'), ['c']);
  assert.equal(mod.rangePaths(order, 'x', 'd'), null);
  assert.equal(mod.rangePaths(order, 'b', 'x'), null);

  const s = mod.createSelection();
  assert.equal(s.size, 0);
  assert.equal(s.only(), null);
  assert.equal(s.selectRange(order, 'c'), false, 'sem âncora não há intervalo');
  assert.equal(s.toggle('b'), true);
  assert.equal(s.anchor, 'b');
  assert.equal(s.only(), 'b');
  assert.equal(s.selectRange(order, 'd'), true);
  assert.deepEqual(s.paths(), ['b', 'c', 'd']);
  assert.equal(s.only(), null);
  assert.equal(s.selectRange(order, 'a', { additive: true }), true);
  assert.deepEqual(s.paths().sort(), ['a', 'b', 'c', 'd']);
  assert.equal(s.selectRange(['q', 'r'], 'r'), false, 'âncora fora da lista visível');
  assert.equal(s.toggle('c'), false);
  assert.equal(s.anchor, 'c');
  assert.equal(s.prune((p) => p !== 'a' && p !== 'c'), true, 'saiu algo');
  assert.deepEqual(s.paths().sort(), ['b', 'd']);
  assert.equal(s.anchor, null, 'a âncora que saiu é esquecida');
  assert.equal(s.prune(() => true), false);
  s.replace(['x', 'y'], 'y');
  assert.deepEqual(s.paths(), ['x', 'y']);
  assert.equal(s.anchor, 'y');
  assert.equal(s.clear(), true);
  assert.equal(s.clear(), false);
  assert.equal(s.size, 0);
  assert.equal(s.anchor, null);

  const sum = mod.summarize([{ name: 'a', size: 10 }, { name: 'b', size: 5 }, { name: 'c' }, { name: 'd', size: -3 }, { name: 'e', size: 1 }, { name: 'f', size: 1 }, { name: 'g', size: 1 }]);
  assert.deepEqual(sum, { count: 7, totalBytes: 18, names: ['a', 'b', 'c', 'd', 'e'], more: 2 });
  assert.deepEqual(mod.summarize([]), { count: 0, totalBytes: 0, names: [], more: 0 });
});
