'use strict';

/**
 * OpenAIProvider — IA via API da OpenAI ou de qualquer servidor compatível com ela
 * (Ollama, LM Studio, llama.cpp, gateways próprios...). O servidor é configurável: basta
 * trocar a URL base. Padrão: https://api.openai.com/v1
 *
 * Segurança: a chave de API só é enviada no cabeçalho Authorization, e nunca por http://
 * para um servidor que não seja a própria máquina.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_HOST = 'api.openai.com';

const isLocalHost = (hostname) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname) || hostname.endsWith('.localhost');

/** Normaliza a URL base: http(s), sem credenciais, sem barra final; caminho vazio vira /v1. */
function normalizeBaseUrl(raw) {
  let url;
  try { url = new URL(String(raw || DEFAULT_BASE_URL).trim()); }
  catch (_) { throw new Error('URL do servidor inválida.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('A URL do servidor deve começar com http:// ou https://.');
  if (url.username || url.password) throw new Error('A URL não deve conter usuário ou senha.');
  const pathname = url.pathname.replace(/\/+$/, '') || '/v1';
  return url.origin + pathname;
}

/** Retry-After (segundos ou data HTTP) de uma resposta -> segundos (inteiro >= 0) ou null. */
function parseRetryAfter(res) {
  const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (!raw) return null;
  if (/^\d+$/.test(String(raw).trim())) return Number(String(raw).trim());
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, Math.round((when - Date.now()) / 1000)) : null;
}

const NO_TOOLS_STATUS = [400, 404, 405, 415, 422, 501];
const MAX_TOOL_ARGS_CHARS = 100000;

/** Servidor/modelo que não aceita o parâmetro `tools`: recusa citando "tools"/"function"/"tool_choice". */
const mentionsTools = (text) => /\btools?\b|tool_choice|function[_ ]call/i.test(String(text || ''));

/** Erro padrão de "este servidor/modelo não suporta ferramentas" (o AssistantChat cai para só texto). */
const noToolsError = (detail) => Object.assign(new Error(`O servidor não aceita ferramentas: ${String(detail || '').slice(0, 160)}`), { code: 'NO_TOOLS' });

/** tool_calls de uma resposta inteira -> [{id, name, arguments}] */
function readToolCalls(message) {
  const calls = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];
  return calls.map((c, i) => ({
    id: String((c && c.id) || `call_${i + 1}`),
    name: String((c && c.function && c.function.name) || ''),
    arguments: String((c && c.function && c.function.arguments) || '').slice(0, MAX_TOOL_ARGS_CHARS)
  })).filter((c) => c.name);
}

class OpenAIProvider {
  constructor({ getBaseUrl, getApiKey, fetchImpl = fetch }) {
    this.id = 'openai';
    this._getBaseUrl = getBaseUrl;
    this._getApiKey = getApiKey;
    this._fetch = fetchImpl;
  }

  static get defaultBaseUrl() { return DEFAULT_BASE_URL; }
  static normalizeBaseUrl(raw) { return normalizeBaseUrl(raw); }
  static isOfficialOpenAI(baseUrl) { try { return new URL(baseUrl).hostname === OPENAI_HOST; } catch (_) { return false; } }

  _base() { return normalizeBaseUrl(this._getBaseUrl()); }

