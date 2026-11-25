'use strict';

// Configurações > LUTs (S6): cartão "Coleção de LUTs" (caminho da pasta, "40 LUTs em 3 pastas; 2 avisos", ícone para abrir a
// pasta, "Restaurar LUTs padrão" em "Ajustes avançados" com confirmação) e o submenu com Coleção e Pré-visualização.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { mountScreen, settle, SCREENS_DIR } = require('./helpers/renderer-harness');

const html = fs.readFileSync(path.join(SCREENS_DIR, 'settings.html'), 'utf8');
const { document: staticDoc } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

const INFO = { folder: 'C:\\Dados\\LUTs', count: 40, groups: 3, problems: [{ name: 'A/B/C/D/funda.cube', reason: 'Pasta funda demais.' }, { name: 'x.cube', reason: 'Não foi possível ler este arquivo.' }], problemCount: 2, bundledAvailable: true };
const ALL = ['download', 'converter', 'library', 'projects', 'upload', 'devices', 'luts', 'transcription', 'metadata', 'silence', 'ai'];
const MODULES = ALL.map((id) => ({ id, title: id, description: '', screens: [id], enabled: true, hasEngine: false, available: true }));

async function mountSettings(bds = {}) {
  const h = await mountScreen('settings', { bds: { modulesList: async () => ({ ok: true, data: MODULES }), getLutsInfo: async () => ({ ...INFO }), ...bds } });
  await settle(60);
  const d = h.document;
  const $ = (id) => d.getElementById(id);
  return {
    h, d, $,
    openLuts: async () => { d.querySelector('.settings-tab[data-tab="settingsLutsView"]').click(); await settle(30); },
    fire: (el, type, props = {}) => { const ev = new h.window.Event(type, { bubbles: true, cancelable: true }); Object.assign(ev, props); el.dispatchEvent(ev); return ev; }
  };
}

// ─── HTML ────────────────────────────────────────────────────────────────────────────────────────

test('estrutura: caminho somente leitura com o ícone de abrir pasta; "Restaurar LUTs padrão" só dentro de "Ajustes avançados" recolhido', () => {
  const card = staticDoc.getElementById('settingsLutsCollectionCard');
  assert.ok(card);
  const input = card.querySelector('#lutsFolderInput');
  const open = card.querySelector('#lutsFolderOpenBtn');
  assert.ok(input.hasAttribute('readonly'));
  assert.equal(input.parentElement.classList.contains('st-path-field'), true, 'componente de campo de caminho');
  assert.equal(open.parentElement, input.parentElement);
  assert.equal(open.getAttribute('aria-label'), 'Abrir a pasta das LUTs');
  assert.equal(open.getAttribute('title'), 'Abrir a pasta das LUTs');
  assert.equal(open.querySelector('.material-symbols-rounded').getAttribute('aria-hidden'), 'true');
  const advanced = card.querySelector('details.st-advanced');
  assert.ok(advanced && !advanced.hasAttribute('open'), 'recolhido');
  assert.ok(advanced.querySelector('#lutsRestoreBtn'), 'o botão de restaurar mora no bloco avançado');
  const outside = [...card.querySelectorAll('button')].filter((b) => !b.closest('details'));
  assert.deepEqual(outside.map((b) => b.id), ['lutsFolderOpenBtn'], 'em repouso só há um controle visível além do campo (sem "Importar de uma pasta")');
  assert.doesNotMatch(card.textContent, /Importar de uma pasta/);
  assert.equal(card.querySelector('#lutsCollectionSummary').getAttribute('aria-live'), 'polite');
  assert.equal(card.querySelector('#lutsCollectionStatus').getAttribute('aria-live'), 'polite');
});

test('submenu das LUTs: Coleção e Pré-visualização, cada um com o seu cartão; sem nomes de motores nem emojis', () => {
  const view = staticDoc.getElementById('settingsLutsView');
  assert.ok(view.classList.contains('st-has-sub'));
  assert.deepEqual([...view.querySelectorAll('.st-subtab')].map((t) => t.textContent.trim()), ['Coleção', 'Pré-visualização']);
  const text = view.textContent;
  assert.doesNotMatch(text, /[\u2600-\u27bf]|\ufe0f|\ud83c|\ud83d|\ud83e/);
  assert.doesNotMatch(text, /sha-?256|sqlite|manifest|electron|ffmpeg/i);
});

// ─── comportamento ───────────────────────────────────────────────────────────────────────────────

