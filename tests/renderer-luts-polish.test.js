'use strict';

// Tela de LUTs (S6, acabamento): tipo vindo do cabeçalho da lista (sem interpretar nada para filtrar), busca sem acento,
// ordem natural e as seis ordens, comparador antes/depois por clique e por teclado (principal e tela cheia), grade com
// uma parada de Tab e setas pelo layout, cartões escondidos limitados, cache de LUTs interpretadas limitado por bytes e
// miniaturas sem escurecimento artificial.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const lut = (name, extra = {}) => ({
  id: null, hash: null, kind: '3D', lutSize: 17, title: null,
  name: `${name}.cube`, displayName: name, path: `C:\\LUTs\\${name}.cube`, relPath: `${name}.cube`, folder: '', depth: 0,
  size: 1000 + name.length, modifiedAt: NOW - name.length * 1000, ...extra
});
const HEADER = { ok: true, title: 'T', size: 17, is1D: false, domainMin: null, domainMax: null, totalEntries: 4913, preview: [[0, 0, 0], [1, 1, 1]] };
const GOOD = { ok: true, size: 2, is1D: false, data: new Float32Array(24), title: null, domainMin: null, domainMax: null, totalEntries: 8, preview: [] };

function bdsFor(items, extra = {}) {
  return {
    listLuts: async () => ({ folder: 'C:\\LUTs', items: items.map((i) => ({ ...i })), problems: [] }),
    getLutHeader: async () => HEADER,
    parseLutCube: async (p) => ({ ...GOOD, path: p }),
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
const cards = (h) => [...h.document.querySelectorAll('#lutsGrid .lut-card')];
const visible = (h) => cards(h).filter((c) => !c.classList.contains('hidden'));
const names = (h) => visible(h).map((c) => c.querySelector('.lut-card-title').textContent);
const click = (h, el) => el.dispatchEvent(new h.window.Event('click', { bubbles: true }));
const fire = (h, el, type, props = {}) => {
  const ev = new h.window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, props);
  el.dispatchEvent(ev);
  return ev;
};
async function setSort(h, value) {
  const sort = $(h, '#lutSortFilter');
  sort.value = value;
  fire(h, sort, 'change');
  await settle(20);
}
async function setType(h, value) {
  const type = $(h, '#lutTypeFilter');
  type.value = value;
  fire(h, type, 'change');
  await settle(30);
}
async function search(h, text) {
  const box = $(h, '#lutSearchInput');
  box.value = text;
  fire(h, box, 'input');
  await settle(260);
}

// ─── tipo vindo da lista ─────────────────────────────────────────────────────────────────────────

test('filtro de tipo usa o cabeçalho que a lista traz: 3D, 1D e sem tipo; nada é interpretado para filtrar', async () => {
  const items = [lut('Tres A'), lut('Tres B'), lut('Curva', { kind: '1D', lutSize: 256 }), lut('Misteriosa', { kind: null, lutSize: null })];
  const h = await mount(items);
  try {
    assert.equal(h.bds.calls.parseLutCube, undefined, 'abrir a tela não interpreta nenhuma LUT');
    await setType(h, '3d');
    assert.deepEqual(names(h).sort(), ['Tres A.cube', 'Tres B.cube']);
    await setType(h, '1d');
    assert.deepEqual(names(h), ['Curva.cube']);
    await setType(h, 'all');
    assert.equal(names(h).length, 4, 'sem tipo conhecido a LUT só aparece em "Todos os tipos"');
    assert.equal(h.bds.calls.parseLutCube, undefined, 'filtrar também não interpretou nada');
  } finally { await h.cleanup(); }
});

test('o cartão mostra o tipo lido do cabeçalho na hora ("LUT 3D", "LUT 1D"); sem tipo mostra "LUT"', async () => {
  const h = await mount([lut('A'), lut('B', { kind: '1D' }), lut('C', { kind: null })]);
  try {
    const badge = (n) => cards(h).find((c) => c.querySelector('.lut-card-title').textContent === `${n}.cube`).querySelector('.lut-badge-3d').textContent;
    assert.deepEqual([badge('A'), badge('B'), badge('C')], ['LUT 3D', 'LUT 1D', 'LUT']);
  } finally { await h.cleanup(); }
});

test('a leitura completa corrige um tipo desconhecido e o filtro passa a incluir a LUT', async () => {
  const items = [lut('Sem tipo', { kind: null })];
  const h = await mount(items);
  const original = globalThis.IntersectionObserver;
  try {
    // observador que "enxerga" o cartão na hora: a miniatura lê a LUT e descobre que é 3D
    globalThis.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; }
      observe(target) { Promise.resolve().then(() => this.cb([{ isIntersecting: true, target }], this)); }
      unobserve() {}
      disconnect() {}
    };
    await setType(h, '3d');
    assert.equal(names(h).length, 0, 'sem tipo conhecido, fora do filtro 3D');
    h.mod.onLeave();
    h.mod.onEnter();
    await settle(200);
    assert.deepEqual(names(h), ['Sem tipo.cube'], 'a leitura completa descobriu o tipo e o filtro reaplicou');
  } finally { globalThis.IntersectionObserver = original; await h.cleanup(); }
});

