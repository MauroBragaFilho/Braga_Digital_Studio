'use strict';

// Assistente de IA integrado ao app (renderer): estado vazio com exemplos, atalho Ctrl + J, contexto da tela enviado a
// cada mensagem, mensagem do primeiro uso com UM botão, aviso de servidor remoto ("Entendi, continuar"), navegação
// pedida pelo assistente (ai:navigate validado contra a lista fixa) e coerência com o main.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mountScreen, settle } = require('./helpers/renderer-harness');
const { SCREEN_IDS, AI_SCREENS: MAIN_SCREENS } = require('../src/services/ai/screens');

const ROOT = path.join(__dirname, '..');
const MODULES_ON = { ok: true, data: [{ id: 'ai', enabled: true }] };
const CONFIG_ON = { ok: true, data: { assistantEnabled: true } };

async function mount({ bds = {}, shell = '' } = {}) {
  const h = await mountScreen('aiassistant', {
    modulePath: '../components/ai-assistant.js',
    html: shell,
    init: false,
    bds: {
      isPackaged: true,
      modulesList: MODULES_ON,
      aiGetConfig: CONFIG_ON,
      aiHistoryGet: { ok: true, data: { messages: [], busy: false } },
      aiHistoryClear: { ok: true, data: true },
      aiChatCancel: { ok: true, data: true },
      aiChatStart: { ok: true, data: { id: 'c1' } },
      aiSaveConfig: { ok: true, data: {} },
      ...bds
    }
  });
  h.ctx = await import(require('node:url').pathToFileURL(path.join(ROOT, 'renderer', 'utils', 'assistantContext.js')).href);
  await h.mod.mountAssistant();
  await settle(20);
  return h;
}
const q = (h, sel) => h.document.querySelector(sel);
const qa = (h, sel) => [...h.document.querySelectorAll(sel)];
const fab = (h) => q(h, '#aiAssistantFab');
const panel = (h) => q(h, '#aiAssistantPanel');
const isOpen = (h) => panel(h) && !panel(h).hasAttribute('hidden');
const input = (h) => q(h, '.aia-input');
function fire(h, el, type, props = {}) {
  const ev = new h.window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, props);
  el.dispatchEvent(ev);
  return ev;
}
const key = (h, el, k, props = {}) => fire(h, el, 'keydown', { key: k, ...props });
const click = (h, el) => fire(h, el, 'click');
const finish = async (h) => { h.mod.unmountAssistant(); await h.cleanup(); };

/** Menu lateral mínimo (como o do index.html) com a aba ativa e ouvintes que registram os cliques. */
const SIDEBAR = (active = 'home') => `
  <nav class="sidebar"><div class="tabs">
    ${['home', 'download', 'converter', 'silence', 'metadata', 'transcription', 'library', 'projects', 'upload', 'devices', 'luts', 'settings', 'montage', 'recovery']
    .map((v) => `<button class="tab-button${v === active ? ' active' : ''}${v === 'montage' ? ' hidden' : ''}" data-view="${v}" type="button"${v === 'montage' ? ' style="display: none;"' : ''}>${v}</button>`).join('')}
  </div></nav>`;
function trackClicks(h) {
  const clicks = [];
  for (const b of qa(h, '.sidebar .tab-button')) b.addEventListener('click', () => clicks.push(b.getAttribute('data-view')));
  return clicks;
}

// ------------------------------------------------------------------ estado vazio

