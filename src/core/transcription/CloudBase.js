'use strict';

/**
 * CloudBase — o que os motores de transcrição na nuvem têm em comum: preparar o áudio (ffmpeg → AAC mono, poucos MB
 * por 10 minutos de fala), enviar com novas tentativas para falhas passageiras e traduzir os erros do serviço em
 * mensagens claras. A chave só é lida aqui, no processo principal, e nunca entra em mensagens de erro nem em logs.
 *
 * Os motores (GroqTranscriber, ElevenLabsTranscriber) devolvem o formato do whisper.cpp:
 * { language, segments:[{start,end,text}], words:[{word,start,end}], hasTokens:false }, então legendas, transcrição,
 * texto e remapeamento de silêncio funcionam sem mudanças. O áudio SAI do computador nestes motores: quem chama deve
 * avisar o usuário.
 */

const fs = require('node:fs');
const { RunnerError, runProcess } = require('../modules/WhisperCppRunner');
const { PROVIDERS } = require('./CloudConfig');

const MAX_RETRIES = 3;
const MAX_WAIT_SECONDS = 60; // espera máxima por um "tente de novo em" (429) antes de desistir

const cancelled = () => new RunnerError('Transcrição cancelada.', 'CANCELLED');
const sleepDefault = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(cancelled()); }, { once: true });
});

/** Junta o sinal do usuário com o limite de tempo do envio. */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : (signal || timeout);
}

/** Mensagem curta do corpo de erro (formatos do Groq/OpenAI e da ElevenLabs), sem nenhuma chave. */
function shortMessage(json) {
  let msg = '';
  if (json && json.error && typeof json.error.message === 'string') msg = json.error.message;
  else if (json && json.detail && typeof json.detail.message === 'string') msg = json.detail.message;
  else if (json && Array.isArray(json.detail) && json.detail[0] && typeof json.detail[0].msg === 'string') msg = json.detail[0].msg;
  return msg.replace(/(gsk_|sk_)[A-Za-z0-9_-]+/g, '[chave]').replace(/\s+/g, ' ').trim().slice(0, 200);
}

class CloudBase {
  /**
   * @param {{provider:string, config:{readKey:Function,getModel:Function}, ffmpegPath?:string|null, ffmpegBaseArgs?:string[],
   *          fetchImpl?:Function, slice?:Function, sleep?:Function}} cfg
   */
  constructor({ provider, config, ffmpegPath = null, ffmpegBaseArgs = [], fetchImpl = globalThis.fetch, slice = null, sleep = sleepDefault }) {
    this.provider = provider;
    this.providerLabel = PROVIDERS[provider].label;
    this.baseUrl = PROVIDERS[provider].baseUrl;
    this.authHeaders = PROVIDERS[provider].authHeaders;
    this.config = config;
    this.ffmpegPath = ffmpegPath;
    this.ffmpegBaseArgs = ffmpegBaseArgs;
    this.fetch = fetchImpl;
    this.slice = slice || this._sliceWithFfmpeg.bind(this);
    this.sleep = sleep;
  }

  get label() { return `${this.providerLabel} ${this.config.getModel(this.provider)}`; }

  /** A chave, ou o erro que manda o usuário informá-la. */
  _requireKey() {
    const key = this.config.readKey(this.provider);
    if (!key) throw new RunnerError(`Falta a chave de API do ${this.providerLabel}. Informe-a em Configurações → Inteligência Artificial.`, 'NO_KEY');
    return key;
  }

