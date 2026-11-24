'use strict';

// Configurações > Atualizações (aplicativo e componentes no mesmo cartão) e Licenças.
//   - o subpainel "Aplicativo" foi fundido: um cartão só, sem submenu, duas linhas de estado, uma barra de progresso e
//     as notas da versão no estado "há atualização";
//   - um único botão muda de papel (Verificar atualizações, Baixar e atualizar, Reiniciar para instalar), sem "Mais tarde";
//   - Licenças: "Página do projeto" e "Código-fonte" são links (<a href>) que abrem no navegador padrão e nunca navegam a janela.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseHTML } = require('linkedom');
const { mountScreen, settle, SCREENS_DIR } = require('./helpers/renderer-harness');

const html = fs.readFileSync(path.join(SCREENS_DIR, 'settings.html'), 'utf8');
const css = fs.readFileSync(path.join(SCREENS_DIR, 'settings.css'), 'utf8');
const js = fs.readFileSync(path.join(SCREENS_DIR, 'settings.js'), 'utf8');
const { document: staticDoc } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

// ------------------------------------------------------------------ estrutura (HTML)

test('Atualizações: um cartão só, sem submenu, com duas linhas de estado e um único botão', () => {
  const view = staticDoc.getElementById('settingsUpdatesView');
  assert.ok(view);
  assert.equal(view.querySelector('.st-subnav'), null, 'sem submenu');
  assert.equal(view.querySelector('[data-sub-panel]'), null);
  assert.equal(view.classList.contains('st-has-sub'), false);
  assert.equal(view.querySelectorAll('.st-card').length, 1, 'um cartão só');

  // ids do botão antigo, do botão do subpainel Aplicativo e da barra de progresso própria dele saíram
  for (const id of ['checkUpdatesButton', 'updateNowButton', 'updateLaterButton', 'checkAppUpdateButton', 'appUpdateZone',
    'appUpdateProgress', 'appUpdateProgressFill', 'appUpdateProgressStep', 'appUpdateProgressPercent']) {
    assert.equal(staticDoc.getElementById(id), null, id);
  }
  assert.doesNotMatch(view.textContent, /Mais tarde/);

  const buttons = [...view.querySelectorAll('button')];
  assert.deepEqual(buttons.map((b) => b.id), ['updateActionButton'], 'um botão só em toda a seção');
  const btn = buttons[0];
  assert.equal(btn.getAttribute('type'), 'button');
  assert.equal(btn.dataset.role, 'check');
  assert.equal(staticDoc.getElementById('updateActionLabel').textContent.trim(), 'Verificar atualizações');
  assert.equal(staticDoc.getElementById('updateActionIcon').getAttribute('aria-hidden'), 'true');
  // o rótulo muda com o estado: a região avisa o leitor de tela
  const bar = staticDoc.getElementById('updateActionsBar');
  assert.equal(bar.getAttribute('aria-live'), 'polite');
  assert.ok(bar.contains(btn));

  // as duas linhas de estado, as notas (escondidas) e uma só barra de progresso
  assert.ok(staticDoc.getElementById('appUpdateStatusText'));
  assert.ok(staticDoc.getElementById('componentsUpdateStatusText'));
  const notes = staticDoc.getElementById('updateReleaseNotes');
  assert.ok(notes.classList.contains('hidden'), 'notas escondidas fora do estado "há atualização"');
  assert.equal(staticDoc.getElementById('updateReleaseNotesText').getAttribute('aria-labelledby'), 'updateReleaseNotesTitle');
  assert.equal(view.querySelectorAll('.settings-update-progress-container').length, 1);
  // o que já morava no cartão continua
  assert.ok(staticDoc.getElementById('checkUpdatesOnStartInput'));
  assert.ok(staticDoc.getElementById('updateServerUrlInput').closest('details.st-advanced'));
  assert.ok(staticDoc.getElementById('updateLastCheck'));
});