test('estado vazio: 3 exemplos curtos de pedidos em texto simples (nada clicável) e nada além do chat', async () => {
  const h = await mount();
  try {
    click(h, fab(h));
    const empty = q(h, '.aia-empty');
    assert.ok(empty);
    const items = qa(h, '.aia-empty .aia-examples li').map((li) => li.textContent);
    assert.equal(items.length, 3);
    for (const t of items) assert.ok(t.length <= 60, t);
    assert.match(items[0], /Quais vídeos de aula eu tenho\?/);
    assert.match(items[1], /Converta o que está selecionado/);
    assert.match(items[2], /O que tem neste projeto\?/);
    assert.equal(qa(h, '.aia-empty button, .aia-empty a, .aia-empty input').length, 0, 'exemplos são texto, não botões');
    assert.deepEqual(qa(h, '#aiAssistantPanel button').map((b) => b.getAttribute('aria-label')), ['Limpar conversa', 'Fechar assistente', 'Enviar']);
    assert.deepEqual(h.mod.EMPTY_EXAMPLES.length, 3);
    // vira uma conversa: o estado vazio sai
    input(h).value = 'oi';
    key(h, input(h), 'Enter');
    await settle(10);
    assert.equal(qa(h, '.aia-empty').length, 0);
  } finally { await finish(h); }
});

// ------------------------------------------------------------------ atalho

test('atalho Ctrl + J abre e fecha o assistente (e foca o campo); outras combinações e assistente desligado não fazem nada', async () => {
  const h = await mount();
  try {
    assert.equal(isOpen(h), false);
    const a = key(h, h.document.body, 'j', { ctrlKey: true });
    assert.equal(a.defaultPrevented, true);
    assert.equal(isOpen(h), true);
    key(h, h.document.body, 'J', { ctrlKey: true });
    assert.equal(isOpen(h), false, 'a mesma tecla fecha');
    key(h, h.document.body, 'j');
    key(h, h.document.body, 'j', { ctrlKey: true, shiftKey: true });
    key(h, h.document.body, 'j', { ctrlKey: true, altKey: true });
    key(h, h.document.body, 'k', { ctrlKey: true });
    assert.equal(isOpen(h), false);
    key(h, h.document.body, 'j', { metaKey: true });
    assert.equal(isOpen(h), true, 'Cmd + J no Mac');
    // dentro do campo de texto também funciona
    key(h, input(h), 'j', { ctrlKey: true });
    assert.equal(isOpen(h), false);
  } finally { await finish(h); }

  const off = await mount({ bds: { aiGetConfig: { ok: true, data: { assistantEnabled: false } } } });
  try {
    assert.equal(fab(off), null);
    const ev = key(off, off.document.body, 'j', { ctrlKey: true });
    assert.equal(ev.defaultPrevented, false, 'desligado: o atalho não existe');
  } finally { await finish(off); }
});

test('ajuda de atalhos e conflitos: Ctrl + J está listado e não colide com outro atalho global do app', () => {
  const help = fs.readFileSync(path.join(ROOT, 'renderer', 'utils', 'shortcutsHelp.js'), 'utf8');
  assert.match(help, /\['Ctrl \+ J', 'Abrir ou fechar o assistente de IA'\]/);
  // atalhos globais já usados: Ctrl+1..9, Ctrl+B, Ctrl+K, Ctrl+F, Ctrl+A (Biblioteca), Ctrl+S (Configurações), Ctrl+R/F5 (dev)
  const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /key === 'j'|key\) === 'j'|toLowerCase\(\) === 'j'/);
  const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.doesNotMatch(mainJs, /key === 'j'/);
  // o componente captura o atalho antes das telas (o 'j' sozinho do monitor de projetos continua livre)
  const comp = fs.readFileSync(path.join(ROOT, 'renderer', 'components', 'ai-assistant.js'), 'utf8');
  assert.match(comp, /addEventListener\('keydown', onShortcut, true\)/);
});

// ------------------------------------------------------------------ contexto da tela

