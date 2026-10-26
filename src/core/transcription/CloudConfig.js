'use strict';

/**
 * CloudConfig — configuração da transcrição na nuvem (Groq e ElevenLabs). Fica SEPARADA do assistente de IA: arquivo
 * próprio (config/transcricao-nuvem.json) e uma chave por provedor, guardada CRIPTOGRAFADA (Electron safeStorage).
 * A chave nunca volta para a interface: só `hasKey`. Os endereços dos provedores são fixos (não há campo de URL, então
 * a chave não vai para outro servidor).
 */

const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS = Object.freeze({
  groq: Object.freeze({
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: Object.freeze([
      { id: 'whisper-large-v3-turbo', label: 'Turbo', hint: 'Mais rápido e mais barato' },
      { id: 'whisper-large-v3', label: 'Completo', hint: 'Mais preciso' }
    ]),
    keyPattern: /^[A-Za-z0-9_-]{20,200}$/,
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    testPath: '/models'
  }),
  elevenlabs: Object.freeze({
    id: 'elevenlabs',
    label: 'ElevenLabs',
    baseUrl: 'https://api.elevenlabs.io/v1',
    models: Object.freeze([{ id: 'scribe_v2', label: 'Scribe v2', hint: 'Transcrição da ElevenLabs' }]),
    keyPattern: /^[A-Za-z0-9_-]{16,200}$/,
    authHeaders: (key) => ({ 'xi-api-key': key }),
    testPath: '/models'
  })
});
const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

class CloudConfigError extends Error {
  constructor(message, code) { super(message); this.name = 'CloudConfigError'; this.code = code; }
}

function providerOf(id) {
  const p = PROVIDERS[id];
  if (!p) throw new CloudConfigError('Serviço de transcrição desconhecido.', 'BAD_PROVIDER');
  return p;
}

class CloudConfig {
  /** @param {{configDir:string, safeStorage?:object, fetchImpl?:Function}} opts */
  constructor({ configDir, safeStorage = null, fetchImpl = globalThis.fetch }) {
    this.filePath = path.join(configDir, 'transcricao-nuvem.json');
    this.safeStorage = safeStorage;
    this.fetch = fetchImpl;
  }

  _load() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) || {}; } catch (_) { raw = {}; }
    const saved = raw.providers && typeof raw.providers === 'object' ? raw.providers : {};
    const out = {};
    for (const id of PROVIDER_IDS) {
      const s = saved[id] && typeof saved[id] === 'object' ? saved[id] : {};
      out[id] = {
        apiKeyEnc: typeof s.apiKeyEnc === 'string' ? s.apiKeyEnc : '',
        model: PROVIDERS[id].models.some((m) => m.id === s.model) ? s.model : PROVIDERS[id].models[0].id
      };
    }
    return out;
  }

  _persist(providers) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ providers }, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  _encryptionAvailable() {
    try { return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable()); } catch (_) { return false; }
  }

  /** Chave descriptografada: só para uso no processo principal. '' quando não há chave (ou não dá para ler). */
  readKey(provider) {
    providerOf(provider);
    const { apiKeyEnc } = this._load()[provider];
    if (!apiKeyEnc || !this._encryptionAvailable()) return '';
    try { return this.safeStorage.decryptString(Buffer.from(apiKeyEnc, 'base64')); } catch (_) { return ''; }
  }

  getModel(provider) { providerOf(provider); return this._load()[provider].model; }

  /** O que a interface pode ver (nunca a chave). */
  getPublic() {
    const saved = this._load();
    return {
      encryptionAvailable: this._encryptionAvailable(),
      providers: PROVIDER_IDS.map((id) => ({
        id,
        label: PROVIDERS[id].label,
        hasKey: Boolean(saved[id].apiKeyEnc) && this.readKey(id) !== '',
        model: saved[id].model,
        models: PROVIDERS[id].models.map((m) => ({ ...m }))
      }))
    };
  }

  /** @param {{provider:string, apiKey?:string, clearApiKey?:boolean, model?:string}} patch */
  set(patch = {}) {
    const p = providerOf(patch.provider);
    const all = this._load();
    const next = all[p.id];
    if (patch.clearApiKey === true) next.apiKeyEnc = '';
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      const key = patch.apiKey.trim();
      if (!p.keyPattern.test(key)) throw new CloudConfigError(`A chave do ${p.label} parece inválida. Cole a chave inteira, sem espaços.`, 'BAD_KEY');
      if (!this._encryptionAvailable()) throw new CloudConfigError('O armazenamento seguro do sistema não está disponível; a chave não pode ser guardada com segurança.', 'NO_ENCRYPTION');
      next.apiKeyEnc = this.safeStorage.encryptString(key).toString('base64');
    }
    if (patch.model !== undefined) {
      if (!p.models.some((m) => m.id === patch.model)) throw new CloudConfigError('Modelo desconhecido.', 'BAD_MODEL');
      next.model = patch.model;
    }
    this._persist(all);
    return this.getPublic();
  }

  /** Confere a chave salva consultando a lista de modelos do provedor (não gasta o limite de transcrição). */
  async test(provider) {
    const p = providerOf(provider);
    const key = this.readKey(p.id);
    if (!key) throw new CloudConfigError(`Informe a chave do ${p.label} primeiro.`, 'NO_KEY');
    let res;
    try {
      res = await this.fetch(`${p.baseUrl}${p.testPath}`, { headers: p.authHeaders(key), signal: AbortSignal.timeout(15000) });
    } catch (_) {
      throw new CloudConfigError(`Não foi possível falar com o ${p.label}. Verifique a conexão com a internet.`, 'NETWORK');
    }
    if (res.status === 401 || res.status === 403) {
      // Chave restrita da ElevenLabs (só "Speech to Text"): a consulta de modelos é negada por permissão, mas a chave vale.
      let body = null;
      try { body = await res.json(); } catch (_) { /* sem corpo */ }
      const status = body && body.detail && body.detail.status;
      if (p.id === 'elevenlabs' && status === 'missing_permissions') return { ok: true, limited: true };
      throw new CloudConfigError(`O ${p.label} recusou a chave. Confira se ela está correta e ativa.`, 'CLOUD_AUTH');
    }
    if (!res.ok) throw new CloudConfigError(`O ${p.label} respondeu com erro (${res.status}). Tente de novo em instantes.`, 'CLOUD_HTTP');
    return { ok: true };
  }
}

module.exports = { CloudConfig, CloudConfigError, PROVIDERS, PROVIDER_IDS };
