'use strict';

// Tela de LUTs (renderer/screens/luts.js) montada com o harness (linkedom + window.bds simulado).
// Parte 1 (caracterização): comportamento que não pode mudar com a base confiável: grade, seleção única, Delete/F2,
// menu do cartão, arrastar-e-soltar, busca, filtro e ordem.
// Parte 2 (S1): prévia/cartão honestos para LUT inválida, "Abrir pasta", teclas com modal aberto, textos, corrida de carga.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const lut = (name, extra = {}) => ({
  id: null, name, displayName: name.replace(/\.cube$/i, ''), path: `C:\\LUTs\\${name}`, relPath: name,
  size: 1000 + name.length, modifiedAt: NOW - name.length * 1000, ...extra
});
const HEADER = { ok: true, title: 'T', size: 17, is1D: false, domainMin: null, domainMax: null, totalEntries: 4913, preview: [[0, 0, 0], [1, 1, 1]] };

/** window.bds da tela com a lista informada. */
function bdsFor(items, extra = {}) {
  return {
    listLuts: async () => ({ folder: 'C:\\LUTs', items: items.map((i) => ({ ...i })), problems: [] }), // cópias novas a cada chamada, como no IPC
    getLutHeader: async () => HEADER,
    parseLutCube: async () => ({ ok: false, code: 'NO_SIZE', reason: 'Falta a linha de tamanho (LUT_3D_SIZE ou LUT_1D_SIZE).' }),
    getPathForFile: (f) => f.path,
    ...extra
  };
}

async function mount(items, extra = {}, mountOptions = {}) {
  const h = await mountScreen('luts', { bds: bdsFor(items, extra), ...mountOptions });
  await settle(30);
  return h;
}

const $ = (h, sel) => h.document.querySelector(sel);
const cards = (h) => [...h.document.querySelectorAll('#lutsGrid .lut-card')];
const visibleCards = (h) => cards(h).filter((c) => !c.classList.contains('hidden'));
const names = (h) => visibleCards(h).map((c) => c.querySelector('.lut-card-title').textContent);
const click = (h, el) => el.dispatchEvent(new h.window.Event('click', { bubbles: true }));
const key = (h, k, extra = {}) => { let prevented = false; h.mod.onKeyDown({ key: k, target: h.document.body, preventDefault() { prevented = true; }, ...extra }); return prevented; };

const THREE = () => [lut('Beta.cube'), lut('Alfa longa.cube'), lut('Gama.cube')];

// ─── Parte 1: caracterização ─────────────────────────────────────────────────────────────────────

test('grade: um cartão por LUT, total no rodapé e nada selecionado', async () => {
  const h = await mount(THREE());
  try {
    assert.equal(cards(h).length, 3);
    assert.equal($(h, '#ftTotal').textContent, '3 LUTs');
    assert.match($(h, '#ftSelected').textContent, /^0 LUTs?$/);
    assert.ok(cards(h).every((c) => c.getAttribute('aria-selected') === 'false' && c.getAttribute('role') === 'option'));
    assert.ok($(h, '#lutsEmptyState').classList.contains('hidden'));
  } finally { await h.cleanup(); }
});

test('biblioteca vazia: estado vazio convida a importar', async () => {
  const h = await mount([]);
  try {
    assert.equal(cards(h).length, 0);
    assert.ok(!$(h, '#lutsEmptyState').classList.contains('hidden'));
    assert.match($(h, '#lutsEmptyText').textContent, /vazia/);
    assert.ok(!$(h, '#btnEmptyImport').classList.contains('hidden'));
  } finally { await h.cleanup(); }
});

test('seleção única: clicar marca o cartão, mostra o nome no inspetor e troca a seleção', async () => {
  const h = await mount(THREE());
  try {
    const [first, second] = cards(h);
    click(h, first);
    await settle(10);
    assert.ok(first.classList.contains('selected'));
    assert.equal(first.getAttribute('aria-selected'), 'true');
    assert.equal($(h, '#ftSelected').textContent, '1 LUT');
    assert.equal($(h, '#insName').textContent, first.querySelector('.lut-card-title').textContent);
    click(h, second);
    await settle(10);
    assert.ok(!first.classList.contains('selected'));
    assert.ok(second.classList.contains('selected'));
    assert.equal(cards(h).filter((c) => c.classList.contains('selected')).length, 1);
  } finally { await h.cleanup(); }
});

