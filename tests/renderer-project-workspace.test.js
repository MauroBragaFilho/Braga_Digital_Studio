'use strict';

// Área interna do projeto (reescrita): cabeçalho, abas, Arquivos (estrutura, grade, seleção, inspetor),
// Áudio (fontes, sincronização multicâmera simulada, linha do tempo, ajuste manual) e Entrega (exportações).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const APP = pathToFileURL(path.join(__dirname, '..', 'renderer', 'app.js')).href;

const MEDIA = [
  { id: 1, pm_id: 11, bin_id: 10, filename: '00014.MTS', filepath: 'D:/Brutos/TV/00014.MTS', duration: 60, fps: 59.94, width: 1920, height: 1080, media_type: 'video', video_codec: 'h264', audio_codec: 'ac3', filesize: 2e9 },
  { id: 2, pm_id: 12, bin_id: 10, filename: '00015.MTS', filepath: 'D:/Brutos/TV/00015.MTS', duration: 60, fps: 59.94, width: 1920, height: 1080, media_type: 'video', video_codec: 'h264', audio_codec: 'ac3', filesize: 2e9 },
  { id: 3, pm_id: 13, bin_id: 20, filename: 'pc.mkv', filepath: 'D:/Brutos/PC/pc.mkv', duration: 100, fps: 30, width: 1920, height: 1080, media_type: 'video', video_codec: 'h264', audio_codec: 'aac', filesize: 1e9 },
  { id: 4, pm_id: 14, bin_id: null, filename: 'foto.jpg', filepath: 'D:/Brutos/foto.jpg', media_type: 'photo', filesize: 3e6 }
];
const BINS = [{ id: 10, name: 'Câmera da TV', parent_id: null }, { id: 20, name: 'Gravação do PC', parent_id: null }];
const SOURCES = [
  { id: 10, name: 'Câmera da TV', kind: 'video', has_audio: true, total_duration: 120, items: [{ media_id: 1, name: '00014.MTS', duration: 60, chain_pos: 0, kind: 'video', has_audio: true }, { media_id: 2, name: '00015.MTS', duration: 60, chain_pos: 60, kind: 'video', has_audio: true }] },
  { id: 20, name: 'Gravação do PC', kind: 'video', has_audio: true, total_duration: 100, items: [{ media_id: 3, name: 'pc.mkv', duration: 100, chain_pos: 0, kind: 'video', has_audio: true }] }
];
const MODEL = {
  group: { id: 77, name: 'Multicam teste', master_media_id: 1 }, start: 0, end: 130, duration: 130,
  lanes: [
    { id: 10, name: 'Câmera da TV', is_master: true, has_audio: true, clips: [{ media_id: 1, name: '00014.MTS', duration: 60, chain_pos: 0, kind: 'video', has_audio: true, offset: 0, confidence: 1, placed: true }, { media_id: 2, name: '00015.MTS', duration: 60, chain_pos: 60, kind: 'video', has_audio: true, offset: 60, confidence: 1, placed: true }] },
    { id: 20, name: 'Gravação do PC', is_master: false, has_audio: true, clips: [{ media_id: 3, name: 'pc.mkv', duration: 100, chain_pos: 0, kind: 'video', has_audio: true, offset: 30, confidence: 0.91, placed: true }] }
  ]
};

