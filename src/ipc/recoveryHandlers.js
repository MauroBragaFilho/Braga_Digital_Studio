'use strict';

const { ipcMain, dialog, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

module.exports = function registerRecoveryHandlers(videoRecoveryService, paths) {
  ipcMain.handle('recovery:diagnose', async (_, { corruptPath, referencePath }) => {
    return await videoRecoveryService.diagnose(corruptPath, referencePath);
  });

  ipcMain.handle('recovery:start', async (_, options) => {
    return await videoRecoveryService.recoverVideo(options);
  });

  ipcMain.handle('recovery:cancel', async () => {
    videoRecoveryService.cancel();
    return { success: true };
  });

  ipcMain.handle('logs:export', async () => {
    const logsDir = path.join(process.cwd(), 'logs');
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Selecione a pasta de destino para exportar os logs',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, cancelled: true };
    }

    const destFolder = result.filePaths[0];
    const exportFolder = path.join(destFolder, `bds_logs_${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(exportFolder, { recursive: true });

    if (fs.existsSync(logsDir)) {
      const files = fs.readdirSync(logsDir);
      for (const file of files) {
        const src = path.join(logsDir, file);
        const dst = path.join(exportFolder, file);
        try {
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, dst);
          }
        } catch (_) {}
      }
    }

    return { success: true, exportPath: exportFolder };
  });
};