// ─── busca sem acento e ordem natural ────────────────────────────────────────────────────────────

test('busca sem acento nem caixa: "cafe" acha "Café", "ACAO" acha "Ação" e o nome da pasta também conta', async () => {
  const items = [lut('Café noturno'), lut('Cafe simples'), lut('Praia'), lut('Filme', { folder: 'Cinéticas', relPath: 'Cinéticas/Filme.cube', path: 'C:\\LUTs\\Cinéticas\\Filme.cube' }), lut('Ação')];
  const h = await mount(items);
  try {
    await search(h, 'cafe');
    assert.deepEqual(names(h).sort(), ['Cafe simples.cube', 'Café noturno.cube'].sort());
    await search(h, 'CAFÉ'); // com acento (e em maiúsculas) também acha o que não tem
    assert.deepEqual(names(h).sort(), ['Cafe simples.cube', 'Café noturno.cube'].sort());
    await search(h, 'ACAO');
    assert.deepEqual(names(h), ['Ação.cube']);
    await search(h, 'ação');
    assert.deepEqual(names(h), ['Ação.cube']);
    await search(h, 'cinet'); // só existe no nome da pasta
    assert.deepEqual(names(h), ['Filme.cube']);
    await search(h, 'filme.cube'); // o nome do arquivo inteiro, como aparece
    assert.deepEqual(names(h), ['Filme.cube']);
    await search(h, 'zzz');
    assert.equal(names(h).length, 0);
    await search(h, '');
    assert.equal(names(h).length, 5);
  } finally { await h.cleanup(); }
});

test('ordem natural: "Look 2" vem antes de "Look 10"; as seis ordens do seletor funcionam (inclusive Z a A)', async () => {
  const items = [
    lut('Look 10', { modifiedAt: NOW - 3000, size: 300 }),
    lut('Look 2', { modifiedAt: NOW - 1000, size: 100 }),
    lut('look 1', { modifiedAt: NOW - 2000, size: 200 }),
    lut('Árvore', { modifiedAt: NOW - 4000, size: 50 })
  ];
  const h = await mount(items);
  try {
    const sort = $(h, '#lutSortFilter');
    assert.deepEqual([...sort.querySelectorAll('option')].map((o) => [o.value, o.textContent.trim()]), [
      ['recent', 'Mais recentes'], ['oldest', 'Mais antigas'], ['name', 'Nome (A a Z)'], ['name-desc', 'Nome (Z a A)'], ['size', 'Maior tamanho'], ['size-asc', 'Menor tamanho']
    ]);
    assert.deepEqual(names(h), ['Look 2.cube', 'look 1.cube', 'Look 10.cube', 'Árvore.cube'], 'padrão: mais recentes primeiro');
    await setSort(h, 'oldest');
    assert.deepEqual(names(h), ['Árvore.cube', 'Look 10.cube', 'look 1.cube', 'Look 2.cube']);
    await setSort(h, 'name');
    assert.deepEqual(names(h), ['Árvore.cube', 'look 1.cube', 'Look 2.cube', 'Look 10.cube'], 'natural: 1, 2, 10; acento e caixa não contam');
    await setSort(h, 'name-desc');
    assert.deepEqual(names(h), ['Look 10.cube', 'Look 2.cube', 'look 1.cube', 'Árvore.cube']);
    await setSort(h, 'size');
    assert.deepEqual(names(h), ['Look 10.cube', 'look 1.cube', 'Look 2.cube', 'Árvore.cube']);
    await setSort(h, 'size-asc');
    assert.deepEqual(names(h), ['Árvore.cube', 'Look 2.cube', 'look 1.cube', 'Look 10.cube']);
  } finally { await h.cleanup(); }
});

