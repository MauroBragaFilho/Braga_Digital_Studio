'use strict';

// O que a análise de transcrição precisa do provedor e do serviço de IA para funcionar em servidor com limite baixo e em
// modelo local pequeno: amostragem só em servidor local, tempo de resposta que acompanha o tamanho pedido, dicas estruturadas
// quando o servidor manda esperar ou recusa o tamanho, e a ligação de tudo isso com a análise.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const AIService = require('../src/services/ai/AIService');
const OpenAIProvider = require('../src/services/ai/providers/OpenAIProvider');
const { ANALYSIS_SAMPLING, STAGE_TOKENS, analyzeTranscript } = require('../src/services/ai/transcriptAnalysis');

const dirs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-ailimits-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, '')
};

const GOOD = '**1. Resumo**\nOk.\n\n**2. Principais assuntos**\n- A\n\n**3. Pontos importantes**\n- B\n\n**4. Trechos potencialmente relevantes**\n- C';
const MD = '# aula\n\n**[00:00:01]** Olá, pessoal.\n\n**[00:00:05]** Hoje vamos falar de aniversários.\n';

/** Servidor de chat falso em localhost; `handler(req, res, body, n)` responde a cada /chat/completions. */
function startServer(handler) {
  const chats = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (_) { /* vazio */ }
      chats.push(body);
      handler(req, res, body, chats.length);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    chats,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
  })));
}
const answer = (res, text) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); };
const refuse = (res, status, message, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify({ error: { message } })); };

async function withService(handler, fn) {
  const server = await startServer(handler);
  try {
    const ai = new AIService({ configDir: tmpDir(), safeStorage });
    ai.saveConfig({ addProvider: { preset: 'custom', label: 'Local', baseUrl: server.url, model: 'modelo-teste' } });
    return await fn(ai, server);
  } finally { await server.close(); }
}

// ------------------------------------------------------------------ provedor

test('amostragem só vai a servidor local, só campos conhecidos e dentro da faixa', () => {
  const s = { temperature: 0.7, top_p: 0.8, top_k: 20.4, presence_penalty: 1.5, foo: 1, repeat_penalty: 9, min_p: 'x', frequency_penalty: null };
  assert.deepEqual(OpenAIProvider.samplingFor('http://127.0.0.1:18741/v1', s), { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 });
  assert.deepEqual(OpenAIProvider.samplingFor('http://localhost:1234/v1', { top_k: 40 }), { top_k: 40 });
  for (const remote of ['https://api.groq.com/openai/v1', 'https://api.openai.com/v1', 'http://192.168.0.10:1234/v1', 'https://maas.qwencloudapi.com/compatible-mode/v1']) {
    assert.deepEqual(OpenAIProvider.samplingFor(remote, ANALYSIS_SAMPLING), {}, remote);
  }
  assert.deepEqual(OpenAIProvider.samplingFor('http://127.0.0.1:1/v1', null), {});
  assert.deepEqual(OpenAIProvider.samplingFor('http://127.0.0.1:1/v1', 'texto'), {});
});

test('tempo de uma resposta: remoto 5 min; local cresce com o tamanho pedido, até 20 min', () => {
  assert.equal(OpenAIProvider.requestTimeoutMs('https://api.groq.com/openai/v1', 8192), 300000);
  const local = 'http://127.0.0.1:18741/v1';
  assert.equal(OpenAIProvider.requestTimeoutMs(local, 900), 180000 + 900 * 400);
  assert.ok(OpenAIProvider.requestTimeoutMs(local, 1600) > OpenAIProvider.requestTimeoutMs(local, 900));
  assert.equal(OpenAIProvider.requestTimeoutMs(local, 8192), 20 * 60 * 1000);
  assert.equal(OpenAIProvider.requestTimeoutMs(local, undefined), 180000 + 1024 * 400);
  // CPU lenta (3 tokens por segundo): o teto da análise (900 tokens) mais a leitura do pedido cabem no tempo
  assert.ok(OpenAIProvider.requestTimeoutMs(local, STAGE_TOKENS.part) > 90000 + (STAGE_TOKENS.part / 3) * 1000);
});

// ------------------------------------------------------------------ serviço

