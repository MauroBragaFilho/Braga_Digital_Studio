const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');

const logger = require('./logService');
const hardwareDetection = require('../core/HardwareDetectionService');
const { ffmpegTool } = require('../infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');
const { processRunner } = require('../infrastructure/external-tools/ProcessRunner');
const probeCache = require('../core/ffmpeg/ProbeCache');

// Progresso por arquivo no máximo a cada 300 ms; stderr do ffmpeg guarda só o final (~8 KB)
const PROGRESS_EMIT_MS = 300;
const STDERR_TAIL_BYTES = 8192;
// ffprobes simultâneos ao montar a fila
const PROBE_CONCURRENCY = 3;

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

    this.encoder = null;       // encoder H.264 detectado (compatibilidade com o log/histórico)
    this.encoderH264 = null;
    this.encoderH265 = null;
    this._lastProgressEmit = 0; // throttling do evento 'progress' por arquivo
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
    for (const entry of files) {
      // Aceita string ou { path, duration } (duração já conhecida do chamador evita novo ffprobe)
      const file = typeof entry === 'string' ? entry : entry?.path;
      const knownDuration = entry && typeof entry === 'object' && Number(entry.duration) > 0
        ? Number(entry.duration)
        : 0;
      if (!file || !fs.existsSync(file)) {
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
      if (knownDuration > 0) item.knownDuration = knownDuration;

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

    // Aquece o ProbeCache em paralelo (limite) para que o início da conversão não espere o ffprobe
    this._prefetchDurations(added.filter((it) => !(it.knownDuration > 0)).map((it) => it.file));

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
      this.currentProcess
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
    this.encoderH264 = await hardwareDetection.detectEncoder(ffmpegPath, 'H.264');
    this.encoder = this.encoderH264;
    // H.265 só é detectado se o usuário escolheu libx265 (evita o teste do encoder à toa)
    this.encoderH265 = this.currentConfig?.videoCodec === 'libx265'
      ? await hardwareDetection.detectEncoder(ffmpegPath, 'H.265')
      : null;
    
    logger.info(
      'converter:encoder',
      {
        encoder: this.encoder,
        encoderH265: this.encoderH265
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
    this._lastProgressEmit = 0;

    const outFormat = this.currentConfig?.format?.toLowerCase() || 'mp4';
    const outExt = outFormat === 'mp3' ? '.mp3' : '.mp4';

    // Default to source directory if no outFolder provided
    const sourceDir = path.dirname(item.file);
    const outputDir = this.currentConfig?.outFolder || sourceDir;

    item.output = path.join(outputDir, `${path.parse(item.file).name}${outExt}`);
    // Saída igual à origem (ex.: x.mp4 -> x.mp4 na mesma pasta): o ffmpeg recusaria e qualquer limpeza
    // de parcial apagaria o ORIGINAL. Usa um nome distinto.
    if (path.resolve(item.output).toLowerCase() === path.resolve(item.file).toLowerCase()) {
      item.output = path.join(outputDir, `${path.parse(item.file).name}_convertido${outExt}`);
    }
    item.outputType = outFormat;

    const config = this.currentConfig || {};
    let plan = this._planEncoder(item, config);
    // O histórico registra o encoder realmente usado (atualizado se houver fallback por software)
    item.encoder = plan.encoder;

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

    // Duração já informada pelo chamador tem prioridade; senão ffprobe (com ProbeCache,
    // normalmente já aquecido pelo _prefetchDurations ao montar a fila).
    const duration = item.knownDuration > 0
      ? item.knownDuration
      : await this.getVideoDuration(item.file);

    // Armazena a duração no item (usada no cálculo de tempo restante individual e do lote)
    item.duration = duration;

    const ffmpeg = ffmpegTool.resolve();

    logger.info(
      'converter:file:start',
      {
        file: item.file,
        output: item.output,
        encoder: plan.encoder
      }
    );

    let result = await this._runEncode(
      item,
      ffmpeg,
      this._buildArgs(item, config, plan.encoder),
      duration
    );

    // Encode por hardware falhou (driver/NVENC indisponível, formato não suportado...): repete UMA vez por software.
    if (
      result.code !== 0 &&
      !this.cancelRequested &&
      plan.hardware &&
      this._shouldRetryInSoftware(result, item)
    ) {
      logger.warn(
        'converter:hwFallback',
        {
          file: item.file,
          failedEncoder: plan.encoder,
          fallback: plan.software,
          code: result.code,
          stderr: result.stderr.slice(-500)
        }
      );
      try {
        if (fs.existsSync(item.output)) fs.unlinkSync(item.output);
      } catch (_) { /* o ffmpeg sobrescreve (-y) */ }

      plan = { encoder: plan.software, software: plan.software, hardware: false };
      item.encoder = plan.encoder;
      item.progress = 0;
      item.startedAt = Date.now();
      item._smoothedSpeed = null;
      item._remainingSeconds = null;
      this._lastProgressEmit = 0;

      result = await this._runEncode(
        item,
        ffmpeg,
        this._buildArgs(item, config, plan.encoder),
        duration
      );
    }

    if (this.cancelRequested) {
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
      return;
    }

    if (result.code === 0) {
      item.progress =
        100;
      item.status =
        'Concluído';

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
      return;
    }

    item.status =
      'Erro';

    this.saveConversion(
      item
    );

    this.emit(
      'queue',
      this.queue
    );

    throw new Error(
      result.stderr ||
      `FFmpeg retornou ${result.code}`
    );
  }

  /**
   * Decide o encoder de vídeo do item: o detectado por hardware (NVENC/QSV/AMF) quando a aceleração
   * está ativa e o codec escolhido é libx264/libx265; caso contrário o de software.
   */
  _planEncoder(item, config) {
    if (item.outputType === 'mp3') {
      return { encoder: 'libmp3lame', software: 'libmp3lame', hardware: false };
    }
    const wantsHevc = config.videoCodec === 'libx265';
    const software = wantsHevc ? 'libx265' : 'libx264';
    const detected = wantsHevc ? this.encoderH265 : this.encoderH264;
    if (this.hwEnabled && detected && !String(detected).startsWith('lib')) {
      return { encoder: detected, software, hardware: true };
    }
    return { encoder: software, software, hardware: false };
  }

  /**
   * Falha precoce (poucos segundos) ou erro típico de encoder => vale repetir por software.
   * Falhas tardias sem relação com o encoder (disco cheio etc.) não são repetidas.
   */
  _shouldRetryInSoftware(result, item) {
    const elapsedMs = Date.now() - (item.startedAt || Date.now());
    if (elapsedMs < 20000) return true;
    return /nvenc|encoder|OpenEncodeSession|No capable devices|Could not open|Error while opening|Cannot load|not supported|Invalid argument|Function not implemented|amf|qsv/i
      .test(result.stderr || '');
  }

  /** Monta os argumentos do ffmpeg para o item usando o encoder indicado. */
  _buildArgs(item, config, videoEncoder) {
    const args = [
      '-y',
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'error'
    ];
    // Decodificação acelerada por hardware (apenas quando ativo nas Configurações)
    if (this.hwEnabled) args.push('-hwaccel', 'auto');
    args.push('-i', item.file);

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

      const isHevc = config.videoCodec === 'libx265';
      const userCrf = config.videoCrf !== undefined && config.videoCrf !== null ? String(config.videoCrf) : null;
      const userPreset = config.preset || 'medium';
      const crf = userCrf || (isHevc ? '28' : '23');

      args.push('-c:v', videoEncoder);
      let quality = hardwareDetection.getEncoderQualityArgs(videoEncoder, crf, userPreset);
      if (hasBitrate) {
        // Com bitrate fixo o parâmetro de qualidade constante (crf/cq/...) não se aplica: mantém só o preset.
        const qualityFlags = new Set(['-crf', '-cq', '-global_quality', '-qp_i', '-qp_p']);
        const filtered = [];
        for (let i = 0; i < quality.length; i++) {
          if (qualityFlags.has(quality[i])) { i++; continue; }
          filtered.push(quality[i]);
        }
        quality = filtered;
      } else if (String(videoEncoder).includes('nvenc')) {
        // NVENC: qualidade constante exige VBR com bitrate-alvo 0 (senão o -cq fica limitado ao bitrate padrão de 2 Mb/s)
        quality.push('-rc', 'vbr', '-b:v', '0');
      }
      args.push(...quality);

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

    return args;
  }

  /**
   * Executa o ffmpeg e resolve com { code, stderr } (stderr limitado ao final, ~8 KB).
   * Atualiza progresso do item (throttle) a partir do `-progress pipe:1`.
   */
  _runEncode(item, ffmpeg, args, duration) {
    return new Promise(
      (resolve, reject) => {
        const child =
          processRunner.spawn(
            ffmpeg,
            args
          );

        this.currentProcess =
          child;

        let stderr = '';
        let stdoutRemainder = '';

        child.stdout.on(
          'data',
          (chunk) => {
            // Acumula linhas parciais: um chunk pode terminar no meio de "out_time_ms=123".
            const text = stdoutRemainder + chunk.toString('utf8');
            const lines = text.split(/\r?\n/);
            stdoutRemainder = lines.pop();

            let outTimeUs = null;
            let speed = null;
            for (const line of lines) {
              // Só importa o ÚLTIMO out_time_ms do chunk (o mais recente).
              if (line.startsWith('out_time_ms=')) {
                const v = Number(line.slice(12));
                if (Number.isFinite(v) && v >= 0) outTimeUs = v;
              } else if (line.startsWith('speed=')) {
                const m = /speed=\s*([\d.]+)x/.exec(line);
                if (m) speed = Number(m[1]);
              }
            }

            // Suaviza a velocidade (EMA): o valor bruto oscila muito.
            if (Number.isFinite(speed) && speed > 0) {
              item._smoothedSpeed =
                item._smoothedSpeed
                  ? (0.3 * speed + 0.7 * item._smoothedSpeed)
                  : speed;
            }

            if (outTimeUs !== null && duration > 0) {
              const current = outTimeUs / 1000000;
              const percent = Math.min(100, (current / duration) * 100);
              item.progress = percent;

              // Tempo restante individual: usa a última velocidade válida (suavizada).
              if (item._smoothedSpeed && item._smoothedSpeed > 0) {
                item._remainingSeconds =
                  Math.max(0, (duration - current) / item._smoothedSpeed);
              }

              // Throttle: no máximo um evento de progresso a cada PROGRESS_EMIT_MS.
              // No tick vai só { id, progress, ... }; a fila inteira só é emitida em mudança de status.
              const now = Date.now();
              if (now - this._lastProgressEmit >= PROGRESS_EMIT_MS) {
                this._lastProgressEmit = now;
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
                this._emitOverallProgress();
              }
            }
          }
        );

        child.stderr.on(
          'data',
          (chunk) => {
            stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
          }
        );

        child.on(
          'error',
          (err) => {
            this.currentProcess = null;
            reject(err);
          }
        );

        child.on(
          'close',
          (code) => {
            this.currentProcess = null;
            resolve({ code, stderr });
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

    return probeCache.getOrLoad(file, () => this._probeDuration(ffprobe, file), 'duration');
  }

  /** Pré-carrega as durações da fila com no máximo PROBE_CONCURRENCY ffprobes simultâneos. */
  _prefetchDurations(files) {
    const pending = files.slice();
    const worker = async () => {
      while (pending.length) {
        const f = pending.shift();
        try { await this.getVideoDuration(f); } catch (_) { /* o erro reaparece (e é tratado) na conversão */ }
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(PROBE_CONCURRENCY, pending.length); i++) workers.push(worker());
    return Promise.all(workers);
  }

  _probeDuration(ffprobe, file) {
    return new Promise(
      (resolve, reject) => {
        const child =
          processRunner.spawn(
            ffprobe,
            [
              '-v',
              'error',
              '-show_entries',
              'format=duration',
              '-of',
              'default=noprint_wrappers=1:nokey=1',
              file
            ]
          );

        let output = '';
        let errorOutput = '';
        let timedOut = false;

        // ffprobe travado não pode bloquear a fila: encerra a árvore após 30s
        const probeTimer = setTimeout(() => {
          timedOut = true;
          processRunner.cancel(child);
        }, 30000);
        if (probeTimer.unref) probeTimer.unref();

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
          (err) => {
            clearTimeout(probeTimer);
            reject(err);
          }
        );

        child.on(
          'close',
          (code) => {
            clearTimeout(probeTimer);
            if (timedOut) {
              return reject(
                new Error('Tempo limite excedido ao obter a duração.')
              );
            }
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

  /** @param {import('child_process').ChildProcess|number} childOrPid */
  async killProcessTree(childOrPid) {
    if (!childOrPid) return;
    await processRunner.cancel(childOrPid);
  }
}

module.exports = ConverterService;