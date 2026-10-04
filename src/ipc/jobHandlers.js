'use strict';

const { handle } = require('./channelRegistry');
const { jobManager } = require('../core/jobs/JobManager');

/**
 * Registra os handlers IPC do JobManager.
 */
module.exports = function registerJobHandlers() {
  handle('jobs:getStatus', () => {
    return jobManager.getStatus();
  });

  handle('jobs:cancel', (_, jobId) => {
    return jobManager.cancel(jobId);
  });

  handle('jobs:cancelAll', () => {
    jobManager.cancelAll();
    return true;
  });

  handle('jobs:getHistory', () => {
    return jobManager.listHistory();
  });

  handle('jobs:clearHistory', () => {
    jobManager.clearHistory();
    return true;
  });

  handle('jobs:pause', () => {
    jobManager.pause();
    return true;
  });

  handle('jobs:resume', () => {
    jobManager.resume();
    return true;
  });
};
