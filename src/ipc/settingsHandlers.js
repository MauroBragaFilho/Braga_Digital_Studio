'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { handle } = require('./channelRegistry');
const { maskSettings, restoreMaskedSecrets } = require('./settingsSecrets');
const {
  libraryFoldersChanged, hardwareSettingsChanged, notificationSettingsChanged, updateServerChanged
} = require('../core/settings/settingsChanges');
const notificationCenter = require('../infrastructure/desktop/NotificationCenter');
const deadlineNotifier = require('../infrastructure/desktop/DeadlineNotifier');

/**
 * Configurações do usuário (settings:get / settings:save) e pasta padrão do Conversor.
 * `deps` = { settingsManager, appPaths, libManager, watcherService, updateService, syncLibraries }.
 */
module.exports = function registerSettingsHandlers({
  settingsManager, appPaths, libManager, watcherService, updateService, syncLibraries
}) {
  // Segredos listados em settingsSecrets são mascarados antes de chegar ao renderer.
  handle('settings:get', () => maskSettings(settingsManager.load()));
  handle('settings:getDefaultFolders', () => settingsManager.getDefaultFolders());
  handle('settings:save', (_, settings) => {
    // (objeto de configurações já validado pelo esquema do canal)
    // Campo ainda mascarado = não alterado: preserva o valor real guardado no main.
    const previous = settingsManager.load();
    const toSave = restoreMaskedSecrets(settings, previous);
    const saved = settingsManager.save(toSave);
    notificationCenter.updateSettings(saved);
    // [PERF] Chaves de interface (sidebarCollapsed, theme, windowBounds...) só gravam o JSON:
    // os efeitos abaixo só rodam quando as chaves relacionadas realmente mudaram.
    // Reavalia prazos imediatamente após salvar preferências de notificação
    if (notificationSettingsChanged(previous, saved) && typeof deadlineNotifier.checkDeadlines === 'function') {
      deadlineNotifier.checkDeadlines(saved);
    }
    // Reinicia os watchers (e ressincroniza as bibliotecas) apenas se uma pasta monitorada mudou.
    if (libManager && watcherService && libraryFoldersChanged(previous, saved)) {
      syncLibraries(libManager, saved);
      watcherService.stopAll();
      setTimeout(() => watcherService.startAll(), 1000);
    }
    if (updateServerChanged(previous, saved)) updateService?.applyUpdateServerSettings();
    // Reaplica as preferências de aceleração de hardware; o cache de encoders só é
    // invalidado se a aceleração ou o fabricante preferido mudaram.
    try {
      const hardwareDetection = require('../core/HardwareDetectionService');
      hardwareDetection.configure(saved);
      if (hardwareSettingsChanged(previous, saved)) hardwareDetection.invalidateCache();
    } catch (_) {}
    return maskSettings(saved);
  });

  // Pasta de destino padrão do Conversor: usa a pasta persistida pelo usuário
  // (settings.converterFolder) ou, na ausência dela, "Vídeos do usuário/Convertido".
  handle('system:getConverterOutputDir', () => {
    const settings = settingsManager.load();
    let dir = settings.converterFolder;
    if (!dir) dir = path.join(appPaths.videosDir, 'Convertido');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
    return dir;
  });
};
