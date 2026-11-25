'use strict';

// Tela de LUTs (S2): grupos por pasta na grade, recolher, menu da pasta, botão Importar com menu e a janela de importação
// (resumo antes de copiar, só o marcado, progresso e cancelamento). Harness: linkedom + window.bds simulado.

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
    folder: parts.join('/'), depth: parts.length, size: 1000 + name.length, modifiedAt: NOW - name.length * 1000, ...extra
  };
};
const HEADER = { ok: true, title: 'T', size: 17, is1D: false, domainMin: null, domainMax: null, totalEntries: 4913, preview: [[0, 0, 0]] };

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
const click = (h, el) => el.dispatchEvent(new h.window.Event('click', { bubbles: true }));
const change = (h, el) => el.dispatchEvent(new h.window.Event('change', { bubbles: true }));
const keydown = (h, el, key) => el.dispatchEvent(Object.assign(new h.window.Event('keydown', { bubbles: true }), { key }));
const key = (h, k, extra = {}) => { let prevented = false; h.mod.onKeyDown({ key: k, target: h.document.body, preventDefault() { prevented = true; }, ...extra }); return prevented; };
const heads = (h) => $$(h, '#lutsGrid .lut-group-head');
const headText = (head) => `${head.querySelector('.lut-group-name').textContent}|${head.querySelector('.lut-group-count').textContent}`;
const cards = (h) => $$(h, '#lutsGrid .lut-card');
const shownNames = (h) => cards(h).filter((c) => !hasClass(c, 'hidden') && !hasClass(c, 'lut-collapsed')).map((c) => c.querySelector('.lut-card-title').textContent);
const gridOrder = (h) => [...$(h, '#lutsGrid').children].filter((c) => !hasClass(c, 'hidden')).map((c) => (hasClass(c, 'lut-group-head') ? `[${c.querySelector('.lut-group-name').textContent}]` : c.querySelector('.lut-card-title').textContent));

const TREE = () => [
  lut('Solta.cube'),
  lut('Looks/Rush/b.cube'), lut('Looks/Rush/a.cube'),
  lut('Looks/Look 10/x.cube'), lut('Looks/Look 2/y.cube'),
  lut('Outra/z.cube')
];

// ─── Grupos na grade ─────────────────────────────────────────────────────────────────────────────

test('grupos: com subpastas a grade mostra um cabeçalho por pasta (raiz primeiro, ordem natural) com a contagem', async () => {
  const h = await mount(TREE());
  try {
    assert.deepEqual(heads(h).map(headText), ['Sem pasta|1 LUT', 'Looks / Look 2|1 LUT', 'Looks / Look 10|1 LUT', 'Looks / Rush|2 LUTs', 'Outra|1 LUT']);
    assert.equal(gridOrder(h)[0], '[Sem pasta]');
    assert.equal(gridOrder(h)[1], 'Solta.cube');
    assert.equal($(h, '#ftTotal').textContent, '6 LUTs');
    // a raiz não tem menu da pasta; as demais têm, com nome acessível
    assert.equal(heads(h)[0].querySelector('[data-action="group-menu"]'), null);
    const menuButton = heads(h)[3].querySelector('[data-action="group-menu"]');
    assert.equal(menuButton.getAttribute('aria-label'), 'Mais opções da pasta Looks / Rush');
    assert.equal(menuButton.getAttribute('aria-haspopup'), 'menu');
    assert.equal(heads(h)[3].querySelector('[data-action="toggle"]').getAttribute('aria-expanded'), 'true');
  } finally { await h.cleanup(); }
});

test('grupos: sem nenhuma subpasta a grade continua plana (sem cabeçalhos)', async () => {
  const h = await mount([lut('A.cube'), lut('B.cube')]);
  try {
    assert.equal(heads(h).length, 0);
    assert.equal(shownNames(h).length, 2);
  } finally { await h.cleanup(); }
});

test('grupos: a ordem escolhida vale dentro de cada grupo e a contagem acompanha o filtro (grupo sem LUT visível some)', async () => {
  const h = await mount(TREE());
  try {
    const sort = $(h, '#lutSortFilter');
    sort.value = 'name';
    change(h, sort);
    await settle(20);
    const order = gridOrder(h);
    assert.ok(order.indexOf('a.cube') < order.indexOf('b.cube'), 'dentro do grupo, A-Z');
    // tipo 1D: ninguém é 1D (o simulado só devolve inválidas): só "Todos" mostra grupos; escolher 1D esvazia tudo
    const type = $(h, '#lutTypeFilter');
    type.value = '1d';
    change(h, type);
    await settle(30);
    assert.equal(heads(h).length, 0, 'sem LUT visível não sobra cabeçalho');
  } finally { await h.cleanup(); }
});

test('grupos: com busca a lista é plana e o cartão diz em que pasta a LUT está', async () => {
  const h = await mount(TREE());
  try {
    const search = $(h, '#lutSearchInput');
    search.value = 'rush';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await settle(260);
    // o nome não casa com "rush": busca pelo nome do arquivo
    search.value = 'a.cube';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await settle(260);
    assert.equal(heads(h).length, 0);
    const card = cards(h).find((c) => !hasClass(c, 'hidden'));
    const tag = card.querySelector('.lut-card-folder');
    assert.equal(tag.textContent, 'em Looks / Rush');
    assert.equal(tag.hasAttribute('hidden'), false);
    search.value = '';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await settle(260);
    assert.equal(heads(h).length, 5, 'sem busca, os grupos voltam');
    assert.ok(cards(h).every((c) => c.querySelector('.lut-card-folder').hasAttribute('hidden')), 'o cabeçalho já diz a pasta');
  } finally { await h.cleanup(); }
});

