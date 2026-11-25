'use strict';

// Configurações > LUTs (S6): cartão "Coleção de LUTs" (caminho da pasta, "40 LUTs em 3 pastas; 2 avisos", ícone para abrir a
// pasta) e o submenu com Coleção e Pré-visualização.

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

test('estrutura: caminho somente leitura com o ícone de abrir pasta e nenhum outro botão', () => {
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
  assert.equal(card.querySelector('details.st-advanced'), null, 'sem ajustes avançados: não há LUTs padrão para restaurar');
  assert.deepEqual([...card.querySelectorAll('button')].map((b) => b.id), ['lutsFolderOpenBtn'], 'só um controle além do campo (sem "Importar de uma pasta")');
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
  } finally { await s.h.cleanup(); }
});

test('textos do resumo: uma LUT, sem pastas, vazio, avisos no singular', async () => {
  const cases = [
    [{ ...INFO, count: 1, groups: 1, problemCount: 1, problems: [] }, '1 LUT em 1 pasta; 1 aviso.'],
    [{ ...INFO, count: 12, groups: 0, problemCount: 0, problems: [] }, '12 LUTs.'],
    [{ ...INFO, count: 0, groups: 0, problemCount: 0, problems: [] }, 'Nenhuma LUT na pasta.'],
    [{ ...INFO, count: 5, groups: 2, problemCount: undefined, problems: [{ name: '', reason: 'Não foi possível ler a pasta de LUTs.' }] }, '5 LUTs em 2 pastas; 1 aviso.']
  ];
  for (const [info, expected] of cases) {
    const s = await mountSettings({ getLutsInfo: async () => info });
    try {
      await s.openLuts();
      assert.equal(s.$('lutsCollectionSummary').textContent, expected);
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
