'use strict';

const { ipcMain } = require('electron');
const { jobManager } = require('../core/jobs/JobManager');

/**
 * Registra os handlers IPC do JobManager.
 */
module.exports = function registerJobHandlers() {
  ipcMain.handle('jobs:getStatus', () => {
    return jobManager.getStatus();
  });

  ipcMain.handle('jobs:cancel', (_, jobId) => {
    return jobManager.cancel(jobId);
  });

  ipcMain.handle('jobs:cancelAll', () => {
    jobManager.cancelAll();
    return true;
  });

  ipcMain.handle('jobs:getHistory', () => {
    return jobManager.listHistory();
  });

  ipcMain.handle('jobs:clearHistory', () => {
    jobManager.clearHistory();
    return true;
  });

  ipcMain.handle('jobs:pause', () => {
    jobManager.pause();
    return true;
  });

  ipcMain.handle('jobs:resume', () => {
    jobManager.resume();
    return true;
  });
};
