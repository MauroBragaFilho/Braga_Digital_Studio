'use strict';

const { handle } = require('./channelRegistry');
const path = require('node:path');
const CookiesService = require('../core/CookiesService');
const { onceCreated } = require('../core/modules/lazyService');
const YoutubeCookieSession = require('../services/youtubeCookieSession');
const logger = require('../services/logService');

// Sessões do navegador embutido onde o usuário entra na conta (aba Envio e janela de login)
const YOUTUBE_PARTITIONS = ['persist:youtube_studio', 'persist:youtube'];

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

  // Conta do YouTube nos downloads: uso OPCIONAL (Configurações, desligado por padrão). O arquivo de cookies que o yt-dlp lê só
  // existe enquanto um download ou uma consulta de link do YouTube o usa (ver services/youtubeCookieSession.js).
  const cookiesFile = () => CookiesService.getDefaultCookiesPath('youtube');
  // Arquivos que o app gerou antes (versões anteriores ou travamento): só os com o cabeçalho do app são apagados
  const staleCookieFiles = () => {
    const files = [cookiesFile()];
    try {
      const { appPaths } = require('../infrastructure/filesystem/AppPaths');
      files.push(path.join(appPaths.dataDir, 'youtube_cookies.txt'), path.join(appPaths.dataDir, 'cookies.txt'));
    } catch (_) { /* caminhos do app ainda não definidos (testes) */ }
    return files;
  };
  const youtubeCookieSession = new YoutubeCookieSession({
    isEnabled: () => settingsManager.load().useYoutubeAccount === true,
    exportFile: async () => ((await CookiesService.exportNetscapeCookies('youtube.com', cookiesFile(), 'persist:youtube_studio')) ? cookiesFile() : null),
    deleteFile: () => CookiesService.deleteCookiesFile(cookiesFile()),
    deleteFileSync: () => CookiesService.deleteCookiesFileSync(cookiesFile()),
    purge: () => CookiesService.purgeGeneratedFiles(staleCookieFiles()),
    inspectSession: () => CookiesService.sessionAuthStatus('youtube.com', 'persist:youtube_studio'),
    logger
  });
  // Só no app de verdade (não nos testes): limpa restos ao abrir e apaga o arquivo ao fechar
  if (process.versions && process.versions.electron) {
    youtubeCookieSession.purgeStale().catch(() => {});
    try { require('electron').app.on('will-quit', () => youtubeCookieSession.disposeSync()); } catch (_) { /* fora do Electron */ }
  }
  // Os serviços são criados no primeiro uso (módulo Downloads): a conta e o provedor de informações dos links (título,
  // miniatura...) são ligados nesse momento. A fila de metadados do serviço busca UM link por vez, depois de o cartão já
  // estar na tela.
  onceCreated(downloadService, (d) => {
    d.cookieSession = youtubeCookieSession;
    d.metadataProvider = (url) => thumbnailService.getMetadata(url);
  });
  onceCreated(thumbnailService, (t) => { t.cookieSession = youtubeCookieSession; });
  // Sair da conta: apaga o login do navegador embutido e qualquer arquivo de sessão
  handle('youtube:signOut', async () => {
    try {
      await youtubeCookieSession.dispose();
      await CookiesService.signOut(YOUTUBE_PARTITIONS);
      await CookiesService.purgeGeneratedFiles(staleCookieFiles());
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Download Queue
  // Link repetido não é erro do app: volta { ok: false, duplicate: true, code, error, existingId } para a tela avisar
  // e destacar o cartão que já existe (o código estável não sobreviveria a uma exceção do IPC).
  handle('downloads:add', (_, request) => {
    try {
      return downloadService.add(request);
    } catch (err) {
      if (err && typeof err.code === 'string' && err.code.startsWith('DUPLICATE_')) {
        return { ok: false, duplicate: true, code: err.code, error: err.message, existingId: err.existingId || null };
      }
      throw err;
    }
  });
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
