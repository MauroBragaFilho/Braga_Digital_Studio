'use strict';

const path = require('node:path');
const os = require('node:os');
const { dialog, BrowserWindow } = require('electron');
const { handle } = require('./channelRegistry');

// Somente opções conhecidas e seguras do renderer são repassadas ao diálogo nativo.
const SAFE_DIALOG_PROPERTIES = new Set(['openFile', 'multiSelections', 'openDirectory', 'showHiddenFiles']);
const sanitizeDialogOptions = (custom) => {
  const out = { properties: ['openFile', 'multiSelections'] };
  if (!custom || typeof custom !== 'object') return out;
  if (typeof custom.title === 'string') out.title = custom.title.slice(0, 200);
  if (typeof custom.buttonLabel === 'string') out.buttonLabel = custom.buttonLabel.slice(0, 60);
  if (typeof custom.defaultPath === 'string' && path.isAbsolute(custom.defaultPath)) out.defaultPath = custom.defaultPath;
  if (Array.isArray(custom.properties)) {
    const props = custom.properties.filter((p) => SAFE_DIALOG_PROPERTIES.has(p));
    if (props.length) out.properties = props;
  }
  if (Array.isArray(custom.filters)) {
    out.filters = custom.filters
      .filter((f) => f && typeof f.name === 'string' && Array.isArray(f.extensions))
      .slice(0, 20)
      .map((f) => ({
        name: f.name.slice(0, 100),
        extensions: f.extensions.filter((e) => typeof e === 'string' && /^[A-Za-z0-9*_-]{1,12}$/.test(e)).slice(0, 100)
      }))
      .filter((f) => f.extensions.length > 0);
  }
  return out;
};

/** Diálogos nativos de seleção de pasta/arquivos. `getMainWindow` devolve a janela atual. */
module.exports = function registerDialogHandlers(getMainWindow) {
  handle('dialog:selectFolder', async (_, fallbackPath) => {
    const win = getMainWindow() || BrowserWindow.getFocusedWindow();
    const safeDefault = typeof fallbackPath === 'string' && fallbackPath && path.isAbsolute(fallbackPath) ? fallbackPath : os.homedir();
    const options = { defaultPath: safeDefault, properties: ['openDirectory', 'createDirectory'] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  });

  handle('dialog:selectFiles', async (_, customOptions) => {
    const options = sanitizeDialogOptions(customOptions);
    const win = getMainWindow() || BrowserWindow.getFocusedWindow();
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
};