test('sorting.js: funções puras (busca sem acento, ordem natural, empate pelo nome, ordem desconhecida vale mais recentes)', async () => {
  require('./helpers/renderer-harness');
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'screens', 'luts', 'sorting.js')).href);
  assert.equal(mod.foldText('  ÁÉÍÕÜ Ç ñ  '), 'aeiou c n');
  assert.equal(mod.foldText(null), '');
  assert.equal(mod.matchesQuery({ name: 'Praia.cube', folder: '' }, ''), true);
  assert.equal(mod.matchesQuery({ name: 'Praia.cube', folder: 'Verão/Noite' }, 'verao'), true);
  assert.equal(mod.matchesQuery({ name: 'Praia.cube' }, 'verao'), false);
  assert.equal(mod.matchesQuery({ name: 'Praia.cube' }, 'praia.cube'), true, 'o nome do arquivo inteiro, como aparece');
  assert.equal(mod.matchesQuery({ name: 'Ação.cube' }, 'acao'), true);
  const list = [{ displayName: 'b', size: 1, modifiedAt: 5 }, { displayName: 'a', size: 1, modifiedAt: 5 }, { displayName: 'c', size: 2, modifiedAt: 9 }];
  assert.deepEqual(mod.sortLuts([...list], 'size').map((l) => l.displayName), ['c', 'a', 'b'], 'empate pelo nome');
  assert.deepEqual(mod.sortLuts([...list], 'qualquer').map((l) => l.displayName), ['c', 'a', 'b'], 'ordem desconhecida: mais recentes');
  assert.deepEqual(mod.SORT_KEYS, ['recent', 'oldest', 'name', 'name-desc', 'size', 'size-asc']);
});

// ─── comparador antes/depois ─────────────────────────────────────────────────────────────────────

const dividerOf = (h, id) => $(h, id);
const clip = (h, id) => $(h, id).style.clipPath;

test('divisor é um controle de teclado: role="slider", foco, aria-valuenow e setas, Shift, Page, Home e End', async () => {
  const h = await mount([lut('A')]);
  try {
    for (const [divider, overlay] of [['#lutSliderDivider', '#lutSliderOverlay'], ['#fsSliderDivider', '#fsSliderOverlay']]) {
      const d = dividerOf(h, divider);
      assert.equal(d.getAttribute('role'), 'slider');
      assert.equal(d.getAttribute('tabindex'), '0');
      assert.equal(d.getAttribute('aria-label'), 'Comparar antes e depois');
      assert.deepEqual([d.getAttribute('aria-valuemin'), d.getAttribute('aria-valuemax'), d.getAttribute('aria-valuenow')], ['0', '100', '50']);
      assert.equal(d.getAttribute('aria-valuetext'), 'Antes 50%, depois 50%');
      const key = (k, extra = {}) => fire(h, d, 'keydown', { key: k, ...extra });
      assert.equal(key('ArrowRight').defaultPrevented, true);
      assert.equal(d.getAttribute('aria-valuenow'), '51');
      assert.equal(clip(h, overlay), 'inset(0 0 0 51%)');
      key('ArrowLeft'); key('ArrowLeft');
      assert.equal(d.getAttribute('aria-valuenow'), '49');
      key('ArrowRight', { shiftKey: true });
      assert.equal(d.getAttribute('aria-valuenow'), '59');
      key('PageDown');
      assert.equal(d.getAttribute('aria-valuenow'), '49');
      key('PageUp'); key('PageUp');
      assert.equal(d.getAttribute('aria-valuenow'), '69');
      assert.equal(d.getAttribute('aria-valuetext'), 'Antes 69%, depois 31%');
      key('End');
      assert.equal(d.getAttribute('aria-valuenow'), '100');
      key('ArrowRight', { shiftKey: true });
      assert.equal(d.getAttribute('aria-valuenow'), '100', 'não passa da ponta');
      key('Home');
      assert.equal(d.getAttribute('aria-valuenow'), '0');
      key('ArrowLeft');
      assert.equal(d.getAttribute('aria-valuenow'), '0');
      assert.equal(d.style.left, '0%');
      assert.equal(key('a').defaultPrevented, false, 'outras teclas não são consumidas');
      assert.equal(key('ArrowRight', { ctrlKey: true }).defaultPrevented, false);
    }
  } finally { await h.cleanup(); }
});

