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
const { uniqueOutputPath, isSamePath } = require('./uniquePath');

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
        // Capa de álbum (attached_pic) aparece como "vídeo" no ffprobe: o arquivo continua sendo só áudio
        const video = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
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
          duration: parseFloat(data.format?.duration || video?.duration || 0) || 0,
          hasAudio: audioStreams.length > 0,
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
  async analyzeSilence(filePath, threshold, minDuration, totalDuration = 0) {
    const ffmpeg = ffmpegTool.resolve();
    return new Promise((resolve, reject) => {
      const th = Number(threshold);
      const md = Number(minDuration);
      if (!Number.isFinite(th) || th > 0 || th < -120) return reject(new Error('Sensibilidade inválida (use um valor entre -120 e 0 dB).'));
      if (!Number.isFinite(md) || md < 0.01 || md > 3600) return reject(new Error('Duração mínima inválida.'));
      const args = [
        '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
        '-i', filePath,
        '-vn', '-sn', '-dn', '-map', '0:a:0',
        '-af', `silencedetect=noise=${th}dB:d=${md}`,
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
        if (startMatch) {
          const v = parseFloat(startMatch[1]);
          if (Number.isFinite(v)) currentStart = v;
        }

        const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/);
        if (endMatch && currentStart !== null) {
          const start = Math.max(0, currentStart);
          const end = parseFloat(endMatch[1]);
          currentStart = null;
          // Números inválidos ou faixa invertida/vazia são descartados (não geram corte)
          if (Number.isFinite(end) && end > start && (!(totalDuration > 0) || start < totalDuration + 1)) {
            silences.push({ start, end: totalDuration > 0 ? Math.min(end, totalDuration) : end, duration: (totalDuration > 0 ? Math.min(end, totalDuration) : end) - start });
          }
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
        // Silêncio que vai até o fim do arquivo: o silencedetect emite só silence_start (sem silence_end)
        if (code === 0 && currentStart !== null && totalDuration > 0) {
          const start = Math.max(0, currentStart);
          if (start < totalDuration) silences.push({ start, end: totalDuration, duration: totalDuration - start });
        }
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

    // Descarta trechos de poucos milissegundos (trim vazio quebraria o concat)
    return keepSegments.filter(seg => seg.end - seg.start >= 0.01);
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

    let processedCount = 0;
    let copiedCount = 0;
    let detectedCount = 0;
    let lastFile = null;
    const skipped = [];
    const failed = [];
    const reservedOutputs = new Set();

    try {
      // Dentro do try: se o ffmpeg não for encontrado, o erro vira 'finished' e o serviço sai de "em andamento"
      const ffmpeg = ffmpegTool.resolve();
      const { files, mode, outFolder } = config;
      const threshold = Number(config.threshold);
      const minDuration = Number(config.minDuration);
      if (!Array.isArray(files) || files.length === 0) throw new Error('Nenhum arquivo informado.');
      if (!Number.isFinite(threshold) || threshold > 0 || threshold < -120) throw new Error('Sensibilidade inválida (use um valor entre -120 e 0 dB).');
      if (!Number.isFinite(minDuration) || minDuration < 0.01 || minDuration > 3600) throw new Error('Duração mínima inválida.');

      for (let i = 0; i < files.length; i++) {
        if (this.cancelRequested) break;

        const filePath = files[i];
        const fileName = path.basename(filePath);
        const reportItem = (status, extra = {}) => this.emit('progress', { index: i + 1, total: files.length, file: fileName, percent: 0, status, ...extra });
        // Pula o arquivo com aviso (não derruba o lote)
        const skipFile = (reason) => {
          skipped.push({ file: filePath, reason });
          this.emit('log', `\n[${fileName}] Ignorado: ${reason}\n`);
          reportItem('Ignorado', { message: reason });
        };
        reportItem('Analisando...');

        try {
        if (!fs.existsSync(filePath)) { skipFile('arquivo não encontrado.'); continue; }

        // Step 1: Probe
        const info = await this.probeFile(filePath);
        if (this.cancelRequested) break;
        if (!info.duration) { skipFile('não foi possível obter a duração do arquivo.'); continue; }
        if (info.hasAudio === false || (info.audioStreams && info.audioStreams.length === 0)) {
          skipFile('o arquivo não tem faixa de áudio (nada a analisar).');
          continue;
        }

        // Step 2: Analyze Silence
        const silences = await this.analyzeSilence(filePath, threshold, minDuration, info.duration);
        if (this.cancelRequested) break;

        // Mode detectOnly just continues
        const silenceSeconds = silences.reduce((acc, s) => acc + Math.max(0, s.duration || 0), 0);
        if (mode === 'detectOnly') {
            detectedCount++;
            this.emit('log', `\n[${fileName}] Encontrados ${silences.length} trechos silenciosos.\n`);
            reportItem('Analisado', { percent: 100, silenceSeconds });
            continue;
        }

        const currentOutFolder = outFolder || path.join(path.dirname(filePath), 'EXPORTADO');
        if (!fs.existsSync(currentOutFolder)) {
          fs.mkdirSync(currentOutFolder, { recursive: true });
        }

        const ext = path.extname(filePath);
        const extLower = ext.toLowerCase();
        // Contêiner da saída compatível com o codec: vídeo sempre H.264/AAC (.webm e afins viram .mp4);
        // áudio mantém a extensão quando há encoder correspondente, senão vira .m4a (AAC)
        const AUDIO_CODECS = {
          '.mp3': ['libmp3lame', '-b:a', '192k'],
          '.wav': ['pcm_s16le'],
          '.flac': ['flac'],
          '.m4a': ['aac', '-b:a', '192k'],
          '.aac': ['aac', '-b:a', '192k'],
          '.ogg': ['libopus', '-b:a', '128k'],
          '.opus': ['libopus', '-b:a', '128k'],
          '.webm': ['libopus', '-b:a', '128k']
        };
        const outExt = info.isVideo
          ? (['.mp4', '.mkv', '.mov'].includes(extLower) ? ext : '.mp4')
          : (AUDIO_CODECS[extLower] ? ext : '.m4a');
        const base = path.basename(filePath, ext);
        let stem = `${base}_semsilencio`;
        if (config.outFileName) {
          const customExt = path.extname(config.outFileName);
          const customBase = customExt ? path.basename(config.outFileName, customExt) : config.outFileName;
          stem = files.length === 1 ? customBase : `${customBase}_${i + 1}`;
        }
        // Nunca sobrescreve: nome já existente (ou arquivo de origem do lote) vira "nome (2).ext"
        const pickOutput = (extension) => uniqueOutputPath(currentOutFolder, `${stem}${extension}`, { avoid: files, reserved: reservedOutputs });

        if (silences.length === 0) {
            const copyPath = pickOutput(ext);
            if (isSamePath(copyPath, filePath)) throw new Error('O destino é o próprio arquivo de origem.');
            this.emit('log', `\n[${fileName}] Nenhum silêncio detectado sob o limiar de ${threshold}dB. Exportando arquivo original para pasta de destino...\n`);
            fs.copyFileSync(filePath, copyPath, fs.constants.COPYFILE_EXCL);
            copiedCount++;
            lastFile = path.basename(copyPath);
            reportItem('Exportado (sem silêncio)', { percent: 100, silenceSeconds: 0, newDuration: info.duration });
            continue;
        }

        // Step 3: Calculate Segments to Keep
        const keepSegments = this.calculateKeepSegments(info.duration, silences, mode);
        const estimatedNewDuration = keepSegments.reduce((acc, seg) => acc + (seg.end - seg.start), 0);
        if (keepSegments.length === 0 || estimatedNewDuration < 0.05) {
          skipFile('o arquivo é inteiramente silencioso sob o limiar escolhido (nada restaria).');
          continue;
        }
        const outPath = pickOutput(outExt);
        reportItem('Processando...', { percent: 0, silenceSeconds, newDuration: estimatedNewDuration });

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
            outArgs.push('-c:a', ...(AUDIO_CODECS[extLower] || ['aac', '-b:a', '192k']));
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
        let outputOk = false;
        const removePartialOutput = () => {
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e) {}
        };

        try {
            let result = null;

            // Muitos trechos: processa em blocos e une com concat (-c copy). Se falhar, cai no grafo único.
            if (keepSegments.length > CHUNK_THRESHOLD) {
                result = await this._cutInChunks({
                    ffmpeg, filePath, keepSegments, info, ext: outExt, outPath, baseArgs, outArgs, tailArgs, tmpDir, emitProgress
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
                    outputOk = true;
                    lastFile = path.basename(outPath);
                    reportItem('Concluído', { percent: 100 });
                    continue;
                }
                throw new Error(`O motor de mídia gerou um arquivo de 0 bytes. Log: ${result.stderr.slice(-300)}`);
            }

            throw new Error(`Falha no motor de mídia (código ${result.code}): ${result.stderr.slice(-300)}`);
        } finally {
            // Cancelamento/falha: apaga a saída parcial (o nome é sempre novo, nunca um arquivo do usuário)
            if (!outputOk) removePartialOutput();
            cleanupTmp();
        }
        } catch (fileErr) {
          // Erro em um arquivo não derruba o lote: registra e segue para o próximo
          if (this.cancelRequested) break;
          const message = String(fileErr.message || fileErr).split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 300);
          failed.push({ file: filePath, error: message });
          logger.error('silence:file:error', { file: filePath, error: message });
          this.emit('log', `\n[${fileName}] Erro: ${message}\n`);
          reportItem('Erro', { message });
        }
      }

      const summary = { processedCount, copiedCount, detectedCount, lastFile, skipped, failed };
      if (this.cancelRequested) {
        this.emit('finished', { status: 'canceled', ...summary });
      } else if (processedCount + copiedCount + detectedCount === 0 && (failed.length || skipped.length)) {
        const first = failed[0]?.error || skipped[0]?.reason;
        this.emit('finished', { status: 'error', error: failed.length ? `Nenhum arquivo foi processado. ${first}` : `Nenhum arquivo foi processado: ${first}`, ...summary });
      } else {
        this.emit('finished', { status: failed.length || skipped.length ? 'partial' : 'success', ...summary });
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
