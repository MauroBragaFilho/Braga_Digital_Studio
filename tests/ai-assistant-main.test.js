'use strict';

// Assistente de IA flutuante (processo principal): trava (AI_DISABLED), streaming contra um servidor HTTP falso em
// localhost (SSE: pedaços, fim, erro, cancelamento, tempo por inatividade, servidor sem streaming), histórico local
// (escrita atômica, limite, limpar) e validação do caminho em ai:analyzeTranscript.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const AIService = require('../src/services/ai/AIService');
const AssistantChat = require('../src/services/ai/AssistantChat');
const ChatHistory = require('../src/services/ai/ChatHistory');
const SettingsManager = require('../src/core/settings/SettingsManager');
const registerAiHandlers = require('../src/ipc/aiHandlers');
const { createRegistry, APP_PAGE } = require('../src/ipc/channelRegistry');
const { listTools } = require('../src/services/ai/tools');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bds-aiasst-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(10); }
  throw new Error('waitFor: tempo esgotado');
}

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, '')
};

/** Servidor falso do protocolo de chat: `handler(req, res, body, n)` decide a resposta. */
function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (_) { /* corpo vazio */ }
      requests.push({ url: req.url, headers: req.headers, body, closed: false });
      const entry = requests[requests.length - 1];
      res.on('close', () => { entry.closed = true; });
      handler(req, res, body, requests.length);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
  })));
}

