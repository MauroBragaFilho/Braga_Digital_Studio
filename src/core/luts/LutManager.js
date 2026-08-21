'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PathGuard } = require('../../infrastructure/filesystem/PathGuard');
const logger = require('../../services/logService');

/**
 * LutManager — Gerenciamento de arquivos e operações com LUTs (.cube).
 */
class LutManager {
  /**
   * @param {string} lutsDir - Diretório onde as LUTs são armazenadas
   */
  constructor(lutsDir) {
    this.lutsDir = lutsDir;
  }

  /**
   * Copia LUTs embutidas no pacote para o diretório gravável de LUTs do usuário.
   * @param {string} bundledLutsDir - Diretório de origem das LUTs embutidas
   */
  ensureBundledLuts(bundledLutsDir) {
    try {
      if (fs.existsSync(bundledLutsDir)) {
        const bundledFiles = fs.readdirSync(bundledLutsDir);
        for (const file of bundledFiles) {
          if (file.endsWith('.cube')) {
            const destFile = path.join(this.lutsDir, file);
            if (!fs.existsSync(destFile)) {
              fs.copyFileSync(path.join(bundledLutsDir, file), destFile);
            }
          }
        }
      }
    } catch (err) {
      logger.error('LutManager:ensureBundledLuts:error', { error: err.message });
    }
  }

  /**
   * Lista todas as LUTs disponíveis no diretório.
   * @returns {Array<{ name: string, path: string, size: number, mtime: Date }>}
   */
  list() {
    try {
      if (!fs.existsSync(this.lutsDir)) return [];
      const files = fs.readdirSync(this.lutsDir);
      const luts = [];
      for (const file of files) {
        if (file.toLowerCase().endsWith('.cube')) {
          const fullPath = path.join(this.lutsDir, file);
          const stats = fs.statSync(fullPath);
          luts.push({
            name: file,
            path: fullPath,
            size: stats.size,
            mtime: stats.mtime
          });
        }
      }
      return luts;
    } catch (err) {
      logger.error('LutManager:list:failed', { error: err.message });
      return [];
    }
  }

  /**
   * Importa arquivos .cube para o diretório de LUTs.
   * @param {string[]} filePaths - Lista de caminhos dos arquivos .cube
   * @returns {boolean}
   */
  importFiles(filePaths) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return false;
    for (const filePath of filePaths) {
      const fileName = path.basename(filePath);
      const destPath = path.join(this.lutsDir, fileName);
      fs.copyFileSync(filePath, destPath);
    }
    return true;
  }

  /**
   * Renomeia uma LUT.
   * @param {string} oldPath - Caminho atual do arquivo
   * @param {string} newName - Novo nome desejado
   * @returns {boolean}
   */
  rename(oldPath, newName) {
    PathGuard.assertWithin(this.lutsDir, oldPath);
    if (!fs.existsSync(oldPath)) return false;

    let finalName = newName;
    if (!finalName.toLowerCase().endsWith('.cube')) {
      finalName += '.cube';
    }

    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, finalName);
    PathGuard.assertWithin(this.lutsDir, newPath);

    if (fs.existsSync(newPath)) {
      throw new Error('Já existe um arquivo com esse nome.');
    }

    fs.renameSync(oldPath, newPath);
    return true;
  }

  /**
   * Remove uma LUT do disco com proteção de caminho.
   * @param {string} filePath - Caminho do arquivo a remover
   * @returns {boolean}
   */
  delete(filePath) {
    PathGuard.assertWithin(this.lutsDir, filePath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }
}

module.exports = LutManager;
