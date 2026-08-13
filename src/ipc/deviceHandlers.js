const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

module.exports = function registerDeviceHandlers(logger, lutSyncService) {
  const BdsmClient = require('../core/devices/BdsmClient');
  
  ipcMain.handle('bdsm:getMedia', async (_, ip, port) => {
      const client = new BdsmClient(ip, port);
      return await client.getMedia();
  });

  ipcMain.handle('bdsm:getImportHistory', async (_, deviceId) => {
      const dbManager = require('../core/database/database');
      const db = dbManager.get();
      const stmt = db.prepare(`SELECT filename FROM sync_history WHERE device_id = ?`);
      const rows = stmt.all(deviceId);
      return rows.map(r => r.filename);
  });

  ipcMain.handle('bdsm:importMedia', async (event, { ip, port, deviceId, items, destFolder, projectId }) => {
      const dbManager = require('../core/database/database');
      const client = new BdsmClient(ip, port);
      const db = dbManager.get();
      let completed = 0;

      for (const item of items) {
          try {
              event.sender.send('bdsm:progress', { completed, total: items.length, current: item.name });
              
              const downloadUrl = client.getMediaDownloadUrl(item.id);
              const response = await fetch(downloadUrl);
              const buffer = await response.arrayBuffer();
              
              const destPath = path.join(destFolder, item.name);
              fs.writeFileSync(destPath, Buffer.from(buffer));
              
              db.prepare(`INSERT INTO sync_history (device_id, filename, hash, project_id) VALUES (?, ?, ?, ?)`).run(deviceId, item.name, item.hash || '', projectId || null);
              
              completed++;
          } catch(e) {
              logger.error(`[BDSM Import] Falha ao importar ${item.name}: ${e.message}`);
          }
      }
      return completed;
  });

  ipcMain.handle('bdsm:analyzeLutSync', async (_, ip, port) => {
      return await lutSyncService.analyzeSync(ip, port);
  });

  ipcMain.handle('bdsm:executeLutSync', async (event, { ip, port, plan }) => {
      lutSyncService.removeAllListeners('progress');
      lutSyncService.removeAllListeners('done');

      lutSyncService.on('progress', (data) => {
          event.sender.send('bdsm:lutSyncProgress', data);
      });
      
      await lutSyncService.executeSync(ip, port, plan);
      return true;
  });
};
