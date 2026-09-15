'use strict';

const { ipcMain } = require('electron');
const { assertSafePath, assertNonEmpty } = require('./validate');
const logger = require('../services/logService');

module.exports = function registerPhotoPreviewHandlers(photoPreviewService) {
  ipcMain.handle('photo:getMetadata', async (_, filePath) => {
    try {
      assertNonEmpty(filePath, 'Caminho do arquivo');
      assertSafePath(filePath, filePath);
      return await photoPreviewService.getMetadata(filePath);
    } catch (err) {
      logger.error('[photo:getMetadata] Erro ao obter metadados:', { filePath, error: err.message });
      throw err;
    }
  });

  ipcMain.handle('photo:getRenderablePath', async (_, filePath, options = {}) => {
    try {
      assertNonEmpty(filePath, 'Caminho do arquivo');
      assertSafePath(filePath, filePath);
      return await photoPreviewService.getRenderablePath(filePath, options);
    } catch (err) {
      logger.error('[photo:getRenderablePath] Erro ao obter caminho renderizável:', { filePath, error: err.message });
      throw err;
    }
  });
};
