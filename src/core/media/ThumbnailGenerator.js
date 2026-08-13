const logger = require('../../services/logService');
const { execFile } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs');
const execFilePromise = util.promisify(execFile);

class ThumbnailGenerator {
    /**
     * @param {Object} options
     * @param {string} options.ffmpegPath - Caminho para o ffmpeg.exe
     * @param {string} options.thumbnailsDir - Diretório onde os thumbnails serão salvos
     */
    constructor({ ffmpegPath, thumbnailsDir }) {
        this.ffmpegPath = ffmpegPath;
        this.thumbnailsDir = thumbnailsDir;

        // Garante que a pasta de thumbnails existe
        if (!fs.existsSync(this.thumbnailsDir)) {
            fs.mkdirSync(this.thumbnailsDir, { recursive: true });
        }
    }

    /**
     * Gera um thumbnail do arquivo de vídeo.
     * @param {string} videoPath - Caminho do vídeo original
     * @param {string} uuid - UUID do arquivo (usado para o nome da imagem)
     * @param {number} duration - Duração do vídeo em segundos (extraída pelo FFprobe)
     * @returns {Promise<string>} O caminho absoluto do arquivo JPG gerado
     */
    async generate(videoPath, uuid, duration = 0) {
        const outputPath = path.join(this.thumbnailsDir, `${uuid}.jpg`);
        
        // Define o tempo: 5 segundos ou metade do vídeo se for menor que 5s
        let timeInSeconds = 5;
        if (duration > 0 && duration < 5) {
            timeInSeconds = duration / 2;
        } else if (duration === 0) {
            timeInSeconds = 0; // Caso não saiba a duração, pega o primeiro frame
        }

        // Formata o tempo em HH:MM:SS.mmm
        const date = new Date(timeInSeconds * 1000);
        const hh = String(date.getUTCHours()).padStart(2, '0');
        const mm = String(date.getUTCMinutes()).padStart(2, '0');
        const ss = String(date.getUTCSeconds()).padStart(2, '0');
        const mmm = String(date.getUTCMilliseconds()).padStart(3, '0');
        const timeString = `${hh}:${mm}:${ss}.${mmm}`;

        // Lógica para arquivos RAW: tenta usar o JPG como fonte rápida se existir
        let thumbSource = videoPath;
        const isRaw = videoPath.match(/\.(arw|cr2|cr3|nef|dng|raf|rw2|orf)$/i);
        if (isRaw) {
            const dir = path.dirname(videoPath);
            const base = path.parse(videoPath).name;
            if (fs.existsSync(path.join(dir, base + '.jpg'))) thumbSource = path.join(dir, base + '.jpg');
            else if (fs.existsSync(path.join(dir, base + '.JPG'))) thumbSource = path.join(dir, base + '.JPG');
            else if (fs.existsSync(path.join(dir, base + '.jpeg'))) thumbSource = path.join(dir, base + '.jpeg');
            else if (fs.existsSync(path.join(dir, base + '.JPEG'))) thumbSource = path.join(dir, base + '.JPEG');
        }

        // Comando FFmpeg: seek rápido (-ss antes de -i), extrai 1 frame (-vframes 1) em JPG de alta qualidade (-q:v 2)
        const isPhoto = thumbSource.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/i) || isRaw;
        let args;
        
        if (isPhoto) {
            args = ['-i', thumbSource, '-vf', 'scale=320:-1', '-vframes', '1', '-q:v', '2', '-y', outputPath];
        } else {
            args = ['-ss', timeString, '-i', thumbSource, '-vframes', '1', '-q:v', '2', '-y', outputPath];
        }

        try {
            await execFilePromise(this.ffmpegPath, args);
            return outputPath;
        } catch (error) {
            logger.error(`[ThumbnailGenerator] Falha ao gerar miniatura para ${videoPath}:`, error.message);
            throw error;
        }
    }
}

module.exports = ThumbnailGenerator;
