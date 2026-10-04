const logger = require('../../services/logService');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ffmpegLimiter = require('../media/FfmpegLimiter');

const { PRIORITY } = ffmpegLimiter;
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000; // teto de segurança por processo
const STDERR_TAIL_BYTES = 4096;

// Cache binário: cabeçalho de 24 bytes + 1 byte (0..255) por pico.
const WFM_MAGIC = 'BWF1';
const WFM_HEADER_BYTES = 24;

// Resolução-mestre: toda geração é feita (e cacheada) em, no mínimo, esta taxa; as telas pedem
// taxas menores (30-100) e recebem uma redução por max-pooling, sem rodar o ffmpeg de novo (RK-036).
const MASTER_PEAKS_PER_SECOND = 100;

/** Atualiza atime/mtime de um item de cache lido (LRU real do CacheService), sem bloquear. */
function touch(p) {
    const now = new Date();
    fs.promises.utimes(p, now, now).catch(() => {});
}

/** Cabeçalho: magic(4) | peaks_per_second u32 | duration f64 | count u32 | stream_index u32 (little endian). */
function encodeWfm({ peaksPerSecond, duration, streamIndex, quantized }) {
    const out = Buffer.allocUnsafe(WFM_HEADER_BYTES + quantized.length);
    out.write(WFM_MAGIC, 0, 'ascii');
    out.writeUInt32LE(peaksPerSecond, 4);
    out.writeDoubleLE(duration, 8);
    out.writeUInt32LE(quantized.length, 16);
    out.writeUInt32LE(streamIndex, 20);
    Buffer.from(quantized.buffer, quantized.byteOffset, quantized.length).copy(out, WFM_HEADER_BYTES);
    return out;
}

/** @returns {{peaksPerSecond:number,duration:number,streamIndex:number,quantized:Uint8Array}|null} */
function decodeWfm(buf) {
    if (!buf || buf.length < WFM_HEADER_BYTES || buf.toString('ascii', 0, 4) !== WFM_MAGIC) return null;
    const count = buf.readUInt32LE(16);
    if (buf.length !== WFM_HEADER_BYTES + count) return null;
    return {
        peaksPerSecond: buf.readUInt32LE(4),
        duration: buf.readDoubleLE(8),
        streamIndex: buf.readUInt32LE(20),
        quantized: new Uint8Array(buf.buffer, buf.byteOffset + WFM_HEADER_BYTES, count)
    };
}

/**
 * Reduz a resolução dos picos por max-pooling (preserva os máximos, ao contrário de uma média).
 * @param {Uint8Array} quantized picos na taxa `fromPps`
 * @param {number} fromPps taxa de origem (picos por segundo)
 * @param {number} toPps taxa desejada (se >= fromPps devolve os picos como estão)
 * @returns {Uint8Array}
 */
function reducePeaks(quantized, fromPps, toPps) {
    if (!(toPps > 0) || toPps >= fromPps || quantized.length === 0) return quantized;
    const ratio = fromPps / toPps;
    const outLen = Math.max(1, Math.ceil(quantized.length / ratio));
    const out = new Uint8Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(quantized.length, Math.max(start + 1, Math.ceil((i + 1) * ratio)));
        let max = 0;
        for (let j = start; j < end; j++) if (quantized[j] > max) max = quantized[j];
        out[i] = max;
    }
    return out;
}

/** Uint8Array (0..255) -> array de amplitudes 0.0..1.0 (formato entregue ao renderer, igual ao antigo). */
function dequantize(quantized) {
    const peaks = new Array(quantized.length);
    for (let i = 0; i < quantized.length; i++) peaks[i] = quantized[i] / 255;
    return peaks;
}

/**
 * WaveformService
 * Gera e gerencia o cache de dados de forma de onda (peaks) a partir de
 * arquivos de áudio/vídeo usando FFmpeg, para renderização fluida na
 * Mini Timeline e no Source Monitor sem travar a interface.
 *
 * Formato do cache (waveforms/<uuid>[_sN].wfm), binário e quantizado:
 *   cabeçalho de 24 bytes (ver encodeWfm) + 1 byte por pico (amplitude 0..255).
 * O cache JSON antigo (waveforms/<uuid>.json, picos como floats) continua sendo lido e é
 * migrado para .wfm sob demanda (o .json é removido após a migração).
 *
 * O objeto entregue ao chamador/renderer NÃO mudou:
 * {
 *   "version": 1,
 *   "uuid": "...",
 *   "stream_index": 0,
 *   "duration": 120.45,
 *   "peaks_per_second": 100,
 *   "peaks": [0.0, 0.12, 0.98, ...] // amplitude normalizada 0.0 - 1.0
 * }
 */
