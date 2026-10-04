'use strict';
/**
 * Contagem de vínculos de projeto que serão apagados em cascata (project_media, grupos de sincronização,
 * referências da timeline) ao excluir mídia, remover uma fonte ou limpar o banco (RK-015).
 * Funções puras sobre o wrapper do banco (db.prepare(...).all/get).
 */
const { chunk, sqlPlaceholders } = require('../../ipc/validate');

const BATCH = 500;

function emptyResult() { return { links: 0, projects: [] }; }

/** @returns {{links:number, projects:string[]}} vínculos (linhas de project_media) e nomes de projetos afetados */
function countMediaLinks(db, mediaIds) {
  const res = emptyResult();
  const ids = Array.isArray(mediaIds) ? mediaIds.filter((n) => Number.isInteger(n)) : [];
  if (!ids.length) return res;
  const names = new Set();
  for (const batch of chunk(ids, BATCH)) {
    const rows = db.prepare(`
      SELECT p.name AS name, COUNT(*) AS n
      FROM project_media pm LEFT JOIN projects p ON p.id = pm.project_id
      WHERE pm.media_id IN (${sqlPlaceholders(batch.length)})
      GROUP BY pm.project_id
    `).all(...batch);
    for (const r of rows) { res.links += r.n || 0; names.add(r.name || '(sem nome)'); }
  }
  res.projects = Array.from(names);
  return res;
}

/** Vínculos das mídias de uma biblioteca (por library_id ou origin). */
function countLibraryLinks(db, libraryId, libraryName) {
  const rows = db.prepare(`SELECT id FROM media WHERE library_id = ? OR origin = ?`).all(libraryId, libraryName || '\u0000');
  return countMediaLinks(db, rows.map((r) => r.id));
}

/** Todos os vínculos existentes (limpar banco). */
function countAllLinks(db) {
  const rows = db.prepare(`
    SELECT p.name AS name, COUNT(*) AS n FROM project_media pm LEFT JOIN projects p ON p.id = pm.project_id GROUP BY pm.project_id
  `).all();
  return { links: rows.reduce((a, r) => a + (r.n || 0), 0), projects: rows.map((r) => r.name || '(sem nome)') };
}

/** Texto curto para diálogos: "3 vínculos em 2 projetos (A, B, ...)" ou '' se não houver. */
function describeLinks({ links, projects }) {
  if (!links) return '';
  const lista = projects.slice(0, 5).join(', ') + (projects.length > 5 ? ', ...' : '');
  return `${links} vínculo${links > 1 ? 's' : ''} de projeto em ${projects.length} projeto${projects.length > 1 ? 's' : ''} (${lista})`;
}

module.exports = { countMediaLinks, countLibraryLinks, countAllLinks, describeLinks };
