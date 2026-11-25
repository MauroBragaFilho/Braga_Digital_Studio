'use strict';

// Tela de LUTs (S4): "Adicionar a um projeto…" no menu do cartão, na barra de seleção, no menu da pasta e no painel
// (link de texto), a janela de escolha do projeto (busca, arquivados, "Já tem", sem projetos), o resumo do resultado,
// o aviso "usada em N projetos" antes de excluir e o comportamento com o módulo Projetos desligado.
// Harness: linkedom + window.bds simulado.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountScreen, settle } = require('./helpers/renderer-harness');

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
const PROJECTS = [
  { id: 1, name: 'Casamento João', client: 'João', status: 'Em produção', created_at: '2026-10-01 10:00:00', last_activity_at: '2026-10-05 10:00:00' },
  { id: 2, name: 'Evento Acme', client: 'Acme Ltda', status: 'Pós-produção', created_at: '2026-10-02 10:00:00', last_activity_at: '2026-10-09 10:00:00' },
  { id: 3, name: 'Clipe antigo', client: 'Ação Filmes', status: 'Arquivado', created_at: '2026-01-02 10:00:00', last_activity_at: '2026-01-09 10:00:00' }
];
const TREE = () => [lut('Solta.cube'), lut('Looks/Rush/a.cube'), lut('Looks/Rush/b.cube'), lut('Looks/Look 2/c.cube'), lut('Outra/z.cube')];

function bdsFor(items, extra = {}) {
  return {
    listLuts: async () => ({ folder: 'C:\\LUTs', items: items.map((i) => ({ ...i })), problems: [] }),
    getLutHeader: async () => HEADER,
    parseLutCube: async () => ({ ok: false, code: 'NO_SIZE', reason: 'Falta a linha de tamanho.' }),
    getPathForFile: (f) => f.path,
    listProjects: async () => PROJECTS.map((p) => ({ ...p })),
    lutsUsage: async () => [],
    addProjectLuts: async () => ({ added: 1, already: 0, invalid: [], overLimit: 0 }),
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
const click = (h, el, mods = {}) => el.dispatchEvent(Object.assign(new h.window.Event('click', { bubbles: true }), mods));
const key = (h, k, extra = {}) => { let prevented = false; h.mod.onKeyDown({ key: k, target: h.document.body, preventDefault() { prevented = true; }, ...extra }); return prevented; };
const cards = (h) => $$(h, '#lutsGrid .lut-card');
const title = (c) => c.querySelector('.lut-card-title').textContent;
const card = (h, name) => cards(h).find((c) => title(c) === name);
const picker = (h) => $(h, '#lutProjectPicker');
const pickerOpen = (h) => !hasClass(picker(h), 'hidden');
const projectRows = (h) => $$(h, '#projectPickerList .lut-project-item');
const rowName = (r) => r.querySelector('.lut-project-name').textContent;
const confirmBtn = (h) => $(h, '#btnProjectPickerConfirm');
const noticeText = (h) => $(h, '#lutsNoticeText').textContent;
const notice = (h) => $(h, '#lutsNotice');
const choose = (h, id) => { const r = $(h, `#projectPickerList input[value="${id}"]`); r.checked = true; r.dispatchEvent(new h.window.Event('change', { bubbles: true })); };

/** linkedom não tem foco real: um "activeElement" simulado, alimentado por focus(). */
function simulateFocus(h) {
  const state = { atual: null };
  Object.defineProperty(h.document, 'activeElement', { configurable: true, get: () => state.atual });
  const proto = h.window.Element.prototype;
  const original = proto.focus;
  proto.focus = function focar() { state.atual = this; };
  return { state, restore() { proto.focus = original; } };
}
/** Uma LUT 3D 2x2x2 válida: a miniatura e a prévia não marcam a LUT como inválida. */
const GOOD_PARSED = { ok: true, size: 2, is1D: false, data: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]], title: null, domainMin: null, domainMax: null, totalEntries: 8, preview: [] };
const parseGood = async (p) => ({ ...GOOD_PARSED, path: p });

