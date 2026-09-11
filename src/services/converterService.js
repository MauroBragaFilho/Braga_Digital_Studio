const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const logger = require('./logService');
const hardwareDetection = require('../core/HardwareDetectionService');
const { ffmpegTool } = require('../infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');
const { processRunner } = require('../infrastructure/external-tools/ProcessRunner');

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
    // Aplicado no processQueue a partir das Configurações (useHardwareAcceleration)
    this.hwEnabled = true;

    // Estatísticas do lote atual — usadas para estimar o tempo restante geral
    // via throughput real acumulado (itens já concluídos).
    this._batchStats = {
      totalDurationProcessed: 0, // segundos de vídeo já convertidos
      totalWallTimeSpent: 0      // segundos reais gastos nesses itens
    };
    this._lastOverallProgressEmit = 0; // throttling do evento overallProgress (500ms)
    this._overallETA = null;           // ETA suavizado por EMA para não oscilar na UI
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

    // Reinicia as estatísticas do lote a cada nova conversão
    this._batchStats = {
      totalDurationProcessed: 0,
      totalWallTimeSpent: 0
    };
    this._lastOverallProgressEmit = 0;
    this._overallETA = null;

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
          status: this.cancelRequested ? 'cancelled' : 'success',
          message: this.cancelRequested ? 'Conversão cancelada.' : 'Fila concluída.'
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
    const ffmpegPath = ffmpegTool.resolve();
    // Aplica preferências atuais do usuário (ex: toggle de HW desativado)
    if (typeof this.getSettings === 'function') {
      hardwareDetection.configure(this.getSettings());
    }
    this.hwEnabled = hardwareDetection.settings.useHardwareAcceleration !== false;
    this.encoder = await hardwareDetection.detectEncoder(ffmpegPath, 'H.264');
    
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

      // Acumula estatísticas do lote apenas com itens concluídos e com duração conhecida
      if (
        item.status === 'Concluído' &&
        item.duration > 0
      ) {
        this._batchStats.totalDurationProcessed +=
          item.duration;
        this._batchStats.totalWallTimeSpent +=
          (Date.now() - item.startedAt) / 1000;
      }
    }
  }

  async convertItem(item) {
    this.currentItem = item;
    item.status =
      'Convertendo';
    item.progress = 0;
    item.startedAt =
      Date.now();
    item._smoothedSpeed =
      null;
    item._remainingSeconds =
      null;

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

    // Armazena a duração no item (usada no cálculo de tempo restante individual e do lote)
    item.duration = duration;

    const ffmpeg = ffmpegTool.resolve();

    const args = [
      '-y'
    ];
    // Decodificação acelerada por hardware (apenas quando ativo nas Configurações)
    if (this.hwEnabled) args.push('-hwaccel', 'auto');
    args.push('-i', item.file);

    const config = this.currentConfig || {};
    const audioBitrate = config.audioBitrate || '192k';

    if (item.outputType === 'mp3') {
      // MP3: sempre usa libmp3lame (ignora codec de áudio configurado)
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
        const vBitrateStr = String(vBitrate);
        // Calcula bufsize = 2x o bitrate (ex: '10M' → '20M', '8000k' → '16000k')
        const bm = vBitrateStr.match(/^(\d+(?:\.\d+)?)([kKmMgG]?)$/);
        const bufSize = bm ? `${parseFloat(bm[1]) * 2}${bm[2] || 'k'}` : `${parseInt(vBitrateStr) * 2}k`;
        args.push('-b:v', vBitrateStr, '-maxrate', vBitrateStr, '-bufsize', bufSize);
        hasBitrate = true;
      }

      let codec = config.videoCodec || 'libx264';
      const userCrf = config.videoCrf !== undefined && config.videoCrf !== null ? String(config.videoCrf) : null;
      const userPreset = config.preset || 'medium';

      if (codec === 'libx265') {
        args.push('-c:v', 'libx265');
        if (!hasBitrate) args.push('-crf', userCrf || '28', '-preset', userPreset);
        else args.push('-preset', userPreset);
      } else if (codec === 'libx264') {
        args.push('-c:v', 'libx264');
        if (!hasBitrate) args.push('-crf', userCrf || '23', '-preset', userPreset);
        else args.push('-preset', userPreset);
      } else {
        // Codec desconhecido → fallback para libx264
        args.push('-c:v', 'libx264', '-preset', userPreset);
        if (!hasBitrate) args.push('-crf', userCrf || '23');
      }

      // Codec de áudio (suporta aac, libmp3lame, pcm_s16le)
      const audioCodec = config.audioCodec || 'aac';
      args.push('-c:a', audioCodec);
      // Bitrate de áudio não se aplica a PCM (sem compressão)
      if (audioCodec !== 'pcm_s16le') {
        args.push('-b:a', audioBitrate);
      }
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

            const timeMatch =
              text.match(
                /out_time_ms=(\d+)/
              );

            // Extrai a velocidade (speed) do FFmpeg e aplica suavização exponencial (EMA).
            // O valor bruto oscila muito; suavizado fica estável para a UI.
            const speedMatch =
              text.match(
                /speed=\s*([\d.]+)x/
              );

            if (speedMatch) {
              const rawSpeed =
                Number(
                  speedMatch[1]
                );

              if (
                Number.isFinite(rawSpeed) &&
                rawSpeed > 0
              ) {
                item._smoothedSpeed =
                  item._smoothedSpeed
                    ? (0.3 * rawSpeed + 0.7 * item._smoothedSpeed)
                    : rawSpeed;
              }
            }

            if (
              timeMatch &&
              duration > 0
            ) {

              const current =
                Number(
                  timeMatch[1]
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

              // Tempo restante individual: usa a última velocidade válida (suavizada).
              // Sem leitura válida ainda, mantém o último valor (ou null).
              if (
                item._smoothedSpeed &&
                item._smoothedSpeed > 0
              ) {
                item._remainingSeconds =
                  Math.max(
                    0,
                    (
                      duration - current
                    ) / item._smoothedSpeed
                  );
              }

              this.emit(
                'progress',
                {
                  id: item.id,
                  progress: percent,
                  status:
                    'Convertendo',
                  remainingSeconds:
                    item._remainingSeconds ?? null
                }
              );

              this.emit(
                'queue',
                this.queue
              );

              this._emitOverallProgress();
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

                // Remove o arquivo parcial gerado (ffmpeg morto no meio deixa .mp4 inválido)
                try {
                  if (item.output && fs.existsSync(item.output)) {
                    fs.unlinkSync(item.output);
                  }
                } catch (cleanupErr) {
                  logger.warn('converter:cancel:cleanup', { error: cleanupErr.message });
                }

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



  async getVideoDuration(file) {

    let ffprobe;
    try {
      ffprobe = ffprobeTool.resolve();
    } catch (_) {
      logger.warn('converter:ffprobeMissing');
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

  _emitOverallProgress() {
    // Throttling: no máximo um evento overallProgress a cada 500ms.
    const now = Date.now();
    if (now - this._lastOverallProgressEmit < 500) return;
    this._lastOverallProgressEmit = now;

    let totalDuration = 0;
    let processedDuration = 0;

    for (const item of this.queue) {
      if (item.duration > 0) {
        totalDuration += item.duration;
        if (item.status === 'Concluído') {
          processedDuration += item.duration;
        } else if (item === this.currentItem) {
          processedDuration +=
            (item.progress / 100) * item.duration;
        }
      }
    }

    const percent =
      totalDuration > 0
        ? Math.min(100, (processedDuration / totalDuration) * 100)
        : (this.currentItem ? this.currentItem.progress : 0);

    // ETA por extrapolação: tempo-decorrido × progresso.
    // Fórmula: remaining = elapsed × (100 - progress) / progress
    // É o método padrão (YouTube, VLC, browsers) — não depende do
    // speed=Xx do FFmpeg (que é muito instável no início) e converge
    // naturalmente à medida que progress e elapsed crescem.
    let remainingSeconds = null;
    const cur = this.currentItem;

    if (
      cur
      && cur.duration > 0
      && cur.progress > 0
      && cur.startedAt
    ) {
      const elapsed =
        (Date.now() - cur.startedAt) / 1000;

      // Exige mínimo de progresso e tempo para evitar estimativas
      // absurdas nos primeiros segundos (FFmpeg a cold-start).
      if (cur.progress >= 3 && elapsed >= 5) {
        const curRemaining =
          elapsed * (100 - cur.progress) / cur.progress;
        remainingSeconds = curRemaining;

        // Para filas com múltiplos arquivos, estima o tempo dos
        // próximos itens usando a velocidade média do item atual.
        const futureVideoDuration =
          totalDuration - cur.duration;
        if (futureVideoDuration > 0) {
          const curSpeed =
            (cur.duration * cur.progress / 100) / elapsed;
          if (curSpeed > 0) {
            remainingSeconds +=
              futureVideoDuration / curSpeed;
          }
        }
      }
    }

    // Suaviza o ETA com EMA (α=0.2) para evitar micro-oscilações
    // mantendo responsividade a mudanças reais de velocidade.
    if (remainingSeconds != null) {
      this._overallETA =
        this._overallETA == null
          ? remainingSeconds
          : (0.2 * remainingSeconds +
            0.8 * this._overallETA);
      remainingSeconds = this._overallETA;
    } else {
      this._overallETA = null;
    }

    this.emit(
      'overallProgress',
      {
        percent,
        completed: processedDuration,
        total: totalDuration,
        remainingSeconds
      }
    );
  }

  async killProcessTree(pid) {
    if (!pid) return;
    processRunner.cancel(pid);
  }
}

module.exports = ConverterService;