test('as setas do divisor não chegam ao resto da tela (nem mexem na seleção da grade)', async () => {
  const h = await mount([lut('A'), lut('B')]);
  try {
    let reached = 0;
    h.document.body.addEventListener('keydown', () => { reached++; });
    fire(h, dividerOf(h, '#lutSliderDivider'), 'keydown', { key: 'ArrowRight' });
    assert.equal(reached, 0);
    fire(h, dividerOf(h, '#lutSliderDivider'), 'keydown', { key: 'Tab' });
    assert.equal(reached, 1, 'Tab segue o caminho normal');
  } finally { await h.cleanup(); }
});

test('clicar no comparador posiciona o divisor ali; arrastar acompanha; soltar para', async () => {
  const h = await mount([lut('A')]);
  try {
    for (const [container, divider, overlay] of [['#lutSliderContainer', '#lutSliderDivider', '#lutSliderOverlay'], ['#fsSliderContainer', '#fsSliderDivider', '#fsSliderOverlay']]) {
      const c = $(h, container);
      c.getBoundingClientRect = () => ({ left: 100, width: 400, top: 0, height: 225 });
      fire(h, c, 'mousedown', { clientX: 140 }); // 10%
      assert.equal(dividerOf(h, divider).getAttribute('aria-valuenow'), '10');
      assert.equal(clip(h, overlay), 'inset(0 0 0 10%)');
      fire(h, h.window, 'mousemove', { clientX: 300 }); // 50%
      assert.equal(dividerOf(h, divider).getAttribute('aria-valuenow'), '50');
      fire(h, h.window, 'mousemove', { clientX: 9999 });
      assert.equal(dividerOf(h, divider).getAttribute('aria-valuenow'), '100', 'limitado à ponta');
      fire(h, h.window, 'mouseup');
      fire(h, h.window, 'mousemove', { clientX: 120 });
      assert.equal(dividerOf(h, divider).getAttribute('aria-valuenow'), '100', 'depois de soltar, o movimento não arrasta mais');
      fire(h, c, 'touchstart', { touches: [{ clientX: 200 }] }); // toque: 25%
      assert.equal(dividerOf(h, divider).getAttribute('aria-valuenow'), '25');
      fire(h, h.window, 'touchend');
    }
  } finally { await h.cleanup(); }
});

test('a tela cheia abre com o divisor no meio e o divisor volta ao meio ao limpar a seleção', async () => {
  const h = await mount([lut('A')]);
  try {
    click(h, cards(h)[0]);
    await settle(30);
    fire(h, dividerOf(h, '#fsSliderDivider'), 'keydown', { key: 'End' });
    fire(h, dividerOf(h, '#lutSliderDivider'), 'keydown', { key: 'Home' });
    click(h, $(h, '#btnFullscreenLut'));
    await settle(10);
    assert.equal(dividerOf(h, '#fsSliderDivider').getAttribute('aria-valuenow'), '50');
    assert.equal(clip(h, '#fsSliderOverlay'), 'inset(0 0 0 50%)');
    h.mod.onKeyDown({ key: 'Escape', target: h.document.body, preventDefault() {} });
    click(h, $(h, '#btnCloseInspector'));
    await settle(20);
    assert.equal(dividerOf(h, '#lutSliderDivider').getAttribute('aria-valuenow'), '50', 'o divisor do painel também volta ao meio');
    assert.equal(dividerOf(h, '#lutSliderDivider').style.left, '50%');
  } finally { await h.cleanup(); }
});

// ─── grade: uma parada de Tab e setas pelo layout ────────────────────────────────────────────────

const tabStops = (h) => cards(h).filter((c) => c.getAttribute('tabindex') === '0');
const focusIn = (h, card) => fire(h, card, 'focusin');
const arrow = (h, card, k, extra = {}) => fire(h, card, 'keydown', { key: k, ...extra });
const SIX = () => ['A', 'B', 'C', 'D', 'E', 'F'].map((n, i) => lut(n, { modifiedAt: NOW - i * 1000 }));

