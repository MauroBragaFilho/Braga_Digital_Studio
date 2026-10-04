const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const logger = require('./logService');
const hardwareDetection = require('../core/HardwareDetectionService');
const { ffmpegTool } = require('../infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');
const { processRunner } = require('../infrastructure/external-tools/ProcessRunner');
const { toolRunner } = require('../infrastructure/external-tools/ToolRunner');
const probeCache = require('../core/ffmpeg/ProbeCache');
const { uniqueOutputPath, isSamePath } = require('./uniquePath');

// Progresso/log para a UI no máximo a cada 250 ms; stderr guarda só o final (~8 KB)
const EMIT_THROTTLE_MS = 250;
const STDERR_TAIL_BYTES = 8192;

class MontageService extends EventEmitter {
  constructor({ paths, getSettings }) {
    super();
    this.paths = paths;
    this.getSettings = getSettings;
    this.currentProcess = null;
    this.currentJobId = null;
    this.currentBatchItem = null;
    this.cancelRequested = false;
    this.running = false;
  }

  isRunning() {
    return this.running;
  }

  async probeFile(filePath) {
    return probeCache.getOrLoad(filePath, () => this._probeFileRaw(filePath), 'montage-probe');
  }

  async _probeFileRaw(filePath) {
    const ffprobe = ffprobeTool.resolve();

    let result;
    try {
      result = await toolRunner.run(ffprobe, [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ], { timeout: 30000 });
    } catch (err) {
      if (/^Timeout/.test(err.message)) throw new Error('Tempo limite excedido ao ler o arquivo.');
      throw err;
    }

    if (result.code !== 0) {
      throw new Error(result.stderr || 'Erro ao ler o arquivo.');
    }

    try {
      const data = JSON.parse(result.stdout);
      const videoStream = data.streams.find(s => s.codec_type === 'video');

      let duration = parseFloat(data.format?.duration || 0);
      if (duration === 0 && videoStream?.duration) {
        duration = parseFloat(videoStream.duration);
      }

      let fps = 0;
      if (videoStream && videoStream.r_frame_rate) {
        const [num, den] = videoStream.r_frame_rate.split('/');
        if (den && num) {
          fps = parseFloat(num) / parseFloat(den);
        }
      }

      return {
        duration: Number.isFinite(duration) ? duration : 0,
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        fps: Number.isFinite(fps) ? fps : 0,
        hasAudio: data.streams.some(s => s.codec_type === 'audio')
      };
    } catch (err) {
      throw new Error(`Falha ao interpretar os dados do arquivo: ${err.message}`);
    }
  }

  async enqueueMontage(config) {
    if (this.running) {
      throw new Error('Já existe um processo de montagem em andamento.');
    }

    const items = config.items || [];
    if (items.length === 0) {
      throw new Error('Nenhum vídeo principal foi fornecido para a montagem.');
    }

    const destFolder = config.destFolder || path.join(require('os').homedir(), 'Videos', 'Montagem');
    if (!fs.existsSync(destFolder)) {
      fs.mkdirSync(destFolder, { recursive: true });
    }

    const totalCount = items.length;
    logger.info('montage:batch-start', { totalCount, destFolder });
    
    this.running = true;
    this.cancelRequested = false;
    this.currentJobId = config.jobId || null;

    try {
      for (let i = 0; i < totalCount; i++) {
        if (this.cancelRequested) break;

        const item = items[i];
        const rawName = item.name || `Video_${i + 1}`;
        const baseName = rawName.replace(/\.[^/.]+$/, ''); // Remove extensão
        const pct = item.pctUsed || 100;
        const ext = (config.format || 'mp4').toLowerCase();
        
        // Nome no formato solicitado: "(nome do vídeo principal) + (porcentagem do vídeo)"
        const outputFileName = `${baseName} - ${pct}%.${ext}`;
        const outputPath = path.join(destFolder, outputFileName);

        // Sem duração informada, mede com o ffprobe: nada de assumir 1800 s
        let knownDuration = Number(item.durationSeconds) > 0 ? Number(item.durationSeconds) : 0;
        if (!item.finalDurationSeconds && !knownDuration) {
          const probed = await this.probeFile(item.path);
          knownDuration = probed && probed.duration > 0 ? probed.duration : 0;
          if (!knownDuration) throw new Error(`Duração desconhecida no vídeo principal: ${baseName}`);
        }
        const mainCutDuration = item.finalDurationSeconds || Math.max(1, Math.round((knownDuration * pct) / 100));

        const singleConfig = {
          introPath: config.introPath,
          mainPath: item.path,
          outroPath: config.outroPath,
          mainCutStart: 0,
          mainCutDuration: mainCutDuration,
          resolution: config.resolution || '1080p',
          fps: config.fps || '30',
          codec: config.codec || 'H.264',
          quality: config.quality || 'Alta',
          outputPath: outputPath,
          totalDuration: mainCutDuration
        };

        this.currentBatchItem = { currentFile: i + 1, totalFiles: totalCount, fileName: outputFileName };

        this.emit('progress', {
          currentFile: i + 1,
          totalFiles: totalCount,
          percent: 0,
          fileName: outputFileName
        });

        this.emit('log', `Processando arquivo [${i + 1}/${totalCount}]: ${outputFileName}`);
        await this.runSingleRender(singleConfig);
      }

      this.emit('finished', { status: 'batch-success', total: totalCount });
      return { ok: true, count: totalCount };
    } catch (err) {
      logger.error('montage:batch-error', { error: err.message });
      this.emit('finished', { status: 'error', error: err.message });
      throw err;
    } finally {
      this.running = false;
      this.currentProcess = null;
      this.currentBatchItem = null;
      this.currentJobId = null;
    }
  }

