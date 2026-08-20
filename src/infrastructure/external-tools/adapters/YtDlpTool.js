'use strict';

const { toolResolver } = require('../ToolResolver');
const { toolRunner } = require('../ToolRunner');

/**
 * YtDlpTool — Adapter para o yt-dlp.
 */
class YtDlpTool {
  constructor() {
    this._toolsDir = null;
  }

  setToolsDir(toolsDir) {
    this._toolsDir = toolsDir;
  }

  resolve(opts = {}) {
    if (!this._toolsDir) throw new Error('YtDlpTool: toolsDir não configurado. Inicialize via ExternalToolsManager.');
    return toolResolver.resolve('ytdlp', this._toolsDir, opts);
  }

  exists() {
    try { this.resolve(); return true; } catch (_) { return false; }
  }

  run(args, opts = {}) {
    const exe = this.resolve();
    const env = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    return toolRunner.run(exe, args, { windowsHide: true, env, ...opts });
  }

  /**
   * Self-update nativo do yt-dlp (binário standalone).
   * Muito mais simples e confiável que baixar/substituir manualmente via GitHub API:
   * o próprio yt-dlp resolve a versão certa pro SO/arquitetura e valida o pacote.
   *
   * @param {'stable'|'nightly'} [channel='stable']
   * @returns {Promise<{code:number, stdout:string, stderr:string}>}
   */
  async selfUpdate(channel = 'stable') {
    const args = channel === 'stable' ? ['-U'] : ['--update-to', channel];
    const result = await this.run(args);
    if (result.code !== 0) {
      throw new Error(`yt-dlp self-update falhou (código ${result.code}): ${result.stderr || result.stdout}`);
    }
    return result;
  }
}

const ytDlpTool = new YtDlpTool();
module.exports = { YtDlpTool, ytDlpTool };
