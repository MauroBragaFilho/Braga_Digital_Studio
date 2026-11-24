'use strict';

// Descoberta de modelos (fetch simulado) e regras de chave/endereço (keyPolicy): formatos OpenAI e Anthropic nativo,
// cabeçalhos exatos, Bearer só com chave, chave nunca por http:// fora do loopback, redirect, tempo, cancelamento e
// mensagens fixas (nunca o texto do servidor nem a chave).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { discoverModels, DiscoveryError, MESSAGES } = require('../src/services/ai/providers/discovery');
const keyPolicy = require('../src/services/ai/providers/keyPolicy');
const OpenAIProvider = require('../src/services/ai/providers/OpenAIProvider');

const KEY = 'sk-test-SEGREDO-123456';

/** fetch falso: devolve as respostas da fila (objeto ou função) e registra as chamadas. */
function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url: String(url), options });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return typeof next === 'function' ? next(url, options) : next;
  };
  fn.calls = calls;
  return fn;
}
const json = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});
const OPENAI_LIST = { object: 'list', data: [{ id: 'gpt-4o-mini' }, { id: 'whisper-1' }, { id: 'text-embedding-3-small' }, { id: 'sora-2' }] };

async function fails(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof DiscoveryError, `esperava DiscoveryError, veio ${err && err.name}`);
    assert.equal(err.code, code);
    assert.equal(err.message, MESSAGES[code]);
    return true;
  });
}

// ------------------------------------------------------------------ formato OpenAI

