'use strict';

// Provedores de IA no renderer: painel em Configurações > Inteligência Artificial (cartões, ordem, chave nunca
// ecoada, aviso do preset de endereço não confirmado, estado vazio, fallback, o fluxo "Adicionar provedor" por
// endereço e chave com busca de modelos) e o chat (nome do provedor no cabeçalho, linha "Usando X (Y indisponível)"
// e troca de texto parcial). O painel conversa com o AIService REAL (sem rede: fetch simulado).

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

/**
 * Painel ligado a um AIService real; o fetch simulado só responde /models (t.respond troca a resposta: modelos ou erro).
 * t.log guarda a ordem das chamadas ao main ('save', 'discover' com a entrada sem a chave, 'list').
 */
async function mountPanel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-aipanel-'));
  dirs.push(dir);
  const fetched = [];
  const respond = { status: 200, body: { data: [{ id: 'modelo-a' }, { id: 'modelo-b' }] } };
  const ai = new AIService({
    configDir: dir,
    safeStorage,
    fetchImpl: async (url, opts) => {
      fetched.push({ url: String(url), auth: opts.headers.authorization, headers: opts.headers });
      if (respond.gate) await respond.gate;   // o teste segura a resposta para olhar a tela durante a busca
      return { ok: respond.status < 400, status: respond.status, text: async () => (typeof respond.body === 'string' ? respond.body : JSON.stringify(respond.body)) };
    }
  });
  const log = [];
  const wrap = (fn, name) => async (...a) => {
    // a chave real nunca entra no registro do teste: só a marca "(chave)"
    const seen = (i) => { const o = { ...i }; if (o.apiKey) o.apiKey = '(chave)'; return o; };
    if (name) log.push(name === 'discover' ? { name, input: a[0] && typeof a[0] === 'object' ? seen(a[0]) : a[0] } : { name });
    try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message, code: e.code }; }
  };
  const h = await mountScreen('luts', {
    init: false,
    bds: {
      aiGetConfig: wrap(() => ai.getPublicConfig()),
      aiSaveConfig: wrap((p) => ai.saveConfig(p), 'save'),
      aiTestConnection: wrap((id) => ai.testConnection(id)),
      aiListModels: wrap((id) => ai.listModels(id), 'list'),
      aiDiscoverProvider: wrap((i) => ai.discoverProvider(i), 'discover'),
      // seção Áudio do card (só para ela carregar; o catálogo vem de aiGetConfig)
      modulesCloudGet: { ok: true, data: { encryptionAvailable: true, providers: [] } },
      modulesGetStatus: { ok: true, data: { whisper: { ready: true, engine: { installed: true }, models: [] } } }
    }
  });
  const host = h.document.createElement('div');
  h.document.body.append(host);
  const mod = await import(`${PANEL}?t=${++seq}`);
  await mod.mountAnalysisPanel(host);
  await settle(20);
  return { h, host, ai, mod, fetched, respond, log };
}

const fire = (h, el, type, props = {}) => { const ev = new h.window.Event(type, { bubbles: true, cancelable: true }); Object.assign(ev, props); el.dispatchEvent(ev); };
const click = (h, el) => fire(h, el, 'click');
const cards = (host) => [...host.querySelectorAll('.ana-prov')];
const names = (host) => cards(host).map((c) => c.querySelector('.ana-prov-title strong').textContent);
const preset = (host, id) => host.querySelector(`.ana-preset[data-preset="${id}"]`);
// Cria o provedor direto no main (sem o fluxo de busca) e recarrega o painel: os testes que não são do fluxo "Adicionar provedor" usam isto
const add = async (t, id) => { await t.ai.saveConfig({ addProvider: { preset: id } }); await t.mod.reloadAnalysisPanel(); await settle(20); };
const stop = async (t) => { t.h.cleanup && await t.h.cleanup(); };

test('estado vazio: texto curto, "Adicionar provedor" aberto com os 6 atalhos na ordem e nada de interruptor de fallback', async () => {
  const t = await mountPanel();
  assert.equal(cards(t.host).length, 0);
  assert.match(t.host.querySelector('.ana-empty').textContent, /Nenhum provedor ainda/);
  assert.match(t.host.querySelector('.mod-state').textContent, /Não configurada/);
  assert.match(t.host.querySelector('.ana-add-btn').textContent, /Adicionar provedor/);
  assert.equal(t.host.querySelector('.ana-add').hasAttribute('open'), true, 'sem provedores o bloco já nasce aberto');
  assert.deepEqual([...t.host.querySelectorAll('.ana-preset')].map((b) => b.textContent),
    ['Groq', 'Qwen', 'OpenAI', 'Anthropic', 'LM Studio (local)', 'Ollama (local)']);
  assert.equal(t.host.querySelector('.ana-add-url').getAttribute('type'), 'text');
  assert.equal(t.host.querySelector('.ana-add-key').getAttribute('type'), 'password');
  const primary = [...t.host.querySelectorAll('.ana-add .mod-btn-primary')];
  assert.equal(primary.length, 1, 'um botão primário só');
  assert.match(primary[0].textContent, /Procurar modelos/);
  assert.match(t.host.querySelector('.ana-add-note').textContent, /A chave é enviada só a este endereço, para listar os modelos\./);
  assert.equal(t.host.querySelector('.ana-fallback'), null, 'com menos de 2 provedores o interruptor não aparece');
  await stop(t);
});

