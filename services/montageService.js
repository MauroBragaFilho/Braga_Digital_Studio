const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const logger = require('./logService');

class MontageService extends EventEmitter {
  constructor({ paths }) {
    super();
    this.paths = paths;
    this.currentProcess = null;
    this.cancelRequested = false;
    this.running = false;
  }

  isRunning() {
    return this.running;
  }

  async probeFile(filePath) {
    const ffprobe = path.join(this.paths.dataDir, 'ffprobe.exe');
    if (!fs.existsSync(ffprobe)) {
      throw new Error('ffprobe.exe não encontrado.');
    }

    return new Promise((resolve, reject) => {
      const child = spawn(
        ffprobe,
        [
          '-v', 'error',
          '-print_format', 'json',
          '-show_format',
          '-show_streams',
          filePath
        ],
        { windowsHide: true }
      );

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', chunk => stdout += chunk.toString('utf8'));
      child.stderr.on('data', chunk => stderr += chunk.toString('utf8'));

      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) {
          return reject(new Error(stderr || 'Erro ao ler arquivo com ffprobe.'));
        }
        try {
          const data = JSON.parse(stdout);
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

          resolve({
            duration: Number.isFinite(duration) ? duration : 0,
            width: videoStream?.width || 0,
            height: videoStream?.height || 0,
            fps: Number.isFinite(fps) ? fps : 0,
            hasAudio: data.streams.some(s => s.codec_type === 'audio')
          });
        } catch (err) {
          reject(new Error(`Falha ao ler JSON do ffprobe: ${err.message}`));
        }
      });
    });
  }

  async testEncoder(encoder) {
    return new Promise((resolve) => {
      const ffmpeg = path.join(this.paths.dataDir, 'ffmpeg.exe');
      const child = spawn(
        ffmpeg,
        [
          '-hide_banner',
          '-f', 'lavfi',
          '-i', 'nullsrc=s=64x64:d=1',
          '-c:v', encoder,
          '-f', 'null',
          '-'
        ],
        { windowsHide: true }
      );
      child.on('close', code => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  }

  async detectEncoder(codecChoice) {
    if (codecChoice === 'H.264') {
      if (await this.testEncoder('h264_nvenc')) return 'h264_nvenc';
      if (await this.testEncoder('h264_qsv')) return 'h264_qsv';
      if (await this.testEncoder('h264_amf')) return 'h264_amf';
      return 'libx264';
    }
    if (codecChoice === 'H.265' || codecChoice === 'HEVC') {
      if (await this.testEncoder('hevc_nvenc')) return 'hevc_nvenc';
      if (await this.testEncoder('hevc_qsv')) return 'hevc_qsv';
      if (await this.testEncoder('hevc_amf')) return 'hevc_amf';
      return 'libx265';
    }
    if (codecChoice === 'AV1') {
      if (await this.testEncoder('av1_nvenc')) return 'av1_nvenc';
      if (await this.testEncoder('av1_qsv')) return 'av1_qsv';
      if (await this.testEncoder('av1_amf')) return 'av1_amf';
      return 'libsvtav1';
    }
    return 'libx264';
  }

  getQualitySettings(encoder, quality) {
    // Quality mapping for CRF/Bitrate based on encoder type
    let cqArg = '-crf';
    let isHw = !encoder.startsWith('lib');
    if (encoder.includes('nvenc')) cqArg = '-cq';
    if (encoder.includes('qsv')) cqArg = '-global_quality';
    
    // Baixa, Média, Alta, Muito Alta
    // CRF/CQ values: Lower is better. 28=Baixa, 23=Média, 18=Alta, 14=Muito Alta
    let crfVal = '23';
    if (quality === 'Baixa') crfVal = '28';
    if (quality === 'Alta') crfVal = '18';
    if (quality === 'Muito Alta') crfVal = '14';

    const args = [];
    if (isHw) {
        if (encoder.includes('nvenc')) {
             args.push('-preset', 'p5', '-cq', crfVal);
        } else if (encoder.includes('qsv')) {
             args.push('-global_quality', crfVal);
        } else if (encoder.includes('amf')) {
             // AMF uses QP or quality usage
             args.push('-usage', 'transcoding', '-quality', 'quality', '-qp_i', crfVal, '-qp_p', crfVal);
        }
    } else {
        // CPU Encoders
        args.push('-preset', 'medium', '-crf', crfVal);
    }
    
    return args;
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
    }
  }

  async startMontage(config) {
    if (this.running) {
      throw new Error('Já existe um processo em andamento.');
    }
    this.running = true;
    this.cancelRequested = false;

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
    }
  }

  async runSingleRender(config) {
    const ffmpeg = path.join(this.paths.dataDir, 'ffmpeg.exe');
    if (!fs.existsSync(ffmpeg)) throw new Error('ffmpeg.exe não encontrado.');

    const { introPath, mainPath, outroPath, mainCutStart, mainCutDuration, resolution, fps, codec, quality, outputPath, totalDuration } = config;

    const resMap = {
        '720p': { w: 1280, h: 720 },
        '1080p': { w: 1920, h: 1080 },
        '1440p': { w: 2560, h: 1440 },
        '2160p': { w: 3840, h: 2160 }
    };
    const targetRes = resMap[resolution] || resMap['1080p'];
    
    // Detect encoder
    const targetEncoder = await this.detectEncoder(codec);
    const qualityArgs = this.getQualitySettings(targetEncoder, quality);

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
        const child = spawn(ffmpeg, args, { windowsHide: true });
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

        child.on('error', reject);
        child.on('close', (code) => {
            if (this.cancelRequested) {
                return resolve();
            }
            if (code === 0) {
                return resolve();
            }
            reject(new Error(`FFmpeg finalizou com código ${code}`));
        });
    });
  }

  async cancelMontage() {
    this.cancelRequested = true;
    if (!this.currentProcess) return { ok: true };
    
    await this.killProcessTree(this.currentProcess.pid);
    return { ok: true };
  }

  async killProcessTree(pid) {
    return new Promise((resolve) => {
      if (!pid) return resolve();
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        killer.on('close', () => resolve());
        killer.on('error', () => resolve());
      } else {
        try { process.kill(pid, 'SIGTERM'); } catch {}
        resolve();
      }
    });
  }
}

module.exports = MontageService;
