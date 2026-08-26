const logger = require('../../services/logService');
const { spawn } = require('child_process');
const fs = require('fs');

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
            if (!filePath || !fs.existsSync(filePath)) {
                reject(new Error(`Arquivo não encontrado no disco: ${filePath}`));
                return;
            }
            if (!this.ffmpegPath || !fs.existsSync(this.ffmpegPath)) {
                reject(new Error(`FFmpeg não encontrado em: "${this.ffmpegPath}". Verifique se as dependências foram baixadas corretamente.`));
                return;
            }

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
    // FASE 3: Correção de deriva de clock (clock drift)
    // ------------------------------------------------------------------
    // Em gravações longas (>~5min), dois gravadores com clocks internos
    // levemente diferentes derivam ao longo do tempo mesmo após o offset
    // inicial estar correto — o áudio vai lentamente "escorregando".
    // Em vez de um único offset global, amostramos a correlação em vários
    // pontos ao longo do trecho sobreposto e ajustamos uma reta
    // (offset em função do tempo) por regressão linear simples.
    // O resultado é: offset_seconds (no início) + drift_rate (segundos de
    // deriva por segundo de mídia, tipicamente na ordem de dezenas de ppm).

    /**
     * Sincroniza com correção de deriva: primeiro acha o offset global
     * (grosso), depois refina com múltiplos pontos de amostragem para
     * detectar e compensar a deriva de clock.
     *
     * @param {Float32Array} masterEnv
     * @param {Float32Array} targetEnv
     * @param {number} maxOffsetSeconds
     * @returns {{offsetSeconds:number, confidence:number, driftRatePpm:number, samplePoints:Array}}
     */
    syncWithDriftCorrection(masterEnv, targetEnv, maxOffsetSeconds = 30) {
        // 1) Offset global grosso, igual ao algoritmo original
        const coarse = this.crossCorrelate(masterEnv, targetEnv, maxOffsetSeconds);
        if (coarse.confidence <= 0) return { ...coarse, driftRatePpm: 0, samplePoints: [] };

        const overlapSeconds = Math.min(masterEnv.length, targetEnv.length) * this.windowSeconds;

        // Deriva só é relevante em clipes longos; abaixo disso o offset
        // global já é suficientemente preciso e a amostragem por segmento
        // não teria trecho longo o bastante para ser confiável.
        const DRIFT_MIN_DURATION_SECONDS = 300; // 5 minutos
        if (overlapSeconds < DRIFT_MIN_DURATION_SECONDS) {
            return { ...coarse, driftRatePpm: 0, samplePoints: [] };
        }

        // 2) Amostra a correlação em N pontos ao longo da sobreposição,
        //    cada um buscando apenas numa janela pequena ao redor do
        //    offset grosso já conhecido (refinamento local, rápido).
        const NUM_SAMPLE_POINTS = 5;
        const localSearchSeconds = 0.75; // busca fina de ±750ms ao redor do offset grosso
        const segmentSpanSeconds = 8;    // cada ponto usa ~8s de envelope centrados nele

        const samplePoints = [];
        for (let p = 0; p < NUM_SAMPLE_POINTS; p++) {
            // Distribui os pontos uniformemente ao longo do trecho sobreposto,
            // evitando as bordas (onde a janela local poderia faltar dados).
            const centerT = overlapSeconds * ((p + 1) / (NUM_SAMPLE_POINTS + 1));
            const local = this._localOffsetAt(masterEnv, targetEnv, coarse.offsetSeconds, centerT, segmentSpanSeconds, localSearchSeconds);
            if (local) samplePoints.push({ tSeconds: centerT, offsetSeconds: local.offsetSeconds, confidence: local.confidence });
        }

        if (samplePoints.length < 3) {
            // Amostragem insuficiente (trechos de silêncio, etc.) — mantém offset global sem deriva
            return { ...coarse, driftRatePpm: 0, samplePoints };
        }

        // 3) Regressão linear simples: offset(t) = intercept + slope * t
        const { slope, intercept } = this._linearRegression(samplePoints.map(s => s.tSeconds), samplePoints.map(s => s.offsetSeconds));

        const avgConfidence = samplePoints.reduce((sum, s) => sum + s.confidence, 0) / samplePoints.length;
        const driftRatePpm = parseFloat((slope * 1_000_000).toFixed(2)); // segundos de deriva por segundo → ppm

        return {
            offsetSeconds: parseFloat(intercept.toFixed(3)),
            confidence: parseFloat(Math.max(0, Math.min(coarse.confidence, avgConfidence)).toFixed(4)),
            driftRatePpm,
            samplePoints
        };
    }

    /**
     * Refina o offset localmente ao redor de um ponto do tempo, buscando
     * apenas numa janela pequena (localSearchSeconds) em torno do offset
     * grosseiro já conhecido — muito mais rápido que uma busca global.
     * @private
     */
    _localOffsetAt(masterEnv, targetEnv, coarseOffsetSeconds, centerTSeconds, segmentSpanSeconds, localSearchSeconds) {
        const centerSample = Math.round(centerTSeconds / this.windowSeconds);
        const halfSpan = Math.round((segmentSpanSeconds / 2) / this.windowSeconds);
        const coarseShiftSamples = Math.round(coarseOffsetSeconds / this.windowSeconds);
        const localSearchSamples = Math.max(1, Math.round(localSearchSeconds / this.windowSeconds));

        const tStart = Math.max(0, centerSample - halfSpan);
        const tEnd = Math.min(targetEnv.length, centerSample + halfSpan);
        if (tEnd - tStart < 20) return null; // segmento curto demais (~0.4s), ignora

        const targetSegment = targetEnv.subarray(tStart, tEnd);
        const targetMean = this._mean(targetSegment);
        const targetStd = this._std(targetSegment, targetMean);
        if (targetStd < 1e-6) return null; // segmento silencioso, sem sinal pra correlacionar

        let bestShift = coarseShiftSamples;
        let bestScore = -Infinity;

        for (let extra = -localSearchSamples; extra <= localSearchSamples; extra++) {
            const shift = coarseShiftSamples + extra;
            const mStart = tStart + shift;
            const mEnd = tEnd + shift;
            if (mStart < 0 || mEnd > masterEnv.length) continue;

            const masterSegment = masterEnv.subarray(mStart, mEnd);
            const masterMean = this._mean(masterSegment);
            const masterStd = this._std(masterSegment, masterMean);
            if (masterStd < 1e-6) continue;

            let sum = 0;
            for (let i = 0; i < targetSegment.length; i++) {
                sum += (masterSegment[i] - masterMean) * (targetSegment[i] - targetMean);
            }
            const score = sum / (masterStd * targetStd * targetSegment.length);
            if (score > bestScore) {
                bestScore = score;
                bestShift = shift;
            }
        }

        if (bestScore === -Infinity) return null;
        return {
            offsetSeconds: parseFloat((bestShift * this.windowSeconds).toFixed(3)),
            confidence: parseFloat(Math.max(0, bestScore).toFixed(4))
        };
    }

    /** @private */
    _linearRegression(xs, ys) {
        const n = xs.length;
        const meanX = xs.reduce((a, b) => a + b, 0) / n;
        const meanY = ys.reduce((a, b) => a + b, 0) / n;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) {
            num += (xs[i] - meanX) * (ys[i] - meanY);
            den += (xs[i] - meanX) ** 2;
        }
        const slope = den === 0 ? 0 : num / den;
        const intercept = meanY - slope * meanX;
        return { slope, intercept };
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
     * @returns {Promise<Array<{media_id:number, offset_seconds:number, confidence:number, drift_rate_ppm:number}>>}
     */
    async syncGroup(mediaList, masterMediaId, maxOffsetSeconds = 30, onProgress = null) {
        const master = mediaList.find(m => m.id === masterMediaId);
        if (!master) throw new Error('Mídia master não encontrada na lista.');

        if (onProgress) onProgress(master.id, 'extracting');
        const masterEnv = await this.extractEnvelope(master.filepath);

        const results = [{ media_id: master.id, offset_seconds: 0.0, confidence: 1.0, drift_rate_ppm: 0 }];

        for (const media of mediaList) {
            if (media.id === masterMediaId) continue;

            try {
                if (onProgress) onProgress(media.id, 'extracting');
                const targetEnv = await this.extractEnvelope(media.filepath);

                if (onProgress) onProgress(media.id, 'correlating');
                const { offsetSeconds, confidence, driftRatePpm } = this.syncWithDriftCorrection(masterEnv, targetEnv, maxOffsetSeconds);

                results.push({ media_id: media.id, offset_seconds: offsetSeconds, confidence, drift_rate_ppm: driftRatePpm || 0 });
                if (onProgress) onProgress(media.id, 'done');
            } catch (e) {
                logger.error(`[AudioSyncService] Falha ao sincronizar mídia ${media.id}: ${e.message}`);
                results.push({ media_id: media.id, offset_seconds: 0.0, confidence: 0, drift_rate_ppm: 0, error: e.message });
                if (onProgress) onProgress(media.id, 'error');
            }
        }

        return results;
    }
}

module.exports = AudioSyncService;
