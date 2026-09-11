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

  ipcMain.handle('telemetry:openReportsFolder', () => {
    errorReporter.openCrashReportsFolder();
    return true;
  });

  ipcMain.handle('telemetry:getMailtoLink', async (_, error, context) => {
    const report = await errorReporter.report(error, context);
    if (!report) return null;
    return errorReporter.generateMailtoLink(report);
  });

  // Link mailto a partir de um crash report já salvo em disco (ação explícita do usuário)
  ipcMain.handle('telemetry:getCrashReportMailto', (_, filePath) => {
    return errorReporter.generateMailtoFromSavedReport(filePath);
  });

  // Conteúdo completo de um crash report salvo (para visualização na UI)
  ipcMain.handle('telemetry:getCrashReportDetails', (_, filePath) => {
    return errorReporter.getReportDetails(filePath);
  });

  // Relato manual do usuário (não é bloqueado por errorReportingEnabled: ação explícita)
  ipcMain.handle('telemetry:generateManualMailto', (_, description) => {
    return errorReporter.generateManualMailto(description);
  });
};