class WaveformService {
    /**
     * @param {Object} options
     * @param {string} options.ffmpegPath - Caminho para o ffmpeg.exe
     * @param {string} options.cacheDir - Diretório onde os arquivos de waveform serão salvos
     */
    constructor({ ffmpegPath, cacheDir }) {
        this.ffmpegPath = ffmpegPath;
        this.cacheDir = cacheDir;
        this._inflight = new Map(); // chave uuid:stream:resolução -> Promise (dedup de gerações simultâneas)
        this._inflightTracks = new Map();

        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    _suffix(streamIndex) {
        return streamIndex > 0 ? `_s${streamIndex}` : '';
    }

    /** Caminho do cache binário atual (.wfm). */
    getCachePath(uuid, streamIndex = 0) {
        return path.join(this.cacheDir, `${uuid}${this._suffix(streamIndex)}.wfm`);
    }

    /** Caminho do cache JSON legado (somente leitura/migração). */
    getLegacyCachePath(uuid, streamIndex = 0) {
        return path.join(this.cacheDir, `${uuid}${this._suffix(streamIndex)}.json`);
    }

    hasCache(uuid, streamIndex = 0) {
        return fs.existsSync(this.getCachePath(uuid, streamIndex))
            || fs.existsSync(this.getLegacyCachePath(uuid, streamIndex));
    }

    /**
     * Lê o cache (assíncrono, sem bloquear o main thread). Retorna o objeto de waveform ou null.
     * Se só existir o JSON legado, migra para o formato binário.
     */
    async readCache(uuid, streamIndex = 0, targetPps = null) {
        const cachePath = this.getCachePath(uuid, streamIndex);
        try {
            const decoded = decodeWfm(await fs.promises.readFile(cachePath));
            if (decoded) {
                touch(cachePath);
                const wanted = targetPps && targetPps < decoded.peaksPerSecond ? targetPps : decoded.peaksPerSecond;
                return {
                    version: 1,
                    uuid,
                    stream_index: decoded.streamIndex,
                    duration: decoded.duration,
                    peaks_per_second: wanted,
                    peaks: dequantize(reducePeaks(decoded.quantized, decoded.peaksPerSecond, wanted))
                };
            }
            logger.warn(`[WaveformService] Cache binário inválido para ${uuid} (stream ${streamIndex}), será regenerado.`);
            fs.promises.unlink(cachePath).catch(() => {});
        } catch (e) {
            if (e.code !== 'ENOENT') {
                logger.warn(`[WaveformService] Falha ao ler cache de ${uuid} (stream ${streamIndex}): ${e.message}`);
            }
        }
        return this._migrateLegacy(uuid, streamIndex);
    }

    async _migrateLegacy(uuid, streamIndex) {
        const legacyPath = this.getLegacyCachePath(uuid, streamIndex);
        let parsed;
        try {
            parsed = JSON.parse(await fs.promises.readFile(legacyPath, 'utf8'));
        } catch (e) {
            if (e.code !== 'ENOENT') {
                logger.warn(`[WaveformService] Cache corrompido para ${uuid} (stream ${streamIndex}), será regenerado. ${e.message}`);
            }
            return null;
        }
        if (!parsed || !Array.isArray(parsed.peaks) || !parsed.peaks_per_second) return null;

        try {
            const quantized = new Uint8Array(parsed.peaks.length);
            for (let i = 0; i < quantized.length; i++) {
                quantized[i] = Math.max(0, Math.min(255, Math.round((Number(parsed.peaks[i]) || 0) * 255)));
            }
            await this._writeWfm(uuid, streamIndex, {
                peaksPerSecond: parsed.peaks_per_second,
                duration: Number(parsed.duration) || 0,
                quantized
            });
            fs.promises.unlink(legacyPath).catch(() => {});
        } catch (e) {
            logger.warn(`[WaveformService] Migração do cache JSON de ${uuid} falhou (mantém o JSON): ${e.message}`);
        }
        return parsed;
    }

    /** Escrita atômica: .tmp + rename, para nunca deixar arquivo truncado no cache. */
    async _writeWfm(uuid, streamIndex, { peaksPerSecond, duration, quantized }) {
        const finalPath = this.getCachePath(uuid, streamIndex);
        const tmpPath = `${finalPath}.tmp`;
        await fs.promises.writeFile(tmpPath, encodeWfm({ peaksPerSecond, duration, streamIndex, quantized }));
        await fs.promises.rename(tmpPath, finalPath);
    }

    deleteCache(uuid, streamIndex = 0) {
        for (const p of [this.getCachePath(uuid, streamIndex), this.getLegacyCachePath(uuid, streamIndex)]) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
    }

    /**
     * Caminho do arquivo de áudio extraído (uma track isolada) usado para
     * permitir playback + mudo independente por linha no Source Monitor,
     * já que o <video>/<audio> nativo do Chromium não mixa múltiplas
     * tracks de áudio simultaneamente com volume independente.
     */
    getTrackAudioPath(uuid, streamIndex = 0) {
        return path.join(this.cacheDir, `${uuid}_track${streamIndex}.m4a`);
    }

    hasTrackAudio(uuid, streamIndex = 0) {
        return fs.existsSync(this.getTrackAudioPath(uuid, streamIndex));
    }

    /**
     * Extrai (e cacheia) uma track de áudio isolada em AAC, para tocar em
     * um <audio> próprio sincronizado ao player principal.
     * @param {number} [priority=PRIORITY.HIGH] pedido do usuário por padrão
     * @returns {Promise<string>} caminho do arquivo extraído
     */
    async getOrExtractTrack(uuid, filePath, streamIndex = 0, force = false, priority = PRIORITY.HIGH) {
        const outPath = this.getTrackAudioPath(uuid, streamIndex);
        if (!force && fs.existsSync(outPath)) { touch(outPath); return outPath; }

        const key = `${uuid}:${streamIndex}`;
        if (this._inflightTracks.has(key)) return this._inflightTracks.get(key);
        const promise = this._extractTrack(filePath, streamIndex, outPath, priority)
            .then(() => outPath)
            .finally(() => this._inflightTracks.delete(key));
        this._inflightTracks.set(key, promise);
        return promise;
    }

    async _extractTrack(filePath, streamIndex, outPath, priority = PRIORITY.HIGH) {
        const tmpPath = `${outPath}.tmp.m4a`;
        await ffmpegLimiter.run(() => new Promise((resolve, reject) => {
            const args = [
                '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                '-i', filePath,
                '-map', `0:a:${streamIndex}`,
                '-vn', '-sn', '-dn',
                '-c:a', 'aac',
                '-b:a', '160k',
                tmpPath
            ];
            const proc = spawn(this.ffmpegPath, args, { windowsHide: true });
            let stderr = '';
            const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, FFMPEG_TIMEOUT_MS);
            proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-STDERR_TAIL_BYTES); });
            proc.on('error', (e) => { clearTimeout(timer); reject(e); });
            proc.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) resolve();
                else reject(new Error(`Falha ao extrair a faixa de áudio ${streamIndex}: ${stderr.slice(-300)}`));
            });
        }), priority);
        try {
            fs.renameSync(tmpPath, outPath);
        } catch (e) {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
            throw e;
        }
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
     * @param {number} [params.priority=PRIORITY.HIGH] - Prioridade no FfmpegLimiter (HIGH: pedido do usuário; LOW: lote/regeneração)
     * @returns {Promise<Object>} Objeto de waveform { peaks, duration, peaks_per_second, stream_index }
     */
    async getOrGenerate({ uuid, filePath, duration = 0, peaksPerSecond = 100, streamIndex = 0, force = false, priority = PRIORITY.HIGH }) {
        if (!uuid || !filePath) throw new Error('uuid e filePath são obrigatórios.');

        // O cache guarda a resolução-mestre (ou maior): pedidos de taxa menor saem dele por redução
        if (!force) {
            const cached = await this.readCache(uuid, streamIndex, peaksPerSecond);
            if (cached && cached.peaks_per_second >= peaksPerSecond) return cached;
        }

        // Gera sempre na resolução-mestre (ou na pedida, se maior) e entrega reduzida à taxa pedida
        const genPps = Math.max(peaksPerSecond, MASTER_PEAKS_PER_SECOND);
        const key = `${uuid}:${streamIndex}:${genPps}`;
        let promise = this._inflight.get(key);
        if (!promise) {
            promise = this._generate({ uuid, filePath, duration, peaksPerSecond: genPps, streamIndex, priority })
                .finally(() => this._inflight.delete(key));
            this._inflight.set(key, promise);
        }
        const master = await promise;
        if (genPps === peaksPerSecond) return master;
        const reduced = reducePeaks(Uint8Array.from(master.peaks, (p) => Math.round(p * 255)), genPps, peaksPerSecond);
        return { ...master, peaks_per_second: peaksPerSecond, peaks: dequantize(reduced) };
    }

    async _generate({ uuid, filePath, duration, peaksPerSecond, streamIndex, priority = PRIORITY.HIGH }) {
        const quantized = await ffmpegLimiter.run(() => this._extractPeaks(filePath, peaksPerSecond, streamIndex), priority);
        const finalDuration = duration || (quantized.length / peaksPerSecond);

        await this._writeWfm(uuid, streamIndex, { peaksPerSecond, duration: finalDuration, quantized });
        // Cache JSON antigo (se houver) fica obsoleto
        fs.promises.unlink(this.getLegacyCachePath(uuid, streamIndex)).catch(() => {});

        return {
            version: 1,
            uuid,
            stream_index: streamIndex,
            duration: finalDuration,
            peaks_per_second: peaksPerSecond,
            peaks: dequantize(quantized)
        };
    }

    /**
     * Extrai os picos de amplitude (máximo absoluto por bloco) de um arquivo de mídia
     * via FFmpeg, decodificando para PCM 16-bit mono a 16kHz. Já devolve os picos
     * quantizados (Uint8Array, 0..255) — sem arrays de floats intermediários.
     * @private
     * @returns {Promise<Uint8Array>}
     */
    _extractPeaks(filePath, peaksPerSecond, streamIndex = 0) {
        const sampleRate = 16000; // Padrão do BDS para análise de áudio (Fase 6 reaproveita a mesma taxa)
        const samplesPerPeak = Math.max(1, Math.floor(sampleRate / peaksPerSecond));

        return new Promise((resolve, reject) => {
            const args = [
                '-nostdin', '-hide_banner', '-loglevel', 'error',
                '-i', filePath,
                '-map', `0:a:${streamIndex}`,
                '-vn', '-sn', '-dn',
                '-ac', '1',
                '-ar', String(sampleRate),
                '-f', 's16le',
                '-'
            ];

            const proc = spawn(this.ffmpegPath, args, { windowsHide: true });
            const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, FFMPEG_TIMEOUT_MS);

            // Buffer crescente de picos quantizados (1 byte por pico)
            let peaks = new Uint8Array(65536);
            let peakCount = 0;
            const pushPeak = (maxAbs) => {
                if (peakCount === peaks.length) {
                    const bigger = new Uint8Array(peaks.length * 2);
                    bigger.set(peaks);
                    peaks = bigger;
                }
                peaks[peakCount++] = Math.min(255, Math.round((maxAbs / 32768) * 255));
            };

            let carry = -1;        // byte baixo pendente de uma amostra cortada entre dois chunks
            let currentMax = 0;
            let sampleCount = 0;

            const processBuffer = (buf) => {
                let i = 0;
                const n = buf.length;
                if (carry >= 0 && n > 0) {
                    const v = ((carry | (buf[0] << 8)) << 16) >> 16;
                    const abs = v < 0 ? -v : v;
                    if (abs > currentMax) currentMax = abs;
                    if (++sampleCount >= samplesPerPeak) { pushPeak(currentMax); currentMax = 0; sampleCount = 0; }
                    carry = -1;
                    i = 1;
                }
                for (; i + 1 < n; i += 2) {
                    const v = ((buf[i] | (buf[i + 1] << 8)) << 16) >> 16; // Int16 little-endian
                    const abs = v < 0 ? -v : v;
                    if (abs > currentMax) currentMax = abs;
                    if (++sampleCount >= samplesPerPeak) { pushPeak(currentMax); currentMax = 0; sampleCount = 0; }
                }
                if (i < n) carry = buf[i]; // sobrou 1 byte (amostra incompleta)
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
            proc.stderr.on('data', (d) => { stderrOutput = (stderrOutput + d.toString()).slice(-STDERR_TAIL_BYTES); });

            proc.on('error', (err) => {
                clearTimeout(killTimer);
                reject(new Error(`Falha ao executar o motor de mídia: ${err.message}`));
            });

            proc.on('close', (code) => {
                clearTimeout(killTimer);
                if (code !== 0 && peakCount === 0) {
                    reject(new Error(`O motor de mídia finalizou com código ${code}: ${stderrOutput.slice(-500)}`));
                    return;
                }
                // Inclui o último bloco parcial, se houver amostras remanescentes
                if (sampleCount > 0) pushPeak(currentMax);
                resolve(peaks.slice(0, peakCount));
            });
        });
    }
}

WaveformService.reducePeaks = reducePeaks;
WaveformService.MASTER_PEAKS_PER_SECOND = MASTER_PEAKS_PER_SECOND;

module.exports = WaveformService;
