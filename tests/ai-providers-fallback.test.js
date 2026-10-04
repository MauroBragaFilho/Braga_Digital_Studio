'use strict';

// Provedores de IA com chave própria e FALLBACK entre eles mantendo o contexto da conversa.
// Servidores HTTP falsos em localhost (um por provedor): 429/500/queda/tempo esgotado no primeiro e resposta no
// segundo; o segundo recebe o histórico completo do turno (inclusive ferramentas); cada chave só chega ao seu host;
// disjuntor; falha no meio do fluxo; migração do ai.json antigo; presets; aviso de servidor remoto por provedor.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const AIService = require('../src/services/ai/AIService');
const AssistantChat = require('../src/services/ai/AssistantChat');
const ChatHistory = require('../src/services/ai/ChatHistory');
const presets = require('../src/services/ai/providers/presets');
const registerAiHandlers = require('../src/ipc/aiHandlers');
const { createRegistry, APP_PAGE } = require('../src/ipc/channelRegistry');
const { pathToFileURL } = require('node:url');

const dirs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-aiprov-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(10); }
  throw new Error('waitFor: tempo esgotado');
}

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, '')
};

// ----------------------------------------------------------------- servidores falsos

function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (_) { /* vazio */ }
      requests.push({ url: req.url, headers: req.headers, body });
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'm-a' }, { id: 'm-b' }] }));
        return;
      }
      handler(req, res, body, requests.filter((r) => r.url.endsWith('/chat/completions')).length);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    chats: () => requests.filter((r) => r.url.endsWith('/chat/completions')),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
  })));
}
const sse = (res) => res.writeHead(200, { 'content-type': 'text/event-stream' });
const piece = (res, text) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
const finish = (res) => { res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`); res.end('data: [DONE]\n\n'); };
/** Responde texto: em SSE quando o pedido é de streaming, em JSON inteiro quando não é. */
function say(res, body, text) {
  if (body.stream) { sse(res); piece(res, text); finish(res); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
}
function callTool(res, name, args, id = 'call_1') {
  sse(res);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const fail = (res, status, message = 'falhou', headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ error: { message } }));
};

// ----------------------------------------------------------------- montagem

function fakeTools() {
  const executed = [];
  return {
    executed,
    deps: {},
    definitions: () => [{ type: 'function', function: { name: 'ping', description: 'teste', parameters: { type: 'object', properties: {} } } }],
    execute: async (name, args) => { executed.push({ name, args }); return JSON.stringify({ ok: true, feito: name }); },
    limitReached: () => '{"erro":"limite"}'
  };
}

/** AIService + AssistantChat com um provedor por servidor (preset "personalizado" apontando para o servidor falso). */
function setup(servers, { clock = null, fallback = true, tools = false, timeouts = {}, fetchImpl, keys = true } = {}) {
  const dir = tmpDir();
  const ai = new AIService({ configDir: dir, safeStorage, now: clock ? () => clock.t : undefined, fetchImpl });
  const ids = [];
  servers.forEach((s, i) => {
    const out = ai.saveConfig({ addProvider: { preset: 'custom', label: s.label, baseUrl: s.url, model: s.model || `modelo-${i + 1}` } });
    ids.push(out.addedId);
    if (keys) ai.saveConfig({ provider: { id: out.addedId, apiKey: `sk-chave-${i + 1}-secreta` } });
  });
  ai.saveConfig({ fallbackEnabled: fallback });
  const events = [];
  const toolbox = tools ? fakeTools() : null;
  const history = new ChatHistory({ dir });
  const chat = new AssistantChat({ ai, history, emit: (channel, payload) => events.push({ channel, ...payload }), timeouts, toolbox });
  const of = (channel) => events.filter((e) => e.channel === channel);
  const status = (kind) => of('ai:chatStatus').filter((e) => e.kind === kind).map((e) => e.text);
  const ask = async (text) => {
    const before = events.length;
    chat.start(text);
    await waitFor(() => events.slice(before).some((e) => e.channel === 'ai:chatDone' || e.channel === 'ai:chatError'));
    return events.slice(before);
  };
  return { ai, ids, chat, history, events, of, status, ask, toolbox, dir };
}

const withServers = async (handlers, fn) => {
  const servers = await Promise.all(handlers.map((h) => startServer(h)));
  try { return await fn(servers); } finally { await Promise.all(servers.map((s) => s.close())); }
};
const label = (s, name) => Object.assign(s, { label: name });

// ----------------------------------------------------------------- (a) fallback mantém o contexto

for (const [nome, falha, frase] of [
  ['429 (limite de uso)', (res) => fail(res, 429, 'Rate limit', { 'retry-after': '2' }), 'Primeiro no limite de uso'],
  ['500', (res) => fail(res, 500, 'erro interno'), 'Primeiro indisponível'],
  ['queda da conexão', (res) => res.destroy(), 'Primeiro indisponível'],
  ['503', (res) => fail(res, 503, 'sobrecarga'), 'Primeiro indisponível']
]) {
  test(`fallback (${nome}): o segundo provedor responde e recebe o histórico inteiro; o histórico salvo não duplica`, async () => {
    await withServers([
      (req, res) => falha(res),
      (req, res, body) => say(res, body, 'Resposta do segundo.')
    ], async ([s1, s2]) => {
      const t = setup([label(s1, 'Primeiro'), label(s2, 'Segundo')]);
      // 1ª pergunta já cai no segundo; a 2ª leva a conversa anterior junto
      const first = await t.ask('Quanto é 2+2?');
      assert.ok(first.some((e) => e.channel === 'ai:chatDone' && e.text === 'Resposta do segundo.'));
      assert.deepEqual(t.status('fallback'), [`Usando Segundo (${frase})`]);
      assert.deepEqual(t.status('provider').slice(-1), ['Segundo']);
      const sent = s2.chats()[0].body.messages;
      assert.deepEqual(sent.map((m) => m.role), ['system', 'user']);
      assert.equal(sent[1].content, 'Quanto é 2+2?');

      await t.ask('E 3+3?');
      const again = s2.chats().slice(-1)[0].body.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}:${m.content}`);
      assert.deepEqual(again, ['user:Quanto é 2+2?', 'assistant:Resposta do segundo.', 'user:E 3+3?']);
      // histórico salvo: só user/assistant, sem duplicar
      assert.deepEqual(t.history.get().map((m) => `${m.role}:${m.content}`), [
        'user:Quanto é 2+2?', 'assistant:Resposta do segundo.', 'user:E 3+3?', 'assistant:Resposta do segundo.'
      ]);
    });
  });
}

