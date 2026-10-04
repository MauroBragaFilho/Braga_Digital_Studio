'use strict';

const { handle } = require('./channelRegistry');
const CookiesService = require('../core/CookiesService');

/**
 * Metadados de mídia (yt-dlp), download direto e fila de downloads.
 * `deps` = { downloadService, thumbnailService, settingsManager }.
 */
module.exports = function registerDownloadHandlers({ downloadService, thumbnailService, settingsManager }) {
  // YouTube & Downloads
  handle('media:metadata', (_, url) => thumbnailService.getMetadata(url));
  handle('media:inspectPlaylist', (_, url) => thumbnailService.inspectPlaylist(url));
  handle('media:expandPlaylist', (_, url) => thumbnailService.expandPlaylist(url));
  handle('download:start', (_, request) => downloadService.startDownload(request));
  handle('youtube:get-accounts', () => []);
  // Renova o arquivo de cookies a partir da sessão da aba Envio (se houver login). Devolve o caminho ou null.
  const refreshYoutubeCookies = async () => {
    const cookiesPath = CookiesService.getDefaultCookiesPath('youtube');
    const success = await CookiesService.exportNetscapeCookies('youtube.com', cookiesPath, 'persist:youtube_studio');
    if (!success) return null;
    if (settingsManager.load().cookiesFile !== cookiesPath) settingsManager.save({ cookiesFile: cookiesPath });
    return cookiesPath;
  };
  downloadService.cookiesProvider = refreshYoutubeCookies;
  handle('youtube:exportCookies', async () => {
    try {
      const cookiesPath = await refreshYoutubeCookies();
      return cookiesPath ? { success: true, path: cookiesPath } : { success: false };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Download Queue
  handle('downloads:add', (_, request) => downloadService.add(request));
  handle('downloads:start', () => downloadService.start());
  handle('downloads:pause', () => downloadService.pause());
  handle('downloads:cancel', (_, id) => downloadService.cancel(id));
  handle('downloads:retry', (_, id) => downloadService.retry(id));
  handle('downloads:remove', (_, id) => downloadService.remove(id));
  handle('downloads:reorder', (_, id, dir) => downloadService.reorder(id, dir));
  handle('downloads:clearCompleted', () => downloadService.clearCompleted());
  handle('downloads:clearAll', () => downloadService.clearAll());
  handle('downloads:toggleFormat', (_, id, fmt) => downloadService.toggleFormat(id, fmt));
  handle('downloads:updateQuality', (_, id, q) => downloadService.updateQuality(id, q));
  handle('downloads:getQueue', () => downloadService.getQueue());
  handle('downloads:skipWait', () => downloadService.skipWait());
  handle('downloads:waitState', () => downloadService.getWaitState());
  handle('downloads:cookiesStatus', () => downloadService.getCookiesStatus());
  handle('download:cancel', () => downloadService.pause());
  handle('download:getQueue', () => downloadService.getQueue());
  handle('download:clearQueue', () => downloadService.clearCompleted());
  handle('download:removeJob', (_, id) => downloadService.remove(id));
};
