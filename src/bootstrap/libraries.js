'use strict';

const logger = require('../services/logService');
const dbManager = require('../core/database/database');
const { recordingFolderDetector } = require('../core/library/RecordingFolderDetector');

const IS_WIN = process.platform === 'win32';
const samePath = (a, b) => (IS_WIN ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/**
 * Decide o que fazer com as bibliotecas fixas (OBS, ShadowPlay, BDSM Devices) a partir das configurações e da
 * detecção automática. Função pura (testável): devolve as ações, sem tocar no banco.
 *
 * Regras:
 *  - pasta informada nas Configurações (manual) vence a detecção;
 *  - sem pasta manual, o OBS vira UMA biblioteca por perfil detectado (nome "OBS Studio (perfil)"; com um
 *    perfil só, "OBS Studio"); o ShadowPlay vira "NVIDIA ShadowPlay" com a pasta do NVIDIA App;
 *  - bibliotecas existentes do tipo são reaproveitadas pela pasta (renomeadas se preciso); as que sobram do tipo
 *    NUNCA são removidas aqui (remover apagaria as mídias indexadas): ficam como estão.
 *
 * @param {Array<{id:number,name:string,type:string,path:string}>} existing  bibliotecas atuais
 * @param {object} settings
 * @param {{ obs?: { profiles: Array<{profile:string,path:string}> }, shadowplay?: { path: string }|null }} [detected]
 * @returns {{ add: Array<{name:string,type:string,path:string}>, update: Array<{id:number,name?:string,path?:string}> }}
 */
function planLibrarySync(existing, settings, detected = {}) {
  const add = [];
  const update = [];
  const ofType = (type) => existing.filter((l) => l.type === type);

  /** Uma biblioteca do tipo com a pasta dada (manual): reaproveita a primeira do tipo. */
  const single = (name, type, folderPath) => {
    if (!folderPath) return;
    const libs = ofType(type);
    if (libs.length === 0) { add.push({ name, type, path: folderPath }); return; }
    const first = libs[0];
    const patch = { id: first.id };
    if (!samePath(first.path, folderPath)) patch.path = folderPath;
    if (first.name !== name) patch.name = name;
    if (patch.path || patch.name) update.push(patch);
  };

  /** Várias bibliotecas do tipo, uma por pasta detectada: casa pela pasta; o que falta é criado. */
  const perFolder = (type, entries) => {
    const libs = ofType(type);
    const used = new Set();
    for (const e of entries) {
      const hit = libs.find((l) => !used.has(l.id) && samePath(l.path, e.path));
      if (hit) {
        used.add(hit.id);
        if (hit.name !== e.name) update.push({ id: hit.id, name: e.name });
        continue;
      }
      // Sem biblioteca nessa pasta: reaproveita uma do tipo ainda não usada (ex.: a pasta mudou no OBS) ou cria
      const spare = libs.find((l) => !used.has(l.id) && !entries.some((x) => samePath(l.path, x.path)));
      if (spare) { used.add(spare.id); update.push({ id: spare.id, name: e.name, path: e.path }); }
      else add.push({ name: e.name, type, path: e.path });
    }
  };

  // OBS Studio
  if (settings.obsFolder) {
    single('OBS Studio', 'OBS', settings.obsFolder);
  } else if (settings.obsFolderAuto !== false) {
    const profiles = (detected.obs && detected.obs.profiles) || [];
    const entries = profiles.map((p) => ({ name: profiles.length > 1 ? `OBS Studio (${p.profile})` : 'OBS Studio', path: p.path }));
    if (entries.length) perFolder('OBS', entries);
  }

  // NVIDIA ShadowPlay (NVIDIA App)
  if (settings.shadowplayFolder) {
    single('NVIDIA ShadowPlay', 'SHADOWPLAY', settings.shadowplayFolder);
  } else if (settings.shadowplayFolderAuto !== false && detected.shadowplay && detected.shadowplay.path) {
    single('NVIDIA ShadowPlay', 'SHADOWPLAY', detected.shadowplay.path);
  }

  if (settings.deviceFolder) single('BDSM Devices', 'BDSM_DEVICE', settings.deviceFolder);

  return { add, update };
}

/**
 * Sincroniza as bibliotecas (OBS, ShadowPlay, BDSM Devices) com as pastas das configurações e, quando a pasta não
 * foi informada, com a detecção automática (último resultado do RecordingFolderDetector).
 * @returns {boolean} true se algo mudou no banco
 */
function syncLibraries(libManager, settings, detected = recordingFolderDetector.last) {
  try {
    const db = dbManager.get();
    db.prepare("DELETE FROM libraries WHERE type IN ('LOCAL_FOLDER', 'LOCAL')").run();

    const plan = planLibrarySync(libManager.list(), settings || {}, detected || {});
    for (const u of plan.update) {
      if (u.path != null && u.name != null) db.prepare('UPDATE libraries SET path = ?, name = ? WHERE id = ?').run(u.path, u.name, u.id);
      else if (u.path != null) db.prepare('UPDATE libraries SET path = ? WHERE id = ?').run(u.path, u.id);
      else if (u.name != null) db.prepare('UPDATE libraries SET name = ? WHERE id = ?').run(u.name, u.id);
    }
    for (const a of plan.add) libManager.add(a);
    const changed = plan.add.length > 0 || plan.update.length > 0;
    if (changed) logger.info('Bootstrap:syncLibraries', { added: plan.add.map((a) => a.name), updated: plan.update.length });
    return changed;
  } catch (err) {
    logger.error('Bootstrap:_syncLibraries:error', { error: err.message });
    return false;
  }
}

module.exports = { syncLibraries, planLibrarySync };