async function openFromCardMenu(h, name) {
  click(h, card(h, name).querySelector('[data-action="menu"]'));
  await settle(10);
  click(h, $(h, '#lutCardMenu [data-action="add-project"]'));
  await settle(30);
}

test('menu do cartão: "Adicionar a um projeto…" abre a escolha com os projetos ativos primeiro e os arquivados escondidos', async () => {
  const h = await mount(TREE());
  try {
    assert.ok(!pickerOpen(h));
    await openFromCardMenu(h, 'Solta.cube');
    assert.ok(pickerOpen(h));
    assert.equal($(h, '#projectPickerWhat').textContent, '1 LUT: Solta');
    assert.deepEqual(projectRows(h).map(rowName), ['Evento Acme', 'Casamento João'], 'mais recente primeiro; o arquivado fica de fora');
    assert.ok(!hasClass($(h, '#projectPickerArchivedRow'), 'hidden'), '"Mostrar arquivados" aparece porque há arquivado');
    assert.equal(confirmBtn(h).disabled, true, 'sem projeto escolhido não confirma');
    assert.ok(hasClass($(h, '#lutCardMenu'), 'hidden'), 'o menu fechou');

    $(h, '#projectPickerArchived').checked = true;
    $(h, '#projectPickerArchived').dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.deepEqual(projectRows(h).map(rowName), ['Evento Acme', 'Casamento João', 'Clipe antigo'], 'arquivados vão para o fim');
  } finally { await h.cleanup(); }
});

test('busca por nome ou cliente, sem acento nem caixa', async () => {
  const h = await mount(TREE());
  try {
    await openFromCardMenu(h, 'Solta.cube');
    const search = $(h, '#projectPickerSearch');
    const type = (value) => { search.value = value; search.dispatchEvent(new h.window.Event('input', { bubbles: true })); };
    type('acme');
    assert.deepEqual(projectRows(h).map(rowName), ['Evento Acme']);
    type('JOAO');
    assert.deepEqual(projectRows(h).map(rowName), ['Casamento João'], 'o cliente também vale e acento não importa');
    type('acao');
    assert.deepEqual(projectRows(h).map(rowName), [], 'o arquivado não aparece sem marcar');
    assert.match($(h, '#projectPickerList').textContent, /Nenhum projeto para essa busca/);
    type('zzz');
    assert.match($(h, '#projectPickerList').textContent, /Nenhum projeto para essa busca/);
  } finally { await h.cleanup(); }
});

test('escolher o projeto e confirmar: addProjectLuts com o caminho relativo e o resumo "adicionada ao projeto"', async () => {
  const calls = [];
  const h = await mount(TREE(), { addProjectLuts: async (...a) => { calls.push(a); return { added: 1, already: 0, invalid: [], overLimit: 0 }; } });
  try {
    await openFromCardMenu(h, 'a.cube');
    choose(h, 2);
    assert.equal(confirmBtn(h).disabled, false);
    click(h, confirmBtn(h));
    await settle(30);
    assert.deepEqual(calls, [[2, ['Looks/Rush/a.cube']]], 'só o caminho relativo da coleção segue para o main');
    assert.ok(!pickerOpen(h), 'a janela fecha');
    assert.match(noticeText(h), /^1 LUT adicionada ao projeto "Evento Acme"\.$/);
    assert.ok(hasClass(notice(h), 'tone-success'));
  } finally { await h.cleanup(); }
});

