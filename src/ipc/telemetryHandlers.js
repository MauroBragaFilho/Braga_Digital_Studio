'use strict';

const { handle } = require('./channelRegistry');
const { errorReporter } = require('../infrastructure/telemetry/ErrorReporter');

/**
 * Registra os handlers de IPC para o sistema de envio de erros e telemetria.
 */
module.exports = function registerTelemetryHandlers() {
  handle('telemetry:reportError', async (_, error, context) => {
    return errorReporter.report(error, context);
  });

  handle('telemetry:getDeveloperEmail', () => {
    return errorReporter.developerEmail;
  });

  handle('telemetry:getCrashReports', () => {
    return errorReporter.listLocalReports();
  });

  handle('telemetry:clearCrashReports', () => {
    return errorReporter.clearAllReports();
  });

  // Envia todos os relatórios guardados (endpoint https ou e-mail com o resumo)
  handle('telemetry:sendReports', () => errorReporter.sendAllReports());

  handle('telemetry:getMailtoLink', async (_, error, context) => {
    const report = await errorReporter.report(error, context);
    if (!report) return null;
    return errorReporter.generateMailtoLink(report);
  });

  // Relato manual do usuário (não é bloqueado por errorReportingEnabled: ação explícita)
  handle('telemetry:generateManualMailto', (_, description) => {
    return errorReporter.generateManualMailto(description);
  });
};