test('adicionar preset: o cartão traz nome, estado, modelo sugerido e a chave pedida; nenhum preset atual mostra aviso de endereço', async () => {
  const t = await mountPanel();
  await add(t, 'groq');
  let card = cards(t.host)[0];
  assert.equal(names(t.host)[0], 'Groq');
  assert.match(card.querySelector('.ana-state').textContent, /Sem chave/);
  assert.equal(card.querySelector('.ana-model').value, 'llama-3.3-70b-versatile');
  assert.equal(card.querySelector('.ana-key').getAttribute('type'), 'password');
  assert.equal(card.querySelector('.ana-note'), null, 'Groq não tem aviso de endereço');
  assert.match(card.querySelector('.ana-where').textContent, /Servidor externo \(api\.groq\.com\)/);

  await add(t, 'qwencloud');
  card = cards(t.host)[1];
  assert.equal(names(t.host)[1], 'Qwen');
  assert.equal(card.querySelector('.ana-model').value, 'qwen-plus');
  assert.equal(card.querySelector('.ana-note'), null, 'QwenCloud é endereço oficial (docs.qwencloud.com): sem aviso');
  assert.match(card.querySelector('.ana-where').textContent, /maas\.qwencloudapi\.com/);
  assert.doesNotMatch(t.host.querySelector('#anaStatus').textContent, /não confirmado/i);
  assert.equal(t.host.querySelectorAll('.ana-note').length, 0, 'nenhum dos presets atuais é de origem não confirmada');
  assert.match(t.host.querySelector('.mod-state').textContent, /Não configurada/);
  await stop(t);
});

test('chave: o campo fica sempre à vista e vazio (nunca o valor); sem "Trocar"; vazio não muda nada; Remover pede confirmação; cada provedor tem a sua', async () => {
  const t = await mountPanel();
  await add(t, 'groq');
  await add(t, 'qwencloud');
  const [groq] = cards(t.host);
  assert.equal(groq.querySelector('.ana-key').getAttribute('placeholder'), 'Cole a chave aqui');
  assert.equal(groq.querySelector('.ana-key-remove'), null, 'sem chave guardada não há o que remover');
  groq.querySelector('.ana-key').value = 'sk-groq-segredo-111';
  click(t.h, groq.querySelector('.ana-save'));
  await settle(60);
  const g = cards(t.host)[0];
  const field = g.querySelector('.ana-key');
  assert.ok(field, 'com chave guardada o campo continua à vista');
  assert.equal(field.value, '', 'o campo nunca traz o valor');
  assert.equal(field.getAttribute('type'), 'password');
  assert.equal(field.getAttribute('placeholder'), 'Chave guardada, cole outra para trocar');
  assert.equal(g.querySelector('.ana-key-change'), null, 'não há botão Trocar');
  assert.match(g.textContent, /Chave guardada/, 'o texto de apoio diz que há chave guardada');
  assert.match(g.querySelector('.ana-state').textContent, /Aviso pendente|Ativo/);
  assert.ok(!t.h.document.body.innerHTML.includes('sk-groq-segredo'), 'a chave não aparece em lugar nenhum da tela');
  assert.ok(!t.h.document.body.textContent.includes('sk-groq-segredo'));
  assert.equal(t.fetched.at(-1).auth, 'Bearer sk-groq-segredo-111', 'o teste usou a chave do Groq');
  assert.ok(t.fetched.every((f) => f.url.startsWith('https://api.groq.com')), 'a chave do Groq só foi ao Groq');
  assert.match(cards(t.host)[1].textContent, /Obrigatória/, 'o Qwen continua sem chave própria');
  assert.equal(cards(t.host)[1].querySelector('.ana-key').value, '');

  // campo vazio + Salvar e testar: a chave guardada continua a mesma (nada é enviado no lugar dela)
  click(t.h, g.querySelector('.ana-save'));
  await settle(60);
  assert.equal(t.fetched.at(-1).auth, 'Bearer sk-groq-segredo-111', 'vazio não troca a chave');
  assert.equal(t.ai.getPublicConfig().providers[0].hasKey, true);

  // colar outra troca a chave
  cards(t.host)[0].querySelector('.ana-key').value = 'sk-groq-outra-chave-2';
  click(t.h, cards(t.host)[0].querySelector('.ana-save'));
  await settle(60);
  assert.equal(t.fetched.at(-1).auth, 'Bearer sk-groq-outra-chave-2');
  assert.equal(cards(t.host)[0].querySelector('.ana-key').value, '', 'a chave enviada sai do campo');

  // remover pede confirmação; recusar mantém a chave
  t.h.window.bdsModal.confirm = async (msg) => { t.h.dialogs.confirms.push(String(msg)); return false; };
  click(t.h, cards(t.host)[0].querySelector('.ana-key-remove'));
  await settle(20);
  assert.equal(t.h.dialogs.confirms.length, 1);
  assert.match(t.h.dialogs.confirms[0], /Remover a chave guardada de Groq\?/);
  assert.equal(t.ai.getPublicConfig().providers[0].hasKey, true, 'recusou: a chave continua guardada');

  t.h.window.bdsModal.confirm = async (msg) => { t.h.dialogs.confirms.push(String(msg)); return true; };
  click(t.h, cards(t.host)[0].querySelector('.ana-key-remove'));
  await settle(20);
  assert.equal(t.h.dialogs.confirms.length, 2);
  assert.equal(t.ai.getPublicConfig().providers[0].hasKey, false);
  assert.equal(cards(t.host)[0].querySelector('.ana-key').getAttribute('placeholder'), 'Cole a chave aqui');
  assert.equal(cards(t.host)[0].querySelector('.ana-key-remove'), null);
  await stop(t);
});