test('AIService.chat repassa o tamanho de resposta e a amostragem ao servidor local (e só quando pedidas)', async () => {
  await withService((req, res) => answer(res, 'ok'), async (ai, server) => {
    await ai.chat({ messages: [{ role: 'user', content: 'oi' }], system: 's', maxTokens: 777, sampling: ANALYSIS_SAMPLING });
    const body = server.chats[0];
    assert.equal(body.max_tokens, 777);
    assert.equal(body.temperature, 0.7);
    assert.equal(body.top_p, 0.8);
    assert.equal(body.top_k, 20);
    assert.equal(body.presence_penalty, 1.5);

    await ai.chat({ messages: [{ role: 'user', content: 'oi' }], system: 's' });
    const plain = server.chats[1];
    for (const k of ['temperature', 'top_p', 'top_k', 'presence_penalty', 'repeat_penalty']) assert.equal(k in plain, false, k);
    assert.equal(plain.max_tokens, 1024, 'sem pedido, vale o limite global das configurações');
  });
});

test('429 de um servidor só: o erro traz rateLimited e o Retry-After para quem chama decidir esperar', async () => {
  await withService((req, res) => refuse(res, 429, 'Rate limit reached', { 'retry-after': '12' }), async (ai) => {
    const err = await ai.chat({ messages: [{ role: 'user', content: 'oi' }] }).catch((e) => e);
    assert.equal(err.code, 'AI_ALL_FAILED');
    assert.equal(err.rateLimited, true);
    assert.equal(err.retryAfter, 12);
    assert.equal(err.tooLarge, undefined);
    assert.doesNotMatch(err.message, /Rate limit reached/, 'o texto do servidor não é repassado');
  });
});

test('pedido grande demais: 413 sobe como veio; 429 com "request too large" vira tooLarge (e não rateLimited)', async () => {
  await withService((req, res) => refuse(res, 413, 'Request too large for model x on tokens per minute (TPM): Limit 8000, Requested 11000'), async (ai) => {
    const err = await ai.chat({ messages: [{ role: 'user', content: 'oi' }] }).catch((e) => e);
    assert.equal(err.status, 413);
  });
  await withService((req, res) => refuse(res, 429, 'Request too large for model x on tokens per minute (TPM): Limit 8000, Requested 11000', { 'retry-after': '5' }), async (ai) => {
    const err = await ai.chat({ messages: [{ role: 'user', content: 'oi' }] }).catch((e) => e);
    assert.equal(err.code, 'AI_ALL_FAILED');
    assert.equal(err.tooLarge, true);
    assert.equal(err.rateLimited, undefined, 'esperar não adianta: o pedido nunca cabe');
  });
});

// ------------------------------------------------------------------ análise de ponta a ponta (serviço + servidor falso)

test('análise com o AIService: servidor manda esperar (429), a análise espera e termina; o servidor recebe os tetos e a amostragem', async () => {
  await withService((req, res, body, n) => (n === 1 ? refuse(res, 429, 'limite', { 'retry-after': '1' }) : answer(res, GOOD)), async (ai, server) => {
    const waits = [];
    const progress = [];
    const out = await analyzeTranscript({ text: MD }, {
      chat: (args) => ai.chat(args), sleep: async (ms) => { waits.push(ms); }, onProgress: (p) => progress.push(p)
    });
    assert.equal(out.markdown, GOOD);
    assert.equal(server.chats.length, 2, 'a mesma chamada foi refeita depois da espera');
    assert.deepEqual(waits, [5000], 'Retry-After de 1 s vira a espera mínima de 5 s');
    assert.ok(progress.some((p) => p.stage === 'wait' && p.seconds === 5));
    for (const body of server.chats) {
      assert.equal(body.max_tokens, STAGE_TOKENS.single);
      assert.equal(body.top_k, 20);
      assert.equal(body.presence_penalty, 1.5);
    }
  });
});

test('análise pela tarefa registrada: o caminho do modelo nunca vai para o documento', async () => {
  await withService((req, res) => answer(res, GOOD), async (ai) => {
    const r = await ai.runTask('analyzeTranscript', { text: MD });
    assert.equal(r.markdown, GOOD);
    assert.ok(r.document.includes('> Gerada por IA (modelo-teste).'));
  });
  // servidor local que informa o arquivo do modelo como nome: o documento mostra o nome do provedor
  const file = 'C:\\Users\\ana\\AppData\\Roaming\\x\\modelo.gguf';
  const server = await startServer((req, res) => answer(res, GOOD));
  try {
    const ai = new AIService({ configDir: tmpDir(), safeStorage });
    ai.saveConfig({ addProvider: { preset: 'custom', label: 'Modelo local do app', baseUrl: server.url, model: file } });
    const r = await ai.runTask('analyzeTranscript', { text: MD });
    assert.ok(!r.document.includes('ana') && !r.document.includes('.gguf'), r.document.split('\n')[2]);
    assert.ok(r.document.includes('> Gerada por IA (Modelo local do app).'));
  } finally { await server.close(); }
});