test('abrir a seção LUTs mostra a pasta, "40 LUTs em 3 pastas; 2 avisos." e os avisos com o motivo', async () => {
  const s = await mountSettings();
  try {
    await s.openLuts();
    assert.equal(s.$('lutsFolderInput').value, 'C:\\Dados\\LUTs');
    assert.equal(s.$('lutsFolderInput').getAttribute('title'), 'C:\\Dados\\LUTs');
    assert.equal(s.$('lutsCollectionSummary').textContent, '40 LUTs em 3 pastas; 2 avisos.');
    const problems = s.$('lutsCollectionProblems');
    assert.equal(problems.hidden, false);
    assert.match(problems.textContent, /^Atenção: A\/B\/C\/D\/funda\.cube \(Pasta funda demais\.\); x\.cube \(Não foi possível ler este arquivo\.\)\.$/);
    assert.equal(s.$('lutsCollectionAdvanced').hidden, false);
    assert.equal(s.$('lutsCollectionAdvanced').hasAttribute('open'), false, 'continua recolhido');
  } finally { await s.h.cleanup(); }
});

test('textos do resumo: uma LUT, sem pastas, vazio, avisos no singular', async () => {
  const cases = [
    [{ ...INFO, count: 1, groups: 1, problemCount: 1, problems: [] }, '1 LUT em 1 pasta; 1 aviso.'],
    [{ ...INFO, count: 12, groups: 0, problemCount: 0, problems: [] }, '12 LUTs.'],
    [{ ...INFO, count: 0, groups: 0, problemCount: 0, problems: [], bundledAvailable: false }, 'Nenhuma LUT na pasta.'],
    [{ ...INFO, count: 5, groups: 2, problemCount: undefined, problems: [{ name: '', reason: 'Não foi possível ler a pasta de LUTs.' }] }, '5 LUTs em 2 pastas; 1 aviso.']
  ];
  for (const [info, expected] of cases) {
    const s = await mountSettings({ getLutsInfo: async () => info });
    try {
      await s.openLuts();
      assert.equal(s.$('lutsCollectionSummary').textContent, expected);
      assert.equal(s.$('lutsCollectionAdvanced').hidden, !info.bundledAvailable, 'sem LUTs padrão na instalação, não há o que restaurar');
    } finally { await s.h.cleanup(); }
  }
});

test('sem avisos o campo de avisos fica escondido; falha ao ler a pasta mostra a mensagem em português', async () => {
  const ok = await mountSettings({ getLutsInfo: async () => ({ ...INFO, problems: [], problemCount: 0 }) });
  try {
    await ok.openLuts();
    assert.equal(ok.$('lutsCollectionProblems').hidden, true);
  } finally { await ok.h.cleanup(); }
  const bad = await mountSettings({ getLutsInfo: async () => { throw new Error('Não foi possível ler a pasta de LUTs.'); } });
  try {
    await bad.openLuts();
    assert.equal(bad.$('lutsCollectionSummary').textContent, 'Não foi possível ler a pasta de LUTs.');
  } finally { await bad.h.cleanup(); }
});

test('voltar para a subseção Coleção lê de novo (o que está no disco agora); a Pré-visualização não lê', async () => {
  let calls = 0;
  const s = await mountSettings({ getLutsInfo: async () => { calls++; return { ...INFO, count: 40 + calls }; } });
  try {
    await s.openLuts();
    const first = calls;
    assert.ok(first >= 1);
    s.d.getElementById('settingsLutsView').querySelector('.st-subtab[data-sub="preview"]').click();
    await settle(20);
    assert.equal(calls, first, 'a outra subseção não relê');
    s.d.getElementById('settingsLutsView').querySelector('.st-subtab[data-sub="collection"]').click();
    await settle(30);
    assert.equal(calls, first + 1);
    assert.match(s.$('lutsCollectionSummary').textContent, new RegExp(`^${40 + calls} LUTs`));
  } finally { await s.h.cleanup(); }
});

test('o ícone, o clique e o Enter no campo abrem a pasta das LUTs (o Enter não salva as Configurações); erro em português', async () => {
  const s = await mountSettings();
  try {
    await s.openLuts();
    const base = (s.h.bds.calls.openLutsFolder || []).length;
    s.$('lutsFolderOpenBtn').click();
    await settle(20);
    s.$('lutsFolderInput').click();
    await settle(20);
    const enter = s.fire(s.$('lutsFolderInput'), 'keydown', { key: 'Enter' });
    await settle(20);
    assert.equal((s.h.bds.calls.openLutsFolder || []).length, base + 3);
    assert.equal(enter.defaultPrevented, true);
    assert.equal(s.h.bds.calls.saveSettings, undefined);
  } finally { await s.h.cleanup(); }
  const bad = await mountSettings({ openLutsFolder: async () => { throw new Error('Não foi possível abrir a pasta das LUTs.'); } });
  try {
    await bad.openLuts();
    bad.$('lutsFolderOpenBtn').click();
    await settle(20);
    assert.equal(bad.$('lutsCollectionStatus').textContent, 'Não foi possível abrir a pasta das LUTs.');
  } finally { await bad.h.cleanup(); }
});

