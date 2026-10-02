const { ipcMain, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { assertUserFile, assertExternalUrl } = require('./validate');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.wmv', '.flv', '.mpg', '.mpeg', '.3gp']);
const MAX_TITLE = 100;          // limite do YouTube
const MAX_DESCRIPTION = 5000;   // limite do YouTube

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

  ipcMain.handle('youtube:login', async () => {
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

  ipcMain.handle('youtube:upload', async (event, payload) => {
    try {
      const { filePath, title, description, isPublic } = payload || {};

      // O YouTubeBot controla o Electron via Puppeteer na porta de depuração remota,
      // que agora só existe quando o app é iniciado com a variável BDS_DEBUG_PORT.
      if (!process.env.BDS_DEBUG_PORT) {
        throw new Error('Upload automatizado indisponível: inicie o app com BDS_DEBUG_PORT=8315 para habilitá-lo.');
      }

      const safeFile = assertUserFile(filePath, 'Arquivo de vídeo');
      if (!VIDEO_EXTS.has(path.extname(safeFile).toLowerCase())) {
        throw new Error('Extensão de vídeo não suportada para upload.');
      }
      if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE) {
        throw new Error(`Título inválido (1 a ${MAX_TITLE} caracteres).`);
      }
      if (description != null && (typeof description !== 'string' || description.length > MAX_DESCRIPTION)) {
        throw new Error(`Descrição inválida (máximo ${MAX_DESCRIPTION} caracteres).`);
      }

      const YouTubeBot = require('../core/youtube/YouTubeBot');
      await YouTubeBot.uploadVideo(safeFile, title.trim(), description || '', isPublic !== false);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
};
