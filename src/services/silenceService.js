const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const logger = require('./logService');
const hardwareDetection = require('../core/HardwareDetectionService');
const probeCache = require('../core/ffmpeg/ProbeCache');
const { ffmpegTool } = require('../infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');
const { processRunner } = require('../infrastructure/external-tools/ProcessRunner');

// Progresso/log para a UI no máximo a cada 250 ms; stderr guarda só o final (~8 KB)
const EMIT_THROTTLE_MS = 250;
const STDERR_TAIL_BYTES = 8192;
// Acima de CHUNK_THRESHOLD trechos a mantidos, o corte é feito em blocos de CHUNK_SIZE trechos
// (cada bloco decodifica só o seu intervalo) e unido com `-f concat -c copy`.
// Medido (3 min, 1080p, 300 trechos): 111 s no filtergraph único vs 40 s em blocos.
const CHUNK_THRESHOLD = 60;
const CHUNK_SIZE = 50;
// Linha de comando do Windows aceita ~32 K; grafos maiores vão para arquivo-script
const MAX_INLINE_GRAPH_CHARS = 24000;

const fmt = (n) => Number(n).toFixed(6);

class SilenceService extends EventEmitter {
  constructor({ paths, getSettings }) {
    super();
    this.paths = paths;
    this.getSettings = getSettings;
    this.currentProcess = null;
    this.cancelRequested = false;
    this.running = false;
    // Flag do ffmpeg para ler o grafo de um arquivo: '-/filter_complex' (ffmpeg >= 7) ou '-filter_complex_script' (antigo)
    this._scriptFlag = '-/filter_complex';
  }

  async probeFile(filePath) {
    return probeCache.getOrLoad(filePath, () => this._probeFileRaw(filePath), 'silence-probe');
  }

