'use strict';

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../../../services/logService');
const BdsmProtocol = require('./BdsmProtocol');
const bdsmAuth = require('./BdsmAuth');

/** Teto de upload de LUT aceito pelo celular (LUT_MAX_UPLOAD_BYTES = 32 MB; acima disso ele responde 413). */
const LUT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const THUMB_MAX_BYTES = 2 * 1024 * 1024;

/** Erro de comunicação com o celular. `code` é estável (ver BdsmProtocol.ERRORS); `message` já é texto para o usuário. */
class BdsmError extends Error {
  constructor(code, message, { status = null, details = null } = {}) {
    super(message || BdsmProtocol.ERRORS[code] || 'Falha na comunicação com o celular.');
    this.name = 'BdsmError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const STATUS_CODES = { 400: 'BAD_REQUEST', 401: 'PAIRING_REQUIRED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'TOO_LARGE', 429: 'DEVICE_BUSY' };

/** Código estável para um status HTTP de erro. */
function codeForStatus(status) {
  return STATUS_CODES[status] || 'DEVICE_ERROR';
}

/**
 * BdsmClient — Cliente HTTP/REST do servidor do celular (BDS Mobile).
 *
 * Toda chamada (exceto /pair/* e a sondagem sem pareamento) leva `Authorization: Bearer <token>`. O token é
 * buscado no BdsmAuth pelo endereço (ip:porta) que a descoberta associou ao aparelho; nunca passa pelo renderer.
 * Um 401 descarta o token salvo e vira BdsmError('PAIRING_REQUIRED').
 */
class BdsmClient {
  /**
   * @param {string} ip - Endereço IP do dispositivo
   * @param {number} [port=8080] - Porta do serviço BDSM
   * @param {{auth?:object, token?:string}} [opts] - `auth` (BdsmAuth) e/ou `token` explícito (testes)
   */
  constructor(ip, port = BdsmProtocol.DEFAULT_PORT, opts = {}) {
    this.ip = ip;
    this.port = port;
    this.auth = opts.auth || bdsmAuth;
    this._explicitToken = opts.token || null;
    this.baseUrl = `http://${ip}:${port}/api`;
  }

  /** Token a enviar agora (ou null). */
  _token() {
    return this._explicitToken || this.auth.tokenForEndpoint(this.ip, this.port);
  }

  get hasToken() { return !!this._token(); }

