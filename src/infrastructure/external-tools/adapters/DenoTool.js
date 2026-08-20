'use strict';

const { toolResolver } = require('../ToolResolver');
const { toolRunner } = require('../ToolRunner');

/**
 * DenoTool — Adapter para o runtime Deno.
 *
 * O BDS não usa uma instalação global de Deno no sistema do usuário: o binário
 * é baixado como qualquer outra ferramenta externa (ver ToolManifest/ToolUpdater)
 * e vive isolado dentro de AppPaths.tools, resolvido via ToolResolver como
 * ffmpeg/ffprobe/yt-dlp/spotdl. Nenhum instalador é executado e o PATH do
 * sistema não é tocado.
 */
class DenoTool {
  constructor() {
    this._toolsDir = null;
  }

  setToolsDir(toolsDir) {
    this._toolsDir = toolsDir;
  }

  resolve(opts = {}) {
    if (!this._toolsDir) throw new Error('DenoTool: toolsDir não configurado. Inicialize via ExternalToolsManager.');
    return toolResolver.resolve('deno', this._toolsDir, opts);
  }

  exists() {
    try { this.resolve(); return true; } catch (_) { return false; }
  }

  run(args, opts = {}) {
    const exe = this.resolve();
    return toolRunner.run(exe, args, { windowsHide: true, ...opts });
  }
}

const denoTool = new DenoTool();
module.exports = { DenoTool, denoTool };
