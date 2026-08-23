'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ipcMain, dialog, BrowserWindow, app } = require('electron');

const logger = require('./services/logService');
const SettingsManager = require('./core/settings/SettingsManager');
const LutManager = require('./core/luts/LutManager');
const { errorReporter } = require('./infrastructure/telemetry/ErrorReporter');

const { ffmpegTool } = require('./infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('./infrastructure/external-tools/adapters/FfprobeTool');
const { externalTools } = require('./infrastructure/external-tools/ExternalToolsManager');

const DownloadService = require('./services/downloadService');
const HistoryService = require('./services/historyService');
const ThumbnailService = require('./services/thumbnailService');
const ConverterService = require('./services/converterService');
const UpdateService = require('./services/updateService');
const MontageService = require('./services/montageService');
const SilenceService = require('./services/silenceService');
const MetadataService = require('./services/metadataService');
const VideoRecoveryService = require('./services/videoRecoveryService');
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
  }

  async init() {
    const paths = this.paths;
    const settings = this.settingsManager.load();

    // Inicializar Sistema de Envio de Erros / Telemetria
    errorReporter.init({
      logsDir: this.appPaths.logsDir,
      developerEmail: settings.developerEmail || 'obragafilho00@gmail.com',
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
    const updateService = new UpdateService({ paths });
    const montageService = new MontageService({ paths });
    const silenceService = new SilenceService({ paths });
    const metadataServiceInstance = new MetadataService({ paths });
    const videoRecoveryService = new VideoRecoveryService({ paths });

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
    watcherService.startAll();

    // 4. Inicializar Descoberta de Hardware
    deviceDiscoveryService.start();
    sonyCameraService.start();

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
    const { downloadService, converterService, montageService, silenceService, metadataService, importQueue } = this.services;

    // Discovery Events
    deviceDiscoveryService.on('device_added', (d) => this.mainWindow?.webContents.send('bdsm:device_added', d));
    deviceDiscoveryService.on('device_removed', (id) => this.mainWindow?.webContents.send('bdsm:device_removed', id));
    deviceDiscoveryService.on('device_updated', (d) => this.mainWindow?.webContents.send('bdsm:device_updated', d));

    // Sony Camera Events
    sonyCameraService.on('camera_connected', (cam) => this.mainWindow?.webContents.send('sony:camera_connected', cam));
    sonyCameraService.on('camera_status_updated', (status) => this.mainWindow?.webContents.send('sony:status_updated', status));

    // Media Library Events
    EventBus.on('MEDIA_IMPORTED', (m) => this.mainWindow?.webContents.send('bds:media-imported', m));
    EventBus.on('MEDIA_REMOVED', (p) => this.mainWindow?.webContents.send('bds:media-removed', p));
    EventBus.on('MEDIA_UPDATED', (p) => this.mainWindow?.webContents.send('bds:media-updated', p));

    // Download Events
    downloadService.on('downloads:added', (item) => this.mainWindow?.webContents.send('downloads:added', item));
    downloadService.on('downloads:updated', (queue) => this.mainWindow?.webContents.send('downloads:updated', queue));
    downloadService.on('downloads:progress', (data) => this.mainWindow?.webContents.send('downloads:progress', data));
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
    downloadService.on('downloads:failed', (data) => this.mainWindow?.webContents.send('downloads:failed', data));
    downloadService.on('downloads:removed', (id) => this.mainWindow?.webContents.send('downloads:removed', id));
    downloadService.on('downloads:queue-completed', () => this.mainWindow?.webContents.send('downloads:queue-completed'));
    downloadService.on('queue', (payload) => this.mainWindow?.webContents.send('download:queue', payload));
    downloadService.on('progress', (payload) => this.mainWindow?.webContents.send('download:progress', payload));
    downloadService.on('finished', (payload) => this.mainWindow?.webContents.send('download:finished', payload));
    downloadService.on('youtube:code', (data) => this.mainWindow?.webContents.send('youtube:code', data));
    downloadService.on('youtube:auth-status', (status) => this.mainWindow?.webContents.send('youtube:auth-status', status));

    // Converter Events
    converterService.on('queue', (p) => this.mainWindow?.webContents.send('converter:queue', p));
    converterService.on('fileStarted', (p) => this.mainWindow?.webContents.send('converter:fileStarted', p));
    converterService.on('progress', (p) => this.mainWindow?.webContents.send('converter:progress', p));
    converterService.on('fileFinished', (p) => this.mainWindow?.webContents.send('converter:fileFinished', p));
    converterService.on('finished', (p) => this.mainWindow?.webContents.send('converter:finished', p));

    // Montage Events
    montageService.on('progress', (p) => this.mainWindow?.webContents.send('montage:progress', p));
    montageService.on('finished', (p) => this.mainWindow?.webContents.send('montage:finished', p));
    montageService.on('queue-updated', (q) => this.mainWindow?.webContents.send('montage:queue-updated', q));
    montageService.on('log', (t) => this.mainWindow?.webContents.send('montage:log', t));

    // Silence Events
    silenceService.on('progress', (p) => this.mainWindow?.webContents.send('silence:progress', p));
    silenceService.on('finished', (p) => this.mainWindow?.webContents.send('silence:finished', p));
    silenceService.on('log', (p) => this.mainWindow?.webContents.send('silence:log', p));

    // Metadata Events
    metadataService.on('progress', (p) => this.mainWindow?.webContents.send('metadata:progress', p));
    metadataService.on('log', (p) => this.mainWindow?.webContents.send('metadata:log', p));

    // Recovery Events
    const { videoRecoveryService, updateService } = this.services;
    videoRecoveryService.on('progress', (p) => this.mainWindow?.webContents.send('recovery:progress', p));
    videoRecoveryService.on('stage', (p) => this.mainWindow?.webContents.send('recovery:stage', p));
    videoRecoveryService.on('finished', (p) => this.mainWindow?.webContents.send('recovery:finished', p));
    videoRecoveryService.on('error', (p) => this.mainWindow?.webContents.send('recovery:error', p));

    // Update Events
    updateService.on('progress', (p) => this.mainWindow?.webContents.send('updates:progress', p));
    updateService.on('completed', (p) => this.mainWindow?.webContents.send('updates:completed', p));

    // Hardware Provider Events
    UsbService.on('progress', (data) => this.mainWindow?.webContents.send('mtp:import-progress', data));
    MtpService.on('progress', (data) => this.mainWindow?.webContents.send('mtp:import-progress', data));

    // Upload & Sony Events
    UploadService.on('queue-updated', (q) => this.mainWindow?.webContents.send('upload:queue-updated', q));
    sonyCameraService.on('connected', (d) => this.mainWindow?.webContents.send('sony-camera:connected', d));
    sonyCameraService.on('disconnected', () => this.mainWindow?.webContents.send('sony-camera:disconnected'));
    sonyCameraService.on('photo-taken', (d) => this.mainWindow?.webContents.send('sony-camera:photo-taken', d));
    sonyCameraService.on('status-update', (d) => this.mainWindow?.webContents.send('sony-camera:status-update', d));
    sonyCameraService.on('download-progress', (d) => this.mainWindow?.webContents.send('sony-camera:download-progress', d));
  }

  _registerIpcHandlers() {
    const {
      downloadService, converterService, historyService, thumbnailService,
      updateService, montageService, silenceService, metadataService,
      videoRecoveryService, projectService, premiereExporter, bdsproPackageService,
      waveformService, audioSyncService, sequenceBuilder,
      uploadScannerService, libManager, watcherService, lutSyncService
    } = this.services;

    // Registra Handlers por Módulo
    require('./ipc/deviceHandlers')(logger, lutSyncService);
    require('./ipc/libraryHandlers')(this.paths, watcherService);
    require('./ipc/systemHandlers')(this.paths);
    require('./ipc/recoveryHandlers')(videoRecoveryService, this.paths);
    require('./ipc/youtubeHandlers')();
    require('./ipc/projectHandlers')(projectService, premiereExporter, bdsproPackageService, this.paths, waveformService, audioSyncService, sequenceBuilder);
    require('./ipc/lutHandlers')(this.lutManager);
    require('./ipc/telemetryHandlers')();
    require('./ipc/jobHandlers')();

    // Settings
    ipcMain.handle('settings:get', () => this.settingsManager.load());
    ipcMain.handle('settings:save', (_, settings) => {
      const saved = this.settingsManager.save(settings);
      if (libManager && watcherService) {
        this._syncLibraries(libManager, saved);
        watcherService.stopAll();
        setTimeout(() => watcherService.startAll(), 1000);
      }
      return saved;
    });

    ipcMain.handle('app:getVersion', () => app.getVersion());

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
    ipcMain.handle('updates:updateAll', async () => {
      return await updateService.updateAll();
    });

    // Devices & Hardware
    ipcMain.handle('devices:get-all', async (_, force = false) => {
      if (force) await deviceDiscoveryService.forceRescan();
      const mtpDevices = await MtpService.getDevices();
      const usbDevices = await UsbService.getDevices();
      const bdsmDevices = deviceDiscoveryService.getDevices();
      const sonyDevices = sonyCameraService.getCameras();
      return [
        ...mtpDevices.map(d => ({ ...d, type: 'MTP', isBdsm: false })),
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

  async checkInitialDependencies() {
    const missingTools = externalTools.getMissing();
    const { updateService } = this.services;

    if (missingTools.length > 0) {
      logger.info('Primeira inicialização detectada. Baixando dependências...');
      this.mainWindow?.webContents.send('dependencies:downloading');

      const tools = ['yt-dlp', 'ffmpeg', 'ffprobe', 'spotdl'];
      for (const tool of tools) {
        try {
          await updateService.updateTool(tool);
        } catch (e) {
          logger.error(`Erro ao baixar ${tool} na inicialização`, { error: e.message });
        }
      }

      this.mainWindow?.webContents.send('dependencies:done');
      logger.info('Dependências iniciais instaladas com sucesso.');
    } else if (this.settingsManager.load().checkUpdatesOnStart) {
      updateService.checkAll().then((result) => {
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
    try { deviceDiscoveryService?.stop(); } catch (_) {}
    try { sonyCameraService?.disconnect?.(); } catch (_) {}
  }
}

module.exports = Bootstrap;
