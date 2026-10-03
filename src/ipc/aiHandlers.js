'use strict';

const { ipcMain, safeStorage, BrowserWindow } = require('electron');
const AIService = require('../services/ai/AIService');
const { analyzeTranscriptFile } = require('../services/ai/analyzeFile');
const { appPaths } = require('../infrastructure/filesystem/AppPaths');
const { wrap } = require('./wrap');

/**
 * Handlers IPC da IA. Todos devolvem { ok, data } ou { ok:false, error } para que o
 * renderer trate falhas sem depender do formato de erro do Electron.
 * O andamento da análise de transcrições chega pelo evento "ai:analysisProgress".
 */
module.exports = function registerAiHandlers(paths) {
  const configDir = (paths && paths.configDir) || appPaths.configDir;
  const ai = new AIService({ configDir, safeStorage });

  const broadcast = (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  ipcMain.handle('ai:getConfig', wrap(() => ai.getPublicConfig()));
  ipcMain.handle('ai:saveConfig', wrap((patch) => ai.saveConfig(patch && typeof patch === 'object' ? patch : {})));
  ipcMain.handle('ai:testConnection', wrap(() => ai.testConnection()));
  ipcMain.handle('ai:listModels', wrap(() => ai.listModels()));
  ipcMain.handle('ai:chat', wrap((payload) => ai.chat({ messages: payload && payload.messages })));
  ipcMain.handle('ai:listTasks', wrap(() => ai.listTasks()));
  ipcMain.handle('ai:runTask', wrap((name, payload) => ai.runTask(String(name || ''), payload)));

  // Análise de transcrição: uma por vez (o modelo local é um só); cancelável.
  let analysis = null;
  ipcMain.handle('ai:analyzeTranscript', wrap(async (payload) => {
    const filePath = payload && typeof payload.path === 'string' && payload.path.length <= 500 ? payload.path : '';
    if (!filePath) throw new Error('Arquivo da transcrição inválido.');
    if (analysis) throw Object.assign(new Error('Já existe uma análise em andamento.'), { code: 'BUSY' });
    const controller = new AbortController();
    analysis = { controller };
    try {
      return await analyzeTranscriptFile(ai, {
        filePath,
        signal: controller.signal,
        onProgress: (p) => broadcast('ai:analysisProgress', { path: filePath, ...p })
      });
    } finally {
      analysis = null;
    }
  }));
  ipcMain.handle('ai:cancelAnalysis', wrap(() => { if (analysis) analysis.controller.abort(); return true; }));

  return ai;
};