test('fallback (servidor desligado: porta fechada): continua no próximo', async () => {
  const closed = await startServer(() => {});
  const deadUrl = closed.url;
  await closed.close();
  await withServers([(req, res, body) => say(res, body, 'Estou aqui.')], async ([s2]) => {
    const t = setup([{ url: deadUrl, label: 'Caído' }, label(s2, 'Vivo')]);
    const out = await t.ask('oi');
    assert.ok(out.some((e) => e.channel === 'ai:chatDone' && e.text === 'Estou aqui.'));
    assert.deepEqual(t.status('fallback'), ['Usando Vivo (Caído indisponível)']);
  });
});

test('fallback (tempo esgotado): o provedor que não responde é trocado', async () => {
  await withServers([
    () => { /* nunca responde */ },
    (req, res, body) => say(res, body, 'Segundo respondeu.')
  ], async ([s1, s2]) => {
    const t = setup([label(s1, 'Lento'), label(s2, 'Rápido')], { timeouts: { firstChunkTimeoutMs: 150, idleTimeoutMs: 150 } });
    const out = await t.ask('oi');
    assert.ok(out.some((e) => e.channel === 'ai:chatDone' && e.text === 'Segundo respondeu.'));
    assert.deepEqual(t.status('fallback'), ['Usando Rápido (Lento indisponível)']);
  });
});

test('ferramentas: a ação confirmada roda UMA vez e o próximo provedor recebe a chamada e o resultado', async () => {
  await withServers([
    (req, res, body, n) => (n === 1 ? callTool(res, 'ping', { x: 1 }) : fail(res, 500, 'caiu na 2ª rodada')),
    (req, res, body) => say(res, body, 'Feito, com o resultado da ferramenta.')
  ], async ([s1, s2]) => {
    const t = setup([label(s1, 'Primeiro'), label(s2, 'Segundo')], { tools: true });
    const out = await t.ask('faça o ping');
    assert.ok(out.some((e) => e.channel === 'ai:chatDone' && /Feito/.test(e.text)));
    assert.equal(t.toolbox.executed.length, 1, 'a ação não se repete no fallback');
    const roles = s2.chats()[0].body.messages.map((m) => m.role);
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool']);
    const msgs = s2.chats()[0].body.messages;
    assert.equal(msgs[2].tool_calls[0].function.name, 'ping');
    assert.equal(msgs[3].tool_call_id, 'call_1');
    assert.match(msgs[3].content, /feito/);
    assert.deepEqual(t.status('fallback'), ['Usando Segundo (Primeiro indisponível)']);
    // o histórico guarda só user/assistant
    assert.deepEqual(t.history.get().map((m) => m.role), ['user', 'assistant']);
    assert.ok(!JSON.stringify(t.history.get()).includes('tool'));
  });
});

