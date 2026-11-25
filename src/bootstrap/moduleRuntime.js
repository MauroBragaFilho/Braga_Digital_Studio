'use strict';

/**
 * Ciclo de vida dos módulos no processo principal. O que só existe porque um módulo está ligado (monitoramento da
 * Biblioteca, descoberta de dispositivos, lembretes de prazo dos Projetos, LUTs embutidas, yt-dlp dos Downloads)
 * começa quando o módulo liga e para quando desliga — tanto na abertura do app quanto em Configurações → Módulos,
 * sem reiniciar. Os serviços em si são criados sob demanda (core/modules/lazyService.js).
 *
 * Os `require` de código pesado ficam DENTRO das funções: nada disso é carregado enquanto o módulo está desligado.
 * `ctx` = { services, paths, appPaths, settingsManager, getMainWindow, lutManager?, bridge? } (guardado por setContext).
 */

const path = require('node:path');
const logger = require('../services/logService');
const perf = require('../infrastructure/diagnostics/startupPerf');
const registry = require('../core/modules/ModuleRegistry');

function isDevBuild() {
  try {
    const { app } = require('electron');
    return !(app && app.isPackaged);
  } catch (_) { return true; }
}

/** Ações de cada módulo: start() ao ligar (ou na abertura, se já ligado), stop() ao desligar. */
const HOOKS = {
  library: {
    start(ctx) {
      const ws = ctx.services.watcherService;
      if (!ws) { ['watchers', 'reconcile', 'regen'].forEach((n) => perf.done(n)); return; }
      perf.time('bg:watchers.startAll', () => ws.startAll());
      ws.startReconcile();
      perf.done('watchers');

      // Regenera thumbnails ausentes DEPOIS da reconciliação, para o ffmpeg do regen não disputar I/O com ela.
      Promise.resolve(ws.whenReconcileDone())
        .then(() => {
          perf.done('reconcile');
          setTimeout(() => {
            const { regenerateMissingThumbnails } = require('../core/library/ThumbnailRegenService');
            regenerateMissingThumbnails({
              paths: ctx.paths,
              dbManager: require('../core/database/database'),
              window: ctx.getMainWindow(),
              batchSize: 10,
              logPrefix: '[Bootstrap] RegenThumbs'
            }).catch((err) => {
              logger.warn('Bootstrap:regenThumbs:error', { error: err.message });
            }).finally(() => perf.done('regen'));
          }, 500);
        })
        .catch(() => {});
    },
    stop(ctx) { ctx.services.watcherService?.stopAll?.(); },
    skipped() { ['watchers', 'reconcile', 'regen'].forEach((n) => perf.done(n)); }
  },

  devices: {
    // Identidade e tokens de pareamento dos celulares, antes da primeira sondagem
    startAuth(ctx) {
      try {
        require('../core/integrations/bdsm/BdsmAuth').init({ configDir: ctx.appPaths.configDir, safeStorage: require('electron').safeStorage });
      } catch (err) {
        logger.warn('Bootstrap:bdsmAuth:error', { error: err.message });
      }
    },
    // Descoberta de dispositivos (mDNS/Bonjour, ADB, SSDP da Sony)
    startDiscovery() {
      perf.time('bg:deviceDiscovery.start', () => require('../core/devices/DeviceDiscoveryService').start());
      perf.time('bg:sonyCamera.start', () => require('../core/devices/SonyCameraService').start());
      perf.done('discovery');
    },
    start(ctx, opts = {}) { if (!opts.skipAuth) this.startAuth(ctx); this.startDiscovery(ctx); },
    async stop() {
      try { require('../core/devices/DeviceDiscoveryService').stop?.(); } catch (_) { /* já parado */ }
      try { require('../core/integrations/bdsm/BdsmPairing').getPairing().stopAll(); } catch (_) { /* sem pareamentos */ }
      try { require('../core/devices/SonyCameraService').stop?.(); } catch (_) { /* já parado */ }
    },
    skipped() { perf.done('discovery'); }
  },

  projects: {
    // Lembretes de prazo dos projetos
    start(ctx) {
      const deadlineNotifier = require('../infrastructure/desktop/DeadlineNotifier');
      deadlineNotifier.setStateFile(path.join(ctx.appPaths.dataDir, 'deadline-reminders.json'));
      deadlineNotifier.start(ctx.settingsManager.load());
      perf.done('deadline');
    },
    stop() { try { require('../infrastructure/desktop/DeadlineNotifier').stop(); } catch (_) { /* já parado */ } },
    skipped() { perf.done('deadline'); }
  },

  // Coleção de LUTs: usada pela tela de LUTs e pela sincronização de LUTs dos dispositivos (por isso os dois módulos)
  luts: { start(ctx) { sweepLutPartials(ctx); } },
  download: {
    // O yt-dlp só é exigido (e baixado) com o módulo de Downloads ligado
    start(ctx, { startup = false } = {}) { if (!startup) ensureDownloaderTool(ctx); }
  }
};
// Dispositivos também precisam da coleção de LUTs (sincronização de LUTs)
const EXTRA_STARTS = { devices: ['luts'] };

