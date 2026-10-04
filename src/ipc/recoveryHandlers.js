'use strict';

const { dialog, BrowserWindow } = require('electron');
const { handle } = require('./channelRegistry');
const path = require('node:path');
const fs = require('node:fs');
const { assertUserFile, assertAbsolutePath } = require('./validate');
const logger = require('../services/logService');

/**
 * Valida as entradas de diagnóstico/recuperação vindas do renderer:
 * arquivo corrompido existente, referência (opcional) existente e pasta de saída (opcional) absoluta.
 */
function validateRecoveryInput(input = {}) {
  if (!input || typeof input !== 'object') throw new Error('Parâmetros inválidos.');
  const out = { ...input };
  out.corruptPath = assertUserFile(input.corruptPath, 'Arquivo corrompido');
  if (input.referencePath) out.referencePath = assertUserFile(input.referencePath, 'Arquivo de referência');
  else out.referencePath = null;
  if (input.outputDir) out.outputDir = assertAbsolutePath(input.outputDir, 'Pasta de saída');
  else out.outputDir = null;
  if (input.preferredLevel != null && typeof input.preferredLevel !== 'string') throw new Error('Nível de recuperação inválido.');
  return out;
}

module.exports = function registerRecoveryHandlers(videoRecoveryService, paths, rawRecoveryService) {
  handle('recovery:diagnose', async (_, payload) => {
    const { corruptPath, referencePath } = validateRecoveryInput(payload);
    return await videoRecoveryService.diagnose(corruptPath, referencePath);
  });

  handle('recovery:start', async (_, options) => {
    return await videoRecoveryService.recoverVideo(validateRecoveryInput(options));
  });

  handle('recovery:cancel', async () => {
    videoRecoveryService.cancel();
    return { success: true };
  });

  // --- Recuperação de RAW ---
  handle('recovery:raw:diagnose', async (_, payload) => {
    const { corruptPath, referencePath } = validateRecoveryInput(payload);
    return await rawRecoveryService.diagnose(corruptPath, referencePath);
  });

  handle('recovery:raw:start', async (_, options) => {
    return await rawRecoveryService.recoverRaw(validateRecoveryInput(options));
  });

  handle('recovery:raw:cancel', async () => {
    rawRecoveryService.cancel();
    return { success: true };
  });

  handle('logs:export', async (event) => {
    try {
      const logsDir = paths?.logsDir || process.env.BMD_LOGS_DIR || path.join(process.cwd(), 'logs');
      const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
      const dialogOptions = {
        title: 'Selecione a pasta de destino para exportar os logs',
        properties: ['openDirectory', 'createDirectory']
      };
      // getFocusedWindow() pode ser nulo (janela sem foco): abre o diálogo sem janela-pai.
      const result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions);

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, cancelled: true };
      }

      const destFolder = result.filePaths[0];
      const exportFolder = path.join(destFolder, `bds_logs_${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.mkdirSync(exportFolder, { recursive: true });

      let copied = 0;
      let failed = 0;
      if (fs.existsSync(logsDir)) {
        for (const file of fs.readdirSync(logsDir)) {
          const src = path.join(logsDir, file);
          const dst = path.join(exportFolder, file);
          try {
            if (fs.statSync(src).isFile()) {
              fs.copyFileSync(src, dst);
              copied++;
            }
          } catch (_) { failed++; }
        }
      }

      return { success: true, exportPath: exportFolder, copied, failed };
    } catch (err) {
      logger.error('[logs:export] Falha ao exportar logs:', { error: err.message });
      return { success: false, error: err.message };
    }
  });
};