test('formato OpenAI: GET {base}/models, classifica, conta e devolve host/isLocal', async () => {
  const fetchImpl = fakeFetch(json(OPENAI_LIST));
  const r = await discoverModels({ baseUrl: 'https://api.openai.com/v1/', apiKey: KEY, fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(fetchImpl.calls[0].options.method, 'GET');
  assert.equal(fetchImpl.calls[0].options.redirect, 'error');
  assert.ok(fetchImpl.calls[0].options.signal instanceof AbortSignal);
  assert.equal(fetchImpl.calls[0].options.body, undefined);
  assert.equal(r.format, 'openai');
  assert.equal(r.baseUrl, 'https://api.openai.com/v1');
  assert.equal(r.host, 'api.openai.com');
  assert.equal(r.isLocal, false);
  assert.deepEqual(r.models.map((m) => [m.id, m.caps.join(',')]), [['gpt-4o-mini', 'chat,image'], ['whisper-1', 'audio'], ['sora-2', 'video']]);
  assert.deepEqual(r.counts, { chat: 1, audio: 1, image: 1, video: 1 });
});

test('Authorization: Bearer só quando há chave; sem chave não vai cabeçalho de autorização', async () => {
  const withKey = fakeFetch(json(OPENAI_LIST));
  await discoverModels({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: `  ${KEY}  `, fetchImpl: withKey });
  assert.deepEqual(withKey.calls[0].options.headers, { accept: 'application/json', authorization: `Bearer ${KEY}` });
  assert.equal(withKey.calls[0].url, 'https://api.groq.com/openai/v1/models');

  const noKey = fakeFetch(json(OPENAI_LIST));
  await discoverModels({ baseUrl: 'https://api.groq.com/openai/v1', fetchImpl: noKey });
  assert.deepEqual(noKey.calls[0].options.headers, { accept: 'application/json' });
  const emptyKey = fakeFetch(json(OPENAI_LIST));
  await discoverModels({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: '   ', fetchImpl: emptyKey });
  assert.equal(emptyKey.calls[0].options.headers.authorization, undefined);
});

test('endereço sem esquema: https:// no remoto, http:// no local; caminho vazio vira /v1', async () => {
  const a = fakeFetch(json(OPENAI_LIST));
  assert.equal((await discoverModels({ baseUrl: 'api.groq.com/openai/v1', apiKey: KEY, fetchImpl: a })).baseUrl, 'https://api.groq.com/openai/v1');
  const b = fakeFetch(json(OPENAI_LIST));
  const local = await discoverModels({ baseUrl: 'localhost:11434', fetchImpl: b });
  assert.equal(b.calls[0].url, 'http://localhost:11434/v1/models');
  assert.equal(local.isLocal, true);
  const c = fakeFetch(json(OPENAI_LIST));
  const lan = await discoverModels({ baseUrl: '192.168.0.20:1234/v1', fetchImpl: c });
  assert.equal(c.calls[0].url, 'http://192.168.0.20:1234/v1/models');
  assert.equal(lan.isLocal, true);
});

test('Ollama e LM Studio: respostas {models:[...]} e chave opcional em localhost, mesmo por http://', async () => {
  const fetchImpl = fakeFetch(json({ models: [{ name: 'llama3.2:latest' }, { name: 'nomic-embed-text:latest' }] }));
  const r = await discoverModels({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'qualquer', fetchImpl });
  assert.deepEqual(r.models.map((m) => m.id), ['llama3.2:latest']);
  assert.equal(fetchImpl.calls[0].options.headers.authorization, 'Bearer qualquer'); // loopback aceita chave por http://
});

// ------------------------------------------------------------------ Anthropic nativo

test('Anthropic: x-api-key e anthropic-version exatos, NENHUM Authorization, paginação com after_id', async () => {
  const page = (ids, hasMore, lastId) => json({
    data: ids.map((id) => ({ id, type: 'model', display_name: id, capabilities: { image_input: { supported: true } } })),
    has_more: hasMore, last_id: lastId
  });
  const fetchImpl = fakeFetch(page(['claude-sonnet-4-5', 'claude-opus-4-1'], true, 'claude-opus-4-1'), page(['claude-haiku-4-5'], false, 'claude-haiku-4-5'));
  const r = await discoverModels({ baseUrl: 'https://api.anthropic.com/v1', apiKey: KEY, fetchImpl });
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), [
    'https://api.anthropic.com/v1/models?limit=100',
    'https://api.anthropic.com/v1/models?limit=100&after_id=claude-opus-4-1'
  ]);
  for (const call of fetchImpl.calls) {
    assert.deepEqual(call.options.headers, { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', accept: 'application/json' });
    assert.equal(Object.keys(call.options.headers).some((k) => /^authorization$/i.test(k)), false);
    assert.equal(call.options.redirect, 'error');
  }
  assert.equal(r.format, 'anthropic');
  assert.equal(r.baseUrl, 'https://api.anthropic.com/v1');
  assert.equal(r.host, 'api.anthropic.com');
  assert.deepEqual(r.models.map((m) => m.id), ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5']);
  assert.ok(r.models.every((m) => m.source === 'metadado' && m.caps.join(',') === 'chat,image'));
  assert.deepEqual(r.counts, { chat: 3, audio: 0, image: 3, video: 0 });
});

test('Anthropic: endereço só com a origem também vale; paginação para em 5 páginas', async () => {
  let n = 0;
  const fetchImpl = fakeFetch(async () => { n += 1; return json({ data: [{ id: `claude-m-${n}`, capabilities: { image_input: { supported: false } } }], has_more: true, last_id: `p${n}` }); });
  const r = await discoverModels({ baseUrl: 'https://api.anthropic.com', apiKey: KEY, fetchImpl });
  assert.equal(fetchImpl.calls.length, 5);
  assert.equal(r.models.length, 5);
});

test('Anthropic só no host exato com https: parecido ou http:// usa o formato OpenAI (Bearer, sem x-api-key)', async () => {
  for (const baseUrl of ['https://api.anthropic.com.evil.example/v1', 'https://eu.api.anthropic.com/v1', 'https://proxy.example/api.anthropic.com/v1', 'https://api.anthropic.com:8443/v1']) {
    const fetchImpl = fakeFetch(json(OPENAI_LIST));
    const r = await discoverModels({ baseUrl, apiKey: KEY, fetchImpl });
    assert.equal(r.format, 'openai', baseUrl);
    assert.equal(fetchImpl.calls[0].options.headers['x-api-key'], undefined, baseUrl);
    assert.equal(fetchImpl.calls[0].options.headers.authorization, `Bearer ${KEY}`, baseUrl);
  }
  // http:// com chave nem sai
  const never = fakeFetch(json(OPENAI_LIST));
  await fails(discoverModels({ baseUrl: 'http://api.anthropic.com/v1', apiKey: KEY, fetchImpl: never }), 'INSECURE');
  assert.equal(never.calls.length, 0);
});

test('Anthropic sem chave: NO_KEY (e não AUTH) sem chamar a rede; erro de workspace vira WORKSPACE', async () => {
  const never = fakeFetch(json({}));
  await fails(discoverModels({ baseUrl: 'https://api.anthropic.com/v1', fetchImpl: never }), 'NO_KEY');
  await fails(discoverModels({ baseUrl: 'https://api.anthropic.com/v1', apiKey: '   ', fetchImpl: never }), 'NO_KEY');
  assert.equal(never.calls.length, 0);
  const ws = fakeFetch(json({ type: 'error', error: { type: 'permission_error', message: `Chave ${KEY} sem acesso ao workspace x` } }, 403));
  await fails(discoverModels({ baseUrl: 'https://api.anthropic.com/v1', apiKey: KEY, fetchImpl: ws }), 'WORKSPACE');
  const plain403 = fakeFetch(json({ type: 'error', error: { type: 'permission_error', message: 'negado' } }, 403));
  await fails(discoverModels({ baseUrl: 'https://api.anthropic.com/v1', apiKey: KEY, fetchImpl: plain403 }), 'AUTH');
});

// ------------------------------------------------------------------ endereço e chave

test('endereço vazio ou inválido: BAD_URL e o fetch nunca é chamado', async () => {
  for (const baseUrl of [undefined, null, '', '   ', 42, '/v1', 'ftp://x.example/v1', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@x.example/v1', 'https://', 'https://exa mple.com']) {
    const fetchImpl = fakeFetch(json(OPENAI_LIST));
    await fails(discoverModels({ baseUrl, apiKey: KEY, fetchImpl }), 'BAD_URL');
    assert.equal(fetchImpl.calls.length, 0, String(baseUrl));
  }
  await fails(discoverModels(), 'BAD_URL');
});

test('http:// com chave: recusado em host remoto e na rede local (INSECURE); sem chave é permitido', async () => {
  for (const baseUrl of ['http://api.exemplo.com/v1', 'http://192.168.0.5:1234/v1', 'http://10.0.0.2/v1', 'http://minha-maquina:1234/v1']) {
    const fetchImpl = fakeFetch(json(OPENAI_LIST));
    await fails(discoverModels({ baseUrl, apiKey: KEY, fetchImpl }), 'INSECURE');
    assert.equal(fetchImpl.calls.length, 0, baseUrl);
  }
  for (const baseUrl of ['http://192.168.0.5:1234/v1', 'http://api.exemplo.com/v1']) {
    const fetchImpl = fakeFetch(json(OPENAI_LIST));
    assert.equal((await discoverModels({ baseUrl, fetchImpl })).format, 'openai');
    assert.equal(fetchImpl.calls[0].options.headers.authorization, undefined);
  }
});

test('chave com caracteres que quebrariam o cabeçalho: BAD_KEY sem chamar a rede', async () => {
  for (const apiKey of ['abc\r\nX-Evil: 1', 'chave com espaco', 'chaveç', 'x'.repeat(5000), 123, {}]) {
    const fetchImpl = fakeFetch(json(OPENAI_LIST));
    await fails(discoverModels({ baseUrl: 'https://api.exemplo.com/v1', apiKey, fetchImpl }), 'BAD_KEY');
    assert.equal(fetchImpl.calls.length, 0);
  }
});

// ------------------------------------------------------------------ erros de resposta

test('401 e 403: AUTH, sem vazar a chave nem o texto do servidor', async () => {
  for (const status of [401, 403]) {
    const fetchImpl = fakeFetch(json({ error: { message: `Invalid key ${KEY} for org-123` } }, status));
    let caught;
    try { await discoverModels({ baseUrl: 'https://api.exemplo.com/v1', apiKey: KEY, fetchImpl }); } catch (e) { caught = e; }
    assert.ok(caught instanceof DiscoveryError);
    assert.equal(caught.code, 'AUTH');
    assert.equal(caught.message, MESSAGES.AUTH);
    for (const dump of [caught.message, caught.stack.split('\n')[0], JSON.stringify(caught), String(caught)]) {
      assert.equal(dump.includes(KEY), false);
      assert.equal(dump.includes('org-123'), false);
    }
    assert.equal(caught.cause, undefined);
  }
});

test('404, 429 e outros status têm código próprio e mensagem fixa', async () => {
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl: fakeFetch(json({ error: 'nao achei' }, 404)) }), 'NOT_FOUND');
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl: fakeFetch(json('', 429, { 'retry-after': '5' })) }), 'RATE_LIMIT');
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl: fakeFetch(json('boom segredo', 500)) }), 'BAD_RESPONSE');
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl: fakeFetch(json('', 400)) }), 'BAD_RESPONSE');
});

