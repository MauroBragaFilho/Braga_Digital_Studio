const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// --- NOVA FUNÇÃO: Parse de arquivos .cube ---
function parseCubeFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/); // \r\n no Windows

  let size = null;
  let lutData = [];

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('#') || trimmedLine === '') {
      continue; // Comentários ou linhas vazias
    }

    if (trimmedLine.startsWith('TITLE')) {
      // Poderia extrair o título se necessário
      continue;
    }

    if (trimmedLine.startsWith('LUT_3D_SIZE')) {
      const sizeMatch = trimmedLine.match(/LUT_3D_SIZE\s+(\d+)/);
      if (sizeMatch) {
        size = parseInt(sizeMatch[1], 10);
      }
      continue;
    }

    // Assume que as próximas linhas válidas são trios RGB
    if (size && !isNaN(size)) {
      const rgbValues = trimmedLine.split(/\s+/).map(parseFloat);
      if (rgbValues.length === 3) {
        lutData.push(rgbValues);
      }
    }
  }

  if (!size || lutData.length === 0) {
    throw new Error('Formato de LUT inválido ou dados ausentes.');
  }

  // Validação: número de entradas deve ser size^3
  if (lutData.length !== size * size * size) {
    throw new Error(`Número de entradas (${lutData.length}) não corresponde ao tamanho (${size}^3 = ${size * size * size})`);
  }

  return {
    size,
    data: lutData
  };
}
// --- FIM DA NOVA FUNÇÃO ---

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('remote-debugging-port', '8315');

const isPackaged = app.isPackaged;
const appRoot = isPackaged ? process.resourcesPath : __dirname;
const writableRoot = isPackaged ? app.getPath('userData') : __dirname;
const paths = {
  appRoot,
  dataDir: path.join(writableRoot, 'data'),
  configDir: path.join(writableRoot, 'config'),
  databaseDir: path.join(writableRoot, 'database'),
  logsDir: path.join(writableRoot, 'logs'),
  lutsDir: path.join(writableRoot, 'data', 'LUTs')
};
process.env.BMD_LOGS_DIR = paths.logsDir;

const DownloadService = require('./src/services/downloadService');
const HistoryService = require('./src/services/historyService');
const ThumbnailService = require('./src/services/thumbnailService');
const ConverterService = require('./src/services/converterService');
const UpdateService = require('./src/services/updateService');
const logger = require('./src/services/logService');
const metadataService = require('./src/services/metadataService');
const MtpService = require('./src/core/MtpService');
const UsbService = require('./src/core/UsbService');
const UploadService = require('./src/core/UploadService');
const sonyCameraService = require('./src/services/sonyCameraService');

const projectService = require('./src/core/projects/ProjectService');
const PremiereExporter = require('./src/core/projects/PremiereExporter');
const premiereExporter = new PremiereExporter(projectService);

const deviceDiscoveryService = require('./src/core/devices/DeviceDiscoveryService');
const BdsmClient = require('./src/core/devices/BdsmClient');
const LutSyncService = require('./src/core/devices/LutSyncService');
const lutSyncService = new LutSyncService(paths.lutsDir);

// --- HANDLER PARA LEITURA E PARSING DE .CUBE ---
ipcMain.handle('luts:parse', async (event, filePath) => {
  try {
    const parsedLut = parseCubeFile(filePath);
    // Opcional: retornar o caminho e nome do arquivo também
    return {
      path: filePath,
      name: path.basename(filePath),
      ...parsedLut
    };
  } catch (error) {
    console.error("Erro ao parsear LUT:", error);
    throw error; // Re-throw para o frontend capturar
  }
});

// --- HANDLER LEGADO (leitura bruta) ---
ipcMain.handle('luts:load', async (event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { rawContent: content };
  } catch (error) {
    console.error("Erro ao ler LUT:", error);
    throw error;
  }
});

