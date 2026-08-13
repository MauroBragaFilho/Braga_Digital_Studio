const { ipcMain, BrowserWindow } = require('electron');

module.exports = function registerYoutubeHandlers() {
  ipcMain.handle('youtube:login', async () => {
    const authWin = new BrowserWindow({
      width: 1024,
      height: 768,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:youtube'
      }
    });
    authWin.setMenuBarVisibility(false);
    await authWin.loadURL('https://studio.youtube.com');
    
    return new Promise((resolve) => {
      authWin.on('closed', () => {
        resolve(true); // Retorna quando o usuário fechar a janela de login
      });
    });
  });

  ipcMain.handle('youtube:upload', async (event, { filePath, title, description, isPublic }) => {
    const YouTubeBot = require('../core/youtube/YouTubeBot');
    try {
      await YouTubeBot.uploadVideo(filePath, title, description, isPublic);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
};
