const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const logger = require('./logService');

class ConverterService extends EventEmitter {
  constructor({ paths, getSettings, historyService }) {
    super();

    this.paths = paths;
    this.getSettings = getSettings;
    this.historyService = historyService;

    this.queue = [];

    this.currentProcess = null;
    this.currentItem = null;

    this.running = false;
    this.cancelRequested = false;

    this.encoder = null;
  }

  isRunning() {
    return this.running;
  }
  getQueue() {
    return this.queue;
  }
  clearQueue() {
    if (this.running) {
      throw new Error(
        'Não é possível limpar a fila durante uma conversão.'
      );
    }
    this.queue = [];
    this.emit('queue', this.queue);
    return {
      ok: true
    };
  }

  removeFile(index) {
    if (this.running) {
      throw new Error('Não é possível remover itens durante uma conversão.');
    }
    if (index >= 0 && index < this.queue.length) {
      this.queue.splice(index, 1);
      this.emit('queue', this.queue);
    }
    return { ok: true };
  }

  addFiles(files = []) {
    const added = [];
    for (const file of files) {
      if (!fs.existsSync(file)) {
        continue;
      }
      const ext = path.extname(file).toLowerCase();
      const allowed = [
        '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mts', '.m2ts',
        '.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.wma', '.alac', '.aiff',
        '.ape', '.opus', '.amr', '.mid', '.midi', '.au', '.ra', '.dsf', '.dff',
        '.ac3', '.dts', '.3gp', '.mpg', '.mpeg', '.m4v', '.ts', '.vob', '.asf',
        '.rm', '.rmvb', '.ogv', '.f4v', '.mxf'
      ];

      if (!allowed.includes(ext)) {
        continue;
      }

      const item = {
        id:
          Date.now() +
          Math.floor(Math.random() * 100000),

        file,

        output: null,

        status: 'Pendente',

        progress: 0,

        encoder: null
      };

      this.queue.push(item);

      added.push(item);
    }

    logger.info(
      'converter:addFiles',
      {
        count: added.length
      }
    );

    this.emit(
      'queue',
      this.queue
    );

    return {
      ok: true,
      count: added.length,
      items: added
    };
  }

  async start(config = {}) {

    if (this.running) {
      throw new Error(
        'Já existe uma conversão em andamento.'
      );
    }

    if (!this.queue.length) {
      throw new Error(
        'A fila está vazia.'
      );
    }

    this.running = true;
    this.cancelRequested = false;
    this.currentConfig = config;

    logger.info(
      'converter:start',
      {
        total: this.queue.length,
        config: this.currentConfig
      }
    );

    try {

      await this.processQueue();

      this.emit(
        'finished',
        {
          status: 'success',
          message: 'Fila concluída.'
        }
      );

    } catch (error) {

      logger.error(
        'converter:error',
        {
          error: error.message
        }
      );

      this.emit(
        'finished',
        {
          status: 'error',
          message: error.message
        }
      );

    } finally {

      this.running = false;
      this.currentProcess = null;
      this.currentItem = null;

    }
  }

  async cancelCurrent() {
    this.cancelRequested = true;
    if (!this.currentProcess) {
      return {
        ok: true
      };
    }

    await this.killProcessTree(
      this.currentProcess.pid
    );
    logger.warn(
      'converter:cancel'
    );

    return {
      ok: true
    };
  }

    async processQueue() {
    this.encoder =
      await this.detectEncoder();
    logger.info(
      'converter:encoder',
      {
        encoder: this.encoder
      }
    );

    for (const item of this.queue) {
      if (this.cancelRequested) {
        break;
      }
      if (
        item.status === 'Concluído'
      ) {
        continue;
      }

      await this.convertItem(
        item
      );
    }
  }

