'use strict';

/**
 * Configuração do servidor MCP (conexão de agentes de IA externos), guardada em <configDir>/mcp.json:
 *   { enabled:boolean, port:number, token:string, requireToken:boolean, autoConfirm:boolean }
 *
 * - DESLIGADO por padrão: o usuário liga em Configurações → Inteligência Artificial.
 * - O token (aleatório, 256 bits) é a "senha" que o agente precisa enviar. Fica neste arquivo, na pasta do usuário,
 *   e o renderer nunca o recebe: o main copia a configuração pronta para a área de transferência.
 * - A mesma pasta recebe o `mcp-bridge.js` (ponte stdio) para agentes que só falam por linha de comando.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_PORT = 47821;
const FILE = 'mcp.json';
const BRIDGE_FILE = 'mcp-bridge.js';

const newToken = () => crypto.randomBytes(32).toString('hex');
const validPort = (n) => Number.isInteger(n) && n >= 1024 && n <= 65535;

class McpConfig {
  /** @param {{ dir:string }} opts  pasta de configuração do app */
  constructor({ dir }) {
    this.dir = dir;
    this.file = path.join(dir, FILE);
    this.bridgeFile = path.join(dir, BRIDGE_FILE);
    this._data = null;
  }

  load() {
    if (this._data) return this._data;
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { stored = {}; }
    const d = {
      enabled: stored.enabled === true,
      port: validPort(stored.port) ? stored.port : DEFAULT_PORT,
      requireToken: stored.requireToken !== false,
      autoConfirm: stored.autoConfirm === true,
      token: typeof stored.token === 'string' && /^[0-9a-f]{64}$/.test(stored.token) ? stored.token : ''
    };
    this._data = d;
    return d;
  }

  _save() {
    const d = this.load();
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  isEnabled() { return this.load().enabled === true; }
  get port() { return this.load().port; }

  /** Garante que exista um token (gera na primeira vez) e devolve-o. */
  ensureToken() {
    const d = this.load();
    if (!d.token) { d.token = newToken(); this._save(); }
    return d.token;
  }

  getToken() { return this.load().token; }
  requiresToken() { return this.load().requireToken !== false; }
  autoConfirms() { return this.load().autoConfirm === true; }

  /** Opções de segurança (ambas opcionais): sem token e/ou ações sem confirmação. */
  setOptions({ requireToken, autoConfirm } = {}) {
    const d = this.load();
    if (typeof requireToken === 'boolean') d.requireToken = requireToken;
    if (typeof autoConfirm === 'boolean') d.autoConfirm = autoConfirm;
    this._save();
  }

  setEnabled(on) {
    const d = this.load();
    d.enabled = on === true;
    if (d.enabled && !d.token) d.token = newToken();
    this._save();
    return d.enabled;
  }

  /** Porta efetivamente usada (a preferida estava ocupada): vale até o próximo início. */
  setPort(port) {
    const d = this.load();
    if (!validPort(port) || d.port === port) return;
    d.port = port;
    this._save();
  }

  /** Novo token: o agente que usava o anterior perde o acesso. */
  regenerateToken() {
    const d = this.load();
    d.token = newToken();
    this._save();
    return d.token;
  }

  /** Grava a ponte stdio ao lado do mcp.json (o Node comum não lê de dentro do app.asar). Devolve o caminho. */
  writeBridge() {
    const src = fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8');
    fs.mkdirSync(this.dir, { recursive: true });
    let current = null;
    try { current = fs.readFileSync(this.bridgeFile, 'utf8'); } catch (_) { current = null; }
    if (current !== src) fs.writeFileSync(this.bridgeFile, src, 'utf8');
    return this.bridgeFile;
  }
}

module.exports = McpConfig;
module.exports.DEFAULT_PORT = DEFAULT_PORT;
