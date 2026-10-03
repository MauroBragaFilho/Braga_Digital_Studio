const logger = require('../../services/logService');
const { execFile } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs');
const { isRaw: isRawPath, isImage, findSiblingJpg } = require('./MediaTypes');
const ffmpegLimiter = require('./FfmpegLimiter');
const { PRIORITY } = ffmpegLimiter;

const FFMPEG_TIMEOUT_MS = 45000;
const THUMB_WIDTH = 480;       // grade ~300 px; 480 cobre telas HiDPI
const THUMB_QUALITY = 4;       // -q:v do MJPEG (2 = máxima; 4 reduz bastante o tamanho sem perda visível)
const LONG_VIDEO_SECONDS = 60; // acima disso usa -skip_frame nokey no primeiro ponto de busca
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
     * @param {Object} [opts] opts.priority - prioridade no FfmpegLimiter (padrão LOW: importação/regeneração)
     * @returns {Promise<string>} O caminho absoluto do arquivo JPG gerado
     */
    async generate(videoPath, uuid, duration = 0, { priority = PRIORITY.LOW } = {}) {
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
        const isRaw = isRawPath(videoPath);
        if (isRaw) {
            const sibling = findSiblingJpg(videoPath);
            if (sibling) thumbSource = sibling;
        }

        // Comando FFmpeg: seek rápido (-ss antes de -i), 1 frame JPEG reduzido. A grade usa ~300 px
        // (HiDPI => 480 px): antes o vídeo saía na resolução cheia (~115-390 KB); agora ~10-15 KB.
        const isPhoto = thumbSource.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/i) || isRaw;

        // yuvj420p (faixa total) é o que o encoder MJPEG aceita; vídeos de câmera (ex.: Sony, faixa
        // limitada ou 10 bits) falhavam com "Non full-range YUV is non-standard" e ficavam sem miniatura.
        // min(...) evita ampliar mídias menores que a miniatura
        const filters = `scale=w='min(${THUMB_WIDTH},iw)':h=-2:flags=fast_bilinear,format=yuvj420p`;
        const run = (extra) => execFilePromise(
            this.ffmpegPath,
            [
                '-an', '-sn', '-dn', '-nostdin', '-hide_banner', '-loglevel', 'error',
                ...extra,
                '-vf', filters, '-vframes', '1', '-q:v', String(THUMB_QUALITY), '-y', outputPath
            ],
            { windowsHide: true, timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL' }
        );
        const assertNotEmpty = () => {
            if (fs.statSync(outputPath).size === 0) throw new Error('Miniatura vazia');
        };

        try {
          await ffmpegLimiter.run(async () => {
            if (isPhoto) {
                await run(['-i', thumbSource]);
            } else {
                // Tentativas em ordem: (1) só keyframes (vídeos longos: ~4x mais rápido em GOP longo),
                // (2) seek normal, (3) primeiro frame (ponto de busca inválido / vídeo curto).
                const attempts = [];
                if (duration > LONG_VIDEO_SECONDS) attempts.push(['-skip_frame', 'nokey', '-ss', timeString, '-i', thumbSource]);
                attempts.push(['-ss', timeString, '-i', thumbSource]);
                if (timeString !== '00:00:00.000') attempts.push(['-i', thumbSource]);

                let lastErr;
                for (const extra of attempts) {
                    try {
                        await run(extra);
                        assertNotEmpty();
                        lastErr = null;
                        break;
                    } catch (err) {
                        lastErr = err;
                    }
                }
                if (lastErr) throw lastErr;
            }
          }, priority);
            return outputPath;
        } catch (error) {
            logger.error(`[ThumbnailGenerator] Falha ao gerar miniatura para ${videoPath}:`, error.message);
            throw error;
        }
    }
}

module.exports = ThumbnailGenerator;