  async convertItem(item) {
    this.currentItem = item;
    item.status =
      'Convertendo';
    item.progress = 0;

    const outFormat = this.currentConfig?.format?.toLowerCase() || 'mp4';
    const folderName = outFormat === 'mp3' ? 'MP3' : 'MP4';
    const outExt = outFormat === 'mp3' ? '.mp3' : '.mp4';
    
    // Default to source directory if no outFolder provided
    const sourceDir = path.dirname(item.file);
    const outputDir = this.currentConfig?.outFolder || sourceDir;
    
    item.output = path.join(outputDir, `${path.parse(item.file).name}${outExt}`);
    item.outputType = outFormat;

    this.emit(
      'fileStarted',
      item
    );

    this.emit(
      'queue',
      this.queue
    );



    fs.mkdirSync(
      outputDir,
      {
        recursive: true
      }
    );

    const duration =
      await this.getVideoDuration(
        item.file
      );

    const ffmpeg =
      path.join(
        this.paths.dataDir,
        'ffmpeg.exe'
      );

    if (!fs.existsSync(ffmpeg)) {
      throw new Error(
        'ffmpeg.exe não encontrado.'
      );
    }

    const args = [
      '-y',
      '-i',
      item.file
    ];

    const config = this.currentConfig || {};
    const audioBitrate = config.audioBitrate || '192k';

    if (item.outputType === 'mp3') {
      args.push(
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', audioBitrate
      );
    } else {
      const res = config.videoResolution;
      if (res && res !== 'original') {
        args.push('-vf', `scale=-2:${res}`);
      }

      const vBitrate = config.videoBitrate;
      let hasBitrate = false;
      if (vBitrate && vBitrate !== 'auto') {
        args.push('-b:v', vBitrate, '-maxrate', vBitrate, '-bufsize', `${parseInt(vBitrate) * 2}k`);
        hasBitrate = true;
      }

      let codec = config.videoCodec || 'auto';
      
      if (codec === 'libx265') {
        args.push('-c:v', 'libx265');
        if (!hasBitrate) args.push('-crf', '28', '-preset', 'medium');
      } else if (codec === 'libx264') {
        args.push('-c:v', 'libx264');
        if (!hasBitrate) args.push('-crf', '23', '-preset', 'medium');
      } else {
        switch (this.encoder) {
          case 'h264_nvenc':
            args.push('-c:v', 'h264_nvenc', '-preset', 'p5');
            if (!hasBitrate) args.push('-cq', '23');
            break;
          case 'h264_qsv':
            args.push('-c:v', 'h264_qsv');
            if (!hasBitrate) args.push('-global_quality', '23');
            break;
          default:
            args.push('-c:v', 'libx264', '-preset', 'medium');
            if (!hasBitrate) args.push('-crf', '23');
        }
      }

      args.push(
        '-c:a', 'aac',
        '-b:a', audioBitrate
      );
    }

    args.push(
      '-progress',
      'pipe:1'
    );

    args.push(
      '-nostats'
    );

    args.push(
      item.output
    );

    logger.info(
      'converter:file:start',
      {
        file: item.file,
        output: item.output,
        encoder: this.encoder
      }
    );

    await new Promise(
      (resolve, reject) => {
        const child =
          spawn(
            ffmpeg,
            args,
            {
              windowsHide: true
            }
          );

        this.currentProcess =
          child;

        let stderr = '';

        child.stdout.on(
          'data',
          (chunk) => {

            const text =
              chunk.toString(
                'utf8'
              );

            const match =
              text.match(
                /out_time_ms=(\d+)/
              );

            if (
              match &&
              duration > 0
            ) {

              const current =
                Number(
                  match[1]
                ) / 1000000;

              const percent =
                Math.min(
                  100,
                  (
                    current /
                    duration
                  ) * 100
                );

              item.progress =
                percent;

              this.emit(
                'progress',
                {
                  id: item.id,
                  progress: percent,
                  status:
                    'Convertendo'
                }
              );

              this.emit(
                'queue',
                this.queue
              );
            }
          }
        );

        child.stderr.on(
          'data',
          (chunk) => {
            stderr +=
              chunk.toString(
                'utf8'
              );
          }
        );

        child.on(
          'error',
          reject
        );

        child.on(
          'close',
          (code) => {
            if (
              this.cancelRequested
            ) {
                item.status =
                'Cancelado';

                this.saveConversion(
                item
                );

                this.emit(
                'fileFinished',
                {
                  id: item.id,
                  status:
                    'Cancelado'
                }
              );

              return resolve();
            }

            if (code === 0) {
              item.progress =
                100;
              item.status =
                'Concluído';
              item.encoder =
                this.encoder;

                this.saveConversion(
                item
                );

                this.emit(
                'fileFinished',
                {
                    id: item.id,
                    status:
                    'Concluído'
                }
                );

                this.emit(
                'queue',
                this.queue
                );

                return resolve();
            }

            item.status =
                'Erro';

            this.saveConversion(
             item
            );

            reject(
                new Error(
                    stderr ||
                    `FFmpeg retornou ${code}`
            )
            );
          }
        );
      }
    );
  }