  _headers(extra = {}, withAuth = true) {
    const headers = BdsmProtocol.buildHeaders(extra);
    const token = withAuth ? this._token() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /**
   * Requisição com timeout e erros padronizados.
   * @param {string} endpoint relativo a /api
   * @param {{method?:string, headers?:object, body?:any, timeout?:number, auth?:boolean, parse?:'json'|'buffer'|'response'|'none', silent?:boolean}} [o]
   */
  async _request(endpoint, o = {}) {
    const { method = 'GET', headers, body, timeout = 10000, auth = true, parse = 'json', silent = false } = o;
    const usedToken = auth && this.hasToken;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      let response;
      try {
        response = await fetch(`${this.baseUrl}${endpoint}`, { method, headers: this._headers(headers, auth), body, signal: controller.signal });
      } catch (e) {
        throw new BdsmError('DEVICE_UNREACHABLE', null, { details: e && e.name === 'AbortError' ? 'timeout' : (e && e.cause && e.cause.code) || null });
      }
      if (!response.ok) {
        let details = null;
        try { const text = await response.text(); details = text ? JSON.parse(text) : null; } catch (_) { /* corpo não-JSON */ }
        const code = codeForStatus(response.status);
        if (code === 'PAIRING_REQUIRED' && usedToken) this.auth.forgetEndpoint(this.ip, this.port); // token recusado: descarta
        throw new BdsmError(code, null, { status: response.status, details });
      }
      try {
        if (parse === 'json') return await response.json();
        if (parse === 'buffer') return Buffer.from(await response.arrayBuffer());
        if (parse === 'none') { await response.arrayBuffer(); return null; }
      } catch (e) {
        throw new BdsmError('DEVICE_UNREACHABLE', null, { details: e && e.name === 'AbortError' ? 'timeout' : 'corpo' });
      }
      return response; // parse === 'response': quem chama lê o corpo (o timeout deixa de valer depois dos cabeçalhos)
    } catch (e) {
      if (!silent && !(e instanceof BdsmError && e.code === 'DEVICE_BUSY')) {
        logger.error(`[BdsmClient] Erro na requisição ${method} ${endpoint.replace(/\/pair\/status\/.*/, '/pair/status/…')}: ${e.code || ''} ${e.status || ''} ${e.message}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Informações do dispositivo. Sem token válido vem só { deviceName, deviceModel, appVersion, authRequired: true };
   * com token válido vêm também bateria e armazenamento.
   */
  async getInfo(silent = false, timeout = 2500, useToken = true) {
    return this._request(BdsmProtocol.ENDPOINTS.DISCOVERY_INFO, { timeout, silent, auth: useToken });
  }

  /** Pedido de pareamento -> { requestId, code, expiresInSec }. 429 (pedido pendente/cooldown) vira DEVICE_BUSY. */
  async requestPairing({ clientId, clientName }) {
    const res = await this._request(BdsmProtocol.ENDPOINTS.PAIR_REQUEST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientName }),
      auth: false,
      timeout: 5000
    });
    if (!res || !res.requestId || !res.code) throw new BdsmError('DEVICE_ERROR');
    return { requestId: String(res.requestId), code: String(res.code), expiresInSec: Number(res.expiresInSec) || BdsmProtocol.PAIR_TTL_SEC };
  }

  /** Estado do pedido -> { state: PENDING|APPROVED|DENIED|EXPIRED, token? }. 404 (outro IP ou pedido descartado) vira NOT_FOUND. */
  async pairingStatus(requestId) {
    return this._request(BdsmProtocol.ENDPOINTS.PAIR_STATUS(requestId), { auth: false, timeout: 5000, silent: true });
  }

  /**
   * Lista as mídias do dispositivo já no formato do app: { id, name, size, duration, width, height, fps, codec, createdAt }.
   * (O servidor usa `filename` e `filesize`; itens sem id ou nome são descartados.)
   */
  async getMedia() {
    const list = await this._request(BdsmProtocol.ENDPOINTS.MEDIA_LIST);
    return (Array.isArray(list) ? list : []).map(BdsmProtocol.normalizeMediaItem).filter(Boolean);
  }

  /**
   * Abre o download de uma mídia (Response com `Content-Length`; aceita `Range: bytes=N-` para retomar).
   * O corpo é lido por quem chama.
   */
  async openMediaDownload(id, { range = null, timeout = 30000 } = {}) {
    const headers = range ? { Range: range } : undefined;
    return this._request(BdsmProtocol.ENDPOINTS.MEDIA_DOWNLOAD(id), { headers, timeout, parse: 'response' });
  }

  /** Miniatura da mídia como { buffer, contentType } (limite de 2 MB; só imagens). */
  async getThumbnail(id) {
    const res = await this._request(BdsmProtocol.ENDPOINTS.MEDIA_THUMBNAIL(id), { parse: 'response', timeout: 8000 });
    const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp)$/.test(contentType)) throw new BdsmError('NOT_FOUND', null, { status: 404 });
    const length = Number(res.headers.get('content-length') || 0);
    if (length > THUMB_MAX_BYTES) throw new BdsmError('TOO_LARGE');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > THUMB_MAX_BYTES) throw new BdsmError('TOO_LARGE');
    return { buffer, contentType };
  }

  /** Remove uma mídia do dispositivo (200 OK sem corpo). */
  async deleteMedia(id) {
    await this._request(BdsmProtocol.ENDPOINTS.MEDIA_DELETE(id), { method: 'DELETE', parse: 'none' });
    return true;
  }

  /** Lista as LUTs do celular: [{ name, relativePath, size, hash (SHA-256 hex) }]. */
  async getLuts() {
    const list = await this._request(BdsmProtocol.ENDPOINTS.LUTS_LIST, { timeout: 30000 });
    return Array.isArray(list) ? list : [];
  }

  /**
   * Envia uma LUT (.cube) ao celular: multipart com o campo texto `relativePath` e o arquivo.
   * Se já existe uma LUT com o mesmo caminho e conteúdo diferente o celular responde 409 (CONFLICT);
   * para substituir, apague a remota antes (deleteLut).
   */
  async uploadLut(filePath, destPath) {
    const stat = fs.statSync(filePath);
    if (stat.size > LUT_MAX_UPLOAD_BYTES) throw new BdsmError('TOO_LARGE');
    const blob = new Blob([fs.readFileSync(filePath)], { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.append('relativePath', destPath);
    formData.append('file', blob, path.basename(filePath));
    await this._request(BdsmProtocol.ENDPOINTS.LUTS_UPLOAD, { method: 'POST', body: formData, timeout: 60000, parse: 'none' });
    return true;
  }

  /** Remove uma LUT do dispositivo (caminho em segmentos separados). */
  async deleteLut(relativePath) {
    await this._request(BdsmProtocol.ENDPOINTS.LUTS_DELETE(relativePath), { method: 'DELETE', parse: 'none' });
    return true;
  }
}

module.exports = BdsmClient;
module.exports.BdsmError = BdsmError;
module.exports.codeForStatus = codeForStatus;
module.exports.LUT_MAX_UPLOAD_BYTES = LUT_MAX_UPLOAD_BYTES;
