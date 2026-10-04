'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const logger = require('../../../services/logService');
const BdsmProtocol = require('./BdsmProtocol');

const FILE_NAME = 'bdsm-pairing.json';
const MAX_CLIENT_NAME = 40; // o servidor corta o nome em 40 caracteres

/**
 * BdsmAuth — Identidade deste computador e tokens de pareamento dos celulares.
 *
 *  - `clientId`: uuid gerado uma vez e gravado no arquivo (o celular guarda UM token por clientId).
 *  - Tokens por aparelho, com chave estável "deviceName|deviceModel" (igual por USB e Wi-Fi).
 *  - Em disco o token fica CRIPTOGRAFADO por safeStorage (DPAPI no Windows). Sem criptografia disponível
 *    o token vale só enquanto o app está aberto (nunca é gravado em texto puro).
 *  - O token NUNCA vai para log nem para o renderer: quem fala com o celular é o processo principal.
 *
 * Singleton `bdsmAuth`; sem `init()` funciona só em memória (testes e uso fora do Electron).
 */
class BdsmAuth {
  /**
   * @param {{configDir?:string, safeStorage?:object, hostname?:string, fileName?:string}} [opts]
   */
  constructor(opts = {}) {
    this.filePath = null;
    this.safeStorage = null;
    this.hostname = opts.hostname || null;
    this.fileName = opts.fileName || FILE_NAME;
    this._data = { version: 1, clientId: '', devices: {} };
    this._mem = new Map();        // chave do aparelho -> token em claro (cache da sessão)
    this._endpoints = new Map();  // "ip:porta" -> chave do aparelho
    this._loaded = false;
    if (opts.configDir || opts.safeStorage) this.init(opts);
  }

  /** Define a pasta de configuração e o safeStorage e carrega o arquivo. Pode ser chamado de novo (testes). */
  init({ configDir, safeStorage = null, hostname } = {}) {
    this.filePath = configDir ? path.join(configDir, this.fileName) : null;
    this.safeStorage = safeStorage;
    if (hostname) this.hostname = hostname;
    this._mem.clear();
    this._data = { version: 1, clientId: '', devices: {} };
    this._loaded = false;
    this._load();
    return this;
  }

  _encryptionAvailable() {
    try { return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable()); } catch (_) { return false; }
  }

  _load() {
    if (this._loaded) return;
    this._loaded = true;
    if (this.filePath) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (raw && typeof raw === 'object') {
          if (typeof raw.clientId === 'string') this._data.clientId = raw.clientId;
          if (raw.devices && typeof raw.devices === 'object') {
            for (const [key, v] of Object.entries(raw.devices)) {
              if (v && typeof v === 'object') this._data.devices[key] = { name: String(v.name || ''), pairedAt: Number(v.pairedAt) || 0, tokenEnc: typeof v.tokenEnc === 'string' ? v.tokenEnc : '' };
            }
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') logger.warn('[BdsmAuth] Arquivo de pareamento ilegível; começando vazio.');
      }
    }
    if (!/^[A-Za-z0-9-]{16,64}$/.test(this._data.clientId)) {
      this._data.clientId = crypto.randomUUID();
      this._persist();
    }
  }

  _persist() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      logger.warn(`[BdsmAuth] Não foi possível gravar o arquivo de pareamento: ${err.code || err.message}`);
    }
  }

  /** Identificador estável deste computador para o celular (uuid). */
  get clientId() {
    this._load();
    return this._data.clientId;
  }

  /** Nome amigável mostrado no celular: "Braga Digital Studio - <computador>", até 40 caracteres, sem símbolos estranhos. */
  clientName() {
    let host = this.hostname;
    if (!host) { try { host = os.hostname(); } catch (_) { host = ''; } }
    host = String(host || '').replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim();
    const base = 'Braga Digital Studio';
    return (host ? `${base} - ${host}` : base).slice(0, MAX_CLIENT_NAME).trim();
  }

  static deviceKey(info) { return BdsmProtocol.deviceKey(info); }

  /** Token em claro do aparelho (ou null). */
  getToken(deviceKey) {
    this._load();
    if (!deviceKey) return null;
    if (this._mem.has(deviceKey)) return this._mem.get(deviceKey);
    const entry = this._data.devices[deviceKey];
    if (!entry || !entry.tokenEnc || !this._encryptionAvailable()) return null;
    try {
      const token = this.safeStorage.decryptString(Buffer.from(entry.tokenEnc, 'base64'));
      if (token) { this._mem.set(deviceKey, token); return token; }
    } catch (_) {
      logger.warn('[BdsmAuth] Token guardado não pôde ser lido; será preciso parear de novo.');
    }
    delete this._data.devices[deviceKey];
    this._persist();
    return null;
  }

  isPaired(deviceKey) { return !!this.getToken(deviceKey); }

  /** Guarda o token recebido no pareamento (criptografado em disco quando possível). */
  saveToken(deviceKey, token, { name = '' } = {}) {
    this._load();
    if (!deviceKey || typeof token !== 'string' || !token) throw new Error('Pareamento inválido.');
    this._mem.set(deviceKey, token);
    let tokenEnc = '';
    if (this._encryptionAvailable()) {
      try { tokenEnc = this.safeStorage.encryptString(token).toString('base64'); } catch (_) { tokenEnc = ''; }
    }
    this._data.devices[deviceKey] = { name: String(name || deviceKey.split('|')[0]), pairedAt: Date.now(), tokenEnc };
    this._persist();
  }

  /** Esquece o pareamento deste aparelho (descarta o token). */
  forget(deviceKey) {
    this._load();
    if (!deviceKey) return;
    this._mem.delete(deviceKey);
    if (this._data.devices[deviceKey]) {
      delete this._data.devices[deviceKey];
      this._persist();
    }
  }

  /** Aparelhos pareados, sem tokens. */
  listPaired() {
    this._load();
    return Object.entries(this._data.devices).map(([key, v]) => ({ key, name: v.name, pairedAt: v.pairedAt }));
  }

  // ---- endereço (ip:porta) -> aparelho --------------------------------------------------------

  _ep(ip, port) { return `${ip}:${port || BdsmProtocol.DEFAULT_PORT}`; }

  /** A descoberta registra a que aparelho corresponde cada endereço (USB e Wi-Fi apontam para a mesma chave). */
  rememberEndpoint(ip, port, deviceKey) {
    if (ip && deviceKey) this._endpoints.set(this._ep(ip, port), deviceKey);
  }

  keyForEndpoint(ip, port) { return this._endpoints.get(this._ep(ip, port)) || null; }

  tokenForEndpoint(ip, port) {
    const key = this.keyForEndpoint(ip, port);
    return key ? this.getToken(key) : null;
  }

  /** O celular recusou o token (401): descarta o pareamento do aparelho que atende neste endereço. */
  forgetEndpoint(ip, port) {
    const key = this.keyForEndpoint(ip, port);
    if (key) this.forget(key);
    return key;
  }
}

const bdsmAuth = new BdsmAuth();

module.exports = bdsmAuth;
module.exports.BdsmAuth = BdsmAuth;
module.exports.MAX_CLIENT_NAME = MAX_CLIENT_NAME;