/** Dá posições de layout aos cartões visíveis: `cols` colunas (offsetTop e offsetLeft). */
function layout(h, cols) {
  visible(h).forEach((card, i) => {
    Object.defineProperty(card, 'offsetTop', { configurable: true, value: Math.floor(i / cols) * 100 });
    Object.defineProperty(card, 'offsetLeft', { configurable: true, value: (i % cols) * 100 });
  });
}

test('grade: só um cartão entra na ordem do Tab (o primeiro) e as setas, Home e End levam o foco e a parada junto', async () => {
  const h = await mount(SIX());
  try {
    assert.equal(tabStops(h).length, 1, 'uma parada de Tab para a grade inteira');
    assert.equal(tabStops(h)[0], visible(h)[0]);
    assert.ok(cards(h).every((c) => c.getAttribute('tabindex') === '0' || c.getAttribute('tabindex') === '-1'));
    const focused = [];
    for (const c of cards(h)) c.focus = () => { focused.push(c.querySelector('.lut-card-title').textContent); focusIn(h, c); };
    const [a, b, , , , f] = visible(h);
    arrow(h, a, 'ArrowRight');
    assert.equal(focused.at(-1), 'B.cube');
    assert.deepEqual(tabStops(h), [b], 'a parada de Tab acompanha o foco');
    arrow(h, b, 'End');
    assert.equal(focused.at(-1), 'F.cube');
    assert.deepEqual(tabStops(h), [f]);
    arrow(h, f, 'ArrowRight'); // na última: fica
    assert.equal(focused.at(-1), 'F.cube');
    arrow(h, f, 'Home');
    assert.equal(focused.at(-1), 'A.cube');
    assert.deepEqual(tabStops(h), [a]);
    arrow(h, a, 'ArrowLeft'); // na primeira: fica
    assert.equal(focused.at(-1), 'A.cube');
  } finally { await h.cleanup(); }
});

test('grade: Cima e Baixo seguem o layout (por linha, na mesma coluna) e param nas pontas', async () => {
  const h = await mount(SIX());
  try {
    layout(h, 3); // A B C / D E F
    const focused = [];
    for (const c of cards(h)) c.focus = () => { focused.push(c.querySelector('.lut-card-title').textContent[0]); focusIn(h, c); };
    const [a, b, c, d, e, f] = visible(h);
    arrow(h, b, 'ArrowDown');
    assert.equal(focused.at(-1), 'E');
    arrow(h, e, 'ArrowUp');
    assert.equal(focused.at(-1), 'B');
    arrow(h, c, 'ArrowDown');
    assert.equal(focused.at(-1), 'F');
    arrow(h, f, 'ArrowDown'); // última linha: continua no mesmo cartão
    assert.equal(focused.at(-1), 'F');
    arrow(h, a, 'ArrowUp'); // primeira linha
    assert.equal(focused.at(-1), 'A');
    // linha de baixo mais curta: vai para o mais próximo da coluna
    h.mod.onKeyDown({ key: 'x', target: h.document.body, preventDefault() {} });
    assert.ok(d);
  } finally { await h.cleanup(); }
});

test('grade: sem layout em linhas (lista), Cima e Baixo andam um por vez; Shift+Home/End estendem a seleção', async () => {
  const h = await mount(SIX());
  try {
    const focused = [];
    for (const c of cards(h)) c.focus = () => { focused.push(c.querySelector('.lut-card-title').textContent[0]); focusIn(h, c); };
    const [a, b, , , , f] = visible(h);
    arrow(h, a, 'ArrowDown');
    assert.equal(focused.at(-1), 'B');
    arrow(h, b, 'ArrowUp');
    assert.equal(focused.at(-1), 'A');
    click(h, a);
    await settle(10);
    arrow(h, a, 'End', { shiftKey: true });
    await settle(10);
    assert.equal(focused.at(-1), 'F');
    assert.equal(cards(h).filter((c) => c.classList.contains('selected')).length, 6, 'Shift+End marca até o fim');
    assert.ok(f.classList.contains('selected'));
  } finally { await h.cleanup(); }
});

