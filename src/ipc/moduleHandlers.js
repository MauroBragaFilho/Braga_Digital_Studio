'use strict';

const { app, ipcMain, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { ModuleManager } = require('../core/modules/ModuleManager');
const { appPaths } = require('../infrastructure/filesystem/AppPaths');
const moduleConfig = require('../config/modules.config.json');
const { detectDevEngine } = require('../core/modules/devEngine');
const { wrap } = require('./wrap');

/**
 * Handlers IPC dos módulos opcionais (Whisper). Todos devolvem { ok, data } ou { ok:false, error, code }.
 * O progresso das operações longas chega ao renderer pelo evento "modules:progress".
 */
module.exports = function registerModuleHandlers(paths) {
  const dataDir = (paths && paths.dataDir) || appPaths.dataDir;
  const tempDir = (paths && paths.tempDir) || appPaths.tempDir;

  // Só em desenvolvimento: usa o Python local do projeto "Whisper + LM Studio" em vez do motor empacotado.
  const devEngine = detectDevEngine({
    isPackaged: app.isPackaged,
    appRoot: path.join(__dirname, '..', '..'),
    ffmpegPath: process.env.WL_FFMPEG || null // senão o motor usa o ffmpeg do PATH
  });
  const manager = new ModuleManager({ rootDir: dataDir, tempDir, config: { ...moduleConfig, devEngine } });

  const broadcast = (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };
  manager.on('progress', (p) => broadcast('modules:progress', p));
  manager.on('status', () => broadcast('modules:status', null));

  const str = (v, label) => {
    if (typeof v !== 'string' || !v || v.length > 500) throw new Error(`${label} inválido.`);
    return v;
  };

  ipcMain.handle('modules:getStatus', wrap(() => manager.getStatus()));
  ipcMain.handle('modules:installEngine', wrap((payload) => manager.installEngine({ zipPath: payload && payload.zipPath ? str(payload.zipPath, 'Arquivo') : null })));
  ipcMain.handle('modules:uninstallEngine', wrap(() => manager.uninstallEngine()));
  ipcMain.handle('modules:installModel', wrap((id) => manager.installModel(str(id, 'Modelo'))));
  ipcMain.handle('modules:removeModel', wrap((id) => manager.removeModel(str(id, 'Modelo'))));
  ipcMain.handle('modules:setActiveModel', wrap((id) => manager.setActiveModel(str(id, 'Modelo'))));
  ipcMain.handle('modules:installCuda', wrap((payload) => manager.installCuda({ acceptLicense: !!(payload && payload.acceptLicense === true) })));
  ipcMain.handle('modules:removeCuda', wrap(() => manager.removeCuda()));
  ipcMain.handle('modules:cancel', wrap(() => manager.cancel()));
  ipcMain.handle('modules:transcribe', wrap((options) => {
    const o = options && typeof options === 'object' ? options : {};
    return manager.transcribe({
      files: Array.isArray(o.files) ? o.files.map((f) => str(f, 'Arquivo')) : [],
      srt: o.srt !== false,
      md: o.md === true,
      maxWords: Number(o.maxWords) || 0,
      lines: o.lines === 1 ? 1 : 2,
      outDir: o.outDir ? str(o.outDir, 'Pasta de saída') : null,
      forceCpu: o.forceCpu === true
    });
  }));
  // Só revela o arquivo no Explorer (não abre nem executa nada).
  ipcMain.handle('modules:reveal', wrap((p) => { shell.showItemInFolder(path.resolve(str(p, 'Caminho'))); return true; }));

  return manager;
};
