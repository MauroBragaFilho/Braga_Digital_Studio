'use strict';

const { handle } = require('./channelRegistry');
const logger = require('../services/logService');

module.exports = function registerPhotoPreviewHandlers(photoPreviewService) {
  handle('photo:getMetadata', async (_, filePath) => {
    try {
      // Caminho do usuário (qualquer pasta da biblioteca): absoluto e sem bytes nulos (esquema do canal).
      return await photoPreviewService.getMetadata(filePath);
    } catch (err) {
      logger.error('[photo:getMetadata] Erro ao obter metadados:', { filePath, error: err.message });
      throw err;
    }
  });

  handle('photo:getRenderablePath', async (_, filePath, options = {}) => {
    try {
      const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
      return await photoPreviewService.getRenderablePath(filePath, safeOptions);
    } catch (err) {
      logger.error('[photo:getRenderablePath] Erro ao obter caminho renderizável:', { filePath, error: err.message });
      throw err;
    }
  });
};
