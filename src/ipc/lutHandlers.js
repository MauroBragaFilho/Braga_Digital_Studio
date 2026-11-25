'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dialog, shell, BrowserWindow } = require('electron');
const { handle } = require('./channelRegistry');
const CubeParser = require('../core/luts/CubeParser');
const LutImporter = require('../core/luts/LutImporter');
const { userMessage, LutUserError } = require('../core/luts/lutErrors');
const logger = require('../services/logService');

const RAW_CONTENT_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const REFERENCE_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_MIMES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const UNC_OR_DEVICE_PATH = /^[\\/]{2}/; // \\servidor\pasta, //servidor/pasta e \\?\...

const MSG_OPEN_FOLDER = 'Não foi possível abrir a pasta das LUTs.';
const MSG_READ = 'Não foi possível ler esta LUT.';
const MSG_SCAN = 'Não foi possível procurar as LUTs.';
const MSG_IMPORT = 'Não foi possível importar as LUTs.';
const MSG_RENAME = 'Não foi possível renomear a LUT.';
const MSG_DELETE = 'Não foi possível excluir a LUT.';
const MSG_REVEAL = 'Não foi possível mostrar a LUT na pasta.';
const MSG_RENAME_FOLDER = 'Não foi possível renomear a pasta.';
const MSG_DELETE_FOLDER = 'Não foi possível excluir a pasta.';
const MSG_DELETE_MANY = 'Não foi possível excluir as LUTs.';
const MSG_INFO = 'Não foi possível ler a pasta de LUTs.';

/** Envia um evento de progresso à janela que pediu a operação (ignora janela fechada). */
function sendProgressTo(channel, event) {
  return (payload) => {
    try {
      const sender = event && event.sender;
      if (!sender || typeof sender.send !== 'function') return;
      if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return;
      sender.send(channel, payload);
    } catch (_) { /* janela fechada */ }
  };
}

// Os canais luts:parse/getHeader/load/reveal só leem LUTs DA COLEÇÃO: o esquema (t.cube) exige caminho absoluto .cube
// e o LutManager.assertFileInside confere que o arquivo está estritamente dentro da pasta de LUTs.

/**
 * Registra todos os handlers IPC do domínio de LUTs (.cube).
 * @param {import('../core/luts/LutManager')} lutManager
 * @param {{ settingsManager?: { load: () => object } }} [deps]
 *   settingsManager: de onde sai a imagem de referência salva
 */
