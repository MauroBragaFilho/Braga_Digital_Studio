'use strict';

const { ipcMain, safeStorage } = require('electron');
const AIService = require('../services/ai/AIService');
const { appPaths } = require('../infrastructure/filesystem/AppPaths');

/**
 * Handlers IPC da IA. Todos devolvem { ok, data } ou { ok:false, error } para que o
 * renderer trate falhas sem depender do formato de erro do Electron.
 */
module.exports = function registerAiHandlers(paths) {
  const configDir = (paths && paths.configDir) || appPaths.configDir;
  const ai = new AIService({ configDir, safeStorage });

  const wrap = (fn) => async (_event, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err?.message || String(err) }; }
  };

  ipcMain.handle('ai:getConfig', wrap(() => ai.getPublicConfig()));
  ipcMain.handle('ai:saveConfig', wrap((patch) => ai.saveConfig(patch && typeof patch === 'object' ? patch : {})));
  ipcMain.handle('ai:testConnection', wrap(() => ai.testConnection()));
  ipcMain.handle('ai:listModels', wrap(() => ai.listModels()));
  ipcMain.handle('ai:chat', wrap((payload) => ai.chat({ messages: payload && payload.messages })));
  ipcMain.handle('ai:listTasks', wrap(() => ai.listTasks()));
  ipcMain.handle('ai:runTask', wrap((name, payload) => ai.runTask(String(name || ''), payload)));

  return ai;
};
