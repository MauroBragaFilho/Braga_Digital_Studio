'use strict';

// Janela virtual da Biblioteca (RK-092): lógica pura (renderer/utils/virtualWindow.js) e a tela montada no
// harness linkedom com 5.000 itens simulados (poucas centenas de nós, rolagem, seleção, importação incremental).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mountScreen, settle } = require('./helpers/renderer-harness');

let vw;
test.before(async () => {
  vw = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'utils', 'virtualWindow.js')).href);
});

// ---------------------------------------------------------------------------------------------
// Lógica pura
// ---------------------------------------------------------------------------------------------

test('computeColumns: colunas pela largura (minmax 220 + gap 16) e mínimo de 1', () => {
  assert.equal(vw.computeColumns(0), 1);
  assert.equal(vw.computeColumns(NaN), 1);
  assert.equal(vw.computeColumns(220), 1);
  assert.equal(vw.computeColumns(455), 1);
  assert.equal(vw.computeColumns(456), 2);
  assert.equal(vw.computeColumns(1000), 4);
  assert.equal(vw.computeColumns(1400), 6);
});

test('groupConsecutive + buildRows: cabeçalhos e linhas de cols itens', () => {
  const items = ['a', 'a', 'a', 'b', 'b', 'c'];
  const groups = vw.groupConsecutive(items, (x) => ({ key: x }));
  assert.deepEqual(groups.map((g) => [g.key, g.start, g.count]), [['a', 0, 3], ['b', 3, 2], ['c', 5, 1]]);
  const { rows, rowOfItem } = vw.buildRows(groups, 2, items.length);
  assert.deepEqual(rows.map((r) => r.kind + ':' + r.start + '+' + r.count), [
    'header:0+3', 'items:0+2', 'items:2+1', 'header:3+2', 'items:3+2', 'header:5+1', 'items:5+1'
  ]);
  assert.deepEqual(Array.from(rowOfItem), [1, 1, 2, 4, 4, 6]);
  // lista: 1 item por linha
  const list = vw.buildRows(groups, 1, items.length);
  assert.equal(list.rows.filter((r) => r.kind === 'items').length, 6);
});

test('rowTops/rowAt/visibleRange: alturas previsíveis e intervalo com overscan', () => {
  const groups = [{ key: 'g', start: 0, count: 100 }];
  const { rows } = vw.buildRows(groups, 1, 100);
  const tops = vw.rowTops(rows, 50, 10); // cabeçalho 50 + 100 linhas de 10
  assert.equal(tops[rows.length], 50 + 1000);
  assert.equal(vw.rowAt(tops, 0), 0);
  assert.equal(vw.rowAt(tops, 49), 0);
  assert.equal(vw.rowAt(tops, 50), 1);
  assert.equal(vw.rowAt(tops, 59), 1);
  assert.equal(vw.rowAt(tops, 60), 2);
  assert.equal(vw.rowAt(tops, 99999), rows.length - 1);
  const r = vw.visibleRange(tops, 500, 100, 0);
  assert.equal(r.first, vw.rowAt(tops, 500));
  assert.equal(r.last, vw.rowAt(tops, 600));
  const ro = vw.visibleRange(tops, 500, 100, 200);
  assert.equal(ro.first, vw.rowAt(tops, 300));
  assert.equal(ro.last, vw.rowAt(tops, 800));
  // início da lista: não fica negativo
  assert.equal(vw.visibleRange(tops, 0, 100, 500).first, 0);
  assert.deepEqual(vw.visibleRange(new Float64Array(1), 0, 100, 0), { first: 0, last: -1 });
});

test('itemPosition + scrollToReveal + scrollTopForAnchor', () => {
  const groups = [{ key: 'g', start: 0, count: 10 }];
  const { rows, rowOfItem } = vw.buildRows(groups, 3, 10);
  const tops = vw.rowTops(rows, 40, 100); // header 40, linhas de 100: itens 0-2 em 40, 3-5 em 140...
  assert.deepEqual(vw.itemPosition(0, rowOfItem, tops), { row: 1, top: 40, height: 100 });
  assert.deepEqual(vw.itemPosition(4, rowOfItem, tops), { row: 2, top: 140, height: 100 });
  assert.equal(vw.itemPosition(10, rowOfItem, tops), null);
  assert.equal(vw.scrollToReveal(140, 100, 0, 300), null);        // já visível
  assert.equal(vw.scrollToReveal(340, 100, 0, 300), 140);         // abaixo: alinha o fim com o fim da janela
  assert.equal(vw.scrollToReveal(40, 100, 200, 300), 40);         // acima: alinha o topo
  assert.equal(vw.scrollToReveal(40, 100, 200, 300, 8), 32);
  assert.equal(vw.scrollTopForAnchor({ index: 4, offset: 20 }, rowOfItem, tops), 120);
  assert.equal(vw.scrollTopForAnchor({ index: 99, offset: 0 }, rowOfItem, tops), null);
});

