'use strict';

const { handle } = require('./channelRegistry');

/**
 * Ferramentas de mídia em fila: Conversor, Montagem, Remoção de silêncio e Metadados.
 * `deps` = { converterService, montageService, silenceService, metadataService }.
 */
module.exports = function registerMediaToolsHandlers({ converterService, montageService, silenceService, metadataService }) {
  // Converter
  handle('converter:addFiles', (_, files) => converterService.addFiles(files));
  handle('converter:start', (_, config) => converterService.start(config));
  handle('converter:cancel', () => converterService.cancelCurrent());
  handle('converter:clearQueue', () => converterService.clearQueue());
  handle('converter:removeFile', (_, index) => converterService.removeFile(index));
  handle('converter:listQueue', () => converterService.getQueue());

  // Montage
  handle('montage:probe', (_, filePath) => montageService.probeFile(filePath));
  handle('montage:enqueue', (_, config) => montageService.enqueueMontage(config));
  handle('montage:cancelJob', (_, id) => montageService.cancelJob(id));
  handle('montage:removeJob', (_, id) => montageService.removeJob(id));
  handle('montage:clearQueue', () => montageService.clearQueue());
  handle('montage:getQueue', () => montageService.getQueue());

  // Silence
  handle('silence:probe', (_, filePath) => silenceService.probeFile(filePath));
  handle('silence:analyze', (_, config) => silenceService.analyzeSilence(config.filePath, config.threshold, config.minDuration));
  handle('silence:process', (_, config) => silenceService.processQueue(config));
  handle('silence:cancel', () => silenceService.cancel());

  // Metadata
  handle('metadata:probe', (_, filePath) => metadataService.probeFile(filePath));
  handle('metadata:extractThumb', (_, filePath) => metadataService.extractThumbnail(filePath));
  handle('metadata:save', (_, config) => metadataService.saveMetadata(config));
  handle('metadata:cancel', () => metadataService.cancel());
};
