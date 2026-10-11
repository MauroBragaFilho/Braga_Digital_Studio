const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const logger = require('./logService');
const { detectarSpotify, validarSpotifyDownload } = require('./spotifyValidator');
const browserService = require('./browserService');
const CookiesService = require('../core/CookiesService');
const dbManager = require('../core/database/database');
const { ytDlpTool } = require('../infrastructure/external-tools/adapters/YtDlpTool');
const { spotDlTool } = require('../infrastructure/external-tools/adapters/SpotDlTool');
const { processRunner } = require('../infrastructure/external-tools/ProcessRunner');
const { isHttpUrl, assertHttpUrl } = require('./urlValidator');
const { friendlyYtDlpError, sanitizeUserMessage } = require('./ytdlpErrors');
const { inspectCookiesFile, cookiesFileFor } = require('./youtubeCookies');
const { uniqueSuffixPath } = require('./uniquePath');

// Subpasta temporária de cada item, dentro da pasta de destino: o ponto inicial a deixa fora do escaneamento e
// do observador da Biblioteca. Tudo é baixado ali e só o arquivo FINAL é movido para o destino, com nome único.
const WORKDIR_PREFIX = '.bds-dl-';
// Tempo máximo (ms) para carregar título/miniatura de UM link (o serviço de metadados também tem o seu, de 15 s)
const METADATA_TIMEOUT_MS = 20000;
// Parâmetros de rastreio/compartilhamento que não mudam o conteúdo do link
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|dclid|msclkid|igshid|igsh|si|feature|pp|ref|ref_.*|spm|mc_.*|cmpid|share|share_id|sharing_id|rdt_cid|_ga)$/i;

/** Nome do site pela URL (para o cartão aparecer na hora, antes de qualquer análise). */
function siteName(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^(www|m)\./, '');
    if (host === 'music.youtube.com') return 'YouTube Music';
    if (host === 'youtu.be' || /(^|\.)youtube(-nocookie)?\.com$/.test(host)) return 'YouTube';
    if (host === 'spotify.com' || host.endsWith('.spotify.com')) return 'Spotify';
    if (/(^|\.)vimeo\.com$/.test(host)) return 'Vimeo';
    if (/(^|\.)tiktok\.com$/.test(host)) return 'TikTok';
    if (/(^|\.)instagram\.com$/.test(host)) return 'Instagram';
    if (/(^|\.)facebook\.com$/.test(host) || host === 'fb.watch') return 'Facebook';
    if (host === 'x.com' || /(^|\.)twitter\.com$/.test(host)) return 'X (Twitter)';
    if (/(^|\.)soundcloud\.com$/.test(host)) return 'SoundCloud';
    if (/(^|\.)dailymotion\.com$/.test(host)) return 'Dailymotion';
    if (/(^|\.)twitch\.tv$/.test(host)) return 'Twitch';
    return host || 'Link';
  } catch (_) {
    return 'Link';
  }
}

/** Título neutro enquanto o nome real não chega (nunca "erro"): "Vídeo do YouTube", "Música", "Vídeo de vimeo.com". */
function neutralTitle(url, format) {
  const site = siteName(url);
  const audio = format === 'MP3';
  if (site === 'Spotify') return 'Música';
  if (site === 'YouTube') return audio ? 'Música do YouTube' : 'Vídeo do YouTube';
  if (site === 'YouTube Music') return 'Música do YouTube';
  return `${audio ? 'Áudio' : 'Vídeo'} de ${site}`;
}

const DUPLICATE_MESSAGES = {
  DUPLICATE_QUEUED: 'Este link já está na fila.',
  DUPLICATE_DOWNLOADED: 'Este link já foi baixado e o arquivo continua na pasta de destino.'
};

/** Erro de link repetido: `code` estável + mensagem em português; `existingId` aponta o cartão que já existe. */
function duplicateError(code, existing, fileName) {
  const message = code === 'DUPLICATE_DOWNLOADED' && fileName
    ? `Este link já foi baixado. O arquivo "${fileName}" continua na pasta de destino.`
    : DUPLICATE_MESSAGES[code];
  return Object.assign(new Error(message), { code, existingId: existing ? existing.id : null, fileName: fileName || '' });
}

/** Cria o arquivo `dest` a partir de `src` SEM nunca sobrescrever: link físico (instantâneo) ou cópia exclusiva; depois solta `src`. */
function moveWithoutOverwrite(src, dest) {
  try {
    fs.linkSync(src, dest);
  } catch (err) {
    if (err && err.code === 'EEXIST') throw err;
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL); // volume sem link físico (FAT, rede…)
  }
  try { fs.unlinkSync(src); } catch (_) { /* a limpeza da subpasta tenta de novo */ }
}

// Persistência/emissão de progresso no máximo a cada 500ms (mudanças de status gravam na hora)
const PROGRESS_THROTTLE_MS = 500;
// Sem nenhuma saída do yt-dlp por este tempo => considera travado, mata a árvore e marca falha
const DEFAULT_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

/** Só MP4 ou MP3: qualquer outro valor vindo da tela cai em MP4. */
function normalizeFormat(value) {
  return String(value || 'MP4').toUpperCase() === 'MP3' ? 'MP3' : 'MP4';
}

/** Qualidade aceita: "best", altura ("720" ou "720p") ou bitrate ("320kbps"); o resto vira "best". */
function normalizeQuality(value) {
  const q = String(value || 'best').trim().toLowerCase();
  return /^(best|\d{3,4}p?|\d{2,3}kbps)$/.test(q) ? q : 'best';
}

/**
 * Pausa aleatória entre downloads de uma lista (evita que o YouTube trate a fila como robô).
 * Ajustável em Configurações → Mídia; padrão 10 s a 3 min.
 */
