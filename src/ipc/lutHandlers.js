'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, dialog, BrowserWindow } = require('electron');
const CubeParser = require('../core/luts/CubeParser');
const logger = require('../services/logService');

const RAW_CONTENT_MAX_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * Registra todos os handlers IPC do domínio de LUTs (.cube).
 * @param {import('../core/luts/LutManager')} lutManager
 */
module.exports = function registerLutHandlers(lutManager) {
  ipcMain.handle('luts:parse', async (_, filePath) => {
    try {
      const parsedLut = CubeParser.parse(filePath);
      return {
        path: filePath,
        name: path.basename(filePath),
        ...parsedLut
      };
    } catch (error) {
      logger.error('IPC:luts:parse:error', { error: error.message });
      throw error;
    }
  });

  ipcMain.handle('luts:load', async (_, filePath) => {
    try {
      const stats = fs.statSync(filePath);

      if (stats.size <= RAW_CONTENT_MAX_BYTES) {
        const content = fs.readFileSync(filePath, 'utf-8');
        return { rawContent: content, truncated: false, totalBytes: stats.size };
      }

      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.alloc(RAW_CONTENT_MAX_BYTES);
        const bytesRead = fs.readSync(fd, buffer, 0, RAW_CONTENT_MAX_BYTES, 0);
        const content = buffer.toString('utf-8', 0, bytesRead);
        return { rawContent: content, truncated: true, totalBytes: stats.size };
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      logger.error('IPC:luts:load:error', { error: error.message });
      throw error;
    }
  });

  ipcMain.handle('luts:getHeader', async (_, filePath) => {
    try {
      const header = CubeParser.parseHeader(filePath);
      return {
        path: filePath,
        name: path.basename(filePath),
        ...header
      };
    } catch (error) {
      logger.error('IPC:luts:getHeader:error', { error: error.message });
      throw error;
    }
  });

  ipcMain.handle('luts:get', async () => {
    return lutManager.list();
  });

  ipcMain.handle('luts:import', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Importar LUT (.cube)',
        filters: [{ name: 'LUTs', extensions: ['cube'] }],
        properties: ['openFile', 'multiSelections']
      });

      if (canceled || filePaths.length === 0) return false;
      return lutManager.importFiles(filePaths);
    } catch (err) {
      logger.error('IPC:luts:import:error', { error: err.message });
      throw err;
    }
  });

  ipcMain.handle('luts:rename', async (_, oldPath, newName) => {
    try {
      return lutManager.rename(oldPath, newName);
    } catch (err) {
      logger.error('IPC:luts:rename:error', { error: err.message });
      throw err;
    }
  });

  ipcMain.handle('luts:delete', async (_, filePath) => {
    try {
      return lutManager.delete(filePath);
    } catch (err) {
      logger.error('IPC:luts:delete:error', { error: err.message });
      throw err;
    }
  });
};