// ----------------------------------------------------------------- (b) fallback desligado

test('fallback desligado: erro amigável e nenhum outro provedor é tentado', async () => {
  await withServers([(req, res) => fail(res, 500, 'caiu'), (req, res, body) => say(res, body, 'não deveria')], async ([s1, s2]) => {
    const t = setup([label(s1, 'Primeiro'), label(s2, 'Segundo')], { fallback: false });
    const out = await t.ask('oi');
    const err = out.find((e) => e.channel === 'ai:chatError');
    assert.ok(err);
    assert.equal(err.code, 'AI_ALL_FAILED');
    assert.match(err.error, /Primeiro: indisponível/);
    assert.match(err.error, /troca automática de provedor está desligada/);
    assert.equal(s2.chats().length, 0);
    assert.equal(t.history.get().length, 0, 'a pergunta sem resposta não entra no histórico');
  });
});

// ----------------------------------------------------------------- (c) 401 e (d) erros que não trocam

test('401: avisa qual provedor falhou (sem repetir o texto do servidor) e segue', async () => {
  await withServers([
    (req, res) => fail(res, 401, 'Incorrect API key provided: sk-chave-1-secreta'),
    (req, res, body) => say(res, body, 'Ok pelo segundo.')
  ], async ([s1, s2]) => {
    const t = setup([label(s1, 'Primeiro'), label(s2, 'Segundo')]);
    const out = await t.ask('oi');
    assert.ok(out.some((e) => e.channel === 'ai:chatDone' && e.text === 'Ok pelo segundo.'));
    assert.deepEqual(t.status('fallback'), ['Usando Segundo (chave do Primeiro recusada)']);
    assert.ok(!JSON.stringify(t.events).includes('sk-chave'), 'nenhuma chave nos eventos');
    assert.equal(t.ai.getPublicConfig().providers[0].state, 'standby');
  });
});

test('400 de conteúdo NÃO aciona o fallback', async () => {
  await withServers([(req, res) => fail(res, 400, 'conteúdo inválido'), (req, res, body) => say(res, body, 'não')], async ([s1, s2]) => {
    const t = setup([label(s1, 'Primeiro'), label(s2, 'Segundo')]);
    const out = await t.ask('oi');
    const err = out.find((e) => e.channel === 'ai:chatError');
    assert.match(err.error, /400/);
    assert.equal(s2.chats().length, 0);
    assert.equal(t.ai.getPublicConfig().providers[0].state, 'active', '400 não coloca o provedor em espera');
  });
});

test('cancelar NÃO aciona o fallback nem põe o provedor em espera', async () => {
  await withServers([() => { /* pensando */ }, (req, res, body) => say(res, body, 'não')], async ([s1, s2]) => {
    const t = setup([label(s1, 'Primeiro'), label(s2, 'Segundo')]);
    const id = t.chat.start('oi');
    await waitFor(() => s1.chats().length === 1);
    t.chat.cancel(id);
    await waitFor(() => t.of('ai:chatDone').length === 1);
    assert.equal(t.of('ai:chatDone')[0].cancelled, true);
    assert.equal(s2.chats().length, 0);
    assert.equal(t.ai.getPublicConfig().providers[0].state, 'active');
  });
});

test('404 (modelo inexistente) aciona o fallback; 422 não', async () => {
  const ai = new AIService({ configDir: tmpDir(), safeStorage });
  assert.deepEqual([ai._classify({ status: 404 }).fallback, ai._classify({ status: 422 }).fallback, ai._classify({ status: 400 }).fallback], [true, false, false]);
  assert.equal(ai._classify({ status: 404 }).kind, 'model');
  assert.equal(ai._classify({ code: 'TIMEOUT' }).fallback, true);
  assert.equal(ai._classify({ code: 'CANCELLED' }).fallback, false);
  assert.equal(ai._classify(new Error('bug qualquer')).fallback, false);
});

// ----------------------------------------------------------------- todos falham

test('todos falham: uma mensagem única, amigável e sem chaves', async () => {
  await withServers([(req, res) => fail(res, 429, 'cota'), (req, res) => fail(res, 401, 'chave sk-chave-2-secreta ruim')], async ([s1, s2]) => {
    const t = setup([label(s1, 'Groq'), label(s2, 'Qwen')]);
    const out = await t.ask('oi');
    const errors = out.filter((e) => e.channel === 'ai:chatError');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'AI_ALL_FAILED');
    assert.match(errors[0].error, /Groq \(limite de uso atingido\); Qwen \(chave recusada\)/);
    assert.ok(!errors[0].error.includes('sk-'));
  });
});