  async _probeFileRaw(filePath) {
    const ffprobe = ffprobeTool.resolve();
    return new Promise((resolve, reject) => {
      const child = spawn(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], { windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => stdout += chunk.toString());
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2048); });
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) return reject(new Error('Erro ao ler o arquivo'));
        let data;
        try {
          data = JSON.parse(stdout);
        } catch (e) {
          return reject(new Error(`Falha ao interpretar os dados do arquivo: ${e.message}`));
        }
        const streams = data.streams || [];
        const video = streams.find(s => s.codec_type === 'video');
        const audioStreams = streams.filter(s => s.codec_type === 'audio').map((s, idx) => ({
          index: idx,
          streamIndex: s.index,
          codec: s.codec_name,
          channels: s.channels || 2,
          sampleRate: s.sample_rate ? parseInt(s.sample_rate, 10) : 48000,
          title: s.tags?.title || s.tags?.handler_name || `Áudio ${idx + 1}`
        }));
        const firstAudio = audioStreams[0];
        resolve({
          duration: parseFloat(data.format?.duration || video?.duration || 0),
          isVideo: !!video,
          codec: video ? video.codec_name : (firstAudio ? firstAudio.codec : 'unknown'),
          width: video?.width || 0,
          height: video?.height || 0,
          audioChannels: firstAudio?.channels || 2,
          audioStreams
        });
      });
    });
  }

  /**
   * Detecta os silêncios decodificando SÓ a primeira faixa de áudio (-vn -map 0:a:0; antes o vídeo
   * inteiro era decodificado à toa: 8 s -> 0,2 s num vídeo 1080p de 3 min) e interpretando o stderr
   * linha a linha, sem acumular o texto completo.
   */
  async analyzeSilence(filePath, threshold, minDuration) {
    const ffmpeg = ffmpegTool.resolve();
    return new Promise((resolve, reject) => {
      const args = [
        '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
        '-i', filePath,
        '-vn', '-sn', '-dn', '-map', '0:a:0',
        '-af', `silencedetect=noise=${threshold}dB:d=${minDuration}`,
        '-f', 'null', '-'
      ];
      const child = spawn(ffmpeg, args, { windowsHide: true });
      this.currentProcess = child;

      const silences = [];
      let currentStart = null;
      let remainder = '';
      let tail = '';

      const parseLine = (line) => {
        if (line.indexOf('silence_') === -1) return;
        const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
        if (startMatch) currentStart = parseFloat(startMatch[1]);

        const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/);
        if (endMatch && currentStart !== null) {
          const start = Math.max(0, currentStart);
          const end = parseFloat(endMatch[1]);
          silences.push({ start, end, duration: end - start });
          currentStart = null;
        }
      };

      child.stderr.on('data', chunk => {
        const text = chunk.toString('utf8');
        tail = (tail + text).slice(-STDERR_TAIL_BYTES);
        const lines = (remainder + text).split(/\r\n|\n|\r/);
        remainder = lines.pop();
        for (const line of lines) parseLine(line);
      });

      child.on('error', reject);
      child.on('close', code => {
        if (this.currentProcess === child) this.currentProcess = null;
        if (remainder) parseLine(remainder);
        if (this.cancelRequested) return resolve(silences);
        if (code !== 0) {
          return reject(new Error(`Falha na análise de silêncio${tail ? `: ${tail.trim().slice(-300)}` : ''}`));
        }
        resolve(silences);
      });
    });
  }

  calculateKeepSegments(totalDuration, silences, mode) {
    // mode: remove, reduce05, reduce10
    const keepSegments = [];
    let currentTime = 0;

    let pad = 0;
    if (mode === 'reduce05') pad = 0.5;
    if (mode === 'reduce10') pad = 1.0;

    for (const sil of silences) {
        // Limit the pad so it doesn't exceed the silence duration
        const actualPad = Math.min(pad, sil.duration);
        const segmentEnd = sil.start + (actualPad / 2);

        if (segmentEnd > currentTime) {
            keepSegments.push({ start: currentTime, end: segmentEnd });
        }

        currentTime = sil.end - (actualPad / 2);
    }

    if (currentTime < totalDuration) {
        keepSegments.push({ start: currentTime, end: totalDuration });
    }

    return keepSegments;
  }

  /**
   * Grafo trim/atrim + concat para um conjunto de trechos. `offset` é subtraído dos tempos
   * (usado nos blocos, cuja entrada começa em -ss = offset).
   */
  _buildGraph(segments, isVideo, offset = 0) {
    const filterParts = [];
    let concatIn = '';
    segments.forEach((seg, idx) => {
      const start = fmt(seg.start - offset);
      const end = fmt(seg.end - offset);
      if (isVideo) {
        filterParts.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${idx}]`);
        concatIn += `[v${idx}]`;
      }
      filterParts.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${idx}]`);
      concatIn += `[a${idx}]`;
    });
    filterParts.push(isVideo
      ? `${concatIn}concat=n=${segments.length}:v=1:a=1[vfinal][afinal]`
      : `${concatIn}concat=n=${segments.length}:v=0:a=1[afinal]`);
    return filterParts.join(';');
  }

  /**
   * Executa o ffmpeg. Progresso (-progress pipe:1) interpretado por linha, pegando o último
   * out_time_ms; `onSeconds(sec)` e o log da UI saem com throttle de 250 ms; stderr limitado ao final.
   * Resolve { code, stderr } (nunca rejeita por código de saída).
   */
  _runFfmpeg(ffmpeg, args, onSeconds) {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { windowsHide: true });
      this.currentProcess = child;

      let stderr = '';
      let stdoutRemainder = '';
      let lastSec = null;
      let lastEmit = 0;
      let pendingLog = '';
      let logTimer = null;

      const flushLog = () => {
        if (logTimer) { clearTimeout(logTimer); logTimer = null; }
        if (pendingLog) {
          this.emit('log', pendingLog);
          pendingLog = '';
        }
      };

      child.stdout.on('data', chunk => {
        const lines = (stdoutRemainder + chunk.toString('utf8')).split(/\r?\n/);
        stdoutRemainder = lines.pop();
        for (const line of lines) {
          if (line.startsWith('out_time_ms=')) {
            const v = Number(line.slice(12));
            if (Number.isFinite(v) && v >= 0) lastSec = v / 1000000;
          }
        }
        const now = Date.now();
        if (lastSec !== null && onSeconds && now - lastEmit >= EMIT_THROTTLE_MS) {
          lastEmit = now;
          onSeconds(lastSec);
        }
      });

      child.stderr.on('data', chunk => {
        const text = chunk.toString('utf8');
        stderr = (stderr + text).slice(-STDERR_TAIL_BYTES);
        pendingLog = (pendingLog + text).slice(-STDERR_TAIL_BYTES);
        if (!logTimer) logTimer = setTimeout(flushLog, EMIT_THROTTLE_MS);
      });

      child.on('error', err => { flushLog(); reject(err); });
      child.on('close', code => {
        flushLog();
        if (this.currentProcess === child) this.currentProcess = null;
        resolve({ code, stderr });
      });
    });
  }

  /**
   * Roda uma passada de ffmpeg com grafo filter_complex. Grafos curtos vão inline (compatível com
   * qualquer ffmpeg); grafos longos vão para arquivo (-/filter_complex em ffmpeg >= 7, que removeu
   * -filter_complex_script; com fallback para a flag antiga).
   */
  async _runWithGraph(ffmpeg, preArgs, graph, postArgs, onSeconds, tmpDir, tag) {
    if (graph.length <= MAX_INLINE_GRAPH_CHARS) {
      return this._runFfmpeg(ffmpeg, [...preArgs, '-filter_complex', graph, ...postArgs], onSeconds);
    }
    const scriptPath = path.join(tmpDir, `silence_filter_${tag}.txt`);
    fs.writeFileSync(scriptPath, graph, 'utf8');
    let result = await this._runFfmpeg(ffmpeg, [...preArgs, this._scriptFlag, scriptPath, ...postArgs], onSeconds);
    if (result.code !== 0 && !this.cancelRequested && /Unrecognized option|Option not found/i.test(result.stderr)) {
      this._scriptFlag = this._scriptFlag === '-/filter_complex' ? '-filter_complex_script' : '-/filter_complex';
      result = await this._runFfmpeg(ffmpeg, [...preArgs, this._scriptFlag, scriptPath, ...postArgs], onSeconds);
    }
    return result;
  }

  async processQueue(config) {
    if (this.running) throw new Error('Já existe um processo em andamento.');
    this.running = true;
    this.cancelRequested = false;

    const ffmpeg = ffmpegTool.resolve();
    let processedCount = 0;
    let copiedCount = 0;

    try {
      const { files, threshold, minDuration, mode, outFolder } = config;

      for (let i = 0; i < files.length; i++) {
        if (this.cancelRequested) break;

        const filePath = files[i];
        const fileName = path.basename(filePath);
        this.emit('progress', { index: i + 1, total: files.length, file: fileName, percent: 0, status: 'Analisando...' });

        // Step 1: Probe
        const info = await this.probeFile(filePath);
        if (!info.duration) continue;

        // Step 2: Analyze Silence
        const silences = await this.analyzeSilence(filePath, threshold, minDuration);
        if (this.cancelRequested) break;

        // Mode detectOnly just continues
        if (mode === 'detectOnly') {
            this.emit('log', `\n[${fileName}] Encontrados ${silences.length} trechos silenciosos.\n`);
            continue;
        }

        let currentOutFolder = outFolder || path.join(path.dirname(filePath), 'EXPORTADO');
        if (!fs.existsSync(currentOutFolder)) {
          fs.mkdirSync(currentOutFolder, { recursive: true });
        }

        const ext = path.extname(filePath);
        const base = path.basename(filePath, ext);
        let finalFileName = `${base}_semsilencio${ext}`;
        if (config.outFileName) {
          if (files.length === 1) {
            finalFileName = config.outFileName;
            if (!path.extname(finalFileName)) finalFileName += ext;
          } else {
            const customExt = path.extname(config.outFileName) || ext;
            const customBase = path.basename(config.outFileName, customExt);
            finalFileName = `${customBase}_${i + 1}${customExt}`;
          }
        }
        const outPath = path.join(currentOutFolder, finalFileName);

        if (silences.length === 0) {
            this.emit('log', `\n[${fileName}] Nenhum silêncio detectado sob o limiar de ${threshold}dB. Exportando arquivo original para pasta de destino...\n`);
            fs.copyFileSync(filePath, outPath);
            copiedCount++;
            this.emit('progress', { index: i + 1, total: files.length, file: fileName, percent: 100, status: 'Exportado (sem silêncio)' });
            continue;
        }

        // Step 3: Calculate Segments to Keep
        const keepSegments = this.calculateKeepSegments(info.duration, silences, mode);
        const estimatedNewDuration = keepSegments.reduce((acc, seg) => acc + (seg.end - seg.start), 0);

        // Aplica preferências atuais do usuário para detecção de hardware
        if (typeof this.getSettings === 'function') {
            hardwareDetection.configure(this.getSettings());
        }

        // Argumentos comuns de saída (codec/mapeamento) calculados uma vez por arquivo
        const hwDecode = info.isVideo && (hardwareDetection.settings || {}).useHardwareAcceleration !== false;
        const outArgs = [];
        if (info.isVideo) {
            outArgs.push('-map', '[vfinal]', '-map', '[afinal]');
            const targetEncoder = await hardwareDetection.detectEncoder(ffmpeg, 'H.264');
            const qualityArgs = hardwareDetection.getQualitySettings(targetEncoder, 'Alta');
            outArgs.push('-c:v', targetEncoder, ...qualityArgs, '-c:a', 'aac');
        } else {
            outArgs.push('-map', '[afinal]');
            const extLower = ext.toLowerCase();
            if (extLower === '.mp3') {
                outArgs.push('-c:a', 'libmp3lame', '-b:a', '192k');
            } else if (extLower === '.wav') {
                outArgs.push('-c:a', 'pcm_s16le');
            } else if (extLower === '.flac') {
                outArgs.push('-c:a', 'flac');
            } else {
                outArgs.push('-c:a', 'aac', '-b:a', '192k');
            }
        }

        const baseArgs = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'warning'];
        if (hwDecode) baseArgs.push('-hwaccel', 'auto');
        const tailArgs = ['-progress', 'pipe:1', '-nostats'];

        const emitProgress = (doneSec) => (sec) => {
            const percent = estimatedNewDuration > 0 ? Math.min(100, ((doneSec + sec) / estimatedNewDuration) * 100) : 0;
            this.emit('progress', { index: i + 1, total: files.length, file: fileName, percent, status: 'Processando...' });
        };

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-silence-'));
        const cleanupTmp = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} };
        const removeEmptyOutput = () => {
            try { if (fs.existsSync(outPath) && fs.statSync(outPath).size === 0) fs.unlinkSync(outPath); } catch (e) {}
        };

        try {
            let result = null;

            // Muitos trechos: processa em blocos e une com concat (-c copy). Se falhar, cai no grafo único.
            if (keepSegments.length > CHUNK_THRESHOLD) {
                result = await this._cutInChunks({
                    ffmpeg, filePath, keepSegments, info, ext, outPath, baseArgs, outArgs, tailArgs, tmpDir, emitProgress
                });
                if (this.cancelRequested) break;
                if (result.code !== 0) {
                    logger.warn('silence:chunked-failed', { file: fileName, code: result.code, stderr: result.stderr.slice(-300) });
                    this.emit('log', `\n[${fileName}] Corte em blocos falhou; repetindo em passada única...\n`);
                    result = null;
                }
            }

            if (!result) {
                const graph = this._buildGraph(keepSegments, info.isVideo);
                result = await this._runWithGraph(
                    ffmpeg,
                    [...baseArgs, '-i', filePath],
                    graph,
                    [...outArgs, ...tailArgs, outPath],
                    emitProgress(0),
                    tmpDir,
                    'single'
                );
            }

            if (this.cancelRequested) break;
            if (result.code === 0) {
                if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
                    processedCount++;
                    continue;
                }
                removeEmptyOutput();
                throw new Error(`O motor de mídia gerou um arquivo de 0 bytes. Log: ${result.stderr.slice(-300)}`);
            }

            removeEmptyOutput();
            throw new Error(`Falha no motor de mídia (código ${result.code}): ${result.stderr.slice(-300)}`);
        } finally {
            cleanupTmp();
        }
      }

      if (this.cancelRequested) {
        this.emit('finished', { status: 'canceled', processedCount, copiedCount });
      } else {
        this.emit('finished', { status: 'success', processedCount, copiedCount });
      }

    } catch (err) {
      logger.error('silence:error', { error: err.message });
      this.emit('finished', { status: 'error', error: err.message });
    } finally {
      this.running = false;
      this.currentProcess = null;
    }
  }

  /**
   * Corte em blocos: cada bloco (CHUNK_SIZE trechos) lê só o seu intervalo (-ss/-t na entrada),
   * é codificado com os mesmos parâmetros e todos são unidos com `-f concat -c copy`.
   * Resolve { code, stderr } como _runFfmpeg.
   */
  async _cutInChunks({ ffmpeg, filePath, keepSegments, info, ext, outPath, baseArgs, outArgs, tailArgs, tmpDir, emitProgress }) {
    const blockExt = ext || '.mp4';
    const parts = [];
    let doneSec = 0;

    for (let i = 0; i < keepSegments.length; i += CHUNK_SIZE) {
      if (this.cancelRequested) return { code: -1, stderr: '' };
      const seg = keepSegments.slice(i, i + CHUNK_SIZE);
      const blockStart = seg[0].start;
      const blockEnd = seg[seg.length - 1].end;
      const blockPath = path.join(tmpDir, `block_${String(parts.length).padStart(4, '0')}${blockExt}`);
      const graph = this._buildGraph(seg, info.isVideo, blockStart);
      const result = await this._runWithGraph(
        ffmpeg,
        [...baseArgs, '-ss', fmt(blockStart), '-t', fmt(blockEnd - blockStart + 0.05), '-i', filePath],
        graph,
        [...outArgs, ...tailArgs, blockPath],
        emitProgress(doneSec),
        tmpDir,
        `b${parts.length}`
      );
      if (result.code !== 0) return result;
      parts.push(blockPath);
      doneSec += seg.reduce((acc, s) => acc + (s.end - s.start), 0);
    }

    const listPath = path.join(tmpDir, 'blocks.txt');
    fs.writeFileSync(
      listPath,
      parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8'
    );
    return this._runFfmpeg(
      ffmpeg,
      ['-y', '-nostdin', '-hide_banner', '-loglevel', 'warning', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath],
      null
    );
  }

  async cancel() {
    this.cancelRequested = true;
    if (this.currentProcess) {
      processRunner.cancel(this.currentProcess);
    }
  }
}

module.exports = SilenceService;
