const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('remote-debugging-port', '8315');

const isPackaged = app.isPackaged;
const appRoot = isPackaged ? process.resourcesPath : __dirname;
const writableRoot = isPackaged ? app.getPath('userData') : __dirname;
const paths = {
  appRoot,
  dataDir: path.join(appRoot, 'data'),
  configDir: path.join(writableRoot, 'config'),
  databaseDir: path.join(writableRoot, 'database'),
  logsDir: path.join(writableRoot, 'logs'),
  lutsDir: path.join(appRoot, 'data', 'LUTs')
};
process.env.BMD_LOGS_DIR = paths.logsDir;

const DownloadService = require('./services/downloadService');
const HistoryService = require('./services/historyService');
const ThumbnailService = require('./services/thumbnailService');
const ConverterService = require('./services/converterService');
const UpdateService = require('./services/updateService');
const logger = require('./services/logService');
const MtpService = require('./src/core/MtpService');
  const UsbService = require('./src/core/UsbService');

for (const dir of Object.values(paths)) {
  fs.mkdirSync(dir, { recursive: true });
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
  useYoutubeAccount: false
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
  downloadService = new DownloadService({ paths, getSettings: loadSettings, historyService });
  converterService = new ConverterService({ paths, getSettings: loadSettings, historyService});
  thumbnailService = new ThumbnailService({ paths, getSettings: loadSettings });
  updateService = new UpdateService({ paths });
  const MontageService = require('./services/montageService');
  const montageService = new MontageService({ paths });
  const SilenceService = require('./services/silenceService');
  const silenceService = new SilenceService({ paths });
  const MetadataService = require('./services/metadataService');
  const metadataService = new MetadataService({ paths });

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

    const importQueue = new ImportQueue({ ffprobePath, ffmpegPath, thumbnailsDir });
    watcherService = new LibraryWatcherService(importQueue);
    
    // Inicia o monitoramento automático das pastas
    watcherService.startAll();

    // FTP Server for Sony a6000
    const ftpService = require('./src/services/ftpService');
    const ftpRoot = settings.deviceFolder 
      ? path.join(settings.deviceFolder, 'Transferencias Wi-Fi (FTP)') 
      : path.join(paths.dataDir, 'Transferencias Wi-Fi (FTP)');
    ftpService.start(ftpRoot);

    // IPC Handlers para Biblioteca (Fase 1.3)
    const LibraryQueryService = require('./src/core/library/LibraryQueryService');
    
    ipcMain.handle('library:getStats', () => {
      return LibraryQueryService.getStats();
    });

    ipcMain.handle('library:getThumbDir', () => {
      return path.join(paths.dataDir, 'Thumbnails');
    });

    ipcMain.handle('library:search', (event, options) => {
      return LibraryQueryService.searchMedia(options);
    });
    
    ipcMain.handle('library:getRecent', (event, limit) => {
      return LibraryQueryService.getRecentMedia(limit);
    });

    ipcMain.handle('library:getFilterOptions', () => {
      return LibraryQueryService.getFilterOptions();
    });

    ipcMain.handle('library:addCustomSource', async (event, { name, folderPath }) => {
      const dbManager = require('./src/core/database/database');
      const MediaImporter = require('./src/core/media/MediaImporter');
      const EventBus = require('./src/core/EventBus');
      const db = dbManager.get();

      if (!name || !folderPath) {
        throw new Error('Nome da fonte e caminho da pasta são obrigatórios.');
      }

      let lib = db.prepare('SELECT * FROM libraries WHERE path = ? OR name = ?').get(folderPath, name);
      if (!lib) {
        const info = db.prepare('INSERT INTO libraries (name, type, path) VALUES (?, ?, ?)').run(name, name, folderPath);
        lib = { id: info.lastInsertRowid, name, type: name, path: folderPath };
      }

      const importer = new MediaImporter({ ffprobePath: path.join(paths.dataDir, 'ffprobe.exe') });
      await importer.importLibrary(lib);

      EventBus.emit('MEDIA_IMPORTED', { source: name });
      return { ok: true, sourceName: lib.name, origin: lib.type };
    });

    ipcMain.handle('library:getCustomSources', () => {
      const dbManager = require('./src/core/database/database');
      const db = dbManager.get();
      const defaultTypes = ['OBS', 'SHADOWPLAY', 'BDSM_DEVICE', 'OBS Studio', 'NVIDIA ShadowPlay', 'NVIDIA Shadowplay', 'BDSM Devices'];
      const libraries = db.prepare('SELECT id, name, type, path FROM libraries').all();
      return libraries.filter(l => !defaultTypes.includes(l.name) && !defaultTypes.includes(l.type));
    });

    ipcMain.handle('library:updateCustomSourcePath', async (event, { id, name, newFolderPath }) => {
      const dbManager = require('./src/core/database/database');
      const MediaImporter = require('./src/core/media/MediaImporter');
      const EventBus = require('./src/core/EventBus');
      const db = dbManager.get();

      if (!newFolderPath) throw new Error('Caminho da pasta é obrigatório.');

      db.prepare('UPDATE libraries SET path = ? WHERE id = ? OR name = ?').run(newFolderPath, id, name);

      let lib = db.prepare('SELECT * FROM libraries WHERE id = ? OR name = ?').get(id, name);
      if (lib) {
        const importer = new MediaImporter({ ffprobePath: path.join(paths.dataDir, 'ffprobe.exe') });
        await importer.importLibrary(lib);
      }

      EventBus.emit('MEDIA_IMPORTED', { action: 'update_source', name });
      return { ok: true };
    });

    ipcMain.handle('library:removeCustomSource', (event, { id, name }) => {
      const dbManager = require('./src/core/database/database');
      const EventBus = require('./src/core/EventBus');
      const db = dbManager.get();
      
      db.prepare('DELETE FROM media WHERE origin = ? OR library_id = ?').run(name, id);
      db.prepare('DELETE FROM libraries WHERE id = ? OR name = ?').run(id, name);

      EventBus.emit('MEDIA_IMPORTED', { action: 'delete_source', name });
      return { ok: true };
    });

    ipcMain.handle('library:renameMedia', (event, id, newName) => {
      const dbManager = require('./src/core/database/database');
      const db = dbManager.get();
      db.prepare('UPDATE media SET filename = ? WHERE id = ?').run(newName, id);
      return true;
    });

    ipcMain.handle('library:toggleFavorite', (event, id, isFav) => {
      const dbManager = require('./src/core/database/database');
      const db = dbManager.get();
      db.prepare('UPDATE media SET favorite = ? WHERE id = ?').run(isFav ? 1 : 0, id);
      return true;
    });

    ipcMain.handle('library:getMediaTags', (event, id) => {
      const dbManager = require('./src/core/database/database');
      const db = dbManager.get();
      return db.prepare(`
        SELECT t.* FROM tags t
        JOIN media_tags mt ON mt.tag_id = t.id
        WHERE mt.media_id = ?
      `).all(id);
    });

    ipcMain.handle('library:addMediaTag', (event, mediaId, tagName) => {
      const dbManager = require('./src/core/database/database');
      const db = dbManager.get();
      const normalizedName = tagName.toLowerCase();
      
      let tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(normalizedName);
      if (!tag) {
        const info = db.prepare('INSERT INTO tags (name) VALUES (?)').run(normalizedName);
        tag = { id: info.lastInsertRowid };
      }
      
      try {
        db.prepare('INSERT INTO media_tags (media_id, tag_id) VALUES (?, ?)').run(mediaId, tag.id);
      } catch (e) {
        // Ignora erro se a tag já estiver associada
      }
      return true;
    });

    ipcMain.handle('library:removeMediaTag', (event, mediaId, tagId) => {
      const dbManager = require('./src/core/database/database');
      const db = dbManager.get();
      db.prepare('DELETE FROM media_tags WHERE media_id = ? AND tag_id = ?').run(mediaId, tagId);
      return true;
    });

    ipcMain.handle('library:deleteMediaBulk', (event, ids) => {
      const dbManager = require('./src/core/database/database');
      const db = dbManager.get();
      if (!ids || ids.length === 0) return true;
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT filepath FROM media WHERE id IN (${placeholders})`).all(...ids);
      rows.forEach(r => {
         try { if (fs.existsSync(r.filepath)) fs.unlinkSync(r.filepath); } catch(e) {}
      });
      db.prepare(`DELETE FROM media WHERE id IN (${placeholders})`).run(...ids);
      return true;
    });

    ipcMain.handle('library:toggleFavoriteBulk', (event, ids, isFav) => {
      const dbManager = require('./src/core/database/database');
      const db = dbManager.get();
      if (!ids || ids.length === 0) return true;
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`UPDATE media SET favorite = ? WHERE id IN (${placeholders})`).run(isFav ? 1 : 0, ...ids);
      return true;
    });

    ipcMain.handle('library:setProjectBulk', (event, ids, projectId) => {
      const dbManager = require('./src/core/database/database');
      const db = dbManager.get();
      if (!ids || ids.length === 0) return true;
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`UPDATE media SET project_id = ? WHERE id IN (${placeholders})`).run(projectId, ...ids);
      return true;
    });

    ipcMain.handle('library:addMediaTagBulk', (event, ids, tagName) => {
      const dbManager = require('./src/core/database/database');
      const db = dbManager.get();
      if (!ids || ids.length === 0 || !tagName) return true;
      
      let tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
      if (!tag) {
          const res = db.prepare('INSERT INTO tags (name, type) VALUES (?, "custom")').run(tagName);
          tag = { id: res.lastInsertRowid };
      }
      const insert = db.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?, ?)');
      db.transaction(() => {
          for (const id of ids) {
              insert.run(id, tag.id);
          }
      })();
      return true;
    });

    ipcMain.handle('library:renameMediaBulk', (event, ids, baseName) => {
      const dbManager = require('./src/core/database/database');
      const db = dbManager.get();
      if (!ids || ids.length === 0 || !baseName) return true;
      
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT id, filepath, filename FROM media WHERE id IN (${placeholders}) ORDER BY COALESCE(recorded_at, imported_at) ASC`).all(...ids);
      
      let counter = 1;
      db.transaction(() => {
         const update = db.prepare(`UPDATE media SET filename = ?, filepath = ? WHERE id = ?`);
         for (const row of rows) {
             const ext = require('path').extname(row.filename);
             let newFilename = ids.length === 1 ? `${baseName}${ext}` : `${baseName} - ${counter}${ext}`;
             const dir = require('path').dirname(row.filepath);
             const newFilepath = require('path').join(dir, newFilename);
             try {
                if (require('fs').existsSync(row.filepath)) {
                   require('fs').renameSync(row.filepath, newFilepath);
                }
                update.run(newFilename, newFilepath, row.id);
             } catch(e) { console.error('Rename err:', e) }
             counter++;
         }
      })();
      return true;
    });

    ipcMain.handle('library:moveMediaBulk', async (event, ids, newDir) => {
      const dbManager = require('./src/core/database/database');
      const db = dbManager.get();
      if (!ids || ids.length === 0 || !newDir) return true;
      
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT id, filepath, filename FROM media WHERE id IN (${placeholders})`).all(...ids);
      
      db.transaction(() => {
         const update = db.prepare(`UPDATE media SET filepath = ? WHERE id = ?`);
         for (const row of rows) {
             const newFilepath = require('path').join(newDir, row.filename);
             try {
                if (require('fs').existsSync(row.filepath)) {
                   require('fs').copyFileSync(row.filepath, newFilepath);
                   require('fs').unlinkSync(row.filepath);
                }
                update.run(newFilepath, row.id);
             } catch(e) { console.error('Move err:', e) }
         }
      })();
      return true;
    });

    ipcMain.handle('system:exportCookies', async (event, domain, outputPath) => {
      const CookiesService = require('./src/core/CookiesService');
      return await CookiesService.exportNetscapeCookies(domain, outputPath);
    });

    ipcMain.handle('youtube:login', async () => {
      const authWin = new BrowserWindow({
        width: 1024,
        height: 768,
        show: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: 'persist:youtube'
        }
      });
      authWin.setMenuBarVisibility(false);
      await authWin.loadURL('https://studio.youtube.com');
      
      return new Promise((resolve) => {
        authWin.on('closed', () => {
          resolve(true); // Retorna quando o usuário fechar a janela de login
        });
      });
    });

    ipcMain.handle('youtube:upload', async (event, { filePath, title, description, isPublic }) => {
      const YouTubeBot = require('./src/core/youtube/YouTubeBot');
      try {
        await YouTubeBot.uploadVideo(filePath, title, description, isPublic);
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('system:openPath', async (_, itemPath) => { require('electron').shell.openPath(itemPath); });
    ipcMain.handle('system:getStorageInfo', async () => {
      const fs = require('fs/promises');
      try {
        const [statsC, statsD] = await Promise.all([
          fs.statfs('C:\\').catch(() => null),
          fs.statfs('D:\\').catch(() => null)
        ]);

        let totalPC = 0;
        let freePC = 0;
        if (statsC) {
          totalPC += statsC.blocks * statsC.bsize;
          freePC += statsC.bavail * statsC.bsize;
        }
        if (statsD) {
          totalPC += statsD.blocks * statsD.bsize;
          freePC += statsD.bavail * statsD.bsize;
        }

        const usedPC = totalPC - freePC;
        const percentPC = totalPC > 0 ? Math.round((usedPC / totalPC) * 100) : 0;
        const formatBytes = (bytes) => {
          const gb = bytes / (1024 ** 3);
          if (gb >= 1000) {
            return (gb / 1024).toFixed(2) + ' TB';
          }
          return gb.toFixed(1) + ' GB';
        };
        
        let device = null;
        try {
          const MtpService = require('./src/core/MtpService');
          const UsbService = require('./src/core/UsbService');
          const mtpDevs = await MtpService.getDevices();
          const usbDevs = await UsbService.getDevices();
          const devs = [...mtpDevs, ...usbDevs];
          if (devs.length > 0) {
             const d = devs[0];
             let cap = 0, free = 0;
             if (d.type === 'usb' && d.storage && d.storage.length) {
                cap = d.storage[0].capacity;
                free = d.storage[0].free;
             } else if ((d.type === 'mtp' || !d.type) && d.Storages && d.Storages.length) {
                cap = d.Storages[0].TotalSize;
                free = d.Storages[0].FreeSpace;
             }
             const used = cap - free;
             const percent = cap > 0 ? Math.round((used / cap) * 100) : 0;
             
             let dName = d.name || d.Name || 'MTP Device';
             device = {
               name: dName,
               total: formatBytes(cap),
               free: formatBytes(free),
               used: formatBytes(used),
               percent: percent
             };
          }
        } catch (e) {
          console.error('Error fetching devices for sidebar', e);
        }

        return {
          pc: {
            total: formatBytes(totalPC),
            free: formatBytes(freePC),
            used: formatBytes(usedPC),
            percent: percentPC
          },
          device: device
        };
      } catch (e) {
        console.error('Storage info error:', e);
        return null;
      }
    });

    ipcMain.handle('library:clearDatabase', () => {
      const dbManager = require('./src/core/database/database');
      const db = dbManager.get();
      // Remove tudo das tabelas
      db.exec('DELETE FROM media_tags; DELETE FROM media; VACUUM;');
      return true;
    });

    ipcMain.handle('library:rescanAll', () => {
      if (watcherService) {
        watcherService.stopAll();
        setTimeout(() => watcherService.startAll(), 500);
      }
      return true;
    });


    // Eventos do backend para o Frontend (Reactivo)
    EventBus.on('MEDIA_IMPORTED', (media) => mainWindow?.webContents.send('bds:media-imported', media));
    EventBus.on('MEDIA_REMOVED', (payload) => mainWindow?.webContents.send('bds:media-removed', payload));
    EventBus.on('MEDIA_UPDATED', (payload) => mainWindow?.webContents.send('bds:media-updated', payload));
  } catch (error) {
    logger.error('Falha ao inicializar a Media Library', { error: error.message });
  }
  // ---------------------------------------------

  // Eventos de Download
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
  ipcMain.handle('download:start', (_, request) => downloadService.startDownload(request));
  ipcMain.handle('download:cancel', () => downloadService.cancelDownload('Cancelado pelo usuário'));
  ipcMain.handle('converter:addFiles', (_, files) => converterService.addFiles(files));
  ipcMain.handle('devices:get-all', async () => {
      const mtpDevices = await MtpService.getDevices();
      const usbDevices = await UsbService.getDevices();
      return [...mtpDevices, ...usbDevices];
    });
      ipcMain.handle('usb:list-folder', (_, basePath, pathArray) => UsbService.listFolder(basePath, pathArray));
    ipcMain.handle('usb:import-items', (_, basePath, pathArray, itemNames, destFolder) => UsbService.importItems(basePath, pathArray, itemNames, destFolder));

    UsbService.on('progress', (data) => {
      if (mainWindow) mainWindow.webContents.send('mtp:import-progress', data); // Reusing the same event name for simplicity in frontend
    });
    ipcMain.handle('mtp:list-folder', (_, deviceName, pathArray) => MtpService.listMtpFolder(deviceName, pathArray));
  ipcMain.handle('mtp:import-items', (_, deviceName, pathArray, itemNames, destFolder) => MtpService.importMtpItems(deviceName, pathArray, itemNames, destFolder));

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
}