test('Delete pede confirmação e exclui a LUT selecionada; F2 abre o pedido de novo nome', async () => {
  const deleted = [];
  const prompts = [];
  const h = await mount(THREE(), { deleteLut: async (p) => { deleted.push(p); return true; } });
  try {
    h.window.bdsModal.prompt = async (msg, value) => { prompts.push([msg, value]); return null; };
    click(h, cards(h)[0]);
    await settle(10);
    key(h, 'F2');
    await settle(10);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0][1], cards(h)[0].querySelector('.lut-card-title').textContent.replace(/\.cube$/i, ''));
    assert.equal(key(h, 'Delete'), true);
    await settle(30);
    assert.equal(h.dialogs.confirms.length, 1);
    assert.deepEqual(deleted, [`C:\\LUTs\\${cards(h)[0].querySelector('.lut-card-title').textContent}`]);
  } finally { await h.cleanup(); }
});

test('Delete e F2 sem LUT selecionada, com campo de texto em foco ou com Ctrl pressionado não fazem nada', async () => {
  const deleted = [];
  const h = await mount(THREE(), { deleteLut: async (p) => { deleted.push(p); return true; } });
  try {
    key(h, 'Delete');
    click(h, cards(h)[0]);
    await settle(10);
    key(h, 'Delete', { target: $(h, '#lutSearchInput') });
    key(h, 'Delete', { ctrlKey: true });
    await settle(30);
    assert.deepEqual(deleted, []);
    assert.equal(h.dialogs.confirms.length, 0);
  } finally { await h.cleanup(); }
});

test('menu do cartão: abre pelo botão, mostra as ações (com "Adicionar a um projeto…") e "Mostrar na pasta" revela o arquivo', async () => {
  const revealed = [];
  const h = await mount(THREE(), { revealLut: async (p) => { revealed.push(p); return true; } });
  try {
    const menu = $(h, '#lutCardMenu');
    assert.ok(menu.classList.contains('hidden'));
    click(h, cards(h)[0].querySelector('[data-action="menu"]'));
    await settle(10);
    assert.ok(!menu.classList.contains('hidden'));
    assert.deepEqual([...menu.querySelectorAll('button')].map((b) => b.dataset.action), ['add-project', 'rename', 'reveal', 'delete']);
    click(h, menu.querySelector('[data-action="reveal"]'));
    await settle(10);
    assert.ok(menu.classList.contains('hidden'));
    assert.equal(revealed.length, 1);
    assert.match(revealed[0], /^C:\\LUTs\\/);
  } finally { await h.cleanup(); }
});

test('arrastar e soltar: os caminhos soltos (arquivos ou pastas) vão para a busca de importação, nunca direto para a cópia', async () => {
  const scanned = [];
  const h = await mount(THREE(), { scanLuts: async (paths, options) => { scanned.push([paths, options]); return { canceled: true }; } });
  try {
    const root = $(h, '.luts-screen-container');
    const drop = new h.window.Event('drop', { bubbles: true });
    drop.dataTransfer = { types: ['Files'], files: [{ path: 'C:\\x\\a.cube' }, { path: 'C:\\x\\Pasta' }] };
    root.dispatchEvent(drop);
    await settle(20);
    assert.deepEqual(scanned, [[['C:\\x\\a.cube', 'C:\\x\\Pasta'], undefined]]);
    assert.equal(h.bds.calls.importLut, undefined, 'o canal antigo de importação direta não é usado pela tela');
  } finally { await h.cleanup(); }
});

test('busca por nome filtra os cartões e "Todos os tipos" volta a mostrar tudo', async () => {
  const h = await mount(THREE());
  try {
    const search = $(h, '#lutSearchInput');
    search.value = 'alfa';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await settle(260);
    assert.deepEqual(names(h), ['Alfa longa.cube']);
    assert.equal($(h, '#ftTotal').textContent, '1 LUT');
    search.value = '';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await settle(260);
    assert.equal(names(h).length, 3);
  } finally { await h.cleanup(); }
});

test('ordem: "Nome (A-Z)" ordena pelo nome; padrão é o mais recente primeiro; "Tamanho" é decrescente', async () => {
  const h = await mount([lut('B.cube', { modifiedAt: NOW - 10, size: 5 }), lut('A.cube', { modifiedAt: NOW - 20, size: 9 }), lut('C.cube', { modifiedAt: NOW - 30, size: 7 })]);
  try {
    assert.deepEqual(names(h), ['B.cube', 'A.cube', 'C.cube']);
    const sort = $(h, '#lutSortFilter');
    sort.value = 'name';
    sort.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle(20);
    assert.deepEqual(names(h), ['A.cube', 'B.cube', 'C.cube']);
    sort.value = 'size';
    sort.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle(20);
    assert.deepEqual(names(h), ['A.cube', 'C.cube', 'B.cube']);
  } finally { await h.cleanup(); }
});

