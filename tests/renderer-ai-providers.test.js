'use strict';

// Provedores de IA no renderer: painel em Configurações > Inteligência Artificial (cartões, ordem, chave nunca
// ecoada, aviso do preset de endereço não confirmado, estado vazio, fallback) e o chat (nome do provedor no
// cabeçalho, linha "Usando X (Y indisponível)" e troca de texto parcial). O painel conversa com o AIService REAL
// (sem rede: fetch simulado).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mountScreen, settle } = require('./helpers/renderer-harness');
const AIService = require('../src/services/ai/AIService');

const ROOT = path.join(__dirname, '..');
const PANEL = pathToFileURL(path.join(ROOT, 'renderer', 'components', 'analysis-panel.js')).href;
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${s}`), decryptString: (b) => b.toString().replace(/^enc:/, '') };
const dirs = [];
let seq = 0;
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Painel ligado a um AIService real; o fetch simulado só responde /models. */
async function mountPanel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-aipanel-'));
  dirs.push(dir);
  const fetched = [];
  const ai = new AIService({
    configDir: dir,
    safeStorage,
    fetchImpl: async (url, opts) => {
      fetched.push({ url: String(url), auth: opts.headers.authorization });
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'modelo-a' }, { id: 'modelo-b' }] }) };
    }
  });
  const wrap = (fn) => async (...a) => { try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message, code: e.code }; } };
  const h = await mountScreen('luts', {
    init: false,
    bds: {
      aiGetConfig: wrap(() => ai.getPublicConfig()),
      aiSaveConfig: wrap((p) => ai.saveConfig(p)),
      aiTestConnection: wrap((id) => ai.testConnection(id)),
      aiListModels: wrap((id) => ai.listModels(id))
    }
  });
  const host = h.document.createElement('div');
  h.document.body.append(host);
  const mod = await import(`${PANEL}?t=${++seq}`);
  await mod.mountAnalysisPanel(host);
  await settle(20);
  return { h, host, ai, mod, fetched };
}

const fire = (h, el, type, props = {}) => { const ev = new h.window.Event(type, { bubbles: true, cancelable: true }); Object.assign(ev, props); el.dispatchEvent(ev); };
const click = (h, el) => fire(h, el, 'click');
const cards = (host) => [...host.querySelectorAll('.ana-prov')];
const names = (host) => cards(host).map((c) => c.querySelector('.ana-prov-title strong').textContent);
const preset = (host, id) => host.querySelector(`.ana-preset[data-preset="${id}"]`);
const add = async (h, host, id) => { click(h, preset(host, id)); await settle(20); };
const stop = async (t) => { t.h.cleanup && await t.h.cleanup(); };

test('estado vazio: texto curto, "Adicionar provedor" com os 7 presets na ordem e nada de interruptor de fallback', async () => {
  const t = await mountPanel();
  assert.equal(cards(t.host).length, 0);
  assert.match(t.host.querySelector('.ana-empty').textContent, /Nenhum provedor ainda/);
  assert.match(t.host.querySelector('.mod-state').textContent, /Não configurada/);
  assert.match(t.host.querySelector('.ana-add-btn').textContent, /Adicionar provedor/);
  assert.deepEqual([...t.host.querySelectorAll('.ana-preset')].map((b) => b.textContent),
    ['Groq', 'Qwen (Alibaba)', 'Qwen (outro endereço)', 'LM Studio (local)', 'Ollama (local)', 'OpenAI', 'Personalizado']);
  assert.equal(t.host.querySelector('.ana-fallback'), null, 'com menos de 2 provedores o interruptor não aparece');
  await stop(t);
});

test('adicionar preset: o cartão traz nome, estado, modelo sugerido e a chave pedida; só o endereço não confirmado mostra aviso', async () => {
  const t = await mountPanel();
  await add(t.h, t.host, 'groq');
  let card = cards(t.host)[0];
  assert.equal(names(t.host)[0], 'Groq');
  assert.match(card.querySelector('.ana-state').textContent, /Sem chave/);
  assert.equal(card.querySelector('.ana-model').value, 'llama-3.3-70b-versatile');
  assert.equal(card.querySelector('.ana-key').getAttribute('type'), 'password');
  assert.equal(card.querySelector('.ana-note'), null, 'Groq não tem aviso de endereço');
  assert.match(card.querySelector('.ana-where').textContent, /Servidor externo \(api\.groq\.com\)/);

  await add(t.h, t.host, 'qwen');
  card = cards(t.host)[1];
  assert.equal(card.querySelector('.ana-model').value, 'qwen-plus');
  assert.equal(card.querySelector('.ana-note'), null, 'Qwen no endereço oficial não avisa');
  assert.match(card.querySelector('.ana-where').textContent, /dashscope-intl\.aliyuncs\.com/);

  await add(t.h, t.host, 'qwen-alt');
  card = cards(t.host)[2];
  assert.equal(names(t.host)[2], 'Qwen (outro endereço)');
  const note = card.querySelector('.ana-note');
  assert.ok(note);
  assert.match(note.textContent, /não confirmado como oficial: use só se você confia nele/i);
  assert.match(t.host.querySelector('#anaStatus').textContent, /não confirmado como oficial/i, 'o aviso também aparece ao escolher o preset');
  assert.equal(t.host.querySelectorAll('.ana-note').length, 1);
  assert.match(t.host.querySelector('.mod-state').textContent, /Não configurada/);
  await stop(t);
});

test('chave: só "Chave guardada" (nunca o valor); Trocar abre o campo vazio; Remover apaga; cada provedor tem a sua', async () => {
  const t = await mountPanel();
  await add(t.h, t.host, 'groq');
  await add(t.h, t.host, 'qwen');
  const [groq] = cards(t.host);
  groq.querySelector('.ana-key').value = 'sk-groq-segredo-111';
  click(t.h, groq.querySelector('.ana-save'));
  await settle(60);
  const g = cards(t.host)[0];
  assert.match(g.textContent, /Chave guardada/);
  assert.equal(g.querySelector('.ana-key'), null, 'sem campo de chave quando já há uma guardada');
  assert.match(g.querySelector('.ana-state').textContent, /Aviso pendente|Ativo/);
  assert.ok(!t.h.document.body.innerHTML.includes('sk-groq-segredo'), 'a chave não aparece em lugar nenhum da tela');
  assert.ok(!t.h.document.body.textContent.includes('sk-groq-segredo'));
  assert.equal(t.fetched.at(-1).auth, 'Bearer sk-groq-segredo-111', 'o teste usou a chave do Groq');
  assert.ok(t.fetched.every((f) => f.url.startsWith('https://api.groq.com')), 'a chave do Groq só foi ao Groq');
  assert.match(cards(t.host)[1].textContent, /Obrigatória/, 'o Qwen continua sem chave própria');
  assert.equal(cards(t.host)[1].querySelector('.ana-key').value, '');

  click(t.h, g.querySelector('.ana-key-change'));
  await settle(10);
  const field = cards(t.host)[0].querySelector('.ana-key');
  assert.ok(field);
  assert.equal(field.value, '', 'o campo de troca nasce vazio');

  // recarrega a lista: continua guardada; remover volta ao campo
  field.value = '';
  await t.ai.saveConfig({ provider: { id: t.ai.getPublicConfig().providers[0].id, apiKey: 'sk-groq-outra-chave-2' } });
  await t.mod.mountAnalysisPanel(t.host);
  await settle(20);
  assert.match(cards(t.host)[0].textContent, /Chave guardada/);
  click(t.h, cards(t.host)[0].querySelector('.ana-key-remove'));
  await settle(20);
  assert.ok(cards(t.host)[0].querySelector('.ana-key'));
  assert.equal(t.ai.getPublicConfig().providers[0].hasKey, false);
  await stop(t);
});

test('modelos: o botão de atualizar lista os modelos do próprio provedor', async () => {
  const t = await mountPanel();
  await add(t.h, t.host, 'groq');
  const card = cards(t.host)[0];
  card.querySelector('.ana-key').value = 'sk-groq-segredo-111';
  click(t.h, card.querySelector('.ana-refresh'));
  await settle(60);
  const opts = [...t.host.querySelectorAll('.ana-prov datalist option')].map((o) => o.getAttribute('value'));
  assert.deepEqual(opts, ['modelo-a', 'modelo-b']);
  assert.match(t.host.querySelector('[data-status]').textContent, /2 modelo\(s\)/);
  await stop(t);
});

test('ordem: Subir/Descer reordenam (primeiro sem Subir, último sem Descer) e o foco continua no botão', async () => {
  const t = await mountPanel();
  for (const id of ['groq', 'qwen', 'ollama']) await add(t.h, t.host, id);
  assert.deepEqual(names(t.host), ['Groq', 'Qwen (Alibaba)', 'Ollama (local)']);
  const cs = cards(t.host);
  assert.equal(cs[0].querySelector('.ana-up').disabled, true);
  assert.equal(cs[2].querySelector('.ana-down').disabled, true);
  assert.equal(cs[1].querySelector('.ana-up').getAttribute('aria-label'), 'Subir Qwen (Alibaba)');
  // linkedom não tem document.activeElement: registra quem recebeu o foco
  const proto = t.h.window.HTMLElement.prototype;
  const origFocus = proto.focus;
  let lastFocus = null;
  proto.focus = function focus(...args) { lastFocus = this; return origFocus ? origFocus.apply(this, args) : undefined; };
  click(t.h, cs[1].querySelector('.ana-up'));
  await settle(20);
  proto.focus = origFocus;
  assert.deepEqual(names(t.host), ['Qwen (Alibaba)', 'Groq', 'Ollama (local)']);
  // chegou ao topo: o "Subir" ficou desabilitado e o foco vai para o "Descer" do mesmo cartão
  assert.equal(cards(t.host)[0].querySelector('.ana-up').disabled, true);
  assert.equal(lastFocus === cards(t.host)[0].querySelector('.ana-down'), true);
  click(t.h, cards(t.host)[1].querySelector('.ana-down'));
  await settle(20);
  assert.deepEqual(names(t.host), ['Qwen (Alibaba)', 'Ollama (local)', 'Groq']);
  assert.deepEqual(t.ai.getPublicConfig().providers.map((p) => p.label), ['Qwen (Alibaba)', 'Ollama (local)', 'Groq']);
  await stop(t);
});

test('fallback e ativação: o interruptor só aparece com 2+ provedores; Ativar liga/desliga e o estado acompanha', async () => {
  const t = await mountPanel();
  await add(t.h, t.host, 'ollama');
  assert.equal(t.host.querySelector('.ana-fallback'), null);
  await add(t.h, t.host, 'lmstudio');
  const sw = t.host.querySelector('#anaFallback');
  assert.ok(sw);
  assert.match(t.host.querySelector('.ana-fallback-text strong').textContent, /Usar o próximo provedor se este falhar \(mantém a conversa\)/);
  assert.equal(sw.checked, true);
  sw.checked = false;
  fire(t.h, sw, 'change');
  await settle(20);
  assert.equal(t.ai.getPublicConfig().fallbackEnabled, false);
  assert.equal(Boolean(t.host.querySelector('#anaFallback').checked), false);

  const on = cards(t.host)[0].querySelector('.ana-enabled');
  assert.equal(on.getAttribute('aria-label'), 'Ativar Ollama (local)');
  on.checked = false;
  fire(t.h, on, 'change');
  await settle(20);
  assert.match(cards(t.host)[0].querySelector('.ana-state').textContent, /Desligado/);
  await stop(t);
});

test('remover provedor pede confirmação; cancelar mantém, confirmar remove', async () => {
  const t = await mountPanel();
  await add(t.h, t.host, 'ollama');
  await add(t.h, t.host, 'lmstudio');
  click(t.h, cards(t.host)[0].querySelector('.ana-remove'));
  await settle(10);
  assert.match(cards(t.host)[0].querySelector('.ana-confirm').textContent, /Remover Ollama \(local\)\? A chave guardada dele também será apagada/);
  assert.equal(t.ai.getPublicConfig().providers.length, 2, 'ainda não removeu');
  click(t.h, cards(t.host)[0].querySelector('.ana-remove-no'));
  await settle(10);
  assert.equal(cards(t.host).length, 2);
  click(t.h, cards(t.host)[0].querySelector('.ana-remove'));
  await settle(10);
  click(t.h, cards(t.host)[0].querySelector('.ana-remove-yes'));
  await settle(20);
  assert.deepEqual(names(t.host), ['LM Studio (local)']);
  assert.equal(t.ai.getPublicConfig().providers.length, 1);
  await stop(t);
});

test('aviso de servidor externo por provedor: só os remotos têm a caixa de aceite; local não avisa', async () => {
  const t = await mountPanel();
  await add(t.h, t.host, 'groq');
  await add(t.h, t.host, 'ollama');
  const [groq, ollama] = cards(t.host);
  assert.ok(groq.querySelector('.ana-accept'));
  assert.equal(Boolean(groq.querySelector('.ana-accept').checked), false);
  assert.equal(ollama.querySelector('.ana-accept'), null);
  assert.match(ollama.querySelector('.ana-where').textContent, /não sai dela/);
  const box = groq.querySelector('.ana-accept');
  box.checked = true;
  fire(t.h, box, 'change');
  await settle(20);
  assert.equal(t.ai.getPublicConfig().providers[0].needsRemoteConsent, false);
  await stop(t);
});

test('acessibilidade: cartões são grupos nomeados, campos têm rótulo e o painel só usa textContent', async () => {
  const t = await mountPanel();
  await add(t.h, t.host, 'groq');
  const card = cards(t.host)[0];
  assert.equal(card.getAttribute('role'), 'group');
  assert.equal(t.host.querySelector(`#${card.getAttribute('aria-labelledby')}`).textContent, 'Groq');
  for (const input of card.querySelectorAll('input:not([type="checkbox"])')) {
    const id = input.getAttribute('id');
    assert.ok(!id || t.host.querySelector(`label[for="${id}"]`), `rótulo para ${id}`);
  }
  for (const b of card.querySelectorAll('button.mod-icon-btn')) assert.ok(b.getAttribute('aria-label'));
  assert.equal(fs.readFileSync(path.join(ROOT, 'renderer', 'components', 'analysis-panel.js'), 'utf8').includes('innerHTML'), false);
  await stop(t);
});