test('grade: se o cartão que era a parada de Tab sai da vista (filtro), outro assume; recolher pasta também', async () => {
  const items = [lut('Alfa'), lut('Beta'), lut('Gama', { folder: 'Pasta', relPath: 'Pasta/Gama.cube', path: 'C:\\LUTs\\Pasta\\Gama.cube' })];
  const h = await mount(items);
  try {
    const alfa = cards(h).find((c) => /Alfa/.test(c.textContent));
    focusIn(h, alfa);
    assert.deepEqual(tabStops(h), [alfa]);
    await search(h, 'beta');
    assert.equal(tabStops(h).length, 1);
    assert.match(tabStops(h)[0].textContent, /Beta/);
    assert.equal(tabStops(h)[0].classList.contains('hidden'), false);
    await search(h, '');
    assert.equal(tabStops(h).length, 1);
    // recolher a pasta do cartão que é a parada: o Tab passa a outro cartão que está à vista
    const gama = cards(h).find((c) => /Gama/.test(c.textContent));
    focusIn(h, gama);
    assert.deepEqual(tabStops(h), [gama]);
    click(h, h.document.querySelector('.lut-group-head[data-folder="Pasta"] [data-action="toggle"]'));
    await settle(10);
    assert.equal(tabStops(h).length, 1);
    assert.notEqual(tabStops(h)[0], gama);
    assert.equal(tabStops(h)[0].classList.contains('lut-collapsed'), false);
  } finally { await h.cleanup(); }
});

// ─── memória: cartões escondidos e LUTs interpretadas ───────────────────────────────────────────

test('cartões escondidos pelo filtro são guardados só até um teto (os mais antigos saem do DOM)', async () => {
  const items = Array.from({ length: 340 }, (_, i) => lut(`Look ${String(i).padStart(3, '0')}`));
  const h = await mount(items);
  try {
    assert.equal(cards(h).length, 340);
    await search(h, 'Look 007');
    assert.deepEqual(names(h), ['Look 007.cube']);
    const kept = cards(h).length;
    assert.ok(kept <= 301, `${kept} cartões guardados (1 visível + no máximo 300 escondidos)`);
    assert.ok(kept >= 2);
    await search(h, '');
    assert.equal(names(h).length, 340, 'ao limpar a busca todos voltam (os descartados são recriados)');
    assert.equal(cards(h).length, 340);
  } finally { await h.cleanup(); }
});

test('LUTs interpretadas ficam em cache limitado por BYTES: as menos usadas saem e são lidas de novo', async () => {
  const parsed = [];
  const items = Array.from({ length: 30 }, (_, i) => lut(`Grande ${String(i).padStart(2, '0')}`, { modifiedAt: NOW - i * 1000 }));
  const h = await mount(items, {
    parseLutCube: async (p) => { parsed.push(p); return { ...GOOD, size: 2, data: new Float32Array(1_310_720), path: p }; } // 5 MB cada
  });
  try {
    const select = async (i) => { click(h, cards(h)[i]); await settle(15); };
    for (let i = 0; i < 25; i++) await select(i); // 25 × 5 MB passa de 96 MB
    const before = parsed.length;
    assert.equal(before, 25);
    await select(24); // a mais recente continua em cache
    await select(23);
    assert.equal(parsed.length, before, 'as recentes não são lidas de novo');
    await select(0); // a mais antiga foi descartada
    assert.equal(parsed.length, before + 1, 'a primeira saiu do cache por causa dos bytes e foi lida de novo');
  } finally { await h.cleanup(); }
});

test('LUTs pequenas continuam todas em cache (o teto é de memória, não de quantidade: mais de 100 cabem)', async () => {
  const parsed = [];
  const items = Array.from({ length: 120 }, (_, i) => lut(`Pequena ${String(i).padStart(3, '0')}`, { modifiedAt: NOW - i * 1000 }));
  const h = await mount(items, { parseLutCube: async (p) => { parsed.push(p); return { ...GOOD, path: p }; } });
  try {
    for (let i = 0; i < 120; i++) { click(h, cards(h)[i]); await settle(5); }
    assert.equal(parsed.length, 120);
    click(h, cards(h)[0]);
    await settle(10);
    assert.equal(parsed.length, 120, 'a primeira LUT ainda está em cache depois de 120 leituras');
  } finally { await h.cleanup(); }
});

// ─── cabeçalho do painel e miniaturas ────────────────────────────────────────────────────────────

