'use strict';

const { toolResolver } = require('./ToolResolver');
const { ffmpegTool } = require('./adapters/FfmpegTool');
const { ffprobeTool } = require('./adapters/FfprobeTool');
const { ytDlpTool } = require('./adapters/YtDlpTool');
const { spotDlTool } = require('./adapters/SpotDlTool');
const { denoTool } = require('./adapters/DenoTool');

/**
 * ExternalToolsManager — Ponto central de configuração de todas as ferramentas externas.
 */
class ExternalToolsManager {
  constructor() {
    this._toolsDir = null;
    this._initialized = false;
  }

  init(toolsDir) {
    this._toolsDir = toolsDir;
    ffmpegTool.setToolsDir(toolsDir);
    ffprobeTool.setToolsDir(toolsDir);
    ytDlpTool.setToolsDir(toolsDir);
    spotDlTool.setToolsDir(toolsDir);
    denoTool.setToolsDir(toolsDir);
    this._initialized = true;
  }

  get ffmpeg() { return ffmpegTool; }
  get ffprobe() { return ffprobeTool; }
  get ytdlp() { return ytDlpTool; }
  get spotdl() { return spotDlTool; }
  get deno() { return denoTool; }

  checkAll() {
    return {
      ffmpeg:  ffmpegTool.exists(),
      ffprobe: ffprobeTool.exists(),
      ytdlp:   ytDlpTool.exists(),
      spotdl:  spotDlTool.exists(),
      deno:    denoTool.exists(),
    };
  }

  getMissing() {
    const status = this.checkAll();
    return Object.entries(status)
      .filter(([, exists]) => !exists)
      .map(([name]) => name);
  }
}

const externalTools = new ExternalToolsManager();

module.exports = { ExternalToolsManager, externalTools };
