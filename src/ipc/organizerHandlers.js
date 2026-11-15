'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DeviceOrganizer, applyRenames, applyMoves } = require('../services/organizer/DeviceOrganizer');

const IMAGE_RE = /\.(jpe?g|png|webp|bmp|gif)$/i;
const MAX_THUMBS = 24;
const MAX_IMAGE_BYTES = 60 * 1024 * 1024;
const LINK_WAIT_MS = 60000;

/**
 * Lógica dos canais de organização (separada do registro no ipcMain para ser testada sem o Electron).
 * @param {{ getLlm: () => object|null, projectService?: object, importQueue?: object, getDb?: () => object,
 *           nativeImage?: object, wait?: (ms:number)=>Promise<void>, linkWaitMs?: number }} deps
 */
function createOrganizerApi({ getLlm, projectService = null, importQueue = null, getDb = null, nativeImage = null, wait = (ms) => new Promise((r) => setTimeout(r, ms)), linkWaitMs = LINK_WAIT_MS }) {
  const llmOrNull = () => { try { return getLlm ? getLlm() : null; } catch (_) { return null; } };
  const organizer = () => new DeviceOrganizer({ llm: llmOrNull() });

  return {
    status() {
      const llm = llmOrNull();
      let vision = false;
      try { vision = Boolean(llm && llm.supportsVision()); } catch (_) { /* sem sistema local */ }
      return { aiAvailable: organizer().aiAvailable(), vision };
    },

    async plan(data = {}) {
      let projects = [];
      try {
        projects = projectService ? projectService.getAllProjects().map((p) => ({ id: p.id, name: String(p.name || ''), client: String(p.client || '') })) : [];
      } catch (_) { /* sem projetos: a sugestão de projeto fica de fora */ }
      return organizer().plan({ ...data, projects });
    },

    applyRenames: (destFolder, pairs) => applyRenames(destFolder, pairs),
    applyMoves: (root, moves) => applyMoves(root, moves),

    /** Miniaturas de imagens JÁ copiadas (para o sistema local olhar depois da importação): só imagens, pequenas, em JPEG. */
    thumbnails(files) {
      const img = nativeImage || require('electron').nativeImage;
      const out = {};
      for (const f of (Array.isArray(files) ? files : []).slice(0, MAX_THUMBS)) {
        try {
          const key = String(f && f.key);
          const file = String(f && f.path);
          if (!f || !f.key || !path.isAbsolute(file) || !IMAGE_RE.test(file)) continue;
          if (fs.statSync(file).size > MAX_IMAGE_BYTES) continue;
          const image = img.createFromPath(file);
          if (!image || image.isEmpty()) continue;
          const { width } = image.getSize();
          const buf = image.resize({ width: Math.min(384, width || 384) }).toJPEG(72);
          if (buf.length && buf.length <= 300000) out[key] = `data:image/jpeg;base64,${buf.toString('base64')}`;
        } catch (_) { /* miniatura é só ajuda: segue sem ela */ }
      }
      return out;
    },

    /**
     * Liga ao projeto os arquivos copiados: enfileira na Biblioteca (como as outras importações), espera as mídias nascerem e vincula.
     * Devolve { linked, total }; o que não entrou na Biblioteca a tempo fica sem vínculo (e é contado em `total`).
     */
    async linkProject(projectId, destFolder, names) {
      if (!projectService || !getDb) return { linked: 0, total: 0 };
      const base = path.resolve(String(destFolder || ''));
      const files = (Array.isArray(names) ? names : []).map(String).filter((n) => n && n === path.basename(n)).map((n) => path.join(base, n)).filter((f) => fs.existsSync(f));
      if (!files.length || !projectService.getProjectById(projectId)) return { linked: 0, total: files.length };
      const db = getDb();
      if (importQueue) {
        let lib = db.prepare("SELECT * FROM libraries WHERE type = 'BDSM_DEVICE' OR type = 'DEVICE' LIMIT 1").get();
        if (!lib) lib = db.prepare('SELECT * FROM libraries LIMIT 1').get();
        if (lib) for (const f of files) importQueue.add({ libraryId: lib.id, path: f, event: 'CREATE' });
      }
      const norm = (p) => path.resolve(p).toLowerCase();
      const wanted = new Map(files.map((f) => [norm(f), f]));
      const ids = new Map();
      const deadline = Date.now() + linkWaitMs;
      for (;;) {
        for (const [key, f] of wanted) {
          if (ids.has(key)) continue;
          const rows = db.prepare('SELECT id, filepath FROM media WHERE filename = ?').all(path.basename(f));
          const hit = rows.find((r) => norm(r.filepath) === key);
          if (hit) ids.set(key, hit.id);
        }
        if (ids.size === wanted.size || Date.now() >= deadline) break;
        await wait(1000);
      }
      const linked = ids.size ? projectService.addMediaBulkToProject(projectId, null, [...ids.values()]) : 0;
      return { linked, total: files.length };
    }
  };
}

/** Registra os canais organizer:* no ipcMain (ver channels.js). */
function registerOrganizerHandlers(deps) {
  const { handle } = require('./channelRegistry');
  const api = createOrganizerApi(deps);
  handle('organizer:status', () => api.status());
  handle('organizer:plan', (_, data) => api.plan(data));
  handle('organizer:applyRenames', (_, destFolder, pairs) => api.applyRenames(destFolder, pairs));
  handle('organizer:applyMoves', (_, root, moves) => api.applyMoves(root, moves));
  handle('organizer:thumbnails', (_, files) => api.thumbnails(files));
  handle('organizer:linkProject', (_, projectId, destFolder, names) => api.linkProject(projectId, destFolder, names));
  return api;
}

module.exports = registerOrganizerHandlers;
module.exports.createOrganizerApi = createOrganizerApi;
