'use strict';

/**
 * discovery: descobre os modelos de um servidor de IA a partir do endereço e da chave. SÓ lista modelos (GET): nenhum conteúdo
 * do usuário (texto, áudio, foto) é enviado.
 *
 *  - Anthropic: só quando o host é exatamente api.anthropic.com com https. GET {origem}/v1/models?limit=100 (pagina com
 *    after_id enquanto has_more, no máximo 5 páginas), cabeçalhos x-api-key e anthropic-version, NUNCA Authorization.
 *  - Qualquer outro endereço (formato compatível com OpenAI): GET {base}/models, com Authorization: Bearer só quando há chave.
 *  - Sempre redirect:'error' (a chave nunca segue um redirecionamento), prazo total e cancelamento por AbortSignal.
 *  - Chave por http:// só no loopback (keyPolicy).
 *  - Erros: DiscoveryError com code e mensagem FIXA em português. Nunca repassa texto do servidor nem a chave.
 */

const { classifyAll, countCaps, parseModelsPayload } = require('../modelKinds');
const { assertKeyAllowed, isPrivateHost, normalizeUserUrl } = require('./keyPolicy');

const ANTHROPIC_HOST = 'api.anthropic.com';
const ANTHROPIC_BASE = `https://${ANTHROPIC_HOST}/v1`;
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_PAGES = 5;
const MAX_BODY_CHARS = 8 * 1024 * 1024;
const MAX_KEY_LENGTH = 4096;

const MESSAGES = Object.freeze({
  BAD_URL: 'O endereço do servidor é inválido. Use algo como https://api.exemplo.com/v1.',
  INSECURE: 'Por segurança, a chave de API não é enviada por http:// a servidores fora deste computador. Use https://.',
  AUTH: 'O servidor recusou a chave de API. Confira se ela está correta e ativa.',
  NO_KEY: 'Este serviço exige chave de API. Cole a chave e tente de novo.',
  BAD_KEY: 'A chave tem caracteres inválidos.',
  NOT_FOUND: 'O servidor não tem a lista de modelos neste endereço. Confira o endereço (costuma terminar em /v1).',
  RATE_LIMIT: 'O servidor pediu para aguardar antes de novas consultas. Tente de novo em instantes.',
  NETWORK: 'Não foi possível conectar ao servidor. Confira o endereço, a internet e se ele está em execução.',
  TIMEOUT: 'O servidor demorou demais para responder.',
  REDIRECT: 'O servidor tentou redirecionar a consulta. Por segurança, o app não segue redirecionamentos: use o endereço final.',
  BAD_RESPONSE: 'O servidor respondeu em um formato que o app não reconhece.',
  EMPTY: 'O servidor não informou nenhum modelo utilizável.',
  WORKSPACE: 'A chave não tem acesso aos modelos neste espaço de trabalho. Confira o espaço de trabalho da chave.',
  CANCELLED: 'Busca cancelada.'
});

class DiscoveryError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.BAD_RESPONSE);
    this.name = 'DiscoveryError';
    this.code = MESSAGES[code] ? code : 'BAD_RESPONSE';
  }
}

/**
 * Lê o corpo da resposta com teto de bytes: resposta em pedaços (sem content-length) de um servidor hostil ou defeituoso não
 * enche a memória do processo; ao passar do teto a consulta é abortada (BAD_RESPONSE). Sem stream (fetch simulado), lê de uma vez.
 */