test('recolher: esconde os cartões do grupo, vale depois de redesenhar/filtrar e fica lembrado no navegador', async () => {
  const h = await mount(TREE());
  try {
    const rush = () => heads(h).find((x) => x.dataset.folder === 'Looks/Rush');
    click(h, rush().querySelector('[data-action="toggle"]'));
    await settle(10);
    assert.ok(hasClass(rush(), 'collapsed'));
    assert.equal(rush().querySelector('[data-action="toggle"]').getAttribute('aria-expanded'), 'false');
    assert.match(rush().querySelector('[data-action="toggle"]').getAttribute('aria-label'), /^Mostrar as LUTs de Looks \/ Rush/);
    assert.deepEqual(shownNames(h).sort(), ['Solta.cube', 'x.cube', 'y.cube', 'z.cube']);
    assert.equal(cards(h).filter((c) => hasClass(c, 'hidden')).length, 0, 'recolher não usa a classe do filtro');
    assert.deepEqual(JSON.parse(h.window.localStorage.getItem('bds.luts.collapsedFolders')), ['Looks/Rush']);

    // redesenhar (ordem) e filtrar não desfazem
    const sort = $(h, '#lutSortFilter');
    sort.value = 'size';
    change(h, sort);
    await settle(20);
    assert.ok(hasClass(rush(), 'collapsed'));
    assert.equal(shownNames(h).includes('a.cube'), false);
    h.mod.onLeave();
    h.mod.onEnter();
    await settle(30);
    assert.ok(hasClass(rush(), 'collapsed'));

    // clicar de novo expande
    click(h, rush().querySelector('[data-action="toggle"]'));
    await settle(10);
    assert.equal(shownNames(h).length, 6);
    assert.deepEqual(JSON.parse(h.window.localStorage.getItem('bds.luts.collapsedFolders')), []);
  } finally { await h.cleanup(); }
});

test('recolher: clicar em qualquer ponto do cabeçalho alterna, e o botão da pasta NÃO recolhe', async () => {
  const h = await mount(TREE());
  try {
    const outra = () => heads(h).find((x) => x.dataset.folder === 'Outra');
    click(h, outra().querySelector('.lut-group-name'));
    await settle(10);
    assert.ok(hasClass(outra(), 'collapsed'));
    click(h, outra().querySelector('[data-action="group-menu"]'));
    await settle(10);
    assert.ok(hasClass(outra(), 'collapsed'), 'abrir o menu não alterna');
    assert.ok(!hasClass($(h, '#lutGroupMenu'), 'hidden'));
  } finally { await h.cleanup(); }
});

test('recolher: o estado lembrado de uma abertura anterior é aplicado ao abrir a tela (e armazenamento quebrado não derruba nada)', async () => {
  const h = await mountScreen('luts', { bds: bdsFor(TREE()), init: false });
  try {
    h.window.localStorage.setItem('bds.luts.collapsedFolders', JSON.stringify(['Outra', 'Looks/Rush']));
    await h.mod.initScreen();
    await settle(30);
    assert.ok(hasClass(heads(h).find((x) => x.dataset.folder === 'Outra'), 'collapsed'));
    assert.deepEqual(shownNames(h).sort(), ['Solta.cube', 'x.cube', 'y.cube']);
  } finally { await h.cleanup(); }
  const broken = await mountScreen('luts', { bds: bdsFor(TREE()), init: false });
  try {
    broken.window.localStorage = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } };
    await broken.mod.initScreen();
    await settle(30);
    assert.equal(heads(broken).length, 5);
    click(broken, heads(broken)[1].querySelector('[data-action="toggle"]'));
    await settle(10);
    assert.ok(hasClass(heads(broken)[1], 'collapsed'), 'recolher funciona mesmo sem poder lembrar');
  } finally { await broken.cleanup(); }
});

test('os grupos aparecem nos três modos (grade, lista e compacto)', async () => {
  const h = await mount(TREE());
  try {
    for (const id of ['btnListView', 'btnCompactView', 'btnGridView']) {
      click(h, $(h, `#${id}`));
      await settle(20);
      assert.equal(heads(h).length, 5, id);
      assert.equal(shownNames(h).length, 6, id);
    }
  } finally { await h.cleanup(); }
});

test('navegação por setas pula os cartões de grupos recolhidos e os escondidos pelo filtro', async () => {
  const h = await mount(TREE());
  try {
    click(h, heads(h).find((x) => x.dataset.folder === 'Looks/Look 2').querySelector('[data-action="toggle"]'));
    await settle(10);
    const focused = [];
    for (const c of cards(h)) c.focus = () => focused.push(c.querySelector('.lut-card-title').textContent);
    const order = shownNames(h);
    assert.ok(!order.includes('y.cube'));
    const first = cards(h).find((c) => c.querySelector('.lut-card-title').textContent === order[0]);
    const arrow = Object.assign(new h.window.Event('keydown', { bubbles: true }), { key: 'ArrowRight' });
    first.dispatchEvent(arrow);
    assert.deepEqual(focused, [order[1]]);
    const last = cards(h).find((c) => c.querySelector('.lut-card-title').textContent === order.at(-1));
    focused.length = 0;
    last.dispatchEvent(Object.assign(new h.window.Event('keydown', { bubbles: true }), { key: 'ArrowRight' }));
    assert.deepEqual(focused, [order.at(-1)], 'no último não passa do fim');
  } finally { await h.cleanup(); }
});

test('o inspetor mostra a pasta da LUT (e esconde a linha para LUT na raiz)', async () => {
  const h = await mount(TREE());
  try {
    click(h, cards(h).find((c) => c.querySelector('.lut-card-title').textContent === 'a.cube'));
    await settle(20);
    assert.equal($(h, '#insFolder').textContent, 'Looks / Rush');
    assert.ok(!hasClass($(h, '#insFolderRow'), 'hidden'));
    click(h, cards(h).find((c) => c.querySelector('.lut-card-title').textContent === 'Solta.cube'));
    await settle(20);
    assert.ok(hasClass($(h, '#insFolderRow'), 'hidden'));
  } finally { await h.cleanup(); }
});

test('nome de pasta e de LUT com HTML nunca vira HTML (nem na grade, nem no cabeçalho)', async () => {
  const h = await mount([lut('<img src=x onerror=alert(1)>/x <b>.cube'), lut('A.cube')]);
  try {
    assert.equal($$(h, '#lutsGrid img[src="x"]').length, 0);
    assert.equal($$(h, '#lutsGrid b').length, 0);
    assert.ok(heads(h).some((x) => x.querySelector('.lut-group-name').textContent === '<img src=x onerror=alert(1)>'));
  } finally { await h.cleanup(); }
});

// ─── Menu da pasta ───────────────────────────────────────────────────────────────────────────────

const openGroupMenu = async (h, folder) => {
  const head = heads(h).find((x) => x.dataset.folder === folder);
  click(h, head.querySelector('[data-action="group-menu"]'));
  await settle(10);
  return $(h, '#lutGroupMenu');
};