module.exports = function registerLutHandlers(lutManager, { settingsManager = null } = {}) {
  const importer = new LutImporter(lutManager);

  // { ok: true, ... } com os dados, ou { ok: false, code, reason } quando o conteúdo do .cube é inválido.
  // Erro de acesso (arquivo fora da coleção, inexistente) continua rejeitando a chamada.
  handle('luts:parse', async (_, filePath) => {
    const safe = lutManager.assertFileInside(filePath);
    try {
      return { ok: true, path: filePath, name: path.basename(filePath), ...CubeParser.parse(safe) };
    } catch (error) {
      if (error instanceof CubeParser.CubeError) return { ok: false, code: error.code, reason: error.message };
      logger.error('IPC:luts:parse:error', { error: error.message });
      throw new Error(MSG_READ);
    }
  });

  handle('luts:load', async (_, filePath) => {
    const safe = lutManager.assertFileInside(filePath);
    try {
      const stats = fs.statSync(safe);

      if (stats.size <= RAW_CONTENT_MAX_BYTES) {
        const content = fs.readFileSync(safe, 'utf-8');
        return { rawContent: content, truncated: false, totalBytes: stats.size };
      }

      const fd = fs.openSync(safe, 'r');
      try {
        const buffer = Buffer.alloc(RAW_CONTENT_MAX_BYTES);
        const bytesRead = fs.readSync(fd, buffer, 0, RAW_CONTENT_MAX_BYTES, 0);
        const content = buffer.toString('utf-8', 0, bytesRead);
        return { rawContent: content, truncated: true, totalBytes: stats.size };
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      logger.error('IPC:luts:load:error', { error: error.message });
      throw new Error(MSG_READ);
    }
  });

  handle('luts:getHeader', async (_, filePath) => {
    const safe = lutManager.assertFileInside(filePath);
    try {
      return { ok: true, path: filePath, name: path.basename(filePath), ...CubeParser.parseHeader(safe) };
    } catch (error) {
      if (error instanceof CubeParser.CubeError) return { ok: false, code: error.code, reason: error.message };
      logger.error('IPC:luts:getHeader:error', { error: error.message });
      throw new Error(MSG_READ);
    }
  });

  // { folder, items, problems }: `problems` lista o que não pôde ser lido, sem esconder as demais LUTs.
  handle('luts:list', async () => ({ folder: lutManager.lutsDir, ...lutManager.listDetailed() }));

  // Resumo da coleção para as Configurações: { folder, count, groups, problems, problemCount }.
  handle('luts:getInfo', async () => {
    try {
      return lutManager.getInfo();
    } catch (err) {
      logger.error('IPC:luts:getInfo:error', { error: err.message });
      throw new Error(MSG_INFO);
    }
  });

  // Abre no gerenciador de arquivos a pasta da coleção (cria a pasta se ainda não existir) ou, com `relPath`, uma
  // subpasta dela (só pasta comum que está dentro da coleção; para um arquivo use luts:reveal).
  handle('luts:openFolder', async (_, relPath) => {
    try {
      let target = lutManager.lutsDir;
      if (relPath) target = lutManager.assertFolderInside(relPath);
      else fs.mkdirSync(lutManager.lutsDir, { recursive: true });
      const failure = await shell.openPath(target);
      if (failure) throw new Error(failure);
      return true;
    } catch (err) {
      logger.error('IPC:luts:openFolder:error', { error: err.message });
      throw new Error(userMessage(err, MSG_OPEN_FOLDER));
    }
  });

  // Procura as LUTs para importar, sem copiar nada. O diálogo (pasta ou arquivos) abre SEMPRE aqui, no processo
  // principal; a tela só informa o modo. Com `paths` (arrastar-e-soltar) valida e usa esses caminhos. O progresso
  // vai pelo evento luts:scanProgress; o retorno é o resumo ({ scanId, summary, items }) ou { canceled: true }.
  handle('luts:scan', async (event, paths, options) => {
    try {
      let list = paths;
      let source = 'drop';
      if (!Array.isArray(paths)) {
        const win = BrowserWindow.getFocusedWindow();
        const picked = await dialog.showOpenDialog(win, options && options.mode === 'files'
          ? { title: 'Importar LUTs (.cube)', filters: [{ name: 'LUTs', extensions: ['cube'] }], properties: ['openFile', 'multiSelections'] }
          : { title: 'Importar LUTs de uma pasta', properties: ['openDirectory'] });
        if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
        list = picked.filePaths;
        source = 'dialog';
      }
      return await importer.scan({ paths: list, source, onProgress: sendProgressTo('luts:scanProgress', event) });
    } catch (err) {
      logger.error('IPC:luts:scan:error', { error: err.message });
      throw new Error(userMessage(err, MSG_SCAN));
    }
  });

  handle('luts:cancelScan', async (_, scanId) => importer.cancelScan(scanId));

  // Copia só as LUTs marcadas do resumo (chaves do resumo; nenhum caminho vem da tela).
  handle('luts:importScanned', async (event, scanId, keys, options) => {
    try {
      return await importer.commit(
        scanId,
        keys,
        { keepFolders: !options || options.keepFolders !== false, rootGroup: (options && options.rootGroup) || null },
        { onProgress: sendProgressTo('luts:importProgress', event) }
      );
    } catch (err) {
      logger.error('IPC:luts:importScanned:error', { error: err.message });
      throw new Error(userMessage(err, MSG_IMPORT));
    }
  });

  handle('luts:cancelImport', async (_, scanId) => importer.cancelImport(scanId));

  handle('luts:renameFolder', async (_, relPath, newName) => {
    try {
      return await lutManager.renameFolder(relPath, newName);
    } catch (err) {
      logger.error('IPC:luts:renameFolder:error', { error: err.message });
      throw new Error(userMessage(err, MSG_RENAME_FOLDER));
    }
  });

  // Manda as LUTs da pasta (uma a uma) para a Lixeira; `dryRun` só conta o que há ({ luts, others }) para a confirmação.
  handle('luts:deleteFolder', async (_, relPath, dryRun) => {
    try {
      return await lutManager.deleteFolder(relPath, (p) => shell.trashItem(p), { dryRun: dryRun === true });
    } catch (err) {
      logger.error('IPC:luts:deleteFolder:error', { error: err.message });
      throw new Error(userMessage(err, MSG_DELETE_FOLDER));
    }
  });

  // Sem argumento abre o seletor de arquivos; com uma lista de caminhos (arrastar-e-soltar) importa direto, para a
  // raiz da coleção, sem resumo (a tela usa luts:scan + luts:importScanned). Caminho de rede é recusado.
  // Retorna false se o usuário cancelou, ou { imported, renamed, duplicates, invalid }.
  handle('luts:import', async (_, droppedPaths) => {
    try {
      let filePaths = Array.isArray(droppedPaths) ? droppedPaths.filter((p) => typeof p === 'string' && !UNC_OR_DEVICE_PATH.test(p)) : null;
      if (!filePaths) {
        const win = BrowserWindow.getFocusedWindow();
        const picked = await dialog.showOpenDialog(win, {
          title: 'Importar LUT (.cube)',
          filters: [{ name: 'LUTs', extensions: ['cube'] }],
          properties: ['openFile', 'multiSelections']
        });
        if (picked.canceled || picked.filePaths.length === 0) return false;
        filePaths = picked.filePaths;
      }
      return lutManager.importFiles(filePaths);
    } catch (err) {
      logger.error('IPC:luts:import:error', { error: err.message });
      throw new Error(userMessage(err, MSG_IMPORT));
    }
  });

  handle('luts:rename', async (_, oldPath, newName) => {
    try {
      return lutManager.rename(oldPath, newName);
    } catch (err) {
      logger.error('IPC:luts:rename:error', { error: err.message });
      throw new Error(userMessage(err, MSG_RENAME));
    }
  });

  handle('luts:delete', async (_, filePath) => {
    try {
      // Vai para a lixeira do sistema: o usuário pode recuperar se excluir sem querer.
      return await lutManager.delete(filePath, (p) => shell.trashItem(p));
    } catch (err) {
      logger.error('IPC:luts:delete:error', { error: err.message });
      throw new Error(userMessage(err, MSG_DELETE));
    }
  });

  // Exclusão em lote (seleção múltipla): uma operação só, cada LUT conferida dentro da coleção, tudo para a Lixeira.
  // Devolve { trashed, missing, failed: [{ path, reason }] }; falha em uma LUT não impede as outras.
  handle('luts:deleteMany', async (_, paths) => {
    try {
      return await lutManager.deleteMany(paths, (p) => shell.trashItem(p));
    } catch (err) {
      logger.error('IPC:luts:deleteMany:error', { error: err.message });
      throw new Error(userMessage(err, MSG_DELETE_MANY));
    }
  });

  // Imagem de referência escolhida nas Configurações, como data URL (o canvas precisa ler os pixels,
  // o que um <img src="file://..."> bloquearia). Só atende ao caminho SALVO nas Configurações (comparado pelo
  // caminho real) e recusa caminho de rede. Retorna null se não for uma imagem utilizável.
  handle('luts:getReferenceImage', async (_, filePath) => {
    try {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || UNC_OR_DEVICE_PATH.test(filePath)) return null;
      const mime = IMAGE_MIMES[path.extname(filePath).toLowerCase()];
      if (!mime || !isSavedReferenceImage(filePath)) return null;
      if (!fs.existsSync(filePath)) return null;
      if (fs.statSync(filePath).size > REFERENCE_IMAGE_MAX_BYTES) return null;
      return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
    } catch (err) {
      logger.warn?.('IPC:luts:getReferenceImage:error', { error: err.message });
      return null;
    }
  });

  handle('luts:reveal', async (_, filePath) => {
    try {
      shell.showItemInFolder(lutManager.assertFileInside(filePath));
      return true;
    } catch (err) {
      logger.error('IPC:luts:reveal:error', { error: err.message });
      throw new Error(userMessage(err, MSG_REVEAL));
    }
  });

  /** true se `filePath` é a imagem de referência que está salva nas Configurações. */
  function isSavedReferenceImage(filePath) {
    let saved = '';
    try {
      const value = settingsManager && typeof settingsManager.load === 'function' ? settingsManager.load().lutPreviewImage : '';
      saved = typeof value === 'string' ? value : '';
    } catch (_) { return false; }
    if (!saved || UNC_OR_DEVICE_PATH.test(saved)) return false;
    let a;
    let b;
    try { a = fs.realpathSync.native(filePath); b = fs.realpathSync.native(saved); } catch (_) { return false; }
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
};