// ----------------------------------------------------------------- (e) servidor remoto sem aviso aceito

test('servidor remoto sem aviso aceito é PULADO (nada é enviado a ele) e o chat diz isso; depois do aceite ele entra', async () => {
  await withServers([(req, res) => fail(res, 500, 'caiu'), (req, res, body) => say(res, body, 'Local respondeu.')], async ([s1, s3]) => {
    const remoteHits = [];
    const real = global.fetch;
    const fetchImpl = (url, opts) => {
      if (String(url).startsWith('https://api.groq.com')) { remoteHits.push({ url: String(url), auth: opts.headers.authorization }); return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })); }
      return real(url, opts);
    };
    const t = setup([label(s1, 'Primeiro')], { fetchImpl });
    // 2º da fila: Groq remoto com chave, SEM aceite; 3º: local
    const g = t.ai.saveConfig({ addProvider: { preset: 'groq' } }).addedId;
    t.ai.saveConfig({ provider: { id: g, apiKey: 'sk-groq-chave-1234' } });
    const l = t.ai.saveConfig({ addProvider: { preset: 'custom', label: 'Terceiro', baseUrl: s3.url, model: 'm3' } }).addedId;
    assert.ok(l);
    const out = await t.ask('oi');
    assert.ok(out.some((e) => e.channel === 'ai:chatDone' && e.text === 'Local respondeu.'));
    assert.equal(remoteHits.length, 0, 'nada saiu para o servidor remoto sem aviso aceito');
    assert.deepEqual(t.status('fallback'), ['Usando Terceiro (Primeiro indisponível; Groq sem aviso de privacidade aceito)']);

    // os locais caem e só sobra o remoto sem aceite: erro único, sem tentar o remoto
    const t2 = setup([{ url: 'http://127.0.0.1:1/v1', label: 'Fora' }], { fetchImpl });
    const g2 = t2.ai.saveConfig({ addProvider: { preset: 'groq' } }).addedId;
    t2.ai.saveConfig({ provider: { id: g2, apiKey: 'sk-groq-chave-1234' } });
    const out2 = await t2.ask('oi');
    assert.match(out2.find((e) => e.channel === 'ai:chatError').error, /Groq \(aviso de privacidade pendente\)/);
    assert.equal(remoteHits.length, 0);

    // depois do aceite (e só dele) o remoto passa a ser tentado, com a chave dele
    t2.ai.saveConfig({ provider: { id: g2, acceptRemote: true } });
    await t2.ask('oi de novo');
    assert.equal(remoteHits.length >= 1, true);
    assert.equal(remoteHits[0].auth, 'Bearer sk-groq-chave-1234');
  });
});

// ----------------------------------------------------------------- (f) chaves por host

test('cada chave só vai ao seu próprio host; trocar o host de um provedor apaga só a chave dele', async () => {
  await withServers([(req, res) => fail(res, 500, 'cai'), (req, res, body) => say(res, body, 'ok')], async ([s1, s2]) => {
    const t = setup([label(s1, 'Um'), label(s2, 'Dois')]);
    await t.ask('oi');
    await t.ai.listModels(t.ids[0]);
    await t.ai.testConnection(t.ids[1]);
    const auth = (s) => new Set(s.requests.map((r) => r.headers.authorization));
    assert.deepEqual([...auth(s1)], ['Bearer sk-chave-1-secreta']);
    assert.deepEqual([...auth(s2)], ['Bearer sk-chave-2-secreta']);

    const pub = JSON.stringify(t.ai.getPublicConfig());
    assert.ok(!pub.includes('sk-chave') && !pub.includes('apiKeyEnc') && !pub.includes('enc:'), 'a chave nunca volta ao renderer');
    const disk = fs.readFileSync(path.join(t.dir, 'ai.json'), 'utf8');
    assert.ok(!disk.includes('sk-chave-1-secreta'), 'no disco a chave está criptografada');

    // mesma origem: mantém; origem nova: apaga só a do provedor alterado
    let cfg = t.ai.saveConfig({ provider: { id: t.ids[0], baseUrl: `${s1.url}/` } });
    assert.deepEqual(cfg.providers.map((p) => p.hasKey), [true, true]);
    cfg = t.ai.saveConfig({ provider: { id: t.ids[0], baseUrl: 'http://127.0.0.1:9/v1' } });
    assert.deepEqual(cfg.providers.map((p) => p.hasKey), [false, true]);
    await t.ai.testConnection(t.ids[1]);
    assert.equal(s2.requests.slice(-1)[0].headers.authorization, 'Bearer sk-chave-2-secreta');
  });
});

