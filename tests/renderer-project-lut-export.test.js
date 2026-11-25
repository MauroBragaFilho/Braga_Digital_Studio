'use strict';

// Avisos de LUTs ao exportar e importar projetos (S5): textos de lutNotes.js, aviso depois de exportar XML e pacote
// (aba Entrega), "N LUTs (conforme o pacote)" no modal de importar e aviso das LUTs não restauradas. Harness: linkedom
// + window.bds simulado.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const APP = pathToFileURL(path.join(__dirname, '..', 'renderer', 'app.js')).href;
const NOTES = pathToFileURL(path.join(__dirname, '..', 'renderer', 'utils', 'lutNotes.js')).href;

const click = (h, el) => el.dispatchEvent(new h.window.Event('click', { bubbles: true }));
const $ = (h, sel) => h.document.querySelector(sel);

test('textos de lutNotes: pacote, XML e importação (sem LUTs, não acrescentam nada)', async () => {
  const notes = await import(NOTES);
  assert.equal(notes.bdsproLutsNote(null), '');
  assert.equal(notes.bdsproLutsNote(undefined), '');
  assert.equal(notes.bdsproLutsNote({ included: 2, warnings: [] }), '\n\n2 LUTs foram levadas dentro do pacote.');
  assert.equal(notes.bdsproLutsNote({ included: 1, warnings: [] }), '\n\n1 LUT foi levada dentro do pacote.');
  assert.match(notes.bdsproLutsNote({ included: 0, warnings: ['1 LUT não coube no pacote.'] }), /Nenhuma LUT foi levada dentro do pacote\.\n1 LUT não coube no pacote\./);

  assert.equal(notes.xmlLutsNote(null), '');
  const ok = notes.xmlLutsNote({ folder: 'D:\\Saída\\Filme - LUTs', copied: 2, existing: 0, missing: 0, changed: 0, failed: 0 });
  assert.match(ok, /LUTs do projeto copiadas para: D:\\Saída\\Filme - LUTs/);
  assert.match(ok, /No Premiere ou no DaVinci a LUT é aplicada por você; o XML não aplica LUT\./);
  assert.doesNotMatch(ok, /não está mais|alterada|não pôde/);
  const bad = notes.xmlLutsNote({ folder: null, copied: 0, existing: 0, missing: 2, changed: 1, failed: 1 });
  assert.match(bad, /As LUTs do projeto não foram copiadas\./);
  assert.match(bad, /2 LUTs não estão mais na coleção e não foi copiada\./);
  assert.match(bad, /1 LUT foi alterada depois de adicionada ao projeto/);
  assert.match(bad, /1 LUT não pôde ser copiada\./);

  assert.equal(notes.importLutsWarning({ success: true }), '');
  assert.equal(notes.importLutsWarning({ lutsWarnings: [] }), '');
  const many = notes.importLutsWarning({ lutsWarnings: Array.from({ length: 9 }, (_, i) => `aviso ${i + 1}`) });
  assert.match(many, /aviso 6\nE mais 3 avisos\./);
  assert.doesNotMatch(many, /aviso 7/);
  assert.match(many, /aparecem como LUT ausente/);
});

async function mountWorkspace(bds = {}) {
  const calls = [];
  const h = await mountScreen('project_workspace', {
    init: false,
    bds: {
      getProject: async () => ({ id: 1, name: 'Casamento', client: 'Ana', type: '', status: 'Em produção', deadline: null, description: '', color: '#3b82f6', cover_path: '' }),
      getProjectBins: async () => [],
      getProjectMedia: async () => [],
      getProjectSyncGroups: async () => [],
      getMissingProjectMedia: async () => [],
      getProjectSummary: async () => ({ videos: 0, audios: 0, photos: 0, total_size: 0, missing: 0, transcripts: 0, devices: 0, delivery: { status: 'Não iniciada', done: 0, items: 0, deadline: null }, last_activity_at: null, last_activity: null }),
      listProjectActivity: async () => [],
      listProjectDevices: async () => [],
      listProjectLuts: async () => [],
      getProjectDelivery: async () => ({ status: 'Não iniciada', deadline: null, items: [], destinations: [], notes: '', saved: false }),
      selectFolder: async () => 'D:\\Saída',
      ...bds(calls)
    }
  });
  const app = await import(APP);
  app.state.currentProjectId = 1;
  await h.mod.initScreen();
  await settle(60);
  click(h, $(h, '.ws-proj-tab[data-proj-tab="delivery"]'));
  await settle(30);
  return { h, calls };
}

test('Entrega: XML exportado mostra onde as LUTs foram copiadas e que o XML não aplica LUT; sem LUTs, o aviso de sempre', async () => {
  const luts = { folder: 'D:\\Saída\\Casamento - Pastas - LUTs', copied: 2, existing: 0, missing: 1, changed: 0, failed: 0 };
  const { h } = await mountWorkspace(() => ({ exportProjectXmeml: async () => ({ filePath: 'D:\\Saída\\Casamento - Pastas.xml', clips: 3, luts }) }));
  try {
    click(h, $(h, '#wsExportBinsXml'));
    await settle(40);
    const text = h.dialogs.alerts.at(-1);
    assert.match(text, /XML exportado\./);
    assert.match(text, /LUTs do projeto copiadas para: D:\\Saída\\Casamento - Pastas - LUTs/);
    assert.match(text, /1 LUT não está mais na coleção e não foi copiada\./);
    assert.match(text, /o XML não aplica LUT\./);
  } finally { await h.cleanup(); }

  const plain = await mountWorkspace(() => ({ exportProjectXmeml: async () => ({ filePath: 'D:\\Saída\\x.xml', clips: 3 }) }));
  try {
    click(plain.h, $(plain.h, '#wsExportBinsXml'));
    await settle(40);
    assert.doesNotMatch(plain.h.dialogs.alerts.at(-1), /LUT/);
  } finally { await plain.h.cleanup(); }
});