// ─── Parte 2: base confiável (S1) ────────────────────────────────────────────────────────────────

const BAD_REASON = 'A tabela tem 5 linhas; o esperado para tamanho 2 é 8.';
const GOOD_PARSED = { ok: true, size: 2, is1D: false, data: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]], title: null, domainMin: null, domainMax: null, totalEntries: 8, preview: [] };

/** Parser simulado: o que se chama "ruim" é inválido; o resto é uma LUT 3D 2x2x2. */
const parseByName = async (p) => (/ruim/i.test(p) ? { ok: false, code: 'ROWS', reason: BAD_REASON } : { ...GOOD_PARSED, path: p });

test('LUT inválida: ao selecionar, some o antes/depois, aparece "LUT inválida: motivo" e a tela cheia fica desativada', async () => {
  const h = await mount([lut('Boa.cube'), lut('Ruim.cube')], { parseLutCube: parseByName });
  try {
    const bad = cards(h).find((c) => /Ruim/.test(c.textContent));
    click(h, bad);
    await settle(30);
    const box = $(h, '#insInvalid');
    assert.ok(!box.classList.contains('hidden'));
    assert.equal($(h, '#insInvalidText').textContent, `LUT inválida: ${BAD_REASON}`);
    assert.ok($(h, '#lutSliderContainer').classList.contains('lut-slider-invalid'), 'antes/depois escondido');
    assert.ok($(h, '#lutSliderCanvas').classList.contains('hidden'), 'o canvas não mostra a prévia da LUT anterior');
    assert.equal($(h, '#btnFullscreenLut').disabled, true);
    assert.equal($(h, '#insBadge').textContent, 'Inválida');
    // o cartão ganha a marca e o motivo
    assert.ok(bad.classList.contains('lut-card-invalid'));
    assert.equal(bad.querySelector('.lut-badge-3d').textContent, 'Inválida');
    assert.equal(bad.getAttribute('title'), `LUT inválida: ${BAD_REASON}`);
    // duplo clique não abre a tela cheia para uma LUT inválida
    bad.dispatchEvent(new h.window.Event('dblclick', { bubbles: true }));
    assert.ok($(h, '#lutFullscreenModal').classList.contains('hidden'));
  } finally { await h.cleanup(); }
});

test('LUT inválida: o aviso some ao selecionar uma LUT boa e a ruim continua marcada', async () => {
  const h = await mount([lut('Boa.cube'), lut('Ruim.cube')], { parseLutCube: parseByName });
  try {
    const good = cards(h).find((c) => /Boa/.test(c.textContent));
    const bad = cards(h).find((c) => /Ruim/.test(c.textContent));
    click(h, bad);
    await settle(30);
    click(h, good);
    await settle(30);
    assert.ok($(h, '#insInvalid').classList.contains('hidden'));
    assert.ok(!$(h, '#lutSliderContainer').classList.contains('lut-slider-invalid'));
    assert.equal($(h, '#btnFullscreenLut').disabled, false);
    assert.ok(bad.classList.contains('lut-card-invalid'));
    assert.ok(!good.classList.contains('lut-card-invalid'));
  } finally { await h.cleanup(); }
});

test('LUT inválida: a miniatura em segundo plano também marca o cartão (selo "Inválida") sem precisar selecionar', async () => {
  const h = await mountScreen('luts', { init: false, bds: bdsFor([lut('Boa.cube'), lut('Ruim.cube')], { parseLutCube: parseByName }) });
  const originalObserver = globalThis.IntersectionObserver;
  try {
    // observador que "enxerga" todos os cartões na hora
    globalThis.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; }
      observe(target) { Promise.resolve().then(() => this.cb([{ isIntersecting: true, target }], this)); } // assíncrono, como o real (o cartão já está na tela)
      unobserve() {}
      disconnect() {}
    };
    await h.mod.initScreen();
    await settle(60);
    const bad = cards(h).find((c) => /Ruim/.test(c.textContent));
    assert.ok(bad.classList.contains('lut-card-invalid'));
    assert.equal(bad.querySelector('.lut-badge-3d').textContent, 'Inválida');
    assert.ok(!bad.querySelector('.lut-card-img').classList.contains('lut-card-img-loading'), 'sem miniatura a gerar');
  } finally { globalThis.IntersectionObserver = originalObserver; await h.cleanup(); }
});

