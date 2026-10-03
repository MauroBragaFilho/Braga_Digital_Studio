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
        throw new Error('Por segurança, a chave de API não é enviada por http:// a servidores remotos. Use https://.');
      }
      headers.authorization = `Bearer ${key}`;
    } else if (url.hostname === OPENAI_HOST) {
      throw new Error('Chave de API da OpenAI não configurada.');
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
        throw new Error(`Servidor (${res.status}): ${detail}`);
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') {
        if (signal && signal.aborted) throw cancelled();
        throw new Error('Tempo esgotado ao falar com o servidor de IA.');
      }
      if (err.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err.message)) {
        throw new Error('Não foi possível conectar ao servidor de IA. Confira a URL e se ele está em execução.');
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
  async chat({ model, system, messages, maxTokens, signal = null }) {
    const base = this._base();
    // A OpenAI atual exige max_completion_tokens; servidores compatíveis usam max_tokens.
    const limitField = OpenAIProvider.isOfficialOpenAI(base) ? 'max_completion_tokens' : 'max_tokens';
    const data = await this._request(`${base}/chat/completions`, {
      method: 'POST',
      headers: this._headers(base),
      body: JSON.stringify({ model, [limitField]: maxTokens, messages: [{ role: 'system', content: system }, ...messages] })
    }, 300000, signal); // servidores locais podem demorar no primeiro carregamento do modelo
    const text = data?.choices?.[0]?.message?.content || '';
    return { text, usage: data?.usage || null, finishReason: data?.choices?.[0]?.finish_reason || null };
  }
}

module.exports = OpenAIProvider;