test('Entrega: pacote .bdspro exportado diz quantas LUTs foram dentro e o que ficou de fora', async () => {
  const withLuts = await mountWorkspace(() => ({
    exportBdspro: async () => ({ success: true, filePath: 'D:\\Saída\\Casamento.bdspro', luts: { included: 2, missing: 0, skipped: 1, bytes: 10, warnings: ['1 LUT não coube no pacote.'] } })
  }));
  try {
    click(withLuts.h, $(withLuts.h, '#wsExportBdspro'));
    await settle(40);
    assert.equal(withLuts.h.dialogs.alerts.at(-1), 'Pacote .bdspro exportado.\n\nD:\\Saída\\Casamento.bdspro\n\n2 LUTs foram levadas dentro do pacote.\n1 LUT não coube no pacote.');
  } finally { await withLuts.h.cleanup(); }

  const without = await mountWorkspace(() => ({ exportBdspro: async () => ({ success: true, filePath: 'D:\\Saída\\Casamento.bdspro' }) }));
  try {
    click(without.h, $(without.h, '#wsExportBdspro'));
    await settle(40);
    assert.equal(without.h.dialogs.alerts.at(-1), 'Pacote .bdspro exportado.\n\nD:\\Saída\\Casamento.bdspro', 'projeto sem LUTs: texto de antes');
  } finally { await without.h.cleanup(); }
});

const INSPECT = (luts) => ({
  valid: true, metadata: { name: 'Casamento' }, totalMedia: 0, missingMediaCount: 0, missingFiles: [], projectData: { media: [] }, ...(luts ? { luts } : {})
});

async function openImport(inspect, importResult) {
  const h = await mountScreen('projects', {
    bds: {
      selectFile: async () => 'C:\\pacotes\\a.bdspro',
      inspectBdspro: async () => inspect,
      importBdspro: async () => importResult
    }
  });
  await settle(30);
  click(h, h.document.getElementById('btnNewProjectMore'));
  await settle(10);
  click(h, [...h.document.querySelectorAll('#projMenu button')].find((b) => /Importar/.test(b.textContent)));
  await settle(40);
  return h;
}

test('Importar .bdspro: o modal mostra "N LUTs (conforme o pacote)" como texto, sem botão novo; sem LUTs a pílula some', async () => {
  const h = await openImport(INSPECT({ total: 3, bytes: 2000, declaredNew: 2, declaredExisting: 1, skipped: 1 }), { success: true, projectId: 9, projectName: 'Casamento' });
  try {
    const pill = h.document.getElementById('pillLuts');
    assert.equal(pill.classList.contains('hidden'), false);
    assert.equal(pill.textContent, '3 LUTs (conforme o pacote)');
    assert.match(pill.getAttribute('title'), /2 novas para a coleção e 1 já existe nela/);
    assert.match(pill.getAttribute('title'), /1 sem o arquivo no pacote/);
    assert.match(pill.getAttribute('title'), /Os arquivos são conferidos ao importar\./);
    assert.equal(pill.children.length, 0, 'só texto');
    assert.equal(h.document.querySelectorAll('#modalRelinkBdspro button').length, 4, 'fechar, localizar pasta, cancelar e confirmar: nenhum botão novo');
  } finally { await h.cleanup(); }

  const none = await openImport(INSPECT(null), { success: true, projectId: 9, projectName: 'Casamento' });
  try {
    assert.equal(none.document.getElementById('pillLuts').classList.contains('hidden'), true);
  } finally { await none.cleanup(); }

  const one = await openImport(INSPECT({ total: 1, bytes: 10, declaredNew: null, declaredExisting: null, skipped: 0 }), { success: true, projectId: 9, projectName: 'Casamento' });
  try {
    assert.equal(one.document.getElementById('pillLuts').textContent, '1 LUT (conforme o pacote)');
    assert.doesNotMatch(one.document.getElementById('pillLuts').getAttribute('title'), /novas/, 'sem a comparação com a coleção, só o aviso geral');
  } finally { await one.cleanup(); }
});

test('Importar .bdspro: LUTs que não puderam ser restauradas aparecem num aviso depois da importação', async () => {
  const h = await openImport(INSPECT({ total: 1, bytes: 10, declaredNew: 1, declaredExisting: 0, skipped: 0 }), {
    success: true, projectId: 9, projectName: 'Casamento', luts: { linked: 1, restored: 0, existing: 0, linkOnly: 0, failed: 1, warnings: [] },
    lutsWarnings: ['LUT "<b>Kodak</b>" não restaurada: o conteúdo não confere com o nome.']
  });
  try {
    click(h, h.document.getElementById('btnConfirmImportBdspro'));
    await settle(80);
    const text = h.dialogs.alerts.at(-1);
    assert.match(text, /^Projeto importado\. Algumas LUTs do pacote não foram restauradas:/);
    assert.match(text, /<b>Kodak<\/b>/, 'o texto vai como veio; o diálogo do app escapa o HTML ao mostrar (escapeHtml)');
    assert.match(text, /aparecem como LUT ausente/);
  } finally { await h.cleanup(); }

  const clean = await openImport(INSPECT(null), { success: true, projectId: 9, projectName: 'Casamento' });
  try {
    click(clean, clean.document.getElementById('btnConfirmImportBdspro'));
    await settle(80);
    assert.equal(clean.dialogs.alerts.some((a) => /LUT/.test(a)), false);
  } finally { await clean.cleanup(); }
});
