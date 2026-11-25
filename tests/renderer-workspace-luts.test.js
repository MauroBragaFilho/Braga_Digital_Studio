'use strict';

// Projeto > Visão geral > cartão "LUTs" (S4): lista com miniatura, nome, tipo e tamanho; "LUT ausente" e "Arquivo alterado";
// "Mostrar na pasta" e "Remover" (com confirmação); "Adicionar da coleção…" (busca, caixas, "No projeto", miniaturas sob
// demanda); cartão escondido com o módulo LUTs desligado; nomes sempre como texto. Harness: linkedom + window.bds simulado.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const APP = pathToFileURL(path.join(__dirname, '..', 'renderer', 'app.js')).href;
const HASH = (c) => c.repeat(64);

const LUTS = () => [
  { id: 1, hash: HASH('a'), name: 'Kodak 2383', title: 'Kodak 2383 D55', kind: '3D', lutSize: 33, bytes: 917504, addedAt: '2026-11-20 10:00:00', status: 'ok', path: 'C:\\LUTs\\Filmes\\Kodak 2383.cube', relPath: 'Filmes/Kodak 2383.cube' },
  { id: 2, hash: HASH('b'), name: 'Curva', title: null, kind: '1D', lutSize: 1024, bytes: 20480, addedAt: '2026-11-20 10:01:00', status: 'changed', path: 'C:\\LUTs\\Curva.cube', relPath: 'Curva.cube' },
  { id: 3, hash: HASH('c'), name: 'Sumiu', title: null, kind: '3D', lutSize: 17, bytes: 100000, addedAt: '2026-11-20 10:02:00', status: 'missing', path: null, relPath: null }
];
const item = (relPath, extra = {}) => {
  const parts = relPath.split('/');
  const name = parts.pop();
  return { id: null, hash: null, name, displayName: name.replace(/\.cube$/i, ''), path: `C:\\LUTs\\${relPath.split('/').join('\\')}`, relPath, folder: parts.join('/'), depth: parts.length, size: 1000, modifiedAt: 1, ...extra };
};

async function mountWorkspace({ luts = LUTS(), bds = {}, beforeInit = () => {} } = {}) {
  const calls = [];
  let current = luts;
  const h = await mountScreen('project_workspace', {
    init: false,
    bds: {
      getProject: async () => ({ id: 1, name: 'Casamento', client: 'Ana', type: '', status: 'Em produção', deadline: null, description: '', color: '#3b82f6', cover_path: '' }),
      getProjectBins: async () => [],
      getProjectMedia: async () => [],
      getProjectSyncGroups: async () => [],
      getMissingProjectMedia: async () => [],
      getProjectSummary: async () => ({ videos: 0, audios: 0, photos: 0, total_size: 0, missing: 0, transcripts: 0, devices: 0, delivery: { status: 'Não iniciada', done: 0, items: 0, deadline: null }, last_activity_at: null, last_activity: null }),
      listProjectActivity: async () => { calls.push(['activity']); return [{ id: 1, kind: 'lut', message: 'LUT adicionada: Kodak 2383', created_at: '2026-11-20 10:00:00' }]; },
      listProjectDevices: async () => [],
      getProjectDelivery: async () => ({ status: 'Não iniciada', deadline: null, items: [], destinations: [], notes: '', saved: false }),
      listProjectLuts: async (id) => { calls.push(['list', id]); return typeof current === 'function' ? current() : current; },
      removeProjectLut: async (id, hash) => { calls.push(['remove', id, hash]); current = current.filter((l) => l.hash !== hash); return true; },
      revealProjectLut: async (id, hash) => { calls.push(['reveal', id, hash]); return true; },
      addProjectLuts: async (id, rels) => { calls.push(['add', id, rels]); return { added: rels.length, already: 0, invalid: [], overLimit: 0 }; },
      ...bds
    }
  });
  beforeInit(h);
  const app = await import(APP);
  app.state.currentProjectId = 1;
  await h.mod.initScreen();
  await settle(60);
  return { h, calls, setLuts: (l) => { current = l; } };
}