test('barra de seleção: vários caminhos de uma vez; resumo com "já estava" e limite de 100', async () => {
  const calls = [];
  const h = await mount(TREE(), {
    addProjectLuts: async (...a) => { calls.push(a); return { added: 2, already: 1, invalid: [], overLimit: 3 }; }
  });
  const focus = simulateFocus(h);
  try {
    click(h, card(h, 'a.cube'));
    click(h, card(h, 'b.cube'), { ctrlKey: true });
    click(h, card(h, 'z.cube'), { ctrlKey: true });
    await settle(10);
    assert.ok(!hasClass($(h, '#lutSelectionBar'), 'hidden'));
    const add = $(h, '#btnSelAddProject');
    assert.ok(!hasClass(add, 'hidden'));
    click(h, add);
    await settle(30);
    assert.match($(h, '#projectPickerWhat').textContent, /^3 LUTs: a, b, z$/);
    choose(h, 1);
    click(h, confirmBtn(h));
    await settle(30);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1].sort(), ['Looks/Rush/a.cube', 'Looks/Rush/b.cube', 'Outra/z.cube']);
    assert.match(noticeText(h), /2 LUTs adicionadas ao projeto "Casamento João"; 1 já estava\./);
    assert.match(noticeText(h), /O projeto aceita até 100 LUTs; 3 LUTs não foram adicionadas\./);
    assert.ok(hasClass(notice(h), 'tone-warning'));
    assert.equal(focus.state.atual && focus.state.atual.id, 'btnSelAddProject', 'o foco volta ao botão que abriu a janela');
  } finally { focus.restore(); await h.cleanup(); }
});

test('LUTs recusadas aparecem no resumo com o motivo', async () => {
  const h = await mount(TREE(), { addProjectLuts: async () => ({ added: 0, already: 0, overLimit: 0, invalid: [{ name: 'a.cube', reason: 'O arquivo está vazio.' }] }) });
  try {
    await openFromCardMenu(h, 'a.cube');
    choose(h, 1);
    click(h, confirmBtn(h));
    await settle(30);
    assert.match(noticeText(h), /1 LUT não pôde ser adicionada: a\.cube \(O arquivo está vazio\.\)\./);
    assert.ok(hasClass(notice(h), 'tone-danger'));
  } finally { await h.cleanup(); }
});

test('menu da pasta: adiciona todas as LUTs da pasta (o main expande a pasta) e o texto diz quantas são', async () => {
  const calls = [];
  const h = await mount(TREE(), { addProjectLuts: async (...a) => { calls.push(a); return { added: 2, already: 0, invalid: [], overLimit: 0 }; } });
  try {
    const head = $$(h, '#lutsGrid .lut-group-head').find((x) => x.dataset.folder === 'Looks/Rush');
    click(h, head.querySelector('[data-action="group-menu"]'));
    await settle(10);
    click(h, $(h, '#lutGroupMenu [data-action="add-project-folder"]'));
    await settle(30);
    assert.equal($(h, '#projectPickerWhat').textContent, 'Todas as LUTs da pasta "Looks / Rush" (2 LUTs)');
    choose(h, 1);
    click(h, confirmBtn(h));
    await settle(30);
    assert.deepEqual(calls, [[1, [], ['Looks/Rush']]], 'vai a pasta, não a lista de arquivos');
    assert.match(noticeText(h), /2 LUTs adicionadas ao projeto "Casamento João"\./);
  } finally { await h.cleanup(); }
});

test('"Já tem": o projeto que contém todas as LUTs escolhidas fica desativado', async () => {
  const usage = async () => [
    { relPath: 'Looks/Rush/a.cube', hash: 'a'.repeat(64), projects: [{ id: 1, name: 'Casamento João' }, { id: 2, name: 'Evento Acme' }], remainingCopies: 1 },
    { relPath: 'Looks/Rush/b.cube', hash: 'b'.repeat(64), projects: [{ id: 1, name: 'Casamento João' }], remainingCopies: 1 }
  ];
  const h = await mount(TREE(), { lutsUsage: usage });
  try {
    click(h, card(h, 'a.cube'));
    click(h, card(h, 'b.cube'), { ctrlKey: true });
    await settle(10);
    click(h, $(h, '#btnSelAddProject'));
    await settle(40);
    const rows = Object.fromEntries(projectRows(h).map((r) => [rowName(r), r]));
    assert.ok(hasClass(rows['Casamento João'], 'is-disabled'), 'tem as duas');
    assert.match(rows['Casamento João'].textContent, /Já tem todas/);
    assert.equal(rows['Casamento João'].querySelector('input').disabled, true);
    assert.ok(!hasClass(rows['Evento Acme'], 'is-disabled'), 'só tem uma das duas: ainda recebe a outra');
    choose(h, 2);
    assert.equal(confirmBtn(h).disabled, false);
  } finally { await h.cleanup(); }
});

