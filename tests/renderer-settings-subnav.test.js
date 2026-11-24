'use strict';

// Configurações: submenu (abas internas) em cada seção, com um só mecanismo.
//   - estrutura: itens e cartões de cada seção, como no agrupamento aprovado, e a marcação de abas acessível;
//   - comportamento: trocar de subpainel, lembrar o último, pedido vindo de fora (uma vez), item que some quando
//     os cartões somem, busca mostrando tudo e escondendo a barra, campo inválido que revela o subpainel.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'screens', 'settings.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'renderer', 'screens', 'settings.css'), 'utf8');
const { document: staticDoc } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

// Agrupamento aprovado: seção -> [[item do submenu, [títulos dos cartões]]]
const GROUPS = {
  settingsGeneralView: [
    ['Aparência', ['Aparência']],
    ['Início e janela', ['Inicialização e janela']],
    ['Menu lateral', ['Menu lateral e atalhos']]
  ],
  settingsNotificationsView: [
    ['Avisos do sistema', ['Avisos do sistema']],
    ['Prazos dos projetos', ['Prazos dos projetos']]
  ],
  settingsMediaView: [
    ['Desempenho', ['Aceleração de hardware (GPU)']],
    ['Downloads', ['Vídeo baixado', 'Lista de downloads', 'Conta do YouTube']],
    ['Conversor', ['Padrões do Conversor']],
    ['Envio para o YouTube', ['Envio automático para o YouTube']]
  ],
  settingsFoldersView: [
    ['Downloads e Conversor', ['Destino dos downloads', 'Saída do Conversor']],
    ['Biblioteca', ['Pastas da biblioteca', 'Pastas personalizadas']],
    ['Envio para o YouTube', ['Upload para YouTube']]
  ],
  settingsAiView: [
    ['Assistente', ['Assistente de IA']],
    ['Provedores', []],
    ['Neste computador', ['Modelo local (sem internet)']],
    ['Agentes externos', ['Conectar agentes (MCP)']]
  ],
  settingsUpdatesView: [
    ['Componentes', ['Componentes do BDS']],
    ['Aplicativo', ['Aplicativo (BDS)']]
  ],
  settingsSystemView: [
    ['Sobre e armazenamento', ['Sobre', 'Armazenamento']],
    ['Erros e suporte', ['Relatórios de erros', 'Diagnóstico e suporte']],
    ['Zona de perigo', ['Zona de perigo']]
  ],
  settingsAboutView: [
    ['Sobre', ['Braga Digital Studio']],
    ['Licenças', ['Licenças de código aberto']]
  ]
};
const NO_SUBMENU = ['settingsModulesView', 'settingsLutsView'];

const cardTitle = (card) => {
  const h = card.querySelector('.st-card-title');
  if (!h) return '';
  const icon = h.querySelector('.material-symbols-rounded');
  return h.textContent.replace(icon ? icon.textContent : '', '').trim();
};
const isHidden = (el) => !el || el.classList.contains('hidden');

// ------------------------------------------------------------------ estrutura (HTML)

test('cada seção com submenu tem os itens e os cartões do agrupamento aprovado, na ordem', () => {
  for (const [viewId, groups] of Object.entries(GROUPS)) {
    const view = staticDoc.getElementById(viewId);
    assert.ok(view, viewId);
    assert.ok(view.classList.contains('st-has-sub'), `${viewId} usa a coluna única do submenu`);
    const navs = view.querySelectorAll('.st-subnav');
    assert.equal(navs.length, 1, `${viewId}: um submenu`);
    const tabs = [...navs[0].querySelectorAll('.st-subtab')];
    assert.deepEqual(tabs.map((t) => t.textContent.trim()), groups.map(([label]) => label), `${viewId}: itens`);
    const panels = [...view.querySelectorAll('[data-sub-panel]')];
    assert.equal(panels.length, groups.length, `${viewId}: um painel por item`);
    groups.forEach(([label, titles], i) => {
      assert.deepEqual([...panels[i].querySelectorAll('.st-card')].map(cardTitle), titles, `${viewId} / ${label}: cartões`);
      assert.equal(tabs[i].dataset.sub, panels[i].dataset.subPanel, `${viewId} / ${label}: painel do item`);
    });
    // nenhum cartão fica solto fora dos subpainéis
    const loose = [...view.children].filter((c) => c.classList.contains('st-card'));
    assert.deepEqual(loose.map(cardTitle), [], `${viewId}: cartões fora dos subpainéis`);
  }
});

