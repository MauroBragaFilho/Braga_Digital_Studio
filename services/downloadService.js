const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const logger = require('./logService');
const { detectarSpotify, validarSpotifyDownload } = require('./spotifyValidator');
const browserService = require('./browserService');
const CookiesService = require('../src/core/CookiesService');
const dbManager = require('../src/core/database/database');

class DownloadManager extends EventEmitter {
  constructor({ paths, getSettings, historyService }) {
    super();
    this.paths = paths;
    this.getSettings = getSettings;
    this.historyService = historyService;

    this.queue = [];
    this.isProcessing = false;
    this.isPaused = false;
    this.currentProcess = null;
    this.currentItem = null;

    // Carrega a fila salva no SQLite no startup
    this.initDatabaseQueue();
  }

  initDatabaseQueue() {
    try {
      const db = dbManager.get();
      const rows = db.prepare(`
        SELECT * FROM download_queue ORDER BY position ASC, created_at ASC
      `).all();

      this.queue = rows.map(r => ({
        id: r.id,
        url: r.url,
        title: r.title || 'Mídia sem título',
        thumbnail: r.thumbnail || '',
        channel: r.channel || '',
        platform: r.platform || '',
        duration: r.duration ? Number(r.duration) : null,
        format: (r.format || 'MP4').toUpperCase(),
        quality: r.quality || 'best',
        status: (r.status === 'downloading' || r.status === 'paused') ? 'queued' : r.status,
        progress: Number(r.progress || 0),
        downloadedBytes: Number(r.downloaded_bytes || 0),
        totalBytes: Number(r.total_bytes || 0),
        speed: r.speed || '',
        eta: r.eta || '',
        outputPath: r.output_path || '',
        error: r.error || '',
        position: Number(r.position || 0),
        createdAt: r.created_at,
        startedAt: r.started_at,
        completedAt: r.completed_at
      }));

      for (const item of this.queue) {
        this.saveItemToDb(item);
      }
    } catch (err) {
      logger.error('[DownloadManager] Erro ao carregar fila do banco:', err);
      this.queue = [];
    }
  }