test('redirect: nunca é seguido (redirect error), vira REDIRECT por exceção ou por status 3xx', async () => {
  const thrown = fakeFetch(async () => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); });
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', apiKey: KEY, fetchImpl: thrown }), 'REDIRECT');
  assert.equal(thrown.calls[0].options.redirect, 'error');
  const direct = fakeFetch(async () => { throw new TypeError('redirect mode is set to error: https://outro.example'); });
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', apiKey: KEY, fetchImpl: direct }), 'REDIRECT');
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', apiKey: KEY, fetchImpl: fakeFetch({ ok: false, status: 302, headers: { get: () => 'https://outro.example/' }, text: async () => '' }) }), 'REDIRECT');
});

test('falha de rede vira NETWORK sem repassar a mensagem original', async () => {
  const fetchImpl = fakeFetch(async () => { throw new TypeError('fetch failed https://x.example com chave ' + KEY, { cause: { code: 'ECONNREFUSED' } }); });
  let caught;
  try { await discoverModels({ baseUrl: 'http://localhost:1234/v1', fetchImpl }); } catch (e) { caught = e; }
  assert.equal(caught.code, 'NETWORK');
  assert.equal(caught.message, MESSAGES.NETWORK);
  assert.equal(caught.message.includes(KEY), false);
});

