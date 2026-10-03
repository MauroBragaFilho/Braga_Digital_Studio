const { ipcMain, app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { appPaths } = require('../infrastructure/filesystem/AppPaths');
const { assertAbsolutePath, assertSafePath, assertExternalUrl } = require('./validate');
const { cachedAsync } = require('../infrastructure/hardware/cachedAsync');

// Extensões que podem ser abertas com o aplicativo padrão do sistema (mídia, legendas e documentos simples).
// Qualquer outra (.exe, .bat, .cmd, .com, .msi, .scr, .ps1, .vbs, .js, .lnk, .hta, .jar...) é recusada.
const OPENABLE_EXTS = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.mts', '.m2ts', '.m4v', '.mpg', '.mpeg', '.3gp', '.ts', '.vob',
  '.mp3', '.wav', '.aac', '.flac', '.ogg', '.opus', '.m4a', '.wma', '.alac', '.aiff', '.ac3', '.dts',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.heic', '.svg',
  '.arw', '.cr2', '.cr3', '.nef', '.dng', '.raf', '.rw2', '.orf',
  '.srt', '.vtt', '.ass', '.txt', '.md', '.json', '.csv', '.pdf', '.cube', '.bdspro'
]);

/**
 * Valida um caminho a abrir com shell.openPath: string absoluta existente que seja
 * diretório ou arquivo de extensão segura. Lança em caso contrário.
 */
function assertOpenablePath(itemPath) {
  const resolved = assertAbsolutePath(itemPath, 'Caminho');
  let st;
  try { st = fs.statSync(resolved); } catch (_) { throw new Error('Caminho não encontrado.'); }
  if (st.isDirectory()) return resolved;
  const ext = path.extname(resolved).toLowerCase();
  if (!OPENABLE_EXTS.has(ext)) {
    throw new Error(`Tipo de arquivo não permitido para abertura: '${ext || '(sem extensão)'}'.`);
  }
  return resolved;
}

module.exports = function registerSystemHandlers(paths, settingsManager) {
  const getSettings = () => {
    if (settingsManager && typeof settingsManager.load === 'function') return settingsManager.load();
    const SettingsClass = require('../core/settings/SettingsManager');
    return new SettingsClass(appPaths.configDir, appPaths.dataDir).load();
  };

  ipcMain.handle('system:exportCookies', async (event, domain, outputPath) => {
    const CookiesService = require('../core/CookiesService');
    if (typeof domain !== 'string' || !/^\.?[a-z0-9.-]{1,253}$/i.test(domain)) {
      throw new Error('Domínio inválido.');
    }
    // Cookies são sensíveis: só podem ser gravados dentro da pasta de dados do app.
    const baseDir = (paths && paths.dataDir) || appPaths.dataDir;
    const safeOut = assertSafePath(baseDir, outputPath);
    return await CookiesService.exportNetscapeCookies(domain, safeOut);
  });

  ipcMain.handle('system:openPath', async (_, itemPath) => {
    // Falhas viram { success:false, error } (o renderer legado não espera rejeição neste canal).
    try {
      const safe = assertOpenablePath(itemPath);
      const errorMessage = await shell.openPath(safe);
      if (errorMessage) return { success: false, error: errorMessage };
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Abre links externos no navegador padrão (preload não pode usar `shell` com sandbox).
  ipcMain.handle('shell:openExternal', async (_, url) => {
    const safeUrl = assertExternalUrl(url);
    await shell.openExternal(safeUrl);
    return true;
  });

  ipcMain.handle('system:isPackaged', () => {
    return app.isPackaged;
  });

  ipcMain.handle('system:getToolsPath', () => {
    const toolsDir = (paths && paths.dataDir) ? paths.dataDir : (appPaths.dataDir || null);
    return toolsDir || null;
  });

  ipcMain.handle('system:getVideosPath', () => {
    return appPaths.videosDir;
  });

  ipcMain.handle('system:getDownloadsPath', () => {
    return appPaths.downloadsDir;
  });

  ipcMain.handle('system:getCacheInfo', async () => {
    const CacheService = require('../core/CacheService');
    const settings = getSettings();
    const svc = new CacheService(appPaths, {
      maxSizeMB: settings.cacheMaxSizeMB || 500,
      autoClean: !!settings.cacheAutoClean,
    });
    // Versão assíncrona: varrer thumbnails/waveforms de forma síncrona travaria o processo principal.
    return svc.getCacheInfoAsync();
  });

  ipcMain.handle('system:clearCache', (_, categoryKey) => {
    const CacheService = require('../core/CacheService');
    const settings = getSettings();
    const svc = new CacheService(appPaths, {
      maxSizeMB: settings.cacheMaxSizeMB || 500,
      autoClean: !!settings.cacheAutoClean,
    });
    const result = svc.clearCache(categoryKey || null);

    // [FIX] Após limpar thumbnails, regenera em background IMEDIATAMENTE (sem reiniciar).
    // Antes, a biblioteca ficava preta até o próximo startup — e o regen de startup
    // podia nem rodar se o app fosse fechado cedo. Usa a mesma lógica compartilhada
    // com bootstrap.js/libraryHandlers.js, com progresso incremental na biblioteca.
    const thumbCleared = Array.isArray(result.cleared) &&
      result.cleared.some(c => c.key === 'thumbnails' && c.filesRemoved > 0);
    if (thumbCleared) {
      const { BrowserWindow } = require('electron');
      const { regenerateMissingThumbnails: regenerate } = require('../core/library/ThumbnailRegenService');
      regenerate({
        paths: appPaths,
        dbManager: require('../core/database/database'),
        window: BrowserWindow.getAllWindows()[0] || null,
        batchSize: 8, // [PERF] paralelismo maior = regen mais rápido pós clearCache
        logPrefix: '[RegenThumbs]',
      }).catch((err) => {
        console.error('Erro ao regenerar thumbnails após clearCache:', err);
      });
    }

    return result;
  });

  // Armazenamento da sidebar: cache de 20 s com deduplicação de chamadas concorrentes (a sidebar
  // consulta com frequência e cada enumeração de dispositivos MTP/USB custa um PowerShell).
  const computeStorageInfo = async () => {
    const fs = require('fs/promises');
    try {
      const rootsToCheck = process.platform === 'win32'
        ? [appPaths.systemRoot, 'D:\\']
        : [appPaths.systemRoot];

      // Disco do PC e provedores MTP/USB em paralelo (antes eram sequenciais).
      const { deviceManager } = require('../infrastructure/hardware/DeviceManager');
      const [statsList, mtpDevs, usbDevs] = await Promise.all([
        Promise.all(rootsToCheck.map(root => fs.statfs(root).catch(() => null))),
        deviceManager.getMtpDevices().catch((e) => { console.error('Error fetching MTP devices for sidebar', e); return []; }),
        deviceManager.getStorageDevices().catch((e) => { console.error('Error fetching USB devices for sidebar', e); return []; })
      ]);

      let totalPC = 0;
      let freePC = 0;
      for (const stats of statsList) {
        if (stats) {
          totalPC += stats.blocks * stats.bsize;
          freePC += stats.bavail * stats.bsize;
        }
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
  };
  const storageInfoCache = cachedAsync(computeStorageInfo, 20000);
  ipcMain.handle('system:getStorageInfo', () => storageInfoCache.get());
};
