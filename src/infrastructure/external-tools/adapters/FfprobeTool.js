'use strict';

const { toolResolver } = require('../ToolResolver');
const { toolRunner } = require('../ToolRunner');

/**
 * FfprobeTool — Adapter para o FFprobe.
 */
class FfprobeTool {
  constructor() {
    this._toolsDir = null;
  }

  setToolsDir(toolsDir) {
    this._toolsDir = toolsDir;
  }

  resolve(opts = {}) {
    if (!this._toolsDir) throw new Error('FfprobeTool: toolsDir não configurado. Inicialize via ExternalToolsManager.');
    return toolResolver.resolve('ffprobe', this._toolsDir, opts);
  }

  exists() {
    try { this.resolve(); return true; } catch (_) { return false; }
  }

  async probe(filePath, extraArgs = []) {
    const exe = this.resolve();
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      ...extraArgs,
      filePath,
    ];
    const result = await toolRunner.run(exe, args, { windowsHide: true });
    if (result.code !== 0) {
      throw new Error(`ffprobe finalizou com código ${result.code} para '${filePath}'`);
    }
    return JSON.parse(result.stdout);
  }

  run(args, opts = {}) {
    const exe = this.resolve();
    return toolRunner.run(exe, args, opts);
  }
}

const ffprobeTool = new FfprobeTool();
module.exports = { FfprobeTool, ffprobeTool };