const sse = (res) => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
const delta = (res, text, extra = {}) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, ...extra }] })}\n\n`);

/** Monta AIService + ChatHistory + AssistantChat apontando para o servidor falso. */
function makeChat(server, { timeouts = {}, dir = tmpDir() } = {}) {
  const ai = new AIService({ configDir: dir, safeStorage });
  ai.saveConfig({ baseUrl: server.url, model: 'modelo-teste' });
  const events = [];
  const history = new ChatHistory({ dir });
  const chat = new AssistantChat({ ai, history, emit: (channel, payload) => events.push({ channel, ...payload }), timeouts });
  return { ai, chat, history, events, dir };
}
const of = (events, channel) => events.filter((e) => e.channel === channel);

// ------------------------------------------------------------------------- streaming

test('streaming: pedaços chegam em ai:chatDelta, o fim em ai:chatDone e o histórico é gravado', async () => {
  const server = await startServer((req, res) => {
    sse(res);
    delta(res, 'Olá');
    // um evento cortado no meio entre duas gravações: o leitor precisa juntar os pedaços
    const half = `data: ${JSON.stringify({ choices: [{ delta: { content: ' mundo' } }] })}\n\n`;
    res.write(half.slice(0, 12));
    setTimeout(() => {
      res.write(half.slice(12));
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    }, 20);
  });
  const { chat, events, history, dir } = makeChat(server);
  try {
    const id = chat.start('  Oi, tudo bem?  ');
    assert.ok(id);
    assert.equal(chat.isBusy(), true);
    await waitFor(() => of(events, 'ai:chatDone').length === 1);

    assert.deepEqual(of(events, 'ai:chatDelta').map((e) => e.text), ['Olá', ' mundo']);
    const done = of(events, 'ai:chatDone')[0];
    assert.equal(done.id, id);
    assert.equal(done.text, 'Olá mundo');
    assert.equal(done.cancelled, false);
    assert.equal(done.finishReason, 'stop');
    assert.equal(chat.isBusy(), false);

    const req = server.requests[0];
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.body.stream, true);
    assert.equal(req.body.model, 'modelo-teste');
    assert.equal(req.body.messages[0].role, 'system');
    assert.deepEqual(req.body.messages.slice(1), [{ role: 'user', content: 'Oi, tudo bem?' }]);
    assert.equal(req.headers.authorization, undefined);

    assert.deepEqual(history.get(), [
      { role: 'user', content: 'Oi, tudo bem?' },
      { role: 'assistant', content: 'Olá mundo' }
    ]);
  } finally { await server.close(); rm(dir); }
});

test('streaming: erro do servidor vira ai:chatError e a pergunta NÃO entra no histórico', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'modelo não carregado' } }));
  });
  const { chat, events, history, dir } = makeChat(server);
  try {
    chat.start('pergunta');
    await waitFor(() => of(events, 'ai:chatError').length === 1);
    assert.match(of(events, 'ai:chatError')[0].error, /modelo não carregado/);
    assert.deepEqual(history.get(), []);
    assert.equal(chat.isBusy(), false);
  } finally { await server.close(); rm(dir); }
});

test('streaming: erro no meio do fluxo (evento de erro do servidor) vira ai:chatError', async () => {
  const server = await startServer((req, res) => {
    sse(res);
    delta(res, 'parcial');
    res.write(`data: ${JSON.stringify({ error: { message: 'falhou no meio' } })}\n\n`);
    res.end();
  });
  const { chat, events, history, dir } = makeChat(server);
  try {
    chat.start('pergunta');
    await waitFor(() => of(events, 'ai:chatError').length === 1);
    assert.match(of(events, 'ai:chatError')[0].error, /falhou no meio/);
    assert.deepEqual(history.get(), []);
  } finally { await server.close(); rm(dir); }
});

test('streaming: cancelar fecha a conexão, mantém o texto que já chegou e marca cancelled', async () => {
  const server = await startServer((req, res) => { sse(res); delta(res, 'abc'); /* e fica esperando */ });
  const { chat, events, history, dir } = makeChat(server);
  try {
    const id = chat.start('pergunta longa');
    await waitFor(() => of(events, 'ai:chatDelta').length === 1);
    assert.equal(chat.cancel(id), true);
    await waitFor(() => of(events, 'ai:chatDone').length === 1);
    const done = of(events, 'ai:chatDone')[0];
    assert.equal(done.cancelled, true);
    assert.equal(done.text, 'abc');
    assert.deepEqual(history.get().map((m) => m.content), ['pergunta longa', 'abc']);
    await waitFor(() => server.requests[0].closed, 2000); // o servidor viu a conexão cair
    assert.equal(chat.isBusy(), false);
    assert.equal(chat.cancel(id), false, 'sem resposta em andamento');
  } finally { await server.close(); rm(dir); }
});

test('streaming: cancelar antes de chegar texto não guarda nada no histórico', async () => {
  const server = await startServer((req, res) => { sse(res); res.write(': aguardando\n\n'); });
  const { chat, events, history, dir } = makeChat(server);
  try {
    chat.start('pergunta');
    await waitFor(() => server.requests.length === 1);
    chat.cancel();
    await waitFor(() => of(events, 'ai:chatDone').length === 1);
    const done = of(events, 'ai:chatDone')[0];
    assert.equal(done.cancelled, true);
    assert.equal(done.text, '');
    assert.deepEqual(history.get(), []);
  } finally { await server.close(); rm(dir); }
});

test('streaming: tempo por inatividade esgotado (servidor parou de mandar dados)', async () => {
  const server = await startServer((req, res) => { sse(res); delta(res, 'inicio'); });
  const { chat, events, history, dir } = makeChat(server, { timeouts: { idleTimeoutMs: 150, firstChunkTimeoutMs: 1000 } });
  try {
    chat.start('pergunta');
    await waitFor(() => of(events, 'ai:chatError').length === 1, 4000);
    const err = of(events, 'ai:chatError')[0];
    assert.equal(err.code, 'TIMEOUT');
    assert.match(err.error, /Tempo esgotado/);
    assert.deepEqual(history.get(), []);
    assert.equal(chat.isBusy(), false);
  } finally { await server.close(); rm(dir); }
});

test('streaming: servidor SEM streaming (responde JSON inteiro) cai para a resposta inteira', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'resposta inteira' }, finish_reason: 'stop' }] }));
  });
  const { chat, events, history, dir } = makeChat(server);
  try {
    chat.start('oi');
    await waitFor(() => of(events, 'ai:chatDone').length === 1);
    assert.deepEqual(of(events, 'ai:chatDelta').map((e) => e.text), ['resposta inteira']);
    assert.equal(of(events, 'ai:chatDone')[0].text, 'resposta inteira');
    assert.equal(history.get().length, 2);
  } finally { await server.close(); rm(dir); }
});

test('streaming: servidor que RECUSA o parâmetro de streaming recebe um segundo pedido sem ele', async () => {
  const server = await startServer((req, res, body) => {
    if (body.stream) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "'stream' is not supported by this server" } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'sem stream' }, finish_reason: 'stop' }] }));
  });
  const { chat, events, dir } = makeChat(server);
  try {
    chat.start('oi');
    await waitFor(() => of(events, 'ai:chatDone').length === 1);
    assert.equal(of(events, 'ai:chatDone')[0].text, 'sem stream');
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0].body.stream, true);
    assert.equal(server.requests[1].body.stream, undefined);
  } finally { await server.close(); rm(dir); }
});

test('uma conversa ativa por vez: a segunda é recusada com BUSY; mensagem vazia/longa é recusada', async () => {
  const server = await startServer((req, res) => { sse(res); delta(res, 'x'); });
  const { chat, events, dir } = makeChat(server);
  try {
    chat.start('primeira');
    assert.throws(() => chat.start('segunda'), (e) => e.code === 'BUSY');
    chat.cancel();
    await waitFor(() => of(events, 'ai:chatDone').length === 1);
    assert.throws(() => chat.start('   '), /Escreva uma mensagem/);
    assert.throws(() => chat.start('a'.repeat(20001)), /longa demais/);
  } finally { await server.close(); rm(dir); }
});

test('contexto enviado ao modelo respeita o limite de 40 mensagens (histórico longo é cortado)', async () => {
  const server = await startServer((req, res) => { sse(res); delta(res, 'ok'); res.end('data: [DONE]\n\n'); });
  const { chat, events, history, dir } = makeChat(server);
  try {
    const big = [];
    for (let i = 0; i < 60; i++) big.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` });
    history.set(big);
    assert.ok(history.get().length <= ChatHistory.MAX_MESSAGES);
    chat.start('nova');
    await waitFor(() => of(events, 'ai:chatDone').length === 1);
    const sent = server.requests[0].body.messages.filter((m) => m.role !== 'system');
    assert.ok(sent.length <= AIService.MAX_MESSAGES, `enviadas ${sent.length}`);
    assert.equal(sent[0].role, 'user');
    assert.equal(sent[sent.length - 1].content, 'nova');
    assert.ok(history.get().length <= ChatHistory.MAX_MESSAGES);
  } finally { await server.close(); rm(dir); }
});

