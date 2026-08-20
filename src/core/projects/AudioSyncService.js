const logger = require('../../services/logService');
const { spawn } = require('child_process');

/**
 * AudioSyncService
 * Sincroniza múltiplas mídias pelo áudio, sem depender do Premiere.
 *
 * Algoritmo (conforme plano de arquitetura, Seção 6):
 *   1. Extrai o áudio de cada mídia via FFmpeg em PCM mono 16-bit / 16kHz.
 *   2. Calcula o envelope de energia (RMS) em janelas de 20ms — isso reduz
 *      drasticamente o volume de dados e aumenta a robustez a ruído/timbre
 *      diferentes entre câmera e gravador externo.
 *   3. Executa correlação cruzada normalizada entre o envelope "master" e
 *      o envelope de cada mídia secundária, deslocando o sinal dentro de
 *      uma janela de busca configurável (padrão: ±30s).
 *   4. Retorna o deslocamento (offset) de maior coeficiente de correlação,
 *      em segundos (precisão de 20ms, sub-frame para a maioria dos usos).
 */
class AudioSyncService {
    /**
     * @param {Object} options
     * @param {string} options.ffmpegPath - Caminho para o ffmpeg.exe
     */
    constructor({ ffmpegPath }) {
        this.ffmpegPath = ffmpegPath;
        this.sampleRate = 16000;   // Taxa de decodificação do PCM (igual ao WaveformService)
        this.windowSeconds = 0.02; // Janela RMS de 20ms
        this.windowSamples = Math.round(this.sampleRate * this.windowSeconds);
    }

    // ------------------------------------------------------------------
    // ETAPA 1 + 2: Extração de PCM e cálculo do envelope de energia (RMS)
    // ------------------------------------------------------------------

    /**
     * Extrai o envelope de energia RMS (janelas de 20ms) de um arquivo de mídia.
     * @param {string} filePath
     * @returns {Promise<Float32Array>} Envelope RMS normalizado (0.0 - 1.0)
     */
    extractEnvelope(filePath) {
        return new Promise((resolve, reject) => {
            const args = [
                '-v', 'error',
                '-i', filePath,
                '-vn',
                '-ac', '1',
                '-ar', String(this.sampleRate),
                '-f', 's16le',
                '-'
            ];

            const proc = spawn(this.ffmpegPath, args, { windowsHide: true });

            let leftover = Buffer.alloc(0);
            const envelope = [];

            let sumSquares = 0;
            let sampleCount = 0;

            proc.stdout.on('data', (chunk) => {
                const combined = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
                const usableLength = combined.length - (combined.length % 2);
                leftover = combined.subarray(usableLength);

                for (let i = 0; i < usableLength; i += 2) {
                    const sample = combined.readInt16LE(i) / 32768; // normaliza para -1.0..1.0
                    sumSquares += sample * sample;
                    sampleCount++;

                    if (sampleCount >= this.windowSamples) {
                        const rms = Math.sqrt(sumSquares / sampleCount);
                        envelope.push(rms);
                        sumSquares = 0;
                        sampleCount = 0;
                    }
                }
            });

            let stderrOutput = '';
            proc.stderr.on('data', (d) => { stderrOutput += d.toString(); });

            proc.on('error', (err) => reject(new Error(`Falha ao executar FFmpeg: ${err.message}`)));

            proc.on('close', (code) => {
                if (code !== 0 && envelope.length === 0) {
                    reject(new Error(`FFmpeg finalizou com código ${code}: ${stderrOutput.slice(0, 500)}`));
                    return;
                }
                if (sampleCount > 0) {
                    envelope.push(Math.sqrt(sumSquares / sampleCount));
                }
                resolve(Float32Array.from(envelope));
            });
        });
    }

    // ------------------------------------------------------------------
    // ETAPA 3 + 4: Correlação cruzada normalizada
    // ------------------------------------------------------------------

