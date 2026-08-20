const { ipcMain } = require('electron');
const { appPaths } = require('../infrastructure/filesystem/AppPaths');

module.exports = function registerSystemHandlers(paths) {
  ipcMain.handle('system:exportCookies', async (event, domain, outputPath) => {
    const CookiesService = require('../core/CookiesService');
    return await CookiesService.exportNetscapeCookies(domain, outputPath);
  });

  ipcMain.handle('system:openPath', async (_, itemPath) => {
    require('electron').shell.openPath(itemPath);
  });

  ipcMain.handle('system:getVideosPath', () => {
    return appPaths.videosDir;
  });

  ipcMain.handle('system:getDownloadsPath', () => {
    return appPaths.downloadsDir;
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