  /** Cabeçalhos da requisição, validando se a chave pode ser enviada para este servidor. */
  _headers(base) {
    const url = new URL(base);
    const key = this._getApiKey();
    const headers = { 'content-type': 'application/json' };
    if (key) {
      if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
        throw Object.assign(new Error('Por segurança, a chave de API não é enviada por http:// a servidores remotos. Use https://.'), { code: 'KEY_INSECURE' });
      }
      headers.authorization = `Bearer ${key}`;
    } else if (url.hostname === OPENAI_HOST) {
      throw Object.assign(new Error('Chave de API da OpenAI não configurada.'), { code: 'AI_NOT_CONFIGURED' });
    }
    return headers;
  }

  /** `signal` (opcional) permite cancelar de fora: o erro sai com code 'CANCELLED', diferente do tempo esgotado. */
  async _request(url, options, timeoutMs, signal = null) {
    const cancelled = () => Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' });
    if (signal && signal.aborted) throw cancelled();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this._fetch(url, { ...options, signal: controller.signal });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { /* resposta não-JSON */ }
      if (!res.ok) {
        const detail = data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || text.slice(0, 200) || res.statusText;
        throw Object.assign(new Error(`Servidor (${res.status}): ${detail}`), { status: res.status, body: text.slice(0, 500), retryAfter: parseRetryAfter(res) });
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') {
        if (signal && signal.aborted) throw cancelled();
        throw Object.assign(new Error('Tempo esgotado ao falar com o servidor de IA.'), { code: 'TIMEOUT' });
      }
      if (err.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err.message)) {
        throw Object.assign(new Error('Não foi possível conectar ao servidor de IA. Confira a URL e se ele está em execução.'), { code: 'AI_UNREACHABLE' });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async listModels() {
    const base = this._base();
    const data = await this._request(`${base}/models`, { method: 'GET', headers: this._headers(base) }, 15000);
    const ids = (data?.data || data?.models || []).map((m) => m.id || m.name).filter(Boolean);
    return [...new Set(ids)].sort().map((id) => ({ id, label: id }));
  }

  async testConnection() {
    const models = await this.listModels();
    return { ok: true, message: `Conexão validada (${models.length} modelo(s) disponível(is)).` };
  }

  /**
   * @param {{model:string, system:string, messages:Array<{role:string,content:string}>, maxTokens:number, signal?:AbortSignal}} p
   * @returns {Promise<{text:string, usage:object|null, finishReason:string|null}>}  finishReason 'length' = resposta cortada
   */
  async chat({ model, system, messages, maxTokens, signal = null, tools = null }) {
    const base = this._base();
    // A OpenAI atual exige max_completion_tokens; servidores compatíveis usam max_tokens.
    const limitField = OpenAIProvider.isOfficialOpenAI(base) ? 'max_completion_tokens' : 'max_tokens';
    const body = { model, [limitField]: maxTokens, messages: [{ role: 'system', content: system }, ...messages] };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
    let data;
    try {
      data = await this._request(`${base}/chat/completions`, {
        method: 'POST',
        headers: this._headers(base),
        body: JSON.stringify(body)
      }, 300000, signal); // servidores locais podem demorar no primeiro carregamento do modelo
    } catch (err) {
      if (tools && tools.length && NO_TOOLS_STATUS.includes(err.status) && mentionsTools(err.body)) throw noToolsError(err.body);
      throw err;
    }
    const message = data?.choices?.[0]?.message;
    return {
      text: message?.content || '',
      toolCalls: readToolCalls(message),
      usage: data?.usage || null,
      finishReason: data?.choices?.[0]?.finish_reason || null
    };
  }

  /**
   * Resposta em STREAMING (SSE do protocolo de chat compatível). Cada pedaço de texto chega em `onDelta(texto)`.
   *  - `signal` cancela de fora (erro com code 'CANCELLED'); o cancelamento fecha a conexão.
   *  - Tempo por INATIVIDADE: `firstChunkTimeoutMs` até o primeiro dado (modelos locais demoram a carregar) e
   *    `idleTimeoutMs` entre os pedaços seguintes. Esgotado: erro 'Tempo esgotado…' (code 'TIMEOUT').
   *  - Se o servidor não suportar streaming (responde JSON inteiro, ou recusa o parâmetro antes de qualquer
   *    texto), cai para a resposta inteira: o texto sai num único `onDelta`.
   *  - `tools` (opcional): definições de ferramentas (function calling). Os pedaços de `tool_calls` do streaming são
   *    acumulados (o nome e os `arguments` chegam divididos) e saem em `toolCalls`. Servidor que recusa o parâmetro
   *    `tools` (400/404/422... citando "tools") lança erro com code 'NO_TOOLS' antes de qualquer texto.
   * @returns {Promise<{text:string, toolCalls:Array<{id:string,name:string,arguments:string}>, usage:object|null, finishReason:string|null, streamed:boolean}>}
   */
  async chatStream({ model, system, messages, maxTokens, signal = null, onDelta = () => {}, tools = null,
    firstChunkTimeoutMs = 300000, idleTimeoutMs = 60000 }) {
    const cancelled = () => Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' });
    if (signal && signal.aborted) throw cancelled();
    const base = this._base();
    const limitField = OpenAIProvider.isOfficialOpenAI(base) ? 'max_completion_tokens' : 'max_tokens';
    const body = { model, [limitField]: maxTokens, messages: [{ role: 'system', content: system }, ...messages] };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }

    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms); };
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const fallbackWhole = async () => {
      const whole = await this.chat({ model, system, messages, maxTokens, signal, tools });
      if (whole.text) onDelta(whole.text);
      return { ...whole, streamed: false };
    };

    try {
      arm(firstChunkTimeoutMs);
      let res;
      try {
        res = await this._fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { ...this._headers(base), accept: 'text/event-stream' },
          body: JSON.stringify({ ...body, stream: true }),
          signal: controller.signal
        });
      } catch (err) {
        throw this._streamError(err, { signal, timedOut });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // Servidor sem suporte a ferramentas: o chamador cai para só texto
        if (tools && tools.length && NO_TOOLS_STATUS.includes(res.status) && mentionsTools(text)) throw noToolsError(text);
        // 400/404/405/415/422/501 antes de qualquer texto: servidor sem suporte ao parâmetro de streaming
        if (NO_TOOLS_STATUS.includes(res.status) && /stream/i.test(text)) {
          clearTimeout(timer);
          return await fallbackWhole();
        }
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { /* não-JSON */ }
        const detail = data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || text.slice(0, 200) || res.statusText;
        throw Object.assign(new Error(`Servidor (${res.status}): ${detail}`), { status: res.status, body: text.slice(0, 500), retryAfter: parseRetryAfter(res) });
      }

      const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
      if (!res.body || !type.includes('text/event-stream')) {
        // Resposta inteira (sem streaming): lê o JSON normal
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { /* não-JSON */ }
        const out = data?.choices?.[0]?.message?.content || '';
        if (out) onDelta(out);
        return { text: out, toolCalls: readToolCalls(data?.choices?.[0]?.message), usage: data?.usage || null, finishReason: data?.choices?.[0]?.finish_reason || null, streamed: false };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let full = '';
      let usage = null;
      let finishReason = null;
      let done = false;
      const callParts = new Map(); // índice -> { id, name, arguments } (os pedaços chegam divididos)

      const handleEvent = (block) => {
        for (const rawLine of block.split(/\r?\n/)) {
          if (!rawLine.startsWith('data:')) continue; // comentários (":") e outros campos são ignorados
          const payload = rawLine.slice(5).trim();
          if (!payload) continue;
          if (payload === '[DONE]') { done = true; return; }
          let json;
          try { json = JSON.parse(payload); } catch (_) { continue; }
          if (json && json.error) {
            const msg = json.error.message || (typeof json.error === 'string' ? json.error : 'erro desconhecido');
            throw Object.assign(new Error(`Servidor: ${msg}`), { code: 'STREAM_ERROR' });
          }
          if (json && json.usage) usage = json.usage;
          const choice = json && json.choices && json.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const piece = choice.delta && typeof choice.delta.content === 'string' ? choice.delta.content : '';
          if (piece) { full += piece; onDelta(piece); }
          const parts = choice.delta && Array.isArray(choice.delta.tool_calls) ? choice.delta.tool_calls : [];
          for (const part of parts) {
            if (!part || typeof part !== 'object') continue;
            const idx = Number.isInteger(part.index) ? part.index : 0;
            const cur = callParts.get(idx) || { id: '', name: '', arguments: '' };
            if (typeof part.id === 'string' && part.id) cur.id = part.id;
            const fn = part.function || {};
            if (typeof fn.name === 'string') cur.name += fn.name;
            if (typeof fn.arguments === 'string' && cur.arguments.length < MAX_TOOL_ARGS_CHARS) cur.arguments += fn.arguments;
            callParts.set(idx, cur);
          }
        }
      };

      try {
        while (!done) {
          arm(full || buffer || callParts.size ? idleTimeoutMs : firstChunkTimeoutMs);
          const { value, done: finished } = await reader.read();
          if (finished) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while (!done && (cut = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
            handleEvent(block);
          }
        }
        if (!done && buffer.trim()) handleEvent(buffer); // último evento sem linha em branco final
      } catch (err) {
        try { await reader.cancel(); } catch (_) { /* conexão já fechada */ }
        throw this._streamError(err, { signal, timedOut });
      }
      try { await reader.cancel(); } catch (_) { /* já encerrado */ }
      const toolCalls = [...callParts.entries()].sort((a, b) => a[0] - b[0])
        .map(([, c], i) => ({ id: c.id || `call_${i + 1}`, name: c.name, arguments: c.arguments }))
        .filter((c) => c.name);
      return { text: full, toolCalls, usage, finishReason, streamed: true };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Converte falhas de rede/abortos do streaming nas mensagens padrão (cancelado, tempo esgotado, sem conexão). */
  _streamError(err, { signal, timedOut }) {
    if (err && err.code === 'CANCELLED') return err;
    if (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)))) {
      if (signal && signal.aborted) return Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' });
      if (timedOut) return Object.assign(new Error('Tempo esgotado: o servidor de IA parou de responder.'), { code: 'TIMEOUT' });
    }
    if (err && (err.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(String(err.message)))) {
      return Object.assign(new Error('Não foi possível conectar ao servidor de IA. Confira a URL e se ele está em execução.'), { code: 'AI_UNREACHABLE' });
    }
    if (err && (/terminated|other side closed|ECONNRESET/i.test(String(err.message)) || err.cause?.code === 'UND_ERR_SOCKET')) {
      return Object.assign(new Error('A conexão com o servidor de IA foi interrompida.'), { code: 'INTERRUPTED' });
    }
    return err;
  }
}

module.exports = OpenAIProvider;
