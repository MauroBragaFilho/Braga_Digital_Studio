'use strict';

const { ipcMain } = require('electron');
const { assertAbsolutePath, assertNonEmpty } = require('./validate');
const logger = require('../services/logService');

module.exports = function registerPhotoPreviewHandlers(photoPreviewService) {
  ipcMain.handle('photo:getMetadata', async (_, filePath) => {
    try {
      assertNonEmpty(filePath, 'Caminho do arquivo');
      // Caminho do usuário (qualquer pasta da biblioteca): exige string absoluta, sem bytes nulos.
      filePath = assertAbsolutePath(filePath, 'Caminho do arquivo');
      return await photoPreviewService.getMetadata(filePath);
    } catch (err) {
      logger.error('[photo:getMetadata] Erro ao obter metadados:', { filePath, error: err.message });
      throw err;
    }
  });

  ipcMain.handle('photo:getRenderablePath', async (_, filePath, options = {}) => {
    try {
      assertNonEmpty(filePath, 'Caminho do arquivo');
      filePath = assertAbsolutePath(filePath, 'Caminho do arquivo');
      const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
      return await photoPreviewService.getRenderablePath(filePath, safeOptions);
    } catch (err) {
      logger.error('[photo:getRenderablePath] Erro ao obter caminho renderizável:', { filePath, error: err.message });
      throw err;
    }
  });
};
