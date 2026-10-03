const logger = require('../../services/logService');
const path = require('path');
const dbManager = require('../database/database');
const FFProbe = require('../ffmpeg/FFProbe');
const ThumbnailGenerator = require('../media/ThumbnailGenerator');
const { ingestFile } = require('../media/MediaIngest');
const { isSupported, isJpeg, findSiblingRaw, invalidateDirCache } = require('../media/MediaTypes');

class ImportWorker {
    constructor({ ffprobePath, ffmpegPath, thumbnailsDir }) {
        this.ffprobe = new FFProbe({ ffprobePath });
        this.thumbnailGen = new ThumbnailGenerator({ ffmpegPath, thumbnailsDir });
    }

    async processFile(item) {
        const { libraryId, path: filePath, event } = item;
        const db = dbManager.get();
        const filename = path.basename(filePath);

        // Validação estrita de extensão para garantir que apenas mídia seja analisada
        if (!isSupported(filename)) {
            logger.info(`[ImportWorker] Arquivo ignorado por não ser mídia suportada: ${filename}`);
            return;
        }

        try {
            // Evento do watcher = arquivo acabou de aparecer: descarta a listagem em cache da pasta
            // para o par RAW/JPG ser avaliado com a pasta atual (o cache serve ao caminho em lote).
            invalidateDirCache(path.dirname(filePath));
            // Par RAW/JPG: o RAW tem prioridade, o JPG irmão não é indexado
            if (isJpeg(filename) && findSiblingRaw(filePath)) {
                logger.info(`[ImportWorker] JPG ignorado (RAW correspondente existe): ${filename}`);
                return;
            }

            const library = db.prepare('SELECT id, type, path FROM libraries WHERE id = ?').get(libraryId);
            await ingestFile({
                db,
                ffprobe: this.ffprobe,
                library: library || (libraryId != null ? { id: libraryId, type: 'OBS', path: null } : null),
                filePath,
                event,
                emit: true,
                generateThumbnail: async (fp, uuid, duration) => {
                    try {
                        await this.thumbnailGen.generate(fp, uuid, duration);
                        return `${uuid}.jpg`;
                    } catch (thumbErr) {
                        logger.warn(`[ImportWorker] Sem thumbnail para ${filename}`);
                        return null;
                    }
                },
            });
        } catch (error) {
            logger.error(`[ImportWorker] Falha em ${filePath}: ${error.stack || error.message || error}`);
            try {
                db.prepare("UPDATE media SET status = 'ERROR' WHERE filepath = ? AND status != 'READY'").run(filePath);
            } catch (e) {}
        }
    }
}

module.exports = ImportWorker;