    async detectEncoder() {
    const ffmpeg =
      path.join(
        this.paths.dataDir,
        'ffmpeg.exe'
      );

    if (!fs.existsSync(ffmpeg)) {
      throw new Error(
        'ffmpeg.exe não encontrado.'
      );
    }

    logger.info(
      'converter:detectEncoder'
    );

    const nvenc =
      await this.testEncoder(
        'h264_nvenc'
      );

    if (nvenc) {
      logger.info(
        'converter:encoder',
        {
          encoder:
            'h264_nvenc'
        }
      );

      return 'h264_nvenc';
    }

    const qsv =
      await this.testEncoder(
        'h264_qsv'
      );

      if (qsv) {
      logger.info(
        'converter:encoder',
        {
          encoder:
            'h264_qsv'
        }
      );

      return 'h264_qsv';
    }

    logger.info(
      'converter:encoder',
      {
        encoder:
          'libx264'
      }
    );

    return 'libx264';
  }

  testEncoder(encoder) {
    return new Promise(
      (resolve) => {
        const ffmpeg =
          path.join(
            this.paths.dataDir,
            'ffmpeg.exe'
          );

        const child =
          spawn(
            ffmpeg,
            [
              '-hide_banner',
              '-f',
              'lavfi',
              '-i',
              'nullsrc=s=64x64:d=1',
              '-c:v',
              encoder,
              '-f',
              'null',
              '-'
            ],
            {
              windowsHide: true
            }
          );

        child.on(
          'close',
          (code) => {
            resolve(
              code === 0
            );
          }
        );

        child.on(
          'error',
          () => {
            resolve(false);
          }
        );
      }
    );
  }

  async getVideoDuration(file) {

    const ffprobe =
      path.join(
        this.paths.dataDir,
        'ffprobe.exe'
      );

    if (!fs.existsSync(ffprobe)) {
      logger.warn(
        'converter:ffprobeMissing'
      );
      return 0;
    }

    return new Promise(
      (resolve, reject) => {
        const child =
          spawn(
            ffprobe,
            [
              '-v',
              'error',
              '-show_entries',
              'format=duration',
              '-of',
              'default=noprint_wrappers=1:nokey=1',
              file
            ],
            {
              windowsHide: true
            }
          );

        let output = '';
        let errorOutput = '';

        child.stdout.on(
          'data',
          (chunk) => {

            output +=
              chunk.toString(
                'utf8'
              );
          }
        );

        child.stderr.on(
          'data',
          (chunk) => {
            errorOutput +=
              chunk.toString(
                'utf8'
              );
          }
        );

        child.on(
          'error',
          reject
        );

        child.on(
          'close',
          (code) => {
            if (code !== 0) {
              return reject(
                new Error(
                  errorOutput ||
                  'Erro ao obter duração.'
                )
              );
            }

            const duration =
              parseFloat(
                output.trim()
              );

            resolve(
              Number.isFinite(
                duration
              )
                ? duration
                : 0
            );
          }
        );
      }
    );
  }

    saveConversion(item) {
    try {
      this.historyService.addConversion({
        arquivoOrigem: item.file,
        arquivoSaida: item.output,
        formato: item.outputType ? item.outputType.toUpperCase() : 'MP4',
        encoder: item.outputType === 'mp3' ? 'libmp3lame' : (item.encoder || this.encoder),
        pasta: path.dirname(item.output),
        status: item.status
      });

    } catch (error) {
      logger.error(
        'converter:history',
        {
          error: error.message
        }
      );
    }
  }

  async killProcessTree(pid) {
    return new Promise((resolve) => {
      if (!pid) {
        return resolve();
      }

      if (process.platform === 'win32') {
        const killer = spawn(
          'taskkill',
          [
            '/PID',
            String(pid),
            '/T',
            '/F'
          ],
          {
            windowsHide: true
          }
        );

        killer.on(
          'close',
          () => resolve()
        );

        killer.on(
          'error',
          () => resolve()
        );
        return;
      }

      try {
        process.kill(
          pid,
          'SIGTERM'
        );
      } catch {
      }
      resolve();
    });
  }
}

module.exports = ConverterService;