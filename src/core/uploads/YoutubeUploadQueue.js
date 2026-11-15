'use strict';

const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

/**
 * YoutubeUploadQueue — fila de envio automático para o YouTube Studio.
 *
 * A fila NÃO fala com o YouTube: ela recebe um `driver` (YoutubeStudioDriver) na hora de iniciar e pede a ele
 * para enviar um vídeo de cada vez. Entre dois envios espera um tempo aleatório (Configurações → Envio) e
 * respeita um limite diário, para a conta não parecer um robô. Quando o YouTube pede uma confirmação ao
 * usuário (senha, código, "confirme que é você"), o driver lança um erro com `code: 'EATTENTION'`: a fila para,
 * marca `attention` e espera o usuário resolver na página e clicar em Continuar (= `start()` de novo).
 *
 * Estados de um item: queued | uploading | done | failed | cancelled
 * Eventos: 'updated' (estado completo), 'wait' ({ until, seconds }), 'attention' ({ message }),
 *          'item-done' (item), 'item-failed' (item), 'queue-completed'.
 */

const PAUSE_DEFAULT_MIN_SEC = 60;
const PAUSE_DEFAULT_MAX_SEC = 300;
const PAUSE_MAX_SEC = 3600;
const DAILY_LIMIT_DEFAULT = 10;
const DAILY_LIMIT_MAX = 100;
const VISIBILITIES = ['private', 'unlisted', 'public'];
// Declaração "para crianças": '' = ainda não escolhida (o vídeo não pode ser enviado)
const AUDIENCES = ['not_kids', 'kids'];
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;

/** Lê as preferências de envio (pausa, limite diário, visibilidade padrão) com valores seguros. */
function readUploadSettings(settings) {
  const s = settings || {};
  const clamp = (v, d, max) => {
    if (v === null || v === undefined || v === '') return d;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : d;
  };
  const minSec = clamp(s.uploadPauseMinSec, PAUSE_DEFAULT_MIN_SEC, PAUSE_MAX_SEC);
  const maxSec = Math.max(minSec, clamp(s.uploadPauseMaxSec, PAUSE_DEFAULT_MAX_SEC, PAUSE_MAX_SEC));
  return {
    enabled: s.uploadAutoEnabled === true,
    pauseEnabled: s.uploadPauseEnabled !== false,
    minSec,
    maxSec,
    dailyLimit: clamp(s.uploadDailyLimit, DAILY_LIMIT_DEFAULT, DAILY_LIMIT_MAX),
    visibility: VISIBILITIES.includes(s.uploadDefaultVisibility) ? s.uploadDefaultVisibility : 'private'
  };
}

/** Sorteia a espera (em ms) dentro da faixa. `random` é injetável para teste. */
function pickPauseMs({ minSec, maxSec }, random = Math.random) {
  return Math.round((minSec + random() * (maxSec - minSec)) * 1000);
}

/** Título padrão: nome do arquivo sem extensão, limitado ao máximo do YouTube. */
function defaultTitle(filePath) {
  const base = path.basename(String(filePath || ''), path.extname(String(filePath || '')));
  return (base.replace(/[_]+/g, ' ').trim() || 'Vídeo').slice(0, TITLE_MAX);
}

const PLAYLIST_MAX = 150;
const THUMBNAIL_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

function sanitizeMeta(patch, fallback = {}) {
  const out = {};
  if (patch && typeof patch === 'object') {
    if (typeof patch.title === 'string' && patch.title.trim()) out.title = patch.title.trim().slice(0, TITLE_MAX);
    if (typeof patch.description === 'string') out.description = patch.description.slice(0, DESCRIPTION_MAX);
    if (VISIBILITIES.includes(patch.visibility)) out.visibility = patch.visibility;
    if (patch.audience === '' || AUDIENCES.includes(patch.audience)) out.audience = patch.audience;
    if (typeof patch.playlist === 'string') out.playlist = patch.playlist.trim().slice(0, PLAYLIST_MAX);
    if (typeof patch.thumbnail === 'string') out.thumbnail = patch.thumbnail.trim(); // '' remove a miniatura
  }
  return { ...fallback, ...out };
}

