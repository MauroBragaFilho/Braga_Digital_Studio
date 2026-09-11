'use strict';

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../services/logService');

/**
 * CacheService — Gerenciamento de cache do BDS.
 *
 *  - Cálculo de tamanho de cada categoria (Thumbnails, Waveforms, Temp)
 *  - Limpeza total ou por categoria
 *  - Limpeza automática no startup quando o cache excede o limite
 *  - Exclusão dos itens mais antigos primeiro (LRU)
 */
class CacheService {
  /**
   * @param {Object} appPaths
   * @param {Object} [options]
   * @param {number} [options.maxSizeMB=500]
   * @param {boolean} [options.autoClean=false]
   */
  constructor(appPaths, options = {}) {
    this.appPaths = appPaths;
    this.maxSizeMB = options.maxSizeMB || 500;
    this.autoClean = options.autoClean || false;
    this.categories = [
      { key: 'thumbnails', dir: appPaths.thumbnailsDir, label: 'Thumbnails' },
      { key: 'waveforms',  dir: appPaths.waveformsDir,  label: 'Waveforms' },
      { key: 'temp',       dir: appPaths.tempDir,       label: 'Arquivos Temporários',
        extraDirs: appPaths.dataDir ? [path.join(appPaths.dataDir, 'temp')] : [] },
    ];
  }

  /* ─── Tamanho ──────────────────────────────────────────────────────── */