test('LUT inválida só aparece em "Todos os tipos" (não entra nos filtros 3D e 1D)', async () => {
  const h = await mount([lut('Boa.cube'), lut('Ruim.cube')], { parseLutCube: parseByName });
  try {
    click(h, cards(h).find((c) => /Ruim/.test(c.textContent)));
    await settle(30);
    const type = $(h, '#lutTypeFilter');
    type.value = '3d';
    type.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle(60);
    assert.ok(!names(h).includes('Ruim.cube'));
    type.value = 'all';
    type.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle(60);
    assert.ok(names(h).includes('Ruim.cube'));
  } finally { await h.cleanup(); }
});

test('cabeçalho ilegível: a seção ".cube" mostra o motivo no lugar dos metadados', async () => {
  const h = await mount([lut('Ruim.cube')], { parseLutCube: parseByName, getLutHeader: async () => ({ ok: false, code: 'BINARY', reason: 'O conteúdo não é texto; não parece uma LUT.' }) });
  try {
    click(h, cards(h)[0]);
    await settle(30);
    assert.equal($(h, '#insLutEntries').textContent, 'O conteúdo não é texto; não parece uma LUT.');
    assert.ok(!$(h, '#insCubeSection').classList.contains('hidden'));
  } finally { await h.cleanup(); }
});

test('"Abrir pasta" abre a pasta das LUTs mesmo com a biblioteca vazia (nunca fica desativado)', async () => {
  const h = await mount([]);
  try {
    const btn = $(h, '#btnOpenLutsFolder');
    assert.equal(btn.disabled || btn.hasAttribute('disabled'), false);
    click(h, btn);
    await settle(10);
    assert.equal((h.bds.calls.openLutsFolder || []).length, 1);
    assert.equal((h.bds.calls.revealLut || []).length, 0, 'não revela um arquivo no lugar de abrir a pasta');
  } finally { await h.cleanup(); }
});

test('"Abrir pasta" com LUTs também abre a pasta (não destaca a primeira LUT) e mostra o erro em português', async () => {
  const h = await mount(THREE(), { openLutsFolder: async () => { throw new Error('Não foi possível abrir a pasta das LUTs.'); } });
  try {
    click(h, $(h, '#btnOpenLutsFolder'));
    await settle(20);
    assert.equal((h.bds.calls.revealLut || []).length, 0);
    const notice = $(h, '#lutsNotice');
    assert.ok(!notice.classList.contains('hidden'));
    assert.match($(h, '#lutsNoticeText').textContent, /pasta das LUTs/);
    assert.match(notice.className, /tone-danger/);
  } finally { await h.cleanup(); }
});

for (const [label, open] of [
  ['a tela cheia', async (h) => { click(h, $(h, '#btnFullscreenLut')); await settle(10); assert.ok(!$(h, '#lutFullscreenModal').classList.contains('hidden')); }],
  ['o ".cube" completo', async (h) => { click(h, $(h, '#btnViewCubeRaw')); await settle(10); assert.ok(!$(h, '#lutCubeRawModal').classList.contains('hidden')); }],
  ['o menu do cartão', async (h) => { click(h, cards(h)[0].querySelector('[data-action="menu"]')); await settle(10); assert.ok(!$(h, '#lutCardMenu').classList.contains('hidden')); }],
  ['um diálogo do aplicativo', async (h) => { h.window.bdsModal.isOpen = () => true; }],
  ['um <dialog> aberto', async (h) => { const d = h.document.createElement('dialog'); d.setAttribute('open', ''); h.document.body.appendChild(d); }]
]) {
  test(`com ${label} aberto, Delete e F2 não agem sobre a LUT que está atrás`, async () => {
    const deleted = [];
    const prompts = [];
    const h = await mount(THREE(), { parseLutCube: parseByName, deleteLut: async (p) => { deleted.push(p); return true; } });
    try {
      h.window.bdsModal.prompt = async (...a) => { prompts.push(a); return null; };
      click(h, cards(h)[0]);
      await settle(20);
      await open(h);
      assert.equal(key(h, 'Delete'), false, 'Delete não deve ser consumido');
      assert.equal(key(h, 'F2'), false, 'F2 não deve ser consumido');
      await settle(20);
      assert.deepEqual(deleted, []);
      assert.equal(h.dialogs.confirms.length, 0);
      assert.equal(prompts.length, 0);
    } finally { await h.cleanup(); }
  });
}

