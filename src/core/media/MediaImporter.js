const logger = require('../../services/logService');
const path = require('path');
const dbManager = require('../database/database');
const MediaScanner = require('./MediaScanner');
const FFProbe = require('../ffmpeg/FFProbe');
const ThumbnailGenerator = require('./ThumbnailGenerator');
const { ffmpegTool } = require('../../infrastructure/external-tools/adapters/FfmpegTool');
const { appPaths } = require('../../infrastructure/filesystem/AppPaths');
const { ingestFile } = require('./MediaIngest');
const { isSupported, isAudio } = require('./MediaTypes');

class MediaImporter {
    /**
     * @param {Object} options
     * @param {string} options.ffprobePath - Caminho para o executável do ffprobe
     * @param {string} [options.ffmpegPath] - Caminho do ffmpeg (padrão: ferramenta resolvida)
     * @param {string} [options.thumbnailsDir] - Pasta das miniaturas (padrão: AppPaths)
     */
    constructor({ ffprobePath, ffmpegPath, thumbnailsDir }) {
        this.ffprobe = new FFProbe({ ffprobePath });
        this.ffmpegPath = ffmpegPath;
        this.thumbnailsDir = thumbnailsDir;
        this._thumbnailGen = null;
    }

    _getThumbnailGenerator() {
        if (!this._thumbnailGen) {
            this._thumbnailGen = new ThumbnailGenerator({
                ffmpegPath: this.ffmpegPath || ffmpegTool.resolve({ mustExist: false }),
                thumbnailsDir: this.thumbnailsDir || appPaths.thumbnailsDir,
            });
        }
        return this._thumbnailGen;
    }

    /** Gera a miniatura da mídia; devolve o nome do arquivo ou null (falha não derruba a importação). */
    async _generateThumbnail(filePath, filename, uuid, duration) {
        if (isAudio(filename)) return null;
        try {
            await this._getThumbnailGenerator().generate(filePath, uuid, duration);
            return `${uuid}.jpg`;
        } catch (err) {
            logger.warn(`[MediaImporter] Sem thumbnail para ${filename}: ${err.message}`);
            return null;
        }
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
        if (!isSupported(filename)) return;

        try {
            // Mesmo pipeline do ImportWorker (origem, álbum, recorded_at, audio_track_count, miniatura, READY)
            const result = await ingestFile({
                db: dbManager.get(),
                ffprobe: this.ffprobe,
                library,
                filePath,
                emit: false, // os handlers IPC já notificam a UI ao final
                generateThumbnail: (fp, uuid, duration) => this._generateThumbnail(fp, filename, uuid, duration),
            });
            if (!result) return;
            if (result.created) logger.info(`[MediaImporter] Arquivo importado: ${filename}`);
            return { id: result.id, created: result.created };
        } catch (error) {
            logger.error(`[MediaImporter] Falha ao importar ${filePath}: ${error.stack || error.message || error}`);
        }
    }
}

module.exports = MediaImporter;