  _dirSize(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    try {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          total += this._dirSize(full);
        } else {
          try { total += fs.statSync(full).size; } catch (_) {}
        }
      }
    } catch (_) {}
    return total;
  }

  getCacheInfo() {
    const categories = this.categories.map(cat => {
      let sizeBytes = this._dirSize(cat.dir);
      for (const extra of (cat.extraDirs || [])) sizeBytes += this._dirSize(extra);
      return {
        key: cat.key, label: cat.label, path: cat.dir,
        sizeBytes, sizeFormatted: this._formatBytes(sizeBytes),
      };
    });
    const totalBytes = categories.reduce((a, c) => a + c.sizeBytes, 0);
    return {
      categories, totalBytes, totalFormatted: this._formatBytes(totalBytes),
      maxSizeMB: this.maxSizeMB, autoClean: this.autoClean,
    };
  }

  /* ─── Limpeza ──────────────────────────────────────────────────────── */

  _clearDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) return { filesRemoved: 0, bytesFreed: 0 };
    let filesRemoved = 0, bytesFreed = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          try { if (fs.readdirSync(full).length === 0) fs.rmdirSync(full); } catch (_) {}
        } else {
          try { const s = fs.statSync(full); fs.unlinkSync(full); filesRemoved++; bytesFreed += s.size; } catch (_) {}
        }
      }
    };
    walk(dirPath);
    return { filesRemoved, bytesFreed };
  }

  clearCache(categoryKey = null) {
    const targets = categoryKey
      ? this.categories.filter(c => c.key === categoryKey)
      : this.categories;
    const cleared = [];
    let totalBytesFreed = 0;
    for (const cat of targets) {
      let totalR = { filesRemoved: 0, bytesFreed: 0 };
      for (const dir of [cat.dir, ...(cat.extraDirs || [])]) {
        const r = this._clearDirectory(dir);
        totalR.filesRemoved += r.filesRemoved;
        totalR.bytesFreed += r.bytesFreed;
      }
      cleared.push({ key: cat.key, ...totalR });
      totalBytesFreed += totalR.bytesFreed;
      logger.info(`[CacheService] Limpou ${cat.label}: ${totalR.filesRemoved} arquivos, ${this._formatBytes(totalR.bytesFreed)}`);
    }
    return { cleared, totalBytesFreed, totalFormatted: this._formatBytes(totalBytesFreed) };
  }

  /* ─── Auto-limpeza (LRU) ───────────────────────────────────────────── */

  _trimByOldest(dirPath, targetBytes) {
    if (!fs.existsSync(dirPath)) return { filesRemoved: 0, bytesFreed: 0 };
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); }
        else {
          try { const s = fs.statSync(full); files.push({ path: full, size: s.size, mtime: s.mtimeMs }); } catch (_) {}
        }
      }
    };
    walk(dirPath);
    files.sort((a, b) => a.mtime - b.mtime);
    let filesRemoved = 0, bytesFreed = 0;
    for (const f of files) {
      if (bytesFreed >= targetBytes) break;
      try { fs.unlinkSync(f.path); filesRemoved++; bytesFreed += f.size; } catch (_) {}
    }
    return { filesRemoved, bytesFreed };
  }

  autoCleanIfNeeded() {
    if (!this.autoClean || this.maxSizeMB <= 0) return { trimmed: false };
    const info = this.getCacheInfo();
    const maxBytes = this.maxSizeMB * 1024 * 1024;
    if (info.totalBytes <= maxBytes) return { trimmed: false };
    const excess = info.totalBytes - maxBytes;
    logger.info(`[CacheService] Auto-limpeza: cache (${info.totalFormatted}) excede limite (${this.maxSizeMB} MB). Removendo ${this._formatBytes(excess)}...`);
    const details = [];
    let totalBytesFreed = 0;
    for (const catInfo of info.categories) {
      if (catInfo.sizeBytes === 0) continue;
      // Descobre as pastas reais da categoria (inclui extras como o 'temp' minúsculo)
      const catDef = this.categories.find(c => c.key === catInfo.key) || {};
      const dirs = [catDef.dir, ...(catDef.extraDirs || [])].filter(Boolean);
      const proportion = catInfo.sizeBytes / info.totalBytes;
      const target = Math.ceil(excess * proportion);
      let totalR = { filesRemoved: 0, bytesFreed: 0 };
      for (const dir of dirs) {
        const r = this._trimByOldest(dir, target - totalR.bytesFreed);
        totalR.filesRemoved += r.filesRemoved;
        totalR.bytesFreed += r.bytesFreed;
      }
      details.push({ key: catInfo.key, ...totalR });
      totalBytesFreed += totalR.bytesFreed;
    }
    return { trimmed: true, details, totalBytesFreed, totalFormatted: this._formatBytes(totalBytesFreed) };
  }

  /* ─── Config ───────────────────────────────────────────────────────── */

  updateSettings(opts) {
    if (typeof opts.maxSizeMB === 'number' && opts.maxSizeMB >= 0) this.maxSizeMB = opts.maxSizeMB;
    if (typeof opts.autoClean === 'boolean') this.autoClean = opts.autoClean;
  }

  /**
   * [PERF] Remove arquivos temporários mais antigos que maxAgeMs.
   * Chamado no startup para evitar que arquivos temporários de execuções
   * anteriores acumulem em disco indefinidamente.
   * @param {number} [maxAgeMs=3600000] - Idade máxima em ms (padrão: 1h)
   * @returns {{ filesRemoved: number, bytesFreed: number }}
   */
  cleanStaleTempFiles(maxAgeMs = 3600000) {
    const cutoff = Date.now() - maxAgeMs;
    let filesRemoved = 0, bytesFreed = 0;

    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            try {
              if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
            } catch (_) {}
          } else {
            try {
              const s = fs.statSync(full);
              if (s.mtimeMs < cutoff) {
                fs.unlinkSync(full);
                filesRemoved++;
                bytesFreed += s.size;
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    };

    // [FIX] Apenas limpar a pasta de temporários — NÃO tocar em thumbnails/waveforms
    const tempCat = this.categories.find(c => c.key === 'temp');
    if (tempCat) {
      for (const dir of [tempCat.dir, ...(tempCat.extraDirs || [])]) {
        walk(dir);
      }
    }

    if (filesRemoved > 0) {
      logger.info(`[CacheService] Limpeza de stale: ${filesRemoved} arquivos removidos, ${this._formatBytes(bytesFreed)} liberados.`);
    }
    return { filesRemoved, bytesFreed };
  }

  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const idx = Math.min(i, units.length - 1);
    const v = bytes / Math.pow(1024, idx);
    return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0)} ${units[idx]}`;
  }
}

module.exports = CacheService;