test('navigateIndex: setas na grade (pula cabeçalhos, última linha parcial) e na lista', () => {
  const groups = [{ key: 'a', start: 0, count: 5 }, { key: 'b', start: 5, count: 2 }];
  const { rows, rowOfItem } = vw.buildRows(groups, 3, 7); // a: [0 1 2][3 4]  b: [5 6]
  const nav = (k, i) => vw.navigateIndex(k, i, rows, rowOfItem, 7);
  assert.equal(nav('ArrowRight', 2), 3);
  assert.equal(nav('ArrowLeft', 0), -1);
  assert.equal(nav('ArrowDown', 1), 4);
  assert.equal(nav('ArrowDown', 2), 4);  // coluna 2 não existe na linha parcial: limita ao último
  assert.equal(nav('ArrowDown', 4), 6);  // atravessa o cabeçalho do grupo seguinte
  assert.equal(nav('ArrowDown', 6), -1);
  assert.equal(nav('ArrowUp', 5), 3);    // volta ao grupo anterior (coluna 0)
  assert.equal(nav('ArrowUp', 0), -1);
  assert.equal(nav('Home', 4), 0);
  assert.equal(nav('End', 0), 6);
  const list = vw.buildRows(groups, 1, 7);
  assert.equal(vw.navigateIndex('ArrowDown', 4, list.rows, list.rowOfItem, 7), 5);
});

test('rangeBetween: intervalo em qualquer direção', () => {
  assert.deepEqual(vw.rangeBetween([10, 20, 30, 40], 20, 40), [1, 3]);
  assert.deepEqual(vw.rangeBetween([10, 20, 30, 40], 40, 20), [1, 3]);
  assert.equal(vw.rangeBetween([10, 20], 10, 99), null);
});