  /** ffmpeg: recorta [start, start+length) do WAV e grava AAC mono. */
  async _sliceWithFfmpeg(wav, start, length, out, signal) {
    const command = this.ffmpegPath || process.execPath;
    const { code } = await runProcess({
      command,
      args: [...this.ffmpegBaseArgs, '-nostdin', '-v', 'error', '-y', '-ss', String(start), '-t', String(length), '-i', wav,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k', out],
      signal
    });
    if (code !== 0 || !fs.existsSync(out)) throw new RunnerError(`Não foi possível preparar o áudio para envio ao ${this.providerLabel}.`, 'DECODE');
  }

  /**
   * Um envio (POST multipart), com novas tentativas para falhas passageiras (rede, 5xx, 429 curto).
   * @param {{path:string, buildForm:()=>FormData, key:string, signal?:AbortSignal, timeoutMs:number, onEvent?:Function}} req
   * @returns {Promise<object>} o JSON da resposta
   */
  async _send({ path: apiPath, buildForm, key, signal, timeoutMs, onEvent = () => {} }) {
    const who = this.providerLabel;
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal && signal.aborted) throw cancelled();
      let res;
      try {
        res = await this.fetch(`${this.baseUrl}${apiPath}`, {
          method: 'POST', headers: this.authHeaders(key), body: buildForm(), signal: withTimeout(signal, timeoutMs)
        });
      } catch (err) {
        if (signal && signal.aborted) throw cancelled();
        lastError = new RunnerError(`Não foi possível falar com o ${who}. Verifique a conexão com a internet.`, 'CLOUD_NETWORK');
        await this._backoff(attempt, null, signal, onEvent);
        continue;
      }

      if (res.ok) {
        try { return await res.json(); } catch (_) { throw new RunnerError(`O ${who} devolveu uma resposta ilegível.`, 'CLOUD_BAD_RESPONSE'); }
      }
      let body = null;
      try { body = await res.json(); } catch (_) { /* sem corpo legível */ }
      const status = body && body.detail && typeof body.detail === 'object' ? String(body.detail.status || '') : '';

      if (status === 'quota_exceeded') throw new RunnerError(`Os créditos do ${who} acabaram. Confira o plano na sua conta.`, 'CLOUD_QUOTA');
      if (res.status === 401 || res.status === 403) throw new RunnerError(`O ${who} recusou a chave de API. Confira a chave em Configurações → Inteligência Artificial.`, 'CLOUD_AUTH');
      if (res.status === 413) throw new RunnerError(`O áudio é grande demais para o ${who}.`, 'CLOUD_TOO_LARGE');
      if (res.status === 429) {
        const wait = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        if (Number.isFinite(wait) && wait > MAX_WAIT_SECONDS) {
          throw new RunnerError(`O limite de uso do ${who} foi atingido. Tente de novo em ${Math.ceil(wait / 60)} min.`, 'CLOUD_RATE_LIMIT');
        }
        lastError = new RunnerError(`O limite de uso do ${who} foi atingido. Tente de novo em instantes.`, 'CLOUD_RATE_LIMIT');
        await this._backoff(attempt, Number.isFinite(wait) ? wait : null, signal, onEvent);
        continue;
      }
      if (res.status >= 500) {
        lastError = new RunnerError(`O ${who} está com problemas (erro ${res.status}). Tente de novo em instantes.`, 'CLOUD_HTTP');
        await this._backoff(attempt, null, signal, onEvent);
        continue;
      }
      const detail = shortMessage(body);
      throw new RunnerError(`O ${who} recusou o pedido${detail ? `: ${detail}` : ` (erro ${res.status})`}.`, 'CLOUD_HTTP');
    }
    throw lastError || new RunnerError(`Falha ao falar com o ${who}.`, 'CLOUD_NETWORK');
  }

  async _backoff(attempt, retryAfterSeconds, signal, onEvent) {
    if (attempt >= MAX_RETRIES) return; // a última tentativa não espera: o laço acaba e o erro sobe
    const seconds = retryAfterSeconds !== null ? Math.max(1, retryAfterSeconds) : [2, 5, 12][attempt] || 12;
    onEvent({ type: 'status', text: `O ${this.providerLabel} pediu uma pausa; nova tentativa em ${Math.ceil(seconds)} s` });
    await this.sleep(seconds * 1000, signal);
  }
}

module.exports = { CloudBase, shortMessage, withTimeout, cancelled };
