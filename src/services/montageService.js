const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const logger = require('./logService');
const hardwareDetection = require('../core/HardwareDetectionService');
const { ffmpegTool } = require('../infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');
const { processRunner } = require('../infrastructure/external-tools/ProcessRunner');
const { toolRunner } = require('../infrastructure/external-tools/ToolRunner');

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

        const mainCutDuration = item.finalDurationSeconds || Math.round(((item.durationSeconds || 1800) * pct) / 100);

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

    const { introPath, mainPath, outroPath, mainCutStart, mainCutDuration, resolution, fps, codec, quality, outputPath, totalDuration } = config;

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

    const processInput = (filePath, isMain) => {
        if (!filePath || !fs.existsSync(filePath)) return;
        
        const currentIdx = inputIndex;
        inputFiles.push(filePath);
        inputIndex++;
        
        let vFilter = '';
        let aFilter = '';
        
        if (isMain) {
            vFilter = `[${currentIdx}:v]trim=start=${mainCutStart}:duration=${mainCutDuration},setpts=PTS-STARTPTS[v${currentIdx}_trim];[v${currentIdx}_trim]`;
            aFilter = `[${currentIdx}:a]atrim=start=${mainCutStart}:duration=${mainCutDuration},asetpts=PTS-STARTPTS[a${currentIdx}_trim];[a${currentIdx}_trim]`;
        } else {
            vFilter = `[${currentIdx}:v]`;
            aFilter = `[${currentIdx}:a]`;
        }
        
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

    let args = ['-y'];
    // Decodificação acelerada apenas quando o usuário mantém HW habilitado
    const settingsHw = hardwareDetection.settings || {};
    if (settingsHw.useHardwareAcceleration !== false) args.push('-hwaccel', 'auto');
    inputFiles.forEach(f => args.push('-i', f));
    
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

        child.stdout.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            const outTimeMatch = text.match(/out_time_ms=(\d+)/);
            const speedMatch = text.match(/speed=\s*([\d.]+)x/);
            const fpsMatch = text.match(/fps=\s*([\d.]+)/);

            if (outTimeMatch && totalDuration > 0) {
                const currentSec = Number(outTimeMatch[1]) / 1000000;
                const percent = Math.min(100, (currentSec / totalDuration) * 100);
                
                this.emit('progress', {
                    percent,
                    currentFile: this.currentBatchItem ? this.currentBatchItem.currentFile : 1,
                    totalFiles: this.currentBatchItem ? this.currentBatchItem.totalFiles : 1,
                    speed: speedMatch ? `${speedMatch[1]}x` : '',
                    fps: fpsMatch ? fpsMatch[1] : ''
                });
            }
        });

        child.stderr.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            stderr += text;
            this.emit('log', text);
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
            this.currentProcess = null;
            removePartialOutput();
            reject(err);
        });
        child.on('close', (code) => {
            this.currentProcess = null;
            if (this.cancelRequested) {
                removePartialOutput();
                return resolve();
            }
            if (code === 0) {
                return resolve();
            }
            removePartialOutput();
            reject(new Error(`O motor de mídia finalizou com código ${code}`));
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
