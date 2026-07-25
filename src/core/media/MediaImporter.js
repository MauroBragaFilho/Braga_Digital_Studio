const logger = require('../../../services/logService');
const fs = require('fs');
const path = require('path');
const dbManager = require('../database/database');
const HashGenerator = require('./HashGenerator');
const MediaScanner = require('./MediaScanner');
const FFProbe = require('../ffmpeg/FFProbe');

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
        const db = dbManager.get();
        
        try {
            // 1. Gera Hash para verificação de duplicidade
            const hash = await HashGenerator.generate(filePath);
            
            // Verifica se o hash já existe
            const existing = db.prepare('SELECT id FROM media WHERE hash = ?').get(hash);
            if (existing) {
                logger.info(`[MediaImporter] Arquivo ignorado (já existe): ${path.basename(filePath)}`);
                return;
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
            const stmt = db.prepare(`
                INSERT INTO media (
                    library_id, origin, filename, filepath, filesize, duration,
                    width, height, fps, video_codec, audio_codec, bitrate, hash, recorded_at, album
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            stmt.run(
                library.id,
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
                info.bitrate,
                hash,
                recordedAt,
                album
            );

            logger.info(`[MediaImporter] Arquivo importado: ${filename}`);

        } catch (error) {
            logger.error(`[MediaImporter] Falha ao importar ${filePath}:`, error.message);
        }
    }
}

module.exports = MediaImporter;