const $ = (h, sel) => h.document.querySelector(sel);
const $$ = (h, sel) => [...h.document.querySelectorAll(sel)];
const hasClass = (el, c) => el.classList.contains(c);
const click = (h, el) => el.dispatchEvent(new h.window.Event('click', { bubbles: true }));
const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
const items = (h) => $$(h, '#wsLutsList .ws-lut-item');
const simulateFocus = (h) => {
  const state = { atual: null };
  Object.defineProperty(h.document, 'activeElement', { configurable: true, get: () => state.atual });
  const proto = h.window.Element.prototype;
  const original = proto.focus;
  proto.focus = function focar() { state.atual = this; };
  return { state, restore() { proto.focus = original; } };
};

test('cartão "LUTs": nome, tipo, tamanho e o estado de cada LUT (ok, alterada, ausente)', async () => {
  const { h } = await mountWorkspace();
  try {
    const rows = items(h);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].querySelector('.ws-lut-name').textContent, 'Kodak 2383');
    assert.equal(rows[0].querySelector('.ws-lut-name').getAttribute('title'), 'Kodak 2383 — Kodak 2383 D55');
    assert.equal(text(rows[0].querySelector('.ws-lut-meta')), 'LUT 3D · 33³ · 896 KB');
    assert.equal(rows[0].querySelector('.ws-lut-status'), null, 'LUT ok não tem aviso');
    assert.equal(text(rows[1].querySelector('.ws-lut-meta')), 'LUT 1D · 1024 pontos · 20,0 KB');
    assert.equal(text(rows[1].querySelector('.ws-lut-status')), 'Arquivo alterado');
    assert.equal(text(rows[2].querySelector('.ws-lut-status')), 'LUT ausente');
    assert.ok(hasClass(rows[2], 'is-missing'));
    assert.ok(hasClass(rows[2].querySelector('.ws-lut-status'), 'tone-warn'));
    assert.equal(rows[2].querySelector('[data-lut-action="reveal"]').disabled, true, 'não há arquivo para mostrar');
    assert.equal(rows[0].querySelector('[data-lut-action="reveal"]').disabled, false);
    assert.ok(!hasClass($(h, '#wsLutsCard'), 'hidden'));
    assert.equal(text($(h, '#wsLutsAdd')), 'Adicionar da coleção…');
  } finally { await h.cleanup(); }
});

test('botões só de ícone têm nome e dica; o cartão entra entre Equipamentos e Atividade', async () => {
  const { h } = await mountWorkspace();
  try {
    for (const b of $$(h, '#wsLutsList button')) {
      assert.ok(b.getAttribute('aria-label'), 'aria-label');
      assert.ok(b.getAttribute('title'), 'title');
    }
    assert.equal($(h, '[data-lut-action="remove"]').getAttribute('aria-label'), 'Remover Kodak 2383 do projeto');
    assert.equal($(h, '[data-lut-action="reveal"]').getAttribute('aria-label'), 'Mostrar Kodak 2383 na pasta');
    const titles = $$(h, '.ws-overview-side .ws-card-title').map(text);
    assert.deepEqual(titles, ['Observações', 'Equipamentos', 'LUTs', 'Atividade']);
    assert.equal($(h, '#wsLutsList').getAttribute('aria-live'), 'polite');
  } finally { await h.cleanup(); }
});

test('projeto sem LUTs: dica curta e o link para adicionar (sem botão fixo)', async () => {
  const { h } = await mountWorkspace({ luts: [] });
  try {
    assert.equal(items(h).length, 0);
    assert.match(text($(h, '#wsLutsList')), /LUTs de cor deste trabalho/);
    assert.equal($$(h, '#wsLutsCard button').length, 1);
    assert.ok(hasClass($(h, '#wsLutsAdd'), 'ws-link'));
  } finally { await h.cleanup(); }
});

test('falha ao ler as LUTs do projeto: mensagem curta, sem quebrar a Visão geral', async () => {
  const { h } = await mountWorkspace({ bds: { listProjectLuts: async () => { throw new Error('x'); } } });
  try {
    assert.match(text($(h, '#wsLutsList')), /Não foi possível ler as LUTs do projeto\./);
    assert.match(text($(h, '#wsActivityList')), /LUT adicionada: Kodak 2383/, 'o resto da tela segue');
  } finally { await h.cleanup(); }
});

test('atividade "lut" aparece com o ícone próprio', async () => {
  const { h } = await mountWorkspace();
  try {
    const icon = $(h, '#wsActivityList .ws-activity-item .material-symbols-rounded');
    assert.equal(icon.textContent, 'gradient');
  } finally { await h.cleanup(); }
});

