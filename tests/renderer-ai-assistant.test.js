'use strict';

// Botão flutuante do assistente de IA (renderer/components/ai-assistant.js) com o harness de renderer (linkedom):
// abrir/fechar, arrasto sem clique, posição salva e reenquadrada, foco, Esc, Enter envia, texto do modelo não vira
// HTML, painel só com chat, interruptor/módulo desligado remove o botão. Mais verificações estáticas (CSS, menu).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const ROOT = path.join(__dirname, '..');
const POS_KEY = 'bds.aiFab.pos';

const MODULES_ON = { ok: true, data: [{ id: 'ai', enabled: true }, { id: 'transcription', enabled: true }] };
const MODULES_OFF = { ok: true, data: [{ id: 'ai', enabled: false }] };
const CONFIG_ON = { ok: true, data: { assistantEnabled: true } };
const CONFIG_OFF = { ok: true, data: { assistantEnabled: false } };

/** Monta o componente com um window.bds simulado; `bds` sobrepõe as respostas. */
async function mount({ bds = {}, storage = null, size = null } = {}) {
  const h = await mountScreen('aiassistant', {
    modulePath: '../components/ai-assistant.js',
    html: '',
    init: false,
    bds: {
      isPackaged: false,
      modulesList: MODULES_ON,
      aiGetConfig: CONFIG_ON,
      aiHistoryGet: { ok: true, data: { messages: [], busy: false } },
      aiHistoryClear: { ok: true, data: true },
      aiChatCancel: { ok: true, data: true },
      aiChatStart: { ok: true, data: { id: 'c1' } },
      ...bds
    }
  });
  if (storage) h.window.localStorage.setItem(POS_KEY, JSON.stringify(storage));
  if (size) { h.window.innerWidth = size[0]; h.window.innerHeight = size[1]; }
  await h.mod.mountAssistant();
  await settle(20);
  return h;
}

const q = (h, sel) => h.document.querySelector(sel);
const fab = (h) => q(h, '#aiAssistantFab');
const panel = (h) => q(h, '#aiAssistantPanel');
const isOpen = (h) => panel(h) && !panel(h).hasAttribute('hidden');
const input = (h) => q(h, '.aia-input');
const cssVar = (h, name) => q(h, '#aiAssistantRoot').style.getPropertyValue(name);
const saved = (h) => JSON.parse(h.window.localStorage.getItem(POS_KEY));

/** Dispara um evento simples com propriedades extras (linkedom não tem PointerEvent). */
function fire(h, el, type, props = {}) {
  const ev = new h.window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, props);
  el.dispatchEvent(ev);
  return ev;
}
const key = (h, el, k, props = {}) => fire(h, el, 'keydown', { key: k, ...props });
const click = (h, el) => fire(h, el, 'click');

/** Substitui focus() para registrar quem recebeu o foco (linkedom não modela o foco). */
function spyFocus(h) {
  const log = [];
  for (const [name, el] of [['fab', fab(h)], ['input', input(h)]]) if (el) el.focus = () => log.push(name);
  return log;
}

const finish = async (h) => { h.mod.unmountAssistant(); await h.cleanup(); };

// --------------------------------------------------------------------- liberação

test('módulo desligado, interruptor desligado ou módulo fora da lista (app empacotado, onde o main nem o lista): nenhum botão', async () => {
  for (const bds of [{ modulesList: MODULES_OFF }, { aiGetConfig: CONFIG_OFF }, { modulesList: { ok: true, data: [] } }]) {
    const h = await mount({ bds });
    try { assert.equal(fab(h), null, JSON.stringify(bds)); assert.equal(q(h, '#aiAssistantRoot'), null); } finally { await finish(h); }
  }
});

test('módulo e interruptor ligados: o botão aparece; desligar o interruptor remove e ligar de novo recria', async () => {
  const h = await mount();
  try {
    assert.ok(fab(h));
    assert.equal(fab(h).getAttribute('aria-haspopup'), 'dialog');
    assert.equal(fab(h).getAttribute('aria-expanded'), 'false');
    assert.equal(fab(h).getAttribute('aria-controls'), 'aiAssistantPanel');

    click(h, fab(h));
    assert.equal(isOpen(h), true);

    h.bds.set('aiGetConfig', CONFIG_OFF);
    h.window.dispatchEvent(new h.window.CustomEvent('bds:ai-assistant-changed'));
    await settle(20);
    assert.equal(fab(h), null, 'botão e painel somem');
    assert.equal(q(h, '#aiAssistantPanel'), null);

    h.bds.set('aiGetConfig', CONFIG_ON);
    h.window.dispatchEvent(new h.window.CustomEvent('bds:ai-assistant-changed'));
    await settle(20);
    assert.ok(fab(h));
    assert.equal(isOpen(h), false);

    // módulo desligado em Configurações → Módulos também remove
    h.bds.set('modulesList', MODULES_OFF);
    h.window.dispatchEvent(new h.window.CustomEvent('bds:modules-changed'));
    await settle(20);
    assert.equal(fab(h), null);
  } finally { await finish(h); }
});

