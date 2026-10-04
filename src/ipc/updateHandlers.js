'use strict';

const { app } = require('electron');
const { handle } = require('./channelRegistry');
const { appUpdateChecker } = require('../infrastructure/external-tools/AppUpdateChecker');

/** Versão do app e atualizações (app + dependências). */
module.exports = function registerUpdateHandlers(updateService) {
  handle('app:getVersion', () => app.getVersion());
  handle('app:checkForUpdate', () => appUpdateChecker.checkForUpdate(app.getVersion()));

  // Updates
  handle('updates:checkSystem', () => updateService.checkSystem());
  handle('updates:check', () => updateService.checkSystem());
  handle('updates:checkLegacy', () => updateService.checkAll());
  // allowUnverified: o usuário confirmou instalar um componente cuja fonte não publica checksum
  handle('updates:updateTool', (_, tool, opts) =>
    updateService.updateTool(tool, null, { allowUnverified: opts?.allowUnverified === true }));
  handle('updates:rollbackTool', (_, tool) => updateService.rollbackTool(tool));
  handle('updates:updateAll', async () => {
    return await updateService.updateAll();
  });
  // Fluxo unificado (app + dependências)
  handle('updates:checkAll', () => updateService.checkEverything());
  handle('updates:updateEverything', async () => {
    return await updateService.updateEverything();
  });
  handle('updates:downloadAppUpdate', async () => {
    return await updateService.downloadAppUpdate();
  });
  handle('updates:installAppUpdate', (_, installerPath) => updateService.installAppUpdate(installerPath));
  handle('updates:relaunchApp', () => updateService.relaunchApp());
};