test('mostrar na pasta chama o main com o projeto e o conteúdo da LUT (nunca um caminho)', async () => {
  const { h, calls } = await mountWorkspace();
  try {
    click(h, items(h)[0].querySelector('[data-lut-action="reveal"]'));
    await settle(10);
    assert.deepEqual(calls.filter((c) => c[0] === 'reveal'), [['reveal', 1, HASH('a')]]);
  } finally { await h.cleanup(); }
});

test('mostrar na pasta que falha: o aviso vai para a barra de estado (sem diálogo e sem erro solto)', async () => {
  const { h } = await mountWorkspace({ bds: { revealProjectLut: async () => { throw new Error("Error invoking remote method 'projects:revealLut': Error: Esta LUT não está mais na coleção."); } } });
  try {
    click(h, items(h)[0].querySelector('[data-lut-action="reveal"]'));
    await settle(20);
    assert.deepEqual(h.dialogs.alerts, []);
    assert.deepEqual(h.errors, []);
  } finally { await h.cleanup(); }
});

test('remover: confirma com o nome, tira só a ligação, atualiza a lista e a atividade, e o foco não se perde', async () => {
  const { h, calls } = await mountWorkspace();
  const focus = simulateFocus(h);
  try {
    const before = calls.filter((c) => c[0] === 'activity').length;
    click(h, items(h)[1].querySelector('[data-lut-action="remove"]'));
    await settle(40);
    assert.equal(h.dialogs.confirms.length, 1);
    assert.match(h.dialogs.confirms[0], /Remover "Curva" das LUTs do projeto\?/);
    assert.match(h.dialogs.confirms[0], /A LUT continua na coleção de LUTs\./);
    assert.deepEqual(calls.filter((c) => c[0] === 'remove'), [['remove', 1, HASH('b')]]);
    assert.deepEqual(items(h).map((r) => r.querySelector('.ws-lut-name').textContent), ['Kodak 2383', 'Sumiu']);
    assert.ok(calls.filter((c) => c[0] === 'activity').length > before, 'a atividade foi relida');
    const target = focus.state.atual;
    assert.ok(target && target.dataset.lutAction === 'remove' && target.closest('.ws-lut-item').dataset.hash === HASH('c'), 'o foco vai para o "Remover" do item que ocupou o lugar');

    // remover o último item: o foco vai para o link "Adicionar da coleção…"
    click(h, items(h)[1].querySelector('[data-lut-action="remove"]'));
    await settle(40);
    click(h, items(h)[0].querySelector('[data-lut-action="remove"]'));
    await settle(40);
    assert.equal(items(h).length, 0);
    assert.equal(focus.state.atual, $(h, '#wsLutsAdd'));
  } finally { focus.restore(); await h.cleanup(); }
});

test('remover: sem confirmar, nada é removido', async () => {
  const { h, calls } = await mountWorkspace();
  try {
    h.window.bdsModal.confirm = async () => false;
    click(h, items(h)[0].querySelector('[data-lut-action="remove"]'));
    await settle(20);
    assert.deepEqual(calls.filter((c) => c[0] === 'remove'), []);
    assert.equal(items(h).length, 3);
  } finally { await h.cleanup(); }
});

test('nomes com HTML (LUT e título) nunca viram HTML', async () => {
  const evil = [{ ...LUTS()[0], name: '<img src=x onerror=alert(1)>', title: '<b>t</b>' }];
  const { h } = await mountWorkspace({ luts: evil });
  try {
    assert.equal($$(h, '#wsLutsList img').length, 0);
    assert.equal($$(h, '#wsLutsList b').length, 1, 'só o <b> do próprio nome (elemento de estrutura), sem filhos injetados');
    assert.equal($(h, '.ws-lut-name').textContent, '<img src=x onerror=alert(1)>');
  } finally { await h.cleanup(); }
});

// ─── Adicionar da coleção ────────────────────────────────────────────────────────────────────────

const COLLECTION = () => [item('Filmes/Kodak 2383.cube', { hash: HASH('a') }), item('Looks/Rush/Ação.cube'), item('Looks/Rush/b.cube'), item('Solta.cube'), item('Outra/z.cube', { hash: HASH('b') })];
const picker = (h) => $(h, '#wsLutPicker');
const pickerOpen = (h) => !hasClass(picker(h), 'hidden');
const rows = (h) => $$(h, '#wsLutPickerList .ws-import-item');
const rowLabel = (r) => r.querySelector('.ws-import-name').textContent;
const tick = (h, rel) => { const c = $(h, `#wsLutPickerList input[data-rel="${rel}"]`); c.checked = true; c.dispatchEvent(new h.window.Event('change', { bubbles: true })); };

