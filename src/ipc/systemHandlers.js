const { ipcMain, app } = require('electron');
const { appPaths } = require('../infrastructure/filesystem/AppPaths');

module.exports = function registerSystemHandlers(paths) {
  ipcMain.handle('system:exportCookies', async (event, domain, outputPath) => {
    const CookiesService = require('../core/CookiesService');
    return await CookiesService.exportNetscapeCookies(domain, outputPath);
  });

  ipcMain.handle('system:openPath', async (_, itemPath) => {
    require('electron').shell.openPath(itemPath);
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

  ipcMain.handle('system:getCacheInfo', () => {
    const CacheService = require('../core/CacheService');
    const SettingsClass = require('../core/settings/SettingsManager');
    const settings = new SettingsClass(appPaths.configDir, appPaths.dataDir).load();
    const svc = new CacheService(appPaths, {
      maxSizeMB: settings.cacheMaxSizeMB || 500,
      autoClean: !!settings.cacheAutoClean,
    });
    return svc.getCacheInfo();
  });

  ipcMain.handle('system:clearCache', (_, categoryKey) => {
    const CacheService = require('../core/CacheService');
    const SettingsClass = require('../core/settings/SettingsManager');
    const settings = new SettingsClass(appPaths.configDir, appPaths.dataDir).load();
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

  ipcMain.handle('system:getStorageInfo', async () => {
    const fs = require('fs/promises');
    try {
      const rootsToCheck = process.platform === 'win32'
        ? [appPaths.systemRoot, 'D:\\']
        : [appPaths.systemRoot];

      const statsList = await Promise.all(
        rootsToCheck.map(root => fs.statfs(root).catch(() => null))
      );

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
        const MtpService = require('../core/MtpService');
        const UsbService = require('../core/UsbService');
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
};
