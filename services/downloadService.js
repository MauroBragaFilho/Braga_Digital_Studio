const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const logger = require('./logService');
const { detectarSpotify, validarSpotifyDownload } = require('./spotifyValidator');
const browserService = require('./browserService');
const CookiesService = require('../src/core/CookiesService');

class DownloadService extends EventEmitter {
  constructor({ paths, getSettings, historyService }) {
    super();
    this.paths = paths;
    this.getSettings = getSettings;
    this.historyService = historyService;
    this.currentProcess = null;
    this.currentRequest = null;
    this.lastTitle = 'Sem título';
    this.cancelRequested = false;
  }

  isRunning() {
    return Boolean(this.currentProcess);
  }

  async startDownload(request) {
    if (this.currentProcess) {
      throw new Error('Já existe um download em andamento.');
    }

    this.validateRequest(request);
    const settings = this.getSettings();
    const isSpotify = detectarSpotify(request.url).isSpotify;
    const folder = request.type === 'MP3' ? settings.mp3Folder : settings.mp4Folder;
    fs.mkdirSync(folder, { recursive: true });

    try {
      const cookiePath = path.join(this.paths.dataDir, 'youtube_cookies.txt');
      const exported = await CookiesService.exportNetscapeCookies('.youtube.com', cookiePath, 'persist:youtube');
      if (exported) {
        settings.cookiesFile = cookiePath;
      }
    } catch (e) {
      logger.warn('Erro ao extrair cookies para o download:', e);
    }

    const command = this.buildCommand({ ...request, isSpotify, folder, settings });
    this.currentRequest = { ...request, folder, isSpotify };
    this.lastTitle = request.title || 'Sem título';
    this.cancelRequested = false;

    console.log({
      isYoutubeMusic: request.isYoutubeMusic
    });

    logger.info('download:start', {
      url: request.url,
      type: request.type,
      resolution: request.resolution,
      folder,
      tool: path.basename(command.exe)
    });

    const child = spawn(command.exe, command.args, {
      cwd: folder,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `${this.paths.dataDir};${process.env.PATH || ''}`,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      }
    });

    this.currentProcess = child;
    let stderr = '';

    child.stdout.on('data', (chunk) => this.handleOutput(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      this.handleOutput(text);
    });

    child.on('error', (error) => {
      this.finishDownload('erro', error.message);
    });

    child.on('close', (code) => {
      if (this.cancelRequested) {
        this.finishDownload('cancelado', 'Download cancelado.');
      } else if (code === 0) {
        this.finishDownload('sucesso', 'Download concluído.');
      } else {
        this.finishDownload('erro', stderr.trim() || `Processo finalizou com código ${code}.`);
      }
    });

    this.emit('progress', {
      percent: 0,
      speed: '',
      eta: '',
      status: 'Download iniciado.',
      running: true
    });