test('janela "Adicionar da coleção…": lista a coleção, marca "No projeto", busca sem acento e conta as escolhidas', async () => {
  const { h } = await mountWorkspace({ bds: { listLuts: async () => ({ folder: 'C:\\LUTs', items: COLLECTION(), problems: [] }) } });
  try {
    assert.ok(!pickerOpen(h));
    click(h, $(h, '#wsLutsAdd'));
    await settle(30);
    assert.ok(pickerOpen(h));
    assert.deepEqual(rows(h).map(rowLabel), ['Kodak 2383', 'Ação', 'b', 'z', 'Solta'], 'ordem natural pelo caminho');
    const byLabel = Object.fromEntries(rows(h).map((r) => [rowLabel(r), r]));
    assert.ok(hasClass(byLabel['Kodak 2383'], 'is-disabled'), 'já está no projeto (mesmo conteúdo)');
    assert.equal(byLabel['Kodak 2383'].querySelector('input').disabled, true);
    assert.equal(text(byLabel['Kodak 2383'].querySelector('.ws-import-meta')), 'No projeto');
    assert.equal(text(byLabel.z.querySelector('.ws-import-meta')), 'No projeto', 'tem o mesmo conteúdo de uma LUT do projeto, mesmo com outro nome');
    assert.equal(text(byLabel.b.querySelector('.ws-import-meta')), 'Looks / Rush', 'a pasta aparece ao lado do nome');
    assert.equal(byLabel.b.querySelector('input').disabled, false);
    assert.equal($(h, '#wsLutPickerConfirm').disabled, true);
    assert.equal(text($(h, '#wsLutPickerCount')), '0 selecionadas');

    const search = $(h, '#wsLutPickerSearch');
    search.value = 'acao';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    assert.deepEqual(rows(h).map(rowLabel), ['Ação'], 'sem acento nem caixa');
    search.value = 'rush';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    assert.deepEqual(rows(h).map(rowLabel).sort(), ['Ação', 'b'], 'o nome da pasta também vale');
    search.value = 'nada';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    assert.match(text($(h, '#wsLutPickerList')), /Nenhuma LUT para essa busca/);
  } finally { await h.cleanup(); }
});

test('janela: marcar e adicionar chama o main com os caminhos relativos, fecha, atualiza a lista e avisa', async () => {
  const added = [];
  const { h, calls, setLuts } = await mountWorkspace({
    bds: {
      listLuts: async () => ({ folder: 'C:\\LUTs', items: COLLECTION(), problems: [] }),
      addProjectLuts: async (id, rels) => { added.push([id, rels]); setLuts([...LUTS(), { ...LUTS()[0], id: 9, hash: HASH('d'), name: 'Solta', relPath: 'Solta.cube', status: 'ok' }]); return { added: 2, already: 0, invalid: [], overLimit: 0 }; }
    }
  });
  try {
    click(h, $(h, '#wsLutsAdd'));
    await settle(30);
    tick(h, 'Solta.cube');
    tick(h, 'Looks/Rush/b.cube');
    assert.equal(text($(h, '#wsLutPickerCount')), '2 selecionadas');
    assert.equal(text($(h, '#wsLutPickerConfirm')), 'Adicionar 2');
    assert.equal($(h, '#wsLutPickerConfirm').disabled, false);
    const listCalls = calls.filter((c) => c[0] === 'list').length;
    click(h, $(h, '#wsLutPickerConfirm'));
    await settle(60);
    assert.equal(added.length, 1);
    assert.equal(added[0][0], 1, 'o projeto aberto');
    assert.deepEqual([...added[0][1]].sort(), ['Looks/Rush/b.cube', 'Solta.cube'], 'só caminhos relativos da coleção');
    assert.ok(!pickerOpen(h), 'a janela fecha');
    assert.ok(calls.filter((c) => c[0] === 'list').length > listCalls, 'o cartão foi relido');
    assert.equal(items(h).length, 4);
    assert.deepEqual(h.dialogs.alerts, [], 'sem problemas, sem diálogo');
  } finally { await h.cleanup(); }
});