  async startMontage(config) {
    if (this.running) {
      throw new Error('Já existe um processo em andamento.');
    }
    this.running = true;
    this.cancelRequested = false;
    this.currentJobId = config.jobId || null;

    try {
      await this.runSingleRender(config);
      this.emit('finished', { status: 'success' });
      return { ok: true };
    } catch (err) {
      this.emit('finished', { status: 'error', error: err.message });
      throw err;
    } finally {
      this.running = false;
      this.currentProcess = null;
      this.currentJobId = null;
    }
  }

  async runSingleRender(config) {
    const ffmpeg = ffmpegTool.resolve();

    const { introPath, mainPath, outroPath, mainCutStart, mainCutDuration, resolution, fps, codec, quality, totalDuration } = config;
    if (!config.outputPath) throw new Error('Arquivo de saída não informado.');
    // Nunca sobrescreve: se já existir (ou for um dos arquivos de entrada) usa "nome (2).ext"
    const outputPath = uniqueOutputPath(path.dirname(config.outputPath), path.basename(config.outputPath), {
      avoid: [introPath, mainPath, outroPath].filter(Boolean)
    });
    if ([introPath, mainPath, outroPath].some((p) => p && isSamePath(p, outputPath))) {
      throw new Error('O arquivo de saída coincide com um arquivo de entrada.');
    }

    const resMap = {
        '720p': { w: 1280, h: 720 },
        '1080p': { w: 1920, h: 1080 },
        '1440p': { w: 2560, h: 1440 },
        '2160p': { w: 3840, h: 2160 }
    };
    const targetRes = resMap[resolution] || resMap['1080p'];
    
    // Detect encoder (respeita preferências de aceleração de hardware do usuário)
    if (typeof this.getSettings === 'function') {
      hardwareDetection.configure(this.getSettings());
    }
    const targetEncoder = await hardwareDetection.detectEncoder(ffmpeg, codec);
    const qualityArgs = hardwareDetection.getQualitySettings(targetEncoder, quality);

    // Building the Filtergraph
    let filterParts = [];
    let concatVideoInputs = [];
    let concatAudioInputs = [];
    let inputFiles = [];
    let inputIndex = 0;

    // Antes de montar o grafo: todo arquivo informado precisa existir e ter duração conhecida (> 0).
    // Nada de ignorar silenciosamente um arquivo ausente nem de assumir duração padrão.
    const probes = new Map();
    let effectiveTotal = 0;
    for (const [label, filePath, isMain] of [['abertura', introPath, false], ['vídeo principal', mainPath, true], ['finalização', outroPath, false]]) {
        if (!filePath) continue;
        if (!fs.existsSync(filePath)) throw new Error(`Arquivo de ${label} não encontrado: ${filePath}`);
        let info;
        try {
            info = await this.probeFile(filePath);
        } catch (err) {
            throw new Error(`Não foi possível ler o arquivo de ${label} (${path.basename(filePath)}): ${err.message}`);
        }
        if (!(info && info.duration > 0)) throw new Error(`Duração desconhecida no arquivo de ${label}: ${path.basename(filePath)}`);
        let effDur = info.duration;
        if (isMain) {
            const start = Number(mainCutStart) > 0 ? Number(mainCutStart) : 0;
            const avail = info.duration - start;
            if (avail <= 0) throw new Error(`O início do corte (${start}s) está além do fim do vídeo principal (${info.duration.toFixed(1)}s).`);
            effDur = Number(mainCutDuration) > 0 ? Math.min(Number(mainCutDuration), avail) : avail;
        }
        probes.set(filePath, { hasAudio: info.hasAudio !== false, effDur });
        effectiveTotal += effDur;
    }
    if (!mainPath) throw new Error('Vídeo principal não informado.');
    const progressTotal = effectiveTotal > 0 ? effectiveTotal : totalDuration;

    const processInput = (filePath, isMain) => {
        if (!filePath) return;
        const probe = probes.get(filePath);

        const currentIdx = inputIndex;
        // Corte do vídeo principal (início/duração) aplicado na ENTRADA (-ss/-t): o ffmpeg busca o ponto
        // e decodifica só o trecho, em vez de decodificar tudo e descartar frames com trim.
        const inputOpts = [];
        if (isMain) {
            if (Number(mainCutStart) > 0) inputOpts.push('-ss', String(mainCutStart));
            if (Number(mainCutDuration) > 0) inputOpts.push('-t', String(mainCutDuration));
        }
        inputFiles.push({ path: filePath, opts: inputOpts });
        inputIndex++;

        let vFilter = `[${currentIdx}:v]`;
        // Entrada sem trilha de áudio: gera silêncio com a mesma duração (o concat exige áudio em todas)
        let aFilter = probe.hasAudio ? `[${currentIdx}:a]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${probe.effDur.toFixed(3)},asetpts=PTS-STARTPTS,`;

        vFilter += `scale=${targetRes.w}:${targetRes.h}:force_original_aspect_ratio=decrease,pad=${targetRes.w}:${targetRes.h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
        if (fps !== 'Manter original') {
            vFilter += `,fps=${fps}`;
        }
        vFilter += `[vout${currentIdx}]`;
        
        aFilter += `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout${currentIdx}]`;
        
        filterParts.push(vFilter);
        filterParts.push(aFilter);
        
        concatVideoInputs.push(`[vout${currentIdx}]`);
        concatAudioInputs.push(`[aout${currentIdx}]`);
    };

    processInput(introPath, false);
    processInput(mainPath, true);
    processInput(outroPath, false);

    if (inputIndex === 0) throw new Error("Nenhum arquivo válido fornecido.");

    const numInputs = concatVideoInputs.length;
    let concatStr = '';
    for (let i = 0; i < numInputs; i++) {
        concatStr += `${concatVideoInputs[i]}${concatAudioInputs[i]}`;
    }
    concatStr += `concat=n=${numInputs}:v=1:a=1[vfinal][afinal]`;
    filterParts.push(concatStr);

    const filterComplex = filterParts.join(';');

    let args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'warning'];
    // Decodificação acelerada apenas quando o usuário mantém HW habilitado
    const settingsHw = hardwareDetection.settings || {};
    if (settingsHw.useHardwareAcceleration !== false) args.push('-hwaccel', 'auto');
    inputFiles.forEach(f => args.push(...f.opts, '-i', f.path));
    
    args.push('-filter_complex', filterComplex);
    args.push('-map', '[vfinal]', '-map', '[afinal]');
    args.push('-c:v', targetEncoder);
    args.push(...qualityArgs);
    args.push('-c:a', 'aac', '-b:a', '192k');
    args.push('-progress', 'pipe:1', '-nostats');
    args.push(outputPath);

    logger.info('montage:start-single', { encoder: targetEncoder, resolution, inputs: inputIndex });

    return new Promise((resolve, reject) => {
        const child = processRunner.spawn(ffmpeg, args);
        this.currentProcess = child;
        
        let stderr = '';
        let stdoutRemainder = '';
        let lastEmit = 0;
        let pendingLog = '';
        let logTimer = null;
        const flushLog = () => {
            if (logTimer) { clearTimeout(logTimer); logTimer = null; }
            if (pendingLog) { this.emit('log', pendingLog); pendingLog = ''; }
        };

        child.stdout.on('data', (chunk) => {
            // Linhas completas apenas (um chunk pode cortar "out_time_ms=123" ao meio); vale o ÚLTIMO valor.
            const lines = (stdoutRemainder + chunk.toString('utf8')).split(/\r?\n/);
            stdoutRemainder = lines.pop();

            let outTimeUs = null;
            let speed = '';
            let fpsVal = '';
            for (const line of lines) {
                if (line.startsWith('out_time_ms=')) {
                    const v = Number(line.slice(12));
                    if (Number.isFinite(v) && v >= 0) outTimeUs = v;
                } else if (line.startsWith('speed=')) {
                    const m = /speed=\s*([\d.]+)x/.exec(line);
                    if (m) speed = `${m[1]}x`;
                } else if (line.startsWith('fps=')) {
                    fpsVal = line.slice(4).trim();
                }
            }

            const now = Date.now();
            if (outTimeUs !== null && progressTotal > 0 && now - lastEmit >= EMIT_THROTTLE_MS) {
                lastEmit = now;
                const currentSec = outTimeUs / 1000000;
                // 99% no máximo até o ffmpeg encerrar de fato (evita "100%" antes de gravar o final)
                const percent = Math.min(99, (currentSec / progressTotal) * 100);

                this.emit('progress', {
                    percent,
                    currentFile: this.currentBatchItem ? this.currentBatchItem.currentFile : 1,
                    totalFiles: this.currentBatchItem ? this.currentBatchItem.totalFiles : 1,
                    speed,
                    fps: fpsVal
                });
            }
        });

        child.stderr.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            stderr = (stderr + text).slice(-STDERR_TAIL_BYTES);
            pendingLog = (pendingLog + text).slice(-STDERR_TAIL_BYTES);
            if (!logTimer) logTimer = setTimeout(flushLog, EMIT_THROTTLE_MS);
        });

        // Remove o arquivo de saída parcial (ffmpeg interrompido/falho deixa um contêiner inválido)
        const removePartialOutput = () => {
            try {
                if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            } catch (cleanupErr) {
                logger.warn('montage:cleanup', { error: cleanupErr.message });
            }
        };

        child.on('error', (err) => {
            flushLog();
            this.currentProcess = null;
            removePartialOutput();
            reject(err);
        });
        child.on('close', (code) => {
            flushLog();
            this.currentProcess = null;
            if (this.cancelRequested) {
                removePartialOutput();
                return resolve();
            }
            if (code === 0) {
                return resolve();
            }
            removePartialOutput();
            reject(new Error(`O motor de mídia finalizou com código ${code}${stderr ? `: ${stderr.trim().slice(-300)}` : ''}`));
        });
    });
  }

  async cancelMontage() {
    this.cancelRequested = true;
    if (!this.currentProcess) return { ok: true };

    // Mata a árvore e espera o término real (o 'close' remove o arquivo parcial)
    await this.killProcessTree(this.currentProcess);
    return { ok: true };
  }

  /** @param {import('child_process').ChildProcess|number} childOrPid */
  async killProcessTree(childOrPid) {
    if (!childOrPid) return;
    await processRunner.cancel(childOrPid);
  }

  /** O id informado pelo renderer identifica o job em andamento? (ids ausentes/'current' valem para o atual) */
  _matchesCurrentJob(id) {
    if (!this.running) return false;
    if (id === undefined || id === null || id === '' || id === 'current') return true;
    return id === this.currentJobId || id === this.currentBatchItem?.fileName;
  }

  /**
   * API de fila exposta pelo preload (montage:cancelJob, montage:removeJob,
   * montage:clearQueue, montage:getQueue).
   *
   * A engine é monoprocesso (lote síncrono): há no máximo UM job ativo, identificado por
   * `config.jobId` (informado pelo renderer em enqueueMontage), 'current' ou o nome do arquivo
   * de saída. Ids que não casam com o job ativo NÃO cancelam nada.
   */

  async cancelJob(id) {
    if (!this._matchesCurrentJob(id)) {
      return { ok: false, error: 'Job não encontrado ou já finalizado.' };
    }
    const result = await this.cancelMontage();
    this.emit('queue-updated', await this.getQueue());
    return result;
  }

  async removeJob(id) {
    // Remover o job ativo equivale a cancelá-lo; qualquer outro id não existe na fila.
    if (!this._matchesCurrentJob(id)) return { ok: true, removed: 0 };
    await this.cancelMontage();
    this.emit('queue-updated', await this.getQueue());
    return { ok: true, removed: 1 };
  }

  async clearQueue() {
    // Limpar a fila = cancelar o lote em andamento (não há itens pendentes persistidos).
    if (!this.running) return { ok: true, cleared: 0 };
    await this.cancelMontage();
    this.emit('queue-updated', await this.getQueue());
    return { ok: true, cleared: 1 };
  }

  async getQueue() {
    if (!this.running) return [];
    return [
      {
        id: 'current',
        name: this.currentBatchItem?.fileName || 'Montagem em andamento',
        status: 'running',
        current: this.currentBatchItem?.currentFile || 1,
        total: this.currentBatchItem?.totalFiles || 1,
        percent: 0
      }
    ];
  }
}

module.exports = MontageService;