test('Atualizações: CSS novo só com tokens e sem o bloco do subpainel Aplicativo', () => {
  assert.doesNotMatch(css, /settings-app-update-progress/);
  for (const sel of ['.settings-update-lines', '.settings-update-notes {', '.settings-update-notes-text', '.settings-update-actions-bar button[aria-disabled="true"]', '.st-license-link']) {
    assert.ok(css.includes(sel), sel);
  }
  const from = css.indexOf('/* Duas linhas de estado');
  const block = css.slice(from, css.indexOf('/* --- SISTEMA --- */', from));
  assert.ok(block.length > 300);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, 'sem hex solto');
  assert.doesNotMatch(block, /font-weight:\s*(7|8|9)00|font-weight:\s*bold/);
  assert.match(css, /\.st-license-link:focus-visible\s*\{[^}]*outline/);
});

// ------------------------------------------------------------------ comportamento (tela montada)

const ALL = ['download', 'converter', 'library', 'projects', 'upload', 'devices', 'luts', 'transcription', 'metadata', 'silence', 'ai'];
const MODULES = ALL.map((id) => ({ id, title: id, description: '', screens: [id], enabled: true, hasEngine: false, available: true }));
const APP_URL = pathToFileURL(path.join(SCREENS_DIR, '..', 'app.js')).href;

async function mountSettings({ bds = {}, pending = null } = {}) {
  const h = await mountScreen('settings', {
    init: false,
    bds: { modulesList: async () => ({ ok: true, data: MODULES }), ...bds }
  });
  if (pending) {
    const app = await import(APP_URL); // a mesma instância que a tela importa
    app.state.pendingUpdateCheck = pending;
  }
  await h.mod.initScreen();
  await settle(60);
  const d = h.document;
  const $ = (id) => d.getElementById(id);
  return {
    h,
    $,
    btn: () => $('updateActionButton'),
    role: () => $('updateActionButton').dataset.role,
    label: () => $('updateActionLabel').textContent.trim(),
    headline: () => $('updateHeadline').textContent.trim(),
    notesVisible: () => !$('updateReleaseNotes').classList.contains('hidden'),
    click: async (ms = 40) => { $('updateActionButton').click(); await settle(ms); },
    setConfirm: (fn) => { h.window.bdsModal.confirm = fn; }
  };
}

const APP_NEW = { hasUpdate: true, currentVersion: '1.0.0', latestVersion: '1.1.0', releaseUrl: 'https://example.com/release', releaseNotes: '<b>Novo</b>\n- item um\n- item dois' };
const CHECK_NEW = { hasUpdates: true, app: APP_NEW, dependencies: { components: [{ title: 'Conversor de mídia', needsUpdate: true }, { title: 'Pronto', needsUpdate: false }] } };
const CHECK_OK = { hasUpdates: false, app: { hasUpdate: false, currentVersion: '1.0.0' }, dependencies: { components: [{ title: 'Pronto', needsUpdate: false }] } };

test('verificar: o botão vira "Baixar e atualizar", as duas linhas e as notas da versão aparecem (texto puro)', async () => {
  const s = await mountSettings({ bds: { checkEverything: async () => CHECK_NEW } });
  try {
    assert.equal(s.role(), 'check');
    assert.equal(s.notesVisible(), false);
    await s.click();
    assert.equal(s.h.bds.calls.checkEverything.length, 1);
    assert.equal(s.role(), 'update');
    assert.equal(s.label(), 'Baixar e atualizar');
    assert.ok(s.btn().classList.contains('settings-btn-primary'));
    assert.equal(s.btn().hasAttribute('aria-disabled'), false);
    assert.equal(s.headline(), 'Existem atualizações disponíveis.');
    assert.match(s.$('appUpdateStatusText').textContent, /v1\.1\.0.*v1\.0\.0/);
    assert.equal(s.$('componentsUpdateStatusText').textContent, 'Há atualização para: Conversor de mídia.');
    // notas da versão: só no estado "há atualização", sempre como texto (nada de HTML do release)
    assert.equal(s.notesVisible(), true);
    assert.equal(s.$('updateReleaseNotesTitle').textContent, 'Novidades da v1.1.0');
    assert.equal(s.$('updateReleaseNotesText').textContent, '<b>Novo</b>\n- item um\n- item dois');
    assert.equal(s.$('updateReleaseNotesText').children.length, 0);
    assert.match(s.$('updateLastCheck').textContent, /há atualizações disponíveis/);
    assert.equal(s.h.errors.length, 0);
  } finally { await s.h.cleanup(); }
});

