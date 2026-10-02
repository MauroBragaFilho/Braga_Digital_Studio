'use strict';

/**
 * AIService — Camada única de IA do BDS.
 *
 * Responsabilidades:
 *   - Guardar a configuração (provedor, modelos, URL local) em config/ai.json.
 *   - Guardar a chave de API CRIPTOGRAFADA (Electron safeStorage). A chave nunca é
 *     devolvida ao renderer: a interface só sabe se existe (`hasKey`).
 *   - Falar com a API da OpenAI ou com qualquer servidor compatível (URL configurável).
 *   - Executar tarefas registradas em tasks.js (transcrição, tags... futuras).
 *
 * Para plugar um provedor com API diferente: crie uma classe com { listModels(),
 * testConnection(), chat() } e devolva-a em _buildProvider().
 */

const fs = require('node:fs');
const path = require('node:path');
const OpenAIProvider = require('./providers/OpenAIProvider');
const tasks = require('./tasks');

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 20000;

const SYSTEM_PROMPT = [
  'Você é o assistente do Braga Digital Studio (BDS), um aplicativo desktop para organizar,',
  'baixar, converter, montar e editar metadados de vídeos, áudios e fotos.',
  'Responda sempre em português do Brasil, de forma objetiva e prática.',
  'Se faltar informação para ajudar, pergunte. Não invente funções do aplicativo que você não conhece.'
].join(' ');

/** Atalhos de servidor para a interface (a URL continua editável). */
const SERVER_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: OpenAIProvider.defaultBaseUrl },
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1' },
  { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1' },
  { id: 'custom', label: 'Personalizado', baseUrl: '' }
];

const DEFAULT_CONFIG = {
  baseUrl: OpenAIProvider.defaultBaseUrl,
  apiKeyEnc: '',
  model: 'gpt-4o-mini',
  maxTokens: 1024,
  customInstructions: ''
};

class AIService {
  /**
   * @param {{configDir:string, safeStorage?:object, fetchImpl?:Function}} opts
   */
  constructor({ configDir, safeStorage = null, fetchImpl = undefined }) {
    if (!configDir) throw new Error('AIService: configDir é obrigatório.');
    this.filePath = path.join(configDir, 'ai.json');
    this.safeStorage = safeStorage;
    this._fetch = fetchImpl;
    this._config = null;
  }

  // ------------------------------------------------------------------ config

  _load() {
    if (this._config) return this._config;
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (_) { /* primeira execução */ }
    this._config = { ...DEFAULT_CONFIG, ...(stored && typeof stored === 'object' ? stored : {}) };
    return this._config;
  }

  _persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._config, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  _encryptionAvailable() {
    try { return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable()); }
    catch (_) { return false; }
  }

  _readApiKey() {
    const enc = this._load().apiKeyEnc;
    if (!enc || !this._encryptionAvailable()) return '';
    try { return this.safeStorage.decryptString(Buffer.from(enc, 'base64')); }
    catch (_) { return ''; }
  }

  /** Configuração segura para o renderer (sem a chave). */
  getPublicConfig() {
    const c = this._load();
    return {
      baseUrl: c.baseUrl,
      model: c.model,
      maxTokens: c.maxTokens,
      customInstructions: c.customInstructions,
      hasKey: !!c.apiKeyEnc,
      encryptionAvailable: this._encryptionAvailable(),
      isOfficialOpenAI: OpenAIProvider.isOfficialOpenAI(c.baseUrl),
      presets: SERVER_PRESETS,
      tasks: tasks.list()
    };
  }

  /** Aplica um patch validado. `apiKey` grava; `clearApiKey: true` remove. */
  saveConfig(patch = {}) {
    const c = this._load();
    const str = (v, max) => String(v ?? '').trim().slice(0, max);

    if (patch.baseUrl !== undefined) c.baseUrl = OpenAIProvider.normalizeBaseUrl(patch.baseUrl);
    if (patch.model !== undefined) c.model = str(patch.model, 120);
    if (patch.maxTokens !== undefined) {
      const n = Math.round(Number(patch.maxTokens));
      if (!Number.isFinite(n) || n < 64 || n > 8192) throw new Error('Máximo de tokens deve estar entre 64 e 8192.');
      c.maxTokens = n;
    }
    if (patch.customInstructions !== undefined) c.customInstructions = str(patch.customInstructions, 2000);

    if (patch.clearApiKey) c.apiKeyEnc = '';
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      if (!this._encryptionAvailable()) {
        throw new Error('A criptografia do sistema não está disponível; a chave não pode ser guardada com segurança.');
      }
      const key = patch.apiKey.trim();
      if (key.length < 8 || key.length > 300 || /\s/.test(key)) throw new Error('Chave de API com formato inválido.');
      c.apiKeyEnc = this.safeStorage.encryptString(key).toString('base64');
    }

    this._persist();
    return this.getPublicConfig();
  }

  // --------------------------------------------------------------- provedores

  _buildProvider() {
    return new OpenAIProvider({
      getBaseUrl: () => this._load().baseUrl,
      getApiKey: () => this._readApiKey(),
      fetchImpl: this._fetch
    });
  }

  async testConnection() { return this._buildProvider().testConnection(); }

  async listModels() { return this._buildProvider().listModels(); }

  // --------------------------------------------------------------------- chat

  _sanitizeMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('Nenhuma mensagem para enviar.');
    if (messages.length > MAX_MESSAGES) throw new Error(`Conversa longa demais (máximo ${MAX_MESSAGES} mensagens).`);
    const clean = messages.map(m => {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
        throw new Error('Mensagem inválida.');
      }
      const content = m.content.trim();
      if (!content) throw new Error('Mensagem vazia.');
      if (content.length > MAX_MESSAGE_CHARS) throw new Error(`Mensagem longa demais (máximo ${MAX_MESSAGE_CHARS} caracteres).`);
      return { role: m.role, content };
    });
    if (clean[0].role !== 'user') throw new Error('A conversa deve começar com uma mensagem do usuário.');
    if (clean[clean.length - 1].role !== 'user') throw new Error('A última mensagem deve ser do usuário.');
    return clean;
  }

  _systemPrompt() {
    const extra = this._load().customInstructions;
    return extra ? `${SYSTEM_PROMPT}\n\nInstruções do usuário:\n${extra}` : SYSTEM_PROMPT;
  }

  /** Envia a conversa ao provedor ativo. */
  async chat({ messages, system } = {}) {
    const clean = this._sanitizeMessages(messages);
    const model = this._load().model;
    if (!model) throw new Error('Nenhum modelo definido. Informe um modelo nas configurações da IA.');
    return this._buildProvider().chat({
      model,
      system: system || this._systemPrompt(),
      messages: clean,
      maxTokens: this._load().maxTokens
    });
  }

  // ------------------------------------------------------------------ tarefas

  listTasks() { return tasks.list(); }

  async runTask(name, payload) {
    const task = tasks.get(name);
    if (!task) throw new Error('Tarefa desconhecida.');
    return task.run(payload, { chat: (args) => this.chat(args) });
  }
}

module.exports = AIService;