test('sem projetos: "Você ainda não tem projetos." e nada para confirmar (sem botão extra)', async () => {
  const h = await mount(TREE(), { listProjects: async () => [] });
  try {
    await openFromCardMenu(h, 'Solta.cube');
    assert.equal($(h, '#projectPickerList').textContent.trim(), 'Você ainda não tem projetos.');
    assert.equal(confirmBtn(h).disabled, true);
    assert.deepEqual($$(h, '#lutProjectPicker button').map((b) => b.id), ['btnProjectPickerClose', 'btnProjectPickerCancel', 'btnProjectPickerConfirm']);
    assert.ok(hasClass($(h, '#projectPickerArchivedRow'), 'hidden'));
  } finally { await h.cleanup(); }
});

test('só há projetos arquivados: o texto manda marcar "Mostrar arquivados"', async () => {
  const h = await mount(TREE(), { listProjects: async () => [PROJECTS[2]] });
  try {
    await openFromCardMenu(h, 'Solta.cube');
    assert.match($(h, '#projectPickerList').textContent, /Só há projetos arquivados/);
  } finally { await h.cleanup(); }
});

test('falha ao adicionar: a mensagem aparece na janela, que continua aberta, em português', async () => {
  const h = await mount(TREE(), { addProjectLuts: async () => { throw new Error("Error invoking remote method 'projects:addLuts': Error: Este projeto não existe mais."); } });
  try {
    await openFromCardMenu(h, 'Solta.cube');
    choose(h, 1);
    click(h, confirmBtn(h));
    await settle(30);
    assert.ok(pickerOpen(h));
    assert.equal(hasClass($(h, '#projectPickerError'), 'hidden'), false);
    assert.match($(h, '#projectPickerError').textContent, /Não foi possível adicionar as LUTs: Este projeto não existe mais\./);
    assert.ok(!/Error invoking/.test($(h, '#projectPickerError').textContent));
  } finally { await h.cleanup(); }
});

test('Esc fecha a janela e devolve o foco a um cartão; com ela aberta, Delete e F2 não agem sobre a LUT de trás', async () => {
  const deleted = [];
  const h = await mount(TREE(), { deleteLut: async (p) => { deleted.push(p); return true; } });
  const focus = simulateFocus(h);
  try {
    await openFromCardMenu(h, 'Solta.cube');
    assert.ok(pickerOpen(h));
    key(h, 'Delete');
    key(h, 'F2');
    await settle(10);
    assert.deepEqual(deleted, []);
    assert.deepEqual(h.dialogs.confirms, []);
    assert.equal(key(h, 'Escape'), true);
    assert.ok(!pickerOpen(h));
    await settle(10);
    assert.ok(card(h, 'Solta.cube').classList.contains('selected'), 'a seleção continua');
    assert.equal(focus.state.atual && focus.state.atual.classList.contains('lut-card'), true, 'o foco vai para um cartão');
  } finally { focus.restore(); await h.cleanup(); }
});

test('nome de projeto com HTML nunca vira HTML', async () => {
  const evil = [{ id: 7, name: '<img src=x onerror=alert(1)>', client: '<b>cli</b>', status: 'Em produção', created_at: '2026-10-01 10:00:00' }];
  const h = await mount(TREE(), { listProjects: async () => evil });
  try {
    await openFromCardMenu(h, 'Solta.cube');
    assert.equal($$(h, '#projectPickerList img').length, 0);
    assert.equal($$(h, '#projectPickerList b').length, 0);
    assert.equal(projectRows(h).map(rowName)[0], '<img src=x onerror=alert(1)>');
  } finally { await h.cleanup(); }
});

// ─── Painel de detalhes ──────────────────────────────────────────────────────────────────────────

