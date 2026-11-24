'use strict';

// "Adicionar provedor" pela descoberta de modelos, no main (AIService + canais ai:*): rascunho só em memória (TTL, limite de 3,
// cancelar, uma descoberta por vez), commit validado (modelo, rascunho, forçado), provedor remoto nascendo com o aviso pendente,
// mesclar catálogo sem tocar nas escolhas, rollback com cópia profunda, migração do ai.json antigo, Anthropic (lista nativa e
// conversa mínima) e a chave que nunca aparece em resposta, configuração pública, erro ou disco.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const AIService = require('../src/services/ai/AIService');
const OpenAIProvider = require('../src/services/ai/providers/OpenAIProvider');
const AnthropicProvider = require('../src/services/ai/providers/AnthropicProvider');
const presets = require('../src/services/ai/providers/presets');
const { MESSAGES } = require('../src/services/ai/providers/discovery');
const registerAiHandlers = require('../src/ipc/aiHandlers');
const { createRegistry, APP_PAGE } = require('../src/ipc/channelRegistry');

const KEY = 'sk-test-SEGREDO-123456';
const REMOTE = 'https://api.example.com/v1';

const dirs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-aidisc-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, '')
};

// ----------------------------------------------------------------- rede falsa

const res = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

const LIST = { object: 'list', data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4.1' }, { id: 'whisper-1' }, { id: 'text-embedding-3-small' }, { id: 'sora-2' }] };
const CHAT_OK = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };

/** fetch falso: `handler(url, init)` devolve a resposta; tudo fica registrado em `calls`. */
function makeNet(handler) {
  const net = {
    calls: [],
    handler,
    fetch: async (url, init = {}) => {
      net.calls.push({ url: String(url), method: init.method || 'GET', headers: { ...(init.headers || {}) }, redirect: init.redirect, signal: init.signal, body: init.body });
      return net.handler(String(url), init);
    },
    chats: () => net.calls.filter((c) => c.url.endsWith('/chat/completions')),
    lists: () => net.calls.filter((c) => /\/models(\?|$)/.test(c.url))
  };
  return net;
}
const okNet = () => makeNet((url) => (url.endsWith('/chat/completions') ? res(CHAT_OK) : res(LIST)));

function setup({ net = okNet(), now, dir = tmpDir() } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const ai = new AIService({ configDir: dir, safeStorage, fetchImpl: net.fetch, now: now || (() => clock.t) });
  return { ai, net, dir, clock, disk: () => fs.readFileSync(path.join(dir, 'ai.json'), 'utf8'), has: () => fs.existsSync(path.join(dir, 'ai.json')) };
}

/** Descobre e confirma um provedor remoto (https://api.example.com/v1). */
async function addRemote(t, { chat = 'gpt-4.1', label, url = REMOTE, key = KEY } = {}) {
  const found = await t.ai.discoverProvider({ baseUrl: url, apiKey: key });
  const cfg = t.ai.saveConfig({ commitDiscovery: { draftId: found.draftId, chat, ...(label ? { label } : {}) } });
  return { found, cfg, id: cfg.addedId, view: cfg.providers.find((p) => p.id === cfg.addedId) };
}

const noKey = (value, key = KEY) => assert.ok(!JSON.stringify(value).includes(key), 'a chave apareceu onde não devia');

// ----------------------------------------------------------------- descoberta e rascunho

test('descoberta de provedor novo: classifica, devolve rascunho SEM a chave e não grava nada em disco', async () => {
  const t = setup();
  const r = await t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
  assert.match(r.draftId, /^[0-9a-f-]{36}$/);
  assert.equal(r.format, 'openai');
  assert.equal(r.host, 'api.example.com');
  assert.equal(r.isLocal, false);
  assert.equal(r.label, 'api.example.com');
  assert.equal(r.needsConsent, true);
  assert.deepEqual(r.counts, { chat: 2, audio: 1, image: 2, video: 1 });
  assert.equal(r.defaultChat, 'gpt-4.1');
  assert.deepEqual(r.models.find((m) => m.id === 'gpt-4o-mini'), { id: 'gpt-4o-mini', caps: ['chat', 'image'], source: 'nome' });
  assert.ok(!r.models.some((m) => m.id === 'text-embedding-3-small'), 'embedding é ignorado');
  noKey(r);
  assert.equal(t.has(), false, 'só o commit grava o provedor');
  const call = t.net.lists()[0];
  assert.equal(call.url, `${REMOTE}/models`);
  assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  assert.equal(call.redirect, 'error');
  assert.equal(t.net.chats().length, 0, 'nenhum conteúdo do usuário é enviado');
});

test('atalhos: presets.shortcuts e getPublicConfig().shortcuts só trazem endereços; o menu antigo continua com os 6', () => {
  const t = setup();
  const s = t.ai.getPublicConfig().shortcuts;
  assert.deepEqual(s.map((x) => x.id), ['groq', 'qwencloud', 'openai', 'anthropic', 'lmstudio', 'ollama']);
  for (const x of s) assert.deepEqual(Object.keys(x).sort(), ['baseUrl', 'id', 'keyRequired', 'label']);
  assert.equal(s.find((x) => x.id === 'anthropic').baseUrl, 'https://api.anthropic.com/v1');
  assert.equal(s.find((x) => x.id === 'anthropic').keyRequired, true);
  assert.deepEqual(s.filter((x) => !x.keyRequired).map((x) => x.id), ['lmstudio', 'ollama']);
  assert.equal(presets.publicList().length, 6);
  assert.equal(presets.publicList().some((p) => p.id === 'anthropic'), false);
  assert.equal(presets.detectPreset('https://api.anthropic.com/v1'), 'anthropic');
  assert.equal(presets.byId('anthropic').discoveryOnly, true);
});

