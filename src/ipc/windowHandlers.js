'use strict';

const { handle } = require('./channelRegistry');

/** Controles da janela principal. `getMainWindow` devolve a janela atual (trocada no activate). */
module.exports = function registerWindowHandlers(getMainWindow) {
  handle('window:minimize', () => getMainWindow()?.minimize());
  handle('window:maximize', () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  // Sem argumento alterna; com 'exit' só sai da tela cheia (usado pela tecla Esc).
  handle('window:fullscreen', (_, mode) => {
    const win = getMainWindow();
    if (!win) return;
    if (mode === 'exit') {
      if (win.isFullScreen()) win.setFullScreen(false);
      return;
    }
    win.setFullScreen(!win.isFullScreen());
  });
  handle('window:close', () => getMainWindow()?.close());
};