test('chave: o que o usuário digitou num cartão não se perde quando a lista é redesenhada (abrir outro cartão)', async () => {
  const t = await mountPanel();
  await add(t, 'groq');
  await add(t, 'qwencloud');
  cards(t.host)[0].querySelector('.ana-key').value = 'sk-groq-digitando';
  click(t.h, cards(t.host)[1].querySelector('.ana-toggle'));
  await settle(10);
  assert.equal(cards(t.host)[0].querySelector('.ana-key').value, 'sk-groq-digitando');
  assert.equal(cards(t.host)[1].querySelector('.ana-key').value, '');
  await stop(t);
});

test('"Salvar e testar" traz o nome do provedor no aria-label, sem mudar o texto visível', async () => {
  const t = await mountPanel();
  await add(t, 'groq');
  await add(t, 'qwencloud');
  const saves = cards(t.host).map((c) => c.querySelector('.ana-save'));
  assert.deepEqual(saves.map((b) => b.getAttribute('aria-label')), ['Salvar e testar Groq', 'Salvar e testar Qwen']);
  assert.ok(saves.every((b) => /Salvar e testar$/.test(b.textContent.trim())), 'o texto visível continua "Salvar e testar"');
  await stop(t);
});

test('ordem: com um provedor só as setas nem são desenhadas (o interruptor continua); com dois voltam', async () => {
  const t = await mountPanel();
  await add(t, 'groq');
  const one = cards(t.host)[0];
  assert.equal(one.querySelector('.ana-up'), null);
  assert.equal(one.querySelector('.ana-down'), null);
  assert.ok(one.querySelector('.ana-enabled'), 'o interruptor fica');
  await add(t, 'qwencloud');
  assert.equal(cards(t.host).length, 2);
  assert.ok(cards(t.host).every((c) => c.querySelector('.ana-up') && c.querySelector('.ana-down')));
  assert.equal(cards(t.host)[0].querySelector('.ana-up').disabled, true);
  assert.equal(cards(t.host)[1].querySelector('.ana-down').disabled, true);
  await stop(t);
});

test('modelos: o botão de atualizar lista os modelos do próprio provedor', async () => {
  const t = await mountPanel();
  await add(t, 'groq');
  const card = cards(t.host)[0];
  card.querySelector('.ana-key').value = 'sk-groq-segredo-111';
  click(t.h, card.querySelector('.ana-refresh'));
  await settle(60);
  fire(t.h, cards(t.host)[0].querySelector('.ana-model'), 'focus');
  const opts = [...t.host.querySelectorAll('.ana-prov .ana-combo-opt')].map((o) => o.getAttribute('data-model'));
  assert.deepEqual(opts, ['modelo-a', 'modelo-b']);
  assert.match(t.host.querySelector('[data-status]').textContent, /2 modelos \(2 novos\)/);
  assert.deepEqual(t.log.filter((e) => e.name !== 'save').map((e) => e.name), ['discover'], 'atualizar usa a descoberta, não a lista simples');
  await stop(t);
});

/** Painel com um provedor que já tem chave e a lista de modelos carregada. */
async function withModels() {
  const t = await mountPanel();
  await add(t, 'groq');
  const card = cards(t.host)[0];
  card.querySelector('.ana-key').value = 'sk-groq-segredo-111';
  click(t.h, card.querySelector('.ana-refresh'));
  await settle(60);
  return t;
}
const optionsOf = (host) => [...host.querySelectorAll('.ana-prov .ana-combo-opt')].map((o) => o.getAttribute('data-model'));
const modelInput = (host) => cards(host)[0].querySelector('.ana-model');

test('campo Modelo: ao clicar mostra TODOS os modelos, mesmo com um nome já escrito', async () => {
  const t = await withModels();
  const input = modelInput(t.host);
  input.value = 'modelo-a';
  fire(t.h, input, 'focus');
  assert.deepEqual(optionsOf(t.host), ['modelo-a', 'modelo-b'], 'não precisa apagar o texto para ver os outros');
  assert.equal(t.host.querySelector('.ana-combo-opt.selected').getAttribute('data-model'), 'modelo-a', 'o atual aparece marcado');
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  await stop(t);
});

test('campo Modelo: digitar filtra pelo que CONTÉM o texto; sem combinação o texto digitado continua valendo', async () => {
  const t = await withModels();
  const input = modelInput(t.host);
  fire(t.h, input, 'focus');
  input.value = '-b';
  fire(t.h, input, 'input');
  assert.deepEqual(optionsOf(t.host), ['modelo-b'], 'filtra por trecho no meio do nome, não só pelo começo');
  input.value = 'MODELO';
  fire(t.h, input, 'input');
  assert.deepEqual(optionsOf(t.host), ['modelo-a', 'modelo-b'], 'sem diferenciar maiúsculas');
  input.value = 'meu-modelo-novo';
  fire(t.h, input, 'input');
  assert.deepEqual(optionsOf(t.host), []);
  assert.match(t.host.querySelector('.ana-combo-empty').textContent, /texto digitado vale como está/);
  assert.equal(input.value, 'meu-modelo-novo', 'o texto não é apagado nem trocado');
  await stop(t);
});

