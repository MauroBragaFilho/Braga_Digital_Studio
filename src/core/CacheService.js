'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
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
   * @param {number} [options.waveformsMaxMB=200] - Teto separado para waveforms/tracks m4a
   */
  constructor(appPaths, options = {}) {
    this.appPaths = appPaths;
    this.maxSizeMB = options.maxSizeMB || 500;
    this.autoClean = options.autoClean || false;
    this.waveformsMaxMB = typeof options.waveformsMaxMB === 'number' ? options.waveformsMaxMB : 200;
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
          try { const s = fs.statSync(full); files.push({ path: full, size: s.size, mtime: Math.max(s.mtimeMs, s.atimeMs || 0) }); } catch (_) {}
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

  /**
   * LRU de verdade: marca o arquivo como usado agora (atualiza atime/mtime).
   * Chamado ao ler itens de cache; o NTFS pode ter atime desativado, por isso o utimes explícito.
   */
  touch(filePath) {
    try { const now = new Date(); fs.utimesSync(filePath, now, now); } catch (_) {}
  }

  _trimWaveformsToCap() {
    if (this.waveformsMaxMB <= 0) return { filesRemoved: 0, bytesFreed: 0 };
    const cat = this.categories.find(c => c.key === 'waveforms');
    if (!cat) return { filesRemoved: 0, bytesFreed: 0 };
    const size = this._dirSize(cat.dir);
    const cap = this.waveformsMaxMB * 1024 * 1024;
    if (size <= cap) return { filesRemoved: 0, bytesFreed: 0 };
    return this._trimByOldest(cat.dir, size - cap);
  }

  async _dirSizeAsync(dirPath) {
    let total = 0;
    let entries;
    try { entries = await fsp.readdir(dirPath, { withFileTypes: true }); } catch (_) { return 0; }
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) total += await this._dirSizeAsync(full);
      else { try { total += (await fsp.stat(full)).size; } catch (_) {} }
    }
    return total;
  }

  /** Versão assíncrona de getCacheInfo (não bloqueia o event loop). */
  async getCacheInfoAsync() {
    const categories = [];
    for (const cat of this.categories) {
      let sizeBytes = await this._dirSizeAsync(cat.dir);
      for (const extra of (cat.extraDirs || [])) sizeBytes += await this._dirSizeAsync(extra);
      categories.push({ key: cat.key, label: cat.label, path: cat.dir, sizeBytes, sizeFormatted: this._formatBytes(sizeBytes) });
    }
    const totalBytes = categories.reduce((a, c) => a + c.sizeBytes, 0);
    return { categories, totalBytes, totalFormatted: this._formatBytes(totalBytes), maxSizeMB: this.maxSizeMB, autoClean: this.autoClean };
  }

  async _trimByOldestAsync(dirPath, targetBytes) {
    const files = [];
    const walk = async (dir) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else { try { const st = await fsp.stat(full); files.push({ path: full, size: st.size, mtime: Math.max(st.mtimeMs, st.atimeMs || 0) }); } catch (_) {} }
      }
    };
    await walk(dirPath);
    files.sort((a, b) => a.mtime - b.mtime);
    let filesRemoved = 0, bytesFreed = 0;
    for (const f of files) {
      if (bytesFreed >= targetBytes) break;
      try { await fsp.unlink(f.path); filesRemoved++; bytesFreed += f.size; } catch (_) {}
    }
    return { filesRemoved, bytesFreed };
  }

  /** Versão assíncrona de autoCleanIfNeeded (teto de waveforms + teto global, LRU). */
  async autoCleanIfNeededAsync() {
    if (!this.autoClean) return { trimmed: false };
    let totalBytesFreed = 0;
    const details = [];
    const wf = this.categories.find(c => c.key === 'waveforms');
    if (wf && this.waveformsMaxMB > 0) {
      const size = await this._dirSizeAsync(wf.dir);
      const cap = this.waveformsMaxMB * 1024 * 1024;
      if (size > cap) {
        const r = await this._trimByOldestAsync(wf.dir, size - cap);
        details.push({ key: 'waveforms', ...r });
        totalBytesFreed += r.bytesFreed;
      }
    }
    if (this.maxSizeMB > 0) {
      const info = await this.getCacheInfoAsync();
      const maxBytes = this.maxSizeMB * 1024 * 1024;
      if (info.totalBytes > maxBytes) {
        const excess = info.totalBytes - maxBytes;
        for (const catInfo of info.categories) {
          if (catInfo.sizeBytes === 0) continue;
          const catDef = this.categories.find(c => c.key === catInfo.key) || {};
          const target = Math.ceil(excess * (catInfo.sizeBytes / info.totalBytes));
          let freed = 0, removed = 0;
          for (const dir of [catDef.dir, ...(catDef.extraDirs || [])].filter(Boolean)) {
            const r = await this._trimByOldestAsync(dir, target - freed);
            freed += r.bytesFreed; removed += r.filesRemoved;
          }
          details.push({ key: catInfo.key, filesRemoved: removed, bytesFreed: freed });
          totalBytesFreed += freed;
        }
      }
    }
    return { trimmed: details.length > 0, details, totalBytesFreed, totalFormatted: this._formatBytes(totalBytesFreed) };
  }

  autoCleanIfNeeded() {
    if (!this.autoClean) return { trimmed: false };
    const wfTrim = this._trimWaveformsToCap();
    const wfResult = () => (wfTrim.filesRemoved > 0
      ? { trimmed: true, details: [{ key: 'waveforms', ...wfTrim }], totalBytesFreed: wfTrim.bytesFreed, totalFormatted: this._formatBytes(wfTrim.bytesFreed) }
      : { trimmed: false });
    if (this.maxSizeMB <= 0) return wfResult();
    const info = this.getCacheInfo();
    const maxBytes = this.maxSizeMB * 1024 * 1024;
    if (info.totalBytes <= maxBytes) return wfResult();
    const excess = info.totalBytes - maxBytes;
    logger.info(`[CacheService] Auto-limpeza: cache (${info.totalFormatted}) excede limite (${this.maxSizeMB} MB). Removendo ${this._formatBytes(excess)}...`);
    const details = wfTrim.filesRemoved > 0 ? [{ key: 'waveforms', ...wfTrim }] : [];
    let totalBytesFreed = wfTrim.bytesFreed;
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
    if (typeof opts.waveformsMaxMB === 'number' && opts.waveformsMaxMB >= 0) this.waveformsMaxMB = opts.waveformsMaxMB;
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

  /**
   * Versão assíncrona de cleanStaleTempFiles (não bloqueia o event loop; usada em background
   * após a janela abrir). Mesma regra: só a pasta de temporários, arquivos mais velhos que maxAgeMs.
   * @param {number} [maxAgeMs=3600000]
   * @returns {Promise<{ filesRemoved: number, bytesFreed: number }>}
   */
  async cleanStaleTempFilesAsync(maxAgeMs = 3600000) {
    const cutoff = Date.now() - maxAgeMs;
    let filesRemoved = 0, bytesFreed = 0;

    const walk = async (dir) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          try { if ((await fsp.readdir(full)).length === 0) await fsp.rmdir(full); } catch (_) {}
        } else {
          try {
            const s = await fsp.stat(full);
            if (s.mtimeMs < cutoff) {
              await fsp.unlink(full);
              filesRemoved++;
              bytesFreed += s.size;
            }
          } catch (_) {}
        }
      }
    };

    const tempCat = this.categories.find(c => c.key === 'temp');
    if (tempCat) {
      for (const dir of [tempCat.dir, ...(tempCat.extraDirs || [])]) {
        await walk(dir);
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