test('painel: "Usada em N projetos" com os nomes e o link de texto "Adicionar a um projeto…" (sem botão fixo novo no rodapé)', async () => {
  const asked = [];
  const h = await mount(TREE(), {
    parseLutCube: parseGood,
    lutsUsage: async (relPaths) => {
      asked.push(relPaths);
      return relPaths[0] === 'Solta.cube' ? [{ relPath: 'Solta.cube', hash: 'a'.repeat(64), projects: [{ id: 1, name: 'Casamento João' }, { id: 2, name: 'Evento Acme' }], remainingCopies: 0 }] : [];
    }
  });
  const focus = simulateFocus(h);
  try {
    assert.ok(hasClass($(h, '#btnInsAddProject'), 'hidden'), 'sem LUT escolhida não há link');
    click(h, card(h, 'Solta.cube'));
    await settle(30);
    assert.deepEqual(asked.at(-1), ['Solta.cube']);
    assert.ok(!hasClass($(h, '#insProjectsRow'), 'hidden'));
    assert.equal($(h, '#insProjects').textContent, 'Usada em 2 projetos');
    assert.equal($(h, '#insProjects').getAttribute('title'), 'Casamento João, Evento Acme');
    const link = $(h, '#btnInsAddProject');
    assert.ok(!hasClass(link, 'hidden'));
    assert.equal(link.textContent.trim(), 'Adicionar a um projeto…');
    assert.equal($$(h, '.inspector-footer button').length, 4, 'o rodapé do painel continua com os mesmos botões');

    click(h, card(h, 'z.cube'));
    await settle(30);
    assert.equal($(h, '#insProjects').textContent, 'Nenhum projeto');

    click(h, link);
    await settle(30);
    assert.ok(pickerOpen(h));
    assert.equal($(h, '#projectPickerWhat').textContent, '1 LUT: z');
    key(h, 'Escape');
    await settle(10);
    assert.equal(focus.state.atual, link, 'o foco volta ao link');
  } finally { focus.restore(); await h.cleanup(); }
});

test('painel: LUT inválida não oferece "Adicionar a um projeto…" (o main recusaria)', async () => {
  const h = await mount(TREE()); // a leitura simulada recusa todas as LUTs
  try {
    click(h, card(h, 'Solta.cube'));
    await settle(60);
    assert.ok(hasClass($(h, '#btnInsAddProject'), 'hidden'));
  } finally { await h.cleanup(); }
});

test('painel: depois de adicionar, "Usada em N projetos" é consultada de novo', async () => {
  let used = false;
  const h = await mount(TREE(), {
    lutsUsage: async (relPaths) => (used && relPaths[0] === 'Solta.cube' ? [{ relPath: 'Solta.cube', hash: 'a'.repeat(64), projects: [{ id: 1, name: 'Casamento João' }], remainingCopies: 0 }] : []),
    addProjectLuts: async () => { used = true; return { added: 1, already: 0, invalid: [], overLimit: 0 }; }
  });
  try {
    click(h, card(h, 'Solta.cube'));
    await settle(30);
    assert.equal($(h, '#insProjects').textContent, 'Nenhum projeto');
    click(h, $(h, '#btnInsAddProject'));
    await settle(30);
    choose(h, 1);
    click(h, confirmBtn(h));
    await settle(40);
    assert.equal($(h, '#insProjects').textContent, 'Usada em 1 projeto');
  } finally { await h.cleanup(); }
});

// ─── Módulo Projetos desligado ───────────────────────────────────────────────────────────────────