test('campo Modelo: escolher na lista preenche o campo e fecha; Esc fecha; setas e Enter escolhem', async () => {
  const t = await withModels();
  const input = modelInput(t.host);
  fire(t.h, input, 'focus');
  const opt = t.host.querySelector('.ana-combo-opt[data-model="modelo-b"]');
  fire(t.h, opt, 'mousedown');
  assert.equal(input.value, 'modelo-b');
  assert.equal(t.host.querySelector('.ana-combo-list').hidden, true);

  fire(t.h, input, 'focus');
  fire(t.h, input, 'keydown', { key: 'Escape' });
  assert.equal(t.host.querySelector('.ana-combo-list').hidden, true);

  fire(t.h, input, 'focus');
  fire(t.h, input, 'keydown', { key: 'ArrowDown' });
  fire(t.h, input, 'keydown', { key: 'Enter' });
  assert.equal(input.value, 'modelo-a');
  await stop(t);
});

test('campo Modelo: sem lista carregada busca sozinho ao focar (chave guardada) e mostra os modelos', async () => {
  const t = await mountPanel();
  await add(t, 'groq');
  cards(t.host)[0].querySelector('.ana-key').value = 'sk-groq-segredo-111';
  click(t.h, cards(t.host)[0].querySelector('.ana-save'));
  await settle(60);
  const before = t.fetched.length;
  fire(t.h, modelInput(t.host), 'focus');
  await settle(60);
  assert.ok(t.fetched.length > before, 'consultou a lista de modelos do servidor');
  assert.deepEqual(optionsOf(t.host), ['modelo-a', 'modelo-b']);
  await stop(t);
});

test('ordem: Subir/Descer reordenam (primeiro sem Subir, último sem Descer) e o foco continua no botão', async () => {
  const t = await mountPanel();
  for (const id of ['groq', 'qwencloud', 'ollama']) await add(t, id);
  assert.deepEqual(names(t.host), ['Groq', 'Qwen', 'Ollama (local)']);
  const cs = cards(t.host);
  assert.equal(cs[0].querySelector('.ana-up').disabled, true);
  assert.equal(cs[2].querySelector('.ana-down').disabled, true);
  assert.equal(cs[1].querySelector('.ana-up').getAttribute('aria-label'), 'Subir Qwen');
  // linkedom não tem document.activeElement: registra quem recebeu o foco
  const proto = t.h.window.HTMLElement.prototype;
  const origFocus = proto.focus;
  let lastFocus = null;
  proto.focus = function focus(...args) { lastFocus = this; return origFocus ? origFocus.apply(this, args) : undefined; };
  click(t.h, cs[1].querySelector('.ana-up'));
  await settle(20);
  proto.focus = origFocus;
  assert.deepEqual(names(t.host), ['Qwen', 'Groq', 'Ollama (local)']);
  // chegou ao topo: o "Subir" ficou desabilitado e o foco vai para o "Descer" do mesmo cartão
  assert.equal(cards(t.host)[0].querySelector('.ana-up').disabled, true);
  assert.equal(lastFocus === cards(t.host)[0].querySelector('.ana-down'), true);
  click(t.h, cards(t.host)[1].querySelector('.ana-down'));
  await settle(20);
  assert.deepEqual(names(t.host), ['Qwen', 'Ollama (local)', 'Groq']);
  assert.deepEqual(t.ai.getPublicConfig().providers.map((p) => p.label), ['Qwen', 'Ollama (local)', 'Groq']);
  await stop(t);
});

test('fallback e ativação: o interruptor só aparece com 2+ provedores; Ativar liga/desliga e o estado acompanha', async () => {
  const t = await mountPanel();
  await add(t, 'ollama');
  assert.equal(t.host.querySelector('.ana-fallback'), null);
  await add(t, 'lmstudio');
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
  await add(t, 'ollama');
  await add(t, 'lmstudio');
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
  await add(t, 'groq');
  await add(t, 'ollama');
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
  await add(t, 'groq');
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

// ----------------------------------------------------------------------------- Adicionar provedor (busca de modelos)

const { MESSAGES: DISCOVERY_MESSAGES } = require('../src/services/ai/providers/discovery');

// chat: 2 llama + llava (que também entende imagem) = 3; áudio 1; imagem 1; vídeo 1
const CATALOG = { data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'llama-3.1-8b-instant' }, { id: 'whisper-large-v3-turbo' }, { id: 'llava:13b' }, { id: 'sora-2' }] };
const GROQ_KEY = 'gsk_segredo_de_teste_123';

const typeIn = (h, el, value) => { el.value = value; fire(h, el, 'input'); };
const field = (host, sel) => host.querySelector(sel);
const pageHas = (t, text) => t.h.document.body.innerHTML.includes(text) || t.h.document.body.textContent.includes(text);

/** Toca num atalho (ou digita o endereço), cola a chave e clica em "Procurar modelos". */
async function search(t, { chip = null, url = null, key = '' } = {}) {
  if (chip) click(t.h, preset(t.host, chip));
  if (url !== null) typeIn(t.h, field(t.host, '.ana-add-url'), url);
  field(t.host, '.ana-add-key').value = key;
  click(t.h, field(t.host, '.ana-discover'));
  await settle(60);
}

test('atalho só PREENCHE o endereço: não cria provedor nem chama o main; a chave é obrigatória nos serviços e opcional nos locais', async () => {
  const t = await mountPanel();
  click(t.h, preset(t.host, 'groq'));
  assert.equal(field(t.host, '.ana-add-url').value, 'https://api.groq.com/openai/v1');
  assert.equal(preset(t.host, 'groq').getAttribute('aria-pressed'), 'true');
  assert.match(field(t.host, '.ana-add-keyhint').textContent, /Obrigatória/);
  assert.equal(t.log.length, 0, 'nenhuma chamada ao main');
  assert.equal(t.ai.getPublicConfig().providers.length, 0, 'nada foi criado');

  // sem a chave pedida: erro fixo nosso e a busca nem sai
  click(t.h, field(t.host, '.ana-discover'));
  await settle(20);
  assert.equal(field(t.host, '.ana-add-error').textContent, 'Cole a chave de API deste serviço.');
  assert.equal(t.log.length, 0);

  click(t.h, preset(t.host, 'ollama'));
  assert.equal(field(t.host, '.ana-add-url').value, 'http://localhost:11434/v1');
  assert.match(field(t.host, '.ana-add-keyhint').textContent, /Opcional/);
  assert.equal(preset(t.host, 'groq').getAttribute('aria-pressed'), 'false');
  await stop(t);
});

