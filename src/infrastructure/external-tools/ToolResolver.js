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
   * @param {boolean} [opts.allowSystemPath=true] - Se não encontrado em toolsDir, procura
   *   também no PATH do sistema operacional (útil em Linux, onde muitas ferramentas já vêm
   *   instaladas via gerenciador de pacotes, ex: `apt install libimage-exiftool-perl`).
   *   A cópia gerenciada pelo BDS em toolsDir sempre tem prioridade quando existe.
   * @returns {string} Caminho absoluto para o executável
   */
  resolve(toolKey, toolsDir, { mustExist = true, allowSystemPath = true } = {}) {
    const exeName = getExecutableName(toolKey);
    const fullPath = path.join(toolsDir, exeName);

    if (fs.existsSync(fullPath)) {
      return fullPath;
    }

    if (allowSystemPath) {
      const systemPath = this._resolveFromSystemPath(exeName);
      if (systemPath) return systemPath;
    }

    if (mustExist) {
      throw new Error(
        `${exeName} não encontrado em '${toolsDir}' nem no PATH do sistema. ` +
        `Use o sistema de atualização do BDS para instalar a ferramenta.`
      );
    }

    return fullPath;
  }

  /**
   * Procura um executável nos diretórios do PATH do sistema operacional.
   * @param {string} exeName
   * @returns {string|null}
   */
  _resolveFromSystemPath(exeName) {
    const pathEnv = process.env.PATH || process.env.Path || '';
    const dirs = pathEnv.split(path.delimiter).filter(Boolean);

    for (const dir of dirs) {
      const candidate = path.join(dir, exeName);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch (_) {
        // Diretório inacessível ou inválido — ignora e continua.
      }
    }
    return null;
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
