'use strict';

// Orquestrador do processo main: monta os serviços, liga os eventos e registra os handlers IPC.
// A lógica vive em módulos coesos:
//   src/bootstrap/services.js     criação dos serviços + preparação da plataforma (banco, telemetria...)
//   src/bootstrap/events/       eventos serviço -> renderer / taskbar / notificações
//   src/bootstrap/rendererBridge  envio ao renderer (guarda de janela + throttle de progresso)
//   src/bootstrap/startup.js      tarefas de segundo plano e checagem de dependências
//   src/bootstrap/shutdown.js     encerramento ordenado
//   src/ipc/index.js              registro dos handlers ipcMain.handle por domínio

const perf = require('./infrastructure/diagnostics/startupPerf');
const SettingsManager = require('./core/settings/SettingsManager');
const LutManager = require('./core/luts/LutManager');
const taskProgressCenter = require('./infrastructure/desktop/TaskProgressCenter');
const notificationCenter = require('./infrastructure/desktop/NotificationCenter');

const RendererBridge = require('./bootstrap/rendererBridge');
const { initPlatform, createServices } = require('./bootstrap/services');
const { syncLibraries } = require('./bootstrap/libraries');
const { bindServiceEvents } = require('./bootstrap/events');
const { startBackgroundServices, checkInitialDependencies } = require('./bootstrap/startup');
const { runShutdown } = require('./bootstrap/shutdown');
const { registerIpcHandlers } = require('./ipc');

class Bootstrap {
  constructor(appPaths) {
    this.appPaths = appPaths;
    this.paths = appPaths.toPlainObject();
    this.settingsManager = new SettingsManager(appPaths.configDir, appPaths.dataDir);
    this.lutManager = new LutManager(appPaths.lutsDir);

    this.services = {};
    this.mainWindow = null;
    this.bridge = new RendererBridge(() => this.mainWindow);
  }

  setMainWindow(window) {
    this.mainWindow = window;
    taskProgressCenter.setMainWindow(window);
    notificationCenter.setMainWindow(window);
    // setNavigateHandler substitui o handler anterior: reativar a janela (activate) não duplica callbacks.
    notificationCenter.setNavigateHandler((screen) => {
      this.bridge.send('bds:navigate-to-screen', screen);
    });
    // Libera a referência quando a janela é destruída (activate cria outra via setMainWindow).
    if (window && typeof window.once === 'function') {
      window.once('closed', () => {
        if (this.mainWindow === window) this.mainWindow = null;
      });
    }
  }

  async init() {
    const settings = this.settingsManager.load();

    const yieldToChromium = () => new Promise((resolve) => setImmediate(resolve));
    await perf.timeAsync('init:platform', () => initPlatform({
      settings,
      appPaths: this.appPaths,
      paths: this.paths,
      settingsManager: this.settingsManager,
      lutManager: this.lutManager
    }));

    await yieldToChromium();
    this.services = await perf.timeAsync('init:createServices', () => createServices({
      appPaths: this.appPaths,
      paths: this.paths,
      settingsManager: this.settingsManager,
      settings
    }));

    // [PERF] A auto-limpeza de cache e a remoção de temporários antigos saíram do init():
    // varrer thumbnails/waveforms de forma síncrona atrasava a abertura da janela. Agora rodam
    // em segundo plano (versões assíncronas) a partir de startBackgroundServices().
    // A regeneração de thumbnails ausentes também roda lá, encadeada APÓS a reconciliação
    // de arquivos (não compete por I/O com os fs.access() da reconciliação).

    // 5. Conectar Eventos e Handlers
    await yieldToChromium();
    perf.time('init:bindEvents', () => this._bindServiceEvents());
    perf.time('init:registerIpc', () => this._registerIpcHandlers());

    return this.services;
  }

  _bindServiceEvents() {
    // Guard contra registro duplicado de listeners (init() nunca deve ser
    // chamado duas vezes, mas esta proteção evita barra/notificação doble).
    if (this._eventsBound) return;
    this._eventsBound = true;

    bindServiceEvents({ bridge: this.bridge, services: this.services });
  }

  _registerIpcHandlers() {
    const { moduleManager } = registerIpcHandlers({
      paths: this.paths,
      appPaths: this.appPaths,
      settingsManager: this.settingsManager,
      lutManager: this.lutManager,
      services: this.services,
      getMainWindow: () => this.mainWindow,
      syncLibraries
    });
    // O ModuleManager é guardado para ser cancelado no encerramento do app.
    this.moduleManager = moduleManager;
  }

  startBackgroundServices() {
    return startBackgroundServices({
      services: this.services,
      paths: this.paths,
      appPaths: this.appPaths,
      settingsManager: this.settingsManager,
      getMainWindow: () => this.mainWindow
    });
  }

  async checkInitialDependencies() {
    return checkInitialDependencies({
      services: this.services,
      settingsManager: this.settingsManager,
      bridge: this.bridge
    });
  }

  /**
   * Encerramento ordenado (idempotente): cancela/pausa serviços em andamento, para watchers e
   * descoberta de dispositivos e, por fim, grava o banco de forma síncrona (ver shutdown.js).
   */
  async shutdown({ timeoutMs = 5000 } = {}) {
    if (this._shutdownPromise) return this._shutdownPromise;

    this._shutdownPromise = runShutdown({
      services: this.services,
      getModuleManager: () => this.moduleManager,
      settingsManager: this.settingsManager
    }, { timeoutMs });

    return this._shutdownPromise;
  }

  /** @deprecated Mantido por compatibilidade; use shutdown(). */
  async cleanup() {
    return this.shutdown();
  }
}

module.exports = Bootstrap;