test('verificar: sem novidade o botão continua "Verificar atualizações" e as notas ficam escondidas', async () => {
  const s = await mountSettings({ bds: { checkEverything: async () => CHECK_OK } });
  try {
    await s.click();
    assert.equal(s.role(), 'check');
    assert.equal(s.label(), 'Verificar atualizações');
    assert.equal(s.headline(), 'Tudo está atualizado.');
    assert.equal(s.$('appUpdateStatusText').textContent, 'Você está na versão mais recente (v1.0.0).');
    assert.equal(s.$('componentsUpdateStatusText').textContent, 'Todos estão nas versões mais recentes.');
    assert.equal(s.notesVisible(), false);
  } finally { await s.h.cleanup(); }
});

test('verificar sem conexão: erro nas duas fontes e o botão continua verificando', async () => {
  const off = { hasUpdates: false, app: { checkFailed: true, currentVersion: '1.0.0' }, dependencies: { checkFailed: true, components: [] } };
  const s = await mountSettings({ bds: { checkEverything: async () => off } });
  try {
    await s.click();
    assert.equal(s.headline(), 'Não foi possível verificar atualizações.');
    assert.equal(s.role(), 'check');
    assert.match(s.$('appUpdateStatusText').textContent, /Não foi possível verificar/);
    assert.match(s.$('componentsUpdateStatusText').textContent, /Não foi possível verificar/);
    assert.equal(s.notesVisible(), false);
  } finally { await s.h.cleanup(); }
});

test('ocupado: aria-disabled (o foco não se perde), rótulo "Verificando…" e o clique repetido não faz nada', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await mountSettings({ bds: { checkEverything: async () => { await gate; return CHECK_OK; } } });
  try {
    s.btn().click();
    await settle(20);
    assert.equal(s.btn().getAttribute('aria-disabled'), 'true');
    assert.equal(s.btn().getAttribute('aria-busy'), 'true');
    assert.equal(s.btn().hasAttribute('disabled'), false, 'disabled tira o foco do botão');
    assert.equal(s.label(), 'Verificando…');
    s.btn().click();
    s.btn().click();
    await settle(20);
    assert.equal(s.h.bds.calls.checkEverything.length, 1, 'verificação já em andamento');
    release();
    await settle(40);
    assert.equal(s.btn().hasAttribute('aria-disabled'), false);
    assert.equal(s.btn().hasAttribute('aria-busy'), false);
    assert.equal(s.label(), 'Verificar atualizações');
  } finally { await s.h.cleanup(); }
});

test('resultado da checagem ao abrir o BDS: mesmo cartão (linhas e notas), sem nova consulta', async () => {
  const s = await mountSettings({ pending: CHECK_NEW });
  try {
    assert.equal(s.h.bds.calls.checkEverything, undefined, 'reaproveita o resultado da inicialização');
    assert.equal(s.role(), 'update');
    assert.equal(s.label(), 'Baixar e atualizar');
    assert.equal(s.notesVisible(), true);
    assert.match(s.$('appUpdateStatusText').textContent, /v1\.1\.0/);
    assert.equal(s.$('componentsUpdateStatusText').textContent, 'Há atualização para: Conversor de mídia.');
  } finally { await s.h.cleanup(); }
});