test('com o módulo Projetos desligado, "Adicionar a um projeto…" some do menu, da barra, da pasta e do painel', async () => {
  const h = await mount(TREE());
  try {
    h.window.bdsIsScreenAllowed = (s) => s !== 'projects';
    h.window.dispatchEvent(new h.window.CustomEvent('bds:modules-changed'));
    click(h, card(h, 'Solta.cube'));
    await settle(30);
    assert.ok(hasClass($(h, '#btnInsAddProject'), 'hidden'));
    assert.ok(hasClass($(h, '#insProjectsRow'), 'hidden'));
    click(h, card(h, 'a.cube'), { ctrlKey: true });
    await settle(10);
    assert.ok(!hasClass($(h, '#lutSelectionBar'), 'hidden'));
    assert.ok(hasClass($(h, '#btnSelAddProject'), 'hidden'));
    click(h, card(h, 'a.cube').querySelector('[data-action="menu"]'));
    await settle(10);
    assert.ok(hasClass($(h, '#lutCardMenu [data-action="add-project"]'), 'hidden'));
    key(h, 'Escape');
    const head = $$(h, '#lutsGrid .lut-group-head').find((x) => x.dataset.folder === 'Looks/Rush');
    click(h, head.querySelector('[data-action="group-menu"]'));
    await settle(10);
    assert.ok(hasClass($(h, '#lutGroupMenu [data-action="add-project-folder"]'), 'hidden'));
    key(h, 'Escape');

    // ligando de novo, tudo volta
    h.window.bdsIsScreenAllowed = () => true;
    h.window.dispatchEvent(new h.window.CustomEvent('bds:modules-changed'));
    assert.ok(!hasClass($(h, '#btnSelAddProject'), 'hidden'));
  } finally { delete h.window.bdsIsScreenAllowed; await h.cleanup(); } // o objeto window é compartilhado entre as montagens do harness
});

// ─── Aviso ao excluir ────────────────────────────────────────────────────────────────────────────

const projectId = (name) => [...name].reduce((n, c) => n * 31 + c.charCodeAt(0), 7) % 100000; // o mesmo nome, o mesmo projeto
const usedBy = (relPath, names, remainingCopies = 0) => ({ relPath, hash: relPath.length.toString(16).padStart(64, '0'), projects: names.map((name) => ({ id: projectId(name), name })), remainingCopies });

test('excluir uma LUT usada em projetos: o aviso entra na confirmação e o usuário decide', async () => {
  const deleted = [];
  const h = await mount(TREE(), {
    lutsUsage: async (relPaths) => (relPaths[0] === 'Solta.cube' ? [usedBy('Solta.cube', ['Casamento João', 'Evento X'])] : []),
    deleteLut: async (p) => { deleted.push(p); return true; }
  });
  try {
    click(h, card(h, 'Solta.cube'));
    await settle(30);
    click(h, $(h, '#btnDeleteLut'));
    await settle(30);
    assert.equal(h.dialogs.confirms.length, 1);
    assert.match(h.dialogs.confirms[0], /^Mover "Solta\.cube" para a lixeira\?\n\nEsta LUT é usada em 2 projetos \(Casamento João, Evento X\)\. Nos projetos ela aparecerá como LUT ausente\. Ela vai para a lixeira e pode ser recuperada\.$/);
    assert.equal(deleted.length, 1, 'não bloqueia: o usuário confirmou');

    // sem uso em projetos: a pergunta de sempre, sem aviso
    h.dialogs.confirms.length = 0;
    click(h, card(h, 'z.cube'));
    await settle(30);
    click(h, $(h, '#btnDeleteLut'));
    await settle(30);
    assert.equal(h.dialogs.confirms[0], 'Mover "z.cube" para a lixeira?');
  } finally { await h.cleanup(); }
});

test('excluir uma LUT usada que tem cópia idêntica FORA do conjunto: nenhum aviso', async () => {
  const h = await mount(TREE(), { lutsUsage: async () => [usedBy('Solta.cube', ['Casamento João'], 1)], deleteLut: async () => true });
  try {
    click(h, card(h, 'Solta.cube'));
    await settle(30);
    click(h, $(h, '#btnDeleteLut'));
    await settle(30);
    assert.equal(h.dialogs.confirms[0], 'Mover "Solta.cube" para a lixeira?');
  } finally { await h.cleanup(); }
});

