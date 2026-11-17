'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Caminho real (junções e links resolvidos). Se o caminho ainda não existe (ex.: arquivo a ser criado),
 * resolve o ancestral mais próximo que existe e junta o restante.
 */
function realpathOfExisting(p) {
  let current = p;
  const rest = [];
  for (;;) {
    try {
      return rest.length ? path.join(fs.realpathSync.native(current), ...rest.reverse()) : fs.realpathSync.native(current);
    } catch (_) {
      const parent = path.dirname(current);
      if (parent === current) return p;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

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

    // Compara os caminhos REAIS (junções/links resolvidos), para uma junção dentro da pasta não levar para fora.
    // No Windows, o sistema de arquivos não diferencia maiúsculas: a comparação também não.
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const realBase = norm(realpathOfExisting(resolvedBase));
    const realTarget = norm(realpathOfExisting(resolvedTarget));

    // Permite o próprio diretório base ou qualquer subcaminho legítimo
    if (realTarget !== realBase && !realTarget.startsWith(realBase.endsWith(path.sep) ? realBase : realBase + path.sep)) {
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