test('baixar e atualizar: nova versão pronta, adiar vira "Reiniciar para instalar" e o botão instala depois (com o aviso do Windows)', async () => {
  const app = { readyToInstall: true, digestVerified: true, latestVersion: '1.1.0', appInfo: APP_NEW };
  const s = await mountSettings({
    pending: CHECK_NEW,
    bds: {
      isPackaged: true,
      updateEverything: async () => ({ dependencies: { success: true, updatedCount: 1 }, appUpdate: app }),
      installAppUpdate: async () => ({ success: true })
    }
  });
  try {
    const confirms = [];
    s.setConfirm(async (msg) => { confirms.push(msg); return false; }); // "Agora não" no aviso de instalar
    await s.click(60);
    assert.equal(s.h.bds.calls.updateEverything.length, 1);
    assert.equal(confirms.length, 1);
    assert.match(confirms[0], /baixada e verificada/);
    assert.match(confirms[0], /UAC/, 'o aviso de permissão do Windows (que morava no painel Aplicativo) continua');
    assert.equal(s.h.bds.calls.installAppUpdate, undefined, 'adiar não instala');
    assert.equal(s.role(), 'install');
    assert.equal(s.label(), 'Reiniciar para instalar');
    assert.equal(s.btn().hasAttribute('aria-disabled'), false);
    assert.equal(s.$('componentsUpdateStatusText').textContent, 'Componentes atualizados.');
    assert.equal(s.notesVisible(), true, 'as notas continuam enquanto a versão espera para ser instalada');

    // depois: "Reiniciar para instalar" pergunta de novo e só então chama o instalador
    s.setConfirm(async (msg) => { confirms.push(msg); return true; });
    await s.click(60);
    assert.equal(confirms.length, 2);
    assert.equal(s.h.bds.calls.installAppUpdate.length, 1);
    assert.equal(s.h.bds.calls.updateEverything.length, 1, 'não baixa de novo');
    assert.equal(s.h.errors.length, 0);
  } finally { await s.h.cleanup(); }
});

test('baixar e atualizar: se o instalador não abrir, o botão continua "Reiniciar para instalar"', async () => {
  const app = { readyToInstall: true, digestVerified: false, latestVersion: '1.1.0', appInfo: APP_NEW };
  const s = await mountSettings({
    pending: CHECK_NEW,
    bds: {
      updateEverything: async () => ({ dependencies: { success: true, updatedCount: 0 }, appUpdate: app }),
      installAppUpdate: async () => ({ success: false, error: 'bloqueado' })
    }
  });
  try {
    await s.click(60);
    assert.equal(s.h.bds.calls.installAppUpdate.length, 1);
    assert.equal(s.h.dialogs.confirms.length, 1);
    assert.match(s.h.dialogs.confirms[0], /não foi possível conferir/, 'sem verificação: o aviso diz a verdade');
    assert.equal(s.h.dialogs.alerts.length, 1, 'o erro continua em diálogo');
    assert.equal(s.role(), 'install');
    assert.match(s.$('appUpdateStatusText').textContent, /Não foi possível abrir o instalador/);
  } finally { await s.h.cleanup(); }
});

test('baixar e atualizar: falha ao baixar o aplicativo oferece a página da release e o botão tenta de novo', async () => {
  const s = await mountSettings({
    pending: CHECK_NEW,
    bds: {
      updateEverything: async () => ({ dependencies: { success: true, updatedCount: 0 }, appUpdate: { error: 'sem rede', appInfo: APP_NEW } })
    }
  });
  try {
    await s.click(60);
    assert.equal(s.h.dialogs.confirms.length, 1);
    assert.match(s.h.dialogs.confirms[0], /página oficial/);
    assert.deepEqual(s.h.bds.calls.openExternal, [['https://example.com/release']]);
    assert.equal(s.role(), 'update', 'continua dando para tentar de novo');
    assert.match(s.$('appUpdateStatusText').textContent, /Não foi possível atualizar automaticamente/);
    assert.notEqual(s.headline(), 'Tudo está atualizado.');
  } finally { await s.h.cleanup(); }
});

