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

  ipcMain.handle('telemetry:clearCrashReports', () => {
    return errorReporter.clearAllReports();
  });

  // Envia todos os relatórios guardados (endpoint https ou e-mail com o resumo)
  ipcMain.handle('telemetry:sendReports', () => errorReporter.sendAllReports());

  ipcMain.handle('telemetry:getMailtoLink', async (_, error, context) => {
    const report = await errorReporter.report(error, context);
    if (!report) return null;
    return errorReporter.generateMailtoLink(report);
  });

  // Relato manual do usuário (não é bloqueado por errorReportingEnabled: ação explícita)
  ipcMain.handle('telemetry:generateManualMailto', (_, description) => {
    return errorReporter.generateManualMailto(description);
  });
};