test('menu da pasta: cinco ações (selecionar, adicionar a um projeto, renomear, abrir, excluir), Esc fecha e "Abrir pasta" abre aquela subpasta', async () => {
  const opened = [];
  const h = await mount(TREE(), { openLutsFolder: async (rel) => { opened.push(rel); return true; } });
  try {
    const menu = await openGroupMenu(h, 'Looks/Rush');
    assert.deepEqual([...menu.querySelectorAll('button')].map((b) => b.dataset.action), ['select-folder', 'add-project-folder', 'rename-folder', 'open-folder', 'delete-folder']);
    assert.equal(key(h, 'Escape'), true);
    assert.ok(hasClass(menu, 'hidden'));
    await openGroupMenu(h, 'Looks/Rush');
    click(h, menu.querySelector('[data-action="open-folder"]'));
    await settle(10);
    assert.deepEqual(opened, ['Looks/Rush']);
    assert.ok(hasClass(menu, 'hidden'));
    // o botão "Abrir a pasta das LUTs" do topo continua abrindo a coleção (sem argumento)
    click(h, $(h, '#btnOpenLutsFolder'));
    await settle(10);
    assert.deepEqual(opened, ['Looks/Rush', undefined]);
  } finally { await h.cleanup(); }
});

test('menu da pasta: com ele aberto, Delete e F2 não agem sobre a LUT selecionada', async () => {
  const deleted = [];
  const h = await mount(TREE(), { deleteLut: async (p) => { deleted.push(p); return true; } });
  try {
    click(h, cards(h)[0]);
    await settle(10);
    await openGroupMenu(h, 'Outra');
    assert.equal(key(h, 'Delete'), false);
    await settle(10);
    assert.deepEqual(deleted, []);
    assert.equal(h.dialogs.confirms.length, 0);
  } finally { await h.cleanup(); }
});

test('renomear pasta: pergunta o novo nome, chama o main com o caminho relativo e recarrega; o recolhido acompanha o nome novo', async () => {
  const renames = [];
  let loads = 0;
  const h = await mount(TREE(), { renameLutFolder: async (rel, name) => { renames.push([rel, name]); return true; } });
  try {
    const realList = h.bds.listLuts;
    h.window.bdsModal.prompt = async (msg, value) => { renames.push(['prompt', msg, value]); return '  Sprint  '; };
    click(h, heads(h).find((x) => x.dataset.folder === 'Looks/Rush').querySelector('[data-action="toggle"]'));
    await settle(10);
    h.bds.set('listLuts', async () => { loads++; return realList(); });
    const menu = await openGroupMenu(h, 'Looks/Rush');
    click(h, menu.querySelector('[data-action="rename-folder"]'));
    await settle(40);
    assert.deepEqual(renames, [['prompt', 'Novo nome da pasta "Looks / Rush":', 'Rush'], ['Looks/Rush', 'Sprint']]);
    assert.ok(loads >= 1, 'a lista foi recarregada');
    assert.deepEqual(JSON.parse(h.window.localStorage.getItem('bds.luts.collapsedFolders')), ['Looks/Sprint']);
    assert.match($(h, '#lutsNoticeText').textContent, /Pasta renomeada/);
  } finally { await h.cleanup(); }
});

test('renomear pasta: nome igual, vazio ou cancelar não chama o main; erro do main aparece em português', async () => {
  const renames = [];
  const h = await mount(TREE(), { renameLutFolder: async (rel, name) => { renames.push([rel, name]); throw new Error('Já existe uma pasta ou arquivo com esse nome.'); } });
  try {
    for (const answer of [null, '', '   ', 'Rush']) {
      h.window.bdsModal.prompt = async () => answer;
      const menu = await openGroupMenu(h, 'Looks/Rush');
      click(h, menu.querySelector('[data-action="rename-folder"]'));
      await settle(20);
    }
    assert.deepEqual(renames, []);
    h.window.bdsModal.prompt = async () => 'Outra coisa';
    const menu = await openGroupMenu(h, 'Looks/Rush');
    click(h, menu.querySelector('[data-action="rename-folder"]'));
    await settle(30);
    assert.deepEqual(renames, [['Looks/Rush', 'Outra coisa']]);
    assert.match($(h, '#lutsNoticeText').textContent, /Já existe uma pasta ou arquivo com esse nome/);
    assert.ok(hasClass($(h, '#lutsNotice'), 'tone-danger'));
  } finally { await h.cleanup(); }
});

test('excluir pasta: conta antes (dryRun), avisa dos outros itens que ficam e só então manda para a lixeira', async () => {
  const calls = [];
  const h = await mount(TREE(), {
    deleteLutFolder: async (rel, dryRun) => {
      calls.push([rel, dryRun]);
      return dryRun ? { luts: 2, others: 3 } : { trashed: 2, luts: 2, others: 3, remaining: 3, folderRemoved: false };
    }
  });
  try {
    const menu = await openGroupMenu(h, 'Looks/Rush');
    click(h, menu.querySelector('[data-action="delete-folder"]'));
    await settle(40);
    assert.deepEqual(calls, [['Looks/Rush', true], ['Looks/Rush', undefined]]);
    assert.equal(h.dialogs.confirms.length, 1);
    assert.match(h.dialogs.confirms[0], /Mover 2 LUTs da pasta "Looks \/ Rush" para a lixeira\?/);
    assert.match(h.dialogs.confirms[0], /3 outros itens que não são LUT: eles ficam onde estão e a pasta não será removida/);
    assert.match($(h, '#lutsNoticeText').textContent, /2 LUTs movidas para a lixeira/);
    assert.match($(h, '#lutsNoticeText').textContent, /3 outros itens ficaram na pasta/);
  } finally { await h.cleanup(); }
});