test('limpar durante a resposta cancela e nada volta ao histórico', async () => {
  const server = await startServer((req, res) => { sse(res); delta(res, 'pedaço'); });
  const { chat, events, history, dir } = makeChat(server);
  try {
    chat.start('pergunta');
    await waitFor(() => of(events, 'ai:chatDelta').length === 1);
    chat.clear();
    await waitFor(() => of(events, 'ai:chatDone').length === 1);
    assert.deepEqual(history.get(), []);
    assert.equal(fs.existsSync(history.filePath), false);
  } finally { await server.close(); rm(dir); }
});

// ------------------------------------------------------------------------- histórico

test('histórico: escrita atômica (.tmp + rename), sem .tmp sobrando e sem dados de configuração', () => {
  const dir = tmpDir();
  try {
    const ai = new AIService({ configDir: dir, safeStorage });
    ai.saveConfig({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-chave-secreta-123', model: 'm' });
    const h = new ChatHistory({ dir });
    h.set([{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá' }]);
    const files = fs.readdirSync(dir);
    assert.ok(files.includes('ai-chat-history.json'));
    assert.ok(!files.some((f) => f.endsWith('.tmp')), 'nenhum temporário sobrando');
    const raw = fs.readFileSync(h.filePath, 'utf8');
    assert.ok(!raw.includes('sk-chave'), 'sem chave');
    assert.ok(!raw.includes('127.0.0.1'), 'sem endereço do servidor');
    assert.deepEqual(JSON.parse(raw).messages, [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá' }]);

    // outra instância lê o mesmo arquivo (restaura ao abrir)
    assert.equal(new ChatHistory({ dir }).get().length, 2);
  } finally { rm(dir); }
});

test('histórico: falha ao gravar (rename) não corrompe o arquivo existente', () => {
  const dir = tmpDir();
  const realRename = fs.renameSync;
  try {
    const h = new ChatHistory({ dir });
    h.set([{ role: 'user', content: 'antigo' }]);
    fs.renameSync = () => { throw new Error('disco travado'); };
    assert.throws(() => h.set([{ role: 'user', content: 'novo' }]), /disco travado/);
    fs.renameSync = realRename;
    assert.deepEqual(JSON.parse(fs.readFileSync(h.filePath, 'utf8')).messages, [{ role: 'user', content: 'antigo' }]);
  } finally { fs.renameSync = realRename; rm(dir); }
});

test('histórico: limite de mensagens, começa por mensagem do usuário, ignora lixo e arquivo ilegível', () => {
  const dir = tmpDir();
  try {
    const h = new ChatHistory({ dir, maxMessages: 4 });
    h.set([
      { role: 'user', content: '1' }, { role: 'assistant', content: '2' }, { role: 'user', content: '3' },
      { role: 'assistant', content: '4' }, { role: 'user', content: '5' }, { role: 'assistant', content: '6' },
      { role: 'system', content: 'x' }, { role: 'user', content: '   ' }, { role: 'user', content: 42 }, null
    ]);
    assert.deepEqual(h.get().map((m) => m.content), ['3', '4', '5', '6']);
    h.set([{ role: 'user', content: '1' }, { role: 'assistant', content: '2' }, { role: 'user', content: '3' }, { role: 'assistant', content: '4' }, { role: 'user', content: '5' }]);
    assert.equal(h.get()[0].role, 'user');

    fs.writeFileSync(h.filePath, '{ isto não é json');
    assert.deepEqual(new ChatHistory({ dir }).get(), []);
  } finally { rm(dir); }
});

test('histórico: limpar apaga o arquivo', () => {
  const dir = tmpDir();
  try {
    const h = new ChatHistory({ dir });
    h.set([{ role: 'user', content: 'oi' }]);
    assert.ok(fs.existsSync(h.filePath));
    h.clear();
    assert.equal(fs.existsSync(h.filePath), false);
    assert.deepEqual(h.get(), []);
    assert.deepEqual(new ChatHistory({ dir }).get(), []);
  } finally { rm(dir); }
});

// --------------------------------------------------------------- trava no processo principal

const APP_EVENT = (() => {
  const url = pathToFileURL(APP_PAGE).href;
  return { senderFrame: { url, parent: null }, sender: { getType: () => 'window', getURL: () => url } };
})();

/** Registra os handlers REAIS de ai:* num registrador com ipc falso. */
function setupHandlers({ isDev = true, enabledModules = { ai: true }, chatTimeouts = {} } = {}) {
  const dir = tmpDir();
  const handlers = new Map();
  const reg = createRegistry({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, logger: { warn() {} } });
  const settings = { enabledModules };
  const sent = [];
  const ai = registerAiHandlers({ configDir: dir }, {
    handle: reg.handle, isDev, safeStorage, settingsManager: { load: () => settings },
    broadcast: (channel, payload) => sent.push({ channel, ...payload }), chatTimeouts
  });
  return { dir, ai, settings, sent, call: (ch, ...args) => handlers.get(ch)(APP_EVENT, ...args) };
}

const GATED = [
  ['ai:chatStart', [{ text: 'oi' }]],
  ['ai:chatCancel', []],
  ['ai:historyGet', []],
  ['ai:historyClear', []]
];

test('trava: app EMPACOTADO (simulado) tem o assistente liberado — os canais respondem, com o módulo no padrão (ligado) ou ligado à mão', async () => {
  for (const enabledModules of [{}, { ai: true }]) {
    const h = setupHandlers({ isDev: false, enabledModules });
    try {
      assert.deepEqual(await h.call('ai:historyGet'), { ok: true, data: { messages: [], busy: false } }, JSON.stringify(enabledModules));
      assert.deepEqual(await h.call('ai:chatCancel'), { ok: true, data: false });
      assert.deepEqual(await h.call('ai:historyClear'), { ok: true, data: true });
      // sem servidor configurado (OpenAI sem chave): não é a trava, é o primeiro uso amigável
      const start = await h.call('ai:chatStart', { text: 'oi' });
      assert.equal(start.ok, false);
      assert.equal(start.code, 'AI_NOT_CONFIGURED');
    } finally { rm(h.dir); }
  }
});

test('trava: assistantBlock respeita a constante de liberação (dev sempre liberado; empacotado só se a constante for true)', () => {
  const gate = require('../src/services/ai/releaseGate');
  const { assistantBlock } = registerAiHandlers;
  const ai = { isAssistantEnabled: () => true };
  const settings = { enabledModules: { ai: true } };
  assert.equal(gate.isAssistantBuildAllowed(true), true);
  assert.equal(gate.isAssistantBuildAllowed(false), gate.ASSISTANT_ALLOWED_IN_PACKAGED_APP);
  assert.equal(assistantBlock({ isDev: true, settings, ai }), null);
  const packaged = assistantBlock({ isDev: false, settings, ai });
  if (gate.ASSISTANT_ALLOWED_IN_PACKAGED_APP) assert.equal(packaged, null);
  else assert.equal(packaged.code, 'AI_DISABLED');
});

test('trava: módulo desligado recusa; interruptor desligado recusa; tudo ligado libera', async () => {
  const h = setupHandlers({ isDev: true, enabledModules: { ai: false } }); // desligado de propósito (o padrão agora é ligado)
  try {
    for (const [ch, args] of GATED) assert.equal((await h.call(ch, ...args)).code, 'AI_DISABLED', `módulo off: ${ch}`);

    h.settings.enabledModules = {}; // chave ausente = padrão do módulo = ligado
    assert.equal((await h.call('ai:historyGet')).ok, true, 'módulo no padrão (ligado)');
    h.settings.enabledModules = { ai: true };
    assert.equal((await h.call('ai:historyGet')).ok, true, 'módulo ligado + interruptor padrão (ligado)');

    const off = await h.call('ai:saveConfig', { assistantEnabled: false });
    assert.equal(off.ok, true);
    assert.equal(off.data.assistantEnabled, false);
    for (const [ch, args] of GATED) assert.equal((await h.call(ch, ...args)).code, 'AI_DISABLED', `interruptor off: ${ch}`);

    await h.call('ai:saveConfig', { assistantEnabled: true });
    const hist = await h.call('ai:historyGet');
    assert.deepEqual(hist, { ok: true, data: { messages: [], busy: false } });
    assert.deepEqual(await h.call('ai:historyClear'), { ok: true, data: true });
  } finally { rm(h.dir); }
});

test('trava: chatStart liberado inicia a resposta e os eventos saem pelo broadcast', async () => {
  const server = await startServer((req, res) => { sse(res); delta(res, 'oi!'); res.end('data: [DONE]\n\n'); });
  const h = setupHandlers();
  try {
    await h.call('ai:saveConfig', { baseUrl: server.url, model: 'm' });
    const r = await h.call('ai:chatStart', { text: 'olá' });
    assert.equal(r.ok, true);
    assert.ok(r.data.id);
    await waitFor(() => h.sent.some((e) => e.channel === 'ai:chatDone'));
    assert.equal(h.sent.find((e) => e.channel === 'ai:chatDone').text, 'oi!');
    const hist = await h.call('ai:historyGet');
    assert.equal(hist.data.messages.length, 2);
    // campos inválidos são recusados pelo esquema do registrador
    const bad = await h.call('ai:chatStart', { text: '' });
    assert.equal(bad.ok, false);
  } finally { await server.close(); rm(h.dir); }
});

test('configuração pública do assistente não devolve a chave; interruptor padrão é ligado', async () => {
  const h = setupHandlers();
  try {
    await h.call('ai:saveConfig', { apiKey: 'sk-chave-secreta-123', baseUrl: 'http://127.0.0.1:5/v1' });
    const cfg = (await h.call('ai:getConfig')).data;
    assert.equal(cfg.hasKey, true);
    assert.equal(cfg.assistantEnabled, true);
    assert.ok(!JSON.stringify(cfg).includes('sk-chave'));
  } finally { rm(h.dir); }
});

test('sem projectService (testes antigos) o chat não envia ferramentas; com ele, a lista é a fixa de 22 ferramentas (detalhes em ai-assistant-tools.test.js)', () => {
  assert.equal(listTools().length, 22);
  assert.ok(Object.isFrozen(listTools()));
});

// ------------------------------------------------------- ai:analyzeTranscript: validação do caminho

test('analyzeTranscript: recusa caminho relativo, extensão estranha, inexistente, pasta, grande demais e link simbólico — sem falar com o servidor', async () => {
  const server = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })); });
  const h = setupHandlers({ isDev: false, enabledModules: {} }); // a análise não depende do assistente (a Transcrição usa)
  const dir = tmpDir();
  try {
    await h.call('ai:saveConfig', { baseUrl: server.url, model: 'm' });
    const bad = async (p, re) => {
      const r = await h.call('ai:analyzeTranscript', { path: p });
      assert.equal(r.ok, false, p);
      assert.match(r.error, re, p);
    };
    await bad('relativo.md', /inválido/);
    fs.writeFileSync(path.join(dir, 'x.exe'), 'MZ');
    await bad(path.join(dir, 'x.exe'), /Formato não suportado/);
    await bad(path.join(dir, 'nao-existe.md'), /não encontrado/);
    fs.mkdirSync(path.join(dir, 'pasta.md'));
    await bad(path.join(dir, 'pasta.md'), /não encontrado/);
    const big = path.join(dir, 'grande.txt');
    fs.writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    await bad(big, /grande demais/);

    // link simbólico (pode exigir privilégio no Windows: sem ele, só não testa esta linha)
    const real = path.join(dir, 'real.md');
    fs.writeFileSync(real, '# aula\n\nconteúdo');
    const link = path.join(dir, 'link.md');
    let linked = false;
    try { fs.symlinkSync(real, link); linked = true; } catch (_) { /* sem permissão para criar links */ }
    if (linked) await bad(link, /simbólico/);

    assert.equal(server.requests.length, 0, 'nada chegou ao servidor');
  } finally { await server.close(); rm(h.dir); rm(dir); }
});

test('analyzeTranscript: arquivo válido grava .analise.md ao lado, sem sobrescrever', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '## Resumo\nok' }, finish_reason: 'stop' }] }));
  });
  const h = setupHandlers({ isDev: false, enabledModules: {} });
  const dir = tmpDir();
  try {
    await h.call('ai:saveConfig', { baseUrl: server.url, model: 'm' });
    const md = path.join(dir, 'aula.srt');
    fs.writeFileSync(md, '1\n00:00:01,000 --> 00:00:04,000\nOlá pessoal\n');
    const a = await h.call('ai:analyzeTranscript', { path: md });
    assert.equal(a.ok, true);
    assert.equal(a.data.path, path.join(dir, 'aula.analise.md'));
    const b = await h.call('ai:analyzeTranscript', { path: md });
    assert.equal(b.data.path, path.join(dir, 'aula.analise (2).md'));
    assert.ok(h.sent.some((e) => e.channel === 'ai:analysisProgress'));
  } finally { await server.close(); rm(h.dir); rm(dir); }
});

// ------------------------------------------------------------ tela inicial antiga ("Assistente IA")

test('configuração: tela inicial "ai" (assistente era uma tela) volta para a Home ao carregar e é recusada ao salvar', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ defaultStartScreen: 'ai', modulesMigrated: true, enabledModules: {} }));
    const sm = new SettingsManager(dir, dir);
    assert.equal(sm.load().defaultStartScreen, 'home');
    const saved = sm.save({ defaultStartScreen: 'ai' });
    assert.equal(saved.defaultStartScreen, 'home');
    assert.equal(sm.save({ defaultStartScreen: 'library' }).defaultStartScreen, 'library');
  } finally { rm(dir); }
});