// ----------------------------------------------------------------------------- chat

async function mountChat({ activeProvider = { id: 'p1', label: 'Groq' } } = {}) {
  const h = await mountScreen('aiassistant', {
    modulePath: '../components/ai-assistant.js',
    html: '',
    init: false,
    bds: {
      isPackaged: true,
      modulesList: { ok: true, data: [{ id: 'ai', enabled: true }] },
      aiGetConfig: { ok: true, data: { assistantEnabled: true, activeProvider } },
      aiHistoryGet: { ok: true, data: { messages: [], busy: false } },
      aiChatCancel: { ok: true, data: true },
      aiChatStart: { ok: true, data: { id: 'c1' } },
      aiSaveConfig: { ok: true, data: {} }
    }
  });
  await h.mod.mountAssistant();
  await settle(20);
  return h;
}
const q = (h, sel) => h.document.querySelector(sel);
const qa = (h, sel) => [...h.document.querySelectorAll(sel)];
async function ask(h, text = 'oi') {
  click(h, q(h, '#aiAssistantFab'));
  const input = q(h, '.aia-input');
  input.value = text;
  fire(h, input, 'keydown', { key: 'Enter' });
  await settle(20);
}

test('chat: o nome do provedor em uso aparece em texto pequeno no cabeçalho e o painel continua só com chat', async () => {
  const h = await mountChat();
  try {
    click(h, q(h, '#aiAssistantFab'));
    await settle(20);
    const el = q(h, '.aia-head .aia-provider');
    assert.equal(el.textContent, 'Groq');
    assert.equal(el.hidden, false);
    assert.deepEqual(qa(h, '#aiAssistantPanel button').map((b) => b.getAttribute('aria-label')), ['Limpar conversa', 'Fechar assistente', 'Enviar']);
  } finally { h.mod.unmountAssistant(); await h.cleanup(); }
});

