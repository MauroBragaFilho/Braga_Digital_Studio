'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dialog, shell, BrowserWindow } = require('electron');
const { handle } = require('./channelRegistry');
const { PathGuard } = require('../infrastructure/filesystem/PathGuard');
const CubeParser = require('../core/luts/CubeParser');
const logger = require('../services/logService');

const RAW_CONTENT_MAX_BYTES = 2 * 1024 * 1024; // 2MB

// Os canais luts:parse/load/getHeader/reveal só leem LUTs: o esquema (t.cube) exige caminho absoluto .cube.

/**
 * Registra todos os handlers IPC do domínio de LUTs (.cube).
 * @param {import('../core/luts/LutManager')} lutManager
 */
module.exports = function registerLutHandlers(lutManager) {
  handle('luts:parse', async (_, filePath) => {
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

  handle('luts:load', async (_, filePath) => {
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

  handle('luts:getHeader', async (_, filePath) => {
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

  handle('luts:get', async () => {
    return lutManager.list();
  });

  // Sem argumento abre o seletor de arquivos; com uma lista de caminhos (arrastar-e-soltar) importa direto.
  // Retorna false se o usuário cancelou, ou { imported, renamed, duplicates, invalid }.
  handle('luts:import', async (_, droppedPaths) => {
    try {
      let filePaths = Array.isArray(droppedPaths) ? droppedPaths.filter((p) => typeof p === 'string') : null;
      if (!filePaths) {
        const win = BrowserWindow.getFocusedWindow();
        const picked = await dialog.showOpenDialog(win, {
          title: 'Importar LUT (.cube)',
          filters: [{ name: 'LUTs', extensions: ['cube'] }],
          properties: ['openFile', 'multiSelections']
        });
        if (picked.canceled || picked.filePaths.length === 0) return false;
        filePaths = picked.filePaths;
      }
      return lutManager.importFiles(filePaths);
    } catch (err) {
      logger.error('IPC:luts:import:error', { error: err.message });
      throw err;
    }
  });

  handle('luts:rename', async (_, oldPath, newName) => {
    try {
      return lutManager.rename(oldPath, newName);
    } catch (err) {
      logger.error('IPC:luts:rename:error', { error: err.message });
      throw err;
    }
  });

  handle('luts:delete', async (_, filePath) => {
    try {
      // Vai para a lixeira do sistema: o usuário pode recuperar se excluir sem querer.
      return await lutManager.delete(filePath, (p) => shell.trashItem(p));
    } catch (err) {
      logger.error('IPC:luts:delete:error', { error: err.message });
      throw err;
    }
  });

  // Imagem de referência escolhida nas Configurações, como data URL (o canvas precisa ler os pixels,
  // o que um <img src="file://..."> bloquearia). Retorna null se não for uma imagem utilizável.
  handle('luts:getReferenceImage', async (_, filePath) => {
    try {
      const mimes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
      const mime = mimes[path.extname(filePath).toLowerCase()];
      if (!mime || !fs.existsSync(filePath)) return null;
      if (fs.statSync(filePath).size > 15 * 1024 * 1024) return null;
      return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
    } catch (err) {
      logger.warn?.('IPC:luts:getReferenceImage:error', { error: err.message });
      return null;
    }
  });

  handle('luts:reveal', async (_, filePath) => {
    try {
      PathGuard.assertWithin(lutManager.lutsDir, filePath);
      shell.showItemInFolder(filePath);
      return true;
    } catch (err) {
      logger.error('IPC:luts:reveal:error', { error: err.message });
      throw err;
    }
  });
};
