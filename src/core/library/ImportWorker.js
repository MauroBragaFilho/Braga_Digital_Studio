const logger = require('../../../services/logService');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const dbManager = require('../database/database');
const HashGenerator = require('../media/HashGenerator');
const FFProbe = require('../ffmpeg/FFProbe');
const ThumbnailGenerator = require('../media/ThumbnailGenerator');
const EventBus = require('../EventBus');

class ImportWorker {
    constructor({ ffprobePath, ffmpegPath, thumbnailsDir }) {
        this.ffprobe = new FFProbe({ ffprobePath });
        this.thumbnailGen = new ThumbnailGenerator({ ffmpegPath, thumbnailsDir });
    }

    async processFile(item) {
        const { libraryId, path: filePath } = item;
        const db = dbManager.get();
        const filename = path.basename(filePath);

        try {
            // 1. Verifica se já existe por caminho, se estiver READY, não processa novamente
            const existsByPath = db.prepare('SELECT id, status FROM media WHERE filepath = ?').get(filePath);
            if (existsByPath && existsByPath.status === 'READY') {
                return; 
            }

            // 2. Gera Hash e checa duplicatas absolutas
            const hash = await HashGenerator.generate(filePath);
            const existingHash = db.prepare('SELECT id, filepath FROM media WHERE hash = ?').get(hash);
            
            if (existingHash) {
                // Se foi apenas movido, poderíamos atualizar o path, mas por enquanto ignoramos
                if (existingHash.filepath !== filePath) {
                    logger.info(`[ImportWorker] Arquivo ignorado (Hash duplicado com outro caminho): ${filename}`);
                }
                return;
            }

            // Busca a origem real da biblioteca
            const lib = db.prepare('SELECT type, path FROM libraries WHERE id = ?').get(libraryId);
            let origin = lib ? lib.type : 'OBS';

            // Extrair o nome do dispositivo da subpasta caso a origem seja BDSM_DEVICE
            if (origin === 'BDSM_DEVICE' && lib && lib.path) {
                const relativeDir = path.dirname(path.relative(lib.path, filePath));
                if (relativeDir && relativeDir !== '.' && relativeDir !== '') {
                    origin = relativeDir.split(path.sep)[0];
                }
            }

            // Determina o álbum a partir do nome da pasta
            const dir = path.dirname(filePath);
            let album = path.basename(dir);
            if (!album || album === '.' || album === path.parse(dir).root) {
                album = null;
            }

            // Insere o placeholder como IMPORTING
            const fileUuid = uuidv4();
            const insertStmt = db.prepare(`
                INSERT INTO media (library_id, uuid, filename, filepath, status, hash, origin, album)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const insertInfo = insertStmt.run(libraryId, fileUuid, filename, filePath, 'IMPORTING', hash, origin, album);
            const mediaId = insertInfo.lastInsertRowid;

            // 3. Extrair metadados via FFProbe
            let probeTarget = filePath;
            const isRaw = filename.match(/\.(arw|cr2|cr3|nef|dng|raf|rw2|orf)$/i);
            if (isRaw) {
                const fs = require('fs');
                const dir = require('path').dirname(filePath);
                const base = require('path').basename(filePath, require('path').extname(filePath));
                if (fs.existsSync(require('path').join(dir, base + '.jpg'))) probeTarget = require('path').join(dir, base + '.jpg');
                else if (fs.existsSync(require('path').join(dir, base + '.JPG'))) probeTarget = require('path').join(dir, base + '.JPG');
            }
            const info = await this.ffprobe.analyze(probeTarget);

            // 4. Gerar Thumbnail
            let thumbnailName = null;
            const isAudio = filename.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i);
            
            if (!isAudio) {
                try {
                    await this.thumbnailGen.generate(filePath, fileUuid, info.duration);
                    thumbnailName = `${fileUuid}.jpg`;
                } catch (thumbErr) {
                    logger.warn(`[ImportWorker] Sem thumbnail para ${filename}`);
                }
            }

            // 4.5. Determinar Data de Gravação
            const fs = require('fs');
            let recordedAt = null;
            if (info.creation_time) {
                recordedAt = info.creation_time;
            } else {
                try {
                    const stats = fs.statSync(filePath);
                    recordedAt = stats.mtime.toISOString();
                } catch(e) {}
            }

            // 5. Atualizar banco finalizando
            const updateStmt = db.prepare(`
                UPDATE media SET 
                    filesize = ?, duration = ?, width = ?, height = ?, fps = ?,
                    video_codec = ?, audio_codec = ?, bitrate = ?, thumbnail = ?,
                    status = 'READY', imported_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
                    recorded_at = ?
                WHERE id = ?
            `);
            updateStmt.run(
                info.filesize, info.duration, info.width, info.height, info.fps,
                info.video_codec, info.audio_codec, info.bitrate, thumbnailName,
                recordedAt, mediaId
            );

            const mediaFinal = db.prepare('SELECT * FROM media WHERE id = ?').get(mediaId);
            
            logger.info(`[ImportWorker] Arquivo indexado com sucesso: ${filename}`);
            EventBus.emit('MEDIA_IMPORTED', mediaFinal);

        } catch (error) {
            logger.error(`[ImportWorker] Falha em ${filePath}:`, error.message);
            try {
                db.prepare('UPDATE media SET status = ? WHERE filepath = ?').run('ERROR', filePath);
            } catch(e) {}
        }
    }
}

module.exports = ImportWorker;