test('Módulos e LUTs não têm submenu e mantêm um cartão só', () => {
  for (const id of NO_SUBMENU) {
    const view = staticDoc.getElementById(id);
    assert.ok(view, id);
    assert.equal(view.querySelector('.st-subnav'), null, id);
    assert.equal(view.querySelector('[data-sub-panel]'), null, id);
    assert.equal(view.classList.contains('st-has-sub'), false, id);
    assert.equal(view.querySelectorAll('.st-card').length, 1, id);
  }
});

test('marcação de abas: tablist/tab/tabpanel, aria-selected, aria-controls e aria-labelledby coerentes; só o primeiro painel aparece', () => {
  for (const viewId of Object.keys(GROUPS)) {
    const view = staticDoc.getElementById(viewId);
    const nav = view.querySelector('.st-subnav');
    assert.equal(nav.getAttribute('role'), 'tablist', viewId);
    assert.ok(nav.getAttribute('aria-label'), `${viewId}: submenu com nome`);
    const tabs = [...nav.querySelectorAll('.st-subtab')];
    for (const [i, tab] of tabs.entries()) {
      assert.equal(tab.getAttribute('role'), 'tab');
      assert.equal(tab.getAttribute('type'), 'button');
      assert.equal(tab.getAttribute('aria-selected'), i === 0 ? 'true' : 'false');
      assert.equal(tab.classList.contains('active'), i === 0);
      const panel = staticDoc.getElementById(tab.getAttribute('aria-controls'));
      assert.ok(panel, `${viewId}: aria-controls de ${tab.dataset.sub}`);
      assert.equal(panel.getAttribute('role'), 'tabpanel');
      assert.equal(panel.dataset.subPanel, tab.dataset.sub);
      assert.equal(panel.getAttribute('aria-labelledby'), tab.id, `${viewId}: aria-labelledby de ${tab.dataset.sub}`);
      assert.equal(panel.classList.contains('hidden'), i !== 0, `${viewId}: só o primeiro painel começa à vista`);
    }
  }
});

