'use strict';

const { handle } = require('./channelRegistry');
const { DeviceOrganizer, applyRenames } = require('../services/organizer/DeviceOrganizer');

/**
 * Organização dos arquivos ao copiar de um dispositivo: o plano (pastas, nomes e projeto sugeridos) e a renomeação depois da cópia.
 * O sistema local (modelo no computador) só é ligado quando o usuário pede sugestões; sem ele, o plano sai das regras.
 * @param {{ getLlm: () => object|null, projectService?: { getAllProjects: () => object[] } }} deps
 */
module.exports = function registerOrganizerHandlers({ getLlm, projectService = null }) {
  const llmOrNull = () => { try { return getLlm ? getLlm() : null; } catch (_) { return null; } };
  const organizer = () => new DeviceOrganizer({ llm: llmOrNull() });

  handle('organizer:status', () => {
    const llm = llmOrNull();
    const o = organizer();
    let vision = false;
    try { vision = Boolean(llm && llm.supportsVision()); } catch (_) { /* sem sistema local */ }
    return { aiAvailable: o.aiAvailable(), vision };
  });

  handle('organizer:plan', async (_, data = {}) => {
    let projects = [];
    try {
      projects = projectService ? projectService.getAllProjects().map((p) => ({ id: p.id, name: String(p.name || ''), client: String(p.client || '') })) : [];
    } catch (_) { /* sem projetos: a sugestão de projeto fica de fora */ }
    return organizer().plan({ ...data, projects });
  });

  handle('organizer:applyRenames', (_, destFolder, pairs) => applyRenames(destFolder, pairs));
};