test('baixar e atualizar: só componentes, a barra de progresso é única e o fim volta para "Verificar atualizações"', async () => {
  const s = await mountSettings({
    pending: { hasUpdates: true, app: CHECK_OK.app, dependencies: CHECK_NEW.dependencies },
    bds: { updateEverything: async () => ({ dependencies: { success: true, updatedCount: 2 }, appUpdate: { checked: true, noUpdateNeeded: true, appInfo: CHECK_OK.app } }) }
  });
  try {
    assert.equal(s.role(), 'update');
    assert.equal(s.notesVisible(), false, 'sem versão nova do aplicativo, sem notas');
    s.btn().click();
    await settle(20);
    assert.equal(s.btn().getAttribute('aria-disabled'), 'true');
    assert.equal(s.label(), 'Atualizando…');
    assert.equal(s.$('updateProgressContainer').classList.contains('hidden'), false);
    s.h.bds.emit('onUpdateProgress', { percent: 40, message: 'Baixando componentes…' });
    assert.equal(s.$('updateProgressPercent').textContent, '40%');
    assert.equal(s.$('updateProgressStep').textContent, 'Baixando componentes…');
    assert.equal(s.$('updateProgressFill').style.width, '40%');
    await settle(1700); // depois de mostrar o resultado por um instante, volta ao estado em dia
    assert.equal(s.role(), 'check');
    assert.equal(s.headline(), 'Tudo está atualizado.');
    assert.equal(s.$('componentsUpdateStatusText').textContent, 'Componentes atualizados.');
    assert.equal(s.$('updateProgressContainer').classList.contains('hidden'), true);
  } finally { await s.h.cleanup(); }
});

// ------------------------------------------------------------------ Licenças

const LICENSES = {
  bundled: [
    { id: 'alfa', name: 'Alfa <b>', version: '1.0', license: 'MIT', url: 'https://example.com/alfa', sourceUrl: '' }
  ],
  runtime: [
    { id: 'beta', name: 'Beta', version: '2.0', license: 'GPL-3.0', note: 'Programa independente.', url: 'https://example.com/beta', sourceUrl: 'https://example.com/beta-src' },
    { id: 'gama', name: 'Gama', version: '3.0', license: 'MIT', url: 'javascript:alert(1)' }
  ]
};

async function openLicenses(extra = {}) {
  const s = await mountSettings({ bds: { getLicenses: async () => LICENSES, ...extra } });
  s.h.document.querySelector('.settings-tab[data-tab="settingsAboutView"]').click();
  await settle(30);
  s.$('licensesToggle').click(); // a lista começa recolhida e só desenha ao abrir
  await settle(40);
  return s;
}

const fire = (h, el, type, props = {}) => {
  const ev = new h.window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, props);
  el.dispatchEvent(ev);
  return ev;
};