test('contexto da tela: cada mensagem leva { screen, selectedIds, projectId } conforme a tela aberta', async () => {
  const h = await mount({ shell: SIDEBAR('library') });
  try {
    h.ctx.setContextProvider('librarySelection', () => [7, 8, 8, 'x', -1, 2.5, 9]);
    click(h, fab(h));
    input(h).value = 'converta o que está selecionado';
    key(h, input(h), 'Enter');
    await settle(10);
    assert.deepEqual(h.bds.calls.aiChatStart[0], ['converta o que está selecionado', { screen: 'library', selectedIds: [7, 8, 9] }]);
  } finally { await finish(h); }

  // Projetos: o projeto aberto na área de trabalho vale mais que o selecionado na lista; seleção da Biblioteca não vaza
  const p = await mount({ shell: SIDEBAR('projects') });
  try {
    p.ctx.setContextProvider('librarySelection', () => [1, 2]);
    p.ctx.setContextProvider('projectSelected', () => 4);
    assert.deepEqual(p.ctx.currentContext(p.document), { screen: 'projects', projectId: 4 });
    p.ctx.setContextProvider('workspaceProject', () => 9);
    assert.deepEqual(p.ctx.currentContext(p.document), { screen: 'projects', projectId: 9 });
    p.ctx.setContextProvider('workspaceProject', null);
    assert.equal(p.ctx.currentContext(p.document).projectId, 4);
  } finally { await finish(p); }

  // limite de 50 ids; tela de desenvolvimento = sem contexto; erro no provedor nunca derruba o envio
  const l = await mount({ shell: SIDEBAR('library') });
  try {
    l.ctx.setContextProvider('librarySelection', () => Array.from({ length: 80 }, (_, i) => i + 1));
    assert.equal(l.ctx.currentContext(l.document).selectedIds.length, 50);
    l.ctx.setContextProvider('librarySelection', () => { throw new Error('quebrou'); });
    assert.deepEqual(l.ctx.currentContext(l.document), { screen: 'library' });
    l.document.querySelector('.tab-button.active').classList.remove('active');
    l.document.querySelector('[data-view="recovery"]').classList.add('active');
    assert.equal(l.ctx.currentContext(l.document), undefined);
  } finally { await finish(l); }
});

test('a lista de telas do renderer é IGUAL à do main (mesmos ids, mesmos nomes, mesmos módulos)', async () => {
  const h = await mount();
  try {
    assert.deepEqual(h.ctx.AI_SCREENS.map((s) => s.id), SCREEN_IDS);
    assert.deepEqual(h.ctx.AI_SCREENS.map((s) => [s.id, s.label, s.module]), MAIN_SCREENS.map((s) => [s.id, s.label, s.module]));
    assert.ok(!SCREEN_IDS.includes('montage') && !SCREEN_IDS.includes('recovery'));
    // os rótulos conferem com o menu lateral real
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    for (const s of MAIN_SCREENS) assert.match(html, new RegExp(`data-view="${s.id}"[\\s\\S]{0,200}?${s.label}`), s.id);
  } finally { await finish(h); }
});

// ------------------------------------------------------------------ primeiro uso (mensagem com UM botão)

for (const [name, trigger] of [
  ['sem servidor configurado (AI_NOT_CONFIGURED na chamada)', { bds: { aiChatStart: { ok: false, error: 'O servidor de IA ainda não foi configurado.', code: 'AI_NOT_CONFIGURED' } }, via: 'start' }],
  ['servidor que não responde (AI_UNREACHABLE no evento de erro)', { bds: {}, via: 'event', code: 'AI_UNREACHABLE' }],
  ['servidor que demora (TIMEOUT no evento de erro)', { bds: {}, via: 'event', code: 'TIMEOUT' }]
]) {
  test(`primeiro uso ${name}: mensagem curta e UM botão "Abrir configurações da IA" que leva a Configurações → Inteligência Artificial`, async () => {
    const h = await mount({ bds: trigger.bds, shell: `${SIDEBAR('library')}<div id="settingsHost"><button class="settings-tab" data-tab="settingsAiView">IA</button></div>` });
    try {
      const clicks = trackClicks(h);
      const aiTab = q(h, '.settings-tab[data-tab="settingsAiView"]');
      let aiClicks = 0;
      aiTab.addEventListener('click', () => { aiClicks += 1; });
      click(h, fab(h));
      input(h).value = 'oi';
      key(h, input(h), 'Enter');
      await settle(10);
      if (trigger.via === 'event') { h.bds.emit('onAiChatError', { id: 'c1', error: 'qualquer texto técnico do servidor', code: trigger.code }); await settle(10); }
      const msg = q(h, '.aia-msg-guide');
      assert.ok(msg, 'mensagem de orientação');
      assert.ok(msg.textContent.length < 260, 'mensagem curta');
      assert.doesNotMatch(msg.textContent, /yt-dlp|ffmpeg|whisper|ECONN|fetch failed|http/i, 'sem termos técnicos nem nomes de motores');
      const buttons = qa(h, '.aia-msg-guide button');
      assert.equal(buttons.length, 1, 'UM botão');
      assert.equal(buttons[0].textContent, 'Abrir configurações da IA');
      assert.equal(qa(h, '.aia-msg-error').length, 0, 'não é um erro vermelho');
      assert.equal(input(h).value, 'oi', 'a pergunta volta ao campo para reenviar depois');
      click(h, buttons[0]);
      assert.deepEqual(clicks, ['settings'], 'abre a tela de Configurações');
      assert.equal(isOpen(h), false, 'o painel sai da frente');
      await settle(250);
      assert.equal(aiClicks, 1, 'e a seção Inteligência Artificial');
    } finally { await finish(h); }
  });
}