test('abrir a pasta e mexer no campo de caminho não deixam a tela "alterada" (o campo não é uma configuração)', async () => {
  const s = await mountSettings();
  try {
    await s.openLuts();
    s.fire(s.$('lutsFolderInput'), 'input');
    s.fire(s.$('lutsFolderInput'), 'change');
    await settle(20);
    assert.equal(s.$('settingsSaveBar').classList.contains('hidden'), true);
  } finally { await s.h.cleanup(); }
});

test('Restaurar LUTs padrão: pergunta antes, restaura, mostra o resultado e relê a pasta', async () => {
  let infoCalls = 0;
  const s = await mountSettings({
    getLutsInfo: async () => { infoCalls++; return { ...INFO, count: infoCalls === 1 ? 38 : 40 }; },
    restoreBundledLuts: async () => ({ restored: 2, alreadyThere: 38, failed: 0, missingSource: false })
  });
  try {
    await s.openLuts();
    assert.match(s.$('lutsCollectionSummary').textContent, /^38 LUTs/);
    s.$('lutsRestoreBtn').click();
    await settle(40);
    assert.equal(s.h.dialogs.confirms.length, 1);
    assert.match(s.h.dialogs.confirms[0], /Nada é apagado nem substituído/);
    assert.equal((s.h.bds.calls.restoreBundledLuts || []).length, 1);
    assert.equal(s.$('lutsCollectionStatus').textContent, '2 LUTs padrão restauradas.');
    assert.match(s.$('lutsCollectionSummary').textContent, /^40 LUTs/);
    assert.equal(s.$('lutsRestoreBtn').hasAttribute('aria-disabled'), false);
  } finally { await s.h.cleanup(); }
});

test('Restaurar LUTs padrão: sem confirmação não faz nada; nada a restaurar, uma só e falhas têm texto próprio', async () => {
  const outcomes = [
    [{ restored: 0, alreadyThere: 40, failed: 0, missingSource: false }, 'Todas as LUTs padrão já estão na pasta.'],
    [{ restored: 1, alreadyThere: 39, failed: 0, missingSource: false }, '1 LUT padrão restaurada.'],
    [{ restored: 1, alreadyThere: 37, failed: 2, missingSource: false }, '1 LUT padrão restaurada. 2 LUTs não puderam ser copiadas.']
  ];
  for (const [result, expected] of outcomes) {
    const s = await mountSettings({ restoreBundledLuts: async () => result });
    try {
      await s.openLuts();
      s.$('lutsRestoreBtn').click();
      await settle(40);
      assert.equal(s.$('lutsCollectionStatus').textContent, expected);
    } finally { await s.h.cleanup(); }
  }
  const no = await mountSettings();
  try {
    await no.openLuts();
    no.h.window.bdsModal.confirm = async () => false;
    no.$('lutsRestoreBtn').click();
    await settle(40);
    assert.equal(no.h.bds.calls.restoreBundledLuts, undefined, 'sem confirmar, nada é restaurado');
    assert.equal(no.$('lutsCollectionStatus').textContent, '');
  } finally { await no.h.cleanup(); }
  const boom = await mountSettings({ restoreBundledLuts: async () => { throw new Error('As LUTs padrão não foram encontradas nesta instalação.'); } });
  try {
    await boom.openLuts();
    boom.$('lutsRestoreBtn').click();
    await settle(40);
    assert.equal(boom.$('lutsCollectionStatus').textContent, 'As LUTs padrão não foram encontradas nesta instalação.');
    assert.equal(boom.$('lutsRestoreBtn').hasAttribute('aria-disabled'), false, 'o botão volta a funcionar');
  } finally { await boom.h.cleanup(); }
});

test('Restaurar LUTs padrão: clique duplo não abre duas perguntas nem restaura duas vezes', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const s = await mountSettings({ restoreBundledLuts: async () => { await slow; return { restored: 1, alreadyThere: 0, failed: 0, missingSource: false }; } });
  try {
    await s.openLuts();
    s.$('lutsRestoreBtn').click();
    s.$('lutsRestoreBtn').click();
    await settle(30);
    assert.equal(s.h.dialogs.confirms.length, 1);
    assert.equal(s.$('lutsRestoreBtn').getAttribute('aria-disabled'), 'true', 'ocupado, sem perder o foco do botão');
    release();
    await settle(40);
    assert.equal((s.h.bds.calls.restoreBundledLuts || []).length, 1);
  } finally { await s.h.cleanup(); }
});