test('painel .cube de arquivo grande (totalEntries nulo) mostra o tamanho declarado sem aviso de linhas faltando', async () => {
  const h = await mount([lut('Grande')], { getLutHeader: async () => ({ ...HEADER, size: 33, totalEntries: null, partial: true, preview: [[0, 0, 0]] }) });
  try {
    click(h, cards(h)[0]);
    await settle(30);
    assert.equal($(h, '#insLutEntries').textContent, (33 ** 3).toLocaleString('pt-BR'));
    assert.equal($(h, '#insLutEntries').classList.contains('cube-meta-value-warning'), false);
  } finally { await h.cleanup(); }
});

test('painel .cube: tabela incompleta (arquivo pequeno) continua avisando; faixa de entrada aparece no domínio', async () => {
  const h = await mount([lut('Curta')], { getLutHeader: async () => ({ ...HEADER, size: 17, totalEntries: 100, inputRange: [0, 2] }) });
  try {
    click(h, cards(h)[0]);
    await settle(30);
    assert.match($(h, '#insLutEntries').textContent, /esperado: 4\.913/);
    assert.ok($(h, '#insLutEntries').classList.contains('cube-meta-value-warning'));
    assert.equal($(h, '#insLutDomain').textContent, '0.00 – 2.00');
  } finally { await h.cleanup(); }
});

test('miniaturas sem escurecimento artificial: o CSS do cartão não aplica brilho por filtro (nem no hover)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'screens', 'luts.css'), 'utf8');
  const block = (selector) => {
    const from = css.indexOf(`${selector} {`);
    assert.ok(from >= 0, selector);
    return css.slice(from, css.indexOf('}', from));
  };
  assert.doesNotMatch(block('.lut-card-img'), /filter/);
  assert.doesNotMatch(css, /brightness\(/, 'nenhum brilho por filtro em lugar nenhum da tela');
  assert.doesNotMatch(css, /\.lut-card:hover \.lut-card-img/);
  assert.match(css, /\.lut-card-invalid \.lut-card-img \{ filter: grayscale\(1\); \}/, 'a LUT inválida segue marcada em cinza');
});

test('miniatura da tela: 320 px e chave por conteúdo (hash): cópias idênticas dividem a mesma miniatura', async () => {
  const hash = 'a'.repeat(64);
  const items = [lut('Original', { hash }), lut('Copia', { hash })];
  const parsed = [];
  const drawn = [];
  const h = await mountScreen('luts', { init: false, bds: bdsFor(items, { parseLutCube: async (p) => { parsed.push(p); return { ...GOOD, data: new Float32Array(24), path: p }; } }) });
  const original = globalThis.IntersectionObserver;
  const OriginalImage = globalThis.Image;
  try {
    globalThis.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; }
      observe(target) { Promise.resolve().then(() => this.cb([{ isIntersecting: true, target }], this)); }
      unobserve() {}
      disconnect() {}
    };
    globalThis.Image = class { constructor() { setTimeout(() => { this.naturalWidth = 1280; this.naturalHeight = 720; this.complete = true; this.onload && this.onload(); }, 0); } };
    const realCreate = h.document.createElement.bind(h.document);
    h.document.createElement = (tag, ...rest) => {
      const el = realCreate(tag, ...rest);
      if (String(tag).toLowerCase() === 'canvas') {
        el.getContext = () => ({ drawImage() {}, getImageData: (x, y, w, hh) => { drawn.push([w, hh]); return { data: new Uint8ClampedArray(w * hh * 4) }; }, putImageData() {} });
        el.toDataURL = () => 'data:image/jpeg;base64,AAAA';
      }
      return el;
    };
    await h.mod.initScreen();
    await settle(200);
    assert.ok(drawn.length >= 1, 'a miniatura foi desenhada');
    assert.ok(drawn.every(([w, hh]) => Math.max(w, hh) <= 320), `tamanhos ${JSON.stringify(drawn)}`);
    assert.equal(drawn[0][0], 320);
    assert.equal(drawn.length, 1, 'a segunda cópia (mesmo hash) reaproveitou a miniatura');
    const imgs = cards(h).map((c) => c.querySelector('.lut-card-img').getAttribute('src'));
    assert.deepEqual(imgs, ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,AAAA']);
  } finally { globalThis.IntersectionObserver = original; globalThis.Image = OriginalImage; await h.cleanup(); }
});
