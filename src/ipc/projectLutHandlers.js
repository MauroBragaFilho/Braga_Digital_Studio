'use strict';

const { shell } = require('electron');
const { handle } = require('./channelRegistry');
const { userMessage } = require('../core/luts/lutErrors');
const logger = require('../services/logService');

const MSG_LIST = 'Não foi possível ler as LUTs do projeto.';
const MSG_ADD = 'Não foi possível adicionar as LUTs ao projeto.';
const MSG_REMOVE = 'Não foi possível remover a LUT do projeto.';
const MSG_REVEAL = 'Não foi possível mostrar a LUT na pasta.';
const MSG_USAGE = 'Não foi possível conferir em quais projetos as LUTs são usadas.';

/**
 * Registra os canais das LUTs de projeto. Os caminhos que chegam da tela são sempre relativos à coleção e o serviço
 * os confere (dentro da coleção, arquivo .cube comum, conteúdo lido uma vez e validado); nenhum caminho do
 * renderer é aberto como veio. Mensagens ao usuário em português, sem o texto cru de exceções.
 * @param {import('../core/projects/ProjectLutService')} projectLutService
 */
module.exports = function registerProjectLutHandlers(projectLutService) {
  const failWith = (tag, fallback) => (err) => {
    logger.error(`IPC:${tag}:error`, { error: err && err.message });
    throw new Error(userMessage(err, fallback));
  };

  handle('projects:listLuts', (_, projectId) => projectLutService.list(projectId).catch(failWith('projects:listLuts', MSG_LIST)));

  handle('projects:addLuts', (_, projectId, relPaths, folders) => projectLutService
    .add(projectId, relPaths || [], { folders: folders || [] })
    .catch(failWith('projects:addLuts', MSG_ADD)));

  handle('projects:removeLut', (_, projectId, hash) => {
    try {
      return projectLutService.remove(projectId, hash);
    } catch (err) {
      return failWith('projects:removeLut', MSG_REMOVE)(err);
    }
  });

  handle('projects:revealLut', async (_, projectId, hash) => {
    try {
      shell.showItemInFolder(await projectLutService.resolvePath(projectId, hash));
      return true;
    } catch (err) {
      return failWith('projects:revealLut', MSG_REVEAL)(err);
    }
  });

  handle('luts:usage', (_, relPaths, folders) => projectLutService
    .usage({ relPaths: relPaths || [], folders: folders || [] })
    .catch(failWith('luts:usage', MSG_USAGE)));
};
