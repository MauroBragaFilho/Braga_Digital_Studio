'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { dialog, BrowserWindow, webContents } = require('electron');
const logger = require('../services/logService');
const { handle } = require('./channelRegistry');
const { assertAbsolutePath, assertUserFile } = require('./validate');
const { mapLimit } = require('../core/library/reconcile');

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

/**
 * A fila só dirige o <webview> da tela Envio: precisa ser um webview da janela principal, aberto no YouTube Studio.
 * Devolve null se pode usar, ou a mensagem para o usuário.
 */
function guestProblem(guest, mainWindow) {
  if (!guest || (guest.isDestroyed && guest.isDestroyed())) return 'A página do YouTube Studio não está aberta. Abra a tela Envio.';
  let type = '';
  try { type = guest.getType(); } catch (_) { /* indisponível */ }
  if (type !== 'webview') return 'A página informada não é a do YouTube Studio.';
  if (mainWindow && guest.hostWebContents && guest.hostWebContents.id !== mainWindow.webContents.id) return 'A página do YouTube Studio pertence a outra janela.';
  let host = '';
  try { host = new URL(guest.getURL()).hostname; } catch (_) { /* URL vazia */ }
  if (host === 'accounts.google.com') return 'Entre na sua conta do YouTube na página ao lado antes de iniciar a fila.';
  if (host !== 'studio.youtube.com') return 'Abra o YouTube Studio na página ao lado antes de iniciar a fila.';
  return null;
}

/**
 * Varredura de pastas/arquivos de vídeo e fila de envio automático para o YouTube Studio (aba Envio).
 * `deps` = { uploadScannerService, youtubeUploadQueue, settingsManager, getMainWindow }.
 */
module.exports = function registerUploadHandlers({ uploadScannerService, youtubeUploadQueue, settingsManager, getMainWindow }) {
  const win = () => getMainWindow() || BrowserWindow.getFocusedWindow();
  const openDialog = (options) => { const w = win(); return w ? dialog.showOpenDialog(w, options) : dialog.showOpenDialog(options); };

  handle('upload:scanDirectory', async (_, customDir) => {
    const settings = settingsManager.load();
    // Caminho vindo do renderer precisa ser absoluto; o handler NÃO cria diretórios (só varre o que existe).
    const targetDir = customDir ? assertAbsolutePath(customDir, 'Pasta de uploads')
      : (settings.uploadsFolder || path.join(os.homedir(), 'Videos', 'Uploads'));
    let isDir = false;
    try { isDir = (await fs.promises.stat(targetDir)).isDirectory(); } catch (_) { /* inexistente */ }
    if (!isDir) return [];
    return uploadScannerService.scanDirectory(targetDir);
  });
  handle('upload:selectFolder', async () => {
    const result = await openDialog({ properties: ['openDirectory'] });
    if (!result.canceled && result.filePaths.length > 0) {
      const selectedDir = result.filePaths[0];
      settingsManager.save({ uploadsFolder: selectedDir });
      return uploadScannerService.scanDirectory(selectedDir);
    }
    return null;
  });
  handle('upload:selectFiles', async () => {
    const result = await openDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Vídeos', extensions: VIDEO_EXTENSIONS }]
    });
    if (!result.canceled && result.filePaths.length > 0) {
      // ffprobe em paralelo limitado a 3 (antes serial); a ordem da lista é preservada.
      const fileList = await mapLimit(result.filePaths, 3, async (filePath) => {
        const stats = await fs.promises.stat(filePath);
        const meta = await uploadScannerService.getVideoMetadata(filePath);
        return {
          id: Buffer.from(filePath).toString('base64'),
          name: path.basename(filePath),
          path: filePath,
          dir: path.dirname(filePath),
          sizeBytes: stats.size,
          sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime,
          ...meta
        };
      }, 3);
      return fileList;
    }
    return [];
  });

  // --- Fila de envio automático -----------------------------------------------------------------
  handle('upload:queue:get', () => youtubeUploadQueue.getState());

  handle('upload:queue:pick', async (_, meta) => {
    const result = await openDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Vídeos', extensions: VIDEO_EXTENSIONS }]
    });
    if (result.canceled || !result.filePaths.length) return [];
    return youtubeUploadQueue.add(result.filePaths, meta || {});
  });

  handle('upload:queue:add', (_, paths, meta) => {
    // Só arquivos de vídeo existentes, fora de pastas do sistema; caminhos ruins são ignorados (não derrubam o lote)
    const ok = [];
    for (const p of paths) {
      try {
        const file = assertUserFile(p, 'Vídeo');
        if (VIDEO_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase())) ok.push(file);
      } catch (_) { /* ignorado */ }
    }
    return youtubeUploadQueue.add(ok, meta || {});
  });

  handle('upload:queue:update', (_, id, meta) => {
    const patch = { ...(meta || {}) };
    // Miniatura: '' remove; caminho precisa ser uma imagem existente
    if (typeof patch.thumbnail === 'string' && patch.thumbnail.trim()) {
      let file;
      try { file = assertUserFile(patch.thumbnail, 'Miniatura'); } catch (err) { return { ok: false, error: err.message }; }
      if (!IMAGE_EXTENSIONS.includes(path.extname(file).toLowerCase())) return { ok: false, error: 'A miniatura precisa ser JPG, PNG ou WEBP.' };
      patch.thumbnail = file;
    }
    return youtubeUploadQueue.update(id, patch);
  });

  handle('upload:queue:pickThumbnail', async (_, id) => {
    const result = await openDialog({
      properties: ['openFile'],
      filters: [{ name: 'Imagens', extensions: IMAGE_EXTENSIONS.map((e) => e.slice(1)) }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };
    const r = youtubeUploadQueue.update(id, { thumbnail: result.filePaths[0] });
    return r.ok ? { ok: true, thumbnail: result.filePaths[0] } : r;
  });

  handle('upload:queue:setDefaults', (_, defaults) => {
    const { applyToQueued, ...patch } = defaults || {};
    return youtubeUploadQueue.setDefaults(patch, { applyToQueued: applyToQueued === true });
  });
  handle('upload:queue:remove', (_, id) => youtubeUploadQueue.remove(id));
  handle('upload:queue:retry', (_, id) => youtubeUploadQueue.retry(id));

  handle('upload:queue:start', (_, webContentsId) => {
    const guest = webContents.fromId(webContentsId);
    const problem = guestProblem(guest, getMainWindow());
    if (problem) return { ok: false, error: problem };
    const YoutubeStudioDriver = require('../core/uploads/YoutubeStudioDriver');
    let driver;
    try { driver = new YoutubeStudioDriver(guest, { logger }); } catch (err) { return { ok: false, error: err.message }; }
    return youtubeUploadQueue.start(driver);
  });
  handle('upload:queue:pause', () => youtubeUploadQueue.pause());
  handle('upload:queue:skipWait', () => youtubeUploadQueue.skipWait());
  handle('upload:queue:clearCompleted', () => youtubeUploadQueue.clearCompleted());
};

module.exports.guestProblem = guestProblem;