for (const dir of Object.values(paths)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Copy bundled LUTs to writable lutsDir if packaged
  try {
    const bundledLutsDir = path.join(__dirname, 'data', 'LUTs');
    if (fs.existsSync(bundledLutsDir)) {
      const bundledFiles = fs.readdirSync(bundledLutsDir);
      for (const file of bundledFiles) {
        if (file.endsWith('.cube')) {
          const destFile = path.join(paths.lutsDir, file);
          if (!fs.existsSync(destFile)) {
            fs.copyFileSync(path.join(bundledLutsDir, file), destFile);
          }
        }
      }
    }
  } catch(err) {
    console.error('Error copying bundled LUTs:', err);
  }

const settingsPath = path.join(paths.configDir, 'settings.json');
const defaultSettings = {
  useDefaultFolder: true,
  mp3Folder: path.join(os.homedir(), 'Music'),
  mp4Folder: path.join(os.homedir(), 'Videos'),
  obsFolder: '',
  shadowplayFolder: '',
  deviceFolder: path.join(os.homedir(), 'Videos', 'BDSM DEVICES'),
  autoUpdateDeps: false,
  cookiesFile: path.join(paths.dataDir, 'cookies.txt'),
  useYoutubeAccount: false,
  theme: 'dark',
  accentColor: '#e53935'
};

function loadSettings() {
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2), 'utf8');
    return { ...defaultSettings };
  }

  try {
    logger.info('Iniciando o Braga Digital Studio...');
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const merged = { ...defaultSettings, ...saved };
    if (!merged.mp3Folder) merged.mp3Folder = defaultSettings.mp3Folder;
    if (!merged.mp4Folder) merged.mp4Folder = defaultSettings.mp4Folder;
    if (!merged.cookiesFile) merged.cookiesFile = defaultSettings.cookiesFile;
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (error) {
    logger.error('settings:failed_to_read', { error: error.message });
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2), 'utf8');
    return { ...defaultSettings };
  }
}

