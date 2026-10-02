const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const {
  assertNonEmpty, assertSafeFileName, assertUserDirectory, assertPrivateIp, assertPort
} = require('./validate');

const DEFAULT_BDSM_PORT = 8080;
const MAX_IMPORT_ITEMS = 5000;
const DOWNLOAD_TIMEOUT_MS = 30000; // sem resposta/cabeçalhos em 30s → aborta o item

/** Valida o par ip/porta de um dispositivo BDSM (IP literal privado/loopback/link-local). */
function validateEndpoint(ip, port) {
  return {
    ip: assertPrivateIp(ip),
    port: port == null || port === '' ? DEFAULT_BDSM_PORT : assertPort(port)
  };
}

/** Evita sobrescrever um arquivo existente no destino. */
function uniqueDestination(dir, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  for (let n = 1; fs.existsSync(candidate); n++) {
    if (n > 9999) throw new Error('Não foi possível gerar um nome livre no destino.');
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

module.exports = function registerDeviceHandlers(logger, lutSyncService) {
  const BdsmClient = require('../core/devices/BdsmClient');

  ipcMain.handle('bdsm:getMedia', async (_, ip, port) => {
      const ep = validateEndpoint(ip, port);
      const client = new BdsmClient(ep.ip, ep.port);
      return await client.getMedia();
  });

  ipcMain.handle('bdsm:getImportHistory', async (_, deviceId) => {
      const dbManager = require('../core/database/database');
      const db = dbManager.get();
      const stmt = db.prepare(`SELECT filename FROM sync_history WHERE device_id = ?`);
      const rows = stmt.all(deviceId);
      return rows.map(r => r.filename);
  });

  // Retorna o número de itens importados (compatível com o renderer); falhas por item vão para o log.
  ipcMain.handle('bdsm:importMedia', async (event, { ip, port, deviceId, items, destFolder, projectId } = {}) => {
      const dbManager = require('../core/database/database');
      const db = dbManager.get();
      let completed = 0;

      // [FASE 1.2] Validação de entrada
      const ep = validateEndpoint(ip, port);
      const destDir = assertUserDirectory(destFolder, 'Diretório de destino');
      assertNonEmpty(String(deviceId == null ? '' : deviceId), 'ID do dispositivo');
      if (!Array.isArray(items) || items.length === 0) return 0;
      if (items.length > MAX_IMPORT_ITEMS) throw new Error('Itens demais em uma única importação.');

      const client = new BdsmClient(ep.ip, ep.port);
      const failures = [];

      for (const item of items) {
          let tmpPath = null;
          try {
              if (!item || typeof item !== 'object') throw new Error('Item inválido.');
              const name = assertSafeFileName(item.name);
              if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(item.id))) throw new Error('ID de mídia inválido.');

              event.sender.send('bdsm:progress', { completed, total: items.length, current: name });

              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
              let response;
              try {
                  response = await fetch(client.getMediaDownloadUrl(item.id), { signal: controller.signal });
              } finally {
                  clearTimeout(timer);
              }
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              if (!response.body) throw new Error('Resposta sem conteúdo.');

              // Baixa em stream para um .part e só então publica com o nome final (sem sobrescrever)
              const destPath = uniqueDestination(destDir, name);
              tmpPath = `${destPath}.part`;
              await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmpPath, { flags: 'w' }));
              fs.renameSync(tmpPath, destPath);
              tmpPath = null;

              db.prepare(`INSERT INTO sync_history (device_id, filename, hash, project_id) VALUES (?, ?, ?, ?)`).run(deviceId, name, typeof item.hash === 'string' ? item.hash : '', projectId || null);

              completed++;
          } catch(e) {
              failures.push({ name: item && item.name, error: e.message });
              logger.error(`[BDSM Import] Falha ao importar ${item && item.name}: ${e.message}`);
              if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) { /* parcial já removido */ } }
          }
      }
      if (failures.length) logger.warn('[BDSM Import] Itens com falha', { count: failures.length, total: items.length });
      return completed;
  });

  ipcMain.handle('bdsm:analyzeLutSync', async (_, ip, port) => {
      const ep = validateEndpoint(ip, port);
      return await lutSyncService.analyzeSync(ep.ip, ep.port);
  });

  ipcMain.handle('bdsm:executeLutSync', async (event, { ip, port, plan } = {}) => {
      const ep = validateEndpoint(ip, port);
      if (!plan || typeof plan !== 'object') throw new Error('Plano de sincronização inválido.');

      // Listener próprio, removido ao final (não derruba listeners de outros consumidores).
      const onProgress = (data) => {
          try { if (!event.sender.isDestroyed()) event.sender.send('bdsm:lutSyncProgress', data); } catch (_) { /* janela fechada */ }
      };
      lutSyncService.on('progress', onProgress);
      try {
          await lutSyncService.executeSync(ep.ip, ep.port, plan);
      } finally {
          lutSyncService.off('progress', onProgress);
      }
      return true;
  });
};