test('chat: sem provedor ativo o nome fica escondido', async () => {
  const h = await mountChat({ activeProvider: null });
  try {
    click(h, q(h, '#aiAssistantFab'));
    await settle(20);
    assert.equal(q(h, '.aia-head .aia-provider').hidden, true);
  } finally { h.mod.unmountAssistant(); await h.cleanup(); }
});

test('chat: fallback vira uma linha discreta "Usando X (Y indisponível)" e o cabeçalho passa a mostrar o novo provedor', async () => {
  const h = await mountChat();
  try {
    await ask(h);
    h.bds.emit('onAiChatStatus', { id: 'c1', kind: 'provider', text: 'Qwen (Alibaba)' });
    h.bds.emit('onAiChatStatus', { id: 'c1', kind: 'fallback', text: 'Usando Qwen (Alibaba) (Groq indisponível)' });
    await settle(10);
    assert.equal(q(h, '.aia-provider').textContent, 'Qwen (Alibaba)');
    const line = q(h, '.aia-msg-fallback');
    assert.ok(line);
    assert.equal(line.textContent, 'Usando Qwen (Alibaba) (Groq indisponível)');
    // o fallback trocou de novo no mesmo turno: a linha é atualizada, não repetida
    h.bds.emit('onAiChatStatus', { id: 'c1', kind: 'fallback', text: 'Usando Ollama (Groq indisponível; Qwen (Alibaba) indisponível)' });
    await settle(10);
    assert.equal(qa(h, '.aia-msg-fallback').length, 1);
    assert.match(q(h, '.aia-msg-fallback').textContent, /^Usando Ollama/);
    h.bds.emit('onAiChatDelta', { id: 'c1', text: 'Resposta' });
    h.bds.emit('onAiChatDone', { id: 'c1', text: 'Resposta', cancelled: false });
    await settle(30);
    assert.ok(q(h, '.aia-msg-fallback'), 'a linha continua na conversa depois da resposta');
    assert.match(qa(h, '.aia-msg-assistant').map((m) => m.textContent).join('|'), /Resposta/);
  } finally { h.mod.unmountAssistant(); await h.cleanup(); }
});