test('Esc fecha primeiro o menu, depois a tela cheia (uma camada por vez)', async () => {
  const h = await mount(THREE(), { parseLutCube: parseByName });
  try {
    click(h, cards(h)[0]);
    await settle(20);
    click(h, $(h, '#btnFullscreenLut'));
    click(h, cards(h)[0].querySelector('[data-action="menu"]'));
    await settle(10);
    key(h, 'Escape');
    assert.ok($(h, '#lutCardMenu').classList.contains('hidden'));
    assert.ok(!$(h, '#lutFullscreenModal').classList.contains('hidden'));
    key(h, 'Escape');
    assert.ok($(h, '#lutFullscreenModal').classList.contains('hidden'));
  } finally { await h.cleanup(); }
});

test('modal do .cube completo: o título mostra o nome como está (sem escapar duas vezes)', async () => {
  const h = await mount([lut('A&B <1>.cube')], { parseLutCube: parseByName, getLutRaw: async () => ({ rawContent: 'LUT_3D_SIZE 2', truncated: false, totalBytes: 13 }) });
  try {
    click(h, cards(h)[0]);
    await settle(20);
    click(h, $(h, '#btnViewCubeRaw'));
    await settle(20);
    assert.equal($(h, '#cubeRawModalTitle').textContent, 'A&B <1>.cube');
  } finally { await h.cleanup(); }
});

test('arquivo grande no .cube completo: aviso sem emoji', async () => {
  const h = await mount([lut('Grande.cube')], { parseLutCube: parseByName, getLutRaw: async () => ({ rawContent: 'LUT_3D_SIZE 2', truncated: true, totalBytes: 5 * 1024 * 1024 }) });
  try {
    click(h, cards(h)[0]);
    await settle(20);
    click(h, $(h, '#btnViewCubeRaw'));
    await settle(20);
    const text = $(h, '.cube-raw-truncated-notice').textContent;
    assert.match(text, /^Arquivo grande \(5\.0 MB\)\./);
    assert.ok(!/[\u2600-\u27bf]|\ufe0f|\ud83c|\ud83d|\ud83e/.test(text), 'sem emoji');
  } finally { await h.cleanup(); }
});

test('textos: "uma LUT" no feminino e nada de "Verifique o console" nem emoji na tela', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'renderer', 'screens');
  const html = fs.readFileSync(path.join(dir, 'luts.html'), 'utf8');
  const js = fs.readFileSync(path.join(dir, 'luts.js'), 'utf8').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.match(html, />Selecione uma LUT</);
  assert.match(html, />Nome da LUT</);
  for (const [name, src] of [['luts.html', html], ['luts.js', js]]) {
    assert.ok(!/Verifique o console/i.test(src), `${name}: "Verifique o console"`);
    assert.ok(!/\b(um|do|este|nenhum) LUT\b/i.test(src), `${name}: "um LUT"`);
    assert.ok(!/[\u2600-\u27bf]|\ufe0f|\ud83c|\ud83d|\ud83e/.test(src), `${name}: emoji`);
  }
});

test('arquivos que a pasta tem e a lista não leu: aviso amarelo, sem esconder as outras LUTs', async () => {
  const h = await mountScreen('luts', {
    bds: bdsFor(THREE(), { listLuts: async () => ({ folder: 'C:\\LUTs', items: THREE(), problems: [{ name: 'quebrada.cube', reason: 'Não foi possível ler este arquivo.' }] }) })
  });
  try {
    await settle(30);
    assert.equal(cards(h).length, 3);
    const notice = $(h, '#lutsNotice');
    assert.ok(!notice.classList.contains('hidden'));
    assert.match(notice.className, /tone-warning/);
    assert.match($(h, '#lutsNoticeText').textContent, /quebrada\.cube/);
    assert.equal(notice.getAttribute('aria-live'), 'polite');
  } finally { await h.cleanup(); }
});