async function mountWorkspace(extra = {}) {
  const calls = [];
  let groups = [];
  // init: false — o app.js (estado compartilhado com o id do projeto aberto) só pode ser importado com o DOM montado
  const h = await mountScreen('project_workspace', {
    init: false,
    bds: {
      getProject: async () => ({ id: 1, name: 'Aula 02-10', client: 'LAC', type: 'Aula', status: 'Em produção', deadline: '2099-10-18', description: 'obs', color: '#3b82f6', cover_path: '' }),
      getProjectBins: async () => BINS,
      getProjectMedia: async () => MEDIA,
      getProjectSyncGroups: async () => groups,
      getMissingProjectMedia: async () => [],
      getProjectSummary: async () => ({ videos: 3, audios: 0, photos: 1, total_size: 5e9, missing: 0, transcripts: 1, devices: 2, delivery: { status: 'Em preparação', done: 1, items: 4, deadline: null }, last_activity_at: '2026-10-06 10:00:00', last_activity: { message: 'Projeto criado' } }),
      listProjectActivity: async () => [{ id: 1, kind: 'criado', message: 'Projeto criado', created_at: '2026-10-06 10:00:00' }],
      listProjectSyncSources: async () => SOURCES,
      runMulticamSync: async (payload) => { calls.push(['sync', payload]); groups = [{ id: 77, name: 'Multicam teste', master_media_id: 1, items: [] }]; return { groupId: 77, ...MODEL }; },
      getMulticamModel: async () => MODEL,
      setSyncClipOffset: async (g, m, s) => { calls.push(['offset', g, m, s]); return 1; },
      listProjectDevices: async () => [{ id: 1, category: 'camera', name: 'Sony A6300', note: '' }],
      getProjectDelivery: async () => ({ status: 'Em preparação', deadline: null, items: [{ label: 'Vídeo principal', done: true }, { label: 'Teaser', done: false }], destinations: [{ label: 'HD', checked: false }], notes: '', saved: true }),
      exportProjectXmeml: async (id, opts) => { calls.push(['xmeml', opts]); return { filePath: 'x.xml', videoTracks: 2, audioTracks: 4, clips: 3 }; },
      updateProject: async (id, data) => { calls.push(['update', data]); return true; },
      moveProjectMedia: async (pm, bin) => { calls.push(['move', pm, bin]); return true; },
      ...(typeof extra === 'function' ? extra(calls) : extra)
    }
  });
  const app = await import(APP);
  app.state.currentProjectId = 1;
  await h.mod.initScreen();
  await settle(80);
  return { h, calls };
}
const text = (h, sel) => (h.document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
const click = (h, sel) => h.document.querySelector(sel).dispatchEvent(new h.window.Event('click', { bubbles: true }));

test('área interna: cabeçalho, abas e Visão geral', async () => {
  const { h } = await mountWorkspace();
  try {
    const d = h.document;
    assert.equal(text(h, '#wsProjectName'), 'Aula 02-10');
    assert.match(text(h, '.ws-header-meta'), /LAC/);
    assert.equal(d.getElementById('wsProjectStatus').value, 'Em produção');
    assert.equal(d.getElementById('wsOvVideos').textContent, '3');
    assert.match(text(h, '#wsOvDeliveryText'), /Em preparação · 1\/4 itens/);
    assert.match(text(h, '#wsActivityList'), /Projeto criado/);
    assert.deepEqual([...d.querySelectorAll('.ws-proj-tab')].map((b) => b.dataset.projTab), ['overview', 'files', 'audio', 'delivery']);
    // próximos passos: material e pastas prontos? (há 1 arquivo sem pasta), sincronizar é o atual, entregar por último
    const steps = [...d.querySelectorAll('#wsSteps .ws-step')];
    assert.deepEqual(steps.map((li) => li.dataset.step), ['media', 'folders', 'sync', 'delivery']);
    assert.ok(steps[0].classList.contains('is-done'), 'material já adicionado');
    assert.ok(steps[1].classList.contains('is-current'), '1 arquivo sem pasta: separar por câmera é o próximo');
    assert.match(steps[1].textContent, /1 arquivo está sem pasta/);
    assert.match(text(h, '#wsDevicesGroups'), /Sony A6300/, 'equipamentos ficam na Visão geral');
    assert.equal(d.getElementById('wsOvSaveNotes'), null, 'observações salvam sozinhas (sem botão)');
  } finally { await h.cleanup(); }
});

test('Arquivos: estrutura com contagens, grade por pasta, seleção com barra de ações e inspetor', async () => {
  const { h, calls } = await mountWorkspace();
  try {
    const d = h.document;
    click(h, '.ws-proj-tab[data-proj-tab="files"]');
    await settle(40);
    const rows = [...d.querySelectorAll('.ws-tree-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    assert.match(rows[0], /Todos os arquivos.*4/);
    assert.ok(rows.some((r) => /Câmera da TV.*2/.test(r)) && rows.some((r) => /Gravação do PC.*1/.test(r)) && rows.some((r) => /Sem pasta.*1/.test(r)));
    assert.equal(d.querySelectorAll('.ws-media-card').length, 4);
    // abre a pasta da câmera: só os 2 clipes
    [...d.querySelectorAll('.ws-tree-row')].find((r) => /Câmera da TV/.test(r.textContent)).dispatchEvent(new h.window.Event('click', { bubbles: true }));
    assert.equal(d.querySelectorAll('.ws-media-card').length, 2);
    assert.equal(text(h, '#wsFilesTitle'), 'Câmera da TV');
    // seleciona um e vê a barra; clica no outro e vê o inspetor
    const first = d.querySelector('.ws-media-card');
    const cb = first.querySelector('input[type="checkbox"]');
    cb.checked = true; cb.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.equal(d.getElementById('wsSelectionBar').classList.contains('hidden'), false);
    assert.match(text(h, '#wsSelCount'), /1 selecionado/);
    d.querySelectorAll('.ws-media-card')[1].dispatchEvent(new h.window.Event('click', { bubbles: true }));
    assert.equal(d.getElementById('wsInspBody').classList.contains('hidden'), false);
    assert.equal(d.getElementById('wsInspName').value, '00015.MTS');
    assert.match(text(h, '#wsInspRows'), /1920×1080/);
    assert.equal(calls.filter((c) => c[0] === 'move').length, 0);
  } finally { await h.cleanup(); }
});

test('Áudio: fontes com a mestre sugerida, sincronizar monta a linha do tempo e o ajuste manual grava a posição', async () => {
  const { h, calls } = await mountWorkspace();
  try {
    const d = h.document;
    click(h, '.ws-proj-tab[data-proj-tab="audio"]');
    await settle(60);
    const sources = [...d.querySelectorAll('.ws-source')];
    assert.equal(sources.length, 2);
    assert.ok(sources[0].classList.contains('is-master'), 'a fonte com mais áudio vira mestre sugerida');
    assert.equal(d.getElementById('wsSyncRun').disabled, false);
    click(h, '#wsSyncRun');
    await settle(80);
    assert.deepEqual(calls.find((c) => c[0] === 'sync')[1], { projectId: 1, masterSourceId: 10 });
    const clips = [...d.querySelectorAll('.ws-tl-clip')];
    assert.equal(clips.length, 3);
    assert.ok(clips.some((c) => c.classList.contains('tone-master')) && clips.some((c) => c.classList.contains('tone-ok')));
    const pc = clips.find((c) => /pc\.mkv/.test(c.textContent));
    assert.ok(Math.abs(parseFloat(pc.style.left) - (30 / 130) * 100) < 0.5, `pc começa em 30 s (left=${pc.style.left})`);
    assert.equal(d.getElementById('wsSyncExport').disabled, false);
    // ajuste manual: o modal falso devolve o texto padrão (posição atual) — aqui simulamos uma posição nova
    h.window.bdsModal.prompt = async () => '31.5';
    pc.dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(60);
    assert.deepEqual(calls.find((c) => c[0] === 'offset'), ['offset', 77, 3, 31.5]);
    click(h, '#wsSyncExport');
    await settle(40);
    assert.deepEqual(calls.find((c) => c[0] === 'xmeml')[1], { mode: 'multicam', groupId: 77 });
  } finally { await h.cleanup(); }
});

test('Entrega: listas, progresso, salva sozinha e exportações (multicam só com sincronização)', async () => {
  const { h, calls } = await mountWorkspace();
  try {
    const d = h.document;
    click(h, '.ws-proj-tab[data-proj-tab="delivery"]');
    await settle(40);
    assert.equal(d.getElementById('wsDeliveryStatus').value, 'Em preparação');
    assert.equal(d.querySelectorAll('#wsDeliveryItems li').length, 2);
    assert.match(text(h, '#wsDeliveryProgressText'), /1 de 2/);
    assert.equal(d.getElementById('wsDeliverySave'), null, 'entrega salva sozinha (sem botão)');
    assert.equal(d.getElementById('wsExportMulticamXml').disabled, true, 'sem sincronização não exporta multicam');
    click(h, '#wsExportBinsXml');
    await settle(40);
    assert.deepEqual(calls.find((c) => c[0] === 'xmeml')[1], { mode: 'bins' });
  } finally { await h.cleanup(); }
});

test('cabeçalho: Editar detalhes salva e atualiza; Adicionar arquivos abre as opções em Arquivos; status mostra "Salvo"', async () => {
  const { h, calls } = await mountWorkspace();
  try {
    const d = h.document;
    click(h, '#wsBtnEditDetails');
    assert.equal(d.getElementById('wsEditModal').classList.contains('hidden'), false);
    assert.equal(d.getElementById('wsEditName').value, 'Aula 02-10');
    d.getElementById('wsEditName').value = 'Aula 03-10';
    d.getElementById('wsEditClient').value = 'LAC Concursos';
    click(h, '#wsEditSave');
    await settle(40);
    const upd = calls.filter((c) => c[0] === 'update').pop()[1];
    assert.equal(upd.name, 'Aula 03-10');
    assert.equal(upd.client, 'LAC Concursos');
    assert.equal(d.getElementById('wsEditModal').classList.contains('hidden'), true);
    assert.equal(text(h, '#wsProjectName'), 'Aula 03-10');
    assert.match(text(h, '#wsSaveState'), /Salvo/);

    click(h, '#wsBtnAddFiles');
    await settle(20);
    assert.equal(d.querySelector('[data-proj-panel="files"]').classList.contains('hidden'), false, 'foi para Arquivos');
    const items = [...d.querySelectorAll('#wsMenu button')].map((b) => b.textContent);
    assert.ok(items.some((t) => /Do computador/.test(t)) && items.some((t) => /Da Biblioteca/.test(t)));

    const status = d.getElementById('wsProjectStatus');
    status.value = 'Pós-produção';
    status.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle(30);
    assert.deepEqual(calls.filter((c) => c[0] === 'update').pop()[1], { status: 'Pós-produção' });
    assert.equal(status.dataset.status, 'Pós-produção');
  } finally { await h.cleanup(); }
});

test('Arquivos: "Selecionar todos" marca os arquivos da pasta aberta e Ctrl+A faz o mesmo', async () => {
  const { h } = await mountWorkspace();
  try {
    const d = h.document;
    click(h, '.ws-proj-tab[data-proj-tab="files"]');
    await settle(30);
    const all = d.getElementById('wsSelectAll');
    all.checked = true; all.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.equal(d.querySelectorAll('.ws-media-card.selected').length, 4);
    assert.match(text(h, '#wsSelCount'), /Todos os 4 selecionados/);
    all.checked = false; all.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.equal(d.querySelectorAll('.ws-media-card.selected').length, 0);
    assert.equal(d.getElementById('wsSelectionBar').classList.contains('hidden'), true);
    // só a pasta aberta: Câmera da TV (2 arquivos), por Ctrl+A
    [...d.querySelectorAll('.ws-tree-row')].find((r) => /Câmera da TV/.test(r.textContent)).dispatchEvent(new h.window.Event('click', { bubbles: true }));
    let prevented = false;
    h.mod.onKeyDown({ key: 'a', ctrlKey: true, target: d.body, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(d.querySelectorAll('.ws-media-card.selected').length, 2);
    assert.equal(d.getElementById('wsSelectAll').checked, true);
  } finally { await h.cleanup(); }
});

test('Importar: escolhe a pasta antes (do computador e da Biblioteca); "Nova pasta…" cria e usa a pasta', async () => {
  const { h, calls } = await mountWorkspace((calls) => ({
    importFilesToProjectBin: async (id, bin) => { calls.push(['importFiles', bin]); return { imported: 2, skipped: 0, failed: 0, total: 2 }; },
    searchLibrary: async () => [{ id: 50, filename: 'extra1.mp4', filesize: 10 }, { id: 51, filename: 'extra2.mp4', filesize: 10 }],
    addProjectMediaBulk: async (id, bin, ids) => { calls.push(['bulk', bin, ids]); return ids.length; },
    createProjectBin: async (id, parent, name) => { calls.push(['newBin', parent, name]); return 30; }
  }));
  try {
    const d = h.document;
    click(h, '.ws-proj-tab[data-proj-tab="files"]');
    await settle(30);
    // do computador: abre "Em qual pasta colocar?" com a pasta aberta sugerida
    [...d.querySelectorAll('.ws-tree-row')].find((r) => /Gravação do PC/.test(r.textContent)).dispatchEvent(new h.window.Event('click', { bubbles: true }));
    click(h, '#wsBtnAddMenu');
    [...d.querySelectorAll('#wsMenu button')].find((b) => /Do computador/.test(b.textContent)).dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(20);
    assert.equal(d.getElementById('wsPickBinModal').classList.contains('hidden'), false);
    const sel = d.getElementById('wsPickBinSelect');
    assert.equal(sel.value, '20', 'sugere a pasta aberta');
    assert.deepEqual([...sel.options].map((o) => o.textContent), ['Sem pasta', 'Câmera da TV', 'Gravação do PC', '+ Nova pasta…']);
    sel.value = '10';
    click(h, '#wsPickBinOk');
    await settle(40);
    assert.deepEqual(calls.find((c) => c[0] === 'importFiles'), ['importFiles', 10]);
    // cancelar não importa nada
    click(h, '#wsBtnAddMenu');
    [...d.querySelectorAll('#wsMenu button')].find((b) => /Do computador/.test(b.textContent)).dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(20);
    click(h, '#wsPickBinCancel');
    await settle(20);
    assert.equal(calls.filter((c) => c[0] === 'importFiles').length, 1);

    // da Biblioteca: selecionar todas + pasta nova
    click(h, '#wsBtnAddMenu');
    [...d.querySelectorAll('#wsMenu button')].find((b) => /Da Biblioteca/.test(b.textContent)).dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(30);
    const all = d.getElementById('wsImportSelectAll');
    all.checked = true; all.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.match(text(h, '#wsImportModalCount'), /2 selecionadas/);
    const dest = d.getElementById('wsImportModalBin');
    dest.value = '__nova';
    h.window.bdsModal.prompt = async () => 'Drone';
    click(h, '#wsBtnConfirmImportLibrary');
    await settle(60);
    assert.deepEqual(calls.find((c) => c[0] === 'newBin'), ['newBin', null, 'Drone']);
    assert.deepEqual(calls.find((c) => c[0] === 'bulk'), ['bulk', 30, [50, 51]]);
  } finally { await h.cleanup(); }
});