test('tempo esgotado: TIMEOUT e a requisição recebe o aborto', async () => {
  let aborted = false;
  const fetchImpl = fakeFetch((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })); });
  }));
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl, timeoutMs: 30 }), 'TIMEOUT');
  assert.equal(aborted, true);
});

test('cancelamento: CANCELLED durante a busca e antes dela (sem chamar a rede)', async () => {
  const controller = new AbortController();
  const fetchImpl = fakeFetch((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    setTimeout(() => controller.abort(), 10);
  }));
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl, signal: controller.signal, timeoutMs: 5000 }), 'CANCELLED');
  const pre = new AbortController();
  pre.abort();
  const never = fakeFetch(json(OPENAI_LIST));
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl: never, signal: pre.signal }), 'CANCELLED');
  assert.equal(never.calls.length, 0);
});

test('resposta ilegível ou de formato desconhecido: BAD_RESPONSE', async () => {
  for (const body of ['<html>erro</html>', '', 'null', '{"foo":1}', '{"data":"x"}', '42', '{"error":{"message":"x"}}']) {
    await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl: fakeFetch(json(body)) }), 'BAD_RESPONSE');
  }
  const huge = { ok: true, status: 200, headers: { get: (k) => (k === 'content-length' ? String(50 * 1024 * 1024) : null) }, text: async () => '{}' };
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl: fakeFetch(huge) }), 'BAD_RESPONSE');
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl: fakeFetch({ ok: true, status: 200, headers: { get: () => null }, text: async () => { throw new Error('socket'); } }) }), 'NETWORK');
});