test('janela: LUT recusada ou limite de 100 aparecem em um aviso com o motivo', async () => {
  const { h } = await mountWorkspace({
    bds: {
      listLuts: async () => ({ folder: 'C:\\LUTs', items: COLLECTION(), problems: [] }),
      addProjectLuts: async () => ({ added: 1, already: 0, overLimit: 4, invalid: [{ name: 'b.cube', reason: 'O arquivo está vazio.' }] })
    }
  });
  try {
    click(h, $(h, '#wsLutsAdd'));
    await settle(30);
    tick(h, 'Solta.cube');
    click(h, $(h, '#wsLutPickerConfirm'));
    await settle(60);
    assert.equal(h.dialogs.alerts.length, 1);
    assert.match(h.dialogs.alerts[0], /1 LUT adicionada ao projeto\./);
    assert.match(h.dialogs.alerts[0], /O projeto aceita até 100 LUTs; 4 LUTs não foram adicionadas\./);
    assert.match(h.dialogs.alerts[0], /1 LUT não pôde ser adicionada: b\.cube \(O arquivo está vazio\.\)\./);
  } finally { await h.cleanup(); }
});

test('janela: erro ao adicionar fica na janela (que continua aberta) e não perde a escolha', async () => {
  const { h } = await mountWorkspace({
    bds: {
      listLuts: async () => ({ folder: 'C:\\LUTs', items: COLLECTION(), problems: [] }),
      addProjectLuts: async () => { throw new Error("Error invoking remote method 'projects:addLuts': Error: Este projeto não existe mais."); }
    }
  });
  try {
    click(h, $(h, '#wsLutsAdd'));
    await settle(30);
    tick(h, 'Solta.cube');
    click(h, $(h, '#wsLutPickerConfirm'));
    await settle(40);
    assert.ok(pickerOpen(h));
    assert.match(text($(h, '#wsLutPickerNote')), /Não foi possível adicionar: Este projeto não existe mais\./);
    assert.equal($(h, '#wsLutPickerConfirm').disabled, false, 'dá para tentar de novo');
  } finally { await h.cleanup(); }
});

test('janela: coleção vazia e falha ao ler a coleção têm mensagem própria', async () => {
  const empty = await mountWorkspace({ bds: { listLuts: async () => ({ folder: 'C:\\LUTs', items: [], problems: [] }) } });
  try {
    click(empty.h, $(empty.h, '#wsLutsAdd'));
    await settle(30);
    assert.match(text($(empty.h, '#wsLutPickerNote')), /A coleção de LUTs está vazia\./);
    assert.equal($(empty.h, '#wsLutPickerConfirm').disabled, true);
  } finally { await empty.h.cleanup(); }
  const broken = await mountWorkspace({ bds: { listLuts: async () => { throw new Error('x'); } } });
  try {
    click(broken.h, $(broken.h, '#wsLutsAdd'));
    await settle(30);
    assert.match(text($(broken.h, '#wsLutPickerNote')), /Não foi possível ler a coleção de LUTs/);
  } finally { await broken.h.cleanup(); }
});

test('janela: Esc fecha; nomes de pasta e de LUT com HTML ficam como texto; a lista é limitada a 300 linhas', async () => {
  const many = Array.from({ length: 320 }, (_, i) => item(`Pasta/L${String(i).padStart(3, '0')}.cube`));
  const evil = [item('<img src=x onerror=alert(1)>/<b onmouseover=alert(2)>x.cube'), ...many];
  const { h } = await mountWorkspace({ bds: { listLuts: async () => ({ folder: 'C:\\LUTs', items: evil, problems: [] }) } });
  try {
    click(h, $(h, '#wsLutsAdd'));
    await settle(40);
    assert.equal(rows(h).length, 300);
    assert.match(text($(h, '#wsLutPickerList')), /Mostrando 300 de 321\. Use a busca para achar as outras\./);
    assert.equal($$(h, '#wsLutPickerList img[src="x"]').length, 0);
    const search = $(h, '#wsLutPickerSearch');
    search.value = 'img';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    assert.equal(rows(h).length, 1);
    assert.equal(rowLabel(rows(h)[0]), '<b onmouseover=alert(2)>x');
    assert.equal($$(h, '#wsLutPickerList b').length, 0);
    h.mod.onKeyDown({ key: 'Escape', target: h.document.body });
    assert.ok(!pickerOpen(h));
  } finally { await h.cleanup(); }
});

// ─── Módulo LUTs desligado ───────────────────────────────────────────────────────────────────────