async function readBody(res, controller) {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text();
    if (typeof text !== 'string' || text.length > MAX_BODY_CHARS) throw new DiscoveryError('BAD_RESPONSE');
    return text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_CHARS) {
      controller.abort();
      try { await reader.cancel(); } catch (_) { /* já abortado */ }
      throw new DiscoveryError('BAD_RESPONSE');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const isAnthropicUrl = (url) => url.protocol === 'https:' && url.hostname === ANTHROPIC_HOST && url.port === '';

/**
 * @param {{baseUrl:string, apiKey?:string, fetchImpl?:Function, signal?:AbortSignal, timeoutMs?:number}} p
 * @returns {Promise<{format:'openai'|'anthropic', baseUrl:string, host:string, isLocal:boolean, models:Array, counts:object}>}
 * @throws {DiscoveryError}
 */
async function discoverModels({ baseUrl, apiKey, fetchImpl = fetch, signal, timeoutMs = 15000 } = {}) {
  if (signal && signal.aborted) throw new DiscoveryError('CANCELLED');

  let normalized;
  try { normalized = normalizeUserUrl(baseUrl); }
  catch (_) { throw new DiscoveryError('BAD_URL'); }
  const url = new URL(normalized);

  if (apiKey !== undefined && apiKey !== null && typeof apiKey !== 'string') throw new DiscoveryError('BAD_KEY');
  const key = (apiKey || '').trim();
  // Chave é texto visível sem espaço: qualquer outra coisa quebraria o cabeçalho (ou tentaria injetar outro).
  if (key && (key.length > MAX_KEY_LENGTH || /[^\x21-\x7e]/.test(key))) throw new DiscoveryError('BAD_KEY');
  try { assertKeyAllowed(url, key); }
  catch (err) { throw new DiscoveryError(err && err.code === 'KEY_INSECURE' ? 'INSECURE' : 'BAD_URL'); }

  const anthropic = isAnthropicUrl(url);
  if (anthropic && !key) throw new DiscoveryError('NO_KEY');   // nenhuma consulta é feita: não é uma recusa do servidor

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  /** Um GET; devolve o JSON já lido. Todo erro sai como DiscoveryError. */
  const getJson = async (target, headers) => {
    try {
      const res = await fetchImpl(target, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
      const status = Number(res && res.status);
      if (res && (res.redirected === true || res.type === 'opaqueredirect' || (status >= 300 && status < 400))) throw new DiscoveryError('REDIRECT');
      const ok = Number.isFinite(status) ? status >= 200 && status < 300 : Boolean(res && res.ok);
      if (!ok) {
        if (status === 401) throw new DiscoveryError('AUTH');
        if (anthropic && [400, 403, 404].includes(status)) {
          let body = '';
          try { body = String(await res.text()).slice(0, 20000); } catch (_) { /* corpo ilegível */ }
          if (/workspace/i.test(body)) throw new DiscoveryError('WORKSPACE');
        }
        if (status === 403) throw new DiscoveryError('AUTH');
        if (status === 404) throw new DiscoveryError('NOT_FOUND');
        if (status === 429) throw new DiscoveryError('RATE_LIMIT');
        throw new DiscoveryError('BAD_RESPONSE');
      }
      const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
      if (Number.isFinite(declared) && declared > MAX_BODY_CHARS) throw new DiscoveryError('BAD_RESPONSE');
      const text = await readBody(res, controller);
      try { return JSON.parse(text); }
      catch (_) { throw new DiscoveryError('BAD_RESPONSE'); }
    } catch (err) {
      if (err instanceof DiscoveryError) throw err;
      if (signal && signal.aborted) throw new DiscoveryError('CANCELLED');
      if (timedOut || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'))) throw new DiscoveryError('TIMEOUT');
      if (/redirect/i.test(String((err && err.message) || '')) || /redirect/i.test(String((err && err.cause && err.cause.message) || ''))) throw new DiscoveryError('REDIRECT');
      throw new DiscoveryError('NETWORK');
    }
  };

  try {
    let entries = [];
    if (anthropic) {
      const headers = { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, accept: 'application/json' };
      let afterId = '';
      for (let page = 0; page < MAX_PAGES; page++) {
        const target = `${url.origin}/v1/models?limit=100${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`;
        const payload = await getJson(target, headers);
        const items = parseModelsPayload(payload);
        if (!items) throw new DiscoveryError('BAD_RESPONSE');
        entries = entries.concat(items);
        const next = payload && payload.has_more === true && typeof payload.last_id === 'string' ? payload.last_id : '';
        if (!next) break;
        afterId = next;
      }
    } else {
      const headers = { accept: 'application/json' };
      if (key) headers.authorization = `Bearer ${key}`;
      const items = parseModelsPayload(await getJson(`${normalized}/models`, headers));
      if (!items) throw new DiscoveryError('BAD_RESPONSE');
      entries = items;
    }

    const models = classifyAll(entries);
    if (!models.length) throw new DiscoveryError('EMPTY');
    return {
      format: anthropic ? 'anthropic' : 'openai',
      baseUrl: anthropic ? ANTHROPIC_BASE : normalized,
      host: url.hostname,
      isLocal: isPrivateHost(url.hostname),
      models,
      counts: countCaps(models)
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { discoverModels, DiscoveryError, isAnthropicUrl, ANTHROPIC_HOST, ANTHROPIC_VERSION, ANTHROPIC_BASE, MESSAGES };