test('buscar e adicionar: resumo, seletor Conversa, chave limpa do campo, remoto nasce com o aviso pendente e a chave nunca aparece', async () => {
  const t = await mountPanel();
  t.respond.body = CATALOG;
  click(t.h, preset(t.host, 'groq'));
  const keyEl = field(t.host, '.ana-add-key');
  keyEl.value = GROQ_KEY;
  click(t.h, field(t.host, '.ana-discover'));
  assert.equal(keyEl.value, '', 'o campo da chave é limpo assim que o pedido sai');
  await settle(60);

  assert.equal(field(t.host, '.ana-found').textContent, 'Encontrado: Groq · compatível com OpenAI');
  assert.equal(field(t.host, '.ana-disc-summary').textContent, '3 modelos de conversa, 1 de áudio, 1 de imagem, 1 de vídeo');
  const opts = [...t.host.querySelectorAll('.ana-disc-chat option')];
  assert.deepEqual(opts.map((o) => o.getAttribute('value')), ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'llava:13b']);
  assert.match(opts[0].textContent, /provável/, 'classificado só pelo nome');
  assert.ok(opts[0].hasAttribute('selected') || opts[0].selected, 'o sugerido do preset já vem escolhido');
  assert.match(field(t.host, '.ana-disc-where').textContent, /As conversas e as análises de texto vão para este serviço\./);
  assert.equal(t.host.querySelector('.ana-discover'), null, 'o passo 2 troca o formulário');
  assert.equal(t.ai.getPublicConfig().providers.length, 0, 'ainda não criou nada');
  assert.ok(!pageHas(t, GROQ_KEY), 'a chave não está na tela');
  assert.equal(t.fetched.length, 1);
  assert.equal(t.fetched[0].url, 'https://api.groq.com/openai/v1/models');
  assert.equal(t.fetched[0].auth, `Bearer ${GROQ_KEY}`);

  field(t.host, '.ana-disc-chat').value = 'llama-3.1-8b-instant';
  click(t.h, field(t.host, '.ana-disc-add'));
  await settle(60);

  const cfg = t.ai.getPublicConfig();
  assert.equal(cfg.providers.length, 1);
  assert.equal(cfg.providers[0].model, 'llama-3.1-8b-instant');
  assert.equal(cfg.providers[0].needsRemoteConsent, true, 'o commit nunca aceita o aviso de servidor externo');
  assert.equal(cfg.providers[0].hasKey, true, 'a chave foi do rascunho no main para o disco criptografado');
  assert.deepEqual(cfg.providers[0].modelCounts, { chat: 3, audio: 1, image: 1, video: 1 });
  const card = cards(t.host)[0];
  assert.ok(card.classList.contains('ana-prov-open'), 'o novo provedor aparece com os detalhes abertos');
  assert.match(card.querySelector('.ana-state').textContent, /Aviso pendente/);
  assert.match(card.textContent, /Chave guardada/);
  assert.equal(Boolean(card.querySelector('.ana-accept').checked), false);
  assert.match(t.host.querySelector('#anaStatus').textContent, /aceite o aviso de servidor externo/);
  assert.equal(t.host.querySelector('.ana-add').hasAttribute('open'), false, 'com provedores o bloco volta a fechar');
  assert.ok(!pageHas(t, GROQ_KEY));
  assert.ok(!JSON.stringify(cfg).includes(GROQ_KEY));
  assert.deepEqual(t.log.map((e) => e.name), ['discover', 'save']);
  assert.equal(t.log[0].input.apiKey, '(chave)');
  assert.ok(t.fetched.every((f) => f.url.startsWith('https://api.groq.com/')), 'a chave só foi ao endereço digitado');
  await stop(t);
});

test('Cancelar apaga o rascunho no main e volta ao formulário com o endereço (sem chave)', async () => {
  const t = await mountPanel();
  t.respond.body = CATALOG;
  await search(t, { chip: 'ollama' });
  assert.ok(field(t.host, '.ana-disc-chat'));
  assert.equal(field(t.host, '.ana-disc-where'), null, 'servidor local: não fala em servidor externo');
  assert.equal(t.ai._drafts.size, 1);
  click(t.h, field(t.host, '.ana-disc-cancel'));
  await settle(30);
  const last = t.log.at(-1);
  assert.equal(last.name, 'discover');
  assert.equal(typeof last.input.discard, 'string');
  assert.equal(Object.keys(last.input).length, 1, 'o pedido de descarte não leva chave nem endereço');
  assert.equal(t.ai._drafts.size, 0, 'o rascunho (e a chave que ele seguraria) foi zerado');
  assert.equal(field(t.host, '.ana-add-url').value, 'http://localhost:11434/v1');
  assert.equal(field(t.host, '.ana-add-key').value, '');
  assert.equal(t.ai.getPublicConfig().providers.length, 0);
  await stop(t);
});

