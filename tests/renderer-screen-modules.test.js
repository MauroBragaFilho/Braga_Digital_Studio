'use strict';

// Telas como módulos, no renderer: a Home e as Configurações escondem o que pertence a um módulo desligado.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const MODULES = (enabled) => [
  ['download', ['download']], ['converter', ['converter']], ['library', ['library']], ['projects', ['projects', 'project_workspace']],
  ['upload', ['upload']], ['devices', ['devices']], ['luts', ['luts']], ['transcription', ['transcription']],
  ['metadata', ['metadata']], ['silence', ['silence']], ['ai', []]
].map(([id, screens]) => ({ id, title: id, description: '', screens, enabled: enabled.includes(id), hasEngine: false, available: true }));

const hidden = (el) => !el || el.classList.contains('hidden') || el.classList.contains('st-devhidden') || el.hidden === true || el.style.display === 'none';

test('Configurações: cartões e aba de módulos desligados somem; a tela inicial só oferece telas ligadas', async () => {
  let enabled = ['library', 'converter'];
  const h = await mountScreen('settings', {
    bds: { modulesList: async () => ({ ok: true, data: MODULES(enabled) }) }
  });
  try {
    await settle(80);
    const d = h.document;
    const card = (mod) => d.querySelector(`.st-card[data-module="${mod}"]`);
    assert.ok(card('download') && card('converter') && card('library') && card('projects'), 'os cartões existem no HTML');
    assert.equal(hidden(card('download')), true, 'Downloads desligado: cartão some');
    assert.equal(hidden(card('projects')), true, 'Projetos desligado: cartão some');
    assert.equal(hidden(card('converter')), false, 'Conversor ligado: cartão fica');
    assert.equal(hidden(card('library')), false, 'Biblioteca ligada: cartão fica');
    assert.equal(hidden(d.querySelector('.settings-tab[data-tab="settingsLutsView"]')), true, 'LUTs desligado: aba some');

    const select = d.getElementById('defaultStartScreenInput');
    const opt = (v) => [...select.options].find((o) => o.value === v);
    assert.equal(opt('home').disabled, false);
    assert.equal(opt('library').disabled, false);
    assert.equal(opt('download').disabled, true, 'tela de módulo desligado não pode ser inicial');

    // o usuário liga Downloads: a lista é relida e o cartão volta
    enabled = ['library', 'converter', 'download'];
    h.bds.emit('onModulesChanged', {});
    await settle(80);
    assert.equal(hidden(card('download')), false);
    assert.equal(opt('download').disabled, false);
  } finally { await h.cleanup(); }
});

test('Home: com a Biblioteca desligada some tudo que lê a Biblioteca; sem módulo nenhum, aparece a dica de Configurações → Módulos', async () => {
  const calls = [];
  const h = await mountScreen('home', {
    bds: {
      getLibraryStats: async () => { calls.push('stats'); return { totalMedia: 3, videosCount: 3, totalSizeBytes: 10 }; },
      getRecentMedia: async () => { calls.push('recent'); return []; }
    }
  });
  try {
    const d = h.document;
    // sem shell: não há abas no menu, ou seja, nenhum módulo de tela está ligado; Biblioteca desligada
    h.window.bdsIsScreenAllowed = (s) => s === 'home' || s === 'settings';
    h.window.dispatchEvent(new h.window.Event('bds:modules-changed'));
    await settle(30);
    assert.equal(hidden(d.querySelector('.stats-section')), true, 'estatísticas somem');
    assert.equal(hidden(d.querySelector('.recent-section')), true, 'gravações recentes somem');
    assert.equal(hidden(d.querySelector('.jobs-section')), true, 'últimos trabalhos somem');
    assert.equal(hidden(d.querySelector('.qa-card[data-action="search"]')), true, 'pesquisa some');
    assert.equal(hidden(d.getElementById('homeModulesHint')), false, 'dica aparece');
    assert.match(d.getElementById('homeModulesHint').textContent, /Configurações → Módulos/);

    // Biblioteca ligada de novo: seções voltam e a dica some
    h.window.bdsIsScreenAllowed = () => true;
    h.window.dispatchEvent(new h.window.Event('bds:modules-changed'));
    await settle(30);
    assert.equal(hidden(d.querySelector('.stats-section')), false);
    assert.equal(hidden(d.querySelector('.qa-card[data-action="search"]')), false);
    assert.equal(hidden(d.getElementById('homeModulesHint')), true);
  } finally { await h.cleanup(); }
});
