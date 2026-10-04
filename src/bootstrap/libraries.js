'use strict';

const logger = require('../services/logService');
const dbManager = require('../core/database/database');

/** Sincroniza as bibliotecas (OBS, ShadowPlay, BDSM Devices) com as pastas das configurações. */
function syncLibraries(libManager, settings) {
  try {
    const db = dbManager.get();
    db.prepare("DELETE FROM libraries WHERE type IN ('LOCAL_FOLDER', 'LOCAL')").run();

    const libs = libManager.list();
    const syncLib = (name, type, folderPath) => {
      if (!folderPath) return;
      const existing = libs.find(l => l.type === type);
      if (existing) {
        if (existing.path !== folderPath) {
          db.prepare('UPDATE libraries SET path = ? WHERE id = ?').run(folderPath, existing.id);
        }
      } else {
        libManager.add({ name, type, path: folderPath });
      }
    };

    if (settings.obsFolder) syncLib('OBS Studio', 'OBS', settings.obsFolder);
    if (settings.shadowplayFolder) syncLib('NVIDIA ShadowPlay', 'SHADOWPLAY', settings.shadowplayFolder);
    if (settings.deviceFolder) syncLib('BDSM Devices', 'BDSM_DEVICE', settings.deviceFolder);
  } catch (err) {
    logger.error('Bootstrap:_syncLibraries:error', { error: err.message });
  }
}

module.exports = { syncLibraries };
