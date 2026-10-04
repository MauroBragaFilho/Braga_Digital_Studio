const { handle } = require('./channelRegistry');
const fs = require('fs');
const path = require('path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const {
  assertNonEmpty, assertSafeFileName, assertAbsolutePath, isDriveRoot, assertPrivateIp, assertPort
} = require('./validate');

const DEFAULT_BDSM_PORT = 8080;
const MAX_IMPORT_ITEMS = 5000;
const DOWNLOAD_TIMEOUT_MS = 30000; // sem resposta/cabeçalhos em 30s → aborta o item
const FATAL_CODES = new Set(['PAIRING_REQUIRED', 'DEVICE_UNREACHABLE']); // não adianta tentar o próximo item

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

/**
 * Erros do celular chegam ao renderer como "BDSM:<CÓDIGO>:<mensagem>": o Electron só transporta a mensagem
 * (o `code` se perde), e a tela precisa distinguir PAIRING_REQUIRED de "sem conexão" etc.
 */
function toIpcError(err) {
  if (err && err.name === 'BdsmError') return new Error(`BDSM:${err.code}:${err.message}`);
  return err;
}

async function guarded(fn) {
  try { return await fn(); } catch (err) { throw toIpcError(err); }
}

module.exports = function registerDeviceHandlers(logger, lutSyncService) {
  const BdsmClient = require('../core/devices/BdsmClient');
  const { getPairing } = require('../core/integrations/bdsm/BdsmPairing');
  const pairing = getPairing();

  handle('bdsm:getMedia', (_, ip, port) => guarded(async () => {
      const ep = validateEndpoint(ip, port);
      const client = new BdsmClient(ep.ip, ep.port);
      return await client.getMedia(); // { id, name, size, duration, ... } (o celular usa filename/filesize)
  }));

  handle('bdsm:getImportHistory', async (_, deviceId) => {
      const dbManager = require('../core/database/database');
      const db = dbManager.get();
      const stmt = db.prepare(`SELECT filename FROM sync_history WHERE device_id = ?`);
      const rows = stmt.all(deviceId);
      return rows.map(r => r.filename);
  });

  // Retorna o número de itens importados (compatível com o renderer); falhas por item vão para o log.
  // Todos falharam: lança o motivo real (pareamento necessário, sem conexão...) para a tela explicar.
  handle('bdsm:importMedia', (event, { ip, port, deviceId, items, destFolder, projectId } = {}) => guarded(async () => {
      const dbManager = require('../core/database/database');
      const db = dbManager.get();
      let completed = 0;

      // [FASE 1.2] Validação de entrada
      const ep = validateEndpoint(ip, port);
      // A pasta padrão (BDSM DEVICES) pode ainda não existir na primeira importação: valida e cria.
      const destDir = assertAbsolutePath(destFolder, 'Diretório de destino');
      if (isDriveRoot(destDir)) throw new Error('Diretório de destino não pode ser a raiz de um drive.');
      fs.mkdirSync(destDir, { recursive: true });
      assertNonEmpty(String(deviceId == null ? '' : deviceId), 'ID do dispositivo');
      if (!Array.isArray(items) || items.length === 0) return 0;
      if (items.length > MAX_IMPORT_ITEMS) throw new Error('Itens demais em uma única importação.');

      const client = new BdsmClient(ep.ip, ep.port);
      const failures = [];
      let firstError = null;

      for (const item of items) {
          let tmpPath = null;
          try {
              if (!item || typeof item !== 'object') throw new Error('Item inválido.');
              const name = assertSafeFileName(item.name);
              if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(item.id))) throw new Error('ID de mídia inválido.');

              event.sender.send('bdsm:progress', { completed, total: items.length, current: name });

              const response = await client.openMediaDownload(item.id, { timeout: DOWNLOAD_TIMEOUT_MS });
              if (!response.body) throw new Error('Resposta sem conteúdo.');
              const expected = Number(response.headers.get('content-length') || 0);

              // Baixa em stream para um .part e só então publica com o nome final (sem sobrescrever)
              const destPath = uniqueDestination(destDir, name);
              tmpPath = `${destPath}.part`;
              await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmpPath, { flags: 'w' }));
              if (expected > 0 && fs.statSync(tmpPath).size !== expected) throw new Error('Download incompleto (o tamanho recebido difere do informado pelo celular).');
              fs.renameSync(tmpPath, destPath);
              tmpPath = null;

              db.prepare(`INSERT INTO sync_history (device_id, filename, hash, project_id) VALUES (?, ?, ?, ?)`).run(deviceId, name, typeof item.hash === 'string' ? item.hash : '', projectId || null);

              completed++;
          } catch(e) {
              failures.push({ name: item && item.name, error: e.message });
              if (!firstError) firstError = e;
              logger.error(`[BDSM Import] Falha ao importar ${item && item.name}: ${e.code || ''} ${e.message}`);
              if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) { /* parcial já removido */ } }
              if (e && FATAL_CODES.has(e.code)) break; // sem pareamento/sem conexão: os próximos também falhariam
          }
      }
      if (failures.length) logger.warn('[BDSM Import] Itens com falha', { count: failures.length, total: items.length });
      if (completed === 0 && firstError) throw firstError;
      return completed;
  }));

  handle('bdsm:analyzeLutSync', (_, ip, port) => guarded(async () => {
      const ep = validateEndpoint(ip, port);
      return await lutSyncService.analyzeSync(ep.ip, ep.port);
  }));

  handle('bdsm:executeLutSync', (event, { ip, port, plan } = {}) => guarded(async () => {
      const ep = validateEndpoint(ip, port);
      if (!plan || typeof plan !== 'object') throw new Error('Plano de sincronização inválido.');

      // Listener próprio, removido ao final (não derruba listeners de outros consumidores).
      const onProgress = (data) => {
          try { if (!event.sender.isDestroyed()) event.sender.send('bdsm:lutSyncProgress', data); } catch (_) { /* janela fechada */ }
      };
      lutSyncService.on('progress', onProgress);
      try {
          return await lutSyncService.executeSync(ep.ip, ep.port, plan);
      } finally {
          lutSyncService.off('progress', onProgress);
      }
  }));

  // --- Pareamento ----------------------------------------------------------------------------
  // O token só existe no processo principal (BdsmAuth); o renderer recebe estado, código e tempo restante.

  handle('bdsm:pairingStatus', (_, ip, port) => guarded(async () => {
      const ep = validateEndpoint(ip, port);
      return await pairing.status(ep.ip, ep.port);
  }));

  handle('bdsm:pairStart', (event, ip, port) => guarded(async () => {
      const ep = validateEndpoint(ip, port);
      const sender = event.sender;
      const emit = (payload) => {
          try { if (!sender.isDestroyed()) sender.send('bdsm:pairing', payload); } catch (_) { /* janela fechada */ }
      };
      return await pairing.start(ep.ip, ep.port, emit);
  }));

  handle('bdsm:pairCancel', (_, ip, port) => {
      const ep = validateEndpoint(ip, port);
      return pairing.cancel(ep.ip, ep.port);
  });

  handle('bdsm:pairForget', (_, ip, port) => guarded(async () => {
      const ep = validateEndpoint(ip, port);
      return await pairing.forget(ep.ip, ep.port);
  }));

  // Miniatura buscada no processo principal (com o token) e entregue como data URL: o renderer nunca vê o token
  // nem precisa de uma URL autenticada (um <img src> com ?token= vazaria o token em log, cache e DevTools).
  handle('bdsm:getThumbnail', (_, ip, port, id) => guarded(async () => {
      const ep = validateEndpoint(ip, port);
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(id))) throw new Error('ID de mídia inválido.');
      const { buffer, contentType } = await new BdsmClient(ep.ip, ep.port).getThumbnail(id);
      return `data:${contentType};base64,${buffer.toString('base64')}`;
  }));
};