test('erros de endereço, chave e rede: mensagem fixa, sem rascunho e sem a chave', async () => {
  const t = setup();
  await assert.rejects(t.ai.discoverProvider({ baseUrl: '', apiKey: KEY }), (e) => e.code === 'BAD_URL' && e.message === MESSAGES.BAD_URL);
  await assert.rejects(t.ai.discoverProvider({}), (e) => e.code === 'BAD_URL');
  assert.equal(t.net.calls.length, 0, 'endereço vazio nem chama a rede');
  await assert.rejects(t.ai.discoverProvider({ baseUrl: 'http://api.example.com/v1', apiKey: KEY }), (e) => e.code === 'INSECURE');
  await assert.rejects(t.ai.discoverProvider({ baseUrl: 'http://192.168.0.5:1234/v1', apiKey: KEY }), (e) => e.code === 'INSECURE');
  assert.equal(t.net.calls.length, 0, 'chave por http:// fora do loopback nunca sai');
  await assert.rejects(t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: 'curta' }), (e) => e.code === 'BAD_KEY' && e.message === 'Chave de API com formato inválido.');
  await assert.rejects(t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: 'tem espaco 123456' }), (e) => e.code === 'BAD_KEY');
  await assert.rejects(t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: 12345678 }), (e) => e.code === 'BAD_KEY');
  assert.equal(t.net.calls.length, 0);

  t.net.handler = () => res(`{"error":"chave ${KEY} inválida, segredo do servidor"}`, 401);
  await assert.rejects(t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY }), (e) => {
    assert.equal(e.code, 'AUTH');
    assert.equal(e.message, MESSAGES.AUTH);
    assert.ok(!e.message.includes(KEY) && !e.message.includes('segredo'));
    return true;
  });
  t.net.handler = () => { throw Object.assign(new Error(`fetch failed ${KEY}`), { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY }), (e) => e.code === 'NETWORK' && !e.message.includes(KEY));
  t.net.handler = () => res(LIST, 302, { location: 'https://outro.exemplo/v1/models' });
  await assert.rejects(t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY }), (e) => e.code === 'REDIRECT');
  assert.equal(t.ai._drafts.size, 0, 'erro de rede, chave recusada ou URL ruim não criam rascunho');
});

