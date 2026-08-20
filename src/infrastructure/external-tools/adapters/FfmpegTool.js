'use strict';

const { toolResolver } = require('../ToolResolver');
const { toolRunner } = require('../ToolRunner');

/**
 * FfmpegTool — Adapter para o FFmpeg.
 */
class FfmpegTool {
  constructor() {
    this._toolsDir = null;
  }

  setToolsDir(toolsDir) {
    this._toolsDir = toolsDir;
  }

  resolve(opts = {}) {
    if (!this._toolsDir) throw new Error('FfmpegTool: toolsDir não configurado. Inicialize via ExternalToolsManager.');
    return toolResolver.resolve('ffmpeg', this._toolsDir, opts);
  }

  exists() {
    try { this.resolve(); return true; } catch (_) { return false; }
  }

  run(args, opts = {}) {
    const exe = this.resolve();
    return toolRunner.run(exe, args, opts);
  }
}

const ffmpegTool = new FfmpegTool();
module.exports = { FfmpegTool, ffmpegTool };