const PAUSE_DEFAULT_MIN_SEC = 10;
const PAUSE_DEFAULT_MAX_SEC = 180;

/** Lê e valida a configuração de pausa: { enabled, minSec, maxSec } (min <= max, dentro de 0 a 600 s). */
function readPauseSettings(settings) {
  const s = settings || {};
  const clamp = (v, d) => {
    if (v === null || v === undefined || v === '') return d; // Number(null) seria 0: ausente não é "sem pausa"
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(600, Math.max(0, Math.round(n))) : d;
  };
  const minSec = clamp(s.downloadPauseMinSec, PAUSE_DEFAULT_MIN_SEC);
  const maxSec = Math.max(minSec, clamp(s.downloadPauseMaxSec, PAUSE_DEFAULT_MAX_SEC));
  return { enabled: s.downloadPauseEnabled !== false, minSec, maxSec };
}

/** Sorteia a espera (em ms) dentro da faixa configurada. `random` é injetável para teste. */
function pickPauseMs({ minSec, maxSec }, random = Math.random) {
  return Math.round((minSec + random() * (maxSec - minSec)) * 1000);
}

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

    this._processing = false;      // trava de reentrância de processQueue
    this._rerunRequested = false;  // alguém pediu processQueue enquanto havia uma execução ativa
    this._lastSaveAt = 0;
    this._lastEmitAt = 0;
    this._lastActivityAt = 0;      // última saída do processo atual (watchdog)

    // Pausa entre downloads: instante em que a espera termina (null = sem espera) e como acordar antes
    this._waitUntil = null;
    this._wakeWait = null;

    // Cookies do YouTube: função opcional (injetada pelo bootstrap) que renova o arquivo a partir da sessão
    // da aba Envio; _cookiesFile é o arquivo validado para esta rodada da fila
    this.cookiesProvider = null;
    this._cookiesFile = undefined;
    this._cookiesCheckedAt = 0;

    // Título/miniatura/canal/duração dos links novos: provedor injetado pelo bootstrap (async url => meta) e fila
    // sequencial de UM link por vez (nunca em massa). Sem provedor, os cartões ficam só com o nome do site.
    this.metadataProvider = null;
    this.metadataTimeoutMs = METADATA_TIMEOUT_MS;
    this._metaQueue = [];
    this._metaRunning = false;
    // Funções de cancelamento ficam num Map à parte: o item é enviado à tela e precisa ser clonável (sem funções)
    this._metaAbort = new Map();

    // Carrega a fila salva no SQLite no startup
    this.initDatabaseQueue();
  }

  initDatabaseQueue() {
    try {
      const db = dbManager.get();
      const rows = db.prepare(`
        SELECT * FROM download_queue ORDER BY position ASC, created_at ASC
      `).all();

      const settings = this.getSettings ? this.getSettings() : {};
      this.queue = rows.map(r => {
        const format = (r.format || 'MP4').toUpperCase();
        // Itens que estavam em andamento/na fila voltam para a fila e o progresso é zerado:
        // o yt-dlp retoma o ".part" (--continue) e o percentual real reaparece nas primeiras linhas.
        const wasActive = ['downloading', 'paused', 'queued'].includes(r.status);
        const urlOk = isHttpUrl(r.url);
        let status = (r.status === 'downloading' || r.status === 'paused') ? 'queued' : r.status;
        let error = r.error || '';
        if (!urlOk && status === 'queued') {
          // O banco pode ter sido editado/corrompido: nunca executa URL que não seja http(s) válida
          status = 'failed';
          error = 'URL inválida (item bloqueado por segurança).';
        }
        return {
          id: r.id,
          url: r.url,
          title: r.title || 'Mídia sem título',
          thumbnail: r.thumbnail || '',
          channel: r.channel || '',
          platform: r.platform || '',
          duration: r.duration ? Number(r.duration) : null,
          format,
          quality: r.quality || 'best',
          folder: format === 'MP3' ? settings.mp3Folder : settings.mp4Folder,
          status,
          progress: wasActive ? 0 : Number(r.progress || 0),
          downloadedBytes: wasActive ? 0 : Number(r.downloaded_bytes || 0),
          totalBytes: wasActive ? 0 : Number(r.total_bytes || 0),
          speed: wasActive ? '' : (r.speed || ''),
          eta: wasActive ? '' : (r.eta || ''),
          outputPath: r.output_path || '',
          error,
          position: Number(r.position || 0),
          isSpotify: r.platform === 'Spotify',
          createdAt: r.created_at,
          startedAt: r.started_at,
          completedAt: r.completed_at
        };
      });

      for (const item of this.queue) {
        this.saveItemToDb(item);
      }
    } catch (err) {
      logger.error('[DownloadManager] Erro ao carregar fila do banco:', err);
      this.queue = [];
    }
  }

  /** UPSERT em um único statement (antes: SELECT + UPDATE/INSERT). created_at nunca é sobrescrito. */
  static get UPSERT_SQL() {
    return `
      INSERT INTO download_queue (
        id, url, title, thumbnail, channel, platform, duration, format, quality, status, progress,
        downloaded_bytes, total_bytes, speed, eta, output_path, error,
        position, created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        url = excluded.url, title = excluded.title, thumbnail = excluded.thumbnail,
        channel = excluded.channel, platform = excluded.platform, duration = excluded.duration,
        format = excluded.format, quality = excluded.quality, status = excluded.status,
        progress = excluded.progress, downloaded_bytes = excluded.downloaded_bytes,
        total_bytes = excluded.total_bytes, speed = excluded.speed, eta = excluded.eta,
        output_path = excluded.output_path, error = excluded.error, position = excluded.position,
        started_at = excluded.started_at, completed_at = excluded.completed_at
    `;
  }

  saveItemToDb(item) {
    try {
      const db = dbManager.get();
      // O DBManager já mantém cache de statements por SQL: prepare() aqui é barato.
      db.prepare(DownloadManager.UPSERT_SQL).run(
        item.id, item.url, item.title, item.thumbnail, item.channel || '', item.platform || '', item.duration || null,
        item.format, item.quality, item.status, item.progress, item.downloadedBytes, item.totalBytes,
        item.speed, item.eta, item.outputPath, item.error, item.position,
        item.createdAt || new Date().toISOString(),
        item.startedAt || null, item.completedAt || null
      );
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

  /**
   * Procura o MESMO pedido (mesmo vídeo + mesmo formato + mesma qualidade) na fila.
   *  - na fila (aguardando/baixando/pausado)            -> { kind: 'queued', item }
   *  - concluído e o arquivo AINDA existe (size > 0)     -> { kind: 'downloaded', item, file }
   *  - concluído com arquivo apagado/movido, falhou ou cancelado -> { kind: 'stale', items } (podem ser substituídos)
   *  - nada parecido                                     -> null
   */
  _findDuplicate(url, format, quality) {
    const key = this._videoKey(url);
    if (!key) return null;
    const same = this.queue.filter((o) => this._videoKey(o.url) === key
      && o.format === format && (o.quality || 'best') === quality);
    if (!same.length) return null;

    const queued = same.find((o) => ['queued', 'downloading', 'paused'].includes(o.status));
    if (queued) return { kind: 'queued', item: queued };

    const exists = (p) => { try { return fs.statSync(p).size > 0; } catch (_) { return false; } };
    for (const o of same) {
      if (o.status === 'completed' && o.outputPath && exists(o.outputPath)) {
        return { kind: 'downloaded', item: o, file: o.outputPath };
      }
    }
    return { kind: 'stale', items: same };
  }

  /**
   * Adiciona um link à fila. Quem decide o status inicial é SEMPRE este método (o pedido não pode mandar
   * `status`/`error`): o item nasce "queued". Link repetido é recusado com `code` estável:
   *   DUPLICATE_QUEUED (já está na fila) ou DUPLICATE_DOWNLOADED (já baixado e o arquivo ainda existe).
   * Concluído com arquivo apagado, falho ou cancelado PODE ser baixado de novo: o cartão antigo é substituído.
   * Sem título no pedido, o cartão nasce com o nome do site + título neutro e as informações vêm depois (fila de metadados).
   */
  add(request) {
    const url = this.validateRequest(request);
    const settings = this.getSettings();
    const isSpotify = detectarSpotify(url).isSpotify;
    const format = normalizeFormat(request.format || request.type);
    const quality = normalizeQuality(request.quality || request.resolution);

    const dup = this._findDuplicate(url, format, quality);
    if (dup && dup.kind === 'queued') throw duplicateError('DUPLICATE_QUEUED', dup.item);
    if (dup && dup.kind === 'downloaded') throw duplicateError('DUPLICATE_DOWNLOADED', dup.item, path.basename(dup.file));

    const folder = format === 'MP3' ? settings.mp3Folder : settings.mp4Folder;
    fs.mkdirSync(folder, { recursive: true });

    // Cartões antigos do mesmo link que não valem mais (arquivo sumiu, falhou, cancelado) saem da fila
    if (dup && dup.kind === 'stale') {
      for (const old of dup.items) this._dropItem(old);
    }

    const maxPos = this.queue.reduce((max, i) => Math.max(max, i.position || 0), 0);
    const givenTitle = typeof request.title === 'string' ? request.title.trim() : '';
    const loadInfo = !givenTitle && typeof this.metadataProvider === 'function';

    const item = {
      id: 'dl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      url,
      title: givenTitle || neutralTitle(url, format),
      thumbnail: request.thumbnail || '',
      channel: request.channel || '',
      platform: isSpotify ? 'Spotify' : siteName(url),
      duration: request.duration || null,
      format,
      quality,
      folder,
      isSpotify,
      status: 'queued',
      infoLoading: loadInfo, // transitório (não vai para o banco): o cartão mostra "Carregando informações..."
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
    if (loadInfo) this._enqueueMetadata(item);
    return item;
  }

  /** Tira o item da fila e do banco sem matar processo (usado ao substituir cartões antigos). */
  _dropItem(item) {
    const index = this.queue.indexOf(item);
    if (index === -1) return;
    this.queue.splice(index, 1);
    this.deleteItemFromDb(item.id);
    this._cancelMetadata(item);
    this.emit('downloads:removed', item.id);
  }

  // ---- Informações do link (título, miniatura, canal, duração): UM link por vez, em ordem de chegada ----

  _enqueueMetadata(item) {
    this._metaQueue.push(item);
    if (!this._metaRunning) {
      this._metaRunning = true;
      this._runMetadataQueue().catch((err) => logger.warn('[DownloadManager] Fila de informações falhou', { error: err && err.message }));
    }
  }

  /** Item removido/cancelado: a espera por ele termina na hora e o resultado, se vier, é ignorado. */
  _cancelMetadata(item) {
    const i = this._metaQueue.indexOf(item);
    if (i !== -1) this._metaQueue.splice(i, 1);
    const abort = this._metaAbort.get(item);
    if (abort) abort();
    item.infoLoading = false;
  }

  async _runMetadataQueue() {
    try {
      while (this._metaQueue.length) {
        const item = this._metaQueue.shift();
        // Só busca de quem ainda está aguardando na fila: removido, baixando ou concluído não precisa
        if (!this.queue.includes(item) || item.status !== 'queued' || !item.infoLoading) {
          item.infoLoading = false;
          continue;
        }

        let meta = null;
        let timer = null;
        try {
          meta = await Promise.race([
            Promise.resolve().then(() => this.metadataProvider(item.url)),
            new Promise((resolve) => { this._metaAbort.set(item, () => resolve(null)); }),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), this.metadataTimeoutMs); })
          ]);
        } catch (err) {
          // Falha ao analisar NÃO é falha do item: continua "Aguardando" com o título neutro e o download tenta mesmo assim
          logger.warn('[DownloadManager] Não foi possível carregar as informações do link', { id: item.id, error: err && err.message });
          meta = null;
        } finally {
          clearTimeout(timer);
          this._metaAbort.delete(item);
        }

        item.infoLoading = false;
        if (!this.queue.includes(item)) continue; // removido durante a análise
        if (meta && item.status === 'queued') {
          const title = typeof meta.title === 'string' ? meta.title.trim() : '';
          if (title) item.title = title;
          if (meta.thumbnail) item.thumbnail = meta.thumbnail;
          if (meta.channel) item.channel = meta.channel;
          if (meta.duration) item.duration = Number(meta.duration) || item.duration;
        }
        this.saveItemToDb(item);
        this.emit('downloads:updated', this.queue);
      }
    } finally {
      this._metaRunning = false;
    }
  }

  async start() {
    if (this.isProcessing && !this.isPaused) {
      return { ok: true, message: 'Fila já está em processamento.' };
    }

    this.isPaused = false;
    this.isProcessing = true;
    // Itens pausados voltam para a fila (o yt-dlp continua do ".part")
    for (const item of this.queue) {
      if (item.status === 'paused') {
        item.status = 'queued';
        this.saveItemToDb(item);
      }
    }
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
        // Marca o filho: o fechamento dele (código != 0 por causa do kill) não pode virar "failed",
        // mesmo que start() já tenha devolvido o item para 'queued' antes de o processo morrer.
        this.currentProcess.killedByPause = true;
        this.killProcessTree(this.currentProcess);
        this.currentProcess = null;
      }
    }

    this.emit('downloads:updated', this.queue);
    // Quem acompanha a barra da taskbar precisa soltar o progresso preso (não é "fila concluída")
    this.emit('downloads:paused');
    return { ok: true };
  }

  async cancel(id) {
    const item = this.queue.find(i => i.id === id);
    if (!item) return { ok: false, error: 'Item não encontrado.' };

    if (item === this.currentItem && this.currentProcess) {
      item.status = 'cancelled';
      item.error = 'Cancelado pelo usuário';
      this.saveItemToDb(item);
      await this.killProcessTree(this.currentProcess);
      this.currentProcess = null;
    } else {
      item.status = 'cancelled';
      item.error = 'Cancelado pelo usuário';
      this.saveItemToDb(item);
    }
    this._cancelMetadata(item);

    // Cancelado não deixa parciais: a subpasta temporária do item some (depois de o processo soltar os arquivos)
    await this._cleanWorkDir(item);

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
      // 'cancelled' antes de matar: o fechamento do processo não pode finalizar o item removido
      item.status = 'cancelled';
      this.killProcessTree(this.currentProcess);
      this.currentProcess = null;
    }

    this.queue.splice(index, 1);
    this.deleteItemFromDb(id);
    this._cancelMetadata(item);
    this._cleanWorkDir(item).catch(() => {}); // sem parciais: a subpasta temporária some (com novas tentativas se travada)

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
      if (this.currentItem) this.currentItem.status = 'cancelled';
      this.killProcessTree(this.currentProcess);
      this.currentProcess = null;
    }
    for (const item of this.queue) {
      this.deleteItemFromDb(item.id);
      this._cancelMetadata(item);
      this._cleanWorkDir(item).catch(() => {});
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
    const targetFormat = newFormat ? normalizeFormat(newFormat) : (item.format === 'MP4' ? 'MP3' : 'MP4');
    
    // Se mudou de formato, ajusta a qualidade padrão para o novo formato se necessário
    if (item.format !== targetFormat) {
      item.format = targetFormat;
      if (targetFormat === 'MP3') {
        item.quality = '320kbps';
      } else {
        item.quality = 'best';
      }
    }
    
    const oldItem = { id: item.id, folder: item.folder, format: item.format };
    item.folder = item.format === 'MP3' ? settings.mp3Folder : settings.mp4Folder;
    if (this._workDir(oldItem) !== this._workDir(item)) this._cleanWorkDir(oldItem).catch(() => {});
    this.saveItemToDb(item);

    this.emit('downloads:updated', this.queue);
    return { ok: true };
  }

  updateQuality(id, newQuality) {
    const item = this.queue.find(i => i.id === id);
    if (!item) return { ok: false, error: 'Item não encontrado.' };

    item.quality = normalizeQuality(newQuality);
    this.saveItemToDb(item);

    this.emit('downloads:updated', this.queue);
    return { ok: true };
  }

  async processQueue() {
    if (this.isPaused) return;

    // Sem reentrância: só um laço de processamento por vez. Se alguém pedir enquanto há um
    // ativo (ex.: start() logo após pause()), reexecuta quando o laço atual terminar.
    if (this._processing) {
      this._rerunRequested = true;
      return;
    }
    this._processing = true;

    try {
      await this._drainQueue();
    } catch (err) {
      logger.error('[DownloadManager] Erro inesperado no processamento da fila:', err);
    } finally {
      this._processing = false;
      this.currentItem = null;
      if (this._rerunRequested) {
        this._rerunRequested = false;
        if (!this.isPaused && this.isProcessing) setImmediate(() => this.processQueue());
      }
    }
  }

  async _drainQueue() {
    // REGRA 1: 1 download por vez. REGRAS 2 e 3: ao terminar/falhar, segue para o próximo item.
    while (!this.isPaused) {
      const nextItem = this.queue.find(i => i.status === 'queued');

      if (!nextItem) {
        this.isProcessing = false;
        this.currentItem = null;
        this.emit('downloads:queue-completed');
        this.emit('downloads:updated', this.queue);
        return;
      }

      // [CHECK] Arquivo já baixado anteriormente (mesmo vídeo, formato e qualidade)?
      const existingFile = this.findExistingFile(nextItem);
      if (existingFile) {
        logger.info('[DownloadManager] Arquivo já existe, pulando:', { file: path.basename(existingFile) });
        nextItem.status = 'completed';
        nextItem.progress = 100;
        nextItem.outputPath = existingFile;
        nextItem.completedAt = new Date().toISOString();
        nextItem.error = 'Arquivo já existe na pasta de destino.';
        this.saveItemToDb(nextItem);
        this.emit('downloads:updated', this.queue);
        await this._sleep(200);
        continue;
      }

      await this._prepareCookies();
      if (nextItem.infoLoading) this._cancelMetadata(nextItem); // quem vai baixar agora não precisa de busca de informações
      this.currentItem = nextItem;
      nextItem.status = 'downloading';
      nextItem.startedAt = new Date().toISOString();
      nextItem.error = '';
      this.saveItemToDb(nextItem);
      this.emit('downloads:updated', this.queue);

      logger.info('[DownloadManager] Iniciando download do item:', { id: nextItem.id, title: nextItem.title });

      try {
        await this.runProcess(nextItem);
      } catch (err) {
        logger.error('[DownloadManager] Erro na execução do item:', err);
        if (nextItem.status !== 'cancelled' && nextItem.status !== 'paused') {
          this._failItem(nextItem, sanitizeUserMessage(err.message));
          this.emit('downloads:updated', this.queue);
        }
      }

      this.currentItem = null;
      await this._sleep(500);

      // Pausa aleatória antes do próximo da lista (só se o item chegou a baixar e ainda há fila)
      if (!this.isPaused && this.queue.some((i) => i.status === 'queued')) {
        const pause = readPauseSettings(this.getSettings());
        if (pause.enabled && pause.maxSec > 0) {
          const ms = pickPauseMs(pause);
          logger.info('[DownloadManager] Pausa entre downloads', { seconds: Math.round(ms / 1000) });
          await this._waitBetweenItems(ms);
        }
      }
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Espera `ms` entre dois downloads. Termina antes se a fila for pausada, o item da vez for removido/cancelado
   * ou `skipWait()` for chamado. Emite `downloads:wait` ({ until, seconds }) ao começar e ({ until: null }) ao terminar.
   * @returns {Promise<boolean>} true se esperou até o fim
   */
  async _waitBetweenItems(ms) {
    if (!(ms > 0)) return true;
    const until = Date.now() + ms;
    this._waitUntil = until;
    this.emit('downloads:wait', { until, seconds: Math.round(ms / 1000) });
    let woken = false;
    this._wakeWait = () => { woken = true; };
    try {
      while (!woken && !this.isPaused && Date.now() < until) {
        await this._sleep(Math.min(250, Math.max(10, until - Date.now())));
      }
    } finally {
      this._waitUntil = null;
      this._wakeWait = null;
      this.emit('downloads:wait', { until: null, seconds: 0 });
    }
    return !woken && !this.isPaused;
  }

  /** Pula a espera atual e segue para o próximo download (botão do usuário). */
  skipWait() {
    if (this._wakeWait) this._wakeWait();
    return { ok: true };
  }

  getWaitState() {
    return { until: this._waitUntil };
  }

  /**
   * Confere (no máximo a cada 2 min) se há sessão do YouTube válida: renova o arquivo de cookies a partir da aba
   * Envio, quando possível, e guarda o arquivo a usar nesta rodada.
   */
  async _prepareCookies(force = false) {
    const now = Date.now();
    if (!force && this._cookiesFile !== undefined && now - this._cookiesCheckedAt < 120000) return;
    this._cookiesCheckedAt = now;
    let file = null;
    try { if (typeof this.cookiesProvider === 'function') file = await this.cookiesProvider(); } catch (err) {
      logger.warn('[DownloadManager] Falha ao renovar os cookies do YouTube', { error: err.message });
    }
    if (!file) file = this.getSettings().cookiesFile || null;
    const info = inspectCookiesFile(file);
    this._cookiesFile = info.valid ? file : null;
  }

  /** Estado da sessão do YouTube para a tela: { valid, expiresAt }. */
  async getCookiesStatus() {
    await this._prepareCookies(true);
    const info = inspectCookiesFile(this._cookiesFile || this.getSettings().cookiesFile);
    return { valid: info.valid, expiresAt: info.expiresAt, reason: info.reason };
  }

  /** Marca o item como falho (nunca sobrescreve cancelled/paused), persiste e emite o evento. */
  _failItem(item, message) {
    if (item.status === 'cancelled' || item.status === 'paused') return false;
    item.status = 'failed';
    item.error = message;
    this.saveItemToDb(item);
    this.emit('downloads:failed', { item, error: message });
    return true;
  }

  /** Marca o item como concluído (nunca sobrescreve cancelled/paused). */
  _completeItem(item) {
    if (item.status === 'cancelled' || item.status === 'paused') return false;
    this._finalizeOutput(item);
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
    return true;
  }

  /**
   * Garante que o outputPath de um item concluído aponte para um arquivo existente.
   * O yt-dlp pode informar o arquivo intermediário (ex.: .webm antes da extração do MP3) e o spotDL
   * não informa o destino; nesses casos tenta a extensão final e, para o Spotify, o arquivo mais
   * recente da pasta de destino. Devolve '' se nada for encontrado.
   */
  _resolveOutputPath(item) {
    const exists = (p) => {
      try { return fs.statSync(p).size > 0; } catch (_) { return false; }
    };
    const current = item.outputPath || '';
    if (current && exists(current)) return current;

    if (current) {
      const finalExt = item.format === 'MP3' || item.isSpotify ? '.mp3' : '.mp4';
      const alt = path.join(path.dirname(current), path.basename(current, path.extname(current)) + finalExt);
      if (exists(alt)) return alt;
    }

    // O destino que o programa informou pode estar errado/ausente: procura o arquivo final na subpasta temporária
    const finalExt = item.format === 'MP3' || item.isSpotify ? '.mp3' : '.mp4';
    const newestIn = (folder, since) => {
      try {
        let best = null;
        for (const name of fs.readdirSync(folder)) {
          if (path.extname(name).toLowerCase() !== finalExt) continue;
          const full = path.join(folder, name);
          const st = fs.statSync(full);
          if (st.isFile() && st.size > 0 && st.mtimeMs >= since && (!best || st.mtimeMs > best.mtimeMs)) best = { full, mtimeMs: st.mtimeMs };
        }
        return best ? best.full : '';
      } catch (_) { return ''; /* pasta inexistente/ilegível */ }
    };
    const inWork = newestIn(this._workDir(item), 0);
    if (inWork) return inWork;

    // Música (spotDL) de itens antigos: o arquivo mais recente gravado na própria pasta de destino
    if (item.isSpotify) {
      const since = (item.startedAt ? Date.parse(item.startedAt) : 0) - 2000;
      return newestIn(item.folder || '', since);
    }
    return '';
  }

  /** Subpasta temporária do item (dentro da pasta de destino). */
  _workDir(item) {
    const settings = this.getSettings ? this.getSettings() : {};
    const folder = item.folder || (item.format === 'MP3' ? settings.mp3Folder : settings.mp4Folder) || '';
    return path.join(folder, WORKDIR_PREFIX + item.id);
  }

  /**
   * Apaga a subpasta temporária do item (parciais ".part", miniaturas, etc.). No Windows o arquivo pode ficar
   * travado por instantes depois que o processo morre: tenta de novo por ~3 s. Nunca apaga nada fora da subpasta
   * ".bds-dl-<id>" criada pelo app.
   */
  async _cleanWorkDir(item, { tries = 15, delayMs = 200 } = {}) {
    if (!item || !item.id) return true;
    const dir = this._workDir(item);
    if (path.basename(dir) !== WORKDIR_PREFIX + item.id || path.dirname(dir) === '.') return true;
    for (let i = 0; i < tries; i++) {
      try {
        if (!fs.existsSync(dir)) return true;
        fs.rmSync(dir, { recursive: true, force: true });
        if (!fs.existsSync(dir)) return true;
      } catch (_) { /* travado: tenta de novo */ }
      await this._sleep(delayMs);
    }
    logger.warn('[DownloadManager] Subpasta temporária não pôde ser apagada', { id: item.id });
    return false;
  }

  /**
   * Move o arquivo final da subpasta temporária para a pasta de destino com nome ÚNICO: nunca apaga nem
   * substitui um arquivo existente (ou reservado por outro item da fila). "Nome.mp4", depois "Nome - 2.mp4"...
   * Atualiza outputPath/title. Se o arquivo não está na subpasta (ex.: item antigo), só confirma o caminho.
   */
  _finalizeOutput(item) {
    const found = this._resolveOutputPath(item);
    const work = this._workDir(item);
    const inside = found && path.resolve(path.dirname(found)).toLowerCase() === path.resolve(work).toLowerCase();
    if (!found) { item.outputPath = ''; return; }
    if (!inside) { item.outputPath = found; return; }

    const folder = item.folder || path.dirname(work);
    fs.mkdirSync(folder, { recursive: true });
    const name = path.basename(found);
    const avoid = this.queue.filter((o) => o !== item && o.outputPath).map((o) => o.outputPath);
    let dest = '';
    for (let attempt = 0; attempt < 100 && !dest; attempt++) {
      const candidate = uniqueSuffixPath(folder, name, { avoid });
      try {
        moveWithoutOverwrite(found, candidate);
        dest = candidate;
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
        avoid.push(candidate); // alguém criou este nome agora: tenta o próximo número
      }
    }
    if (!dest) throw new Error('Não foi possível escolher um nome de arquivo livre.');
    item.outputPath = dest;
    item.title = path.basename(dest, path.extname(dest));
    this._cleanWorkDir(item).catch(() => {});
  }

  /**
   * Chave estável do vídeo para comparar itens: ID do YouTube quando a URL permite extraí-lo,
   * senão a URL sem query/fragmento. null se a URL for inválida.
   */
  _videoKey(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
      if (host === 'youtu.be') return `yt:${u.pathname.split('/')[1] || ''}`;
      if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
        const v = u.searchParams.get('v');
        if (v) return `yt:${v}`;
        const m = /^\/(?:shorts|live|embed|v)\/([\w-]{6,})/.exec(u.pathname);
        if (m) return `yt:${m[1]}`;
      }
      // Outros sites: o identificador do vídeo pode estar na query string (ex.: ?id=123), então ela
      // entra na chave; o fragmento (#...) nunca identifica o conteúdo.
      // (sem parâmetros de rastreio/compartilhamento, em ordem fixa, e sem a barra final do caminho)
      const params = Array.from(u.searchParams.entries()).filter(([k]) => !TRACKING_PARAM.test(k))
        .map(([k, v]) => `${k}=${v}`).sort();
      const pathname = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
      return `url:${host}${pathname}${params.length ? '?' + params.join('&') : ''}`;
    } catch (_) {
      return null;
    }
  }

  /**
   * Verifica se ESTE vídeo (mesmo ID/URL), no mesmo formato e qualidade, já foi baixado para a
   * pasta de destino e o arquivo ainda existe.
   *
   * Antes bastava existir um arquivo com o mesmo título, o que tratava como "baixado" arquivos
   * parciais, de outro vídeo com o mesmo título ou de outra qualidade. Agora só vale quando há um
   * registro concluído na fila (mesmo id/URL + formato + qualidade) cujo arquivo é o candidato e
   * existe com tamanho > 0. Sem registro, o item vai ao yt-dlp, que por conta própria não
   * sobrescreve um arquivo de mesmo nome (limitação conhecida: o nome do arquivo ainda é só o
   * título, então duas qualidades do mesmo vídeo no mesmo formato compartilham o arquivo).
   *
   * @param {object} item
   * @returns {string|null} caminho completo se encontrado, null caso contrário
   */
  findExistingFile(item) {
    const settings = this.getSettings();
    const folder = item.folder || (item.format === 'MP3' ? settings.mp3Folder : settings.mp4Folder);
    if (!folder || !fs.existsSync(folder)) return null;

    const key = this._videoKey(item.url);
    if (!key) return null;

    const ext = item.format === 'MP3' ? '.mp3' : '.mp4';
    const norm = (p) => path.resolve(p).toLowerCase();

    for (const other of this.queue) {
      if (other === item || other.status !== 'completed' || !other.outputPath) continue;
      if (this._videoKey(other.url) !== key) continue;
      if (other.format !== item.format || (other.quality || 'best') !== (item.quality || 'best')) continue;

      const candidate = path.resolve(other.outputPath);
      if (path.extname(candidate).toLowerCase() !== ext) continue;
      if (norm(path.dirname(candidate)) !== norm(folder)) continue;
      try {
        if (fs.statSync(candidate).size > 0) return candidate;
      } catch (_) { /* arquivo não existe mais */ }
    }

    return null;
  }

  async runProcess(item) {
    const settings = this.getSettings();
    const targetFolder = item.folder || (item.format === 'MP3' ? settings.mp3Folder : settings.mp4Folder);
    const command = await this.buildCommand(item, settings);

    const inactivityMs = Number(settings.downloadInactivityTimeoutMs) > 0
      ? Number(settings.downloadInactivityTimeoutMs)
      : DEFAULT_INACTIVITY_TIMEOUT_MS;

    return new Promise((resolve) => {
      const child = processRunner.spawn(command.exe, command.args, {
        cwd: targetFolder || settings.mp4Folder,
        env: {
          ...process.env,
          PATH: `${this.paths.dataDir}${path.delimiter}${process.env.PATH || ''}`,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1'
        }
      });

      this.currentProcess = child;
      this._lastActivityAt = Date.now();
      let stderr = '';
      let settled = false;
      let stalled = false;
      let watchdog = null;

      // ÚNICO ponto de finalização do item: error, close e watchdog passam por aqui, uma vez só,
      // e nenhum deles sobrescreve um item já cancelado/pausado.
      const settle = (apply) => {
        if (settled) return;
        settled = true;
        if (watchdog) clearInterval(watchdog);
        if (this.currentProcess === child) this.currentProcess = null;

        // Filho morto por pausa: não finaliza o item (fica 'paused' ou já 'queued' se houve start())
        if (child.killedByPause) {
          this.emit('downloads:updated', this.queue);
        } else if (item.status !== 'cancelled' && item.status !== 'paused') {
          apply();
          this.emit('downloads:updated', this.queue);
        }
        resolve();
      };

      // Watchdog de inatividade: sem nenhuma saída por `inactivityMs` => mata a árvore e falha
      watchdog = setInterval(() => {
        if (settled || stalled) return;
        if (!this._isStalled(this._lastActivityAt, Date.now(), inactivityMs)) return;
        stalled = true;
        logger.warn('[DownloadManager] Download sem atividade; encerrando processo.', { id: item.id });
        const minutes = Math.max(1, Math.round(inactivityMs / 60000));
        processRunner.cancel(child).then(() => {
          settle(() => this._failItem(item, `O download ficou sem progresso por ${minutes} min e foi cancelado. Tente novamente.`));
        });
      }, Math.min(30000, Math.max(1000, Math.floor(inactivityMs / 4))));
      if (watchdog.unref) watchdog.unref();

      child.stdout.on('data', (chunk) => this.handleOutput(chunk.toString('utf8'), item));
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stderr = (stderr + text).slice(-8000); // só o final interessa (linhas ERROR)
        this.handleOutput(text, item);
      });

      child.on('error', (error) => {
        settle(() => this._failItem(item, friendlyYtDlpError(`ERROR: ${error.message}`, null)));
      });

      child.on('close', (code) => {
        if (stalled) return; // o watchdog finaliza depois de matar a árvore
        settle(() => {
          if (code === 0) {
            this._completeItem(item);
          } else {
            this._failItem(item, friendlyYtDlpError(stderr, code));
          }
        });
      });
    });
  }

  /** true se passou `limitMs` sem atividade. */
  _isStalled(lastActivityAt, now, limitMs) {
    return limitMs > 0 && lastActivityAt > 0 && (now - lastActivityAt) >= limitMs;
  }

  handleOutput(text, item) {
    this._lastActivityAt = Date.now();
    if (item.status === 'cancelled' || item.status === 'paused') return;

    let forceSave = false;
    let changed = false;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      // "[download] Destination:" (arquivo baixado) e "[ExtractAudio] Destination:" (MP3 final)
      const destination = line.match(/\[(?:download|ExtractAudio)\]\s+Destination:\s+(.+)$/i);
      if (destination) {
        item.outputPath = destination[1];
        item.title = path.basename(destination[1], path.extname(destination[1]));
        forceSave = true;
      }

      const merger = line.match(/\[Merger\]\s+Merging formats into\s+"?([^"]+)"?/i);
      if (merger) {
        item.outputPath = merger[1].replace(/"/g, '');
        item.title = path.basename(item.outputPath, path.extname(item.outputPath));
        forceSave = true;
      }

      const parsed = this.parseProgress(line);
      if (parsed.percent !== null) item.progress = parsed.percent;
      if (parsed.speed) item.speed = parsed.speed;
      if (parsed.eta) item.eta = parsed.eta;
      if (parsed.downloadedBytes) item.downloadedBytes = parsed.downloadedBytes;
      if (parsed.totalBytes) item.totalBytes = parsed.totalBytes;
      changed = true;
    }

    if (!changed) return;

    // O progresso parcial NÃO é gravado no SQLite a cada tick: ao reiniciar, itens em andamento voltam
    // com progresso 0 (initDatabaseQueue) e o yt-dlp retoma o ".part", então só mudanças de estado/destino
    // (outputPath/título) e a finalização (completed/failed/cancelled/paused) são persistidas.
    // A emissão para a UI continua com throttle (~500ms) e leva só o item, nunca a fila inteira.
    const now = Date.now();
    if (forceSave) {
      this._lastSaveAt = now;
      this.saveItemToDb(item);
    }
    if (forceSave || now - this._lastEmitAt >= PROGRESS_THROTTLE_MS) {
      this._lastEmitAt = now;
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
    const finalFolder = item.folder || (item.format === 'MP3' ? settings.mp3Folder : settings.mp4Folder);
    // Tudo é baixado na subpasta temporária do item (retoma o ".part" em retry/pausa); o arquivo final é movido
    // para o destino, com nome único, quando termina. Assim nenhum arquivo existente é tocado durante o download.
    const targetFolder = finalFolder ? this._workDir({ ...item, folder: finalFolder }) : '';
    if (targetFolder && !fs.existsSync(targetFolder)) {
      try {
        fs.mkdirSync(targetFolder, { recursive: true });
      } catch (_) {}
    }

    if (item.isSpotify) {
      const exe = spotDlTool.resolve();
      const outputPattern = targetFolder
        ? path.join(targetFolder, '{title}.{output-ext}')
        : '{title}.{output-ext}';
      return {
        exe,
        args: ['--output', outputPattern, '--format', 'mp3', assertHttpUrl(item.url)]
      };
    }

    const exe = ytDlpTool.resolve();
    const args = [
      '--newline',
      '--progress',
      '--no-playlist', // link de vídeo com "&list=" baixa só o vídeo; playlists são expandidas antes, pela UI
      '--windows-filenames',
      '--continue', // retoma o ".part" de execuções anteriores (padrão do yt-dlp, explícito aqui)
      '--no-mtime',
      '--ffmpeg-location', this.paths.dataDir
    ];

    // Sessão do YouTube válida (aba Envio): baixa já autenticado; o arquivo nunca vai para outros sites
    const cookies = cookiesFileFor(item.url, this._cookiesFile !== undefined ? this._cookiesFile : settings.cookiesFile);
    if (cookies) {
      args.push('--cookies', cookies);
    }

    if (item.format === 'MP3') {
      let audioQuality = '0'; // 0 = VBR Best (~250-320kbps)
      if (item.quality === '320kbps') audioQuality = '0';
      else if (item.quality === '256kbps') audioQuality = '2';
      else if (item.quality === '192kbps') audioQuality = '4';
      else if (item.quality === '128kbps') audioQuality = '6';
      
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', audioQuality, '--embed-metadata', '--embed-thumbnail');
      // '--' encerra as opções: a URL nunca é interpretada como flag do yt-dlp
      args.push('-P', targetFolder || settings.mp3Folder, '-o', '%(title)s.%(ext)s', '--', assertHttpUrl(item.url));
    } else {
      const resolution = item.quality && item.quality !== 'best' ? item.quality.replace('p', '') : 'best';
      const format = resolution && resolution !== 'best'
        ? `bv*[height<=${resolution}][ext=mp4]+ba[ext=m4a]/b[height<=${resolution}][ext=mp4]/best[height<=${resolution}]`
        : 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best';

      args.push('-f', format, '--merge-output-format', 'mp4', '--embed-metadata', '--embed-thumbnail');
      args.push('-P', targetFolder || settings.mp4Folder, '-o', '%(title)s.%(ext)s', '--', assertHttpUrl(item.url));
    }

    return { exe, args };
  }

  /** Encerra o processo e toda a sua árvore; resolve quando terminou. */
  killProcessTree(childOrPid) {
    if (!childOrPid) return Promise.resolve();
    return processRunner.cancel(childOrPid);
  }

  /** Valida o pedido (validador único http/https) e devolve a URL normalizada. */
  validateRequest(request) {
    if (!request || !request.url) throw new Error('Informe uma URL.');
    return assertHttpUrl(request.url);
  }
}

module.exports = DownloadManager;
module.exports.readPauseSettings = readPauseSettings;
module.exports.pickPauseMs = pickPauseMs;
module.exports.siteName = siteName;
module.exports.neutralTitle = neutralTitle;
module.exports.WORKDIR_PREFIX = WORKDIR_PREFIX;