test('chat: falha no meio da resposta troca o texto parcial pelo do próximo provedor (reset)', async () => {
  const h = await mountChat();
  try {
    await ask(h);
    h.bds.emit('onAiChatDelta', { id: 'c1', text: 'Resposta parc' });
    await settle(30);
    assert.match(q(h, '.aia-msg-pending, .aia-msg-assistant:last-child').textContent, /parc/);
    h.bds.emit('onAiChatStatus', { id: 'c1', kind: 'reset', text: '' });
    await settle(10);
    assert.ok(!qa(h, '.aia-bubble').some((b) => /parc/.test(b.textContent)), 'o parcial saiu da tela');
    h.bds.emit('onAiChatDelta', { id: 'c1', text: 'Resposta completa.' });
    h.bds.emit('onAiChatDone', { id: 'c1', text: 'Resposta completa.', cancelled: false });
    await settle(30);
    const texts = qa(h, '.aia-msg-assistant .aia-bubble').map((b) => b.textContent);
    assert.equal(texts.filter((t) => /Resposta completa\./.test(t)).length, 1, 'sem duplicar');
    assert.ok(!texts.some((t) => /parc/.test(t)));
  } finally { h.mod.unmountAssistant(); await h.cleanup(); }
});

test('chat: todos falharam mostra a mensagem do main e o botão "Abrir configurações da IA"', async () => {
  const h = await mountChat();
  try {
    await ask(h);
    h.bds.emit('onAiChatStatus', { id: 'c1', kind: 'fallback', text: 'Usando Qwen (Alibaba) (Groq indisponível)' });
    h.bds.emit('onAiChatError', { id: 'c1', code: 'AI_ALL_FAILED', error: 'Não consegui usar nenhum servidor de IA agora: Groq (limite de uso atingido); Qwen (chave recusada). Confira as configurações da IA.' });
    await settle(20);
    const guide = q(h, '.aia-msg-guide');
    assert.ok(guide);
    assert.match(guide.textContent, /Groq \(limite de uso atingido\); Qwen \(chave recusada\)/);
    assert.match(guide.querySelector('button').textContent, /Abrir configurações da IA/);
    assert.equal(qa(h, '.aia-msg-error').length, 0);
    assert.equal(qa(h, '.aia-msg-fallback').length, 0, 'a linha "Usando..." de uma resposta que falhou de vez não fica na conversa');
  } finally { h.mod.unmountAssistant(); await h.cleanup(); }
});

test('CSS: a linha de troca e o nome do provedor são discretos e usam os tokens do app', () => {
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'components', 'ai-assistant.css'), 'utf8');
  assert.match(css, /\.aia-provider\s*\{[^}]*color: var\(--muted\)/);
  assert.match(css, /\.aia-msg-fallback \.aia-bubble/);
  const panel = fs.readFileSync(path.join(ROOT, 'renderer', 'components', 'modules-panel.css'), 'utf8');
  assert.match(panel, /\.ana-prov \{/);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(panel.slice(panel.indexOf('Provedores de IA: lista'), panel.indexOf('Painel embutido'))), 'cores só por tokens');
});