    /**
     * Calcula o offset ótimo (em segundos) entre dois envelopes via
     * correlação cruzada normalizada, buscando dentro de ±maxOffsetSeconds.
     *
     * @param {Float32Array} masterEnv - Envelope da mídia "master" (referência)
     * @param {Float32Array} targetEnv - Envelope da mídia a sincronizar
     * @param {number} maxOffsetSeconds - Janela máxima de busca (padrão 30s)
     * @returns {{offsetSeconds: number, confidence: number}}
     */
    crossCorrelate(masterEnv, targetEnv, maxOffsetSeconds = 30) {
        const maxOffsetSamples = Math.round(maxOffsetSeconds / this.windowSeconds);

        const masterMean = this._mean(masterEnv);
        const targetMean = this._mean(targetEnv);
        const masterStd = this._std(masterEnv, masterMean);
        const targetStd = this._std(targetEnv, targetMean);

        // Sinal degenerado (silêncio total) — não é possível correlacionar com confiança
        if (masterStd < 1e-6 || targetStd < 1e-6) {
            return { offsetSeconds: 0, confidence: 0 };
        }

        let bestShift = 0;
        let bestScore = -Infinity;

        // shift > 0: target começa DEPOIS do master (target[i] ~ master[i + shift])
        // shift < 0: target começa ANTES do master
        for (let shift = -maxOffsetSamples; shift <= maxOffsetSamples; shift++) {
            const score = this._normalizedCorrelationAt(
                masterEnv, masterMean, masterStd,
                targetEnv, targetMean, targetStd,
                shift
            );
            if (score !== null && score > bestScore) {
                bestScore = score;
                bestShift = shift;
            }
        }

        // offset_seconds > 0 significa que a mídia target deve ser deslocada
        // PARA FRENTE (atrasada) em relação ao master para ficar alinhada.
        const offsetSeconds = parseFloat((bestShift * this.windowSeconds).toFixed(3));
        const confidence = bestScore === -Infinity ? 0 : parseFloat(Math.max(0, bestScore).toFixed(4));

        return { offsetSeconds, confidence };
    }

    /**
     * Coeficiente de correlação de Pearson entre master e target
     * alinhados com um deslocamento (shift) de amostras do envelope.
     * @private
     */
    _normalizedCorrelationAt(masterEnv, masterMean, masterStd, targetEnv, targetMean, targetStd, shift) {
        // target[i] é comparado com master[i + shift]
        const start = Math.max(0, -shift);
        const end = Math.min(targetEnv.length, masterEnv.length - shift);
        const overlap = end - start;

        // Exige sobreposição mínima significativa para o cálculo ser confiável
        if (overlap < 50) return null; // ~1s de overlap mínimo (50 * 20ms)

        let sum = 0;
        for (let i = start; i < end; i++) {
            const m = masterEnv[i + shift] - masterMean;
            const t = targetEnv[i] - targetMean;
            sum += m * t;
        }

        const denom = masterStd * targetStd * overlap;
        if (denom === 0) return null;
        return sum / denom;
    }

    _mean(arr) {
        if (arr.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += arr[i];
        return sum / arr.length;
    }

    _std(arr, mean) {
        if (arr.length === 0) return 0;
        let sumSq = 0;
        for (let i = 0; i < arr.length; i++) {
            const d = arr[i] - mean;
            sumSq += d * d;
        }
        return Math.sqrt(sumSq / arr.length);
    }

    // ------------------------------------------------------------------
    // API DE ALTO NÍVEL: sincroniza um grupo de mídias contra uma master
    // ------------------------------------------------------------------

    /**
     * Sincroniza uma lista de mídias contra uma mídia master.
     * @param {Array<{id:number, filepath:string}>} mediaList - Lista de mídias (inclui a master)
     * @param {number} masterMediaId - ID da mídia usada como referência (offset 0.0)
     * @param {number} [maxOffsetSeconds=30] - Janela máxima de busca de offset
     * @param {Function} [onProgress] - Callback opcional (mediaId, status) para reportar progresso
     * @returns {Promise<Array<{media_id:number, offset_seconds:number, confidence:number}>>}
     */
    async syncGroup(mediaList, masterMediaId, maxOffsetSeconds = 30, onProgress = null) {
        const master = mediaList.find(m => m.id === masterMediaId);
        if (!master) throw new Error('Mídia master não encontrada na lista.');

        if (onProgress) onProgress(master.id, 'extracting');
        const masterEnv = await this.extractEnvelope(master.filepath);

        const results = [{ media_id: master.id, offset_seconds: 0.0, confidence: 1.0 }];

        for (const media of mediaList) {
            if (media.id === masterMediaId) continue;

            try {
                if (onProgress) onProgress(media.id, 'extracting');
                const targetEnv = await this.extractEnvelope(media.filepath);

                if (onProgress) onProgress(media.id, 'correlating');
                const { offsetSeconds, confidence } = this.crossCorrelate(masterEnv, targetEnv, maxOffsetSeconds);

                results.push({ media_id: media.id, offset_seconds: offsetSeconds, confidence });
                if (onProgress) onProgress(media.id, 'done');
            } catch (e) {
                logger.error(`[AudioSyncService] Falha ao sincronizar mídia ${media.id}: ${e.message}`);
                results.push({ media_id: media.id, offset_seconds: 0.0, confidence: 0, error: e.message });
                if (onProgress) onProgress(media.id, 'error');
            }
        }

        return results;
    }
}

module.exports = AudioSyncService;
