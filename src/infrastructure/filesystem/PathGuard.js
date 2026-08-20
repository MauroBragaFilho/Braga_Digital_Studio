'use strict';

const path = require('node:path');

/**
 * PathGuard — Validação de segurança para operações de filesystem disparadas via IPC.
 *
 * Regra do roadmap (seções 24 e 51 - Regra 4):
 *   Operações que recebem caminhos do renderer devem validar esses caminhos.
 *   Garante que o caminho pertence ao diretório permitido antes de qualquer escrita/exclusão.
 */
class PathGuard {
  /**
   * Valida se targetPath está contido dentro de baseDir.
   *
   * @param {string} baseDir - Diretório base permitido
   * @param {string} targetPath - Caminho a ser verificado
   * @returns {string} Caminho absoluto normalizado e validado
   * @throws {Error} Se o caminho estiver fora de baseDir ou contiver traversal malicioso
   */
  static assertWithin(baseDir, targetPath) {
    if (!baseDir || !targetPath) {
      throw new Error('PathGuard: baseDir e targetPath são obrigatórios.');
    }

    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(targetPath);

    // Permite o próprio diretório base ou qualquer subcaminho legítimo
    if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
      throw new Error(`Acesso negado: o caminho '${targetPath}' está fora do diretório permitido.`);
    }

    return resolvedTarget;
  }

  /**
   * Verifica se targetPath está contido dentro de baseDir (retorna booleano sem lançar erro).
   *
   * @param {string} baseDir
   * @param {string} targetPath
   * @returns {boolean}
   */
  static isWithin(baseDir, targetPath) {
    try {
      PathGuard.assertWithin(baseDir, targetPath);
      return true;
    } catch (_) {
      return false;
    }
  }
}

module.exports = { PathGuard };
