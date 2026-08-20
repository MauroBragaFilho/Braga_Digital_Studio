'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { getExecutableName } = require('./ToolManifest');

/**
 * ToolResolver — Resolve o caminho absoluto de um executável externo.
 */
class ToolResolver {
  /**
   * Resolve o caminho absoluto de uma ferramenta.
   *
   * @param {string} toolKey - Chave da ferramenta ('ffmpeg', 'ffprobe', 'ytdlp', 'spotdl')
   * @param {string} toolsDir - Diretório onde os executáveis estão armazenados
   * @param {object} [opts]
   * @param {boolean} [opts.mustExist=true] - Lançar erro se o arquivo não existir
   * @returns {string} Caminho absoluto para o executável
   */
  resolve(toolKey, toolsDir, { mustExist = true } = {}) {
    const exeName = getExecutableName(toolKey);
    const fullPath = path.join(toolsDir, exeName);

    if (mustExist && !fs.existsSync(fullPath)) {
      throw new Error(
        `${exeName} não encontrado em '${toolsDir}'. ` +
        `Use o sistema de atualização do BDS para instalar a ferramenta.`
      );
    }

    return fullPath;
  }

  /**
   * Verifica se uma ferramenta está instalada.
   *
   * @param {string} toolKey
   * @param {string} toolsDir
   * @returns {boolean}
   */
  exists(toolKey, toolsDir) {
    try {
      this.resolve(toolKey, toolsDir, { mustExist: true });
      return true;
    } catch (_) {
      return false;
    }
  }
}

const toolResolver = new ToolResolver();

module.exports = { ToolResolver, toolResolver };
