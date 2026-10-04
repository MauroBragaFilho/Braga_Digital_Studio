'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { dialog, BrowserWindow } = require('electron');
const { handle } = require('./channelRegistry');
const { assertAbsolutePath } = require('./validate');
const { mapLimit } = require('../core/library/reconcile');

/**
 * Varredura de pastas/arquivos de vídeo para a aba Envio.
 * `deps` = { uploadScannerService, settingsManager, getMainWindow }.
 */
module.exports = function registerUploadHandlers({ uploadScannerService, settingsManager, getMainWindow }) {
  handle('upload:scanDirectory', async (_, customDir) => {
    const settings = settingsManager.load();
    // Caminho vindo do renderer precisa ser absoluto; o handler NÃO cria diretórios (só varre o que existe).
    const targetDir = customDir ? assertAbsolutePath(customDir, 'Pasta de uploads')
      : (settings.uploadsFolder || path.join(os.homedir(), 'Videos', 'Uploads'));
    let isDir = false;
    try { isDir = (await fs.promises.stat(targetDir)).isDirectory(); } catch (_) { /* inexistente */ }
    if (!isDir) return [];
    return uploadScannerService.scanDirectory(targetDir);
  });
  handle('upload:selectFolder', async () => {
    const win = getMainWindow() || BrowserWindow.getFocusedWindow();
    const dialogOptions = { properties: ['openDirectory'] };
    const result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    if (!result.canceled && result.filePaths.length > 0) {
      const selectedDir = result.filePaths[0];
      settingsManager.save({ uploadsFolder: selectedDir });
      return uploadScannerService.scanDirectory(selectedDir);
    }
    return null;
  });
  handle('upload:selectFiles', async () => {
    const win = getMainWindow() || BrowserWindow.getFocusedWindow();
    const dialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Vídeos', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }]
    };
    const result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    if (!result.canceled && result.filePaths.length > 0) {
      // ffprobe em paralelo limitado a 3 (antes serial); a ordem da lista é preservada.
      const fileList = await mapLimit(result.filePaths, 3, async (filePath) => {
        const stats = await fs.promises.stat(filePath);
        const meta = await uploadScannerService.getVideoMetadata(filePath);
        return {
          id: Buffer.from(filePath).toString('base64'),
          name: path.basename(filePath),
          path: filePath,
          dir: path.dirname(filePath),
          sizeBytes: stats.size,
          sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime,
          ...meta
        };
      }, 3);
      return fileList;
    }
    return [];
  });
};
