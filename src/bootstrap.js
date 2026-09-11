'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ipcMain, dialog, BrowserWindow, app } = require('electron');

const logger = require('./services/logService');
const { DEVELOPER_EMAIL } = require('./config/appInfo');
const SettingsManager = require('./core/settings/SettingsManager');
const LutManager = require('./core/luts/LutManager');
const { errorReporter } = require('./infrastructure/telemetry/ErrorReporter');

const { ffmpegTool } = require('./infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('./infrastructure/external-tools/adapters/FfprobeTool');
const { externalTools } = require('./infrastructure/external-tools/ExternalToolsManager');
const { appUpdateChecker } = require('./infrastructure/external-tools/AppUpdateChecker');

const taskProgressCenter = require('./infrastructure/desktop/TaskProgressCenter');
const notificationCenter = require('./infrastructure/desktop/NotificationCenter');
const deadlineNotifier = require('./infrastructure/desktop/DeadlineNotifier');
const telegramDeliveryChannel = require('./infrastructure/desktop/TelegramDeliveryChannel');

const DownloadService = require('./services/downloadService');
const HistoryService = require('./services/historyService');
const ThumbnailService = require('./services/thumbnailService');
const ConverterService = require('./services/converterService');
const UpdateService = require('./services/updateService');
const MontageService = require('./services/montageService');
const SilenceService = require('./services/silenceService');
const MetadataService = require('./services/metadataService');
const VideoRecoveryService = require('./services/videoRecoveryService');
const RawRecoveryService = require('./services/rawRecoveryService');
const sonyCameraService = require('./core/devices/SonyCameraService');

const MtpService = require('./core/MtpService');
const UsbService = require('./core/UsbService');
const UploadService = require('./core/UploadService');
const UploadScannerService = require('./core/uploads/UploadScannerService');
const CookiesService = require('./core/CookiesService');

const projectService = require('./core/projects/ProjectService');
const SequenceBuilder = require('./core/projects/SequenceBuilder');
const PremiereExporter = require('./core/projects/PremiereExporter');
const BdsproPackageService = require('./core/projects/BdsproPackageService');
const WaveformService = require('./core/projects/WaveformService');
const AudioSyncService = require('./core/projects/AudioSyncService');

const deviceDiscoveryService = require('./core/devices/DeviceDiscoveryService');
const LutSyncService = require('./core/devices/LutSyncService');

const dbManager = require('./core/database/database');
const { runMigrations } = require('./core/database/migrations');
const LibraryManager = require('./core/library/LibraryManager');
const ImportQueue = require('./core/library/ImportQueue');
const LibraryWatcherService = require('./core/library/LibraryWatcherService');
const EventBus = require('./core/EventBus');

class Bootstrap {
  constructor(appPaths) {
    this.appPaths = appPaths;
    this.paths = appPaths.toPlainObject();
    this.settingsManager = new SettingsManager(appPaths.configDir, appPaths.dataDir);
    this.lutManager = new LutManager(appPaths.lutsDir);

    this.services = {};
    this.mainWindow = null;
  }

  setMainWindow(window) {
    this.mainWindow = window;
    taskProgressCenter.setMainWindow(window);
    notificationCenter.setMainWindow(window);
    notificationCenter.setNavigateHandler((screen) => {
      this.mainWindow?.webContents.send('bds:navigate-to-screen', screen);
    });
  }

  async init() {
    const paths = this.paths;
    const settings = this.settingsManager.load();

    // Aplica as preferências de aceleração de hardware (GPU) ao serviço de detecção.
    const hardwareDetection = require('./core/HardwareDetectionService');
    hardwareDetection.configure(settings);

    // Notificações nativas — refletir preferências do usuário já carregadas.
    notificationCenter.updateSettings(settings);

    // Canal Telegram (opcional): fica inativo até token/chat_id serem configurados.
    notificationCenter.registerDeliveryChannel({
      name: telegramDeliveryChannel.name,
      deliver: (note) => telegramDeliveryChannel.deliver(note)
    });
    telegramDeliveryChannel.updateSettings(settings);

    // Inicializar Sistema de Envio de Erros / Telemetria
    errorReporter.init({
      logsDir: this.appPaths.logsDir,
      developerEmail: settings.developerEmail || DEVELOPER_EMAIL,
      endpointUrl: settings.errorReportingEndpoint || '',
      getSettings: () => this.settingsManager.load()
    });

    // Copiar LUTs embutidas
    const bundledLutsDir = path.join(__dirname, '..', 'data', 'LUTs');
    this.lutManager.ensureBundledLuts(bundledLutsDir);

    // 1. Inicializar Banco de Dados
    await dbManager.init(paths.databaseDir);
    runMigrations();

    // 2. Inicializar Serviços Core e Infraestrutura
    const historyService = await HistoryService.create(paths.databaseDir);
    const downloadService = new DownloadService({ paths, getSettings: () => this.settingsManager.load(), historyService });
    const converterService = new ConverterService({ paths, getSettings: () => this.settingsManager.load(), historyService });
    const thumbnailService = new ThumbnailService({ paths, getSettings: () => this.settingsManager.load() });
    const updateService = new UpdateService({ paths, getSettings: () => this.settingsManager.load() });
    const montageService = new MontageService({ paths, getSettings: () => this.settingsManager.load() });
    const silenceService = new SilenceService({ paths, getSettings: () => this.settingsManager.load() });
    const metadataServiceInstance = new MetadataService({ paths });
    const videoRecoveryService = new VideoRecoveryService({ paths });
    const rawRecoveryService = new RawRecoveryService({ paths });

    const sequenceBuilder = new SequenceBuilder(projectService);
    const premiereExporter = new PremiereExporter(projectService, sequenceBuilder);
    const bdsproPackageService = new BdsproPackageService(projectService);

    const waveformService = new WaveformService({
      ffmpegPath: ffmpegTool.resolve({ mustExist: false }),
      cacheDir: this.appPaths.waveformsDir
    });
    const audioSyncService = new AudioSyncService({
      ffmpegPath: ffmpegTool.resolve({ mustExist: false })
    });

    const lutSyncService = new LutSyncService(paths.lutsDir);
    const uploadScannerService = new UploadScannerService({
      paths,
      ffprobePath: ffprobeTool.resolve({ mustExist: false }),
      ffmpegPath: ffmpegTool.resolve({ mustExist: false })
    });

    // 3. Inicializar Media Library e Watcher
    const libManager = new LibraryManager();
    const importQueue = new ImportQueue({
      ffprobePath: ffprobeTool.resolve({ mustExist: false }),
      ffmpegPath: ffmpegTool.resolve({ mustExist: false }),
      thumbnailsDir: this.appPaths.thumbnailsDir
    });
    const watcherService = new LibraryWatcherService(importQueue);

    // Sincronizar bibliotecas das configurações
    this._syncLibraries(libManager, settings);

    this.services = {
      historyService,
      downloadService,
      converterService,
      thumbnailService,
      updateService,
      montageService,
      silenceService,
      metadataService: metadataServiceInstance,
      videoRecoveryService,
      rawRecoveryService,
      projectService,
      sequenceBuilder,
      premiereExporter,
      bdsproPackageService,
      waveformService,
      audioSyncService,
      lutSyncService,
      uploadScannerService,
      libManager,
      importQueue,
      watcherService
    };

    // Auto-limpeza de cache no startup (se habilitado nas configurações)
    try {
      const CacheService = require('./core/CacheService');
      const cacheSvc = new CacheService(this.appPaths, {
        maxSizeMB: settings.cacheMaxSizeMB || 500,
        autoClean: !!settings.cacheAutoClean,
      });
      const result = cacheSvc.autoCleanIfNeeded();
      if (result.trimmed) {
        logger.info(`[Bootstrap] Auto-limpeza de cache no startup: liberado ${result.totalFormatted}`);
      }
      // [PERF] Remove apenas arquivos temporários de execuções anteriores (>1h)
      // [FIX] Agora limitado à pasta temp — NÃO toca em thumbnails/waveforms
      cacheSvc.cleanStaleTempFiles(60 * 60 * 1000);
    } catch (err) {
      logger.warn('Bootstrap:autoCleanCache:error', { error: err.message });
    }

    // [FIX] Regenera thumbnails ausentes em background (não bloqueia startup).
    // Lógica compartilhada com o handler IPC e com o clearCache (systemHandlers),
    // para que a biblioteca nunca fique preta por minutos.
    // [PERF] O acionamento agora acontece em startBackgroundServices(), encadeado
    // APÓS a reconciliação de arquivos (watcherService.whenReconcileDone()), para
    // não competir por I/O com os fs.access() da reconciliação.
    // setTimeout(...) removido daqui — ver startBackgroundServices().

    // 5. Conectar Eventos e Handlers
    this._bindServiceEvents();
    this._registerIpcHandlers();

    return this.services;
  }

  _syncLibraries(libManager, settings) {
    try {
      const db = dbManager.get();
      db.prepare("DELETE FROM libraries WHERE type IN ('LOCAL_FOLDER', 'LOCAL') OR name LIKE '%LOCAL%'").run();

      const libs = libManager.list();
      const syncLib = (name, type, folderPath) => {
        if (!folderPath) return;
        const existing = libs.find(l => l.type === type);
        if (existing) {
          if (existing.path !== folderPath) {
            db.prepare('UPDATE libraries SET path = ? WHERE id = ?').run(folderPath, existing.id);
          }
        } else {
          libManager.add({ name, type, path: folderPath });
        }
      };

      if (settings.obsFolder) syncLib('OBS Studio', 'OBS', settings.obsFolder);
      if (settings.shadowplayFolder) syncLib('NVIDIA ShadowPlay', 'SHADOWPLAY', settings.shadowplayFolder);
      if (settings.deviceFolder) syncLib('BDSM Devices', 'BDSM_DEVICE', settings.deviceFolder);
    } catch (err) {
      logger.error('Bootstrap:_syncLibraries:error', { error: err.message });
    }
  }

  _bindServiceEvents() {
    // Guard contra registro duplicado de listeners (init() nunca deve ser
    // chamado duas vezes, mas esta proteção evita barra/notificação doble).
    if (this._eventsBound) return;
    this._eventsBound = true;

    const { downloadService, converterService, montageService, silenceService, metadataService, importQueue } = this.services;

    // Discovery Events
    deviceDiscoveryService.on('device_added', (d) => this.mainWindow?.webContents.send('bdsm:device_added', d));
    deviceDiscoveryService.on('device_removed', (id) => this.mainWindow?.webContents.send('bdsm:device_removed', id));
    deviceDiscoveryService.on('device_updated', (d) => this.mainWindow?.webContents.send('bdsm:device_updated', d));

    // [FASE 2.2] Sony Camera Events — unificados para canais do preload
    sonyCameraService.on('camera_connected', (cam) => this.mainWindow?.webContents.send('sony-camera:connected', cam));
    sonyCameraService.on('camera_status_updated', (status) => this.mainWindow?.webContents.send('sony-camera:status-update', status));

    // Media Library Events
    EventBus.on('MEDIA_IMPORTED', (m) => this.mainWindow?.webContents.send('bds:media-imported', m));
    EventBus.on('MEDIA_REMOVED', (p) => this.mainWindow?.webContents.send('bds:media-removed', p));
    EventBus.on('MEDIA_UPDATED', (p) => this.mainWindow?.webContents.send('bds:media-updated', p));

    // Download Events
    downloadService.on('downloads:added', (item) => this.mainWindow?.webContents.send('downloads:added', item));
    downloadService.on('downloads:updated', (queue) => this.mainWindow?.webContents.send('downloads:updated', queue));
    downloadService.on('downloads:progress', (data) => {
      taskProgressCenter.reportProgress('downloads', (data.progress || 0) / 100);
      this.mainWindow?.webContents.send('downloads:progress', data);
    });
    downloadService.on('downloads:completed', (item) => {
      this.mainWindow?.webContents.send('downloads:completed', item);
      if (item.outputPath && importQueue) {
        try {
          const db = dbManager.get();
          let lib = db.prepare("SELECT * FROM libraries WHERE type = 'DOWNLOADER'").get();
          if (!lib) {
            const info = db.prepare("INSERT INTO libraries (name, type, path, enabled, auto_scan) VALUES (?, ?, ?, 1, 0)").run('Downloads', 'DOWNLOADER', '');
            lib = { id: info.lastInsertRowid, type: 'DOWNLOADER' };
          }
          importQueue.add({ libraryId: lib.id, path: item.outputPath });
        } catch (err) {
          logger.error('Erro ao adicionar download à biblioteca:', { error: err.message });
        }
      }
    });
    downloadService.on('downloads:failed', (data) => {
      taskProgressCenter.reportError('downloads');
      this.mainWindow?.webContents.send('downloads:failed', data);
    });
    downloadService.on('downloads:removed', (id) => this.mainWindow?.webContents.send('downloads:removed', id));
    downloadService.on('downloads:queue-completed', () => {
      taskProgressCenter.reportIdle('downloads');
      notificationCenter.notifyTaskCompleted('downloads', {});
      this.mainWindow?.webContents.send('downloads:queue-completed');
    });
    downloadService.on('queue', (payload) => this.mainWindow?.webContents.send('download:queue', payload));
    downloadService.on('progress', (payload) => this.mainWindow?.webContents.send('download:progress', payload));
    downloadService.on('finished', (payload) => this.mainWindow?.webContents.send('download:finished', payload));
    downloadService.on('youtube:code', (data) => this.mainWindow?.webContents.send('youtube:code', data));
    downloadService.on('youtube:auth-status', (status) => this.mainWindow?.webContents.send('youtube:auth-status', status));

    // Converter Events
    converterService.on('queue', (p) => this.mainWindow?.webContents.send('converter:queue', p));
    converterService.on('fileStarted', (p) => this.mainWindow?.webContents.send('converter:fileStarted', p));
    converterService.on('progress', (p) => {
      taskProgressCenter.reportProgress('converter', (p?.progress || 0) / 100);
      this.mainWindow?.webContents.send('converter:progress', p);
    });
    converterService.on('fileFinished', (p) => this.mainWindow?.webContents.send('converter:fileFinished', p));
    // Progresso geral do lote (ponderado por duração) emitido pelo serviço a cada ~500ms
    converterService.on('overallProgress', (p) => {
      taskProgressCenter.reportProgress('converter', (p?.percent || 0) / 100);
      this.mainWindow?.webContents.send('converter:overallProgress', p);
    });
    converterService.on('finished', (p) => {
      taskProgressCenter.reportIdle('converter');
      if (p?.status === 'error') {
        taskProgressCenter.reportError('converter');
      } else if (p?.status === 'cancelled') {
        // Cancelamento: apenas libera o centro de tarefas, sem notificar sucesso.
        logger.warn('converter:finished:cancelled');
      } else {
        // O payload 'finished' não traz contagem — calculamos pelos itens
        // efetivamente concluídos na fila do serviço.
        const count = converterService.getQueue().filter((it) => it.status === 'Concluído').length;
        notificationCenter.notifyTaskCompleted('converter', { count });
      }
      this.mainWindow?.webContents.send('converter:finished', p);
    });

    // Montage Events
    montageService.on('progress', (p) => this.mainWindow?.webContents.send('montage:progress', p));
    montageService.on('finished', (p) => this.mainWindow?.webContents.send('montage:finished', p));
    montageService.on('queue-updated', (q) => this.mainWindow?.webContents.send('montage:queue-updated', q));
    montageService.on('log', (t) => this.mainWindow?.webContents.send('montage:log', t));

    // Silence Events
    silenceService.on('progress', (p) => {
      taskProgressCenter.reportProgress('silence', (p?.percent || 0) / 100);
      this.mainWindow?.webContents.send('silence:progress', p);
    });
    silenceService.on('finished', (p) => {
      taskProgressCenter.reportIdle('silence');
      if (p?.status === 'error') {
        taskProgressCenter.reportError('silence');
      } else if (p?.status !== 'canceled') {
        // payload.file fica undefined até o silenceService emitir o nome do
        // último arquivo — o NotificationCenter cai no texto genérico.
        notificationCenter.notifyTaskCompleted('silence', { file: p?.lastFile });
      }
      this.mainWindow?.webContents.send('silence:finished', p);
    });
    silenceService.on('log', (p) => this.mainWindow?.webContents.send('silence:log', p));

    // Metadata Events
    metadataService.on('progress', (p) => this.mainWindow?.webContents.send('metadata:progress', p));
    metadataService.on('log', (p) => this.mainWindow?.webContents.send('metadata:log', p));

    // Recovery Events
    const { videoRecoveryService, rawRecoveryService, updateService } = this.services;
    videoRecoveryService.on('progress', (p) => this.mainWindow?.webContents.send('recovery:progress', p));
    videoRecoveryService.on('stage', (p) => this.mainWindow?.webContents.send('recovery:stage', p));
    videoRecoveryService.on('finished', (p) => this.mainWindow?.webContents.send('recovery:finished', p));
    videoRecoveryService.on('error', (p) => this.mainWindow?.webContents.send('recovery:error', p));

    rawRecoveryService.on('progress', (p) => this.mainWindow?.webContents.send('recovery:raw:progress', p));
    rawRecoveryService.on('stage', (p) => this.mainWindow?.webContents.send('recovery:raw:stage', p));
    rawRecoveryService.on('finished', (p) => this.mainWindow?.webContents.send('recovery:raw:finished', p));
    rawRecoveryService.on('error', (p) => this.mainWindow?.webContents.send('recovery:raw:error', p));

    // Update Events
    updateService.on('progress', (p) => this.mainWindow?.webContents.send('updates:progress', p));
    updateService.on('completed', (p) => this.mainWindow?.webContents.send('updates:completed', p));

    // Hardware Provider Events
    UsbService.on('progress', (data) => this.mainWindow?.webContents.send('mtp:import-progress', data));
    MtpService.on('progress', (data) => this.mainWindow?.webContents.send('mtp:import-progress', data));

    // Upload & Sony Events
    // Cópia de arquivos (upload p/ YouTube) — Opção A: refletir o progresso
    // simulado do UploadService na taskbar como tarefa 'copy'.
    let copyCompleted = false;
    UploadService.on('queue-updated', (q) => {
      const hasPending = q.some((job) => job.status === 'queued' || job.status === 'uploading' || job.status === 'Enviando...');
      if (hasPending) copyCompleted = false;

      const active = q.find((job) => job.status === 'uploading' || job.status === 'Enviando...');
      if (active) {
        taskProgressCenter.reportProgress('copy', (active.progress || 0) / 100);
      } else {
        taskProgressCenter.reportIdle('copy');
      }

      const allDone = q.length > 0 && q.every((job) => job.status === 'Concluído' || job.status === 'error');
      if (allDone && !copyCompleted) {
        copyCompleted = true;
        const count = q.filter((job) => job.status === 'Concluído').length;
        notificationCenter.notifyTaskCompleted('copy', { count });
      }

      this.mainWindow?.webContents.send('upload:queue-updated', q);
    });
    // [FASE 2.2] Sony — eventos 'connected'/'photo-taken' já capturados no bloco acima via camera_connected
    // Não registrar listeners duplicados para o mesmo serviço
  }

  _registerIpcHandlers() {
    const {
      downloadService, converterService, historyService, thumbnailService,
      updateService, montageService, silenceService, metadataService,
      videoRecoveryService, rawRecoveryService, projectService, premiereExporter, bdsproPackageService,
      waveformService, audioSyncService, sequenceBuilder,
      uploadScannerService, libManager, watcherService, lutSyncService
    } = this.services;

    // Registra Handlers por Módulo
    require('./ipc/deviceHandlers')(logger, lutSyncService);
    require('./ipc/libraryHandlers')(this.paths, watcherService);
    require('./ipc/systemHandlers')(this.paths);
    require('./ipc/recoveryHandlers')(videoRecoveryService, this.paths, rawRecoveryService);
    require('./ipc/youtubeHandlers')();
    require('./ipc/projectHandlers')(projectService, premiereExporter, bdsproPackageService, this.paths, waveformService, audioSyncService, sequenceBuilder);
    require('./ipc/lutHandlers')(this.lutManager);
    require('./ipc/telemetryHandlers')();
    require('./ipc/jobHandlers')();

    // Settings
    ipcMain.handle('settings:get', () => this.settingsManager.load());
    ipcMain.handle('settings:save', (_, settings) => {
      const saved = this.settingsManager.save(settings);
      notificationCenter.updateSettings(saved);
      // Sincroniza o canal Telegram com as preferências (token, chat id, flag)
      telegramDeliveryChannel.updateSettings(saved);
      // Reavalia prazos imediatamente após salvar preferências de notificação
      if (typeof deadlineNotifier.checkDeadlines === 'function') {
        deadlineNotifier.checkDeadlines(saved);
      }
      if (libManager && watcherService) {
        this._syncLibraries(libManager, saved);
        watcherService.stopAll();
        setTimeout(() => watcherService.startAll(), 1000);
      }
      updateService?.applyUpdateServerSettings();
      // Reaplica as preferências de aceleração de hardware e limpa o cache de encoders.
      try {
        const hardwareDetection = require('./core/HardwareDetectionService');
        hardwareDetection.configure(saved);
        hardwareDetection.invalidateCache();
      } catch (_) {}
      return saved;
    });

    // Informações de hardware (GPU + encoders) para a aba Sistema das Configurações.
    ipcMain.handle('system:getHardwareInfo', async () => {
      const hardwareDetection = require('./core/HardwareDetectionService');
      hardwareDetection.configure(this.settingsManager.load());
      const ffmpegPath = ffmpegTool.resolve({ mustExist: false });
      return await hardwareDetection.getSystemHardwareInfo(ffmpegPath || null);
    });

    // Lista de encoders disponíveis no FFmpeg (para validação na tela Conversor).
    ipcMain.handle('system:checkEncoders', async () => {
      const hardwareDetection = require('./core/HardwareDetectionService');
      hardwareDetection.configure(this.settingsManager.load());
      const ffmpegPath = ffmpegTool.resolve({ mustExist: false });
      if (!ffmpegPath) return [];
      const set = await hardwareDetection.listEncoders(ffmpegPath);
      return [...set].sort();
    });


    // Teste do canal Telegram (botão "Testar envio no Telegram" na tela de Configurações)
    ipcMain.handle('telegram:sendTest', async (_, data) => {
      const token = String(data?.botToken || '').trim();
      const chatId = String(data?.chatId || '').trim();
      if (!token || !chatId) {
        return { success: false, error: 'Token do bot e Chat ID são obrigatórios.' };
      }
      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '✅ Notificações do Braga Digital Studio funcionando!'
          })
        });
        if (!response.ok) {
          const errBody = await response.text();
          return { success: false, error: `Telegram respondeu HTTP ${response.status}: ${errBody.slice(0, 200)}` };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message || 'Falha de rede ao contatar o Telegram.' };
      }
    });

    ipcMain.handle('app:getVersion', () => app.getVersion());
    ipcMain.handle('app:checkForUpdate', () => appUpdateChecker.checkForUpdate(app.getVersion()));
    // Pasta de destino padrão do Conversor: usa a pasta persistida pelo usuário
    // (settings.converterFolder) ou, na ausência dela, "Vídeos do usuário/Convertido".
    ipcMain.handle('system:getConverterOutputDir', () => {
      const settings = this.settingsManager.load();
      let dir = settings.converterFolder;
      if (!dir) dir = path.join(this.appPaths.videosDir, 'Convertido');
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
      return dir;
    });



    // Window Controls
    ipcMain.handle('window:minimize', () => this.mainWindow?.minimize());
    ipcMain.handle('window:maximize', () => {
      if (!this.mainWindow) return;
      if (this.mainWindow.isMaximized()) this.mainWindow.unmaximize();
      else this.mainWindow.maximize();
    });
    ipcMain.handle('window:fullscreen', () => {
      if (this.mainWindow) this.mainWindow.setFullScreen(!this.mainWindow.isFullScreen());
    });
    ipcMain.handle('window:close', () => this.mainWindow?.close());

    // Dialogs
    ipcMain.handle('dialog:selectFolder', async (_, fallbackPath) => {
      const win = this.mainWindow || BrowserWindow.getFocusedWindow();
      const options = { defaultPath: fallbackPath || os.homedir(), properties: ['openDirectory', 'createDirectory'] };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('dialog:selectFiles', async (_, customOptions) => {
      const defaultOptions = { properties: ['openFile', 'multiSelections'] };
      const options = customOptions ? { ...defaultOptions, ...customOptions } : defaultOptions;
      const win = this.mainWindow || BrowserWindow.getFocusedWindow();
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return result.canceled ? [] : result.filePaths;
    });

    // YouTube & Downloads
    ipcMain.handle('startYoutubeAuth', () => downloadService.startYoutubeAuth());
    ipcMain.handle('media:metadata', (_, url) => thumbnailService.getMetadata(url));
    ipcMain.handle('media:inspectPlaylist', (_, url) => thumbnailService.inspectPlaylist(url));
    ipcMain.handle('media:expandPlaylist', (_, url) => thumbnailService.expandPlaylist(url));
    ipcMain.handle('download:start', (_, request) => downloadService.startDownload(request));
    ipcMain.handle('youtube:get-accounts', () => []);
    ipcMain.handle('youtube:exportCookies', async () => {
      try {
        const cookiesPath = path.join(this.paths.dataDir, 'youtube_cookies.txt');
        const success = await CookiesService.exportNetscapeCookies('youtube.com', cookiesPath, 'persist:youtube_studio');
        if (success) {
          this.settingsManager.save({ cookiesFile: cookiesPath });
          return { success: true, path: cookiesPath };
        }
        return { success: false };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // Download Queue
    ipcMain.handle('downloads:add', (_, request) => downloadService.add(request));
    ipcMain.handle('downloads:start', () => downloadService.start());
    ipcMain.handle('downloads:pause', () => downloadService.pause());
    ipcMain.handle('downloads:cancel', (_, id) => downloadService.cancel(id));
    ipcMain.handle('downloads:retry', (_, id) => downloadService.retry(id));
    ipcMain.handle('downloads:remove', (_, id) => downloadService.remove(id));
    ipcMain.handle('downloads:reorder', (_, id, dir) => downloadService.reorder(id, dir));
    ipcMain.handle('downloads:clearCompleted', () => downloadService.clearCompleted());
    ipcMain.handle('downloads:clearAll', () => downloadService.clearAll());
    ipcMain.handle('downloads:toggleFormat', (_, id, fmt) => downloadService.toggleFormat(id, fmt));
    ipcMain.handle('downloads:updateQuality', (_, id, q) => downloadService.updateQuality(id, q));
    ipcMain.handle('downloads:getQueue', () => downloadService.getQueue());
    ipcMain.handle('download:cancel', () => downloadService.pause());
    ipcMain.handle('download:getQueue', () => downloadService.getQueue());
    ipcMain.handle('download:clearQueue', () => downloadService.clearCompleted());
    ipcMain.handle('download:removeJob', (_, id) => downloadService.remove(id));

    // Converter
    ipcMain.handle('converter:addFiles', (_, files) => converterService.addFiles(files));
    ipcMain.handle('converter:start', (_, config) => converterService.start(config));
    ipcMain.handle('converter:cancel', () => converterService.cancelCurrent());
    ipcMain.handle('converter:clearQueue', () => converterService.clearQueue());
    ipcMain.handle('converter:removeFile', (_, index) => converterService.removeFile(index));
    ipcMain.handle('converter:listQueue', () => converterService.getQueue());

    // Montage
    ipcMain.handle('montage:probe', (_, filePath) => montageService.probeFile(filePath));
    ipcMain.handle('montage:enqueue', (_, config) => montageService.enqueueMontage(config));
    ipcMain.handle('montage:cancelJob', (_, id) => montageService.cancelJob(id));
    ipcMain.handle('montage:removeJob', (_, id) => montageService.removeJob(id));
    ipcMain.handle('montage:clearQueue', () => montageService.clearQueue());
    ipcMain.handle('montage:getQueue', () => montageService.getQueue());

    // Silence
    ipcMain.handle('silence:probe', (_, filePath) => silenceService.probeFile(filePath));
    ipcMain.handle('silence:analyze', (_, config) => silenceService.analyzeSilence(config.filePath, config.threshold, config.minDuration));
    ipcMain.handle('silence:process', (_, config) => silenceService.processQueue(config));
    ipcMain.handle('silence:cancel', () => silenceService.cancel());

    // Metadata
    ipcMain.handle('metadata:probe', (_, filePath) => metadataService.probeFile(filePath));
    ipcMain.handle('metadata:extractThumb', (_, filePath) => metadataService.extractThumbnail(filePath));
    ipcMain.handle('metadata:save', (_, config) => metadataService.saveMetadata(config));
    ipcMain.handle('metadata:cancel', () => metadataService.cancel());

    // History
    ipcMain.handle('history:list', () => historyService.listDownloads());
    ipcMain.handle('history:clear', () => historyService.clearDownloads());
    ipcMain.handle('conversions:list', () => historyService.listConversions());
    ipcMain.handle('conversions:clear', () => historyService.clearConversions());

    // Updates
    ipcMain.handle('updates:checkSystem', () => updateService.checkSystem());
    ipcMain.handle('updates:check', () => updateService.checkSystem());
    ipcMain.handle('updates:checkLegacy', () => updateService.checkAll());
    ipcMain.handle('updates:updateTool', (_, tool) => updateService.updateTool(tool));
    ipcMain.handle('updates:rollbackTool', (_, tool) => updateService.rollbackTool(tool));
    ipcMain.handle('updates:updateAll', async () => {
      return await updateService.updateAll();
    });
    // Fluxo unificado (app + dependências)
    ipcMain.handle('updates:checkAll', () => updateService.checkEverything());
    ipcMain.handle('updates:updateEverything', async () => {
      return await updateService.updateEverything();
    });
    ipcMain.handle('updates:downloadAppUpdate', async () => {
      return await updateService.downloadAppUpdate();
    });
    ipcMain.handle('updates:installAppUpdate', (_, installerPath) => updateService.installAppUpdate(installerPath));
    ipcMain.handle('updates:relaunchApp', () => updateService.relaunchApp());


    // Devices & Hardware
    ipcMain.handle('devices:get-all', async (_, force = false) => {
      if (force) await deviceDiscoveryService.forceRescan();
      const mtpDevices = await MtpService.getDevices();
      const usbDevices = await UsbService.getDevices();
      const bdsmDevices = deviceDiscoveryService.getDevices();
      const sonyDevices = sonyCameraService.getCameras();

      // Quando o mesmo aparelho físico já está acessível via o app BDSM (que dá acesso
      // direto às gravações do app), suprimimos a entrada MTP genérica equivalente — o
      // usuário quer trabalhar com as gravações do app, não navegar o sistema de arquivos
      // bruto do dispositivo via MTP. Não existe um ID compartilhado entre os dois
      // protocolos, então o cruzamento é feito pelo nome do dispositivo (normalizado).
      const normalizeDeviceName = (name) => (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const bdsmNames = new Set(bdsmDevices.map(d => normalizeDeviceName(d.name)));
      const mtpDevicesFiltered = mtpDevices.filter(d => {
        const mtpName = normalizeDeviceName(d.name || d.Name);
        const matchesBdsm = mtpName && bdsmNames.has(mtpName);
        if (matchesBdsm) {
          logger.info('devices:get-all:mtp_suppressed_duplicate_of_bdsm', { name: d.name || d.Name });
        }
        return !matchesBdsm;
      });

      return [
        ...mtpDevicesFiltered.map(d => ({ ...d, type: 'MTP', isBdsm: false })),
        ...usbDevices.map(d => ({ ...d, type: 'USB', isBdsm: false })),
        ...bdsmDevices.map(d => ({ ...d, type: 'BDSM', isBdsm: true })),
        ...sonyDevices.map(d => ({ ...d, type: 'SONY', isBdsm: false }))
      ];
    });
    ipcMain.handle('usb:list-folder', (_, basePath, pathArray) => UsbService.listFolder(basePath, pathArray));
    ipcMain.handle('usb:import-items', (_, basePath, pathArray, itemNames, destFolder) => UsbService.importItems(basePath, pathArray, itemNames, destFolder));
    ipcMain.handle('mtp:list-folder', (_, deviceName, pathArray) => MtpService.listMtpFolder(deviceName, pathArray));
    ipcMain.handle('mtp:import-items', (_, deviceName, pathArray, itemNames, destFolder) => MtpService.importMtpItems(deviceName, pathArray, itemNames, destFolder));

    // Sony Camera Integration
    ipcMain.handle('sony:list', async (_, cameraId, options) => {
      const provider = sonyCameraService.getProvider(cameraId);
      if (!provider) return [];
      return await provider.list(options);
    });

    ipcMain.handle('sony:browse', async (_, cameraId, uri) => {
      const provider = sonyCameraService.getProvider(cameraId);
      if (!provider) return [];
      return await provider.browse(uri);
    });

    ipcMain.handle('sony:get-status', async (_, cameraId) => {
      const provider = sonyCameraService.getProvider(cameraId);
      if (!provider) return null;
      return await provider.getDeviceStatus();
    });

    ipcMain.handle('sony:import-items', async (event, { cameraId, items, destFolder }) => {
      const provider = sonyCameraService.getProvider(cameraId);
      if (!provider) throw new Error(`Provider não encontrado para ${cameraId}`);

      if (!fs.existsSync(destFolder)) {
        fs.mkdirSync(destFolder, { recursive: true });
      }

      const importedPaths = [];
      let index = 0;

      for (const item of items) {
        index++;
        try {
          const files = await provider.import(item, destFolder, (progress) => {
            event.sender.send('sony:import-progress', {
              currentItem: item.title || item.filename,
              itemIndex: index,
              totalItems: items.length,
              ...progress
            });
          });

          for (const filePath of files) {
            importedPaths.push(filePath);
            // Pipeline padrão da Library: enfileira importação com hash e FFProbe
            if (this.services.importQueue) {
              const db = dbManager.get();
              let lib = db.prepare("SELECT * FROM libraries WHERE type = 'BDSM_DEVICE' OR type = 'DEVICE' LIMIT 1").get();
              if (!lib) {
                lib = db.prepare("SELECT * FROM libraries LIMIT 1").get();
              }
              if (lib) {
                this.services.importQueue.enqueue({
                  library: lib,
                  filePath: filePath
                });
              }
            }
          }
        } catch (e) {
          logger.error(`[Sony Import] Erro ao importar ${item.title || item.filename}: ${e.message}`);
        }
      }

      return importedPaths;
    });

    // Upload & Scanner
    ipcMain.handle('upload:scanDirectory', async (_, customDir) => {
      const settings = this.settingsManager.load();
      const targetDir = customDir || settings.uploadsFolder || path.join(os.homedir(), 'Videos', 'Uploads');
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      return uploadScannerService.scanDirectory(targetDir);
    });
    ipcMain.handle('upload:selectFolder', async () => {
      const win = this.mainWindow || BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      if (!result.canceled && result.filePaths.length > 0) {
        const selectedDir = result.filePaths[0];
        this.settingsManager.save({ uploadsFolder: selectedDir });
        return uploadScannerService.scanDirectory(selectedDir);
      }
      return null;
    });
    ipcMain.handle('upload:selectFiles', async () => {
      const win = this.mainWindow || BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Vídeos', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }]
      });
      if (!result.canceled && result.filePaths.length > 0) {
        const fileList = [];
        for (const filePath of result.filePaths) {
          const stats = fs.statSync(filePath);
          const meta = await uploadScannerService.getVideoMetadata(filePath);
          fileList.push({
            id: Buffer.from(filePath).toString('base64'),
            name: path.basename(filePath),
            path: filePath,
            dir: path.dirname(filePath),
            sizeBytes: stats.size,
            sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
            createdAt: stats.birthtime,
            modifiedAt: stats.mtime,
            ...meta
          });
        }
        return fileList;
      }
      return [];
    });
    ipcMain.handle('upload:addToQueue', (_, account, fileData) => UploadService.addToQueue(account, fileData));
    ipcMain.handle('upload:startJob', (_, jobId) => UploadService.startUpload(jobId));
    ipcMain.handle('upload:getQueue', () => UploadService.getQueue());
    ipcMain.handle('upload:clearQueue', () => UploadService.clearQueue());
  }

  startBackgroundServices() {
    try {
      // 1. Inicia watcher de bibliotecas
      if (this.services.watcherService) {
        this.services.watcherService.startAll();

        // [FIX] Regenera thumbnails ausentes em background — encadeado APÓS a
        // reconciliação de arquivos terminar, para os processos ffmpeg do regen
        // NÃO competirem por I/O com os fs.access() da reconciliação.
        // (Antes rodavam concorrentes: reconciliação 1.6s→13.5s; regen sofria junto.)
        const ws = this.services.watcherService;
        Promise.resolve(ws.whenReconcileDone())
          .then(() => {
            setTimeout(() => {
              const { regenerateMissingThumbnails } = require('./core/library/ThumbnailRegenService');
              regenerateMissingThumbnails({
                paths: this.paths,
                dbManager,
                window: this.mainWindow,
                batchSize: 10, // [PERF] maior paralelismo = regen ~2x mais rápido
                logPrefix: '[Bootstrap] RegenThumbs',
              }).catch((err) => {
                logger.warn('Bootstrap:regenThumbs:error', { error: err.message });
              });
            }, 500); // pequena folga pós-reconciliação
          })
          .catch(() => {});
      }

      // 2. Inicia descoberta de dispositivos
      deviceDiscoveryService.start();
      sonyCameraService.start();

      // 3. Inicia verificação de prazos dos projetos (lembretes de deadline)
      deadlineNotifier.start(this.settingsManager.load());
      logger.info('Serviços em segundo plano inicializados.');
    } catch (err) {
      logger.error('Erro ao iniciar serviços em segundo plano:', { error: err.message });
    }
  }

  async checkInitialDependencies() {
    const { updateService } = this.services;
    
    // Verifica apenas ferramentas essenciais de execução
    const requiredTools = ['ytdlp', 'ffmpeg', 'ffprobe'];
    const missing = requiredTools.filter(tool => {
      try {
        if (tool === 'ytdlp') return !externalTools.ytdlp.exists();
        if (tool === 'ffmpeg') return !externalTools.ffmpeg.exists();
        if (tool === 'ffprobe') return !externalTools.ffprobe.exists();
      } catch (_) {
        return true;
      }
      return false;
    });

    if (missing.length > 0) {
      logger.info(`Primeira inicialização: Baixando dependências essenciais ausentes: ${missing.join(', ')}`);
      this.mainWindow?.webContents.send('dependencies:downloading');

      for (const tool of missing) {
        try {
          await updateService.updateTool(tool);
        } catch (e) {
          logger.error(`Erro ao baixar ${tool} na inicialização`, { error: e.message });
        }
      }

      this.mainWindow?.webContents.send('dependencies:done');
      logger.info('Dependências iniciais instaladas com sucesso.');
    } else if (this.settingsManager.load().checkUpdatesOnStart) {
      // Usa checkEverything() (mesmo método do botão "Verificar Atualizações" em
      // Configurações) para checar app + dependências num formato { hasUpdates, app,
      // dependencies } esperado pelo renderer. checkAll() é um método legado com formato
      // diferente (um objeto por ferramenta) e não deve ser usado aqui.
      updateService.checkEverything().then((result) => {
        this.mainWindow?.webContents.send('updates:checked', result);
      }).catch((error) => {
        logger.warn('updates:startup_check_failed', { error: error.message });
      });
    }
  }

  async cleanup() {
    const { downloadService, converterService, watcherService } = this.services;
    try {
      if (downloadService && typeof downloadService.pause === 'function') {
        downloadService.pause();
      }
    } catch (_) {}

    try {
      if (converterService && typeof converterService.isRunning === 'function' && converterService.isRunning()) {
        await converterService.cancelCurrent();
      }
    } catch (_) {}

    try { watcherService?.stopAll(); } catch (_) {}
    try { deadlineNotifier.stop(); } catch (_) {}
    try { deviceDiscoveryService?.stop(); } catch (_) {}
    try { sonyCameraService?.stop?.(); } catch (_) {}
  }
}

module.exports = Bootstrap;