test('o painel continua só com chat fora do primeiro uso: sem botões nas mensagens normais nem nos erros comuns', async () => {
  const h = await mount();
  try {
    click(h, fab(h));
    input(h).value = 'oi';
    key(h, input(h), 'Enter');
    await settle(10);
    h.bds.emit('onAiChatError', { id: 'c1', error: 'A conexão com o servidor de IA foi interrompida.', code: 'INTERRUPTED' });
    await settle(10);
    assert.equal(qa(h, '.aia-msg button, .aia-bubble button').length, 0);
    assert.equal(qa(h, '.aia-msg-error').length, 1);
  } finally { await finish(h); }
});

// ------------------------------------------------------------------ aviso de servidor remoto

test('servidor remoto: o aviso aparece no chat com "Entendi, continuar"; clicar guarda o aceite e REENVIA a pergunta uma vez', async () => {
  let starts = 0;
  const h = await mount({ bds: {
    aiChatStart: async () => {
      starts += 1;
      return starts === 1
        ? { ok: false, error: 'Antes de começar: o que você escrever aqui e o que eu consultar na sua biblioteca será enviado a este servidor (api.nuvem.exemplo.com).', code: 'AI_REMOTE_CONSENT' }
        : { ok: true, data: { id: 'c2' } };
    }
  } });
  try {
    click(h, fab(h));
    input(h).value = 'quantos vídeos eu tenho?';
    key(h, input(h), 'Enter');
    await settle(10);
    const msg = q(h, '.aia-msg-guide');
    assert.match(msg.textContent, /será enviado a este servidor \(api\.nuvem\.exemplo\.com\)/);
    const btns = qa(h, '.aia-msg-guide button');
    assert.equal(btns.length, 1);
    assert.equal(btns[0].textContent, 'Entendi, continuar');
    assert.equal(input(h).value, '', 'a pergunta fica guardada no botão, não duplicada no campo');
    assert.equal((h.bds.calls.aiSaveConfig || []).length, 0, 'nada gravado antes do clique');
    click(h, btns[0]);
    await settle(30);
    assert.deepEqual(h.bds.calls.aiSaveConfig, [[{ acceptRemoteServer: true }]]);
    assert.equal(starts, 2, 'a pergunta foi reenviada');
    assert.equal(h.bds.calls.aiChatStart[1][0], 'quantos vídeos eu tenho?');
    assert.equal(qa(h, '.aia-msg-guide button').length, 0, 'o botão some depois do aceite');
    assert.equal(qa(h, '.aia-msg-user').length, 1);
  } finally { await finish(h); }
});