function sweepLutPartials(ctx) {
  if (sweepLutPartials.done || !ctx.lutManager) return;
  sweepLutPartials.done = true;
  // Temporários ".part" de uma cópia interrompida (mais velhos que 1 hora): limpeza em segundo plano, sem bloquear a abertura
  if (typeof ctx.lutManager.sweepPartials === 'function') ctx.lutManager.sweepPartials();
}

function ensureDownloaderTool(ctx) {
  try {
    const { externalTools } = require('../infrastructure/external-tools/ExternalToolsManager');
    if (externalTools.ytdlp.exists()) return;
    const updateService = ctx.services.updateService;
    if (!updateService) return;
    logger.info('Módulo Downloads ligado: baixando o yt-dlp ausente.');
    ctx.bridge?.send?.('dependencies:downloading');
    // Confere o SHA-256 da release oficial; sem ele não instala em silêncio (o usuário confirma em Configurações).
    Promise.resolve(updateService.updateTool('ytdlp', null))
      .then((r) => {
        if (r && r.needsConfirmation) logger.warn('yt-dlp não instalado: a fonte não publica verificação de integridade; aguardando confirmação do usuário.');
      })
      .catch((err) => logger.error('Erro ao baixar o yt-dlp ao ligar Downloads', { error: err.message }))
      .finally(() => ctx.bridge?.send?.('dependencies:done'));
  } catch (err) {
    logger.warn('Bootstrap:ensureDownloaderTool:error', { error: err.message });
  }
}

class ModuleRuntime {
  constructor() {
    this.ctx = null;
    this.started = new Set();
    this.deferred = new Map(); // id -> [fn] a rodar na primeira vez que o módulo ligar
  }

  setContext(ctx) { this.ctx = { ...(this.ctx || {}), ...ctx }; }

  hooks() { return HOOKS; }

  isEnabled(id) {
    try {
      const settings = this.ctx && this.ctx.settingsManager ? this.ctx.settingsManager.load() : {};
      return registry.isEnabled(id, settings, { isDev: isDevBuild() });
    } catch (_) { return false; }
  }

  /** Roda `fn` quando o módulo `id` estiver ligado pela primeira vez (agora, se já está). */
  whenOn(id, fn) {
    if (this.started.has(id)) { fn(); return; }
    if (!this.deferred.has(id)) this.deferred.set(id, []);
    this.deferred.get(id).push(fn);
  }

  /** Inicia o módulo (idempotente). `opts.startup`: chamado na abertura do app. */
  start(id, opts = {}) {
    const hook = HOOKS[id];
    const extra = EXTRA_STARTS[id] || [];
    if (this.started.has(id) || !this.ctx) return false;
    this.started.add(id);
    try { extra.forEach((x) => HOOKS[x]?.start?.(this.ctx, opts)); hook?.start?.(this.ctx, opts); }
    catch (err) { logger.error('Módulo: falha ao iniciar', { module: id, error: err.message }); }
    for (const fn of (this.deferred.get(id) || []).splice(0)) {
      try { fn(); } catch (err) { logger.warn('Módulo: ação adiada falhou', { module: id, error: err.message }); }
    }
    return true;
  }

  /** Para o módulo (idempotente). */
  async stop(id) {
    if (!this.started.has(id)) return false;
    this.started.delete(id);
    try { await HOOKS[id]?.stop?.(this.ctx); }
    catch (err) { logger.warn('Módulo: falha ao parar', { module: id, error: err.message }); }
    return true;
  }

  /** Chamado ao ligar/desligar em Configurações → Módulos. */
  async toggle(id, enabled) {
    if (!registry.isKnownId(id)) return;
    if (enabled) this.start(id);
    else await this.stop(id);
  }

  /** Encerramento do app: para tudo que foi iniciado. */
  async stopAll() {
    for (const id of [...this.started]) await this.stop(id);
  }
}

const moduleRuntime = new ModuleRuntime();

module.exports = { moduleRuntime, ModuleRuntime, HOOKS };