// ----------------------------------------------------------------- (g) disjuntor

test('disjuntor: provedor que falhou fica em espera, não é tentado a cada mensagem e volta depois do tempo', async () => {
  let firstOk = false;
  await withServers([
    (req, res, body) => (firstOk ? say(res, body, 'Primeiro voltou.') : fail(res, 500, 'caiu')),
    (req, res, body) => say(res, body, 'Segundo.')
  ], async ([s1, s2]) => {
    const clock = { t: 1_000_000 };
    const t = setup([label(s1, 'Primeiro'), label(s2, 'Segundo')], { clock });
    await t.ask('1');
    assert.equal(s1.chats().length, 1);
    let cfg = t.ai.getPublicConfig();
    assert.equal(cfg.providers[0].state, 'standby');
    assert.ok(cfg.providers[0].standbySeconds > 55 && cfg.providers[0].standbySeconds <= 60);
    assert.equal(cfg.activeProvider.label, 'Segundo');

    clock.t += 30_000;
    await t.ask('2');
    assert.equal(s1.chats().length, 1, 'ainda em espera: não foi tentado');
    assert.match(t.status('fallback').slice(-1)[0], /Usando Segundo \(Primeiro indisponível\)/);

    firstOk = true;
    clock.t += 40_000; // passou dos 60 s
    await t.ask('3');
    assert.equal(s1.chats().length, 2, 'voltou a ser tentado');
    assert.equal(t.of('ai:chatDone').slice(-1)[0].text, 'Primeiro voltou.');
    cfg = t.ai.getPublicConfig();
    assert.equal(cfg.providers[0].state, 'active');
  });
});

test('disjuntor: o 429 respeita o Retry-After (máximo de 5 min); se TODOS estão em espera, tenta mesmo assim', async () => {
  await withServers([(req, res) => fail(res, 429, 'cota', { 'retry-after': '99999' }), (req, res) => fail(res, 500, 'caiu')], async ([s1, s2]) => {
    const clock = { t: 5_000 };
    const t = setup([label(s1, 'Um'), label(s2, 'Dois')], { clock });
    await t.ask('oi');
    const p = t.ai.getPublicConfig().providers;
    assert.equal(p[0].standbySeconds, 300);
    assert.equal(p[1].standbySeconds, 60);
    assert.equal(p[0].standbyReason, 'limit');
    await t.ask('de novo');
    assert.equal(s1.chats().length, 2, 'sem alternativa, o provedor em espera é tentado');
  });
});

test('salvar o provedor (ex.: nova chave) tira o provedor da espera', async () => {
  await withServers([(req, res) => fail(res, 401, 'chave ruim'), (req, res, body) => say(res, body, 'ok')], async ([s1, s2]) => {
    const t = setup([label(s1, 'Um'), label(s2, 'Dois')]);
    await t.ask('oi');
    assert.equal(t.ai.getPublicConfig().providers[0].state, 'standby');
    t.ai.saveConfig({ provider: { id: t.ids[0], apiKey: 'sk-chave-nova-123456' } });
    assert.equal(t.ai.getPublicConfig().providers[0].state, 'active');
  });
});

// ----------------------------------------------------------------- (h) falha no meio do streaming

test('falha no MEIO do fluxo SEM texto: o próximo assume em silêncio (nada a descartar)', async () => {
  await withServers([
    (req, res) => { sse(res); res.write(': aquecendo\n\n'); setTimeout(() => res.destroy(), 20); },
    (req, res, body) => say(res, body, 'Resposta inteira do segundo.')
  ], async ([s1, s2]) => {
    const t = setup([label(s1, 'Primeiro'), label(s2, 'Segundo')]);
    const out = await t.ask('oi');
    assert.equal(out.filter((e) => e.channel === 'ai:chatStatus' && e.kind === 'reset').length, 0);
    assert.equal(out.filter((e) => e.channel === 'ai:chatDelta').map((e) => e.text).join(''), 'Resposta inteira do segundo.');
    assert.equal(t.history.get()[1].content, 'Resposta inteira do segundo.');
  });
});