test('excluir uma seleção: o aviso agrega as LUTs usadas e os projetos, calculado sobre o conjunto todo', async () => {
  const asked = [];
  const h = await mount(TREE(), {
    lutsUsage: async (relPaths, folders) => {
      asked.push([relPaths, folders]);
      return [usedBy('Looks/Rush/a.cube', ['A', 'B']), usedBy('Looks/Rush/b.cube', ['B', 'C', 'D']), usedBy('Outra/z.cube', ['E'], 2)];
    },
    deleteManyLuts: async () => ({ trashed: 3, missing: 0, failed: [] })
  });
  try {
    click(h, card(h, 'a.cube'));
    click(h, card(h, 'b.cube'), { ctrlKey: true });
    click(h, card(h, 'z.cube'), { ctrlKey: true });
    await settle(10);
    click(h, $(h, '#btnSelDelete'));
    await settle(40);
    const forDelete = asked.at(-1);
    assert.deepEqual([...forDelete[0]].sort(), ['Looks/Rush/a.cube', 'Looks/Rush/b.cube', 'Outra/z.cube'], 'a consulta leva o conjunto inteiro');
    assert.match(h.dialogs.confirms[0], /Mover 3 LUTs para a lixeira\?/);
    assert.match(h.dialogs.confirms[0], /2 LUTs desta seleção são usadas em 4 projetos \(A, B, C e mais 1\)\. Nos projetos elas aparecerão como LUT ausente\.$/, 'a z tem cópia fora do conjunto e não entra na conta');
  } finally { await h.cleanup(); }
});

test('excluir uma pasta: a consulta vai por pasta e o aviso fala "desta pasta"', async () => {
  const asked = [];
  const h = await mount(TREE(), {
    lutsUsage: async (relPaths, folders) => { asked.push([relPaths, folders]); return [usedBy('Looks/Rush/a.cube', ['Casamento João'])]; },
    deleteLutFolder: async (rel, dryRun) => (dryRun ? { luts: 2, others: 0 } : { trashed: 2, luts: 2, others: 0, remaining: 0, folderRemoved: true })
  });
  try {
    const head = $$(h, '#lutsGrid .lut-group-head').find((x) => x.dataset.folder === 'Looks/Rush');
    click(h, head.querySelector('[data-action="group-menu"]'));
    await settle(10);
    click(h, $(h, '#lutGroupMenu [data-action="delete-folder"]'));
    await settle(40);
    assert.deepEqual(asked.at(-1), [[], ['Looks/Rush']]);
    assert.match(h.dialogs.confirms[0], /Mover 2 LUTs da pasta "Looks \/ Rush" para a lixeira\?/);
    assert.match(h.dialogs.confirms[0], /1 LUT desta pasta é usada em 1 projeto \(Casamento João\)\. Nos projetos ela aparecerá como LUT ausente\. Elas ficam na lixeira e podem ser recuperadas\.$/);
  } finally { await h.cleanup(); }
});

test('a consulta de uso falha: a exclusão segue com a pergunta de sempre (nada é bloqueado)', async () => {
  const h = await mount(TREE(), { lutsUsage: async () => { throw new Error('indisponível'); }, deleteLut: async () => true });
  try {
    click(h, card(h, 'Solta.cube'));
    await settle(30);
    click(h, $(h, '#btnDeleteLut'));
    await settle(30);
    assert.equal(h.dialogs.confirms[0], 'Mover "Solta.cube" para a lixeira?');
  } finally { await h.cleanup(); }
});

test('nome de projeto com HTML no aviso de exclusão fica como texto', async () => {
  const h = await mount(TREE(), { lutsUsage: async () => [usedBy('Solta.cube', ['<img src=x onerror=alert(1)>'])], deleteLut: async () => true });
  try {
    click(h, card(h, 'Solta.cube'));
    await settle(30);
    click(h, $(h, '#btnDeleteLut'));
    await settle(30);
    assert.match(h.dialogs.confirms[0], /<img src=x onerror=alert\(1\)>/, 'o texto vai para o diálogo como está (o diálogo usa textContent)');
    assert.equal($$(h, 'img[src="x"]').length, 0);
  } finally { await h.cleanup(); }
});