test('desligado com resposta em andamento: pede o cancelamento ao processo principal', async () => {
  const h = await mount();
  try {
    input(h).value = 'pergunta';
    key(h, input(h), 'Enter');
    await settle(20);
    h.bds.set('aiGetConfig', CONFIG_OFF);
    h.window.dispatchEvent(new h.window.CustomEvent('bds:ai-assistant-changed'));
    await settle(20);
    assert.equal(fab(h), null);
    assert.ok((h.bds.calls.aiChatCancel || []).length >= 1);
  } finally { await finish(h); }
});

// --------------------------------------------------------------- painel: só o chat

test('o painel mostra SOMENTE o chat: título, limpar, fechar, mensagens, campo e enviar', async () => {
  const h = await mount();
  try {
    click(h, fab(h));
    const p = panel(h);
    assert.equal(p.getAttribute('role'), 'dialog');
    assert.equal(p.getAttribute('aria-modal'), 'false');
    assert.ok(p.getAttribute('aria-label'));
    assert.equal(p.querySelector('h2').textContent, 'Assistente');

    const buttons = [...p.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    assert.deepEqual(buttons, ['Limpar conversa', 'Fechar assistente', 'Enviar']);
    assert.equal(p.querySelectorAll('textarea').length, 1);
    assert.equal(p.querySelectorAll('input, select, details, a, datalist').length, 0, 'nada de configuração no painel');
    assert.doesNotMatch(p.textContent, /servidor|chave|modelo|endere[cç]o|token/i);

    const log = p.querySelector('.aia-messages');
    assert.equal(log.getAttribute('role'), 'log');
    assert.equal(log.getAttribute('aria-live'), 'polite');
  } finally { await finish(h); }
});

test('abrir/fechar: clique alterna, Esc fecha e devolve o foco ao botão, o X também', async () => {
  const h = await mount();
  try {
    const focus = spyFocus(h);
    click(h, fab(h));
    assert.equal(isOpen(h), true);
    assert.equal(fab(h).getAttribute('aria-expanded'), 'true');
    assert.equal(focus.at(-1), 'input', 'abre com o foco no campo de texto');

    key(h, input(h), 'Escape');
    assert.equal(isOpen(h), false);
    assert.equal(fab(h).getAttribute('aria-expanded'), 'false');
    assert.equal(focus.at(-1), 'fab', 'foco devolvido ao botão');

    click(h, fab(h));
    focus.length = 0;
    click(h, q(h, 'button[aria-label="Fechar assistente"]'));
    assert.equal(isOpen(h), false);
    assert.equal(focus.at(-1), 'fab');

    click(h, fab(h));
    click(h, fab(h));
    assert.equal(isOpen(h), false, 'segundo clique no botão fecha');
  } finally { await finish(h); }
});

test('Enter envia, Shift+Enter não envia (quebra linha); texto vazio não envia', async () => {
  const h = await mount();
  try {
    click(h, fab(h));
    input(h).value = 'linha 1';
    const shift = key(h, input(h), 'Enter', { shiftKey: true });
    assert.equal(shift.defaultPrevented, false, 'Shift+Enter deixa o campo quebrar a linha');
    assert.equal((h.bds.calls.aiChatStart || []).length, 0);

    input(h).value = '   ';
    key(h, input(h), 'Enter');
    assert.equal((h.bds.calls.aiChatStart || []).length, 0);

    input(h).value = '  Oi, assistente  ';
    const enter = key(h, input(h), 'Enter');
    assert.equal(enter.defaultPrevented, true);
    await settle(10);
    // o 2º argumento é o contexto da tela (sem menu lateral no teste, a tela é a Home)
    assert.deepEqual(h.bds.calls.aiChatStart, [['Oi, assistente', { screen: 'home' }]]);
    assert.equal(input(h).value, '', 'campo limpo depois de enviar');
    assert.equal(h.document.querySelectorAll('.aia-msg-user').length, 1);
    assert.equal(h.document.querySelector('.aia-msg-user .aia-bubble').textContent, 'Oi, assistente');
  } finally { await finish(h); }
});

test('resposta em streaming: pedaços aparecem, o fim troca pelo texto final e o botão volta a "Enviar"', async () => {
  const h = await mount();
  try {
    click(h, fab(h));
    input(h).value = 'Quem é você?';
    key(h, input(h), 'Enter');
    await settle(10);
    const send = q(h, '.aia-send');
    assert.equal(send.getAttribute('aria-label'), 'Parar resposta');
    assert.equal(q(h, '.aia-messages').getAttribute('aria-busy'), 'true');

    h.bds.emit('onAiChatDelta', { id: 'c1', text: 'Sou o ' });
    h.bds.emit('onAiChatDelta', { id: 'c1', text: 'assistente.' });
    await settle(30);
    assert.match(q(h, '.aia-msg-assistant .aia-bubble').textContent, /Sou o assistente\./);
    assert.equal(h.document.querySelectorAll('.aia-msg-pending').length, 0);

    h.bds.emit('onAiChatDelta', { id: 'outra', text: 'IGNORADO' });
    h.bds.emit('onAiChatDone', { id: 'c1', text: 'Sou o assistente.', finishReason: 'stop', cancelled: false });
    await settle(10);
    assert.equal(q(h, '.aia-msg-assistant .aia-bubble').textContent, 'Sou o assistente.');
    assert.equal(send.getAttribute('aria-label'), 'Enviar');
    assert.equal(q(h, '.aia-messages').getAttribute('aria-busy'), 'false');
    assert.equal(h.document.querySelectorAll('.aia-msg-assistant').length, 1);
  } finally { await finish(h); }
});

test('"Parar" durante a resposta chama ai:chatCancel; cancelado sem texto devolve a pergunta ao campo', async () => {
  const h = await mount();
  try {
    click(h, fab(h));
    input(h).value = 'pergunta';
    key(h, input(h), 'Enter');
    await settle(10);
    fire(h, q(h, '.aia-composer'), 'submit'); // clicar no botão (agora "Parar") envia o formulário
    await settle(10);
    assert.ok((h.bds.calls.aiChatCancel || []).length >= 1);
    h.bds.emit('onAiChatDone', { id: 'c1', text: '', cancelled: true });
    await settle(10);
    assert.equal(input(h).value, 'pergunta');
    assert.equal(h.document.querySelectorAll('.aia-msg').length, 0);
    assert.equal(h.document.querySelectorAll('.aia-empty').length, 1);
  } finally { await finish(h); }
});

test('SEGURANÇA: texto do modelo e do usuário nunca vira HTML (só markdown mínimo por createElement)', async () => {
  const evil = '<img src=x onerror="alert(1)"><script>window.hack=1</script> **negrito** e `código` <b>x</b>';
  const h = await mount();
  try {
    click(h, fab(h));
    input(h).value = evil;
    key(h, input(h), 'Enter');
    await settle(10);
    h.bds.emit('onAiChatDelta', { id: 'c1', text: evil });
    h.bds.emit('onAiChatDone', { id: 'c1', text: `${evil}\n\n- item <i>um</i>\n- item dois\n\n\`\`\`js\n<script>alert(2)</script>\n\`\`\``, finishReason: 'stop' });
    await settle(30);

    const log = q(h, '.aia-messages');
    assert.equal(log.querySelector('img'), null);
    assert.equal(log.querySelector('script'), null);
    assert.equal(log.querySelector('b'), null);
    assert.equal(log.querySelector('i'), null);
    assert.equal(log.querySelector('[onerror]'), null);
    assert.equal(h.window.hack, undefined);
    assert.ok(log.textContent.includes('<img src=x onerror="alert(1)">'), 'o texto aparece literal');
    const user = q(h, '.aia-msg-user .aia-bubble');
    assert.equal(user.textContent, evil);
    assert.equal(user.children.length, 0, 'bolha do usuário é texto puro');
    const bot = q(h, '.aia-msg-assistant .aia-bubble');
    assert.equal(bot.querySelector('strong').textContent, 'negrito');
    assert.equal(bot.querySelector('code').textContent, 'código');
    assert.equal(bot.querySelectorAll('li').length, 2);
    assert.match(bot.querySelector('pre code').textContent, /<script>alert\(2\)<\/script>/);
  } finally { await finish(h); }
});

test('erro ao iniciar: mensagem amigável, a pergunta volta ao campo e não fica bolha órfã', async () => {
  const h = await mount({ bds: { aiChatStart: { ok: false, error: 'Não foi possível conectar ao servidor de IA. Confira a URL e se ele está em execução.', code: null } } });
  try {
    click(h, fab(h));
    input(h).value = 'oi';
    key(h, input(h), 'Enter');
    await settle(20);
    assert.equal(input(h).value, 'oi');
    assert.equal(h.document.querySelectorAll('.aia-msg-user').length, 0);
    const err = q(h, '.aia-msg-error .aia-bubble');
    assert.match(err.textContent, /Não foi possível conectar ao servidor de IA/);
    assert.doesNotMatch(err.textContent, /responder\. Não foi possível/, 'sem prefixo redundante');
    assert.equal(q(h, '.aia-send').getAttribute('aria-label'), 'Enviar');
  } finally { await finish(h); }
});

test('erro durante a resposta (ai:chatError) e AI_DISABLED: erro amigável; AI_DISABLED reavalia o botão', async () => {
  const h = await mount();
  try {
    click(h, fab(h));
    input(h).value = 'oi';
    key(h, input(h), 'Enter');
    await settle(10);
    h.bds.emit('onAiChatError', { id: 'c1', error: 'A conexão com o servidor de IA foi interrompida.', code: 'INTERRUPTED' });
    await settle(10);
    assert.match(q(h, '.aia-msg-error .aia-bubble').textContent, /interrompida/);
    assert.equal(input(h).value, 'oi');
  } finally { await finish(h); }

  const h2 = await mount({ bds: { aiChatStart: { ok: false, error: 'O assistente de IA está desligado.', code: 'AI_DISABLED' } } });
  try {
    click(h2, fab(h2));
    input(h2).value = 'oi';
    h2.bds.set('aiGetConfig', CONFIG_OFF); // o main já considera desligado
    key(h2, input(h2), 'Enter');
    await settle(40);
    assert.equal(fab(h2), null, 'AI_DISABLED faz o botão sumir');
  } finally { await finish(h2); }
});

test('limpar conversa: confirma, chama ai:historyClear e volta ao estado vazio', async () => {
  const h = await mount({ bds: { aiHistoryGet: { ok: true, data: { messages: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá!' }], busy: false } } } });
  try {
    assert.equal(h.document.querySelectorAll('.aia-msg').length, 2, 'histórico restaurado ao abrir');
    click(h, fab(h));
    click(h, q(h, 'button[aria-label="Limpar conversa"]'));
    await settle(20);
    assert.equal(h.dialogs.confirms.length, 1);
    assert.equal((h.bds.calls.aiHistoryClear || []).length, 1);
    assert.equal(h.document.querySelectorAll('.aia-msg').length, 0);
    assert.equal(h.document.querySelectorAll('.aia-empty').length, 1);
  } finally { await finish(h); }
});

// --------------------------------------------------------------- posição e arrasto

test('arrasto move o botão e NÃO abre o painel (nem o clique que vem depois); a posição é salva', async () => {
  const h = await mount();
  try {
    const before = { right: parseInt(cssVar(h, '--aia-right'), 10), bottom: parseInt(cssVar(h, '--aia-bottom'), 10) };
    fire(h, fab(h), 'pointerdown', { pointerId: 1, button: 0, clientX: 500, clientY: 500 });
    fire(h, fab(h), 'pointermove', { pointerId: 1, clientX: 460, clientY: 480 });
    fire(h, fab(h), 'pointerup', { pointerId: 1, clientX: 460, clientY: 480 });
    click(h, fab(h)); // o navegador dispara um "click" depois do arrasto
    assert.equal(isOpen(h) || false, false, 'arrastar não abre o painel');
    assert.equal(parseInt(cssVar(h, '--aia-right'), 10), before.right + 40);
    assert.equal(parseInt(cssVar(h, '--aia-bottom'), 10), before.bottom + 20);
    assert.deepEqual(saved(h), { right: before.right + 40, bottom: before.bottom + 20 });

    await settle(10); // o bloqueio do clique expira: o próximo clique de verdade abre
    click(h, fab(h));
    assert.equal(isOpen(h), true);
  } finally { await finish(h); }
});

test('toque sem movimento (abaixo do limite) é clique, não arrasto', async () => {
  const h = await mount();
  try {
    const before = cssVar(h, '--aia-right');
    fire(h, fab(h), 'pointerdown', { pointerId: 1, button: 0, clientX: 500, clientY: 500 });
    fire(h, fab(h), 'pointermove', { pointerId: 1, clientX: 502, clientY: 501 });
    fire(h, fab(h), 'pointerup', { pointerId: 1, clientX: 502, clientY: 501 });
    click(h, fab(h));
    assert.equal(cssVar(h, '--aia-right'), before);
    assert.equal(h.window.localStorage.getItem(POS_KEY), null, 'nada salvo');
    assert.equal(isOpen(h), true);
  } finally { await finish(h); }
});

test('o arrasto fica dentro da janela', async () => {
  const h = await mount({ size: [1280, 800] });
  try {
    fire(h, fab(h), 'pointerdown', { pointerId: 1, button: 0, clientX: 1000, clientY: 700 });
    fire(h, fab(h), 'pointermove', { pointerId: 1, clientX: -5000, clientY: -5000 });
    fire(h, fab(h), 'pointerup', { pointerId: 1 });
    assert.equal(parseInt(cssVar(h, '--aia-right'), 10), 1280 - 52 - 8);
    assert.equal(parseInt(cssVar(h, '--aia-bottom'), 10), 800 - 52 - 8);
    fire(h, fab(h), 'pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fire(h, fab(h), 'pointermove', { pointerId: 1, clientX: 9000, clientY: 9000 });
    fire(h, fab(h), 'pointerup', { pointerId: 1 });
    assert.equal(parseInt(cssVar(h, '--aia-right'), 10), 8);
    assert.equal(parseInt(cssVar(h, '--aia-bottom'), 10), 8);
  } finally { await finish(h); }
});

test('posição salva é restaurada; janela menor reenquadra sem perder a posição desejada', async () => {
  const h = await mount({ storage: { right: 300, bottom: 200 } });
  try {
    assert.equal(cssVar(h, '--aia-right'), '300px');
    assert.equal(cssVar(h, '--aia-bottom'), '200px');
  } finally { await finish(h); }

  const h2 = await mount({ storage: { right: 1000, bottom: 700 }, size: [1280, 800] });
  try {
    assert.equal(cssVar(h2, '--aia-right'), '1000px');
    h2.window.innerWidth = 800;
    h2.window.innerHeight = 600;
    fire(h2, h2.window, 'resize');
    assert.equal(parseInt(cssVar(h2, '--aia-right'), 10), 800 - 52 - 8, 'reenquadrado para dentro da janela');
    assert.equal(parseInt(cssVar(h2, '--aia-bottom'), 10), 600 - 52 - 8);
    assert.deepEqual(saved(h2), { right: 1000, bottom: 700 }, 'a posição escolhida continua guardada');
    h2.window.innerWidth = 1280;
    h2.window.innerHeight = 800;
    fire(h2, h2.window, 'resize');
    assert.equal(cssVar(h2, '--aia-right'), '1000px', 'voltou onde estava ao crescer');
  } finally { await finish(h2); }
});

test('posição salva inválida cai no padrão', async () => {
  const h = await mount({ storage: { right: 'x', bottom: null } });
  try {
    assert.equal(cssVar(h, '--aia-right'), '24px');
    assert.equal(cssVar(h, '--aia-bottom'), '84px');
  } finally { await finish(h); }
});

test('teclado: Alt + setas movem o botão (e salvam); sem Alt nada muda', async () => {
  const h = await mount();
  try {
    const r0 = parseInt(cssVar(h, '--aia-right'), 10);
    const b0 = parseInt(cssVar(h, '--aia-bottom'), 10);
    const plain = key(h, fab(h), 'ArrowLeft');
    assert.equal(plain.defaultPrevented, false);
    assert.equal(parseInt(cssVar(h, '--aia-right'), 10), r0);

    const ev = key(h, fab(h), 'ArrowLeft', { altKey: true });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(parseInt(cssVar(h, '--aia-right'), 10), r0 + 16);
    key(h, fab(h), 'ArrowUp', { altKey: true, shiftKey: true });
    assert.equal(parseInt(cssVar(h, '--aia-bottom'), 10), b0 + 48);
    key(h, fab(h), 'ArrowRight', { altKey: true });
    key(h, fab(h), 'ArrowDown', { altKey: true });
    assert.deepEqual(saved(h), { right: r0, bottom: b0 + 32 });
  } finally { await finish(h); }
});

test('janela pequena (800x600): o painel cabe inteiro e fica ancorado ao botão', async () => {
  const h = await mount({ size: [800, 600] });
  try {
    click(h, fab(h));
    const p = panel(h);
    const w = parseInt(p.style.width, 10);
    const ht = parseInt(p.style.height, 10);
    const left = parseInt(p.style.left, 10);
    const top = parseInt(p.style.top, 10);
    assert.ok(left >= 8 && left + w <= 800 - 8, `horizontal ${left}+${w}`);
    assert.ok(top >= 8 && top + ht <= 600 - 8, `vertical ${top}+${ht}`);
    assert.ok(ht >= 240);
    // não cobre o botão (fica acima dele)
    const fabTop = 600 - parseInt(cssVar(h, '--aia-bottom'), 10) - 52;
    assert.ok(top + ht <= fabTop, 'painel acima do botão');
  } finally { await finish(h); }
});

// ------------------------------------------------------------- verificações estáticas

test('CSS: botão some sob visualizadores em tela cheia, respeita movimento reduzido e só usa tokens do app', () => {
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'components', 'ai-assistant.css'), 'utf8');
  for (const sel of ['.photo-preview-overlay', '.video-preview-overlay', '.audio-preview-overlay', '.preview-backdrop']) {
    assert.ok(css.includes(`body:has(${sel}:not(.hidden)) .aia-root`), sel);
  }
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /var\(--btn-bg\)/);
  // os nomes das classes dos visualizadores existem de verdade
  for (const f of ['photo-preview.css', 'video-preview.css', 'audio-preview.css', 'preview-popup.css']) {
    const txt = fs.readFileSync(path.join(ROOT, 'renderer', 'components', 'preview', f), 'utf8');
    assert.ok(/preview-(overlay|backdrop)/.test(txt), f);
  }
});

test('o assistente não é mais tela: sem botão no menu, sem arquivos ai.* e com CSS carregado no index', () => {
  const index = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  assert.doesNotMatch(index, /data-view="ai"/);
  assert.match(index, /components\/ai-assistant\.css/);
  for (const ext of ['html', 'css', 'js']) assert.equal(fs.existsSync(path.join(ROOT, 'renderer', 'screens', `ai.${ext}`)), false, `ai.${ext}`);
  const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /DEV_ONLY_SCREENS = \[[^\]]*'ai'/);
  assert.match(app, /components\/ai-assistant\.js/);
  const settings = fs.readFileSync(path.join(ROOT, 'renderer', 'screens', 'settings.html'), 'utf8');
  assert.doesNotMatch(settings, /<option value="ai"/);
  assert.match(settings, /id="aiAssistantEnabledInput"/);
});

test('o componente nunca usa innerHTML/outerHTML/insertAdjacentHTML/eval', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'components', 'ai-assistant.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // sem comentários
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});

// ------------------------------------------------------- Configurações: interruptor do assistente

test('Configurações: o interruptor "Ativar assistente" grava na configuração da IA e avisa o botão', async () => {
  const h = await mountScreen('settings', {
    bds: {
      aiGetConfig: { ok: true, data: { assistantEnabled: true, customInstructions: 'seja breve', presets: [], model: 'm', baseUrl: 'http://localhost:1234/v1', maxTokens: 512, hasKey: false } },
      aiSaveConfig: async (patch) => ({ ok: true, data: { assistantEnabled: patch.assistantEnabled !== false } })
    }
  });
  try {
    await settle(60);
    const sw = h.document.getElementById('aiAssistantEnabledInput');
    const text = h.document.getElementById('aiAssistantInstructionsInput');
    assert.ok(sw && text);
    assert.equal(sw.checked, true);
    assert.equal(text.value, 'seja breve');
    let notified = 0;
    h.window.addEventListener('bds:ai-assistant-changed', () => { notified++; });
    sw.checked = false;
    fire(h, sw, 'change');
    await settle(20);
    assert.deepEqual(h.bds.calls.aiSaveConfig.at(-1), [{ assistantEnabled: false }]);
    assert.equal(notified, 1);
    assert.match(h.document.getElementById('aiAssistantStatus').textContent, /desativado/);

    text.value = 'responda em uma frase';
    fire(h, h.document.getElementById('aiAssistantInstructionsSave'), 'click');
    await settle(20);
    assert.deepEqual(h.bds.calls.aiSaveConfig.at(-1), [{ customInstructions: 'responda em uma frase' }]);
  } finally { await h.cleanup(); }
});


// ------------------------------------------------- fases 2 e 3: linhas de status e formatação parcial

/** Envia uma pergunta e deixa o painel esperando a resposta. */
async function ask(h, text = 'Quais vídeos eu tenho?') {
  click(h, fab(h));
  input(h).value = text;
  key(h, input(h), 'Enter');
  await settle(10);
}
const statusRows = (h) => h.document.querySelectorAll('.aia-msg-status');
const answerBubble = (h) => q(h, '.aia-msg-assistant .aia-bubble');

test('status: "Consultando a Biblioteca…" aparece como linha discreta (textContent) no lugar do "Pensando…" e some quando o texto chega', async () => {
  const h = await mount();
  try {
    await ask(h);
    assert.match(answerBubble(h).textContent, /Pensando/);
    h.bds.emit('onAiChatStatus', { id: 'c1', text: 'Consultando a Biblioteca…', kind: 'tool' });
    assert.equal(statusRows(h).length, 1);
    assert.equal(q(h, '.aia-status').textContent, 'Consultando a Biblioteca…');
    assert.equal(answerBubble(h).parentElement.hidden, true, 'sem texto ainda: só a linha de status aparece');
    // o mesmo status atualiza no lugar (progresso), sem empilhar linhas
    h.bds.emit('onAiChatStatus', { id: 'c1', text: 'Aguardando sua confirmação…', kind: 'confirm' });
    h.bds.emit('onAiChatStatus', { id: 'c1', text: 'Transcrevendo… 40%', kind: 'tool' });
    assert.equal(statusRows(h).length, 1);
    assert.equal(q(h, '.aia-status').textContent, 'Transcrevendo… 40%');
    // outra conversa não mexe nesta
    h.bds.emit('onAiChatStatus', { id: 'outra', text: 'INTRUSO', kind: 'tool' });
    assert.equal(q(h, '.aia-status').textContent, 'Transcrevendo… 40%');
    // limpar (fim da ferramenta) e depois o texto
    h.bds.emit('onAiChatStatus', { id: 'c1', text: '', kind: 'clear' });
    assert.equal(statusRows(h).length, 0);
    assert.equal(answerBubble(h).parentElement.hidden, false);
    h.bds.emit('onAiChatStatus', { id: 'c1', text: 'Consultando os Projetos…', kind: 'tool' });
    h.bds.emit('onAiChatDelta', { id: 'c1', text: 'Você tem 3 aulas.' });
    await settle(30);
    assert.equal(statusRows(h).length, 0, 'o texto chegando apaga a linha de status');
    assert.match(answerBubble(h).textContent, /Você tem 3 aulas\./);
    h.bds.emit('onAiChatDone', { id: 'c1', text: 'Você tem 3 aulas.', finishReason: 'stop' });
    await settle(10);
    assert.equal(statusRows(h).length, 0);
    assert.equal(h.document.querySelectorAll('.aia-msg-assistant').length, 1);
  } finally { await finish(h); }
});

test('status: texto nunca vira HTML; aviso (notice) fica na conversa; erro e cancelamento limpam a linha', async () => {
  const h = await mount();
  try {
    await ask(h);
    h.bds.emit('onAiChatStatus', { id: 'c1', text: '<img src=x onerror=alert(1)>', kind: 'tool' });
    assert.equal(q(h, '.aia-status').querySelector('img'), null);
    assert.equal(q(h, '.aia-status').textContent, '<img src=x onerror=alert(1)>');
    h.bds.emit('onAiChatStatus', { id: 'c1', text: 'Este modelo não permite consultar nem alterar o app. Vou responder só em conversa.', kind: 'notice' });
    assert.equal(h.document.querySelectorAll('.aia-msg-note').length, 1);
    h.bds.emit('onAiChatDelta', { id: 'c1', text: 'Olá.' });
    h.bds.emit('onAiChatDone', { id: 'c1', text: 'Olá.', finishReason: 'stop' });
    await settle(30);
    assert.equal(h.document.querySelectorAll('.aia-msg-note').length, 1, 'o aviso continua na conversa');
    assert.equal(statusRows(h).length, 0);
  } finally { await finish(h); }
  const e = await mount();
  try {
    await ask(e);
    e.bds.emit('onAiChatStatus', { id: 'c1', text: 'Consultando a Biblioteca…', kind: 'tool' });
    e.bds.emit('onAiChatError', { id: 'c1', error: 'Falha qualquer', code: null });
    await settle(10);
    assert.equal(statusRows(e).length, 0);
    assert.equal(input(e).value, 'Quais vídeos eu tenho?', 'a pergunta volta ao campo');
  } finally { await finish(e); }
  const c = await mount();
  try {
    await ask(c);
    c.bds.emit('onAiChatStatus', { id: 'c1', text: 'Aguardando sua confirmação…', kind: 'confirm' });
    c.bds.emit('onAiChatDone', { id: 'c1', text: '', cancelled: true });
    await settle(10);
    assert.equal(statusRows(c).length, 0);
    assert.equal(c.document.querySelectorAll('.aia-msg-assistant').length, 0);
  } finally { await finish(c); }
});

test('painel continua só com chat durante ações: sem cartões, botões de confirmar nem configurações (a confirmação é um diálogo nativo do app)', async () => {
  const h = await mount();
  try {
    await ask(h);
    h.bds.emit('onAiChatStatus', { id: 'c1', text: 'Aguardando sua confirmação…', kind: 'confirm' });
    const p = panel(h);
    const buttons = [...p.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    assert.deepEqual(buttons, ['Limpar conversa', 'Fechar assistente', 'Parar resposta']);
    assert.equal(p.querySelectorAll('input, select, details, a').length, 0);
    // o renderer não tem nenhum canal para acionar ferramentas ou confirmar: só fala o texto e cancela
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'components', 'ai-assistant.js'), 'utf8');
    const used = [...src.matchAll(/bds\(\)\.(\w+)/g)].map((m) => m[1]).filter((n) => /^ai[A-Z]/.test(n));
    // aiSaveConfig: só o botão "Entendi, continuar" do aviso de privacidade (grava o aceite do servidor atual)
    assert.deepEqual([...new Set(used)].sort(), ['aiChatCancel', 'aiChatStart', 'aiGetConfig', 'aiHistoryClear', 'aiHistoryGet', 'aiSaveConfig']);
  } finally { await finish(h); }
});

test('partialSafe: marcas ainda não fechadas (**, `, ```) não aparecem cruas; as fechadas ficam', async () => {
  const h = await mount();
  try {
    const { partialSafe } = h.mod;
    const cases = [
      ['Isto é **neg', 'Isto é neg'],
      ['Isto é **negrito**', 'Isto é **negrito**'],
      ['Isto é **negrito*', 'Isto é negrito'],
      ['Isto é *', 'Isto é '],
      ['Use `cod', 'Use cod'],
      ['Use `cod`', 'Use `cod`'],
      ['Use `a` e `b', 'Use `a` e b'],
      ['Texto ``', 'Texto '],
      ['Texto `', 'Texto '],
      ['Linha **fechada**\nOutra **aberta', 'Linha **fechada**\nOutra aberta'],
      ['```js\nconst a = 1;', '```js\nconst a = 1;'],
      ['```js\nconst a = 1;\n``', '```js\nconst a = 1;\n'],
      ['```js\ncod\n```\ndepois **aberto', '```js\ncod\n```\ndepois aberto'],
      ['* item', '* item'],
      ['', '']
    ];
    for (const [text, expected] of cases) assert.equal(partialSafe(text), expected, JSON.stringify(text));
  } finally { await finish(h); }
});

test('streaming: formatação aberta não aparece crua e vira negrito/código quando fecha', async () => {
  const h = await mount();
  try {
    await ask(h);
    const step = async (piece) => { h.bds.emit('onAiChatDelta', { id: 'c1', text: piece }); await settle(30); };
    await step('Você tem **3 aul');
    assert.doesNotMatch(answerBubble(h).textContent, /\*/);
    assert.equal(answerBubble(h).querySelector('strong'), null);
    await step('as** e o arquivo `a.');
    assert.equal(answerBubble(h).querySelector('strong').textContent, '3 aulas');
    assert.doesNotMatch(answerBubble(h).textContent, /\*|`/);
    await step('mp4`');
    assert.equal(answerBubble(h).querySelector('code').textContent, 'a.mp4');
    h.bds.emit('onAiChatDone', { id: 'c1', text: 'Você tem **3 aulas** e o arquivo `a.mp4`', finishReason: 'stop' });
    await settle(10);
    assert.equal(answerBubble(h).querySelector('strong').textContent, '3 aulas');
  } finally { await finish(h); }
});
