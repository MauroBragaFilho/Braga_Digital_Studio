const logger = require('../../services/logService');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * WaveformService
 * Gera e gerencia o cache de dados de forma de onda (peaks) a partir de
 * arquivos de áudio/vídeo usando FFmpeg, para renderização fluida na
 * Mini Timeline e no Source Monitor sem travar a interface.
 *
 * Formato do cache (waveforms/<uuid>.json):
 * {
 *   "version": 1,
 *   "uuid": "...",
 *   "duration": 120.45,
 *   "peaks_per_second": 100,
 *   "peaks": [0.0, 0.12, 0.98, ...] // amplitude normalizada 0.0 - 1.0
 * }
 */
class WaveformService {
    /**
     * @param {Object} options
     * @param {string} options.ffmpegPath - Caminho para o ffmpeg.exe
     * @param {string} options.cacheDir - Diretório onde os arquivos .json de waveform serão salvos
     */
    constructor({ ffmpegPath, cacheDir }) {
        this.ffmpegPath = ffmpegPath;
        this.cacheDir = cacheDir;

        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    getCachePath(uuid, streamIndex = 0) {
        const suffix = streamIndex > 0 ? `_s${streamIndex}` : '';
        return path.join(this.cacheDir, `${uuid}${suffix}.json`);
    }

    hasCache(uuid, streamIndex = 0) {
        return fs.existsSync(this.getCachePath(uuid, streamIndex));
    }

    readCache(uuid, streamIndex = 0) {
        const cachePath = this.getCachePath(uuid, streamIndex);
        if (!fs.existsSync(cachePath)) return null;
        try {
            return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        } catch (e) {
            logger.warn(`[WaveformService] Cache corrompido para ${uuid} (stream ${streamIndex}), será regenerado. ${e.message}`);
            return null;
        }
    }

    deleteCache(uuid, streamIndex = 0) {
        const cachePath = this.getCachePath(uuid, streamIndex);
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    }

    /**
     * Obtém o waveform de um arquivo, gerando e cacheando se necessário.
     * @param {Object} params
     * @param {string} params.uuid - UUID único da mídia (usado como chave de cache)
     * @param {string} params.filePath - Caminho absoluto do arquivo de origem
     * @param {number} [params.duration] - Duração em segundos (opcional, apenas informativo)
     * @param {number} [params.peaksPerSecond=100] - Resolução do waveform
     * @param {number} [params.streamIndex=0] - Índice da stream de áudio (0 para 1a stream, 1 para 2a, etc.)
     * @param {boolean} [params.force=false] - Força regeneração ignorando cache existente
     * @returns {Promise<Object>} Objeto de waveform { peaks, duration, peaks_per_second, stream_index }
     */
    async getOrGenerate({ uuid, filePath, duration = 0, peaksPerSecond = 100, streamIndex = 0, force = false }) {
        if (!uuid || !filePath) throw new Error('uuid e filePath são obrigatórios.');

        if (!force) {
            const cached = this.readCache(uuid, streamIndex);
            if (cached && cached.peaks_per_second === peaksPerSecond) return cached;
        }

        const peaks = await this._extractPeaks(filePath, peaksPerSecond, streamIndex);
        const result = {
            version: 1,
            uuid,
            stream_index: streamIndex,
            duration: duration || (peaks.length / peaksPerSecond),
            peaks_per_second: peaksPerSecond,
            peaks
        };

        fs.writeFileSync(this.getCachePath(uuid, streamIndex), JSON.stringify(result));
        return result;
    }

    /**
     * Extrai os picos de amplitude (min/max por bloco) de um arquivo de mídia
     * via FFmpeg, decodificando para PCM 16-bit mono a 16kHz.
     * @private
     */
    _extractPeaks(filePath, peaksPerSecond, streamIndex = 0) {
        const sampleRate = 16000; // Padrão do BDS para análise de áudio (Fase 6 reaproveita a mesma taxa)
        const samplesPerPeak = Math.max(1, Math.floor(sampleRate / peaksPerSecond));

        return new Promise((resolve, reject) => {
            const args = [
                '-v', 'error',
                '-i', filePath,
                '-map', `0:a:${streamIndex}`,
                '-vn',
                '-ac', '1',
                '-ar', String(sampleRate),
                '-f', 's16le',
                '-'
            ];

            const proc = spawn(this.ffmpegPath, args, { windowsHide: true });

            let leftover = Buffer.alloc(0);
            const peaks = [];

            let currentMax = 0;
            let sampleCount = 0;

            const processBuffer = (buf) => {
                const combined = leftover.length ? Buffer.concat([leftover, buf]) : buf;
                // Cada amostra tem 2 bytes (Int16). Garante processar apenas pares completos.
                const usableLength = combined.length - (combined.length % 2);
                leftover = combined.subarray(usableLength);

                for (let i = 0; i < usableLength; i += 2) {
                    const sample = combined.readInt16LE(i);
                    const abs = Math.abs(sample);
                    if (abs > currentMax) currentMax = abs;
                    sampleCount++;

                    if (sampleCount >= samplesPerPeak) {
                        peaks.push(parseFloat((currentMax / 32768).toFixed(4)));
                        currentMax = 0;
                        sampleCount = 0;
                    }
                }
            };

            proc.stdout.on('data', (chunk) => {
                try {
                    processBuffer(chunk);
                } catch (e) {
                    // Ignora erros pontuais de parsing de um chunk; não interrompe o stream
                    logger.warn(`[WaveformService] Erro ao processar chunk PCM: ${e.message}`);
                }
            });

            let stderrOutput = '';
            proc.stderr.on('data', (d) => { stderrOutput += d.toString(); });

            proc.on('error', (err) => {
                reject(new Error(`Falha ao executar FFmpeg: ${err.message}`));
            });

            proc.on('close', (code) => {
                if (code !== 0 && peaks.length === 0) {
                    reject(new Error(`FFmpeg finalizou com código ${code}: ${stderrOutput.slice(0, 500)}`));
                    return;
                }
                // Inclui o último bloco parcial, se houver amostras remanescentes
                if (sampleCount > 0) {
                    peaks.push(parseFloat((currentMax / 32768).toFixed(4)));
                }
                resolve(peaks);
            });
        });
    }
}

module.exports = WaveformService;