test('falha no MEIO do fluxo COM texto parcial: descarta o parcial, refaz no próximo e não duplica no histórico', async () => {
  await withServers([
    (req, res) => { sse(res); piece(res, 'Resposta parc'); setTimeout(() => res.destroy(), 30); },
    (req, res, body) => say(res, body, 'Resposta completa.')
  ], async ([s1, s2]) => {
    const t = setup([label(s1, 'Primeiro'), label(s2, 'Segundo')]);
    const out = await t.ask('oi');
    const kinds = out.filter((e) => e.channel === 'ai:chatDelta' || (e.channel === 'ai:chatStatus' && e.kind === 'reset'));
    assert.deepEqual(kinds.map((e) => (e.channel === 'ai:chatDelta' ? `d:${e.text}` : `reset:${e.text}`)), ['d:Resposta parc', 'reset:', 'd:Resposta completa.']);
    assert.equal(out.find((e) => e.channel === 'ai:chatDone').text, 'Resposta completa.');
    assert.deepEqual(t.history.get().map((m) => m.content), ['oi', 'Resposta completa.']);
    // o segundo recebeu exatamente a mesma pergunta (sem o parcial)
    assert.deepEqual(s2.chats()[0].body.messages.filter((m) => m.role !== 'system').map((m) => m.content), ['oi']);
  });
});