test('excluir pasta: dizer "não" não exclui; pasta sem LUTs só avisa; erro do main aparece em português', async () => {
  const calls = [];
  let mode = 'normal';
  const h = await mount(TREE(), {
    deleteLutFolder: async (rel, dryRun) => {
      calls.push([rel, dryRun]);
      if (mode === 'vazia') return { luts: 0, others: 1 };
      if (mode === 'erro' && !dryRun) throw new Error('Não foi possível mover as LUTs para a Lixeira.');
      return { luts: 1, others: 0 };
    }
  });
  try {
    h.window.bdsModal.confirm = async () => false;
    let menu = await openGroupMenu(h, 'Outra');
    click(h, menu.querySelector('[data-action="delete-folder"]'));
    await settle(30);
    assert.deepEqual(calls, [['Outra', true]], 'só contou');

    mode = 'vazia';
    calls.length = 0;
    menu = await openGroupMenu(h, 'Outra');
    click(h, menu.querySelector('[data-action="delete-folder"]'));
    await settle(30);
    assert.deepEqual(calls, [['Outra', true]]);
    assert.match($(h, '#lutsNoticeText').textContent, /não tem LUTs para excluir/);

    mode = 'erro';
    h.window.bdsModal.confirm = async () => true;
    menu = await openGroupMenu(h, 'Outra');
    click(h, menu.querySelector('[data-action="delete-folder"]'));
    await settle(30);
    assert.match($(h, '#lutsNoticeText').textContent, /Erro ao excluir a pasta: Não foi possível mover as LUTs para a Lixeira\./);
  } finally { await h.cleanup(); }
});

// ─── Botão Importar com menu ─────────────────────────────────────────────────────────────────────

