'use strict';

const { handle } = require('./channelRegistry');

/** Históricos de downloads e conversões. */
module.exports = function registerHistoryHandlers(historyService) {
  handle('history:list', () => historyService.listDownloads());
  handle('history:clear', () => historyService.clearDownloads());
  handle('conversions:list', () => historyService.listConversions());
  handle('conversions:clear', () => historyService.clearConversions());
};