function saveSettings(nextSettings) {
  const current = loadSettings();
  const merged = { ...current, ...nextSettings };
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

let mainWindow;
let downloadService;
let converterService;
let historyService;
let thumbnailService;
let updateService;
let libManager;
let importQueue;
let watcherService;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 380,
    resizable: true,
    backgroundColor: '#121212',
    title: 'Braga Digital Studio',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  historyService = await HistoryService.create(paths.databaseDir);
  converterService = new ConverterService({ paths, getSettings: loadSettings, historyService});
  thumbnailService = new ThumbnailService({ paths, getSettings: loadSettings });
  updateService = new UpdateService({ paths });
  const MontageService = require('./src/services/montageService');
  const montageService = new MontageService({ paths });

  const SilenceService = require('./src/services/silenceService');
  const silenceService = new SilenceService({ paths });
  const MetadataService = require('./src/services/metadataService');
  const metadataService = new MetadataService({ paths });

  // Inicializar Serviços de Descoberta
  deviceDiscoveryService.start();

  deviceDiscoveryService.on('device_added', (device) => {
    if (mainWindow) mainWindow.webContents.send('bdsm:device_added', device);
  });
  deviceDiscoveryService.on('device_removed', (deviceId) => {
    if (mainWindow) mainWindow.webContents.send('bdsm:device_removed', deviceId);
  });
  deviceDiscoveryService.on('device_updated', (device) => {
    if (mainWindow) mainWindow.webContents.send('bdsm:device_updated', device);
  });

  // --- Inicialização Fase 1.2: Media Library Watcher ---
  const dbManager = require('./src/core/database/database');
  const { runMigrations } = require('./src/core/database/migrations');
  const LibraryManager = require('./src/core/library/LibraryManager');
  const ImportQueue = require('./src/core/library/ImportQueue');
  const LibraryWatcherService = require('./src/core/library/LibraryWatcherService');
  const EventBus = require('./src/core/EventBus');

  try {
    await dbManager.init(paths.databaseDir);
    runMigrations();
    downloadService = new DownloadService({ paths, getSettings: loadSettings, historyService });

    // Migrate old BDSM_DEVICE origins to actual device names
    try {
      const db = dbManager.get();
      const bdsmMedia = db.prepare("SELECT m.id, m.filepath, l.path as lib_path FROM media m JOIN libraries l ON m.library_id = l.id WHERE m.origin = 'BDSM_DEVICE'").all();
      for (const media of bdsmMedia) {
        if (media.filepath && media.lib_path) {
          const relativeDir = require('path').dirname(require('path').relative(media.lib_path, media.filepath));
          if (relativeDir && relativeDir !== '.' && relativeDir !== '') {
            const deviceName = relativeDir.split(require('path').sep)[0];
            db.prepare("UPDATE media SET origin = ? WHERE id = ?").run(deviceName, media.id);
          }
        }
      }
    } catch (e) {
      console.warn("Failed to migrate BDSM_DEVICE origins", e);
    }
    libManager = new LibraryManager();
    const db = dbManager.get();
    
    // Remove LOCAL_FOLDER ou LOCAL se ainda existirem no banco
    db.prepare("DELETE FROM libraries WHERE type IN ('LOCAL_FOLDER', 'LOCAL') OR name LIKE '%LOCAL%'").run();

    let libs = libManager.list();
    const settings = loadSettings();
    
    // Sincroniza configurações com a biblioteca apenas se a pasta estiver configurada
    const syncLibrary = (name, type, folderPath) => {
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
    
    if (settings.obsFolder) syncLibrary('OBS Studio', 'OBS', settings.obsFolder);
    if (settings.shadowplayFolder) syncLibrary('NVIDIA ShadowPlay', 'SHADOWPLAY', settings.shadowplayFolder);
    if (settings.deviceFolder) syncLibrary('BDSM Devices', 'BDSM_DEVICE', settings.deviceFolder);
    
    // Recarrega
    libs = libManager.list();

    const ffprobePath = path.join(paths.dataDir, 'ffprobe.exe');
    const ffmpegPath = path.join(paths.dataDir, 'ffmpeg.exe');
    const thumbnailsDir = path.join(paths.dataDir, 'Thumbnails');

    importQueue = new ImportQueue({ ffprobePath, ffmpegPath, thumbnailsDir });
    watcherService = new LibraryWatcherService(importQueue);
    
    // Inicia o monitoramento automático das pastas
    watcherService.startAll();

    // FTP Server for Sony a6000
    const ftpService = require('./src/services/ftpService');
    const ftpRoot = settings.deviceFolder 
      ? path.join(settings.deviceFolder, 'Transferencias Wi-Fi (FTP)') 
      : path.join(paths.dataDir, 'Transferencias Wi-Fi (FTP)');
    ftpService.start(ftpRoot);




    // Eventos do backend para o Frontend (Reactivo)
    EventBus.on('MEDIA_IMPORTED', (media) => mainWindow?.webContents.send('bds:media-imported', media));
    EventBus.on('MEDIA_REMOVED', (payload) => mainWindow?.webContents.send('bds:media-removed', payload));
    EventBus.on('MEDIA_UPDATED', (payload) => mainWindow?.webContents.send('bds:media-updated', payload));
  } catch (error) {
    logger.error('Falha ao inicializar a Media Library', { error: error.message });
  }
  // ---------------------------------------------
  require('./src/ipc/deviceHandlers')(logger, lutSyncService);
  require('./src/ipc/libraryHandlers')(paths, watcherService);
  require('./src/ipc/systemHandlers')(paths);
  require('./src/ipc/youtubeHandlers')();

  // Eventos do DownloadManager
  downloadService.on('downloads:added', (item) => mainWindow?.webContents.send('downloads:added', item));
  downloadService.on('downloads:updated', (queue) => mainWindow?.webContents.send('downloads:updated', queue));
  downloadService.on('downloads:progress', (data) => mainWindow?.webContents.send('downloads:progress', data));
  downloadService.on('downloads:completed', (item) => {
    mainWindow?.webContents.send('downloads:completed', item);
    if (item.outputPath) {
      try {
        const dbManager = require('./src/core/database/database');
        const db = dbManager.get();
        let lib = db.prepare("SELECT * FROM libraries WHERE type = 'DOWNLOADER'").get();
        if (!lib) {
          const info = db.prepare("INSERT INTO libraries (name, type, path, enabled, auto_scan) VALUES (?, ?, ?, 1, 0)").run('Downloads', 'DOWNLOADER', '');
          lib = { id: info.lastInsertRowid, type: 'DOWNLOADER' };
        }
        if (importQueue) {
          importQueue.add({ libraryId: lib.id, path: item.outputPath });
        }
      } catch (err) {
        logger.error('Erro ao adicionar download à biblioteca:', { error: err.message });
      }
    }
  });
  downloadService.on('downloads:failed', (data) => mainWindow?.webContents.send('downloads:failed', data));
  downloadService.on('downloads:removed', (id) => mainWindow?.webContents.send('downloads:removed', id));
  downloadService.on('downloads:queue-completed', () => mainWindow?.webContents.send('downloads:queue-completed'));

  // Eventos Legados mantidos para compatibilidade
  downloadService.on('queue', (payload) => mainWindow?.webContents.send('download:queue', payload));
  downloadService.on('progress', (payload) => mainWindow?.webContents.send('download:progress', payload));
  downloadService.on('finished', (payload) => mainWindow?.webContents.send('download:finished', payload));
  
  // Novos Eventos de Autenticação YouTube
  downloadService.on('youtube:code', (data) => mainWindow?.webContents.send('youtube:code', data));
  downloadService.on('youtube:auth-status', (status) => mainWindow?.webContents.send('youtube:auth-status', status));

  // Eventos de Conversor
  converterService.on('queue', (payload) => mainWindow?.webContents.send('converter:queue', payload));
  converterService.on('fileStarted', (payload) => mainWindow?.webContents.send('converter:fileStarted', payload));
  converterService.on('progress', (payload) => mainWindow?.webContents.send('converter:progress', payload));
  converterService.on('fileFinished', (payload) => mainWindow?.webContents.send('converter:fileFinished', payload));
  converterService.on('finished', (payload) => mainWindow?.webContents.send('converter:finished', payload));

  // Eventos de Montagem
  montageService.on('progress', (payload) => mainWindow?.webContents.send('montage:progress', payload));
  montageService.on('finished', (payload) => mainWindow?.webContents.send('montage:finished', payload));
  montageService.on('queue-updated', (queue) => {
    if (mainWindow) {
      mainWindow.webContents.send('montage:queue-updated', queue);
    }
  });

  montageService.on('log', (text) => {
    if (mainWindow) mainWindow.webContents.send('montage:log', text);
  });

  // Eventos de Silêncio
  silenceService.on('progress', (payload) => mainWindow?.webContents.send('silence:progress', payload));
  silenceService.on('finished', (payload) => mainWindow?.webContents.send('silence:finished', payload));
  silenceService.on('log', (payload) => mainWindow?.webContents.send('silence:log', payload));

  // Eventos de Metadados
  metadataService.on('progress', (payload) => mainWindow?.webContents.send('metadata:progress', payload));
  metadataService.on('log', (payload) => mainWindow?.webContents.send('metadata:log', payload));

  // Handlers de Montagem
  ipcMain.handle('montage:probe', (_, filePath) => montageService.probeFile(filePath));
  ipcMain.handle('montage:enqueue', async (event, config) => {
    return montageService.enqueueMontage(config);
  });
  
  ipcMain.handle('montage:cancelJob', async (event, id) => {
    montageService.cancelJob(id);
  });
  
  ipcMain.handle('montage:removeJob', async (event, id) => {
    montageService.removeJob(id);
  });
  
  ipcMain.handle('montage:clearQueue', async (event) => {
    montageService.clearQueue();
  });
  
  ipcMain.handle('montage:getQueue', async (event) => {
    return montageService.getQueue();
  });

  // Handlers de Silêncio
  ipcMain.handle('silence:probe', (_, filePath) => silenceService.probeFile(filePath));
  ipcMain.handle('silence:analyze', (_, config) => silenceService.analyzeSilence(config.filePath, config.threshold, config.minDuration));
  ipcMain.handle('silence:process', (_, config) => silenceService.processQueue(config));
  ipcMain.handle('silence:cancel', () => silenceService.cancel());

  // Handlers de Metadados
  ipcMain.handle('metadata:probe', (_, filePath) => metadataService.probeFile(filePath));
  ipcMain.handle('metadata:extractThumb', (_, filePath) => metadataService.extractThumbnail(filePath));
  ipcMain.handle('metadata:save', (_, config) => metadataService.saveMetadata(config));
  ipcMain.handle('metadata:cancel', () => metadataService.cancel());

  require('./src/ipc/projectHandlers')(projectService, premiereExporter);

  // Handlers de LUTs
  ipcMain.handle('luts:get', async () => {
    try {
      if (!fs.existsSync(paths.lutsDir)) return [];
      const files = fs.readdirSync(paths.lutsDir);
      const luts = [];
      for (const file of files) {
        if (file.toLowerCase().endsWith('.cube')) {
          const fullPath = path.join(paths.lutsDir, file);
          const stats = fs.statSync(fullPath);
          luts.push({
            name: file,
            path: fullPath,
            size: stats.size,
            mtime: stats.mtime
          });
        }
      }
      return luts;
    } catch (err) {
      logger.error('luts:get_failed', { error: err.message });
      return [];
    }
  });

  ipcMain.handle('luts:import', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Importar LUT (.cube)',
        filters: [{ name: 'LUTs', extensions: ['cube'] }],
        properties: ['openFile', 'multiSelections']
      });

      if (canceled || filePaths.length === 0) return false;

      for (const filePath of filePaths) {
        const fileName = path.basename(filePath);
        const destPath = path.join(paths.lutsDir, fileName);
        fs.copyFileSync(filePath, destPath);
      }
      return true;
    } catch (err) {
      logger.error('luts:import_failed', { error: err.message });
      throw err;
    }
  });

      ipcMain.handle('luts:rename', async (_, oldPath, newName) => {
      try {
        if (!fs.existsSync(oldPath)) return false;
        
        let finalName = newName;
        if (!finalName.toLowerCase().endsWith('.cube')) {
          finalName += '.cube';
        }
        
        const dir = path.dirname(oldPath);
        const newPath = path.join(dir, finalName);
        
        if (fs.existsSync(newPath)) {
          throw new Error('Já existe um arquivo com esse nome.');
        }
        
        fs.renameSync(oldPath, newPath);
        return true;
      } catch (err) {
        logger.error('luts:rename_failed', { error: err.message });
        throw err;
      }
    });

    ipcMain.handle('luts:delete', async (_, filePath) => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
      return false;
    } catch (err) {
      logger.error('luts:delete_failed', { error: err.message });
      throw err;
    }
  });

  registerIpc();
  createWindow();

  // Verificação de primeira inicialização
  const checkInitialDependencies = async () => {
    const exes = ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe', 'spotify-dlp.exe'];
    const missing = exes.some(exe => !fs.existsSync(path.join(paths.dataDir, exe)));
    
    if (missing) {
      logger.info('Primeira inicialização detectada. Baixando dependências...');
      mainWindow?.webContents.send('dependencies:downloading');
      
      const tools = ['yt-dlp', 'ffmpeg', 'ffprobe', 'spotdl'];
      for (const tool of tools) {
        try {
          await updateService.updateTool(tool);
        } catch (e) {
          logger.error(`Erro ao baixar ${tool} na inicialização`, { error: e.message });
        }
      }
      
      mainWindow?.webContents.send('dependencies:done');
      logger.info('Dependências iniciais instaladas com sucesso.');
    } else if (loadSettings().checkUpdatesOnStart) {
      updateService.checkAll().then((result) => {
        mainWindow?.webContents.send('updates:checked', result);
      }).catch((error) => {
        logger.warn('updates:startup_check_failed', { error: error.message });
      });
    }
  };

  // Dá um tempo curto para a interface renderizar antes de travar
  setTimeout(checkInitialDependencies, 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}); 

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  if (downloadService?.isRunning()) {
    await downloadService.cancelDownload('Aplicativo encerrado');
  }
  if (converterService?.isRunning()) {
    await converterService.cancelCurrent();
  }
  require('./src/services/ftpService').stop();
});