    return { ok: true };
  }

  async cancelDownload(reason = 'Cancelado') {
    if (!this.currentProcess) return { ok: true };
    this.cancelRequested = true;
    const child = this.currentProcess;

    logger.warn('download:cancel', { reason, pid: child.pid });
    await this.killProcessTree(child.pid);
    return { ok: true };
  }

  buildCommand({ type, url, resolution, isSpotify, isYoutubeMusic, folder, settings }) {
    if (isSpotify) {
      if (type !== 'MP3') throw new Error('Links do Spotify só podem ser baixados como MP3.');
      const spotifyInfo = validarSpotifyDownload(url);
      if (spotifyInfo.permitido === false) {
        logger.warn(`[SPOTIFY]\nLink bloqueado: ${spotifyInfo.tipo}`);
        throw new Error(
          'Este tipo de link do Spotify não é suportado.\n\n' +
          'Tipo detectado:\n' +
          `${this.formatSpotifyType(spotifyInfo.tipo)}\n\n` +
          'Utilize um link de música, álbum ou playlist.'
        );
      }

      logger.info(`[SPOTIFY]\nTipo detectado: ${spotifyInfo.tipo}`);
      const exe = path.join(this.paths.dataDir, 'spotify-dlp.exe');
      this.assertExecutable(exe);
      return {
        exe,
        args: [
          '--output', '{title}.{output-ext}',
          '--format', 'mp3',
          url
        ]
      };
    }

    const exe = path.join(this.paths.dataDir, 'yt-dlp.exe');
    this.assertExecutable(exe);
    const args = [
      '--newline',
      '--progress',
      '--windows-filenames',
      '--restrict-filenames',
      '--no-part',
      '--no-mtime',
      '--ffmpeg-location', this.paths.dataDir
    ];
    const cookiesFile = settings.cookiesFile;

    // Lógica para downloads via yt-dlp (YouTube e outros)
    if (!isSpotify) {
      
      // --- INÍCIO DA NOVA LÓGICA OPCIONAL DE CONTA (OAuth2) ---
      if (settings.useYoutubeAccount) {
        logger.info('youtube:using-oauth2', { message: 'Conta habilitada para este download' });
        args.push('--username', 'oauth2');
      }
      // --- FIM DA NOVA LÓGICA ---

      // Lógica de fallback para cookies de navegador (mantida para redundância)
      let browser = settings.browser;
      if (!browser || browser === 'auto') {
        browser = browserService.getPreferredBrowser();
      }
      if (cookiesFile && fs.existsSync(cookiesFile)) {
        logger.info('cookies:using-file', { file: cookiesFile });
        args.push('--cookies', cookiesFile);
      } else {
        logger.warn('cookies:none');
      }
    }

    if (type === 'MP3') {
      args.push(
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--embed-metadata',
        '--embed-thumbnail'
      );

      if (isYoutubeMusic) {
        args.push(
          '--ppa',
          'EmbedThumbnail+ffmpeg_o:-vf crop=min(in_w\\,in_h):min(in_w\\,in_h)'
        );
      }

      args.push(
        '-P', folder,
        '-o', '%(title)s.%(ext)s',
        url
      );
    } else {
      const format = resolution && resolution !== 'best'
        ? `bv*[height<=${resolution}][ext=mp4]+ba[ext=m4a]/b[height<=${resolution}][ext=mp4]/best[height<=${resolution}]`
        : 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best';

      args.push(
        '-f', format,
        '--merge-output-format', 'mp4',
        '--embed-metadata',
        '--embed-thumbnail',
        '-P', folder,
        '-o', '%(title)s.%(ext)s',
        url
      );
    }

    return { exe, args };
  }

  handleOutput(text) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const destination = line.match(/\[download\]\s+Destination:\s+(.+)$/i);
      if (destination) {
        this.lastTitle = path.basename(destination[1], path.extname(destination[1]));
      }

      const title = line.match(/\[Metadata\]\s+Adding metadata to "(.+)"/i);
      if (title) {
        this.lastTitle = path.basename(title[1], path.extname(title[1]));
      }

      const parsed = this.parseProgress(line);
      logger.info('download:progress', { line });
      this.emit('progress', {
        ...parsed,
        status: line,
        running: true
      });
    }
  }

  parseProgress(line) {
    const percentMatch = line.match(/(\d+(?:\.\d+)?)%/);
    const speedMatch = line.match(/at\s+([^\s]+\/s)/i);
    const etaMatch = line.match(/ETA\s+([^\s]+)/i);
    return {
      percent: percentMatch ? Number(percentMatch[1]) : null,
      speed: speedMatch ? speedMatch[1] : '',
      eta: etaMatch ? etaMatch[1] : ''
    };
  }

  finishDownload(status, message) {
    const request = this.currentRequest;
    this.currentProcess = null;
    this.cancelRequested = false;

    if (request) {
      this.historyService.addDownload({
        titulo: this.lastTitle,
        url: request.url,
        tipo: request.type,
        resolucao: request.type === 'MP4' ? request.resolution : '',
        pasta: request.folder,
        status
      });
    }

    logger.info('download:finished', { status, message });
    this.emit('finished', {
      status,
      message,
      running: false,
      title: this.lastTitle
    });
    this.currentRequest = null;
  }

  killProcessTree(pid) {
    return new Promise((resolve) => {
      if (!pid) return resolve();
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        killer.on('close', () => resolve());
        killer.on('error', () => resolve());
      } else {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
        }
        resolve();
      }
    });
  }

  assertExecutable(exePath) {
    if (!fs.existsSync(exePath)) {
      throw new Error(`${path.basename(exePath)} não encontrado em ${exePath}`);
    }
  }

  validateRequest(request) {
    if (!request || !request.url) throw new Error('Informe uma URL.');
    if (detectarSpotify(request.url).isSpotify) {
      if (!['MP3', 'MP4'].includes(request.type)) throw new Error('Tipo de download invÃ¡lido.');
      return;
    }
    try {
      const parsed = new URL(request.url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Protocolo inválido');
    } catch {
      throw new Error('Informe uma URL válida.');
    }
    if (!['MP3', 'MP4'].includes(request.type)) throw new Error('Tipo de download inválido.');
  }

  isSpotifyUrl(url) {
    return detectarSpotify(url).isSpotify;
  }

  formatSpotifyType(type) {
    if (!type) return 'Desconhecido';
    return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

module.exports = DownloadService;