test('lista vazia: mensagem fixa do main, campo para digitar o modelo e "Adicionar mesmo assim" (sem reenviar a chave)', async () => {
  const t = await mountPanel();
  t.respond.body = { data: [] };
  await search(t, { chip: 'lmstudio' });
  assert.equal(field(t.host, '.ana-disc-error').textContent, DISCOVERY_MESSAGES.EMPTY);
  assert.equal(field(t.host, '.ana-disc-chat'), null);
  assert.equal(field(t.host, '.ana-disc-add').textContent, 'Adicionar mesmo assim');

  click(t.h, field(t.host, '.ana-disc-add'));
  await settle(20);
  assert.equal(field(t.host, '.ana-disc-error').textContent, 'Informe o modelo de conversa.', 'sem texto não adiciona');
  assert.equal(t.ai.getPublicConfig().providers.length, 0);

  field(t.host, '.ana-disc-force').value = '  meu-modelo-local  ';
  click(t.h, field(t.host, '.ana-disc-add'));
  await settle(60);
  const cfg = t.ai.getPublicConfig();
  assert.equal(cfg.providers.length, 1);
  assert.equal(cfg.providers[0].model, 'meu-modelo-local');
  assert.equal(cfg.providers[0].isLocal, true);
  assert.equal(t.ai._drafts.size, 0);
  assert.deepEqual(t.log.map((e) => e.name), ['discover', 'save']);
  assert.equal(t.log[1].name, 'save');
  await stop(t);
});

test('chave recusada: texto fixo nosso (nunca o do servidor), nenhum rascunho e a chave não fica na tela', async () => {
  const t = await mountPanel();
  t.respond.status = 401;
  t.respond.body = '{"error":{"message":"servidor-diz: chave gsk_segredo_de_teste_123 invalida"}}';
  await search(t, { chip: 'groq', key: GROQ_KEY });
  assert.equal(field(t.host, '.ana-add-error').textContent, DISCOVERY_MESSAGES.AUTH);
  assert.ok(!pageHas(t, 'servidor-diz'));
  assert.ok(!pageHas(t, GROQ_KEY));
  assert.equal(t.ai._drafts.size, 0, 'erro de chave não cria rascunho');
  assert.equal(field(t.host, '.ana-add-url').value, 'https://api.groq.com/openai/v1');
  assert.equal(field(t.host, '.ana-add-key').value, '');
  assert.ok(field(t.host, '.ana-discover'), 'o formulário continua para tentar de novo');
  await stop(t);
});

/** Registra onde o foco cai (classe do elemento) enquanto `fn` roda; o linkedom não tem activeElement. */
async function recordFocus(t, fn) {
  // troca `focus` em todos os níveis da cadeia de protótipos dos elementos do painel (algum nível pode ter o seu próprio)
  const patched = [];
  const seen = [];
  const record = { configurable: true, writable: true, value() { seen.push(String(this.getAttribute('class') || '')); } };
  for (let proto = Object.getPrototypeOf(t.host.querySelector('button')); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    patched.push([proto, Object.getOwnPropertyDescriptor(proto, 'focus')]);
    Object.defineProperty(proto, 'focus', record);
  }
  try { await fn(); } finally {
    for (const [proto, had] of patched) { if (had) Object.defineProperty(proto, 'focus', had); else delete proto.focus; }
  }
  return seen;
}

test('foco do teclado: busca, resultado, erro e Cancelar levam o foco a um elemento que existe; os erros são anunciados (role alert)', async () => {
  const t = await mountPanel();
  t.respond.body = CATALOG;
  const seen = await recordFocus(t, async () => {
    await search(t, { chip: 'ollama' });
    click(t.h, field(t.host, '.ana-disc-cancel'));
    await settle(30);
  });
  assert.ok(seen.some((c) => /ana-add-cancel/.test(c)), 'durante a busca o foco fica no Cancelar');
  assert.ok(seen.some((c) => /ana-disc-chat/.test(c)), 'o resultado leva ao seletor Conversa');
  assert.match(seen.at(-1), /ana-add-url/, 'Cancelar volta ao campo Endereço');

  t.respond.status = 401;
  t.respond.body = '{}';
  const errSeen = await recordFocus(t, async () => { await search(t, { chip: 'groq', key: GROQ_KEY }); });
  assert.match(errSeen.at(-1), /ana-add-key/, 'depois de um erro de busca o foco volta ao campo da chave');
  assert.equal(field(t.host, '.ana-add-error').getAttribute('role'), 'alert');

  t.respond.status = 200;
  t.respond.body = { data: [] };
  await search(t, { chip: 'lmstudio' });
  assert.equal(field(t.host, '.ana-disc-error').getAttribute('role'), 'alert');
  await stop(t);
});

test('lista vazia: o topo do resultado não afirma "compatível com OpenAI" (nada foi reconhecido); com modelos, continua dizendo o formato', async () => {
  const t = await mountPanel();
  t.respond.body = { data: [] };
  await search(t, { chip: 'lmstudio' });
  assert.equal(field(t.host, '.ana-found').textContent, 'Servidor: LM Studio (local)');
  assert.doesNotMatch(field(t.host, '.ana-found').textContent, /compatível|Encontrado/);
  click(t.h, field(t.host, '.ana-disc-cancel'));
  await settle(30);
  t.respond.body = '<html>nada de JSON</html>';
  await search(t, { chip: 'lmstudio' });
  assert.equal(field(t.host, '.ana-found').textContent, 'Servidor: LM Studio (local)');
  assert.equal(field(t.host, '.ana-disc-force') !== null, true);
  await stop(t);
});