function registerIpc() {
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:save', (_, settings) => {
    const saved = saveSettings(settings);
    
    // Re-sincronizar bibliotecas e monitoramento se estiverem inicializados
    if (libManager && watcherService) {
      const dbManager = require('./src/core/database/database');
      const syncLibrary = (name, type, folderPath) => {
        const libs = libManager.list();
        const existing = libs.find(l => l.type === type);
        if (existing) {
          if (existing.path !== folderPath) {
            const db = dbManager.get();
            db.prepare('UPDATE libraries SET path = ? WHERE id = ?').run(folderPath, existing.id);
          }
        } else {
          libManager.add({ name, type, path: folderPath });
        }
      };
      
      // Remove LOCAL_FOLDER caso o usuário tenha clicado em salvar configurações e ela ainda esteja lá
      const localLib = libs.find(l => l.type === 'LOCAL_FOLDER');
      if (localLib) {
        libManager.remove(localLib.id);
      }
      
      if (saved.obsFolder) syncLibrary('OBS Studio', 'OBS', saved.obsFolder);
      if (saved.shadowplayFolder) syncLibrary('NVIDIA ShadowPlay', 'SHADOWPLAY', saved.shadowplayFolder);
      if (saved.deviceFolder) syncLibrary('BDSM Devices', 'BDSM_DEVICE', saved.deviceFolder);
      
      // Reinicia o monitoramento para aplicar novas pastas
      watcherService.stopAll();
      setTimeout(() => watcherService.startAll(), 1000);
    }
    
    return saved;
  });
  ipcMain.handle('app:getVersion', () => app.getVersion());

  // Window Controls
  ipcMain.handle('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });
  ipcMain.handle('window:maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });

  ipcMain.handle('window:fullscreen', () => {
    if (mainWindow) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });
  
  ipcMain.handle('window:close', () => {
    if (mainWindow) mainWindow.close();
  });

  // Handler de Autenticação YouTube
  ipcMain.handle('startYoutubeAuth', async () => {
      try {
          return await downloadService.startYoutubeAuth();
      } catch (error) {
          logger.error('Erro no fluxo de autenticação:', { error: error.message });
          throw error;
      }
  });

  ipcMain.handle('dialog:selectFolder', async (_, fallbackPath) => {
    const win = mainWindow || BrowserWindow.getFocusedWindow();
    const options = {
      defaultPath: fallbackPath || os.homedir(),
      properties: ['openDirectory', 'createDirectory']
    };
    const result = win 
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:selectFiles', async (event, customOptions) => {
    const defaultOptions = { properties: ['openFile', 'multiSelections'] };
    const options = customOptions ? { ...defaultOptions, ...customOptions } : defaultOptions;
    const win = mainWindow || BrowserWindow.getFocusedWindow();
    const result = win 
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('media:metadata', (_, url) => thumbnailService.getMetadata(url));
  ipcMain.handle('media:inspectPlaylist', (_, url) => thumbnailService.inspectPlaylist(url));
  ipcMain.handle('media:expandPlaylist', (_, url) => thumbnailService.expandPlaylist(url));
  ipcMain.handle('download:start', (_, request) => downloadService.startDownload(request));
  ipcMain.handle('youtube:get-accounts', () => {
    // TODO: Implement reading from database/settings. For now, return empty array.
    return [];
  });
  
  ipcMain.handle('youtube:exportCookies', async () => {
    try {
      const CookiesService = require('./src/core/CookiesService');
      const cookiesPath = path.join(paths.dataDir, 'youtube_cookies.txt');
      const success = await CookiesService.exportNetscapeCookies('youtube.com', cookiesPath, 'persist:youtube_studio');
      
      if (success) {
        saveSettings({ cookiesFile: cookiesPath });
        logger.info('[IPC] Cookies do YouTube exportados e salvos nas configurações:', cookiesPath);
        return { success: true, path: cookiesPath };
      }
      return { success: false };
    } catch (err) {
      logger.error('[IPC] Erro ao exportar cookies do YouTube:', err);
      return { success: false, error: err.message };
    }
  });
  
  // Roteamento para Upload Scanner & Automação
  const UploadScannerService = require('./src/core/uploads/UploadScannerService');
  const uploadScannerService = new UploadScannerService({
    paths,
    ffprobePath: path.join(paths.dataDir, 'ffprobe.exe'),
    ffmpegPath: path.join(paths.dataDir, 'ffmpeg.exe')
  });

  ipcMain.handle('upload:scanDirectory', async (_, customDir) => {
    const settings = loadSettings();
    const targetDir = customDir || settings.uploadsFolder || path.join(os.homedir(), 'Videos', 'Uploads');
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    return uploadScannerService.scanDirectory(targetDir);
  });

  ipcMain.handle('upload:selectFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const selectedDir = result.filePaths[0];
      saveSettings({ uploadsFolder: selectedDir });
      return uploadScannerService.scanDirectory(selectedDir);
    }
    return null;
  });

  ipcMain.handle('upload:selectFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
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
  
  UploadService.on('queue-updated', (q) => {
    if (mainWindow) mainWindow.webContents.send('upload:queue-updated', q);
  });
  // --- Download Queue Manager IPC Handlers ---
  ipcMain.handle('downloads:add', (_, request) => downloadService.add(request));
  ipcMain.handle('downloads:start', () => downloadService.start());
  ipcMain.handle('downloads:pause', () => downloadService.pause());
  ipcMain.handle('downloads:cancel', (_, id) => downloadService.cancel(id));
  ipcMain.handle('downloads:retry', (_, id) => downloadService.retry(id));
  ipcMain.handle('downloads:remove', (_, id) => downloadService.remove(id));
  ipcMain.handle('downloads:reorder', (_, id, direction) => downloadService.reorder(id, direction));
  ipcMain.handle('downloads:clearCompleted', () => downloadService.clearCompleted());
  ipcMain.handle('downloads:clearAll', () => downloadService.clearAll());
  ipcMain.handle('downloads:toggleFormat', (_, id, format) => downloadService.toggleFormat(id, format));
  ipcMain.handle('downloads:updateQuality', (_, id, quality) => downloadService.updateQuality(id, quality));
  ipcMain.handle('downloads:getQueue', () => downloadService.getQueue());

  ipcMain.handle('download:cancel', () => downloadService.pause());
  ipcMain.handle('download:getQueue', () => downloadService.getQueue());
  ipcMain.handle('download:clearQueue', () => downloadService.clearCompleted());
  ipcMain.handle('download:removeJob', (_, id) => downloadService.remove(id));
  ipcMain.handle('converter:addFiles', (_, files) => converterService.addFiles(files));
  ipcMain.handle('devices:get-all', async (_, force = false) => {
        if (force) {
            await deviceDiscoveryService.forceRescan();
        }
        const mtpDevices = await MtpService.getDevices();
        const usbDevices = await UsbService.getDevices();
        const bdsmDevices = deviceDiscoveryService.getDevices();
        
        return [
            ...mtpDevices.map(d => ({ ...d, type: 'MTP', isBdsm: false })),
            ...usbDevices.map(d => ({ ...d, type: 'USB', isBdsm: false })),
            ...bdsmDevices.map(d => ({ ...d, type: 'BDSM', isBdsm: true }))
        ];
    });
      ipcMain.handle('usb:list-folder', (_, basePath, pathArray) => UsbService.listFolder(basePath, pathArray));
    ipcMain.handle('usb:import-items', (_, basePath, pathArray, itemNames, destFolder) => UsbService.importItems(basePath, pathArray, itemNames, destFolder));

    UsbService.on('progress', (data) => {
      if (mainWindow) mainWindow.webContents.send('mtp:import-progress', data); // Reusing the same event name for simplicity in frontend
    });
  ipcMain.handle('mtp:import-items', (_, deviceName, pathArray, itemNames, destFolder) => MtpService.importMtpItems(deviceName, pathArray, itemNames, destFolder));
  ipcMain.handle('mtp:list-folder', (_, deviceName, pathArray) => MtpService.listMtpFolder(deviceName, pathArray));

    MtpService.on('progress', (data) => {
      if (mainWindow) mainWindow.webContents.send('mtp:import-progress', data);
    });
  ipcMain.handle('converter:start', (_, config) => converterService.start(config));
  ipcMain.handle('converter:cancel', () => converterService.cancelCurrent());
  
  ipcMain.handle('converter:clearQueue', async () => {
    return converterService.clearQueue();
  });
  ipcMain.handle('converter:removeFile', (_, index) => converterService.removeFile(index));
  
  ipcMain.handle('converter:listQueue', () => converterService.getQueue());
  ipcMain.handle('history:list', () => historyService.listDownloads());
  ipcMain.handle('history:clear', () => historyService.clearDownloads());
  ipcMain.handle('conversions:list', () => historyService.listConversions());
  ipcMain.handle('conversions:clear', () => historyService.clearConversions());
  ipcMain.handle('updates:check', () => updateService.checkAll());
  ipcMain.handle('updates:updateTool', (_, tool) => updateService.updateTool(tool));

  ipcMain.handle('updates:updateAll', async () => {
    const tools = ['yt-dlp', 'ffmpeg', 'ffprobe', 'spotdl'];
    for (const tool of tools) {
      try {
        await updateService.updateTool(tool);
      } catch (e) {
        logger.error(`Erro ao atualizar ${tool} silenciosamente`, { error: e.message });
      }
    }
    return true;
  });

  // --- Sony Camera a6000 Handlers ---
  ipcMain.handle('sony-camera:discover', (_, timeoutMs) => sonyCameraService.discover(timeoutMs));
  ipcMain.handle('sony-camera:get-status', () => sonyCameraService.getStatus());
  ipcMain.handle('sony-camera:take-photo', () => sonyCameraService.takePicture());
  ipcMain.handle('sony-camera:start-liveview', () => sonyCameraService.startLiveview());
  ipcMain.handle('sony-camera:stop-liveview', () => sonyCameraService.stopLiveview());
  ipcMain.handle('sony-camera:download', (_, fileUrl, destPath) => sonyCameraService.downloadMedia(fileUrl, destPath));
  ipcMain.handle('sony-camera:disconnect', () => sonyCameraService.disconnect());

  sonyCameraService.on('connected', (data) => {
    if (mainWindow) mainWindow.webContents.send('sony-camera:connected', data);
  });
  sonyCameraService.on('disconnected', () => {
    if (mainWindow) mainWindow.webContents.send('sony-camera:disconnected');
  });
  sonyCameraService.on('photo-taken', (data) => {
    if (mainWindow) mainWindow.webContents.send('sony-camera:photo-taken', data);
  });
  sonyCameraService.on('status-update', (data) => {
    if (mainWindow) mainWindow.webContents.send('sony-camera:status-update', data);
  });
  sonyCameraService.on('download-progress', (data) => {
    if (mainWindow) mainWindow.webContents.send('sony-camera:download-progress', data);
  });
}