test('os nomes antigos do submenu da IA saíram do HTML, do CSS e do script', () => {
  const js = fs.readFileSync(path.join(ROOT, 'renderer', 'screens', 'settings.js'), 'utf8');
  assert.doesNotMatch(html, /data-ai-sub|data-ai-panel/);
  assert.doesNotMatch(js, /data-ai-sub|data-ai-panel|aiSub\b|aiPanel\b|showAiSub|setupAiSubnav|applyPendingAiSub/);
  assert.doesNotMatch(css, /#settingsAiView\s*\{/, 'a coluna única vem da classe .st-has-sub');
  assert.match(css, /\.settings-view\.st-has-sub\s*\{[^}]*column-count:\s*1/);
});

test('CSS do submenu: só tokens, busca mostra todos os subpainéis e esconde a barra', () => {
  const from = css.indexOf('.st-subnav {');
  const block = css.slice(from, css.indexOf('.settings-layout {', from));
  assert.ok(block.length > 100);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, 'sem hex solto');
  assert.doesNotMatch(block, /font-weight:\s*(7|8|9)00|font-weight:\s*bold/);
  assert.match(css, /\.st-searching \.st-subnav\s*\{\s*display:\s*none/);
  assert.match(css, /\.st-searching \.st-subpanel\.hidden\s*\{\s*display:\s*flex\s*!important/);
  assert.match(css, /\.st-subtab:focus-visible/);
});

test('todos os subpainéis com cartão que monta depois marcam o ponto de montagem (data-lazy-host)', () => {
  assert.ok(staticDoc.querySelector('[data-sub-panel="providers"] #settingsAnalysisPanel[data-lazy-host]'));
  assert.ok(staticDoc.querySelector('[data-sub-panel="local"] #settingsTranscriptionPanel[data-lazy-host]'));
});

// ------------------------------------------------------------------ comportamento (tela montada)

const ALL = ['download', 'converter', 'library', 'projects', 'upload', 'devices', 'luts', 'transcription', 'metadata', 'silence', 'ai'];
const MODULES = (enabled) => ALL.map((id) => ({ id, title: id, description: '', screens: [id], enabled: enabled.includes(id), hasEngine: false, available: true }));

async function mountSettings({ enabled = ALL, bds = {} } = {}) {
  let on = enabled;
  const h = await mountScreen('settings', {
    bds: { modulesList: async () => ({ ok: true, data: MODULES(on) }), ...bds }
  });
  await settle(60);
  const d = h.document;
  const api = {
    h,
    d,
    // o app.js liga onModulesChanged só na primeira janela do processo: dispara o evento da janela direto
    setModules: async (list) => { on = list; h.window.dispatchEvent(new h.window.Event('bds:modules-changed')); await settle(60); },
    openTab: (viewId) => d.querySelector(`.settings-tab[data-tab="${viewId}"]`).click(),
    tab: (viewId, sub) => d.getElementById(viewId).querySelector(`.st-subtab[data-sub="${sub}"]`),
    panel: (viewId, sub) => d.getElementById(viewId).querySelector(`[data-sub-panel="${sub}"]`),
    clickSub: (viewId, sub) => api.tab(viewId, sub).click(),
    active: (viewId) => d.getElementById(viewId).querySelector('.st-subtab.active')?.dataset.sub,
    shown: (viewId) => [...d.getElementById(viewId).querySelectorAll('[data-sub-panel]')].filter((p) => !isHidden(p)).map((p) => p.dataset.subPanel),
    fire: (el, type, props = {}) => {
      const ev = new h.window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(ev, props);
      el.dispatchEvent(ev);
      return ev;
    }
  };
  return api;
}

test('clicar num item mostra só o subpainel dele e atualiza aria-selected', async () => {
  const s = await mountSettings();
  try {
    const v = 'settingsGeneralView';
    assert.equal(s.active(v), 'appearance');
    assert.deepEqual(s.shown(v), ['appearance']);
    s.clickSub(v, 'menu');
    assert.equal(s.active(v), 'menu');
    assert.deepEqual(s.shown(v), ['menu']);
    assert.equal(s.tab(v, 'menu').getAttribute('aria-selected'), 'true');
    assert.equal(s.tab(v, 'appearance').getAttribute('aria-selected'), 'false');
    // as outras seções não mudam
    assert.equal(s.active('settingsMediaView'), 'performance');
  } finally { await s.h.cleanup(); }
});

test('setas, Home e End percorrem os itens e ativam o painel', async () => {
  const s = await mountSettings();
  try {
    const v = 'settingsMediaView';
    s.openTab(v);
    const nav = s.d.getElementById(v).querySelector('.st-subnav');
    const focused = [];
    for (const t of nav.querySelectorAll('.st-subtab')) t.focus = () => focused.push(t.dataset.sub);
    const press = (sub, k) => s.fire(s.tab(v, sub), 'keydown', { key: k });
    press('performance', 'ArrowRight');
    assert.equal(s.active(v), 'downloads');
    press('downloads', 'End');
    assert.equal(s.active(v), 'upload');
    press('upload', 'ArrowRight'); // dá a volta
    assert.equal(s.active(v), 'performance');
    press('performance', 'ArrowLeft'); // dá a volta ao contrário
    assert.equal(s.active(v), 'upload');
    press('upload', 'Home');
    assert.equal(s.active(v), 'performance');
    assert.deepEqual(focused, ['downloads', 'upload', 'performance', 'upload', 'performance'], 'o foco acompanha o item ativo');
    press('performance', 'x'); // outras teclas não fazem nada
    assert.equal(s.active(v), 'performance');
    assert.ok(nav);
  } finally { await s.h.cleanup(); }
});

test('o último subpainel de cada seção é lembrado (localStorage "bdsSub:<seção>")', async () => {
  const s = await mountSettings();
  try {
    s.openTab('settingsNotificationsView');
    s.clickSub('settingsNotificationsView', 'deadlines');
    assert.equal(s.h.window.localStorage.getItem('bdsSub:settingsNotificationsView'), 'deadlines');
    s.openTab('settingsGeneralView');
    s.openTab('settingsNotificationsView');
    assert.equal(s.active('settingsNotificationsView'), 'deadlines', 'ao voltar, o mesmo subpainel');
    assert.deepEqual(s.shown('settingsNotificationsView'), ['deadlines']);

    // valor guardado antigo/desconhecido: cai no primeiro item visível
    s.h.window.localStorage.setItem('bdsSub:settingsSystemView', 'nao-existe');
    s.openTab('settingsSystemView');
    assert.equal(s.active('settingsSystemView'), 'about');
    s.h.window.localStorage.setItem('bdsSub:settingsSystemView', 'danger');
    s.openTab('settingsUpdatesView');
    s.openTab('settingsSystemView');
    assert.equal(s.active('settingsSystemView'), 'danger');
  } finally { await s.h.cleanup(); }
});

test('pedido de fora (bdsSubRequest) vale uma vez, só para a seção pedida, e não vira o "último usado"', async () => {
  const s = await mountSettings();
  try {
    const ss = s.h.window.sessionStorage;
    ss.setItem('bdsSubRequest', JSON.stringify({ view: 'settingsSystemView', sub: 'support' }));
    s.openTab('settingsMediaView'); // outra seção: o pedido continua guardado
    assert.ok(ss.getItem('bdsSubRequest'));
    assert.equal(s.active('settingsMediaView'), 'performance');
    s.openTab('settingsSystemView');
    assert.equal(s.active('settingsSystemView'), 'support');
    assert.equal(ss.getItem('bdsSubRequest'), null, 'lido uma vez');
    assert.equal(s.h.window.localStorage.getItem('bdsSub:settingsSystemView'), null, 'não é gravado como último usado');
    // reabrir a seção não repete o pedido
    s.openTab('settingsGeneralView');
    s.openTab('settingsSystemView');
    assert.equal(s.active('settingsSystemView'), 'about');
    // pedido com lixo é descartado sem erro
    ss.setItem('bdsSubRequest', '{não é json');
    s.openTab('settingsUpdatesView');
    assert.equal(ss.getItem('bdsSubRequest'), null);
    assert.equal(s.active('settingsUpdatesView'), 'components');
  } finally { await s.h.cleanup(); }
});

test('compatibilidade da IA: bdsAiSubRequest e o evento bds:ai-open-sub seguem valendo', async () => {
  const s = await mountSettings({ bds: { aiGetConfig: { ok: true, data: {} } } });
  try {
    const ss = s.h.window.sessionStorage;
    ss.setItem('bdsAiSubRequest', 'local');
    s.openTab('settingsAiView');
    await settle(40);
    assert.equal(s.active('settingsAiView'), 'local');
    assert.equal(ss.getItem('bdsAiSubRequest'), null, 'lido uma vez');
    s.h.window.dispatchEvent(new s.h.window.CustomEvent('bds:ai-open-sub', { detail: 'agents' }));
    assert.equal(s.active('settingsAiView'), 'agents');
    assert.deepEqual(s.shown('settingsAiView'), ['agents']);
    assert.equal(s.h.window.localStorage.getItem('bdsSub:settingsAiView'), 'agents');
    s.h.window.dispatchEvent(new s.h.window.CustomEvent('bds:ai-open-sub', { detail: 'inexistente' }));
    assert.equal(s.active('settingsAiView'), 'agents', 'pedido com id inexistente é ignorado: nada muda');
    assert.equal(s.h.window.localStorage.getItem('bdsSub:settingsAiView'), 'agents', 'e não sobrescreve o último usado');
  } finally { await s.h.cleanup(); }
});

test('evento genérico bds:settings-open-sub com {view, sub}', async () => {
  const s = await mountSettings();
  try {
    s.h.window.dispatchEvent(new s.h.window.CustomEvent('bds:settings-open-sub', { detail: { view: 'settingsFoldersView', sub: 'library' } }));
    assert.equal(s.active('settingsFoldersView'), 'library');
    assert.deepEqual(s.shown('settingsFoldersView'), ['library']);
    s.h.window.dispatchEvent(new s.h.window.CustomEvent('bds:settings-open-sub', { detail: { view: 'settingsModulesView', sub: 'x' } }));
    s.h.window.dispatchEvent(new s.h.window.CustomEvent('bds:settings-open-sub', { detail: null }));
    assert.equal(s.active('settingsFoldersView'), 'library');
  } finally { await s.h.cleanup(); }
});

test('item do submenu some quando todos os cartões do painel somem (módulo desligado) e volta ao religar', async () => {
  const s = await mountSettings({ enabled: ALL });
  try {
    const media = 'settingsMediaView';
    const folders = 'settingsFoldersView';
    for (const sub of ['performance', 'downloads', 'converter', 'upload']) assert.equal(isHidden(s.tab(media, sub)), false, sub);
    assert.equal(isHidden(s.tab(folders, 'upload')), true, 'o cartão de Upload para YouTube é oculto: o item não aparece');
    assert.equal(isHidden(s.tab(folders, 'downloads')), false);

    // fica em Downloads e desliga o módulo: o item some e o primeiro visível assume
    s.openTab(media);
    s.clickSub(media, 'downloads');
    assert.equal(s.active(media), 'downloads');
    await s.setModules(ALL.filter((m) => m !== 'download'));
    assert.equal(isHidden(s.tab(media, 'downloads')), true);
    assert.equal(s.active(media), 'performance', 'o item ativo sumiu: ativa o primeiro visível');
    assert.deepEqual(s.shown(media), ['performance']);
    assert.equal(isHidden(s.tab(folders, 'downloads')), false, 'Pastas: o painel ainda tem o cartão do Conversor');

    // sem Conversor e sem Downloads, o primeiro painel de Pastas some também
    await s.setModules(ALL.filter((m) => m !== 'download' && m !== 'converter'));
    assert.equal(isHidden(s.tab(folders, 'downloads')), true);
    assert.equal(isHidden(s.tab(media, 'converter')), true);
    s.openTab(folders);
    assert.equal(s.active(folders), 'library');

    // Envio desligado: some o item do Envio em Mídia
    await s.setModules(ALL.filter((m) => m !== 'upload'));
    assert.equal(isHidden(s.tab(media, 'upload')), true);

    // tudo de volta
    await s.setModules(ALL);
    assert.equal(isHidden(s.tab(media, 'downloads')), false);
    assert.equal(isHidden(s.tab(media, 'upload')), false);
    assert.equal(isHidden(s.tab(folders, 'downloads')), false);
  } finally { await s.h.cleanup(); }
});

test('IA: o item Assistente some com o módulo desligado e Provedores (montagem tardia) nunca some', async () => {
  const s = await mountSettings({ enabled: ['transcription'] });
  try {
    const v = 'settingsAiView';
    assert.equal(isHidden(s.tab(v, 'assistant')), true);
    assert.equal(isHidden(s.tab(v, 'providers')), false);
    assert.equal(isHidden(s.tab(v, 'local')), false);
    assert.equal(isHidden(s.tab(v, 'agents')), false);
    assert.equal(s.active(v), 'providers', 'sem o Assistente, o primeiro visível é Provedores');
    await s.setModules(['transcription', 'ai']);
    assert.equal(isHidden(s.tab(v, 'assistant')), false);
  } finally { await s.h.cleanup(); }
});

test('busca: todos os subpainéis entram, quem não casa some, e ao limpar o submenu volta como estava', async () => {
  const s = await mountSettings();
  try {
    const media = 'settingsMediaView';
    s.openTab(media);
    s.clickSub(media, 'downloads');
    const box = s.d.getElementById('settingsSearch');
    const container = s.d.querySelector('.settings-container');

    box.value = 'bitrate'; // só existe no painel Conversor (escondido)
    s.fire(box, 'input');
    assert.ok(container.classList.contains('st-searching'));
    assert.equal(isHidden(s.d.getElementById(media)), false, 'a seção com resultado aparece');
    const conv = s.panel(media, 'converter');
    const downloads = s.panel(media, 'downloads');
    assert.equal(conv.classList.contains('st-filtered'), false, 'o painel com resultado fica');
    assert.equal(downloads.classList.contains('st-filtered'), true, 'o painel sem resultado some inteiro');
    const hit = [...conv.querySelectorAll('.st-card .st-row')].filter((r) => !r.classList.contains('st-filtered'));
    assert.ok(hit.some((r) => /Bitrate de vídeo/.test(r.textContent)), 'a linha foi achada dentro de um subpainel escondido');
    assert.equal(s.active(media), 'downloads', 'o item ativo não muda durante a busca');

    // outra busca: acha em outro subpainel de outra seção
    box.value = 'Zona de perigo';
    s.fire(box, 'input');
    assert.equal(isHidden(s.d.getElementById('settingsSystemView')), false);
    assert.equal(s.panel('settingsSystemView', 'danger').classList.contains('st-filtered'), false);

    box.value = '';
    s.fire(box, 'input');
    assert.equal(container.classList.contains('st-searching'), false);
    assert.equal(s.panel(media, 'converter').classList.contains('st-filtered'), false);
    assert.equal(s.panel(media, 'downloads').classList.contains('st-filtered'), false);
    assert.equal(s.active(media), 'downloads', 'o submenu volta como estava');
    assert.deepEqual(s.shown(media), ['downloads']);
    assert.equal(isHidden(s.d.getElementById(media)), false);
    assert.equal(isHidden(s.d.getElementById('settingsSystemView')), true);
  } finally { await s.h.cleanup(); }
});

test('busca: o filtro por módulos desligados continua e a barra reaparece reavaliada ao limpar', async () => {
  const s = await mountSettings({ enabled: ALL.filter((m) => m !== 'download') });
  try {
    const media = 'settingsMediaView';
    const box = s.d.getElementById('settingsSearch');
    box.value = 'conta do youtube'; // cartão do módulo Downloads, desligado
    s.fire(box, 'input');
    assert.equal(s.panel(media, 'downloads').classList.contains('st-filtered'), true);
    box.value = '';
    s.fire(box, 'input');
    assert.equal(isHidden(s.tab(media, 'downloads')), true, 'o item continua escondido depois da busca');
  } finally { await s.h.cleanup(); }
});

test('campo inválido num subpainel escondido: salvar revela o subpainel (e a aba) antes de focar', async () => {
  const s = await mountSettings();
  try {
    const media = 'settingsMediaView';
    s.openTab(media);
    s.clickSub(media, 'performance');
    s.openTab('settingsGeneralView'); // a aba de Mídia fica escondida
    assert.equal(isHidden(s.d.getElementById(media)), true);
    s.h.window.Element.prototype.scrollIntoView = () => {}; // o linkedom não implementa
    let focusedEl = null;
    const limit = s.d.getElementById('converterDefaultVideoBitrateInput');
    limit.focus = () => { focusedEl = limit; }; // no painel "Conversor", dentro dos ajustes avançados
    assert.ok(limit.closest('[data-sub-panel="converter"]'));
    limit.value = '999';
    s.fire(limit, 'input');
    s.d.getElementById('saveSettingsButton').disabled = false;
    s.d.getElementById('saveSettingsButton').click();
    await settle(30);
    assert.equal(limit.getAttribute('aria-invalid'), 'true');
    assert.equal(isHidden(s.d.getElementById(media)), false, 'a aba foi aberta');
    assert.equal(s.active(media), 'converter', 'o item do campo inválido foi ativado');
    assert.deepEqual(s.shown(media), ['converter']);
    assert.equal(limit.closest('details').open, true, 'o bloco avançado abriu');
    assert.equal(focusedEl, limit, 'o foco foi para o campo');
    assert.equal((s.h.bds.calls.saveSettings || []).length, 0, 'nada foi salvo');
  } finally { await s.h.cleanup(); }
});

test('campos de painéis escondidos continuam valendo: a barra de alterações enxerga a mudança e o salvar lê o campo', async () => {
  const s = await mountSettings({ bds: { saveSettings: async (p) => p } });
  try {
    const bar = s.d.getElementById('settingsSaveBar');
    assert.equal(isHidden(bar), true);
    const sw = s.d.getElementById('notifyDeadlinesInput'); // painel "Prazos dos projetos", escondido
    assert.ok(sw.closest('[data-sub-panel="deadlines"]').classList.contains('hidden'));
    sw.checked = !sw.checked;
    s.fire(sw, 'change');
    assert.equal(isHidden(bar), false, 'a barra de alterações aparece');
    s.d.getElementById('saveSettingsButton').click();
    await settle(30);
    const sent = s.h.bds.calls.saveSettings?.at(-1)?.[0];
    assert.ok(sent, 'salvou');
    assert.equal(sent.notifyDeadlines, sw.checked);
    // desfazer à mão esconde a barra (o instantâneo cobre todos os campos)
    sw.checked = !sw.checked;
    s.fire(sw, 'change');
    assert.equal(isHidden(bar), false);
    sw.checked = !sw.checked;
    s.fire(sw, 'change');
    assert.equal(isHidden(bar), true);
  } finally { await s.h.cleanup(); }
});
