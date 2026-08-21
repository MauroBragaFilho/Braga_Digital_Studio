'use strict';

const { ipcMain } = require('electron');
const { errorReporter } = require('../infrastructure/telemetry/ErrorReporter');

/**
 * Registra os handlers de IPC para o sistema de envio de erros e telemetria.
 */
module.exports = function registerTelemetryHandlers() {
  ipcMain.handle('telemetry:reportError', async (_, error, context) => {
    return errorReporter.report(error, context);
  });

  ipcMain.handle('telemetry:getDeveloperEmail', () => {
    return errorReporter.developerEmail;
  });

  ipcMain.handle('telemetry:getCrashReports', () => {
    return errorReporter.listLocalReports();
  });

  ipcMain.handle('telemetry:openReportsFolder', () => {
    errorReporter.openCrashReportsFolder();
    return true;
  });

  ipcMain.handle('telemetry:getMailtoLink', async (_, error, context) => {
    const report = await errorReporter.report(error, context);
    if (!report) return null;
    return errorReporter.generateMailtoLink(report);
  });
};