/** Promessa que o teste resolve na hora que quiser. */
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('corrida de cargas: uma carga silenciosa que ultrapassa a normal não deixa "Carregando..." para trás', async () => {
  const slow = deferred();
  let call = 0;
  const h = await mountScreen('luts', {
    bds: bdsFor([], {
      listLuts: () => {
        call++;
        if (call === 2) return slow.promise; // o "Atualizar" (carga normal) demora
        return Promise.resolve({ folder: 'C:\\LUTs', items: [], problems: [] });
      }
    })
  });
  try {
    await settle(30);
    assert.equal(call, 1);
    click(h, $(h, '#btnRefreshLuts')); // carga normal (chamada 2), fica pendente e mostra "Carregando..."
    await settle(10);
    assert.ok($(h, '.luts-loading'), 'a carga normal mostra o aviso de carregamento');
    h.mod.onEnter(); // carga silenciosa (chamada 3), termina antes
    await settle(30);
    assert.equal(call, 3);
    assert.equal($(h, '.luts-loading'), null, 'a carga silenciosa limpou o "Carregando..."');
    slow.resolve({ folder: 'C:\\LUTs', items: [lut('Tardia.cube')], problems: [] }); // a carga velha chega depois e é ignorada
    await settle(30);
    assert.equal($(h, '.luts-loading'), null);
    assert.equal(cards(h).length, 0, 'a resposta atrasada não sobrescreve a mais nova');
  } finally { await h.cleanup(); }
});

test('primeira carga que falhou: ao voltar para a tela tenta de novo (e mostra as LUTs)', async () => {
  let call = 0;
  const h = await mountScreen('luts', {
    bds: bdsFor(THREE(), {
      listLuts: () => {
        call++;
        return call === 1 ? Promise.reject(new Error('Falha simulada.')) : Promise.resolve({ folder: 'C:\\LUTs', items: THREE(), problems: [] });
      }
    })
  });
  try {
    await settle(30);
    assert.ok($(h, '.luts-error'), 'erro com "Tentar novamente"');
    assert.equal(cards(h).length, 0);
    h.mod.onEnter();
    await settle(30);
    assert.equal(call, 2);
    assert.equal(cards(h).length, 3);
    assert.equal($(h, '.luts-error'), null);
  } finally { await h.cleanup(); }
});

test('voltar para a tela durante a primeira carga não dispara uma segunda carga', async () => {
  const first = deferred();
  let call = 0;
  const h = await mountScreen('luts', { init: false, bds: bdsFor([], { listLuts: () => { call++; return first.promise; } }) });
  try {
    const init = h.mod.initScreen();
    await settle(20);
    h.mod.onEnter();
    await settle(10);
    assert.equal(call, 1);
    first.resolve({ folder: 'C:\\LUTs', items: THREE(), problems: [] });
    await init;
    await settle(20);
    assert.equal(cards(h).length, 3);
  } finally { await h.cleanup(); }
});

test('atualizar tenta de novo a LUT que tinha falhado na leitura', async () => {
  let parses = 0;
  const h = await mount([lut('Ruim.cube')], { parseLutCube: async (p) => { parses++; return parses === 1 ? { ok: false, reason: 'Falha passageira.' } : { ...GOOD_PARSED, path: p }; } });
  try {
    click(h, cards(h)[0]);
    await settle(30);
    assert.ok(cards(h)[0].classList.contains('lut-card-invalid'));
    click(h, cards(h)[0]); // selecionar de novo não repete a leitura que falhou (fica em cache)
    await settle(30);
    assert.equal(parses, 1);
    click(h, $(h, '#btnRefreshLuts'));
    await settle(40);
    click(h, cards(h)[0]);
    await settle(30);
    assert.equal(parses, 2);
    assert.ok(!cards(h)[0].classList.contains('lut-card-invalid'));
  } finally { await h.cleanup(); }
});

test('fechar o inspetor limpa o estado de LUT inválida (aviso, selo e antes/depois voltam ao normal)', async () => {
  const h = await mount([lut('Ruim.cube')], { parseLutCube: parseByName });
  try {
    click(h, cards(h)[0]);
    await settle(30);
    assert.ok(!$(h, '#insInvalid').classList.contains('hidden'));
    click(h, $(h, '#btnCloseInspector'));
    await settle(20);
    assert.ok($(h, '#insInvalid').classList.contains('hidden'));
    assert.equal($(h, '#insInvalidText').textContent, '');
    assert.ok(!$(h, '#insBadge').classList.contains('lut-badge-invalid'));
    assert.ok(!$(h, '#lutSliderContainer').classList.contains('lut-slider-invalid'));
    assert.equal($(h, '#insName').textContent, 'Selecione uma LUT');
  } finally { await h.cleanup(); }
});
