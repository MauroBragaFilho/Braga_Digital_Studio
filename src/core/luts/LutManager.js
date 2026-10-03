'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PathGuard } = require('../../infrastructure/filesystem/PathGuard');
const CubeParser = require('./CubeParser');
const logger = require('../../services/logService');

/** Arquivo (não-.cube) que registra quais LUTs embutidas já foram instaladas, para não recriar as que o usuário excluiu. */
const BUNDLED_MARKER = '.bundled-installed.json';
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * LutManager — Gerenciamento de arquivos e operações com LUTs (.cube).
 */
class LutManager {
  /**
   * @param {string} lutsDir - Diretório onde as LUTs são armazenadas
   */
  constructor(lutsDir) {
    this.lutsDir = lutsDir;
    this._idCache = new Map(); // caminho -> { key: 'tamanho:mtime', id }
  }

  /**
   * Copia LUTs embutidas no pacote para o diretório gravável de LUTs do usuário.
   * Cada LUT embutida é instalada uma única vez: se o usuário a excluir, ela não volta.
   * @param {string} bundledLutsDir - Diretório de origem das LUTs embutidas
   */
  ensureBundledLuts(bundledLutsDir) {
    try {
      if (!fs.existsSync(bundledLutsDir)) return;
      fs.mkdirSync(this.lutsDir, { recursive: true });

      const markerPath = path.join(this.lutsDir, BUNDLED_MARKER);
      let installed = [];
      try { installed = JSON.parse(fs.readFileSync(markerPath, 'utf-8')); } catch { /* primeira execução */ }
      if (!Array.isArray(installed)) installed = [];
      const done = new Set(installed);
      let changed = false;
      for (const file of fs.readdirSync(bundledLutsDir)) {
        if (!file.toLowerCase().endsWith('.cube') || done.has(file)) continue;
        const destFile = path.join(this.lutsDir, file);
        if (!fs.existsSync(destFile)) fs.copyFileSync(path.join(bundledLutsDir, file), destFile);
        done.add(file);
        changed = true;
      }
      if (changed) fs.writeFileSync(markerPath, JSON.stringify([...done]), 'utf-8');
    } catch (err) {
      logger.error('LutManager:ensureBundledLuts:error', { error: err.message });
    }
  }

  /** Identificador estável do conteúdo (não muda ao renomear/mover o arquivo). Em cache por tamanho+data. */
  _contentId(fullPath, stats) {
    const key = `${stats.size}:${stats.mtimeMs}`;
    const hit = this._idCache.get(fullPath);
    if (hit && hit.key === key) return hit.id;
    let id = null;
    try {
      id = crypto.createHash('sha1').update(fs.readFileSync(fullPath)).digest('hex').slice(0, 16);
    } catch (err) {
      logger.warn?.('LutManager:contentId:failed', { error: err.message });
    }
    this._idCache.set(fullPath, { key, id });
    return id;
  }

  /**
   * Lista todas as LUTs disponíveis no diretório.
   * @returns {Array<{ id: string, name: string, path: string, size: number, mtime: Date, modifiedAt: number }>}
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
            id: this._contentId(fullPath, stats),
            name: file,
            path: fullPath,
            size: stats.size,
            mtime: stats.mtime,
            modifiedAt: stats.mtimeMs // a tela de LUTs ordena e exibe a data por este campo
          });
        }
      }
      return luts;
    } catch (err) {
      logger.error('LutManager:list:failed', { error: err.message });
      return [];
    }
  }

  /** Verifica se o arquivo é um .cube utilizável. Retorna o motivo da recusa ou null se estiver ok. */
  _validate(filePath) {
    try {
      if (path.extname(filePath).toLowerCase() !== '.cube') return 'não é um arquivo .cube';
      if (!fs.statSync(filePath).isFile()) return 'não é um arquivo';
      const header = CubeParser.parseHeader(filePath);
      if (!header.size || header.size < 2) return 'cabeçalho sem LUT_3D_SIZE/LUT_1D_SIZE';
      const expected = header.is1D ? header.size : header.size ** 3;
      if (header.totalEntries < expected) return `tabela incompleta (${header.totalEntries} de ${expected} linhas)`;
      return null;
    } catch (err) {
      return `não foi possível ler (${err.message})`;
    }
  }

  /** Nome livre na pasta: "Nome.cube" → "Nome (2).cube" → "Nome (3).cube"… */
  _uniqueName(fileName) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    let candidate = fileName;
    for (let n = 2; fs.existsSync(path.join(this.lutsDir, candidate)); n++) candidate = `${base} (${n})${ext}`;
    return candidate;
  }

  /**
   * Importa arquivos .cube para o diretório de LUTs sem sobrescrever nada.
   * - arquivo inválido é recusado; conteúdo idêntico a uma LUT já existente é ignorado;
   * - nome repetido com conteúdo diferente ganha sufixo " (2)".
   * @param {string[]} filePaths - Lista de caminhos dos arquivos .cube
   * @returns {{ imported: Array<{name:string,path:string}>, renamed: Array<{from:string,to:string}>, duplicates: string[], invalid: Array<{name:string,reason:string}> } | false}
   */
  importFiles(filePaths) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return false;
    fs.mkdirSync(this.lutsDir, { recursive: true });

    const result = { imported: [], renamed: [], duplicates: [], invalid: [] };
    const known = new Set(this.list().map((l) => l.id).filter(Boolean));

    for (const filePath of filePaths) {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) continue;
      const fileName = path.basename(filePath);
      const reason = this._validate(filePath);
      if (reason) { result.invalid.push({ name: fileName, reason }); continue; }

      const id = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex').slice(0, 16);
      if (known.has(id)) { result.duplicates.push(fileName); continue; }

      const finalName = this._uniqueName(fileName);
      const destPath = path.join(this.lutsDir, finalName);
      fs.copyFileSync(filePath, destPath);
      known.add(id);
      result.imported.push({ name: finalName, path: destPath });
      if (finalName !== fileName) result.renamed.push({ from: fileName, to: finalName });
    }
    return result;
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

    const base = String(newName ?? '')
      .replace(/\.cube$/i, '')
      .replace(INVALID_NAME_CHARS, '')
      .trim()
      .replace(/[. ]+$/, '');
    if (!base) throw new Error('Informe um nome válido (sem os caracteres \\ / : * ? " < > |).');
    const finalName = `${base}.cube`;

    const newPath = path.join(path.dirname(oldPath), finalName);
    PathGuard.assertWithin(this.lutsDir, newPath);
    if (newPath === oldPath) return true;

    // Só muda a caixa das letras (Windows considera o mesmo arquivo): permitido.
    if (fs.existsSync(newPath) && newPath.toLowerCase() !== oldPath.toLowerCase()) {
      throw new Error('Já existe um arquivo com esse nome.');
    }

    fs.renameSync(oldPath, newPath);
    this._idCache.delete(oldPath);
    return true;
  }

  /**
   * Remove uma LUT com proteção de caminho. Com `trash`, vai para a lixeira (recuperável).
   * @param {string} filePath - Caminho do arquivo a remover
   * @param {(p: string) => Promise<void>} [trash] - Ex.: shell.trashItem
   * @returns {Promise<boolean>}
   */
  async delete(filePath, trash) {
    PathGuard.assertWithin(this.lutsDir, filePath);
    if (!fs.existsSync(filePath)) return false;
    if (typeof trash === 'function') await trash(filePath);
    else fs.unlinkSync(filePath);
    this._idCache.delete(filePath);
    return true;
  }
}

module.exports = LutManager;
