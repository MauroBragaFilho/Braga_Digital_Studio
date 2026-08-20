const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const logger = require('./logService');
const hardwareDetection = require('../core/HardwareDetectionService');
const { ffmpegTool } = require('../infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');
const { processRunner } = require('../infrastructure/external-tools/ProcessRunner');

class SilenceService extends EventEmitter {
  constructor({ paths }) {
    super();
    this.paths = paths;
    this.currentProcess = null;
    this.cancelRequested = false;
    this.running = false;
  }

  async probeFile(filePath) {
    const ffprobe = ffprobeTool.resolve();
    return new Promise((resolve, reject) => {
      const child = spawn(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], { windowsHide: true });
      let stdout = '';
      child.stdout.on('data', chunk => stdout += chunk.toString());
      child.on('close', code => {
        if (code !== 0) return reject(new Error('Erro no ffprobe'));
        const video = data.streams.find(s => s.codec_type === 'video');
        const audioStreams = data.streams.filter(s => s.codec_type === 'audio').map((s, idx) => ({
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

  async analyzeSilence(filePath, threshold, minDuration) {
    const ffmpeg = ffmpegTool.resolve();
    return new Promise((resolve, reject) => {
      // Usar silencedetect apenas no áudio para extrair os logs
      const args = ['-hide_banner', '-i', filePath, '-af', `silencedetect=noise=${threshold}dB:d=${minDuration}`, '-f', 'null', '-'];
      const child = spawn(ffmpeg, args, { windowsHide: true });
      
      let stderr = '';
      child.stderr.on('data', chunk => stderr += chunk.toString('utf8'));
      
      child.on('close', code => {
        if (code !== 0) return reject(new Error('Falha na análise de silêncio'));
        
        const silences = [];
        const lines = stderr.split('\n');
        
        let currentStart = null;
        for (const line of lines) {
          const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
          if (startMatch) currentStart = parseFloat(startMatch[1]);
          
          const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/);
          if (endMatch && currentStart !== null) {
            silences.push({
              start: Math.max(0, currentStart),
              end: parseFloat(endMatch[1]),
              duration: parseFloat(endMatch[1]) - Math.max(0, currentStart)
            });
            currentStart = null;
          }
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
        
        // Step 4: Build Filtergraph
        let filterParts = [];
        let videoInputs = [];
        let audioInputs = [];
        
        let estimatedNewDuration = 0;

        keepSegments.forEach((seg, idx) => {
            estimatedNewDuration += (seg.end - seg.start);
            if (info.isVideo) {
                filterParts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${idx}]`);
                videoInputs.push(`[v${idx}]`);
            }
            filterParts.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${idx}]`);
            audioInputs.push(`[a${idx}]`);
        });

        const numInputs = keepSegments.length;
        let concatStr = '';
        for (let j = 0; j < numInputs; j++) {
            if (info.isVideo) concatStr += videoInputs[j];
            concatStr += audioInputs[j];
        }
        
        if (info.isVideo) {
            concatStr += `concat=n=${numInputs}:v=1:a=1[vfinal][afinal]`;
        } else {
            concatStr += `concat=n=${numInputs}:v=0:a=1[afinal]`;
        }
        filterParts.push(concatStr);
        
        const filterComplex = filterParts.join(';');
        const filterScriptPath = path.join(this.paths.dataDir, `silence_filter_${Date.now()}_${i}.txt`);
        fs.writeFileSync(filterScriptPath, filterComplex, 'utf8');
        
        const args = ['-y', '-i', filePath, '-filter_complex_script', filterScriptPath];
        
        if (info.isVideo) {
            args.push('-map', '[vfinal]', '-map', '[afinal]');
            const targetEncoder = await hardwareDetection.detectEncoder(ffmpeg, 'H.264');
            const qualityArgs = hardwareDetection.getQualitySettings(targetEncoder, 'Alta');
            args.push('-c:v', targetEncoder, ...qualityArgs, '-c:a', 'aac');
        } else {
            args.push('-map', '[afinal]');
            const extLower = ext.toLowerCase();
            if (extLower === '.mp3') {
                args.push('-c:a', 'libmp3lame', '-b:a', '192k');
            } else if (extLower === '.wav') {
                args.push('-c:a', 'pcm_s16le');
            } else if (extLower === '.flac') {
                args.push('-c:a', 'flac');
            } else {
                args.push('-c:a', 'aac', '-b:a', '192k');
            }
        }
        
        args.push('-progress', 'pipe:1', '-nostats', outPath);

        await new Promise((resolve, reject) => {
            const child = spawn(ffmpeg, args, { windowsHide: true });
            this.currentProcess = child;
            let ffmpegErrLog = '';
            
            child.stdout.on('data', chunk => {
                const text = chunk.toString();
                const timeMatch = text.match(/out_time_ms=(\d+)/);
                if (timeMatch && estimatedNewDuration > 0) {
                    const currentSec = Number(timeMatch[1]) / 1000000;
                    const percent = Math.min(100, (currentSec / estimatedNewDuration) * 100);
                    this.emit('progress', { index: i + 1, total: files.length, file: fileName, percent, status: 'Processando...' });
                }
            });

            child.stderr.on('data', chunk => {
                const text = chunk.toString();
                ffmpegErrLog += text;
                this.emit('log', text);
            });
            
            child.on('close', code => {
                try { if (fs.existsSync(filterScriptPath)) fs.unlinkSync(filterScriptPath); } catch (e) {}
                if (this.cancelRequested) return resolve();
                if (code === 0) {
                    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
                        processedCount++;
                        return resolve();
                    } else {
                        if (fs.existsSync(outPath)) {
                            try { fs.unlinkSync(outPath); } catch (e) {}
                        }
                        return reject(new Error(`O FFmpeg gerou um arquivo de 0 bytes. Log: ${ffmpegErrLog.slice(-300)}`));
                    }
                }

                if (fs.existsSync(outPath) && fs.statSync(outPath).size === 0) {
                    try { fs.unlinkSync(outPath); } catch (e) {}
                }
                reject(new Error(`Falha no FFmpeg (código ${code}): ${ffmpegErrLog.slice(-300)}`));
            });
        });
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

  async cancel() {
    this.cancelRequested = true;
    if (this.currentProcess) {
      processRunner.cancel(this.currentProcess);
    }
  }
}

module.exports = SilenceService;