test('com o módulo LUTs desligado o cartão fica escondido e nada é lido; ligando, ele aparece', async () => {
  let allowed = false;
  const { h, calls } = await mountWorkspace({ beforeInit: (hh) => { hh.window.bdsIsScreenAllowed = (s) => (s === 'luts' ? allowed : true); } });
  try {
    assert.ok(hasClass($(h, '#wsLutsCard'), 'hidden'));
    assert.deepEqual(calls.filter((c) => c[0] === 'list'), [], 'não lê as LUTs do projeto com o módulo desligado');
    allowed = true;
    h.window.dispatchEvent(new h.window.CustomEvent('bds:modules-changed'));
    await settle(40);
    assert.ok(!hasClass($(h, '#wsLutsCard'), 'hidden'));
    assert.equal(items(h).length, 3, 'os dados continuavam guardados');
    allowed = false;
    h.window.dispatchEvent(new h.window.CustomEvent('bds:modules-changed'));
    await settle(10);
    assert.ok(hasClass($(h, '#wsLutsCard'), 'hidden'));
  } finally { delete h.window.bdsIsScreenAllowed; await h.cleanup(); }
});

// ─── Miniaturas sob demanda ──────────────────────────────────────────────────────────────────────

test('miniaturas: só quando o item chega perto da tela; a LUT aplicada vira a imagem do item', async () => {
  const observers = [];
  const parsed = [];
  class FakeObserver {
    constructor(cb, options) { this.cb = cb; this.options = options; this.els = []; observers.push(this); }
    observe(el) { this.els.push(el); }
    unobserve() {}
    disconnect() { this.els = []; }
  }
  class FakeImage {
    constructor() { this.naturalWidth = 640; this.naturalHeight = 360; }
    set src(v) { this._src = v; queueMicrotask(() => this.onload && this.onload()); }
    get src() { return this._src; }
  }
  const { h } = await mountWorkspace({
    luts: [LUTS()[0]],
    beforeInit: () => { globalThis.IntersectionObserver = FakeObserver; globalThis.Image = FakeImage; },
    bds: {
      parseLutCube: async (p) => { parsed.push(p); return { ok: true, size: 2, is1D: false, data: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]] }; }
    }
  });
  const realCreate = h.document.createElement.bind(h.document);
  try {
    h.document.createElement = (tag, ...rest) => {
      if (String(tag).toLowerCase() !== 'canvas') return realCreate(tag, ...rest);
      return { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: (x, y, w, hh) => ({ data: new Uint8ClampedArray(w * hh * 4) }), putImageData() {} }), toDataURL: () => 'data:image/jpeg;base64,AAAA' };
    };
    assert.deepEqual(parsed, [], 'nada é lido antes de o item aparecer');
    const watching = observers.filter((o) => o.els.length);
    assert.equal(watching.length, 1);
    const thumb = watching[0].els[0];
    assert.equal(thumb.dataset.thumbPath, 'C:\\LUTs\\Filmes\\Kodak 2383.cube');
    assert.equal(thumb.dataset.thumbKey, HASH('a'), 'a miniatura é guardada pelo conteúdo');
    watching[0].cb([{ isIntersecting: false, target: thumb }]);
    await settle(20);
    assert.deepEqual(parsed, [], 'fora da tela continua sem ler');
    watching[0].cb([{ isIntersecting: true, target: thumb }]);
    await settle(80);
    assert.deepEqual(parsed, ['C:\\LUTs\\Filmes\\Kodak 2383.cube']);
    const img = thumb.querySelector('img');
    assert.ok(img, 'a imagem entrou no item');
    assert.equal(img.getAttribute('src'), 'data:image/jpeg;base64,AAAA');
    assert.equal(img.getAttribute('alt'), '');
    assert.ok(hasClass(thumb, 'has-img'));
  } finally { h.document.createElement = realCreate; await h.cleanup(); }
});

test('miniaturas: LUT ausente não pede leitura (fica o ícone)', async () => {
  const observers = [];
  class FakeObserver { constructor() { this.els = []; observers.push(this); } observe(el) { this.els.push(el); } unobserve() {} disconnect() {} }
  const { h } = await mountWorkspace({ luts: [LUTS()[2]], beforeInit: () => { globalThis.IntersectionObserver = FakeObserver; } });
  try {
    assert.equal(observers.flatMap((o) => o.els).length, 0);
    assert.equal($(h, '.ws-lut-thumb').textContent, 'broken_image');
  } finally { await h.cleanup(); }
});