  saveItemToDb(item) {
    try {
      const db = dbManager.get();
      const exists = db.prepare('SELECT id FROM download_queue WHERE id = ?').get(item.id);
      if (exists) {
        db.prepare(`
          UPDATE download_queue SET
            url = ?, title = ?, thumbnail = ?, channel = ?, platform = ?, duration = ?,
            format = ?, quality = ?, status = ?, progress = ?, downloaded_bytes = ?, total_bytes = ?,
            speed = ?, eta = ?, output_path = ?, error = ?, position = ?,
            started_at = ?, completed_at = ?
          WHERE id = ?
        `).run(
          item.url, item.title, item.thumbnail, item.channel || '', item.platform || '', item.duration || null,
          item.format, item.quality, item.status, item.progress, item.downloadedBytes, item.totalBytes,
          item.speed, item.eta, item.outputPath, item.error, item.position,
          item.startedAt || null, item.completedAt || null,
          item.id
        );
      } else {
        db.prepare(`
          INSERT INTO download_queue (
            id, url, title, thumbnail, channel, platform, duration, format, quality, status, progress,
            downloaded_bytes, total_bytes, speed, eta, output_path, error,
            position, created_at, started_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id, item.url, item.title, item.thumbnail, item.channel || '', item.platform || '', item.duration || null,
          item.format, item.quality, item.status, item.progress, item.downloadedBytes, item.totalBytes,
          item.speed, item.eta, item.outputPath, item.error, item.position,
          item.createdAt || new Date().toISOString(),
          item.startedAt || null, item.completedAt || null
        );
      }
    } catch (err) {
      logger.error('[DownloadManager] Erro ao salvar item no banco:', err);
    }
  }

  deleteItemFromDb(id) {
    try {
      const db = dbManager.get();
      db.prepare('DELETE FROM download_queue WHERE id = ?').run(id);
    } catch (err) {
      logger.error('[DownloadManager] Erro ao remover item do banco:', err);
    }
  }

  getQueue() {
    return this.queue;
  }

  add(request) {
    this.validateRequest(request);
    const settings = this.getSettings();
    const isSpotify = detectarSpotify(request.url).isSpotify;
    const format = (request.format || request.type || 'MP4').toUpperCase();
    const folder = format === 'MP3' ? settings.mp3Folder : settings.mp4Folder;
    fs.mkdirSync(folder, { recursive: true });

    const maxPos = this.queue.reduce((max, i) => Math.max(max, i.position || 0), 0);
    const item = {
      id: 'dl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      url: request.url,
      title: request.title || 'Mídia sem título',
      thumbnail: request.thumbnail || '',
      channel: request.channel || '',
      platform: request.platform || (isSpotify ? 'Spotify' : 'YouTube'),
      duration: request.duration || null,
      format,
      quality: request.quality || request.resolution || 'best',
      folder,
      isSpotify,
      status: 'queued',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speed: '',
      eta: '',
      outputPath: '',
      error: '',
      position: maxPos + 1,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null
    };

    this.queue.push(item);
    this.saveItemToDb(item);

    logger.info('[DownloadManager] Item adicionado à fila:', { id: item.id, title: item.title });
    this.emit('downloads:added', item);
    this.emit('downloads:updated', this.queue);
    return item;
  }

  async start() {
    if (this.isProcessing && !this.isPaused) {
      return { ok: true, message: 'Fila já está em processamento.' };
    }

    this.isPaused = false;
    this.isProcessing = true;
    this.processQueue();
    return { ok: true };
  }

  pause() {
    this.isPaused = true;
    this.isProcessing = false;

    if (this.currentItem && this.currentItem.status === 'downloading') {
      this.currentItem.status = 'paused';
      this.saveItemToDb(this.currentItem);
      if (this.currentProcess) {
        this.killProcessTree(this.currentProcess.pid);
        this.currentProcess = null;
      }
    }

    this.emit('downloads:updated', this.queue);
    return { ok: true };
  }

  async cancel(id) {
    const item = this.queue.find(i => i.id === id);
    if (!item) return { ok: false, error: 'Item não encontrado.' };

    if (item === this.currentItem && this.currentProcess) {
      item.status = 'cancelled';
      item.error = 'Cancelado pelo usuário';
      this.saveItemToDb(item);
      await this.killProcessTree(this.currentProcess.pid);
      this.currentProcess = null;
    } else {
      item.status = 'cancelled';
      item.error = 'Cancelado pelo usuário';
      this.saveItemToDb(item);
    }

    this.emit('downloads:updated', this.queue);
    return { ok: true };
  }

  retry(id) {
    const item = this.queue.find(i => i.id === id);
    if (!item) return { ok: false, error: 'Item não encontrado.' };

    item.status = 'queued';
    item.progress = 0;
    item.error = '';
    item.startedAt = null;
    item.completedAt = null;
    this.saveItemToDb(item);

    this.emit('downloads:updated', this.queue);

    if (this.isProcessing && !this.currentItem) {
      this.processQueue();
    }

    return { ok: true };
  }

  remove(id) {
    const index = this.queue.findIndex(i => i.id === id);
    if (index === -1) return { ok: false, error: 'Item não encontrado.' };

    const item = this.queue[index];
    if (item === this.currentItem && this.currentProcess) {
      this.killProcessTree(this.currentProcess.pid);
      this.currentProcess = null;
    }

    this.queue.splice(index, 1);
    this.deleteItemFromDb(id);

    this.emit('downloads:removed', id);
    this.emit('downloads:updated', this.queue);
    return { ok: true };
  }

  reorder(id, direction) {
    const index = this.queue.findIndex(i => i.id === id);
    if (index === -1) return { ok: false, error: 'Item não encontrado.' };

    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= this.queue.length) return { ok: false };

    // Troca de posição
    const temp = this.queue[index];
    this.queue[index] = this.queue[targetIndex];
    this.queue[targetIndex] = temp;

    // Atualiza posições numéricas
    this.queue.forEach((item, pos) => {
      item.position = pos + 1;
      this.saveItemToDb(item);
    });

    this.emit('downloads:updated', this.queue);
    return { ok: true };
  }

  clearCompleted() {
    const completedItems = this.queue.filter(i => i.status === 'completed');
    for (const item of completedItems) {
      this.deleteItemFromDb(item.id);
    }
    this.queue = this.queue.filter(i => i.status !== 'completed');
    this.emit('downloads:updated', this.queue);
    return { ok: true };
  }

  clearAll() {
    if (this.currentProcess) {
      this.killProcessTree(this.currentProcess.pid);
      this.currentProcess = null;
    }
    for (const item of this.queue) {
      this.deleteItemFromDb(item.id);
    }
    this.queue = [];
    this.isProcessing = false;
    this.currentItem = null;
    this.emit('downloads:updated', this.queue);
    return { ok: true };
  }

  toggleFormat(id, newFormat) {
    const item = this.queue.find(i => i.id === id);
    if (!item) return { ok: false, error: 'Item não encontrado.' };

    const settings = this.getSettings();
    const targetFormat = (newFormat || (item.format === 'MP4' ? 'MP3' : 'MP4')).toUpperCase();
    
    // Se mudou de formato, ajusta a qualidade padrão para o novo formato se necessário
    if (item.format !== targetFormat) {
      item.format = targetFormat;
      if (targetFormat === 'MP3') {
        item.quality = '320kbps';
      } else {
        item.quality = 'best';
      }
    }
    
    item.folder = item.format === 'MP3' ? settings.mp3Folder : settings.mp4Folder;
    this.saveItemToDb(item);

    this.emit('downloads:updated', this.queue);
    return { ok: true };
  }

  updateQuality(id, newQuality) {
    const item = this.queue.find(i => i.id === id);
    if (!item) return { ok: false, error: 'Item não encontrado.' };

    item.quality = newQuality || 'best';
    this.saveItemToDb(item);

    this.emit('downloads:updated', this.queue);
    return { ok: true };
  }

  async processQueue() {
    if (this.isPaused) return;

    // REGRA 1: Permitir 1 download por vez. Encontra o próximo item queued.
    const nextItem = this.queue.find(i => i.status === 'queued');

    if (!nextItem) {
      this.isProcessing = false;
      this.currentItem = null;
      this.emit('downloads:queue-completed');
      this.emit('downloads:updated', this.queue);
      return;
    }

    this.currentItem = nextItem;
    this.currentItem.status = 'downloading';
    this.currentItem.startedAt = new Date().toISOString();
    this.saveItemToDb(this.currentItem);
    this.emit('downloads:updated', this.queue);

    logger.info('[DownloadManager] Iniciando download do item:', { id: nextItem.id, title: nextItem.title });

    try {
      await this.runProcess(this.currentItem);
    } catch (err) {
      logger.error('[DownloadManager] Erro na execução do item:', err);
      this.currentItem.status = 'failed';
      this.currentItem.error = err.message;
      this.saveItemToDb(this.currentItem);
      this.emit('downloads:failed', { item: this.currentItem, error: err.message });
    }

    this.currentItem = null;

    // REGRA 2 & 3: Quando um download termina ou falha, avança automaticamente para o próximo item
    if (!this.isPaused) {
      setTimeout(() => this.processQueue(), 500);
    }
  }

  async runProcess(item) {
    const settings = this.getSettings();
    const command = await this.buildCommand(item, settings);

    return new Promise((resolve) => {
      const child = spawn(command.exe, command.args, {
        cwd: item.folder || settings.mp4Folder,
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

      child.stdout.on('data', (chunk) => this.handleOutput(chunk.toString('utf8'), item));
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stderr += text;
        this.handleOutput(text, item);
      });

      child.on('error', (error) => {
        item.status = 'failed';
        item.error = error.message;
        this.saveItemToDb(item);
        this.emit('downloads:failed', { item, error: error.message });
        this.emit('downloads:updated', this.queue);
        resolve();
      });

      child.on('close', (code) => {
        this.currentProcess = null;
        if (item.status === 'cancelled' || item.status === 'paused') {
          resolve();
          return;
        }

        if (code === 0) {
          item.status = 'completed';
          item.progress = 100;
          item.completedAt = new Date().toISOString();
          this.saveItemToDb(item);

          if (this.historyService) {
            this.historyService.addDownload({
              titulo: item.title,
              url: item.url,
              tipo: item.format,
              resolucao: item.quality,
              pasta: item.folder,
              status: 'sucesso'
            });
          }

          this.emit('downloads:completed', item);
        } else {
          item.status = 'failed';
          item.error = stderr.trim() || `Processo finalizou com código ${code}`;
          this.saveItemToDb(item);
          this.emit('downloads:failed', { item, error: item.error });
        }

        this.emit('downloads:updated', this.queue);
        resolve();
      });
    });
  }

  handleOutput(text, item) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const destination = line.match(/\[download\]\s+Destination:\s+(.+)$/i);
      if (destination) {
        item.outputPath = destination[1];
        item.title = path.basename(destination[1], path.extname(destination[1]));
      }

      const merger = line.match(/\[Merger\]\s+Merging formats into\s+"?([^"]+)"?/i);
      if (merger) {
        item.outputPath = merger[1].replace(/"/g, '');
        item.title = path.basename(item.outputPath, path.extname(item.outputPath));
      }

      const parsed = this.parseProgress(line);
      if (parsed.percent !== null) item.progress = parsed.percent;
      if (parsed.speed) item.speed = parsed.speed;
      if (parsed.eta) item.eta = parsed.eta;
      if (parsed.downloadedBytes) item.downloadedBytes = parsed.downloadedBytes;
      if (parsed.totalBytes) item.totalBytes = parsed.totalBytes;

      this.saveItemToDb(item);
      this.emit('downloads:progress', {
        id: item.id,
        progress: item.progress,
        downloadedBytes: item.downloadedBytes,
        totalBytes: item.totalBytes,
        speed: item.speed,
        eta: item.eta,
        status: item.status
      });
    }
  }

  parseProgress(line) {
    const percentMatch = line.match(/(\d+(?:\.\d+)?)%/);
    const speedMatch = line.match(/at\s+([^\s]+\/s)/i);
    const etaMatch = line.match(/ETA\s+([^\s]+)/i);
    const sizeMatch = line.match(/of\s+~?\s*([0-9.]+)\s*([KiBmGiB]+)/i);

    let totalBytes = 0;
    let downloadedBytes = 0;

    if (sizeMatch) {
      const val = parseFloat(sizeMatch[1]);
      const unit = sizeMatch[2].toLowerCase();
      let mult = 1024 * 1024;
      if (unit.startsWith('k')) mult = 1024;
      if (unit.startsWith('g')) mult = 1024 * 1024 * 1024;
      totalBytes = Math.round(val * mult);
      if (percentMatch) {
        downloadedBytes = Math.round((totalBytes * parseFloat(percentMatch[1])) / 100);
      }
    }

    return {
      percent: percentMatch ? Number(percentMatch[1]) : null,
      speed: speedMatch ? speedMatch[1] : '',
      eta: etaMatch ? etaMatch[1] : '',
      downloadedBytes,
      totalBytes
    };
  }

  async buildCommand(item, settings) {
    if (item.isSpotify) {
      const exe = path.join(this.paths.dataDir, 'spotify-dlp.exe');
      return {
        exe,
        args: ['--output', '{title}.{output-ext}', '--format', 'mp3', item.url]
      };
    }

    const exe = path.join(this.paths.dataDir, 'yt-dlp.exe');
    const args = [
      '--newline',
      '--progress',
      '--windows-filenames',
      '--restrict-filenames',
      '--no-part',
      '--no-mtime',
      '--ffmpeg-location', this.paths.dataDir
    ];

    if (settings.cookiesFile && fs.existsSync(settings.cookiesFile)) {
      args.push('--cookies', settings.cookiesFile);
    }

    if (item.format === 'MP3') {
      let audioQuality = '0'; // 0 = VBR Best (~250-320kbps)
      if (item.quality === '320kbps') audioQuality = '0';
      else if (item.quality === '256kbps') audioQuality = '2';
      else if (item.quality === '192kbps') audioQuality = '4';
      else if (item.quality === '128kbps') audioQuality = '6';
      
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', audioQuality, '--embed-metadata', '--embed-thumbnail');
      args.push('-P', item.folder || settings.mp3Folder, '-o', '%(title)s.%(ext)s', item.url);
    } else {
      const resolution = item.quality && item.quality !== 'best' ? item.quality.replace('p', '') : 'best';
      const format = resolution && resolution !== 'best'
        ? `bv*[height<=${resolution}][ext=mp4]+ba[ext=m4a]/b[height<=${resolution}][ext=mp4]/best[height<=${resolution}]`
        : 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best';

      args.push('-f', format, '--merge-output-format', 'mp4', '--embed-metadata', '--embed-thumbnail');
      args.push('-P', item.folder || settings.mp4Folder, '-o', '%(title)s.%(ext)s', item.url);
    }

    return { exe, args };
  }

  killProcessTree(pid) {
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

  validateRequest(request) {
    if (!request || !request.url) throw new Error('Informe uma URL.');
    try {
      const parsed = new URL(request.url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Protocolo inválido');
    } catch {
      throw new Error('Informe uma URL válida.');
    }
  }
}

module.exports = DownloadManager;