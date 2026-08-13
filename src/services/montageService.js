const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { v4: uuidv4 } = require('uuid');

class MontageService extends EventEmitter {
  constructor({ paths }) {
    super();
    this.paths = paths;
    this.queue = [];
    this.currentJob = null;
    this.currentProcess = null;
    this.cancelRequested = false;
  }

  getQueue() {
    return this.queue;
  }

  async probeFile(filePath) {
    const ffprobe = path.join(this.paths.dataDir, 'ffprobe.exe');
    if (!fs.existsSync(ffprobe)) throw new Error('ffprobe.exe não encontrado.');

    return new Promise((resolve, reject) => {
      const child = spawn(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], { windowsHide: true });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', chunk => stdout += chunk.toString('utf8'));
      child.stderr.on('data', chunk => stderr += chunk.toString('utf8'));
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) return reject(new Error(stderr || 'Erro no ffprobe.'));
        try {
          const data = JSON.parse(stdout);
          const videoStream = data.streams.find(s => s.codec_type === 'video');
          let duration = parseFloat(data.format?.duration || 0);
          if (duration === 0 && videoStream?.duration) duration = parseFloat(videoStream.duration);
          resolve({ filename: path.basename(filePath), duration });
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  async testEncoder(encoder) {
    const ffmpeg = path.join(this.paths.dataDir, 'ffmpeg.exe');
    return new Promise(resolve => {
      const child = spawn(ffmpeg, ['-f', 'lavfi', '-i', 'nullsrc=s=128x128:d=1', '-c:v', encoder, '-f', 'null', '-'], { windowsHide: true });
      child.on('close', code => resolve(code === 0));
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
    return 'libx264';
  }

  getQualitySettings(encoder, quality) {
    let cqArg = '-crf';
    let isHw = !encoder.startsWith('lib');
    if (encoder.includes('nvenc')) cqArg = '-cq';
    if (encoder.includes('qsv')) cqArg = '-global_quality';
    
    let crfVal = '23';
    if (quality === 'Baixa') crfVal = '28';
    if (quality === 'Alta') crfVal = '18';
    if (quality === 'Muito Alta') crfVal = '14';

    const args = [];
    if (isHw) {
        if (encoder.includes('nvenc')) args.push('-preset', 'p5', '-cq', crfVal);
        else if (encoder.includes('qsv')) args.push('-preset', 'medium', '-global_quality', crfVal);
        else if (encoder.includes('amf')) args.push('-quality', 'quality');
    } else {
        args.push('-preset', 'medium', '-crf', crfVal);
    }
    return args;
  }

  enqueueMontage(config) {
    const job = {
      id: uuidv4(),
      config,
      status: 'PENDING', // PENDING, PROCESSING, DONE, ERROR
      progress: 0,
      createdAt: Date.now()
    };
    
    this.queue.push(job);
    this._broadcastQueue();
    this._processNext();
    return job.id;
  }

  cancelJob(id) {
    const job = this.queue.find(j => j.id === id);
    if (!job) return;

    if (job.status === 'PENDING') {
      this.queue = this.queue.filter(j => j.id !== id);
      this._broadcastQueue();
    } else if (job.status === 'PROCESSING' && this.currentJob && this.currentJob.id === id) {
      this.cancelRequested = true;
      if (this.currentProcess) {
        this.currentProcess.kill('SIGTERM'); // Isso parará o FFmpeg e lançará erro no loop
      }
    }
  }

  removeJob(id) {
    this.queue = this.queue.filter(j => j.id !== id);
    this._broadcastQueue();
  }

  clearQueue() {
    this.queue = this.queue.filter(j => j.status === 'PENDING' || j.status === 'PROCESSING');
    this._broadcastQueue();
  }

  _broadcastQueue() {
    this.emit('queue-updated', this.queue);
  }

  async _processNext() {
    if (this.currentJob) return; // Já está rodando

    const nextJob = this.queue.find(j => j.status === 'PENDING');
    if (!nextJob) return; // Fila vazia

    this.currentJob = nextJob;
    this.currentJob.status = 'PROCESSING';
    this.cancelRequested = false;
    this._broadcastQueue();

    try {
      await this._runMontage(nextJob);
      nextJob.status = 'DONE';
      nextJob.progress = 100;
    } catch (err) {
      nextJob.status = 'ERROR';
      nextJob.error = err.message;
      this.emit('log', `\nErro: ${err.message}\n`);
    } finally {
      this.currentJob = null;
      this.currentProcess = null;
      this._broadcastQueue();
      this._processNext(); // Continua a fila
    }
  }

  async _runMontage(job) {
    const ffmpeg = path.join(this.paths.dataDir, 'ffmpeg.exe');
    const { introPath, mainPath, outroPath, percentCut, resolution, fps, codec, quality, outputPath } = job.config;

    // Calcular duração real do vídeo principal para a porcentagem exata
    const probe = await this.probeFile(mainPath);
    const baseDuration = probe.duration;
    
    // Calcula o corte em segundos
    const cutDuration = baseDuration * (percentCut / 100);
    const cutStart = (baseDuration - cutDuration) / 2;

    const resMap = {
        '720p': { w: 1280, h: 720 },
        '1080p': { w: 1920, h: 1080 },
        '1440p': { w: 2560, h: 1440 },
        '2160p': { w: 3840, h: 2160 }
    };
    const targetRes = resMap[resolution] || resMap['1080p'];
    const targetEncoder = await this.detectEncoder(codec);
    const qualityArgs = this.getQualitySettings(targetEncoder, quality);

    // Calcular totalDuration para barra de progresso (precisa do probe intro/outro pra ser exato, mas se n tiver pega por cima)
    let introDur = 0, outroDur = 0;
    if(introPath && fs.existsSync(introPath)) introDur = (await this.probeFile(introPath)).duration;
    if(outroPath && fs.existsSync(outroPath)) outroDur = (await this.probeFile(outroPath)).duration;
    const totalDuration = introDur + cutDuration + outroDur;

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
        
        let vFilter = '', aFilter = '';
        if (isMain) {
            vFilter = `[${currentIdx}:v]trim=start=${cutStart}:duration=${cutDuration},setpts=PTS-STARTPTS[v${currentIdx}_trim];[v${currentIdx}_trim]`;
            aFilter = `[${currentIdx}:a]atrim=start=${cutStart}:duration=${cutDuration},asetpts=PTS-STARTPTS[a${currentIdx}_trim];[a${currentIdx}_trim]`;
        } else {
            vFilter = `[${currentIdx}:v]`;
            aFilter = `[${currentIdx}:a]`;
        }
        
        vFilter += `scale=${targetRes.w}:${targetRes.h}:force_original_aspect_ratio=decrease,pad=${targetRes.w}:${targetRes.h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
        if (fps !== 'Manter original') vFilter += `,fps=${fps}`;
        vFilter += `[vout${currentIdx}]`;
        
        aFilter += `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout${currentIdx}]`;
        
        filterParts.push(vFilter, aFilter);
        concatVideoInputs.push(`[vout${currentIdx}]`);
        concatAudioInputs.push(`[aout${currentIdx}]`);
    };

    processInput(introPath, false);
    processInput(mainPath, true);
    processInput(outroPath, false);

    const numInputs = concatVideoInputs.length;
    let concatStr = '';
    for (let i = 0; i < numInputs; i++) concatStr += `${concatVideoInputs[i]}${concatAudioInputs[i]}`;
    concatStr += `concat=n=${numInputs}:v=1:a=1[vfinal][afinal]`;
    filterParts.push(concatStr);

    let args = ['-y'];
    inputFiles.forEach(f => args.push('-i', f));
    args.push('-filter_complex', filterParts.join(';'));
    args.push('-map', '[vfinal]', '-map', '[afinal]');
    args.push('-c:v', targetEncoder, ...qualityArgs);
    args.push('-c:a', 'aac', '-b:a', '192k', '-progress', 'pipe:1', '-nostats');
    args.push(outputPath);

    return new Promise((resolve, reject) => {
      this.currentProcess = spawn(ffmpeg, args, { windowsHide: true });
      
      this.currentProcess.stdout.on('data', chunk => {
        const lines = chunk.toString().split('\n');
        let currentOutTimeUs = 0;
        let speed = '';
        let currentFps = '';

        lines.forEach(line => {
          if (line.startsWith('out_time_ms=')) currentOutTimeUs = parseInt(line.split('=')[1]);
          if (line.startsWith('speed=')) speed = line.split('=')[1].trim();
          if (line.startsWith('fps=')) currentFps = line.split('=')[1].trim();
        });

        if (currentOutTimeUs > 0) {
          const currentOutTimeS = currentOutTimeUs / 1000000;
          let percent = (currentOutTimeS / totalDuration) * 100;
          if (percent > 100) percent = 100;
          
          this.currentJob.progress = percent;
          this._broadcastQueue();
        }
      });

      this.currentProcess.stderr.on('data', chunk => {
        this.emit('log', chunk.toString());
      });

      this.currentProcess.on('close', code => {
        if (this.cancelRequested) return reject(new Error('Cancelado pelo usuário'));
        if (code !== 0) return reject(new Error('Processo terminou com código ' + code));
        resolve();
      });
    });
  }
}

module.exports = MontageService;