test('servidor remoto: se não for possível guardar o aceite, o botão volta e avisa; nada é reenviado', async () => {
  let starts = 0;
  const h = await mount({ bds: {
    aiChatStart: async () => { starts += 1; return { ok: false, error: 'Antes de começar: ... enviado a este servidor (x.exemplo.com).', code: 'AI_REMOTE_CONSENT' }; },
    aiSaveConfig: { ok: false, error: 'Falha ao gravar.' }
  } });
  try {
    click(h, fab(h));
    input(h).value = 'oi';
    key(h, input(h), 'Enter');
    await settle(10);
    click(h, q(h, '.aia-msg-guide button'));
    await settle(30);
    assert.equal(starts, 1);
    assert.equal(qa(h, '.aia-msg-guide button').length, 1);
    assert.equal(q(h, '.aia-msg-guide button').disabled, false);
    assert.match(q(h, '.aia-msg-error').textContent, /Não foi possível guardar/);
  } finally { await finish(h); }
});

// ------------------------------------------------------------------ ai:navigate

test('ai:navigate: só abre telas da lista fixa cujo menu existe e está visível; o resto é ignorado', async () => {
  const h = await mount({ shell: SIDEBAR('home') });
  try {
    const clicks = trackClicks(h);
    const nav = (screen) => h.bds.emit('onAiNavigate', screen === undefined ? undefined : { screen });
    nav('library');
    nav('converter');
    assert.deepEqual(clicks, ['library', 'converter']);
    for (const bad of ['montage', 'recovery', 'ai', '../x', 'library"] , [x', '', 5, null, { a: 1 }]) nav(bad);
    nav(undefined);
    assert.deepEqual(clicks, ['library', 'converter'], 'telas fora da lista (ou escondidas) não navegam');
    // módulo desligado: a aba some do menu e a navegação é ignorada
    q(h, '[data-view="silence"]').classList.add('hidden');
    nav('silence');
    q(h, '[data-view="metadata"]').style.display = 'none';
    nav('metadata');
    assert.deepEqual(clicks, ['library', 'converter']);
    assert.equal(h.mod.onNavigate({ screen: 'settings' }), true);
    assert.equal(h.mod.onNavigate({ screen: 'montage' }), false);
  } finally { await finish(h); }
});

// ------------------------------------------------------------------ estático

test('o componente continua sem innerHTML, sem canal de ferramenta e o CSS novo usa só tokens do app', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'components', 'ai-assistant.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // sem comentários
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
  const used = [...new Set([...src.matchAll(/bds\(\)\.(\w+)/g)].map((m) => m[1]).filter((n) => /^ai[A-Z]/.test(n)))].sort();
  assert.deepEqual(used, ['aiChatCancel', 'aiChatStart', 'aiGetConfig', 'aiHistoryClear', 'aiHistoryGet', 'aiSaveConfig']);
  assert.doesNotMatch(src, /aiRunTool|aiExecute|aiConfirm|executeTool|confirmTool/);
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'components', 'ai-assistant.css'), 'utf8');
  const block = css.slice(css.indexOf('.aia-examples {'), css.indexOf('.aia-msg { display: flex; }'));
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, 'sem cor fixa no estado vazio');
  const guide = css.slice(css.indexOf('.aia-msg-guide'), css.indexOf('.aia-msg-error .aia-bubble {'));
  assert.doesNotMatch(guide, /#[0-9a-fA-F]{3,8}\b/, 'sem cor fixa na mensagem com botão');
  assert.match(guide, /focus-visible/);
});

test('telas que alimentam o contexto registram os provedores (Biblioteca, Projetos e área de trabalho)', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'renderer', 'screens', 'library.js'), 'utf8');
  assert.match(lib, /setContextProvider\('librarySelection', \(\) => Array\.from\(selectedIds\)\)/);
  assert.match(lib, /onMediaUpdated/, 'a Biblioteca recarrega quando o assistente etiqueta/favorita');
  const proj = fs.readFileSync(path.join(ROOT, 'renderer', 'screens', 'projects.js'), 'utf8');
  assert.match(proj, /setContextProvider\('projectSelected', \(\) => selectedProjectId\)/);
  const ws = fs.readFileSync(path.join(ROOT, 'renderer', 'screens', 'project_workspace.js'), 'utf8');
  assert.match(ws, /setContextProvider\('workspaceProject', \(\) => projectId\)/);
  assert.match(ws, /setContextProvider\('workspaceProject', null\)/);
});