test('corpo em pedaços sem content-length: lido por stream e abortado ao passar do teto (BAD_RESPONSE), sem acumular tudo', async () => {
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const streaming = {
    ok: true, status: 200, headers: { get: () => null },
    text: async () => { throw new Error('não devia ler tudo de uma vez'); },
    body: { getReader: () => ({ read: async () => { pulled++; return { done: false, value: chunk }; }, cancel: async () => { cancelled = true; } }) }
  };
  let aborted = false;
  const fetchImpl = fakeFetch(async (url, options) => { options.signal.addEventListener('abort', () => { aborted = true; }); return streaming; });
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl }), 'BAD_RESPONSE');
  assert.ok(pulled <= 10, `parou cedo (${pulled} pedaços)`);
  assert.equal(cancelled, true);
  assert.equal(aborted, true, 'a consulta é abortada');
  // o mesmo caminho lê um corpo pequeno em vários pedaços
  const enc = new TextEncoder().encode(JSON.stringify(OPENAI_LIST));
  const parts = [enc.slice(0, 7), enc.slice(7, 30), enc.slice(30)];
  const small = { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => (parts.length ? { done: false, value: parts.shift() } : { done: true }), cancel: async () => {} }) } };
  assert.equal((await discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl: fakeFetch(small) })).counts.chat, 1);
});

test('lista vazia ou sem modelo utilizável: EMPTY', async () => {
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl: fakeFetch(json({ data: [] })) }), 'EMPTY');
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl: fakeFetch(json({ data: [{ id: 'text-embedding-3-small' }, { id: 'dall-e-3' }, { id: '__proto__' }] })) }), 'EMPTY');
  await fails(discoverModels({ baseUrl: 'https://x.example/v1', fetchImpl: fakeFetch(json({ data: [{ id: 'old', active: false }] })) }), 'EMPTY');
});

test('as mensagens fixas não citam motores nem o servidor', () => {
  const codes = ['BAD_URL', 'INSECURE', 'AUTH', 'NO_KEY', 'BAD_KEY', 'NOT_FOUND', 'RATE_LIMIT', 'NETWORK', 'TIMEOUT', 'REDIRECT', 'BAD_RESPONSE', 'EMPTY', 'WORKSPACE', 'CANCELLED'];
  assert.deepEqual(Object.keys(MESSAGES).sort(), [...codes].sort());
  for (const code of codes) {
    assert.equal(new DiscoveryError(code).code, code);
    assert.doesNotMatch(MESSAGES[code], /whisper|ffmpeg|cuda|sqlite|electron|node\.?js|sha-?256|manifest/i);
  }
  assert.equal(new DiscoveryError('QUALQUER').code, 'BAD_RESPONSE');
});

// ------------------------------------------------------------------ keyPolicy

test('keyPolicy.isLoopbackHost: só a própria máquina', () => {
  for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) assert.equal(keyPolicy.isLoopbackHost(h), true, h);
  for (const h of ['', null, undefined, '127.0.0.256', '128.0.0.1', '192.168.0.1', '10.0.0.1', 'example.com', 'localhost.example.com', 'notlocalhost', '127.0.0.1.example.com', '0.0.0.0', '::2']) assert.equal(keyPolicy.isLoopbackHost(h), false, String(h));
});

test('keyPolicy.isPrivateHost: loopback e rede local, nunca a internet', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.1.1', 'minha-maquina', 'nas.local', '[fd00::1]', '[fe80::1]']) assert.equal(keyPolicy.isPrivateHost(h), true, h);
  for (const h of ['', '172.32.0.1', '8.8.8.8', 'api.groq.com', 'example.com', '[2001:db8::1]']) assert.equal(keyPolicy.isPrivateHost(h), false, h);
});