test('falha com texto parcial de uma rodada ANTERIOR de ferramentas: só o parcial da rodada atual é descartado', async () => {
  await withServers([
    (req, res, body, n) => {
      if (n === 1) { sse(res); piece(res, 'Vou consultar. '); res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'ping', arguments: '{}' } }] } }] })}\n\n`); res.end('data: [DONE]\n\n'); return; }
      sse(res); piece(res, 'trecho que'); setTimeout(() => res.destroy(), 30);
    },
    (req, res, body) => say(res, body, 'Pronto.')
  ], async ([s1, s2]) => {
    const t = setup([label(s1, 'Primeiro'), label(s2, 'Segundo')], { tools: true });
    const out = await t.ask('faça');
    const reset = out.find((e) => e.channel === 'ai:chatStatus' && e.kind === 'reset');
    // sobra o texto da rodada anterior (sem o que o provedor que falhou entregou depois)
    assert.equal(reset.text, 'Vou consultar. ');
    assert.equal(out.find((e) => e.channel === 'ai:chatDone').text, 'Vou consultar. \n\nPronto.');
    assert.equal(t.toolbox.executed.length, 1);
  });
});

// ----------------------------------------------------------------- análise de transcrição

test('chat() (usado pela análise de transcrição) usa a mesma cadeia com fallback', async () => {
  await withServers([(req, res) => fail(res, 503, 'fora'), (req, res, body) => say(res, body, 'Resumo do segundo.')], async ([s1, s2]) => {
    const t = setup([label(s1, 'Um'), label(s2, 'Dois')]);
    const r = await t.ai.chat({ messages: [{ role: 'user', content: 'resuma' }] });
    assert.equal(r.text, 'Resumo do segundo.');
    assert.deepEqual(r.provider.label, 'Dois');
    assert.equal(s1.chats().length, 1);
    assert.equal(s2.chats().length, 1);
  });
});

// ----------------------------------------------------------------- (j) migração

test('migração: o ai.json antigo (um servidor) vira o primeiro provedor, com preset detectado e a chave preservada', async () => {
  await withServers([(req, res, body) => say(res, body, 'Funciona.')], async ([s]) => {
    const dir = tmpDir();
    const oldKey = safeStorage.encryptString('sk-antiga-1234567').toString('base64');
    fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({
      baseUrl: s.url, apiKeyEnc: oldKey, model: 'meu-modelo', maxTokens: 777, customInstructions: 'Seja breve.', assistantEnabled: false, remoteAccepted: ['https://api.groq.com']
    }));
    const ai = new AIService({ configDir: dir, safeStorage });
    const cfg = ai.getPublicConfig();
    assert.equal(cfg.providers.length, 1);
    assert.deepEqual([cfg.providers[0].preset, cfg.providers[0].model, cfg.providers[0].hasKey, cfg.providers[0].enabled], ['custom', 'meu-modelo', true, true]);
    assert.deepEqual([cfg.maxTokens, cfg.customInstructions, cfg.assistantEnabled, cfg.fallbackEnabled], [777, 'Seja breve.', false, true]);
    assert.equal(cfg.hasKey, true);
    const r = await ai.chat({ messages: [{ role: 'user', content: 'oi' }] });
    assert.equal(r.text, 'Funciona.');
    assert.equal(s.chats()[0].headers.authorization, 'Bearer sk-antiga-1234567', 'a chave antiga continua valendo');

    // ao salvar, o arquivo passa para o formato novo (sem os campos do servidor único)
    ai.saveConfig({ fallbackEnabled: false });
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'ai.json'), 'utf8'));
    assert.equal(disk.baseUrl, undefined);
    assert.equal(disk.apiKeyEnc, undefined);
    assert.equal(disk.providers[0].apiKeyEnc, oldKey);
    assert.deepEqual(disk.order, [disk.providers[0].id]);
    assert.deepEqual(disk.remoteAccepted, ['https://api.groq.com']);
  });
});

test('migração: preset detectado pelo endereço (Groq, Qwen, LM Studio, Ollama, OpenAI) e servidor "de fábrica" não vira provedor', () => {
  const cases = [
    ['https://api.groq.com/openai/v1', 'groq'], ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen'],
    ['https://maas.qwencloudapi.com/compatible-mode/v1', 'qwen-alt'], ['http://localhost:1234/v1', 'lmstudio'],
    ['http://127.0.0.1:11434/v1', 'ollama'], ['https://api.openai.com/v1', 'openai'], ['http://192.168.0.5:8080/v1', 'custom']
  ];
  for (const [url, preset] of cases) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ baseUrl: url, apiKeyEnc: 'x', model: 'm' }));
    assert.equal(new AIService({ configDir: dir, safeStorage }).getPublicConfig().providers[0].preset, preset, url);
  }
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ baseUrl: 'https://api.openai.com/v1', apiKeyEnc: '', model: 'gpt-4o-mini', maxTokens: 1024 }));
  const cfg = new AIService({ configDir: dir, safeStorage }).getPublicConfig();
  assert.equal(cfg.providers.length, 0);
  assert.equal(cfg.ready, false);
});

test('presets: Groq, Qwen oficial, Qwen de outro endereço (não confirmado), LM Studio, Ollama, OpenAI e Personalizado', () => {
  const list = presets.publicList();
  assert.deepEqual(list.map((p) => p.id), ['groq', 'qwen', 'qwen-alt', 'lmstudio', 'ollama', 'openai', 'custom']);
  const by = Object.fromEntries(list.map((p) => [p.id, p]));
  assert.deepEqual([by.groq.baseUrl, by.groq.model], ['https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile']);
  assert.deepEqual([by.qwen.baseUrl, by.qwen.model], ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen-plus']);
  assert.equal(by['qwen-alt'].baseUrl, 'https://maas.qwencloudapi.com/compatible-mode/v1');
  assert.equal(by['qwen-alt'].unverified, true);
  assert.match(by['qwen-alt'].warning, /não confirmado como oficial/);
  assert.equal(by.qwen.unverified, false);
  assert.ok(new URL(by.qwen.baseUrl).hostname.endsWith('aliyuncs.com'));

  const ai = new AIService({ configDir: tmpDir(), safeStorage });
  const cfg = ai.saveConfig({ addProvider: { preset: 'qwen-alt' } });
  const p = cfg.providers[0];
  assert.deepEqual([p.preset, p.model, p.unverifiedAddress, p.keyRequired, p.isLocal, p.needsRemoteConsent, p.state], ['qwen-alt', 'qwen-plus', true, true, false, true, 'nokey']);
});

// ----------------------------------------------------------------- ordem, gestão, validações

test('ordem: subir/descer muda a prioridade e quem responde; remover provedor; limites', async () => {
  await withServers([(req, res, body) => say(res, body, 'A'), (req, res, body) => say(res, body, 'B')], async ([s1, s2]) => {
    const t = setup([label(s1, 'A'), label(s2, 'B')]);
    await t.ask('1');
    assert.equal(t.of('ai:chatDone')[0].text, 'A');
    const cfg = t.ai.saveConfig({ order: [t.ids[1], t.ids[0]] });
    assert.deepEqual(cfg.providers.map((p) => p.label), ['B', 'A']);
    assert.deepEqual(cfg.order, [t.ids[1], t.ids[0]]);
    await t.ask('2');
    assert.equal(t.of('ai:chatDone')[1].text, 'B');
    // ids desconhecidos ou repetidos não quebram a ordem
    const odd = t.ai.saveConfig({ order: ['zzz', t.ids[0], t.ids[0]] });
    assert.deepEqual(odd.order, [t.ids[0], t.ids[1]]);
    assert.throws(() => t.ai.saveConfig({ removeProvider: 'nao-existe' }), /não encontrado/);
    const rest = t.ai.saveConfig({ removeProvider: t.ids[0] });
    assert.deepEqual(rest.providers.map((p) => p.label), ['B']);
    assert.throws(() => t.ai.saveConfig({ addProvider: { preset: 'custom' } }), /endereço/);
    assert.throws(() => t.ai.saveConfig({ addProvider: { preset: 'inexistente' } }), /desconhecido/);
    assert.throws(() => t.ai.saveConfig({ provider: { id: t.ids[1], baseUrl: 'ftp://x' } }), /http/);
    const disk = JSON.parse(fs.readFileSync(path.join(t.dir, 'ai.json'), 'utf8'));
    assert.deepEqual(disk.order, [t.ids[1]]);
  });
});

test('provedor desligado, sem chave (preset que exige) ou sem modelo não entra na cadeia', async () => {
  await withServers([(req, res, body) => say(res, body, 'Terceiro.')], async ([s3]) => {
    const t = setup([]);
    const off = t.ai.saveConfig({ addProvider: { preset: 'custom', label: 'Desligado', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' } }).addedId;
    t.ai.saveConfig({ provider: { id: off, enabled: false } });
    t.ai.saveConfig({ addProvider: { preset: 'groq' } }); // sem chave
    t.ai.saveConfig({ addProvider: { preset: 'custom', label: 'SemModelo', baseUrl: 'http://127.0.0.1:2/v1', model: '' } });
    t.ai.saveConfig({ addProvider: { preset: 'custom', label: 'Bom', baseUrl: s3.url, model: 'm3' } });
    const cfg = t.ai.getPublicConfig();
    assert.deepEqual(cfg.providers.map((p) => p.state), ['off', 'nokey', 'active', 'active']);
    const out = await t.ask('oi');
    assert.ok(out.some((e) => e.channel === 'ai:chatDone' && e.text === 'Terceiro.'));
    assert.deepEqual(t.status('fallback'), ['Usando Bom (Groq sem chave; SemModelo sem modelo)']);
  });
});

test('estado vazio: sem provedores o primeiro uso devolve AI_NOT_CONFIGURED; ready=false e activeProvider=null', () => {
  const ai = new AIService({ configDir: tmpDir(), safeStorage });
  const cfg = ai.getPublicConfig();
  assert.deepEqual([cfg.providers, cfg.ready, cfg.activeProvider, cfg.fallbackEnabled], [[], false, null, true]);
  assert.equal(ai.configProblem().code, 'AI_NOT_CONFIGURED');
});

// ----------------------------------------------------------------- IPC

test('canais ai:*: getConfig devolve a lista sem chaves; saveConfig recebe alterações por provedor; testConnection e listModels aceitam providerId', async () => {
  await withServers([(req, res, body) => say(res, body, 'oi')], async ([s]) => {
    const dir = tmpDir();
    const handlers = new Map();
    const reg = createRegistry({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, logger: { warn() {} } });
    registerAiHandlers({ configDir: dir }, { handle: reg.handle, isDev: false, safeStorage, settingsManager: { load: () => ({}) }, broadcast() {} });
    const url = pathToFileURL(APP_PAGE).href;
    const ev = { senderFrame: { url, parent: null }, sender: { getType: () => 'window', getURL: () => url } };
    const call = (ch, ...a) => handlers.get(ch)(ev, ...a);

    const added = await call('ai:saveConfig', { addProvider: { preset: 'custom', label: 'Meu', baseUrl: s.url, model: 'm1' } });
    assert.equal(added.ok, true);
    const id = added.data.addedId;
    const keyed = await call('ai:saveConfig', { provider: { id, apiKey: 'sk-via-canal-123456' } });
    assert.equal(keyed.data.providers[0].hasKey, true);
    assert.ok(!JSON.stringify(keyed).includes('sk-via-canal'));
    const got = await call('ai:getConfig');
    assert.ok(!JSON.stringify(got).includes('sk-via-canal'));
    assert.equal(got.data.providers[0].label, 'Meu');

    const models = await call('ai:listModels', id);
    assert.deepEqual(models.data.map((m) => m.id), ['m-a', 'm-b']);
    const test = await call('ai:testConnection', id);
    assert.equal(test.data.ok, true);
    assert.equal(test.data.providerId, id);
    assert.equal(s.requests.at(-1).headers.authorization, 'Bearer sk-via-canal-123456');
    const missing = await call('ai:listModels', 'nao-existe');
    assert.deepEqual([missing.ok, missing.error], [false, 'Provedor não encontrado.']);
    // sem providerId: usa o provedor principal (compatível com a chamada antiga)
    assert.equal((await call('ai:testConnection')).ok, true);
  });
});