test('diffById: inserções, remoções e reordenação preservando a ordem', () => {
  const o = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.equal(vw.diffById(o, [{ id: 1 }, { id: 2 }, { id: 3 }]).unchanged, true);
  const ins = vw.diffById(o, [{ id: 9 }, { id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(ins.inserted, [{ index: 0, id: 9 }]);
  assert.deepEqual(ins.removed, []);
  assert.equal(ins.reordered, false);
  const rem = vw.diffById(o, [{ id: 1 }, { id: 3 }]);
  assert.deepEqual(rem.removed, [2]);
  assert.equal(rem.reordered, false);
  assert.equal(vw.diffById(o, [{ id: 3 }, { id: 2 }, { id: 1 }]).reordered, true);
});

test('reconcileWindow: o que criar e o que remover', () => {
  const ids = [10, 11, 12, 13, 14];
  const { create, remove } = vw.reconcileWindow([2, 3, 4], new Set([11, 12]), (i) => ids[i]);
  assert.deepEqual(create, [3, 4]);
  assert.deepEqual(remove, [11]);
});

// ---------------------------------------------------------------------------------------------
// Tela montada no harness (5.000 itens)
// ---------------------------------------------------------------------------------------------

const BASE = Date.UTC(2026, 5, 1, 12, 0, 0);
function makeItems(n, startId = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 3;
    const id = startId + i;
    out.push({
      id, uuid: 'u' + id, filename: kind === 2 ? `foto_${id}.jpg` : (kind === 1 ? `som_${id}.mp3` : `clip_${id}.mp4`),
      filepath: `C:/media/${id}.x`, thumbnail: `t${id}.jpg`, filesize: 1000 + id, duration: 10 + (i % 50), width: 1920, height: 1080,
      fps: 30, video_codec: 'h264', origin: 'LOCAL', favorite: 0,
      recorded_at: new Date(BASE - Math.floor(i / 7) * 86400000).toISOString().replace('T', ' ').slice(0, 19),
      imported_at: new Date(BASE).toISOString().replace('T', ' ').slice(0, 19)
    });
  }
  return out;
}

// linkedom não tem MouseEvent/KeyboardEvent: Event comum com as propriedades usadas pela tela
function evt(h, type, props = {}) {
  const e = new h.window.Event(type, { bubbles: true, cancelable: true });
  return Object.assign(e, props);
}

const VIEW_W = 1000; // colunas = 4
const VIEW_H = 800;

async function mountLibrary(total = 5000, extra = {}) {
  const all = makeItems(total);
  const state = { all };
  const h = await mountScreen('library', {
    init: false,
    bds: {
      searchLibrary: async (o) => {
        const off = o.offset || 0;
        const items = state.all.slice(off, off + (o.limit || 300));
        return { items, totalCount: state.all.length };
      },
      getLibraryFilterOptions: async () => ({ types: { video: 1, audio: 1, photo: 1 }, origins: [], albums: [] }),
      ...extra
    }
  });
  const area = h.document.getElementById('libContentArea');
  // linkedom não mede layout: simula a área de rolagem
  Object.defineProperty(area, 'clientWidth', { configurable: true, value: VIEW_W + 48 });
  Object.defineProperty(area, 'clientHeight', { configurable: true, value: VIEW_H });
  area.scrollTop = 0;
  // linkedom não implementa foco: registra o último elemento focado e o expõe como document.activeElement
  let focused = null;
  h.window.Element.prototype.focus = function focus() { focused = this; };
  Object.defineProperty(h.document, 'activeElement', { configurable: true, get: () => focused });
  await h.mod.initScreen();
  await settle(60);
  const scrollTo = async (y) => {
    area.scrollTop = y;
    area.dispatchEvent(new h.window.Event('scroll'));
    await settle(30);
  };
  const cards = () => Array.from(area.querySelectorAll('.media-clickable'));
  const ids = () => cards().map((c) => Number(c.getAttribute('data-id')));
  return { h, area, state, scrollTo, cards, ids };
}

test('5.000 itens: DOM com poucas centenas de nós e só os cards da janela', async () => {
  const { h, area, cards } = await mountLibrary();
  try {
    const total = h.document.querySelectorAll('*').length;
    assert.ok(total < 700, `DOM total: ${total}`);
    const n = cards().length;
    assert.ok(n > 0 && n < 120, `cards no DOM: ${n}`);
    assert.ok(area.querySelector('.lib-vspacer').style.height.endsWith('px'));
    assert.equal(h.errors.length, 0);
    // carregou só a 1ª página (300), o restante vem por rolagem
    assert.equal(h.bds.calls.searchLibrary.length >= 1, true);
    assert.equal(h.bds.calls.searchLibrary[0][0].limit, 300);
  } finally { await h.cleanup(); }
});

test('rolar muda a janela, mantém o DOM pequeno e carrega a próxima página perto do fim', async () => {
  const { h, area, scrollTo, ids } = await mountLibrary();
  try {
    const before = ids();
    await scrollTo(6000);
    const after = ids();
    assert.ok(after.length > 0 && after.length < 120);
    assert.notDeepEqual(after.slice(0, 3), before.slice(0, 3));
    assert.ok(!after.includes(before[0]), 'o 1º card saiu do DOM');
    assert.ok(h.document.querySelectorAll('*').length < 700);
    // fim das 300 carregadas: 300 itens / 4 colunas = 75 linhas * 226 + cabeçalhos ~ 18 mil px
    const tall = parseInt(area.querySelector('.lib-vspacer').style.height, 10);
    await scrollTo(tall - VIEW_H);
    await settle(40);
    const offsets = h.bds.calls.searchLibrary.map((c) => c[0].offset);
    assert.ok(offsets.includes(300), `offsets pedidos: ${offsets}`);
    const tall2 = parseInt(area.querySelector('.lib-vspacer').style.height, 10);
    assert.ok(tall2 > tall, 'a altura total cresceu com a nova página');
  } finally { await h.cleanup(); }
});

test('seleção persiste ao rolar para longe e voltar; ctrl+clique, intervalo com shift e Ctrl+A', async () => {
  const { h, area, scrollTo, cards } = await mountLibrary();
  try {
    const ctrlClick = (el, extra = {}) => el.dispatchEvent(evt(h, 'click', { ctrlKey: true, ...extra }));
    const byId = (id) => area.querySelector(`.media-clickable[data-id="${id}"]`);
    ctrlClick(byId(2));
    assert.ok(byId(2).classList.contains('selected'));
    await scrollTo(8000);
    assert.equal(byId(2), null, 'saiu do DOM');
    await scrollTo(0);
    assert.ok(byId(2).classList.contains('selected'), 'selecionado ao voltar');
    assert.equal(byId(2).getAttribute('aria-pressed'), 'true');
    assert.equal(h.document.getElementById('libSelectedCount').textContent, '1 selecionado');
    // shift: de 2 até 6 (5 itens)
    byId(6).dispatchEvent(evt(h, 'click', { shiftKey: true }));
    assert.equal(h.document.getElementById('libSelectedCount').textContent, '5 selecionados');
    assert.ok(byId(4).classList.contains('selected'));
    // Ctrl+A: tudo o que está carregado (300)
    h.mod.onKeyDown({ key: 'a', ctrlKey: true, preventDefault() {} });
    assert.equal(h.document.getElementById('libSelectedCount').textContent, '300 selecionados');
    assert.ok(cards().every((c) => c.classList.contains('selected')));
  } finally { await h.cleanup(); }
});

test('miniaturas só são atribuídas depois da rolagem assentar e só dos cards na janela', async () => {
  const { h, area, scrollTo } = await mountLibrary();
  try {
    await settle(120);
    const imgs = Array.from(area.querySelectorAll('img.lib-card-img'));
    assert.ok(imgs.length > 0);
    assert.ok(imgs.every((i) => i.getAttribute('src') && !i.hasAttribute('data-src')), 'miniaturas carregadas após assentar');
    const first = imgs[0];
    await scrollTo(9000);
    // card que saiu: a carga é cancelada (src removido) e ele não está mais no DOM
    assert.equal(first.getAttribute('src'), null);
    assert.ok(!area.contains(first));
    // recém-criados ainda sem src (debounce): rolar de novo antes do prazo não dispara carga dos que saem
    const fresh = Array.from(area.querySelectorAll('img.lib-card-img'));
    assert.ok(fresh.length > 0);
    await settle(120);
    assert.ok(Array.from(area.querySelectorAll('img.lib-card-img')).every((i) => i.getAttribute('src')));
  } finally { await h.cleanup(); }
});

test('importação pelo watcher: incremental, sem recriar cards, sem reiniciar a rolagem, seleção preservada', async () => {
  const { h, area, state, cards } = await mountLibrary();
  try {
    const ctrlClick = (el) => el.dispatchEvent(evt(h, 'click', { ctrlKey: true }));
    ctrlClick(area.querySelector('.media-clickable[data-id="3"]'));
    const beforeEls = new Map(cards().map((c) => [c.getAttribute('data-id'), c]));
    const fetchesBefore = h.bds.calls.searchLibrary.length;

    // item novo e mais recente que todos
    const novo = { ...makeItems(1, 90001)[0], recorded_at: new Date(BASE + 86400000).toISOString().replace('T', ' ').slice(0, 19) };
    state.all = [novo, ...state.all];
    h.bds.emit('onMediaImported', { id: 90001 });
    await settle(250);

    assert.ok(h.bds.calls.searchLibrary.length > fetchesBefore, 'recarregou a lista');
    assert.equal(area.scrollTop, 0, 'rolagem não reiniciada');
    const novoEl = area.querySelector('.media-clickable[data-id="90001"]');
    assert.ok(novoEl, 'o item novo apareceu');
    // os demais cards visíveis são os MESMOS elementos
    let same = 0;
    for (const [id, el] of beforeEls) {
      const now = area.querySelector(`.media-clickable[data-id="${id}"]`);
      if (now) { assert.equal(now, el, `card ${id} recriado`); same++; }
    }
    assert.ok(same >= 15, `cards preservados: ${same}`);
    assert.ok(area.querySelector('.media-clickable[data-id="3"]').classList.contains('selected'), 'seleção preservada');
    assert.equal(h.document.getElementById('libSelectedCount').textContent, '1 selecionado');
  } finally { await h.cleanup(); }
});

test('importação com a lista rolada: a posição na tela do item no topo é mantida (âncora)', async () => {
  const { h, area, state, scrollTo } = await mountLibrary();
  try {
    await scrollTo(3000);
    const rowOf = (el) => el.closest('.lib-vrow');
    const probe = Array.from(area.querySelectorAll('.media-clickable'))[10];
    const probeId = probe.getAttribute('data-id');
    const screenY = () => parseInt(rowOf(area.querySelector(`.media-clickable[data-id="${probeId}"]`)).style.top, 10) - area.scrollTop;
    const y0 = screenY();
    const novos = makeItems(9, 91000).map((m) => ({ ...m, recorded_at: new Date(BASE + 2 * 86400000).toISOString().replace('T', ' ').slice(0, 19) }));
    state.all = [...novos, ...state.all];
    h.bds.emit('onMediaImported', {});
    await settle(250);
    assert.ok(area.scrollTop > 3000, `rolagem ajustada: ${area.scrollTop}`);
    assert.equal(screenY(), y0, 'o item continua no mesmo lugar da tela');
  } finally { await h.cleanup(); }
});

test('modo lista: linhas de altura fixa, rowgroup acessível e janela pequena', async () => {
  const { h, area, scrollTo, cards } = await mountLibrary();
  try {
    h.document.getElementById('btnViewList').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(60);
    assert.ok(area.querySelector('.lib-vlist'), 'modo lista');
    assert.equal(area.querySelector('.lib-vroot').getAttribute('role'), 'grid');
    const n = cards().length;
    assert.ok(n > 10 && n < 80, `linhas no DOM: ${n}`);
    assert.equal(cards()[0].getAttribute('role'), 'row');
    assert.equal(cards()[0].querySelectorAll('[role="gridcell"]').length, 5);
    assert.ok(area.querySelector('.lib-vhead'));
    // altura total = linhas * 52 + cabeçalhos
    const h1 = parseInt(area.querySelector('.lib-vspacer').style.height, 10);
    assert.ok(h1 > 300 * 52, `altura: ${h1}`);
    await scrollTo(5000);
    assert.ok(cards().length < 80);
    // volta à grade
    h.document.getElementById('btnViewGrid').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(60);
    assert.ok(area.querySelector('.lib-vgrid'));
    assert.equal(h.errors.length, 0);
  } finally { await h.cleanup(); }
});

test('redimensionar muda o número de colunas e refaz a janela', async () => {
  const { h, area, ids } = await mountLibrary();
  try {
    const rowsBefore = area.querySelector('.lib-vrow-items').style.gridTemplateColumns;
    assert.match(rowsBefore, /repeat\(4,/);
    Object.defineProperty(area, 'clientWidth', { configurable: true, value: 600 + 48 });
    h.window.dispatchEvent(new h.window.Event('resize'));
    await settle(60);
    assert.match(area.querySelector('.lib-vrow-items').style.gridTemplateColumns, /repeat\(2,/);
    assert.ok(ids().length > 0);
  } finally { await h.cleanup(); }
});

test('teclado: setas movem o foco por índice, inclusive para fora da janela (rola e desenha)', async () => {
  const { h, area, cards } = await mountLibrary();
  try {
    const key = (el, k) => el.dispatchEvent(evt(h, 'keydown', { key: k }));
    const first = cards()[0];
    const id0 = Number(first.getAttribute('data-id'));
    key(first, 'ArrowRight');
    assert.equal(h.document.activeElement.getAttribute('data-id'), String(id0 + 1));
    key(h.document.activeElement, 'ArrowDown');
    assert.equal(h.document.activeElement.getAttribute('data-id'), String(id0 + 1 + 4));
    key(h.document.activeElement, 'End');
    const last = h.document.activeElement;
    assert.equal(last.getAttribute('data-id'), '300', 'End vai ao último item carregado');
    assert.ok(area.scrollTop > 1000, 'rolou até o fim');
    assert.ok(cards().length < 120);
    key(last, 'Home');
    assert.equal(h.document.activeElement.getAttribute('data-id'), '1');
    assert.equal(area.scrollTop <= 8, true);
  } finally { await h.cleanup(); }
});

test('preview: duplo clique abre com a coleção inteira carregada (navegação anterior/próximo)', async () => {
  const { h, area } = await mountLibrary();
  try {
    let opened = null;
    h.window.openPreview = (media, collection) => { opened = { media, collection }; };
    const el = area.querySelector('.media-clickable[data-id="5"]');
    el.dispatchEvent(evt(h, 'dblclick'));
    assert.equal(opened.media.id, 5);
    assert.equal(opened.collection.length, 300);
    assert.equal(opened.collection[5].id, 6);
  } finally { await h.cleanup(); }
});

test('mudar ordenação/filtro: lista nova volta ao topo; favoritar em lote preserva a rolagem', async () => {
  const { h, area, scrollTo, state } = await mountLibrary();
  try {
    await scrollTo(4000);
    // recarga com a MESMA consulta (ex.: favorito em lote): mantém a rolagem e o tamanho carregado
    h.document.getElementById('btnReloadLibrary').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(80);
    assert.equal(area.scrollTop, 4000);
    // ordem invertida = consulta nova: volta ao topo
    h.document.getElementById('btnSortOrder').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(80);
    assert.equal(area.scrollTop, 0);
    assert.equal(state.all.length, 5000);
  } finally { await h.cleanup(); }
});