test('lista vazia ou resposta ilegível: o main cria o rascunho VAZIO (com a chave) e devolve canForce', async () => {
  for (const [label, handler, code] of [
    ['vazia', () => res({ data: [] }), 'EMPTY'],
    ['só ignorados', () => res({ data: [{ id: 'text-embedding-3-small' }, { id: 'dall-e-3' }] }), 'EMPTY'],
    ['ilegível', () => res({ ok: true }), 'BAD_RESPONSE'],
    ['não-JSON', () => res('<html>oi</html>'), 'BAD_RESPONSE']
  ]) {
    const t = setup({ net: makeNet(handler) });
    const r = await t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
    assert.equal(r.canForce, true, label);
    assert.deepEqual(r.models, [], label);
    assert.deepEqual(r.error, { code, message: MESSAGES[code] }, label);
    assert.match(r.draftId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(r.counts, { chat: 0, audio: 0, image: 0, video: 0 });
    assert.equal(r.defaultChat, null);
    noKey(r);
    assert.equal(t.ai._drafts.size, 1);
  }
});

test('forçado: "adicionar mesmo assim" aceita o texto digitado (aparado) e a chave vai do rascunho; lista com modelos NÃO aceita texto livre', async () => {
  const t = setup({ net: makeNet(() => res({ data: [] })) });
  const r = await t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
  assert.throws(() => t.ai.saveConfig({ commitDiscovery: { draftId: r.draftId, chat: '   ' } }), /Escolha o modelo/);
  assert.throws(() => t.ai.saveConfig({ commitDiscovery: { draftId: r.draftId, chat: 'a'.repeat(121) } }), /Escolha o modelo/);
  assert.throws(() => t.ai.saveConfig({ commitDiscovery: { draftId: r.draftId, chat: 'ruim‮modelo' } }), /Escolha o modelo/);
  assert.equal(t.ai._drafts.size, 1, 'a recusa não consome o rascunho');
  const cfg = t.ai.saveConfig({ commitDiscovery: { draftId: r.draftId, chat: '  meu-modelo-x  ' } });
  const p = cfg.providers.find((x) => x.id === cfg.addedId);
  assert.equal(p.model, 'meu-modelo-x');
  assert.equal(p.hasKey, true);
  assert.deepEqual(p.models, []);
  assert.equal(JSON.parse(t.disk()).providers[0].apiKeyEnc, Buffer.from(`enc:${KEY}`).toString('base64'));

  const t2 = setup();
  const full = await t2.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
  assert.throws(() => t2.ai.saveConfig({ commitDiscovery: { draftId: full.draftId, chat: 'modelo-inventado' } }), /não está entre os modelos/);
});

test('commit: cria o provedor com catálogo, chave criptografada, ordem e rótulo único; o rascunho some; a chave nunca aparece', async () => {
  const t = setup();
  const a = await addRemote(t);
  assert.equal(a.view.model, 'gpt-4.1');
  assert.equal(a.view.enabled, true);
  assert.equal(a.view.hasKey, true);
  assert.equal(a.view.preset, 'custom');
  assert.equal(a.view.label, 'api.example.com');
  assert.equal(a.view.format, 'openai');
  assert.equal(a.view.baseUrl, REMOTE);
  assert.deepEqual(a.view.modelCounts, { chat: 2, audio: 1, image: 2, video: 1 });
  assert.deepEqual(a.view.models.map((m) => m.id), ['gpt-4o-mini', 'gpt-4.1', 'whisper-1', 'sora-2']);
  for (const m of a.view.models) assert.deepEqual(Object.keys(m).sort(), ['caps', 'id', 'source'], 'o catálogo público só tem id, caps e source');
  assert.match(a.view.discoveredAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.deepEqual(a.cfg.order, [a.id]);
  noKey(a.cfg);
  noKey(a.found);
  noKey(t.ai.getPublicConfig());
  const disk = t.disk();
  noKey(disk);
  const stored = JSON.parse(disk).providers[0];
  assert.deepEqual(stored.models.map((m) => m.id), ['gpt-4o-mini', 'gpt-4.1', 'whisper-1', 'sora-2']);
  assert.equal(stored.discoveredAt, a.view.discoveredAt);

  // o rascunho foi consumido; um segundo igual ganha rótulo único e entra no fim da ordem
  assert.throws(() => t.ai.saveConfig({ commitDiscovery: { draftId: a.found.draftId, chat: 'gpt-4.1' } }), /expirou/);
  const b = await addRemote(t, { url: 'https://api.example.com/v2' });
  assert.equal(b.view.label, 'api.example.com 2');
  assert.deepEqual(b.cfg.order, [a.id, b.id]);

  // rótulo digitado e atalho conhecido (Groq) viram preset e nome
  const t2 = setup();
  const g = await addRemote(t2, { url: 'https://api.groq.com/openai/v1', label: '  Meu Groq  ' });
  assert.equal(g.view.label, 'Meu Groq');
  assert.equal(g.view.preset, 'groq');
  const g2 = await addRemote(t2, { url: 'https://api.groq.com/openai/v1' });
  assert.equal(g2.view.label, 'Groq');
});

test('commit valida no main: rascunho, modelo, tipos errados, providerId e capacidade "chat"', async () => {
  const t = setup();
  const r = await t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
  const commit = (c) => t.ai.saveConfig({ commitDiscovery: c });
  const INVALID = /Dados inválidos/;
  assert.throws(() => commit(null), INVALID);
  assert.throws(() => commit('x'), INVALID);
  assert.throws(() => commit([]), INVALID);
  assert.throws(() => commit({ chat: 'gpt-4.1' }), INVALID);
  assert.throws(() => commit({ draftId: 123, chat: 'gpt-4.1' }), INVALID);
  assert.throws(() => commit({ draftId: r.draftId }), INVALID);
  assert.throws(() => commit({ draftId: r.draftId, chat: 42 }), INVALID);
  assert.throws(() => commit({ draftId: r.draftId, chat: ['gpt-4.1'] }), INVALID);
  assert.throws(() => commit({ draftId: r.draftId, chat: 'gpt-4.1', label: 7 }), INVALID);
  assert.throws(() => commit({ draftId: r.draftId, chat: 'gpt-4.1', providerId: 'embedded' }), INVALID);
  assert.throws(() => commit({ draftId: 'nao-existe', chat: 'gpt-4.1' }), /expirou/);
  assert.throws(() => commit({ draftId: r.draftId, chat: '' }), /Escolha o modelo/);
  assert.throws(() => commit({ draftId: r.draftId, chat: 'whisper-1' }), /não está entre os modelos de conversa/, 'áudio não serve de conversa');
  assert.throws(() => commit({ draftId: r.draftId, chat: 'sora-2' }), /não está entre os modelos de conversa/);
  assert.throws(() => commit({ draftId: r.draftId, chat: 'text-embedding-3-small' }), /não está entre os modelos de conversa/, 'ignorado não entra');
  assert.throws(() => commit({ draftId: r.draftId, chat: 'toString' }), /não está entre os modelos/);
  assert.throws(() => commit({ draftId: r.draftId, chat: '__proto__' }), /Escolha o modelo/);
  assert.equal(t.ai.getPublicConfig().providers.length, 0, 'nada foi criado');
  assert.equal(t.has(), false);
  assert.ok(commit({ draftId: r.draftId, chat: 'gpt-4o-mini' }).addedId, 'depois das recusas o rascunho ainda vale');
});

test('ids hostis do servidor: __proto__ some, constructor e toString viram modelos comuns sem poluir nada', async () => {
  const t = setup({ net: makeNet(() => res({ data: [{ id: '__proto__' }, { id: 'constructor' }, { id: 'toString' }, { id: 'hasOwnProperty' }, { id: 'a\u0000b' }, { id: 'x'.repeat(121) }, { id: 'llama3' }] })) });
  const r = await t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
  assert.deepEqual(r.models.map((m) => m.id), ['constructor', 'toString', 'hasOwnProperty', 'llama3']);
  const cfg = t.ai.saveConfig({ commitDiscovery: { draftId: r.draftId, chat: 'constructor' } });
  assert.equal(cfg.providers[0].model, 'constructor');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(JSON.parse(t.disk()).providers[0].models[0]), Object.prototype);
});

test('TTL de 10 min, descartar e limite de 3 rascunhos (o mais antigo é descartado e zerado)', async () => {
  const t = setup();
  const r = await t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
  t.clock.t += 10 * 60 * 1000 - 1;
  assert.ok(t.ai._liveDraft(r.draftId), 'ainda vale 1 ms antes');
  t.clock.t += 2;
  assert.throws(() => t.ai.saveConfig({ commitDiscovery: { draftId: r.draftId, chat: 'gpt-4.1' } }), /A busca expirou/);
  assert.equal(t.ai._drafts.size, 0, 'o expirado é apagado');

  const d = await t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
  const live = t.ai._drafts.get(d.draftId);
  assert.equal(live.key, KEY);
  assert.equal(await t.ai.discoverProvider({ discard: d.draftId }), true);
  assert.equal(live.key, '', 'descartar zera a chave');
  assert.equal(t.ai._drafts.size, 0);
  assert.equal(await t.ai.discoverProvider({ discard: 'nao-existe' }), true, 'descartar o que não existe também devolve true');
  assert.throws(() => t.ai.saveConfig({ commitDiscovery: { draftId: d.draftId, chat: 'gpt-4.1' } }), /expirou/);

  const first = await t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
  const firstDraft = t.ai._drafts.get(first.draftId);
  const second = await t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
  const third = await t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
  assert.equal(t.ai._drafts.size, 3);
  const fourth = await t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
  assert.equal(t.ai._drafts.size, 3);
  assert.equal(firstDraft.key, '', 'o mais antigo foi zerado');
  assert.throws(() => t.ai.saveConfig({ commitDiscovery: { draftId: first.draftId, chat: 'gpt-4.1' } }), /expirou/);
  for (const x of [second, third, fourth]) assert.ok(t.ai._liveDraft(x.draftId));
});

test('uma descoberta por vez: a nova aborta a anterior (que não cria rascunho); dispose apaga tudo', async () => {
  const t = setup();
  const pending = [];
  t.net.handler = (url, init) => new Promise((resolve, reject) => {
    pending.push({ resolve, init });
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const first = t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
  const firstSettled = first.then(() => 'ok', (e) => e.code);
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.length, 1);
  const second = t.ai.discoverProvider({ baseUrl: 'https://api.outro.com/v1', apiKey: KEY });
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.length, 2);
  assert.equal(await firstSettled, 'CANCELLED');
  pending[1].resolve(res(LIST));
  const r = await second;
  assert.equal(r.host, 'api.outro.com');
  assert.equal(t.ai._drafts.size, 1, 'só a descoberta que valeu criou rascunho');

  // dispose: aborta a em andamento e zera os rascunhos
  const third = t.ai.discoverProvider({ baseUrl: REMOTE, apiKey: KEY });
  const thirdSettled = third.then(() => 'ok', (e) => e.code);
  await new Promise((x) => setImmediate(x));
  const draft = t.ai._drafts.get(r.draftId);
  t.ai.dispose();
  assert.equal(await thirdSettled, 'CANCELLED');
  assert.equal(t.ai._drafts.size, 0);
  assert.equal(draft.key, '');
});

// ----------------------------------------------------------------- aviso de servidor externo

test('provedor remoto nasce em "consent" e o commit nunca aceita o aviso; o servidor local nasce ativo', async () => {
  const t = setup();
  const a = await addRemote(t);
  assert.equal(a.found.needsConsent, true);
  assert.equal(a.view.state, 'consent');
  assert.equal(a.view.needsRemoteConsent, true);
  assert.deepEqual(JSON.parse(t.disk()).remoteAccepted, []);
  assert.equal(t.ai.needsRemoteConsent(), true);
  assert.equal(t.ai.getPublicConfig().ready, false, 'sem aviso aceito o provedor não entra na cadeia');

  const local = await addRemote(t, { url: 'http://127.0.0.1:1234/v1', key: '' });
  assert.equal(local.found.needsConsent, false);
  assert.equal(local.found.isLocal, true);
  assert.equal(local.view.state, 'active');
  assert.equal(local.view.hasKey, false);
  assert.equal(t.net.lists().at(-1).headers.authorization, undefined, 'sem chave não há Authorization');

  // aceitar é um gesto separado do usuário
  const accepted = t.ai.saveConfig({ provider: { id: a.id, acceptRemote: true } });
  assert.equal(accepted.providers.find((p) => p.id === a.id).state, 'active');
});

test('a análise e a cadeia NÃO dispensam mais o aviso do primeiro provedor remoto: nada é enviado antes do aceite', async () => {
  const t = setup();
  const a = await addRemote(t);
  await assert.rejects(t.ai.chat({ messages: [{ role: 'user', content: 'texto da transcrição' }] }), (e) => {
    assert.equal(e.code, 'AI_ALL_FAILED');
    assert.match(e.message, /aviso de privacidade pendente/);
    assert.match(e.message, /Aceite o aviso de servidor externo nos detalhes do provedor\./, 'a mensagem diz o que fazer');
    return true;
  });
  assert.equal(t.net.chats().length, 0, 'o texto não saiu');
  t.ai.saveConfig({ provider: { id: a.id, acceptRemote: true } });
  const ok = await t.ai.chat({ messages: [{ role: 'user', content: 'texto da transcrição' }] });
  assert.equal(ok.text, 'ok');
  assert.equal(t.net.chats().length, 1);
});

test('nome de máquina que só COMEÇA com 127. é servidor externo: nasce em "consent"; 127.x.x.x de verdade, localhost e a rede local seguem locais', async () => {
  for (const host of ['127.attacker.com', '127.0.0.1.nip.io', '127.example.org']) {
    const t = setup();
    const found = await t.ai.discoverProvider({ baseUrl: `https://${host}/v1`, apiKey: KEY });
    assert.equal(found.isLocal, false, host);
    assert.equal(found.needsConsent, true, host);
    const cfg = t.ai.saveConfig({ commitDiscovery: { draftId: found.draftId, chat: 'gpt-4.1' } });
    const view = cfg.providers.find((p) => p.id === cfg.addedId);
    assert.deepEqual([view.isLocal, view.needsRemoteConsent, view.state], [false, true, 'consent'], host);
    assert.equal(AIService.isLocalOrLanHost(host), false, host);
  }
  for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '192.168.0.5']) {
    const t = setup();
    const found = await t.ai.discoverProvider({ baseUrl: `http://${host}:1234/v1` });
    assert.deepEqual([found.isLocal, found.needsConsent], [true, false], host);
    const cfg = t.ai.saveConfig({ commitDiscovery: { draftId: found.draftId, chat: 'gpt-4.1' } });
    const view = cfg.providers.find((p) => p.id === cfg.addedId);
    assert.deepEqual([view.isLocal, view.needsRemoteConsent, view.state], [true, false, 'active'], host);
  }
});

