'use strict';

const { toolResolver } = require('../ToolResolver');
const { toolRunner } = require('../ToolRunner');

/**
 * SpotDlTool — Adapter para o spotDL (spotify-dlp).
 */
class SpotDlTool {
  constructor() {
    this._toolsDir = null;
  }

  setToolsDir(toolsDir) {
    this._toolsDir = toolsDir;
  }

  resolve(opts = {}) {
    if (!this._toolsDir) throw new Error('SpotDlTool: toolsDir não configurado. Inicialize via ExternalToolsManager.');
    return toolResolver.resolve('spotdl', this._toolsDir, opts);
  }

  exists() {
    try { this.resolve(); return true; } catch (_) { return false; }
  }

  run(args, opts = {}) {
    const exe = this.resolve();
    return toolRunner.run(exe, args, { windowsHide: true, ...opts });
  }
}

const spotDlTool = new SpotDlTool();
module.exports = { SpotDlTool, spotDlTool };
