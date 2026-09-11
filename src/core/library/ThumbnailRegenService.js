'use strict';

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../../services/logService');

/**
 * Regenera thumbnails ausentes — thumbnail registrada no DB, arquivo ausente no disco.
 *
 * Compartilhado entre:
 *  - bootstrap.js        (startup — recupera thumbnails apagadas/desaparecidas)
 *  - libraryHandlers.js  (IPC manual "regenerar thumbnails")
 *  - systemHandlers.js   (após clearCache de thumbnails — regenera na hora, sem reiniciar)
 *
 * Processa em lotes paralelos (batchSize) e envia progresso incremental
 * ('bds:thumbs-regen-progress') para a biblioteca atualizar em tempo real.
 *
 * @param {Object} opts
 * @param {Object} opts.paths       AppPaths (usado: paths.dataDir)
 * @param {Object} opts.dbManager   módulo database (com .get())
 * @param {Object} [opts.window]    BrowserWindow p/ eventos de progresso
 * @param {number} [opts.batchSize=8]
 * @param {number} [opts.limit]     Limita a quantidade processada (uso em testes/recuperação parcial)
 * @param {string} [opts.logPrefix='[RegenThumbs]']
 * @param {Function} [opts.onProgress]
 * @returns {Promise<{regenerated:number, failed:number, total:number}>}
 */
async function regenerateMissingThumbnails({
  paths,
  dbManager,
  window = null,
  batchSize = 8,
  limit = 0,
  logPrefix = '[RegenThumbs]',
  onProgress = null,
} = {}) {
  const ThumbnailGenerator = require('../media/ThumbnailGenerator');
  const { ffmpegTool } = require('../../infrastructure/external-tools/adapters/FfmpegTool');

  const thumbDir = path.join(paths.dataDir, 'Thumbnails');
  if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

  const thumbGen = new ThumbnailGenerator({
    ffmpegPath: ffmpegTool.resolve({ mustExist: false }),
    thumbnailsDir: thumbDir,
  });

  const db = dbManager.get();
  const t0 = Date.now();
  // Busca mídias com thumbnail registrada no DB mas arquivo ausente no disco.
  // [FIX] Exclui mídias marcadas missing=1 (fonte não existe mais — nunca regeneraria).
  const rows = db.prepare(`
    SELECT id, uuid, filepath, thumbnail, duration, filename
    FROM media
    WHERE thumbnail IS NOT NULL AND thumbnail != ''
      AND (status = 'READY' OR status IS NULL)
      AND (missing = 0 OR missing IS NULL)
  `).all();

  const missing = rows.filter((r) => {
    const thumbPath = path.join(thumbDir, r.thumbnail);
    try { return !fs.existsSync(thumbPath); } catch { return true; }
  }).slice(0, limit > 0 ? limit : undefined);

  if (missing.length === 0) {
    logger.info(`${logPrefix} Nenhuma thumbnail ausente encontrada.`);
    return { regenerated: 0, failed: 0, total: 0 };
  }

  logger.info(`${logPrefix} ${missing.length} thumbnails ausentes. Regenerando em lotes de ${batchSize}...`);

  let regenerated = 0;
  let failed = 0;

  const notify = (processed) => {
    const payload = {
      processed: Math.min(processed, missing.length),
      total: missing.length,
      regenerated,
      failed,
    };
    if (onProgress) {
      try { onProgress(payload); } catch (_) {}
    }
    if (window && !window.isDestroyed()) {
      try { window.webContents.send('bds:thumbs-regen-progress', payload); } catch (_) {}
    }
  };

  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(async (row) => {
      try {
        // Verifica se o arquivo original ainda existe
        if (!fs.existsSync(row.filepath)) { failed++; return; }
        await thumbGen.generate(row.filepath, row.uuid, row.duration || 0);
        regenerated++;
      } catch (err) {
        logger.warn(`${logPrefix} Falha ao regenerar thumb id=${row.id}: ${err.message}`);
        failed++;
      }
    }));
    notify(i + batchSize);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  logger.info(`${logPrefix} Concluído (${elapsed}s): ${regenerated} regeneradas, ${failed} falhas de ${missing.length} total.`);
  return { regenerated, failed, total: missing.length };
}

module.exports = { regenerateMissingThumbnails };