test('keyPolicy.assertKeyAllowed: http:// com chave só no loopback; sem chave tudo passa', () => {
  assert.equal(keyPolicy.assertKeyAllowed('https://api.exemplo.com/v1', KEY), true);
  assert.equal(keyPolicy.assertKeyAllowed('http://localhost:1234/v1', KEY), true);
  assert.equal(keyPolicy.assertKeyAllowed('http://[::1]:1234/v1', KEY), true);
  assert.equal(keyPolicy.assertKeyAllowed(new URL('http://127.0.0.1:11434/v1'), KEY), true);
  assert.equal(keyPolicy.assertKeyAllowed('http://api.exemplo.com/v1', ''), true);
  assert.equal(keyPolicy.assertKeyAllowed('http://api.exemplo.com/v1', undefined), true);
  for (const url of ['http://api.exemplo.com/v1', 'http://192.168.0.5/v1', 'http://10.0.0.1/v1']) {
    assert.throws(() => keyPolicy.assertKeyAllowed(url, KEY), (e) => e.code === 'KEY_INSECURE' && !e.message.includes(KEY));
  }
  assert.throws(() => keyPolicy.assertKeyAllowed('nao-e-url', KEY), (e) => e.code === 'BAD_URL');
  assert.throws(() => keyPolicy.assertKeyAllowed('ftp://x.example', KEY), (e) => e.code === 'BAD_URL');
});

test('keyPolicy.normalizeUserUrl: esquema, credenciais, caminho', () => {
  const n = keyPolicy.normalizeUserUrl;
  assert.equal(n('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(n('  api.groq.com/openai/v1  '), 'https://api.groq.com/openai/v1');
  assert.equal(n('api.exemplo.com'), 'https://api.exemplo.com/v1');
  assert.equal(n('localhost:1234/v1'), 'http://localhost:1234/v1');
  assert.equal(n('127.0.0.1:11434'), 'http://127.0.0.1:11434/v1');
  assert.equal(n('192.168.0.9:8080/v1'), 'http://192.168.0.9:8080/v1');
  assert.equal(n('[::1]:1234/v1'), 'http://[::1]:1234/v1');
  assert.equal(n('http://api.exemplo.com/v1'), 'http://api.exemplo.com/v1'); // o esquema digitado é respeitado
  assert.equal(n('https://x.example/v1?chave=1#topo'), 'https://x.example/v1');
  assert.equal(n('HTTPS://X.Example:443/a//'), 'https://x.example/a');
  for (const bad of [undefined, null, '', '   ', 5, '/v1', '//x.example', 'ftp://x.example', 'file:///x', 'data:text/plain,oi', 'javascript:alert(1)', 'mailto:a@b.c', 'https://u:p@x.example', 'https://x.example/ v1', 'https:///v1', 'x'.repeat(3000)]) {
    assert.throws(() => n(bad), (e) => e.code === 'BAD_URL', String(bad).slice(0, 40));
  }
});

// ------------------------------------------------------------------ OpenAIProvider usa a mesma regra

test('OpenAIProvider._headers usa keyPolicy: mesmo comportamento de antes', () => {
  const make = (baseUrl, key) => new OpenAIProvider({ getBaseUrl: () => baseUrl, getApiKey: () => key });
  const headers = (baseUrl, key) => make(baseUrl, key)._headers(OpenAIProvider.normalizeBaseUrl(baseUrl));
  assert.equal(headers('https://api.groq.com/openai/v1', KEY).authorization, `Bearer ${KEY}`);
  assert.equal(headers('http://localhost:1234/v1', KEY).authorization, `Bearer ${KEY}`);
  assert.equal(headers('http://localhost:1234/v1', '').authorization, undefined);
  assert.equal(headers('http://192.168.0.5:1234/v1', '').authorization, undefined);
  assert.throws(() => headers('http://api.exemplo.com/v1', KEY), (e) => e.code === 'KEY_INSECURE' && /http:\/\/ a servidores remotos/.test(e.message));
  assert.throws(() => headers('http://192.168.0.5:1234/v1', KEY), (e) => e.code === 'KEY_INSECURE');
  assert.throws(() => headers('https://api.openai.com/v1', ''), (e) => e.code === 'AI_NOT_CONFIGURED');
  assert.equal(OpenAIProvider.isLocalBase('http://localhost:1234/v1'), true);
  assert.equal(OpenAIProvider.isLocalBase('http://192.168.0.5:1234/v1'), false);
});