test('Licenças: "Página do projeto" e "Código-fonte" são links; só "Ver lista de componentes" é botão', async () => {
  const s = await openLicenses();
  try {
    const list = s.$('licensesList');
    assert.equal(list.querySelectorAll('button').length, 0, 'nenhum botão na lista');
    assert.equal(list.querySelectorAll('[data-license-link]').length, 0);
    const links = [...list.querySelectorAll('a.st-license-link')];
    assert.deepEqual(links.map((a) => a.textContent), ['Página do projeto', 'Página do projeto', 'Código-fonte']);
    assert.deepEqual(links.map((a) => a.getAttribute('href')), ['https://example.com/alfa', 'https://example.com/beta', 'https://example.com/beta-src']);
    // o aria-label traz o nome do componente (como texto, não como HTML) e o texto visível está dentro dele
    assert.deepEqual(links.map((a) => a.getAttribute('aria-label')), [
      'Abrir página do projeto Alfa <b>', 'Abrir página do projeto Beta', 'Abrir código-fonte de Beta'
    ]);
    for (const a of links) assert.ok(a.getAttribute('aria-label').toLowerCase().includes(a.textContent.toLowerCase()));
    assert.equal(list.querySelector('.st-license-body b'), null, 'o nome não vira HTML');
    // endereço que não é http(s) não vira link
    const gama = list.querySelector('details[data-license-id="gama"]');
    assert.equal(gama.querySelectorAll('a').length, 0);
    for (const a of links) assert.match(a.getAttribute('rel'), /noopener/);
    // o botão de abrir a lista continua (D8)
    const toggle = s.$('licensesToggle');
    assert.equal(toggle.tagName, 'BUTTON');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(s.$('licensesToggleText').textContent, 'Ocultar lista de componentes');
  } finally { await s.h.cleanup(); }
});

test('Licenças: clicar abre uma vez no navegador padrão e não navega a janela; Ctrl+clique e botão do meio também não', async () => {
  const s = await openLicenses();
  try {
    const [alfa, beta, betaSrc] = [...s.$('licensesList').querySelectorAll('a.st-license-link')];
    const ev = fire(s.h, alfa, 'click');
    assert.equal(ev.defaultPrevented, true, 'o clique não navega a janela do BDS');
    await settle(10);
    assert.deepEqual(s.h.bds.calls.openExternal, [['https://example.com/alfa']]);

    const ctrl = fire(s.h, beta, 'click', { ctrlKey: true });
    assert.equal(ctrl.defaultPrevented, true);
    await settle(10);
    assert.equal(s.h.bds.calls.openExternal.length, 2);

    // botão do meio: abre no navegador padrão; outros botões do mouse só não navegam
    const middle = fire(s.h, betaSrc, 'auxclick', { button: 1 });
    assert.equal(middle.defaultPrevented, true);
    await settle(10);
    assert.deepEqual(s.h.bds.calls.openExternal.at(-1), ['https://example.com/beta-src']);
    assert.equal(s.h.bds.calls.openExternal.length, 3);
    const right = fire(s.h, betaSrc, 'auxclick', { button: 2 });
    assert.equal(right.defaultPrevented, true);
    await settle(10);
    assert.equal(s.h.bds.calls.openExternal.length, 3, 'só o clique e o botão do meio abrem');

    // clique fora de um link não faz nada
    const other = fire(s.h, s.$('licensesList').querySelector('.st-license-meta'), 'click');
    assert.equal(other.defaultPrevented, false);
    await settle(10);
    assert.equal(s.h.bds.calls.openExternal.length, 3);
    assert.equal(s.h.errors.length, 0);
  } finally { await s.h.cleanup(); }
});

test('Licenças: se o navegador padrão não abrir, o usuário é avisado', async () => {
  const s = await openLicenses({ openExternal: async () => { throw new Error('bloqueado'); } });
  try {
    const toasts = [];
    s.h.window.bdsToast = (msg, opts) => toasts.push([msg, opts]);
    const link = s.$('licensesList').querySelector('a.st-license-link');
    const ev = fire(s.h, link, 'click');
    await settle(20);
    assert.equal(ev.defaultPrevented, true);
    assert.deepEqual(toasts, [['Não foi possível abrir o link.', { type: 'error' }]]);
    assert.equal(s.h.errors.length, 0, 'a falha é tratada, sem erro solto');
  } finally { await s.h.cleanup(); }
});

test('Licenças: o clique em links é tratado no script (click e auxclick) e o código não deixa botão de link', () => {
  assert.match(js, /addEventListener\('click', openLicenseLink\)/);
  assert.match(js, /addEventListener\('auxclick', openLicenseLink\)/);
  assert.doesNotMatch(js, /data-license-link/);
});
