'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { handle } = require('./channelRegistry');
const logger = require('../services/logService');
const { assertAbsolutePath } = require('./validate');
const sonyCameraService = require('../core/devices/SonyCameraService');
const dbManager = require('../core/database/database');

/** Integração com câmeras Sony. `deps` = { importQueue } (fila de importação da biblioteca). */
module.exports = function registerSonyHandlers({ importQueue }) {
  handle('sony:list', async (_, cameraId, options) => {
    const provider = sonyCameraService.getProvider(cameraId);
    if (!provider) return [];
    return await provider.list(options);
  });

  handle('sony:browse', async (_, cameraId, uri) => {
    const provider = sonyCameraService.getProvider(cameraId);
    if (!provider) return [];
    return await provider.browse(uri);
  });

  handle('sony:get-status', async (_, cameraId) => {
    const provider = sonyCameraService.getProvider(cameraId);
    if (!provider) return null;
    return await provider.getDeviceStatus();
  });

  handle('sony:import-items', async (event, payload) => {
    const { cameraId, items, destFolder } = payload || {};
    const provider = sonyCameraService.getProvider(cameraId);
    if (!provider) throw new Error(`Provider não encontrado para ${cameraId}`);

    // Validação de entrada: lista limitada de itens e pasta de destino absoluta (criada se necessário)
    if (!Array.isArray(items) || items.length === 0) return { imported: [], failed: [] };
    if (items.length > 5000) throw new Error('Itens demais em uma única importação.');
    const destDir = assertAbsolutePath(destFolder, 'Pasta de destino');
    if (path.parse(destDir).root === destDir) throw new Error('A pasta de destino não pode ser a raiz de um drive.');
    fs.mkdirSync(destDir, { recursive: true });

    const importedPaths = [];
    const failed = [];
    let index = 0;

    const sendProgress = (data) => {
      try { if (!event.sender.isDestroyed()) event.sender.send('sony:import-progress', data); } catch (_) { /* janela fechada */ }
    };

    for (const item of items) {
      index++;
      const label = item && (item.title || item.filename);
      try {
        if (!item || typeof item !== 'object') throw new Error('Item inválido.');
        let files = [];
        try {
          files = await provider.import(item, destDir, (progress) => {
            sendProgress({
              currentItem: label,
              itemIndex: index,
              totalItems: items.length,
              ...progress
            });
          });
        } catch (e) {
          // Falha no meio (ex.: o JPG baixou e o RAW não): o que já está no disco continua sendo indexado
          if (Array.isArray(e.partial)) files = e.partial;
          failed.push({ item: label, error: e.message });
          logger.error(`[Sony Import] Erro ao importar ${label}: ${e.message}`);
        }

        for (const filePath of files) {
          importedPaths.push(filePath);
          // Pipeline padrão da Library: enfileira importação com hash e FFProbe (falha aqui não invalida a cópia)
          try {
            if (importQueue) {
              const db = dbManager.get();
              let lib = db.prepare("SELECT * FROM libraries WHERE type = 'BDSM_DEVICE' OR type = 'DEVICE' LIMIT 1").get();
              if (!lib) {
                lib = db.prepare("SELECT * FROM libraries LIMIT 1").get();
              }
              if (lib) {
                importQueue.add({ libraryId: lib.id, path: filePath, event: 'CREATE' });
              }
            }
          } catch (qe) {
            logger.warn(`[Sony Import] Não foi possível indexar ${filePath}: ${qe.message}`);
          }
        }
      } catch (e) {
        failed.push({ item: label, error: e.message });
        logger.error(`[Sony Import] Erro ao importar ${label}: ${e.message}`);
      }
    }

    // Informa ao chamador os importados e as falhas por item (resultado parcial).
    return { imported: importedPaths, failed };
  });
};
