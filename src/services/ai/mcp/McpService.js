'use strict';

/**
 * McpService — junta a configuração (McpConfig), o servidor (McpServer) e a "configuração pronta" que o usuário cola
 * no agente de IA. O token nunca vai ao renderer: `copyConfig` escreve direto na área de transferência do sistema.
 */

const McpConfig = require('./McpConfig');
const McpServer = require('./McpServer');

const NAME = 'braga-digital-studio';
const CLIENT_KINDS = Object.freeze(['antigravity', 'http', 'stdio']);

class McpService {
  /**
   * @param {{ configDir:string, getToolbox:()=>object|null, log?:object, version?:string, clipboard?:{writeText:Function},
   *           nodePath?:string }} deps
   */
  constructor({ configDir, getToolbox, log = null, version = '0.0.0', clipboard = null }) {
    this.config = new McpConfig({ dir: configDir });
    this.log = log || { info() {}, warn() {} };
    this.clipboard = clipboard;
    this.server = new McpServer({ getToolbox, getToken: () => this.config.getToken(), requireToken: () => this.config.requiresToken(), autoConfirm: () => this.config.autoConfirms(), log: this.log, version });
    this.lastError = '';
  }

  /** Início do app: religa o servidor se o usuário o deixou ligado. Nunca derruba a abertura. */
  async init() {
    if (!this.config.isEnabled()) return;
    try { await this._start(); } catch (err) { this._fail(err); }
  }

  async _start() {
    this.config.ensureToken();
    this.config.writeBridge();
    const port = await this.server.start(this.config.port);
    this.config.setPort(port);
    this.lastError = '';
  }

  _fail(err) {
    this.lastError = 'Não foi possível abrir a porta local para os agentes.';
    this.log.warn(`[MCP] falha ao ligar: ${String(err && err.message).slice(0, 120)}`);
  }

  async setEnabled(on) {
    if (on === true) {
      this.config.setEnabled(true);
      try { await this._start(); } catch (err) { this.config.setEnabled(false); this._fail(err); throw new Error(this.lastError); }
    } else {
      this.config.setEnabled(false);
      await this.server.stop();
      this.lastError = '';
    }
    return this.status();
  }

  /** Novo token: quem usava o anterior perde o acesso; é preciso copiar a configuração de novo no agente. */
  regenerateToken() {
    this.config.regenerateToken();
    return this.status();
  }

  /** Opções de segurança opcionais: `requireToken` (false = local aberto) e `autoConfirm` (true = ações sem confirmação). */
  setOptions(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    this.config.setOptions({ requireToken: o.requireToken, autoConfirm: o.autoConfirm });
    return this.status();
  }

  status() {
    const s = this.server.status();
    return {
      enabled: this.config.isEnabled(),
      running: s.running,
      port: s.running ? s.port : this.config.port,
      url: s.running ? `http://127.0.0.1:${s.port}/mcp` : '',
      calls: s.calls,
      client: s.client,
      requireToken: this.config.requiresToken(),
      autoConfirm: this.config.autoConfirms(),
      error: this.lastError
    };
  }

  /** Texto JSON da configuração para o agente. `kind`: antigravity | http | stdio. */
  buildConfig(kind) {
    if (!CLIENT_KINDS.includes(kind)) throw new Error('Formato de agente desconhecido.');
    if (!this.server.running) throw new Error('Ligue "Conectar agentes (MCP)" primeiro.');
    const url = `http://127.0.0.1:${this.server.port}/mcp`;
    const headers = this.config.requiresToken() ? { headers: { Authorization: `Bearer ${this.config.ensureToken()}` } } : {};
    let entry;
    if (kind === 'antigravity') entry = { serverUrl: url, ...headers };
    else if (kind === 'http') entry = { type: 'http', url, ...headers };
    else entry = { command: 'node', args: [this.config.writeBridge(), this.config.file] };
    return JSON.stringify({ mcpServers: { [NAME]: entry } }, null, 2);
  }

  /** Copia a configuração para a área de transferência (o token não passa pelo renderer). */
  copyConfig(kind) {
    const text = this.buildConfig(kind);
    if (!this.clipboard || typeof this.clipboard.writeText !== 'function') throw new Error('A área de transferência não está disponível.');
    this.clipboard.writeText(text);
    return { kind };
  }

  async shutdown() { await this.server.stop(); }
}

module.exports = McpService;
module.exports.CLIENT_KINDS = CLIENT_KINDS;
module.exports.McpConfig = McpConfig;
module.exports.McpServer = McpServer;
