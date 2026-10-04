const { BrowserWindow, shell } = require('electron');
const { handle } = require('./channelRegistry');
const { assertExternalUrl } = require('./validate');


/** Hosts permitidos para navegação dentro da janela de login do YouTube Studio. */
function isAllowedLoginHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'accounts.google.com' || h === 'google.com' || h.endsWith('.google.com') ||
         h === 'youtube.com' || h.endsWith('.youtube.com');
}

module.exports = function registerYoutubeHandlers() {
  // Singleton: um único login por vez; novos pedidos reutilizam/focam a janela existente.
  let authWin = null;
  let authPromise = null;

  handle('youtube:login', async () => {
    if (authWin && !authWin.isDestroyed()) {
      if (authWin.isMinimized()) authWin.restore();
      authWin.focus();
      return authPromise;
    }

    authWin = new BrowserWindow({
      width: 1024,
      height: 768,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'persist:youtube'
      }
    });
    const win = authWin;
    win.setMenuBarVisibility(false);

    // Mantém a navegação restrita ao login do Google/YouTube; links externos abrem no navegador padrão.
    win.webContents.on('will-navigate', (event, url) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'https:' && isAllowedLoginHost(u.hostname)) return;
      } catch (_) { /* cai no preventDefault */ }
      event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      try { shell.openExternal(assertExternalUrl(url)); } catch (_) { /* URL não permitida */ }
      return { action: 'deny' };
    });

    authPromise = new Promise((resolve) => {
      win.on('closed', () => {
        if (authWin === win) { authWin = null; authPromise = null; }
        resolve(true); // Retorna quando o usuário fechar a janela de login
      });
    });

    try {
      await win.loadURL('https://studio.youtube.com');
    } catch (err) {
      // Falha de rede/URL: fecha a janela e informa; não deixa a promise pendurada.
      if (!win.isDestroyed()) win.destroy();
      return false;
    }

    return authPromise;
  });
};