/**
 * Miniatura automática: imagem com o MESMO nome do vídeo, na mesma pasta (video.mp4 → video.jpg/.jpeg/.png/.webp).
 * @returns {string} caminho da imagem ou '' se não houver
 */
function findThumbnail(videoPath, exists = fs.existsSync) {
  if (!videoPath) return '';
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  for (const ext of THUMBNAIL_EXTENSIONS) {
    for (const candidate of [ext, ext.toUpperCase()]) {
      const p = path.join(dir, base + candidate);
      try { if (exists(p)) return p; } catch (_) { /* ignora */ }
    }
  }
  return '';
}

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

class YoutubeUploadQueue extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => object} opts.getSettings  configurações atuais do usuário
   * @param {string} [opts.storeFile]        JSON com os envios concluídos (para o limite diário sobreviver ao reinício)
   * @param {object} [opts.logger]
   * @param {(ms:number) => Promise} [opts.sleep]   injetável para teste
   * @param {() => number} [opts.now]               injetável para teste
   * @param {() => number} [opts.random]            injetável para teste
   */
  constructor({ getSettings, storeFile = '', logger = null, sleep = null, now = null, random = null } = {}) {
    super();
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this.storeFile = storeFile;
    this.logger = logger;
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._now = now || (() => Date.now());
    this._random = random || Math.random;

    this.items = [];
    this.running = false;
    this.paused = false;
    this.attention = null;        // { message } quando o YouTube pediu confirmação ao usuário
    this.currentId = null;
    this._driver = null;
    this._loop = null;
    this._waitUntil = null;
    this._wakeWait = null;
    this._seq = 0;
    // Padrões aplicados a cada vídeo que entra na fila (descrição e playlist iguais para todos). O público ("para
    // crianças") só entra aqui se o usuário o escolheu nesta sessão: nunca é gravado nem vem pré-marcado.
    this.defaults = { description: '', playlist: '', audience: '' };
    this._doneLog = [];
    this._loadStore();
  }

  // ------------------------------------------------------------------ fila

  /**
   * Acrescenta vídeos. `entries` = caminhos (string) ou { path, title?, description?, visibility? }.
   * Caminhos já na fila (e ainda não concluídos) são ignorados.
   */
  add(entries, defaults = {}) {
    const prefs = readUploadSettings(this.getSettings());
    const list = Array.isArray(entries) ? entries : [entries];
    const added = [];
    for (const e of list) {
      const filePath = typeof e === 'string' ? e : e && e.path;
      if (!filePath || typeof filePath !== 'string') continue;
      if (this.items.some((i) => i.path === filePath && !['done', 'failed', 'cancelled'].includes(i.status))) continue;
      const meta = sanitizeMeta(typeof e === 'object' ? e : {}, sanitizeMeta(defaults, {
        title: defaultTitle(filePath),
        description: this.defaults.description,
        visibility: prefs.visibility,
        audience: this.defaults.audience,
        playlist: this.defaults.playlist,
        thumbnail: findThumbnail(filePath)
      }));
      const item = {
        id: `u${++this._seq}_${this._now().toString(36)}`,
        path: filePath,
        name: path.basename(filePath),
        ...meta,
        status: 'queued',
        progress: 0,
        stage: '',
        error: null,
        addedAt: this._now(),
        startedAt: null,
        finishedAt: null
      };
      this.items.push(item);
      added.push(item);
    }
    if (added.length) this._emitUpdated();
    return added.map((i) => ({ ...i }));
  }

  /** Edita título/descrição/visibilidade/público de um item ainda não enviado. */
  update(id, patch) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return { ok: false, error: 'Vídeo não está na fila.' };
    if (item.status !== 'queued' && item.status !== 'failed') return { ok: false, error: 'Este vídeo já está sendo enviado.' };
    Object.assign(item, sanitizeMeta(patch, { title: item.title, description: item.description, visibility: item.visibility }));
    if (item.status === 'failed') { item.status = 'queued'; item.error = null; item.progress = 0; }
    this._emitUpdated();
    return { ok: true };
  }

  /**
   * Padrões da fila (descrição e playlist para todos os vídeos). Com `applyToQueued`, também sobrescreve os vídeos
   * que já estão na fila e ainda não foram enviados.
   */
  setDefaults(patch, { applyToQueued = false } = {}) {
    const p = patch && typeof patch === 'object' ? patch : {};
    if (typeof p.description === 'string') this.defaults.description = p.description.slice(0, DESCRIPTION_MAX);
    if (typeof p.playlist === 'string') this.defaults.playlist = p.playlist.trim().slice(0, PLAYLIST_MAX);
    if (p.audience === '' || AUDIENCES.includes(p.audience)) this.defaults.audience = p.audience;
    if (applyToQueued) {
      for (const item of this.items) {
        if (item.status !== 'queued' && item.status !== 'failed') continue;
        if (typeof p.description === 'string') item.description = this.defaults.description;
        if (typeof p.playlist === 'string') item.playlist = this.defaults.playlist;
        if (AUDIENCES.includes(p.audience)) item.audience = p.audience; // nunca apaga uma escolha já feita no vídeo
      }
    }
    this._saveStore();
    this._emitUpdated();
    return { ok: true, defaults: { ...this.defaults } };
  }

  /** Remove da fila. O item em envio é marcado como cancelado e o driver é avisado. */
  remove(id) {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) return { ok: false };
    const item = this.items[idx];
    if (item.id === this.currentId) {
      item.status = 'cancelled';
      try { this._driver && this._driver.cancel && this._driver.cancel(); } catch (_) { /* driver opcional */ }
      this._emitUpdated();
      return { ok: true, cancelled: true };
    }
    this.items.splice(idx, 1);
    if (this._wakeWait) this._wakeWait(); // sem próximo item a espera perde o sentido
    this._emitUpdated();
    return { ok: true };
  }

  /** Volta um item com falha para a fila. */
  retry(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== 'failed') return { ok: false };
    item.status = 'queued'; item.error = null; item.progress = 0; item.stage = '';
    this._emitUpdated();
    return { ok: true };
  }

  clearCompleted() {
    this.items = this.items.filter((i) => !['done', 'failed', 'cancelled'].includes(i.status));
    this._emitUpdated();
    return { ok: true };
  }

  // ------------------------------------------------------------------ execução

  /**
   * Inicia (ou retoma) a fila com o driver dado. Se já está rodando, só troca o driver quando o atual sumiu.
   * Também é o "Continuar" depois de um pedido de atenção.
   */
  start(driver) {
    if (driver) this._driver = driver;
    if (!this._driver) return { ok: false, error: 'A página do YouTube Studio não está disponível.' };
    const prefs = readUploadSettings(this.getSettings());
    if (!prefs.enabled) return { ok: false, error: 'O envio automático está desligado nas Configurações.' };
    // Nenhum vídeo sai sem a declaração de público feita pelo usuário
    const missing = this.items.filter((i) => i.status === 'queued' && !AUDIENCES.includes(i.audience)).length;
    if (missing) {
      return {
        ok: false,
        needsAudience: true,
        error: missing === 1
          ? 'Escolha se o vídeo é para crianças antes de enviar (em Editar, ou em "Para todos os vídeos").'
          : `Escolha se os ${missing} vídeos são para crianças antes de enviar (em Editar, ou em "Para todos os vídeos").`
      };
    }
    this.paused = false;
    this.attention = null;
    if (this.running) { this._emitUpdated(); return { ok: true, already: true }; }
    this.running = true;
    this._emitUpdated();
    this._loop = this._drain().catch((err) => {
      this._log('error', '[YoutubeUpload] Fila interrompida', { error: err && err.message });
    }).finally(() => {
      this.running = false;
      this.currentId = null;
      this._loop = null;
      this._emitUpdated();
    });
    return { ok: true };
  }

  /** Pausa: o envio em curso termina (ou é cancelado pelo driver) e nenhum outro começa. */
  pause() {
    this.paused = true;
    if (this._wakeWait) this._wakeWait();
    try { this._driver && this._driver.cancel && this._driver.cancel(); } catch (_) { /* driver opcional */ }
    this._emitUpdated();
    return { ok: true };
  }

  skipWait() {
    if (this._wakeWait) this._wakeWait();
    return { ok: true };
  }

  /** Envios concluídos hoje (limite diário). */
  doneToday() {
    const today = dayKey(this._now());
    return this._doneLog.filter((ms) => dayKey(ms) === today).length;
  }

  getState() {
    const prefs = readUploadSettings(this.getSettings());
    return {
      items: this.items.map((i) => ({ ...i })),
      running: this.running,
      paused: this.paused,
      attention: this.attention ? { ...this.attention } : null,
      waitUntil: this._waitUntil,
      doneToday: this.doneToday(),
      dailyLimit: prefs.dailyLimit,
      enabled: prefs.enabled,
      defaults: { ...this.defaults }
    };
  }

  async _drain() {
    while (!this.paused) {
      const next = this.items.find((i) => i.status === 'queued');
      if (!next) { this.emit('queue-completed'); break; }

      const prefs = readUploadSettings(this.getSettings());
      if (prefs.dailyLimit > 0 && this.doneToday() >= prefs.dailyLimit) {
        this.attention = { message: `Limite de ${prefs.dailyLimit} envios por dia atingido. A fila continua amanhã ou quando você aumentar o limite nas Configurações.`, kind: 'limit' };
        this.emit('attention', { ...this.attention });
        break;
      }

      // Vídeo que entrou na fila durante o envio, sem a declaração de público: para e espera a escolha do usuário
      if (!AUDIENCES.includes(next.audience)) {
        this.attention = { message: `Escolha se "${next.title || next.name}" é para crianças e clique em Continuar.`, kind: 'audience' };
        this.emit('attention', { ...this.attention });
        break;
      }

      await this._runItem(next);
      if (this.paused || this.attention) break;

      // Pausa aleatória antes do próximo (só se ainda há fila)
      if (this.items.some((i) => i.status === 'queued') && prefs.pauseEnabled && prefs.maxSec > 0) {
        const ms = pickPauseMs(prefs, this._random);
        this._log('info', '[YoutubeUpload] Pausa entre envios', { seconds: Math.round(ms / 1000) });
        await this._waitBetweenItems(ms);
      }
    }
  }

  async _runItem(item) {
    this.currentId = item.id;
    item.status = 'uploading';
    item.startedAt = this._now();
    item.progress = 0;
    item.stage = 'Preparando';
    item.error = null;
    this._emitUpdated();

    const onProgress = (p) => {
      if (item.status !== 'uploading') return;
      if (typeof p.progress === 'number') item.progress = Math.max(0, Math.min(100, Math.round(p.progress)));
      if (typeof p.stage === 'string') item.stage = p.stage;
      this._emitUpdated();
    };

    try {
      const result = await this._driver.upload({
        path: item.path, title: item.title, description: item.description, visibility: item.visibility, audience: item.audience,
        thumbnail: item.thumbnail || '', playlist: item.playlist || ''
      }, { onProgress });
      if (item.status === 'cancelled') { item.finishedAt = this._now(); this.emit('item-cancelled', { ...item }); return; }
      item.status = 'done';
      item.progress = 100;
      item.stage = 'Enviado';
      item.videoUrl = (result && result.videoUrl) || null;
      // Avisos não fatais do driver (miniatura ou playlist que não deu para aplicar)
      item.warnings = Array.isArray(result && result.warnings) ? result.warnings.slice(0, 5) : [];
      item.finishedAt = this._now();
      this._doneLog.push(item.finishedAt);
      this._saveStore();
      this.emit('item-done', { ...item });
    } catch (err) {
      if (item.status === 'cancelled') { item.finishedAt = this._now(); return; }
      if (err && err.code === 'EATTENTION') {
        // Não é falha do vídeo: volta para a fila e espera o usuário resolver na página
        item.status = 'queued'; item.progress = 0; item.stage = '';
        this.attention = { message: err.message || 'O YouTube pediu uma confirmação. Resolva na página e clique em Continuar.', kind: 'verify' };
        this.emit('attention', { ...this.attention });
        return;
      }
      item.status = 'failed';
      item.error = (err && err.message) || String(err);
      item.finishedAt = this._now();
      this._log('warn', '[YoutubeUpload] Falha no envio', { file: item.name, error: item.error });
      this.emit('item-failed', { ...item });
    } finally {
      this.currentId = null;
      this._emitUpdated();
    }
  }

  /** Espera `ms` entre dois envios; termina antes se pausar, pular ou a fila esvaziar. */
  async _waitBetweenItems(ms) {
    if (!(ms > 0)) return true;
    const until = this._now() + ms;
    this._waitUntil = until;
    this.emit('wait', { until, seconds: Math.round(ms / 1000) });
    this._emitUpdated();
    let woken = false;
    this._wakeWait = () => { woken = true; };
    try {
      while (!woken && !this.paused && this._now() < until) {
        await this._sleep(Math.min(250, Math.max(10, until - this._now())));
      }
    } finally {
      this._waitUntil = null;
      this._wakeWait = null;
      this.emit('wait', { until: null, seconds: 0 });
      this._emitUpdated();
    }
    return !woken && !this.paused;
  }

  // ------------------------------------------------------------------ util

  _emitUpdated() { this.emit('updated', this.getState()); }

  _log(level, msg, meta) {
    try { this.logger && this.logger[level] && this.logger[level](msg, meta); } catch (_) { /* log opcional */ }
  }

  /** Arquivo de estado: envios concluídos (limite diário) e padrões da fila. */
  _loadStore() {
    if (!this.storeFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
      const cutoff = this._now() - 2 * 24 * 3600 * 1000;
      this._doneLog = Array.isArray(data.done) ? data.done.filter((n) => Number.isFinite(n) && n >= cutoff) : [];
      const d = data.defaults && typeof data.defaults === 'object' ? data.defaults : {};
      if (typeof d.description === 'string') this.defaults.description = d.description.slice(0, DESCRIPTION_MAX);
      if (typeof d.playlist === 'string') this.defaults.playlist = d.playlist.slice(0, PLAYLIST_MAX);
    } catch (_) { /* sem arquivo ainda */ }
  }

  _saveStore() {
    if (!this.storeFile) return;
    try {
      const cutoff = this._now() - 2 * 24 * 3600 * 1000;
      this._doneLog = this._doneLog.filter((n) => n >= cutoff);
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
      // O público ("para crianças") nunca é gravado: cada sessão começa sem escolha
      const { description, playlist } = this.defaults;
      fs.writeFileSync(this.storeFile, JSON.stringify({ done: this._doneLog, defaults: { description, playlist } }), 'utf8');
    } catch (err) { this._log('warn', '[YoutubeUpload] Não foi possível gravar o estado da fila', { error: err && err.message }); }
  }
}

module.exports = YoutubeUploadQueue;
module.exports.readUploadSettings = readUploadSettings;
module.exports.pickPauseMs = pickPauseMs;
module.exports.defaultTitle = defaultTitle;
module.exports.findThumbnail = findThumbnail;
module.exports.THUMBNAIL_EXTENSIONS = THUMBNAIL_EXTENSIONS;
module.exports.VISIBILITIES = VISIBILITIES;
module.exports.AUDIENCES = AUDIENCES;
module.exports.PAUSE_MAX_SEC = PAUSE_MAX_SEC;
module.exports.DAILY_LIMIT_MAX = DAILY_LIMIT_MAX;