test('o resultado sobrevive a um redesenho do card: a escolha do seletor Conversa e o modelo digitado não voltam ao padrão', async () => {
  const t = await mountPanel();
  t.respond.body = CATALOG;
  await search(t, { chip: 'ollama' });
  const sel = field(t.host, '.ana-disc-chat');
  sel.value = 'llava:13b';
  fire(t.h, sel, 'change');
  await t.mod.reloadAnalysisPanel();   // o card é redesenhado (ex.: outro cartão mudou a configuração)
  await settle(20);
  assert.equal(field(t.host, '.ana-disc-chat').value, 'llava:13b', 'a escolha foi mantida');
  click(t.h, field(t.host, '.ana-disc-add'));
  await settle(60);
  assert.equal(t.ai.getPublicConfig().providers[0].model, 'llava:13b', 'adiciona o modelo que o usuário escolheu');

  t.respond.body = { data: [] };
  await search(t, { chip: 'lmstudio' });
  const force = field(t.host, '.ana-disc-force');
  force.value = 'meu-modelo';
  fire(t.h, force, 'input');
  await t.mod.reloadAnalysisPanel();
  await settle(20);
  assert.equal(field(t.host, '.ana-disc-force').value, 'meu-modelo', 'o texto digitado não some');
  await stop(t);
});

test('Enter no campo do modelo digitado aciona "Adicionar mesmo assim"', async () => {
  const t = await mountPanel();
  t.respond.body = { data: [] };
  await search(t, { chip: 'lmstudio' });
  const force = field(t.host, '.ana-disc-force');
  force.value = 'modelo-por-enter';
  fire(t.h, force, 'keydown', { key: 'Enter' });
  await settle(60);
  assert.equal(t.ai.getPublicConfig().providers[0].model, 'modelo-por-enter');
  await stop(t);
});

test('durante a busca: Cancelar fica habilitado (aria-busy), a resposta que chega depois é descartada com o rascunho', async () => {
  const t = await mountPanel();
  t.respond.body = CATALOG;
  let release;
  t.respond.gate = new Promise((resolve) => { release = resolve; });
  click(t.h, preset(t.host, 'ollama'));
  click(t.h, field(t.host, '.ana-discover'));
  await settle(20);
  assert.equal(field(t.host, '.ana-add-form').getAttribute('aria-busy'), 'true');
  assert.equal(field(t.host, '.ana-discover').disabled, true);
  const cancel = field(t.host, '.ana-add-cancel');
  assert.ok(cancel && !cancel.disabled, 'dá para desistir de uma busca demorada');
  click(t.h, cancel);
  await settle(20);
  assert.equal(field(t.host, '.ana-add-cancel'), null);
  assert.equal(field(t.host, '.ana-discover').disabled, false, 'o formulário volta');
  release();
  await settle(80);
  assert.equal(field(t.host, '.ana-disc-chat'), null, 'a resposta tardia não reabre o resultado');
  assert.equal(t.ai._drafts.size, 0, 'o rascunho dela foi apagado no main');
  await stop(t);
});

test('depois de um erro com chave, o texto de ajuda avisa que a chave não fica na tela e some ao colar de novo', async () => {
  const t = await mountPanel();
  t.respond.status = 401;
  t.respond.body = '{}';
  await search(t, { chip: 'groq', key: GROQ_KEY });
  assert.match(field(t.host, '.ana-add-keyhint').textContent, /cole-a de novo para tentar outra vez/);
  const keyEl = field(t.host, '.ana-add-key');
  keyEl.value = GROQ_KEY;
  fire(t.h, keyEl, 'input');
  assert.match(field(t.host, '.ana-add-keyhint').textContent, /Obrigatória/);
  await stop(t);
});

test('Anthropic: o atalho usa a API nativa (x-api-key, sem Authorization) e o resultado diz Anthropic', async () => {
  const t = await mountPanel();
  t.respond.body = { data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', capabilities: { image_input: { supported: true } } }], has_more: false };
  await search(t, { chip: 'anthropic', key: 'sk-ant-chave-de-teste-123' });
  assert.equal(field(t.host, '.ana-found').textContent, 'Encontrado: Anthropic · Anthropic');
  assert.equal(t.fetched.length, 1);
  assert.equal(t.fetched[0].headers['x-api-key'], 'sk-ant-chave-de-teste-123');
  assert.equal(t.fetched[0].headers.authorization, undefined);
  assert.ok(!pageHas(t, 'sk-ant-chave'));
  await stop(t);
});

test('ids de modelo vindos do servidor entram só por textContent (nada vira marcação)', async () => {
  const t = await mountPanel();
  t.respond.body = { data: [{ id: '<img src=x onerror=alert(1)>' }, { id: 'modelo-ok' }] };
  await search(t, { chip: 'lmstudio' });
  const opt = [...t.host.querySelectorAll('.ana-disc-chat option')].find((o) => o.getAttribute('value').startsWith('<img'));
  assert.ok(opt);
  assert.match(opt.textContent, /^<img src=x onerror=alert\(1\)>/);
  assert.equal(t.host.querySelector('img'), null);
  field(t.host, '.ana-disc-chat').value = 'modelo-ok';
  click(t.h, field(t.host, '.ana-disc-add'));
  await settle(60);
  fire(t.h, cards(t.host)[0].querySelector('.ana-model'), 'focus');
  assert.equal(t.host.querySelector('img'), null, 'nem na lista do campo Modelo');
  assert.ok(optionsOf(t.host).some((id) => id.startsWith('<img')));
  await stop(t);
});

test('atualizar o card: grava o card ANTES e só depois descobre pelo provedor já gravado; mostra "N modelos (X novos)"', async () => {
  const t = await mountPanel();
  await add(t, 'groq');
  t.respond.body = CATALOG;
  const id = t.ai.getPublicConfig().providers[0].id;
  cards(t.host)[0].querySelector('.ana-key').value = GROQ_KEY;
  click(t.h, cards(t.host)[0].querySelector('.ana-refresh'));
  await settle(80);
  assert.deepEqual(t.log.map((e) => e.name), ['save', 'discover']);
  assert.deepEqual(t.log[1].input, { providerId: id }, 'usa o endereço e a chave já gravados: nada de chave no pedido');
  assert.equal(t.ai.getPublicConfig().providers[0].hasKey, true);
  assert.match(t.host.querySelector('[data-status]').textContent, /3 modelos \(5 novos\)/);
  assert.deepEqual(t.ai.getPublicConfig().providers[0].modelCounts, { chat: 3, audio: 1, image: 1, video: 1 });
  fire(t.h, cards(t.host)[0].querySelector('.ana-model'), 'focus');
  assert.deepEqual(optionsOf(t.host), ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'llava:13b'], 'só modelos de conversa na lista');
  assert.ok(!pageHas(t, GROQ_KEY));
  await stop(t);
});

