'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const logger = require('../../services/logService');
const { isAudio } = require('../media/MediaTypes');

const MAX_BATCH = 3; // teto do paralelismo (ffmpeg já é limitado pelo FfmpegLimiter; evita competir com a UI)

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
 * @param {number} [opts.batchSize=3]  limitado a 3 (valores maiores dos chamadores são reduzidos)
 * @param {number} [opts.limit]     Limita a quantidade processada (uso em testes/recuperação parcial)
 * @param {string} [opts.logPrefix='[RegenThumbs]']
 * @param {Function} [opts.onProgress]
 * @returns {Promise<{regenerated:number, failed:number, total:number}>}
 */
async function regenerateMissingThumbnails({
  paths,
  dbManager,
  window = null,
  batchSize = 3,
  limit = 0,
  logPrefix = '[RegenThumbs]',
  onProgress = null,
} = {}) {
  const ThumbnailGenerator = require('../media/ThumbnailGenerator');
  const { PRIORITY } = require('../media/FfmpegLimiter');
  const { ffmpegTool } = require('../../infrastructure/external-tools/adapters/FfmpegTool');

  const thumbDir = path.join(paths.dataDir, 'Thumbnails');
  if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

  const thumbGen = new ThumbnailGenerator({
    ffmpegPath: ffmpegTool.resolve({ mustExist: false }),
    thumbnailsDir: thumbDir,
  });

  const batchLimit = Math.max(1, Math.min(Number(batchSize) || MAX_BATCH, MAX_BATCH));
  const db = dbManager.get();
  const t0 = Date.now();
  // Um único readdir da pasta de miniaturas (Set) — usado também para decidir se vale varrer o banco.
  let present;
  try { present = new Set(await fsp.readdir(thumbDir)); } catch { present = new Set(); }

  // Atalho de startup: se a pasta tem pelo menos tantos arquivos quanto miniaturas registradas e não há
  // mídia (não áudio) sem miniatura, não há o que regenerar — evita o SELECT completo da tabela.
  // (Arquivos órfãos na pasta podem mascarar poucas ausências; a regeneração manual/limpeza de cache
  // normalmente esvazia a pasta, caindo no caminho completo.)
  try {
    const readyCond = "(status = 'READY' OR status IS NULL) AND (missing = 0 OR missing IS NULL)";
    const registered = db.prepare(`SELECT COUNT(*) AS c FROM media WHERE ${readyCond} AND thumbnail IS NOT NULL`).get();
    // Sem miniatura registrada e que não é áudio (media_type NULL = extensão desconhecida: também vai ao caminho completo)
    const unregistered = db.prepare(
      `SELECT COUNT(*) AS c FROM media WHERE ${readyCond} AND thumbnail IS NULL AND (media_type IS NULL OR media_type != 'audio')`
    ).get();
    if (present.size >= registered.c && unregistered.c === 0) {
      logger.info(`${logPrefix} Miniaturas completas (${present.size} arquivos >= ${registered.c} registradas): varredura ignorada.`);
      return { regenerated: 0, failed: 0, total: 0 };
    }
  } catch (e) {
    logger.warn(`${logPrefix} Atalho de contagem indisponível (${e.message}); usando varredura completa.`);
  }

  // Busca mídias com thumbnail registrada no DB mas arquivo ausente no disco.
  // [FIX] Exclui mídias marcadas missing=1 (fonte não existe mais — nunca regeneraria).
  // Inclui também mídias SEM miniatura registrada (ex.: importadas por um caminho que não a gerava),
  // exceto áudio, que não tem imagem para extrair.
  const rows = db.prepare(`
    SELECT id, uuid, filepath, thumbnail, duration, filename
    FROM media
    WHERE (status = 'READY' OR status IS NULL)
      AND (missing = 0 OR missing IS NULL)
  `).all();

  const missing = rows.filter((r) => {
    if (!r.thumbnail) return !isAudio(r.filename || r.filepath || '');
    return !present.has(r.thumbnail);
  }).slice(0, limit > 0 ? limit : undefined);

  if (missing.length === 0) {
    logger.info(`${logPrefix} Nenhuma thumbnail ausente encontrada.`);
    return { regenerated: 0, failed: 0, total: 0 };
  }

  logger.info(`${logPrefix} ${missing.length} thumbnails ausentes. Regenerando em lotes de ${batchLimit}...`);

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

  for (let i = 0; i < missing.length; i += batchLimit) {
    const batch = missing.slice(i, i + batchLimit);
    await Promise.allSettled(batch.map(async (row) => {
      try {
        // Sem fsp.access por item: se a fonte não existe, o generate() falha e conta como falha.
        // Prioridade baixa no FfmpegLimiter (não disputa CPU com reprodução/exportação).
        await thumbGen.generate(row.filepath, row.uuid, row.duration || 0, { priority: PRIORITY.LOW });
        if (!row.thumbnail) {
          db.prepare('UPDATE media SET thumbnail = ? WHERE id = ?').run(`${row.uuid}.jpg`, row.id);
        }
        regenerated++;
      } catch (err) {
        logger.warn(`${logPrefix} Falha ao regenerar thumb id=${row.id}: ${err.message}`);
        failed++;
      }
    }));
    notify(i + batchLimit);
    await new Promise((r) => setTimeout(r, 20)); // cede o event loop entre lotes
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  logger.info(`${logPrefix} Concluído (${elapsed}s): ${regenerated} regeneradas, ${failed} falhas de ${missing.length} total.`);
  return { regenerated, failed, total: missing.length };
}

module.exports = { regenerateMissingThumbnails };