// ----------------------------------------------------------------- provedor existente: só mescla o catálogo

test('providerId: usa endereço e chave GRAVADOS, mescla só models/discoveredAt e conta os novos', async () => {
  const t = setup();
  const a = await addRemote(t);
  const b = await addRemote(t, { url: 'https://api.outro.com/v1', key: 'sk-outra-chave-999999', chat: 'gpt-4o-mini' });
  t.ai.saveConfig({ provider: { id: a.id, enabled: false, label: 'Nome do usuário', model: 'gpt-4o-mini' }, order: [b.id, a.id] });
  const before = JSON.stringify(t.ai.getPublicConfig().providers.find((p) => p.id === a.id));
  const disk0 = JSON.parse(t.disk());

  t.clock.t += 60_000;
  t.net.handler = () => res({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-5' }, { id: 'whisper-large-v3-turbo' }] });
  const r = await t.ai.discoverProvider({ providerId: a.id, apiKey: 'sk-do-renderer-nao-vale', baseUrl: 'https://evil.example/v1' });
  assert.deepEqual(Object.keys(r).sort(), ['added', 'counts', 'format', 'models', 'providerId']);
  assert.equal(r.providerId, a.id);
  assert.equal(r.format, 'openai');
  assert.equal(r.added, 2, 'gpt-5 e whisper-large-v3-turbo são novos');
  assert.deepEqual(r.counts, { chat: 2, audio: 1, image: 2, video: 0 });
  const call = t.net.lists().at(-1);
  assert.equal(call.url, `${REMOTE}/models`, 'usa o endereço gravado, nunca o do pedido');
  assert.equal(call.headers.authorization, `Bearer ${KEY}`, 'usa a chave gravada, nunca a do pedido');
  noKey(r);
  noKey(t.disk(), 'sk-do-renderer-nao-vale');

  const after = t.ai.getPublicConfig().providers.find((p) => p.id === a.id);
  const was = JSON.parse(before);
  for (const k of ['model', 'enabled', 'label', 'hasKey', 'baseUrl', 'preset', 'state']) assert.deepEqual(after[k], was[k], k);
  assert.deepEqual(t.ai.getPublicConfig().order, [b.id, a.id], 'a ordem não muda');
  // o modelo de conversa escolhido que sumiu do servidor continua no catálogo; os outros que sumiram saem
  assert.deepEqual(after.models.map((m) => m.id), ['gpt-4o-mini', 'gpt-5', 'whisper-large-v3-turbo']);
  assert.notEqual(after.discoveredAt, was.discoveredAt);
  const disk1 = JSON.parse(t.disk());
  assert.deepEqual(disk1.providers.find((p) => p.id === b.id), disk0.providers.find((p) => p.id === b.id), 'o outro provedor não é tocado');
  assert.deepEqual(disk1.remoteAccepted, disk0.remoteAccepted);
});

test('providerId: o modelo escolhido que sumiu do servidor continua no catálogo; embedded, inexistente e endereço trocado são recusados', async () => {
  const t = setup();
  const a = await addRemote(t, { chat: 'gpt-4.1' });
  t.net.handler = () => res({ data: [{ id: 'gpt-5' }] });
  const r = await t.ai.discoverProvider({ providerId: a.id });
  assert.deepEqual(r.models.map((m) => m.id), ['gpt-5', 'gpt-4.1']);
  assert.equal(r.added, 1);

  await assert.rejects(t.ai.discoverProvider({ providerId: 'nao-existe' }), /Provedor não encontrado/);
  const emb = t.ai.saveConfig({ addProvider: { preset: 'embedded' } }).addedId;
  await assert.rejects(t.ai.discoverProvider({ providerId: emb }), (e) => e.code === 'INTERNAL_PROVIDER');
  const before = t.net.calls.length;
  assert.equal(t.net.calls.length, before);

  // o provedor mudou de endereço durante a busca: o resultado antigo não é gravado
  let release;
  t.net.handler = () => new Promise((resolve) => { release = () => resolve(res({ data: [{ id: 'novo-modelo' }] })); });
  const pending = t.ai.discoverProvider({ providerId: a.id });
  await new Promise((x) => setImmediate(x));
  t.ai.saveConfig({ provider: { id: a.id, baseUrl: 'https://api.trocado.com/v1' } });
  release();
  await assert.rejects(pending, (e) => e.code === 'CHANGED');
  assert.deepEqual(t.ai.getPublicConfig().providers.find((p) => p.id === a.id).models, [], 'trocar o endereço limpa o catálogo do servidor antigo');
  assert.equal(t.ai.getPublicConfig().providers.find((p) => p.id === a.id).hasKey, false, 'e apaga a chave, como sempre');
});

// ----------------------------------------------------------------- rollback e migração

test('rollback: erro depois de mexer no catálogo deixa getPublicConfig() e o disco idênticos (e o rascunho vale)', async () => {
  const t = setup();
  await addRemote(t);
  const fresh = await t.ai.discoverProvider({ baseUrl: 'https://api.outro.com/v1', apiKey: KEY });
  const snapPublic = JSON.stringify(t.ai.getPublicConfig());
  const snapDisk = t.disk();

  // erro de validação DEPOIS do commit na cópia
  assert.throws(() => t.ai.saveConfig({ commitDiscovery: { draftId: fresh.draftId, chat: 'gpt-4.1' }, order: 'invalida' }), /Ordem dos provedores inválida/);
  assert.equal(JSON.stringify(t.ai.getPublicConfig()), snapPublic);
  assert.equal(t.disk(), snapDisk);
  assert.ok(t.ai._liveDraft(fresh.draftId), 'o rascunho não foi consumido');

  // falha ao gravar no disco
  const before = t.ai._load();
  const persist = t.ai._persist;
  t.ai._persist = () => { throw new Error('disco cheio'); };
  assert.throws(() => t.ai.saveConfig({ commitDiscovery: { draftId: fresh.draftId, chat: 'gpt-4.1' } }), /disco cheio/);
  t.ai._persist = persist;
  assert.equal(t.ai._load(), before, 'o cache em memória voltou ao objeto anterior');
  assert.equal(JSON.stringify(t.ai.getPublicConfig()), snapPublic);
  assert.equal(t.disk(), snapDisk);
  assert.ok(t.ai._liveDraft(fresh.draftId));
  assert.ok(t.ai.saveConfig({ commitDiscovery: { draftId: fresh.draftId, chat: 'gpt-4.1' } }).addedId, 'e agora grava');
});

test('saveConfig trabalha numa CÓPIA PROFUNDA dos provedores (inclui o catálogo)', async () => {
  const t = setup();
  await addRemote(t);
  const before = t.ai._load();
  let during = null;
  const persist = t.ai._persist.bind(t.ai);
  t.ai._persist = function spy() { during = this._config; return persist(); };
  t.ai.saveConfig({ maxTokens: 512 });
  assert.notEqual(during, before);
  assert.notEqual(during.providers[0], before.providers[0]);
  assert.notEqual(during.providers[0].models, before.providers[0].models);
  assert.notEqual(during.providers[0].models[0], before.providers[0].models[0]);
  assert.notEqual(during.providers[0].models[0].caps, before.providers[0].models[0].caps);
  assert.deepEqual(during.providers[0].models, before.providers[0].models);
  // mexer no catálogo da cópia não alcança o que está valendo
  before.providers[0].models[0].caps.push('video');
  const cp = t.ai._cloneConfig(before);
  cp.providers[0].models[0].caps.pop();
  assert.ok(before.providers[0].models[0].caps.includes('video'));
});

test('migração: ai.json antigo (sem catálogo) carrega; catálogo editado à mão é limpo sem derrubar nada', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({
    providers: [
      { id: 'p-groq', preset: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnc: 'abc', model: 'llama-3.3-70b-versatile', enabled: true },
      {
        id: 'p-novo', preset: 'custom', label: 'Novo', baseUrl: 'https://api.example.com/v1', apiKeyEnc: '', model: 'm', enabled: true,
        discoveredAt: '2026-11-20T10:00:00.000Z',
        models: [
          { id: 'ok-1', caps: ['chat', 'image', 'coisa'], source: 'metadado' },
          { id: 'ok-1', caps: ['chat'], source: 'nome' },
          { id: '__proto__', caps: ['chat'], source: 'nome' },
          { id: '', caps: ['chat'] },
          { id: 'sem-caps', caps: [] },
          { id: 'caps-ruins', caps: 'chat' },
          { id: 'audio-1', caps: ['audio'], source: 'qualquer', timing: 'palavras' },
          { id: 'chat-1', caps: ['chat'], timing: 'palavras' },
          'texto', null, 42
        ]
      },
      { id: 'p-ruim', preset: 'custom', label: 'Ruim', baseUrl: 'https://api.ruim.com/v1', model: 'm', models: 'não é lista', discoveredAt: 12345 }
    ],
    order: ['p-groq', 'p-novo', 'p-ruim']
  }), 'utf8');
  const ai = new AIService({ configDir: dir, safeStorage });
  const [groq, novo, ruim] = ai.getPublicConfig().providers;
  assert.deepEqual([groq.models, groq.modelCounts, groq.discoveredAt, groq.format], [[], { chat: 0, audio: 0, image: 0, video: 0 }, '', 'openai']);
  assert.deepEqual(novo.models, [
    { id: 'ok-1', caps: ['chat', 'image'], source: 'metadado' },
    { id: 'audio-1', caps: ['audio'], source: 'nome' },
    { id: 'chat-1', caps: ['chat'], source: 'nome' }
  ]);
  assert.equal(novo.discoveredAt, '2026-11-20T10:00:00.000Z');
  assert.deepEqual([ruim.models, ruim.discoveredAt], [[], '']);
  assert.equal(groq.hasKey, true);
  const saved = ai.saveConfig({ maxTokens: 300 });
  assert.equal(saved.providers.length, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ai.json'), 'utf8')).providers[1].models[2].timing, undefined);
  assert.equal(ai._load().providers[1].models.find((m) => m.id === 'audio-1').timing, 'palavras', 'timing de áudio fica no catálogo guardado');
});

// ----------------------------------------------------------------- Anthropic

const ANTHROPIC_LIST = {
  data: [
    { type: 'model', id: 'claude-opus-4-1', display_name: 'Claude Opus 4.1', capabilities: { image_input: { supported: true } } },
    { type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', capabilities: { image_input: { supported: true } } },
    { type: 'model', id: 'claude-haiku-3-5', display_name: 'Claude Haiku 3.5', capabilities: { image_input: { supported: false } } }
  ],
  has_more: false,
  last_id: 'claude-haiku-3-5'
};
const anthropicNet = () => makeNet((url) => (url.endsWith('/chat/completions') ? res(CHAT_OK) : res(ANTHROPIC_LIST)));

test('Anthropic: descoberta pela API nativa (x-api-key, sem Authorization), provedor "anthropic" nasce em consent e o formato vem do endereço', async () => {
  const t = setup({ net: anthropicNet() });
  const found = await t.ai.discoverProvider({ baseUrl: 'https://api.anthropic.com', apiKey: KEY });
  assert.equal(found.format, 'anthropic');
  assert.equal(found.label, 'Anthropic');
  assert.equal(found.defaultChat, 'claude-sonnet-4-5', 'prefere sonnet a opus');
  assert.deepEqual(found.counts, { chat: 3, audio: 0, image: 2, video: 0 });
  assert.equal(found.needsConsent, true);
  const call = t.net.lists()[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/models?limit=100');
  assert.equal(call.headers['x-api-key'], KEY);
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.headers.authorization, undefined);
  noKey(found);
  const cfg = t.ai.saveConfig({ commitDiscovery: { draftId: found.draftId, chat: found.defaultChat } });
  const p = cfg.providers[0];
  assert.deepEqual([p.preset, p.label, p.format, p.baseUrl, p.state, p.model], ['anthropic', 'Anthropic', 'anthropic', 'https://api.anthropic.com/v1', 'consent', 'claude-sonnet-4-5']);
  assert.equal(p.keyRequired, true);
  assert.equal(p.suggestedModel, '');

  // endereço parecido NÃO é Anthropic: formato OpenAI, só Bearer
  const t2 = setup({ net: anthropicNet() });
  const lookalike = await t2.ai.discoverProvider({ baseUrl: 'https://api.anthropic.com.exemplo.com/v1', apiKey: KEY });
  assert.equal(lookalike.format, 'openai');
  const c2 = t2.net.lists()[0];
  assert.equal(c2.headers.authorization, `Bearer ${KEY}`);
  assert.equal(c2.headers['x-api-key'], undefined);
  await assert.rejects(t2.ai.discoverProvider({ baseUrl: 'http://api.anthropic.com/v1', apiKey: KEY }), (e) => e.code === 'INSECURE');
});

test('AnthropicProvider: listModels devolve [{id,label}] pela API nativa e testConnection faz a conversa mínima de verdade', async () => {
  const net = anthropicNet();
  const provider = new AnthropicProvider({ getBaseUrl: () => 'https://api.anthropic.com/v1', getApiKey: () => KEY, fetchImpl: net.fetch });
  assert.ok(provider instanceof OpenAIProvider);
  assert.equal(provider.id, 'anthropic');
  assert.deepEqual(await provider.listModels(), [
    { id: 'claude-opus-4-1', label: 'claude-opus-4-1' },
    { id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
    { id: 'claude-haiku-3-5', label: 'claude-haiku-3-5' }
  ]);
  assert.equal(net.chats().length, 0, 'listar não conversa');
  assert.equal(net.lists()[0].headers.authorization, undefined);

  const test = await provider.testConnection({ model: 'claude-sonnet-4-5' });
  assert.equal(test.ok, true);
  assert.match(test.message, /3 modelo/);
  const chat = net.chats()[0];
  assert.equal(chat.url, 'https://api.anthropic.com/v1/chat/completions');
  assert.equal(chat.headers.authorization, `Bearer ${KEY}`, 'a conversa vai pela camada de compatibilidade, com Bearer');
  assert.equal(chat.headers['x-api-key'], undefined);
  const body = JSON.parse(chat.body);
  assert.equal(body.model, 'claude-sonnet-4-5');
  assert.ok(body.max_tokens > 0 && body.max_tokens <= 32, 'conversa mínima');
  for (const k of ['temperature', 'top_p', 'response_format', 'tool_choice']) assert.equal(body[k], undefined, `${k} nunca é enviado`);

  // teste verde tem que provar a conversa: sem modelo, recusa; conversa que falha derruba o teste
  await assert.rejects(provider.testConnection(), (e) => e.code === 'NO_MODEL');
  await assert.rejects(provider.testConnection({ model: '  ' }), (e) => e.code === 'NO_MODEL');
  net.handler = (url) => (url.endsWith('/chat/completions') ? res({ error: { message: 'modelo não existe' } }, 404) : res(ANTHROPIC_LIST));
  await assert.rejects(provider.testConnection({ model: 'claude-inexistente' }), (e) => e.status === 404);
  const noKeyProvider = new AnthropicProvider({ getBaseUrl: () => 'https://api.anthropic.com/v1', getApiKey: () => '', fetchImpl: net.fetch });
  await assert.rejects(noKeyProvider.listModels(), (e) => e.code === 'NO_KEY' && e.message === MESSAGES.NO_KEY);
});

test('AIService escolhe o provedor pelo endereço: AnthropicProvider só em api.anthropic.com (https); testConnection e listModels pelo card', async () => {
  const net = anthropicNet();
  const t = setup({ net });
  const found = await t.ai.discoverProvider({ baseUrl: 'https://api.anthropic.com/v1', apiKey: KEY });
  const id = t.ai.saveConfig({ commitDiscovery: { draftId: found.draftId, chat: 'claude-haiku-3-5' } }).addedId;
  assert.ok(t.ai._providerFor(t.ai._find(id)) instanceof AnthropicProvider);
  const other = await addRemote(t, { chat: 'claude-sonnet-4-5' });
  const generic = t.ai._providerFor(t.ai._find(other.id));
  assert.ok(generic instanceof OpenAIProvider && !(generic instanceof AnthropicProvider));
  const http = t.ai.saveConfig({ addProvider: { preset: 'custom', label: 'Falso', baseUrl: 'http://api.anthropic.com/v1', model: 'm' } }).addedId;
  assert.ok(!(t.ai._providerFor(t.ai._find(http)) instanceof AnthropicProvider), 'http:// não é o host da Anthropic');

  assert.deepEqual((await t.ai.listModels(id)).map((m) => m.id), ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-3-5']);
  const r = await t.ai.testConnection(id);
  assert.equal(r.ok, true);
  assert.equal(r.providerId, id);
  assert.equal(JSON.parse(net.chats().at(-1).body).model, 'claude-haiku-3-5', 'testa a conversa no modelo escolhido do provedor');
  // sem modelo escolhido não há como provar a conversa
  t.ai.saveConfig({ provider: { id, model: '' } });
  await assert.rejects(t.ai.testConnection(id), /Escolha o modelo de conversa/);
  // refresh do catálogo (botão atualizar)
  const merged = await t.ai.discoverProvider({ providerId: id });
  assert.equal(merged.format, 'anthropic');
  assert.equal(merged.added, 0);
});

// ----------------------------------------------------------------- canais IPC

test('canais: ai:discoverProvider e commit por ai:saveConfig, schema estrito, erros fixos e a chave nunca volta ao renderer', async () => {
  const net = okNet();
  const dir = tmpDir();
  const handlers = new Map();
  const reg = createRegistry({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, logger: { warn() {} } });
  const ai = registerAiHandlers({ configDir: dir }, { handle: reg.handle, isDev: false, safeStorage, settingsManager: { load: () => ({}) }, broadcast() {}, fetchImpl: net.fetch, mcpAutoStart: false });
  const url = pathToFileURL(APP_PAGE).href;
  const ev = { senderFrame: { url, parent: null }, sender: { getType: () => 'window', getURL: () => url } };
  const call = (ch, ...a) => handlers.get(ch)(ev, ...a);

  assert.ok(handlers.has('ai:discoverProvider'));
  const found = await call('ai:discoverProvider', { baseUrl: REMOTE, apiKey: KEY });
  assert.equal(found.ok, true);
  assert.equal(found.data.counts.chat, 2);
  noKey(found);
  assert.equal(net.lists()[0].headers.authorization, `Bearer ${KEY}`);

  // esquema: campos desconhecidos, tipos errados e limites
  for (const bad of [{ baseUrl: REMOTE, extra: 1 }, { baseUrl: 5 }, { baseUrl: 'x'.repeat(501) }, { apiKey: 'k'.repeat(401), baseUrl: REMOTE }, 'texto']) {
    const r = await call('ai:discoverProvider', bad);
    assert.deepEqual([r.ok, r.code], [false, 'EINVALID']);
    noKey(r);
  }
  assert.equal((await call('ai:discoverProvider', { baseUrl: '' })).code, 'BAD_URL');
  assert.equal((await call('ai:discoverProvider')).code, 'EINVALID', 'o argumento é obrigatório');

  // erros: sempre o texto fixo do app
  net.handler = () => res(`{"error":"a chave ${KEY} é inválida (segredo do servidor)"}`, 401);
  const refused = await call('ai:discoverProvider', { baseUrl: REMOTE, apiKey: KEY });
  assert.deepEqual([refused.ok, refused.code, refused.error], [false, 'AUTH', MESSAGES.AUTH]);
  noKey(refused);
  net.handler = (u) => (u.endsWith('/chat/completions') ? res(CHAT_OK) : res(LIST));

  // commit pelo saveConfig existente
  const added = await call('ai:saveConfig', { commitDiscovery: { draftId: found.data.draftId, chat: 'gpt-4.1' } });
  assert.equal(added.ok, true);
  const id = added.data.addedId;
  const view = added.data.providers.find((p) => p.id === id);
  assert.deepEqual([view.state, view.hasKey, view.model, view.format], ['consent', true, 'gpt-4.1', 'openai']);
  noKey(added);
  noKey(await call('ai:getConfig'));
  noKey(fs.readFileSync(path.join(dir, 'ai.json'), 'utf8'));
  const again = await call('ai:saveConfig', { commitDiscovery: { draftId: found.data.draftId, chat: 'gpt-4.1' } });
  assert.deepEqual([again.ok, again.error], [false, 'A busca expirou. Procure os modelos de novo.']);
  const wrong = await call('ai:saveConfig', { commitDiscovery: 'texto' });
  assert.equal(wrong.ok, false);

  // atualizar o catálogo de um provedor existente, descartar rascunho, provedor interno
  net.handler = () => res({ data: [{ id: 'gpt-4.1' }, { id: 'gpt-5' }] });
  const merged = await call('ai:discoverProvider', { providerId: id });
  assert.deepEqual([merged.ok, merged.data.added, merged.data.providerId], [true, 1, id]);
  const draft = await call('ai:discoverProvider', { baseUrl: REMOTE, apiKey: KEY });
  assert.deepEqual(await call('ai:discoverProvider', { discard: draft.data.draftId }), { ok: true, data: true });
  assert.equal((await call('ai:saveConfig', { commitDiscovery: { draftId: draft.data.draftId, chat: 'gpt-5' } })).ok, false);
  const emb = (await call('ai:saveConfig', { addProvider: { preset: 'embedded' } })).data.addedId;
  const internal = await call('ai:discoverProvider', { providerId: emb });
  assert.deepEqual([internal.ok, internal.code], [false, 'INTERNAL_PROVIDER']);
  ai.dispose();
  assert.equal(ai._drafts.size, 0);
});