test('campo Modelo: o catálogo guardado é a lista inicial, sem nova busca ao focar', async () => {
  const t = await mountPanel();
  await add(t, 'groq');
  t.respond.body = CATALOG;
  cards(t.host)[0].querySelector('.ana-key').value = GROQ_KEY;
  click(t.h, cards(t.host)[0].querySelector('.ana-refresh'));
  await settle(80);
  await t.mod.mountAnalysisPanel(t.host);   // painel novo: a lista buscada some, o catálogo guardado fica
  await settle(30);
  const before = t.fetched.length;
  t.log.length = 0;
  fire(t.h, cards(t.host)[0].querySelector('.ana-model'), 'focus');
  await settle(30);
  assert.deepEqual(optionsOf(t.host), ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'llava:13b']);
  assert.equal(t.fetched.length, before, 'não consultou o servidor');
  assert.equal(t.log.length, 0);
  await stop(t);
});

test('seções: Áudio, Imagem e Vídeo mostram o catálogo (só informação); Vídeo some por inteiro sem modelos de vídeo', async () => {
  const t = await mountPanel();
  const sections = () => [...t.host.querySelectorAll('.ana-sec')].filter((s) => !s.hidden).map((s) => s.getAttribute('aria-label'));
  assert.deepEqual(sections(), ['Chat', 'Áudio', 'Imagem'], 'sem catálogo não há seção de vídeo');

  // catálogo sem vídeo: áudio e imagem informam; vídeo continua fora
  t.respond.body = { data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'whisper-large-v3-turbo' }, { id: 'llava:13b' }] };
  await search(t, { chip: 'groq', key: GROQ_KEY });
  click(t.h, field(t.host, '.ana-disc-add'));
  await settle(80);
  assert.deepEqual(sections(), ['Chat', 'Áudio', 'Imagem']);
  assert.match(t.host.querySelector('.aud-catalog').textContent, /Modelos de áudio encontrados em Groq: 1\./);
  // o Groq acabou de nascer com o aviso de servidor externo pendente: a chave ainda não é compartilhada, e a dica diz isso
  assert.match(t.host.querySelector('.aud-catalog').textContent, /Ative o Groq em Chat e aceite o aviso de servidor externo: o motor usa a chave dele\./);
  assert.doesNotMatch(t.host.querySelector('.aud-catalog').textContent, /Ligue o Groq acima/);
  assert.match(t.host.querySelector('#anaImageHost').textContent, /Também entendem imagens: 1 modelo em Groq \(uso em breve\)\./);
  assert.equal(t.host.querySelectorAll('.ana-sec button.ana-disc-add, .ana-sec select').length, 0, 'nenhum seletor nem botão nas seções');

  // um endereço que não é Groq/OpenAI: não há motor de transcrição; e agora com vídeo
  t.respond.body = { data: [{ id: 'llama3.2' }, { id: 'whisper-large-v3' }, { id: 'sora-2' }, { id: 'veo-3' }] };
  await search(t, { chip: 'lmstudio' });
  click(t.h, field(t.host, '.ana-disc-add'));
  await settle(80);
  assert.deepEqual(sections(), ['Chat', 'Áudio', 'Imagem', 'Vídeo']);
  const audio = t.host.querySelector('.aud-catalog').textContent;
  assert.match(audio, /Modelos de áudio encontrados em LM Studio \(local\): 1\./);
  assert.match(audio, /Ainda não há motor de transcrição para este endereço\./);
  const video = t.host.querySelector('#anaVideoHost').textContent;
  assert.match(video, /O app ainda não usa vídeo\./);
  assert.match(video, /LM Studio \(local\): 2 modelos de vídeo\./);
  await stop(t);
});

test('o painel não guarda a chave: depois de buscar, nenhum campo do DOM tem valor de chave', async () => {
  const t = await mountPanel();
  t.respond.body = CATALOG;
  await search(t, { chip: 'groq', key: GROQ_KEY });
  const values = [...t.h.document.querySelectorAll('input, select, textarea')].map((e) => e.value || '');
  assert.ok(values.every((v) => !v.includes(GROQ_KEY)));
  click(t.h, field(t.host, '.ana-disc-cancel'));
  await settle(30);
  assert.ok(!pageHas(t, GROQ_KEY));
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
    assert.deepEqual(qa(h, '#aiAssistantPanel button').map((b) => b.getAttribute('aria-label')), ['Limpar conversa', 'Fechar a Yui', 'Enviar']);
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
