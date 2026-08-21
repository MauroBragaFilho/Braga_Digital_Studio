const logger = require('../../services/logService');
const fs = require('fs');
const path = require('path');
const dbManager = require('../database/database');
const HashGenerator = require('./HashGenerator');
const MediaScanner = require('./MediaScanner');
const FFProbe = require('../ffmpeg/FFProbe');
const { v4: uuidv4 } = require('uuid');

class MediaImporter {
    /**
     * @param {Object} options
     * @param {string} options.ffprobePath - Caminho para o executável do ffprobe
     */
    constructor({ ffprobePath }) {
        this.ffprobe = new FFProbe({ ffprobePath });
    }

    /**
     * Importa uma biblioteca inteira
     * @param {Object} library - Objeto library vindo do banco de dados
     */
    async importLibrary(library) {
        logger.info(`[MediaImporter] Iniciando importação da biblioteca: ${library.name} (${library.path})`);
        
        if (!library.path) {
            logger.warn(`[MediaImporter] A biblioteca ${library.name} não possui um caminho local.`);
            return;
        }

        const files = await MediaScanner.scanDirectory(library.path);
        logger.info(`[MediaImporter] Encontrados ${files.length} arquivos compatíveis.`);

        for (const filePath of files) {
            await this.importFile(library, filePath);
        }

        logger.info(`[MediaImporter] Importação de ${library.name} concluída.`);
    }

    /**
     * Processa e importa um único arquivo para o banco de dados
     * @param {Object} library 
     * @param {string} filePath 
     */
    async importFile(library, filePath) {
        const filename = path.basename(filePath);
        
        // Validação de extensão para ignorar exes, dlls e arquivos não suportados
        const SUPPORTED_EXTENSIONS = new Set([
            '.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4a', '.mp3', '.flac', '.wav', '.ogg', 
            '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.svg', '.heic',
            '.arw', '.cr2', '.cr3', '.nef', '.dng', '.raf', '.rw2', '.orf'
        ]);
        const ext = path.extname(filename).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
            return;
        }

        const db = dbManager.get();
        
        try {
            // 1. Gera Hash para verificação de duplicidade
            const hash = await HashGenerator.generate(filePath);
            
            // Verifica se o hash já existe
            const existing = db.prepare('SELECT id FROM media WHERE hash = ?').get(hash);
            if (existing) {
                logger.info(`[MediaImporter] Arquivo ignorado (já existe): ${path.basename(filePath)}`);
                return { id: existing.id, created: false };
            }

            // 2. Coleta Metadados usando FFProbe
            const info = await this.ffprobe.analyze(filePath);
            const filename = path.basename(filePath);

            // Pega a data de modificação real do arquivo
            const stats = fs.statSync(filePath);
            const recordedAt = stats.mtime.toISOString();

            // Determina o álbum a partir do nome da pasta
            const dir = path.dirname(filePath);
            let album = path.basename(dir);
            if (!album || album === '.' || album === path.parse(dir).root) {
                album = null;
            }

            // 3. Salva no banco de dados
            const fileUuid = uuidv4();
            const audioTrackCount = (info.audio_streams && info.audio_streams.length) ? info.audio_streams.length : (info.audio_codec ? 1 : 0);
            const stmt = db.prepare(`
                INSERT INTO media (
                    library_id, uuid, origin, filename, filepath, filesize, duration,
                    width, height, fps, video_codec, audio_codec, audio_track_count, bitrate, hash, recorded_at, album
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const info2 = stmt.run(
                library.id,
                fileUuid,
                library.type,
                filename,
                filePath,
                info.filesize,
                info.duration,
                info.width,
                info.height,
                info.fps,
                info.video_codec,
                info.audio_codec,
                audioTrackCount,
                info.bitrate,
                hash,
                recordedAt,
                album
            );

            logger.info(`[MediaImporter] Arquivo importado: ${filename}`);
            return { id: info2.lastInsertRowid, created: true };

        } catch (error) {
            logger.error(`[MediaImporter] Falha ao importar ${filePath}: ${error.stack || error.message || error}`);
        }
    }
}

module.exports = MediaImporter;