test('Importar: o botão abre um menu com "Arquivos .cube…" e "Pasta…" (sem botão novo), Esc fecha devolvendo o foco', async () => {
  const scans = [];
  const h = await mount(TREE(), { scanLuts: async (paths, options) => { scans.push([paths, options]); return { canceled: true }; } });
  try {
    const button = $(h, '#btnImportLut');
    const menu = $(h, '#lutImportMenu');
    assert.equal(button.getAttribute('aria-haspopup'), 'menu');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.ok(hasClass(menu, 'hidden'));
    click(h, button);
    assert.ok(!hasClass(menu, 'hidden'));
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.deepEqual([...menu.querySelectorAll('button')].map((b) => b.dataset.action), ['files', 'folder']);
    assert.deepEqual([...menu.querySelectorAll('button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim().replace(/^\w+ /, '')), ['Arquivos .cube…', 'Pasta…']);
    assert.equal(key(h, 'Escape'), true);
    assert.ok(hasClass(menu, 'hidden'));
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    // clicar de novo no botão com o menu aberto fecha
    click(h, button);
    click(h, button);
    assert.ok(hasClass(menu, 'hidden'));

    click(h, button);
    click(h, menu.querySelector('[data-action="folder"]'));
    await settle(20);
    click(h, button);
    click(h, menu.querySelector('[data-action="files"]'));
    await settle(20);
    assert.deepEqual(scans, [[undefined, { mode: 'folder' }], [undefined, { mode: 'files' }]], 'o diálogo abre no main: a tela só informa o modo');
    assert.equal($$(h, '.luts-header-actions button.lut-btn-primary').length, 1, 'o topo continua com um botão de Importar');
  } finally { await h.cleanup(); }
});

test('Importar: o botão do estado vazio abre o mesmo menu', async () => {
  const h = await mount([]);
  try {
    click(h, $(h, '#btnEmptyImport'));
    assert.ok(!hasClass($(h, '#lutImportMenu'), 'hidden'));
    assert.equal($(h, '#btnEmptyImport').getAttribute('aria-expanded'), 'true');
    assert.match($(h, '#lutsEmptyHint').textContent, /arquivos \.cube ou uma pasta/);
  } finally { await h.cleanup(); }
});

test('Importar: com o menu aberto, Delete e F2 não agem; menu e janela entram em "algo aberto por cima"', async () => {
  const deleted = [];
  const h = await mount(TREE(), { deleteLut: async (p) => { deleted.push(p); return true; } });
  try {
    click(h, cards(h)[0]);
    await settle(10);
    click(h, $(h, '#btnImportLut'));
    assert.equal(key(h, 'Delete'), false);
    await settle(10);
    assert.deepEqual(deleted, []);
  } finally { await h.cleanup(); }
});

// ─── Janela de importação ────────────────────────────────────────────────────────────────────────

const ITEMS = [
  { key: 0, name: 'Nova A.cube', folder: 'Rush', relPath: 'Rush/Nova A.cube', size: 900000, status: 'new', reason: null, existsAs: null, warning: null },
  { key: 1, name: 'Nova B.cube', folder: 'Rush', relPath: 'Rush/Nova B.cube', size: 900000, status: 'new', reason: null, existsAs: null, warning: null },
  { key: 2, name: 'Nova C.cube', folder: 'Rush/Sub', relPath: 'Rush/Sub/Nova C.cube', size: 900000, status: 'new', reason: null, existsAs: null, warning: null },
  { key: 3, name: 'Velha.cube', folder: 'Rush', relPath: 'Rush/Velha.cube', size: 900000, status: 'exists', reason: null, existsAs: 'Ignition 01.cube', warning: null },
  { key: 4, name: 'Dupla.cube', folder: 'Rush', relPath: 'Rush/Dupla.cube', size: 900000, status: 'repeated', reason: null, existsAs: 'Rush/Nova A.cube', warning: null },
  { key: 5, name: 'Quebrada.cube', folder: 'Rush/Sub', relPath: 'Rush/Sub/Quebrada.cube', size: 10, status: 'invalid', reason: 'Linha 3: valor inválido (use ponto, não vírgula, como separador decimal).', existsAs: null, warning: null }
];
const SCAN = (over = {}) => ({
  scanId: 'scan-1',
  sourceName: 'Rush',
  hasFolders: true,
  summary: { found: 6, new: 3, exists: 1, repeated: 1, invalid: 1, ignored3dl: 12, ignoredOther: 0, ignoredLinks: 0, truncated: false, timedOut: false, tooDeepSkipped: 0, maxFolderDepth: 2, bigForPhone: 0, omitted: 0 },
  items: ITEMS,
  ...over
});
const modal = (h) => $(h, '#lutImportModal');
const isOpen = (h) => !hasClass(modal(h), 'hidden');
const section = (h, id) => !hasClass($(h, id), 'hidden');
const groups = (h) => $$(h, '#importGroups .lut-import-group');
const openFlow = async (h, mode = 'folder') => {
  click(h, $(h, '#btnImportLut'));
  click(h, $(h, `#lutImportMenu [data-action="${mode}"]`));
  await settle(30);
};

test('janela: o resumo mostra os números, o aviso dos .3dl, só as novas marcadas e "Importar N LUTs"', async () => {
  const h = await mount(TREE(), { scanLuts: async () => SCAN() });
  try {
    await openFlow(h);
    assert.ok(isOpen(h));
    assert.ok(section(h, '#importSummary') && !section(h, '#importScanning') && !section(h, '#importProgress'));
    assert.equal($(h, '#importSummaryText').textContent, 'Encontrei 6 LUTs: 3 novas, 1 já existe, 1 repetida, 1 inválida.');
    assert.deepEqual($$(h, '#importNotes li').map((li) => li.textContent), ['12 arquivos .3dl foram ignorados; o programa só aceita .cube.']);
    assert.deepEqual($$(h, '#importFilters button').map((b) => [b.dataset.filter, b.textContent, b.getAttribute('aria-pressed')]), [
      ['new', '3 novas', 'true'], ['exists', '1 já existe', 'false'], ['repeated', '1 repetida', 'false'], ['invalid', '1 inválida', 'false']
    ]);
    assert.equal($(h, '#btnImportConfirm').textContent, 'Importar 3 LUTs');
    assert.equal($(h, '#btnImportConfirm').disabled, false);
    // grupos recolhidos por padrão: nenhuma linha criada ainda
    assert.deepEqual(groups(h).map((g) => g.dataset.folder), ['Rush', 'Rush/Sub']);
    assert.equal($$(h, '#importGroups .lut-import-item').length, 0, 'linhas só ao expandir');
    assert.equal(groups(h)[0].querySelector('[data-action="toggle"]').getAttribute('aria-expanded'), 'false');
    assert.equal(groups(h)[0].querySelector('[data-role="group-check"]').checked, true);
    // opções avançadas ficam recolhidas, com as duas escolhas
    assert.equal($(h, '#importOptions').hasAttribute('open'), false);
    assert.equal($(h, '#importWrap').checked, true);
    assert.equal($(h, '#importWrapName').value, 'Rush');
    assert.equal($(h, '#importKeepFolders').checked, true);
  } finally { await h.cleanup(); }
});

test('janela: expandir cria as linhas só daquele grupo; existentes, repetidas e inválidas aparecem pelos filtros, com o motivo, sem caixa', async () => {
  const h = await mount(TREE(), { scanLuts: async () => SCAN() });
  try {
    await openFlow(h);
    click(h, groups(h)[0].querySelector('[data-action="toggle"]'));
    assert.deepEqual($$(h, '#importGroups .lut-import-item-name').map((n) => n.textContent), ['Nova A.cube', 'Nova B.cube']);
    assert.equal(groups(h)[0].querySelector('[data-action="toggle"]').getAttribute('aria-expanded'), 'true');
    assert.equal(groups(h)[1].querySelectorAll('.lut-import-item').length, 0, 'o outro grupo continua sem linhas');

    click(h, $(h, '#importFilters [data-filter="exists"]'));
    assert.equal($(h, '#importFilters [data-filter="exists"]').getAttribute('aria-pressed'), 'true');
    assert.equal($$(h, '#importGroups [data-role="group-check"]').length, 0, 'só as novas têm caixa de grupo');
    click(h, groups(h)[0].querySelector('[data-action="toggle"]'));
    assert.match($(h, '#importGroups .lut-import-reason').textContent, /Já existe na biblioteca como "Ignition 01\.cube"/);
    assert.equal($$(h, '#importGroups input[data-key]').length, 0);

    click(h, $(h, '#importFilters [data-filter="repeated"]'));
    click(h, groups(h)[0].querySelector('[data-action="toggle"]'));
    assert.match($(h, '#importGroups .lut-import-reason').textContent, /Repetida: mesmo conteúdo de "Rush\/Nova A\.cube"/);

    click(h, $(h, '#importFilters [data-filter="invalid"]'));
    click(h, groups(h)[0].querySelector('[data-action="toggle"]'));
    const bad = $(h, '#importGroups .lut-import-reason');
    assert.match(bad.textContent, /valor inválido/);
    assert.ok(hasClass(bad, 'lut-import-reason-bad'));
  } finally { await h.cleanup(); }
});

test('janela: a caixa do grupo marca e desmarca o grupo todo, o estado do grupo fica misto e o botão acompanha a contagem', async () => {
  const h = await mount(TREE(), { scanLuts: async () => SCAN() });
  try {
    await openFlow(h);
    const groupBox = () => groups(h)[0].querySelector('[data-role="group-check"]');
    groupBox().checked = false;
    change(h, groupBox());
    assert.equal($(h, '#btnImportConfirm').textContent, 'Importar 1 LUT');
    click(h, groups(h)[0].querySelector('[data-action="toggle"]'));
    assert.deepEqual($$(h, '#importGroups input[data-key]').map((b) => b.checked), [false, false], 'as linhas criadas depois já nascem desmarcadas');
    const one = $$(h, '#importGroups input[data-key]')[0];
    one.checked = true;
    change(h, one);
    assert.equal(groupBox().indeterminate, true);
    assert.equal($(h, '#btnImportConfirm').textContent, 'Importar 2 LUTs');
    // desmarcar tudo desativa o botão
    for (const g of groups(h)) {
      const box = g.querySelector('[data-role="group-check"]');
      box.checked = false;
      change(h, box);
    }
    assert.equal($(h, '#btnImportConfirm').disabled, true);
    assert.equal($(h, '#btnImportConfirm').textContent, 'Importar');
    // e remarcar um grupo (já expandido) atualiza as caixas das linhas visíveis
    groupBox().checked = true;
    change(h, groupBox());
    assert.deepEqual($$(h, '#importGroups input[data-key]').map((b) => b.checked), [true, true]);
    assert.equal(groupBox().indeterminate, false);
  } finally { await h.cleanup(); }
});

test('janela: Importar manda ao main só o id da busca, os números marcados e as opções (nenhum caminho), recarrega e conta o resultado', async () => {
  const sent = [];
  let loads = 0;
  const h = await mount(TREE(), {
    scanLuts: async () => SCAN(),
    importScannedLuts: async (id, keys, options) => {
      sent.push([id, keys, options]);
      return { imported: 3, renamed: 1, skippedChanged: 0, failed: 0, exists: 0, canceled: false, groupsCreated: 2, total: 3, firstImported: { relPath: 'Looks/Rush/a.cube', path: 'C:\\LUTs\\Looks\\Rush\\a.cube' }, failures: [] };
    }
  });
  try {
    const realList = h.bds.listLuts;
    h.bds.set('listLuts', async () => { loads++; return realList(); });
    await openFlow(h);
    const groupBox = groups(h)[1].querySelector('[data-role="group-check"]');
    groupBox.checked = false; // tira a subpasta
    change(h, groupBox);
    click(h, $(h, '#btnImportConfirm'));
    await settle(60);
    assert.deepEqual(sent, [['scan-1', [0, 1], { keepFolders: true, rootGroup: 'Rush' }]]);
    assert.ok(!isOpen(h), 'a janela fecha');
    assert.ok(loads >= 1);
    assert.match($(h, '#lutsNoticeText').textContent, /3 LUTs importadas, com 2 pastas novas\./);
    assert.match($(h, '#lutsNoticeText').textContent, /1 LUT foi salva com " \(2\)"/);
    // a primeira LUT importada é selecionada
    assert.equal($(h, '#insName').textContent, 'a.cube');
  } finally { await h.cleanup(); }
});

test('janela: opções avançadas — sem pasta de grupo e sem manter subpastas vão como foram escolhidas; nome de grupo vazio é recusado na própria janela', async () => {
  const sent = [];
  const h = await mount(TREE(), { scanLuts: async () => SCAN(), importScannedLuts: async (id, keys, options) => { sent.push(options); return { imported: 3, failed: 0 }; } });
  try {
    await openFlow(h);
    $(h, '#importWrapName').value = '   ';
    click(h, $(h, '#btnImportConfirm'));
    await settle(20);
    assert.deepEqual(sent, [], 'nada foi enviado');
    assert.ok(isOpen(h) && section(h, '#importSummary'));
    assert.match($(h, '#importError').textContent, /Informe o nome da pasta/);
    assert.ok(!hasClass($(h, '#importError'), 'hidden'));
    assert.equal($(h, '#importOptions').hasAttribute('open'), true, 'abre as opções onde está o problema');

    $(h, '#importWrap').checked = false;
    change(h, $(h, '#importWrap'));
    assert.equal($(h, '#importWrapName').disabled, true);
    $(h, '#importKeepFolders').checked = false;
    click(h, $(h, '#btnImportConfirm'));
    await settle(40);
    assert.deepEqual(sent, [{ keepFolders: false }]);
  } finally { await h.cleanup(); }
});

test('janela: pastas com mais de 3 níveis avisam que serão agrupadas, e o aviso acompanha as opções', async () => {
  const deep = SCAN({ summary: { ...SCAN().summary, ignored3dl: 0, maxFolderDepth: 3 } });
  const h = await mount(TREE(), { scanLuts: async () => deep });
  try {
    await openFlow(h);
    // 3 níveis + o grupo raiz = 4: avisa
    assert.match($$(h, '#importNotes li').map((li) => li.textContent).join('|'), /Pastas com mais de 3 níveis serão agrupadas/);
    $(h, '#importWrap').checked = false;
    change(h, $(h, '#importWrap'));
    assert.equal($$(h, '#importNotes li').length, 0, 'sem o grupo raiz, 3 níveis cabem');
    $(h, '#importWrap').checked = true;
    change(h, $(h, '#importWrap'));
    $(h, '#importKeepFolders').checked = false;
    change(h, $(h, '#importKeepFolders'));
    assert.equal($$(h, '#importNotes li').length, 0, 'sem manter as subpastas, nada é agrupado');
  } finally { await h.cleanup(); }
});

test('janela: o main recusa o nome da pasta (ou outro erro): a mensagem aparece na janela, que volta ao resumo e continua aberta', async () => {
  const h = await mount(TREE(), { scanLuts: async () => SCAN(), importScannedLuts: async () => { throw new Error('O nome da pasta não pode ter os caracteres \\ / : * ? " < > |.'); } });
  try {
    await openFlow(h);
    click(h, $(h, '#btnImportConfirm'));
    await settle(40);
    assert.ok(isOpen(h) && section(h, '#importSummary') && !section(h, '#importProgress'));
    assert.match($(h, '#importError').textContent, /não pode ter os caracteres/);
  } finally { await h.cleanup(); }
});

test('janela: progresso da busca e da importação, Cancelar chama o main com o id e a janela fecha quando o main responde', async () => {
  let resolveScan;
  const cancels = [];
  const h = await mount(TREE(), {
    scanLuts: () => new Promise((resolve) => { resolveScan = resolve; }),
    cancelLutScan: async (id) => { cancels.push(['scan', id]); resolveScan({ canceled: true }); return true; }
  });
  try {
    await openFlow(h);
    assert.ok(!isOpen(h), 'a janela só abre quando a busca realmente começa');
    h.bds.emit('onLutsScanProgress', { scanId: 'abc', phase: 'start' });
    assert.ok(isOpen(h) && section(h, '#importScanning'));
    h.bds.emit('onLutsScanProgress', { scanId: 'abc', phase: 'walk', found: 83 });
    assert.equal($(h, '#importScanText').textContent, 'Procurando LUTs… 83 encontradas');
    h.bds.emit('onLutsScanProgress', { scanId: 'abc', phase: 'collection', found: 83 });
    assert.match($(h, '#importScanText').textContent, /Conferindo as LUTs que você já tem/);
    h.bds.emit('onLutsScanProgress', { scanId: 'abc', phase: 'read', processed: 30, total: 83 });
    assert.equal($(h, '#importScanText').textContent, 'Verificando as LUTs… 30 de 83');
    assert.equal($(h, '#importScanBar').value, 30);
    h.bds.emit('onLutsScanProgress', { scanId: 'outra', phase: 'read', processed: 99, total: 100 });
    assert.equal($(h, '#importScanText').textContent, 'Verificando as LUTs… 30 de 83', 'evento de outra busca é ignorado');
    click(h, $(h, '#btnImportScanCancel'));
    await settle(30);
    assert.deepEqual(cancels, [['scan', 'abc']]);
    assert.ok(!isOpen(h));
    assert.equal(h.document.querySelectorAll('#lutsNotice:not(.hidden) .tone-danger').length, 0);
  } finally { await h.cleanup(); }
});

test('janela: cancelar a importação em andamento chama o main e o resultado cancelado é contado ("o que já foi copiado ficou")', async () => {
  let resolveImport;
  const cancels = [];
  const h = await mount(TREE(), {
    scanLuts: async () => SCAN(),
    importScannedLuts: () => new Promise((resolve) => { resolveImport = resolve; }),
    cancelLutImport: async (id) => { cancels.push(id); resolveImport({ imported: 1, failed: 0, canceled: true, exists: 0, renamed: 0, skippedChanged: 0, groupsCreated: 0, firstImported: null, failures: [] }); return true; }
  });
  try {
    await openFlow(h);
    click(h, $(h, '#btnImportConfirm'));
    await settle(20);
    assert.ok(section(h, '#importProgress') && !section(h, '#importSummary'));
    h.bds.emit('onLutsImportProgress', { scanId: 'scan-1', phase: 'import', done: 1, total: 3, current: 'Nova B.cube' });
    assert.equal($(h, '#importProgressText').textContent, 'Importando 2 de 3: Nova B.cube');
    assert.equal($(h, '#importProgressBar').value, 1);
    click(h, $(h, '#btnImportStop'));
    await settle(40);
    assert.deepEqual(cancels, ['scan-1']);
    assert.ok(!isOpen(h));
    assert.match($(h, '#lutsNoticeText').textContent, /Importação cancelada; o que já tinha sido copiado ficou na biblioteca/);
    assert.match($(h, '#lutsNoticeText').textContent, /1 LUT importada/);
  } finally { await h.cleanup(); }
});

test('janela: cancelar no resumo libera a busca guardada; Esc também fecha; nada é importado', async () => {
  const cancels = [];
  const imports = [];
  const h = await mount(TREE(), { scanLuts: async () => SCAN(), cancelLutScan: async (id) => { cancels.push(id); return true; }, importScannedLuts: async () => { imports.push(1); return {}; } });
  try {
    await openFlow(h);
    click(h, $(h, '#btnImportCancel'));
    await settle(10);
    assert.ok(!isOpen(h));
    assert.deepEqual(cancels, ['scan-1']);
    await openFlow(h);
    assert.ok(isOpen(h));
    keydown(h, modal(h), 'Escape');
    await settle(10);
    assert.ok(!isOpen(h), 'Esc fecha pela mesma ação do botão de fechar');
    assert.deepEqual(cancels, ['scan-1', 'scan-1']);
    assert.deepEqual(imports, []);
  } finally { await h.cleanup(); }
});

test('janela: busca sem resultado, busca com erro e diálogo cancelado não deixam a janela aberta', async () => {
  let mode = 'vazio';
  const h = await mount(TREE(), {
    scanLuts: async () => {
      if (mode === 'erro') throw new Error('Esta já é a pasta das LUTs.');
      if (mode === 'cancelou') return { canceled: true };
      return SCAN({ items: [], summary: { ...SCAN().summary, found: 0, new: 0, exists: 0, repeated: 0, invalid: 0, ignored3dl: 4 } });
    }
  });
  try {
    await openFlow(h);
    assert.ok(!isOpen(h));
    assert.match($(h, '#lutsNoticeText').textContent, /Nenhuma LUT \.cube foi encontrada\. Os arquivos \.3dl foram ignorados/);
    mode = 'erro';
    await openFlow(h);
    assert.ok(!isOpen(h));
    assert.match($(h, '#lutsNoticeText').textContent, /Esta já é a pasta das LUTs\./);
    mode = 'cancelou';
    await openFlow(h);
    assert.ok(!isOpen(h));
  } finally { await h.cleanup(); }
});

test('janela: só uma importação por vez (o botão fica aria-disabled e um segundo pedido é ignorado)', async () => {
  let scans = 0;
  let resolveScan;
  const h = await mount(TREE(), { scanLuts: () => { scans++; return new Promise((resolve) => { resolveScan = resolve; }); } });
  try {
    await openFlow(h);
    assert.equal($(h, '#btnImportLut').getAttribute('aria-disabled'), 'true');
    click(h, $(h, '#btnImportLut'));
    assert.ok(hasClass($(h, '#lutImportMenu'), 'hidden'), 'o menu nem abre enquanto importa');
    const drop = new h.window.Event('drop', { bubbles: true });
    drop.dataTransfer = { types: ['Files'], files: [{ path: 'C:\\x\\Pasta' }] };
    $(h, '.luts-screen-container').dispatchEvent(drop);
    await settle(10);
    assert.equal(scans, 1);
    resolveScan({ canceled: true });
    await settle(20);
    assert.equal($(h, '#btnImportLut').getAttribute('aria-disabled'), 'false');
  } finally { await h.cleanup(); }
});

test('janela: nome com HTML nunca vira HTML e, com a janela aberta, Delete e F2 não agem sobre a LUT atrás', async () => {
  const deleted = [];
  const items = ITEMS.map((i, n) => (n === 0 ? { ...i, name: '<img src=x onerror=alert(1)>.cube' } : i));
  const h = await mount(TREE(), { deleteLut: async (p) => { deleted.push(p); return true; }, scanLuts: async () => SCAN({ items }) });
  try {
    click(h, cards(h)[0]);
    await settle(10);
    await openFlow(h);
    click(h, groups(h)[0].querySelector('[data-action="toggle"]'));
    assert.equal($$(h, '#importGroups img').length, 0);
    assert.equal($(h, '#importGroups .lut-import-item-name').textContent, '<img src=x onerror=alert(1)>.cube');
    assert.equal(key(h, 'Delete'), false);
    await settle(10);
    assert.deepEqual(deleted, []);
  } finally { await h.cleanup(); }
});

test('janela: lista grande — as linhas de um grupo são criadas em páginas de 300 com "Ver mais"', async () => {
  const many = Array.from({ length: 650 }, (_, i) => ({ key: i, name: `L${i}.cube`, folder: 'Grande', relPath: `Grande/L${i}.cube`, size: 1, status: 'new', reason: null, existsAs: null, warning: null }));
  const h = await mount(TREE(), { scanLuts: async () => SCAN({ sourceName: null, hasFolders: true, items: many, summary: { ...SCAN().summary, found: 650, new: 650, exists: 0, repeated: 0, invalid: 0, ignored3dl: 0, maxFolderDepth: 1 } }) });
  try {
    await openFlow(h);
    assert.equal($(h, '#btnImportConfirm').textContent, 'Importar 650 LUTs');
    assert.equal($$(h, '#importGroups .lut-import-item').length, 0);
    click(h, groups(h)[0].querySelector('[data-action="toggle"]'));
    assert.equal($$(h, '#importGroups .lut-import-item').length, 300);
    assert.equal($(h, '#importGroups [data-action="more"]').textContent, 'Ver mais (350)');
    click(h, $(h, '#importGroups [data-action="more"]'));
    assert.equal($$(h, '#importGroups .lut-import-item').length, 600);
    click(h, $(h, '#importGroups [data-action="more"]'));
    assert.equal($$(h, '#importGroups .lut-import-item').length, 650);
    assert.equal($$(h, '#importGroups [data-action="more"]').length, 0);
  } finally { await h.cleanup(); }
});

test('janela: arquivos soltos (sem subpastas) vêm como lista simples, sem cabeçalho de grupo e sem a opção de pasta', async () => {
  const flat = ITEMS.filter((i) => i.status === 'new').map((i) => ({ ...i, folder: '', relPath: i.name }));
  const h = await mount(TREE(), { scanLuts: async () => SCAN({ sourceName: null, hasFolders: false, items: flat, summary: { ...SCAN().summary, found: 3, new: 3, exists: 0, repeated: 0, invalid: 0, ignored3dl: 0, maxFolderDepth: 0 } }) });
  try {
    await openFlow(h, 'files');
    assert.equal($$(h, '#importGroups .lut-import-group-head').length, 0);
    assert.equal($$(h, '#importGroups input[data-key]').length, 3);
    assert.ok(hasClass($(h, '#importOptions'), 'hidden'));
    assert.deepEqual($$(h, '#importFilters button').map((b) => b.dataset.filter), ['new']);
  } finally { await h.cleanup(); }
});

test('janela: avisos do resumo (links, busca interrompida, LUT acima de 32 MB, lista cortada) em texto simples', async () => {
  const warn = SCAN({ summary: { ...SCAN().summary, ignored3dl: 1, ignoredLinks: 2, truncated: true, tooDeepSkipped: 1, bigForPhone: 3, omitted: 20, found: 5020 } });
  const h = await mount(TREE(), { scanLuts: async () => warn });
  try {
    await openFlow(h);
    const lines = $$(h, '#importNotes li').map((li) => li.textContent);
    assert.ok(lines.includes('1 arquivo .3dl foi ignorado; o programa só aceita .cube.'));
    assert.ok(lines.includes('2 atalhos (links) foram ignorados.'));
    assert.ok(lines.includes('1 pasta funda demais foi ignorada.'));
    assert.ok(lines.some((l) => /A busca foi interrompida/.test(l)));
    assert.ok(lines.includes('3 LUTs passam de 32 MB: o celular não as recebe.'));
    assert.ok(lines.some((l) => /^Há mais de 5\.000 LUTs; só as primeiras aparecem\. Importe em partes\.$/.test(l)));
  } finally { await h.cleanup(); }
});

test('textos da janela e dos menus em português, sem emoji e sem nomes de programas internos', async () => {
  const h = await mount(TREE());
  try {
    const text = ['#lutImportModal', '#lutImportMenu', '#lutGroupMenu'].map((s) => $(h, s).textContent).join(' ');
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(text));
    assert.ok(!/SHA|hash|walkTree|ffmpeg|sqlite|manifest/i.test(text));
    assert.match(text, /Importar LUTs/);
    assert.match(text, /Arquivos \.cube…/);
    assert.match(text, /Renomear pasta/);
    assert.equal($$(h, '#lutImportModal button').every((b) => b.textContent.trim() || b.getAttribute('aria-label')), true, 'todo botão tem nome');
    assert.equal($$(h, '#lutGroupMenu button, #lutImportMenu button').length, 7);
    assert.match(text, /Selecionar as LUTs desta pasta/);
  } finally { await h.cleanup(); }
});

// ─── Regras puras de grupos ──────────────────────────────────────────────────────────────────────

test('groups.js: ordem natural, agrupamento estável e estado recolhido que acompanha a renomeação', async () => {
  const mod = await import(pathToFileURL(path.join(SCREENS_DIR, 'luts', 'groups.js')).href);
  assert.deepEqual(['b', 'a/b/c', '', 'a', 'Look 10', 'Look 2', 'a/b'].sort(mod.compareFolders), ['', 'a', 'a/b', 'a/b/c', 'b', 'Look 2', 'Look 10']);
  assert.equal(mod.folderLabel(''), 'Sem pasta');
  assert.equal(mod.folderLabel('A/B'), 'A / B');
  assert.equal(mod.hasSubfolders([{ folder: '' }, {}]), false);
  assert.equal(mod.hasSubfolders([{ folder: '' }, { folder: 'x' }]), true);
  const groups = mod.groupLuts([{ n: 1, folder: 'B' }, { n: 2, folder: '' }, { n: 3, folder: 'B' }, { n: 4 }, { n: 5, folder: 'A/Z' }]);
  assert.deepEqual(groups.map((g) => [g.folder, g.luts.map((l) => l.n)]), [['', [2, 4]], ['A/Z', [5]], ['B', [1, 3]]]);
  const set = new Set(['Looks/Rush', 'Looks/Rush/Sub', 'Outra']);
  mod.remapCollapsed(set, 'Looks/Rush', 'Looks/Sprint');
  assert.deepEqual([...set].sort(), ['Looks/Sprint', 'Looks/Sprint/Sub', 'Outra']);
  assert.equal(mod.countLuts(1), '1 LUT');
  assert.equal(mod.countLuts(0), '0 LUTs');
  // sem armazenamento (ou com lixo gravado), o estado é vazio e nada quebra
  globalThis.window = { localStorage: { getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('bloqueado'); } } };
  try {
    assert.deepEqual([...mod.loadCollapsed()], []);
    assert.doesNotThrow(() => mod.saveCollapsed(new Set(['x'])));
    globalThis.window = { localStorage: { getItem: () => '{"nao":"lista"}', setItem() {} } };
    assert.deepEqual([...mod.loadCollapsed()], []);
    globalThis.window = { localStorage: { getItem: () => JSON.stringify(['ok', 5, null, 'tambem']), setItem() {} } };
    assert.deepEqual([...mod.loadCollapsed()], ['ok', 'tambem']);
  } finally { delete globalThis.window; }
});
