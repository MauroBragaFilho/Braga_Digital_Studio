'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const { StorageProvider } = require('../StorageProvider');
const logger = require('../../../services/logService');

/**
 * LinuxStorageProvider — Provider USB/Mass Storage para Linux.
 *
 * Usa lsblk para enumerar drives removiveis montados.
 * Listagem de pasta e copia de arquivo sao nativas via node:fs (identicas ao Windows).
 *
 * Regra do roadmap (Sprint 5):
 *   Nenhum arquivo fora de src/infrastructure/hardware/linux/ deve conter
 *   chamadas especificas de Linux para enumeracao de storage.
 */
class LinuxStorageProvider extends StorageProvider {
  /**
   * Lista drives removiveis montados via lsblk.
   * @returns {Promise<Array<{id, name, type, storage}>>}
   */
  async getDevices() {
    return new Promise((resolve) => {
      // lsblk -J -o NAME,LABEL,MOUNTPOINT,SIZE,FSTYPE retorna JSON
      exec(
        'lsblk -J -o NAME,LABEL,MOUNTPOINT,SIZE,HOTPLUG,FSTYPE 2>/dev/null',
        { encoding: 'utf8' },
        (error, stdout) => {
          if (error) {
            logger.error('LinuxStorageProvider:getDevices:error', { error: error.message });
            return resolve([]);
          }
          try {
            const data = JSON.parse(stdout);
            const devices = [];
            const walk = (nodes) => {
              for (const node of (nodes || [])) {
                if (node.hotplug === '1' && node.mountpoint && node.mountpoint !== '') {
                  devices.push({
                    id: node.name,
                    name: node.label || node.name,
                    type: 'usb',
                    storage: [{
                      name: 'Mass Storage',
                      path: node.mountpoint,
                      capacity: 0,
                      free: 0
                    }]
                  });
                }
                if (node.children) walk(node.children);
              }
            };
            walk(data.blockdevices);
            resolve(devices);
          } catch (e) {
            logger.error('LinuxStorageProvider:getDevices:parse_error', { error: e.message });
            resolve([]);
          }
        }
      );
    });
  }

  /**
   * Lista o conteudo de uma pasta via fs nativo.
   */
  async listFolder(basePath, pathArray) {
    try {
      let currentPath = basePath;
      for (const p of pathArray) {
        if (p) currentPath = path.join(currentPath, p);
      }
      if (!fs.existsSync(currentPath)) return { success: false, items: [] };
      const items = [];
      for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        let size = 0;
        if (entry.isFile()) {
          try { size = fs.statSync(path.join(currentPath, entry.name)).size; } catch (_) {}
        }
        items.push({ name: entry.name, isFolder: entry.isDirectory(), size });
      }
      return { success: true, items };
    } catch (err) {
      logger.error('LinuxStorageProvider:listFolder:error', { error: err.message });
      return { success: false, items: [] };
    }
  }

  /**
   * Copia arquivos para destino local com progresso via event 'progress'.
   */
  async importItems(basePath, pathArray, itemNames, destFolder) {
    try {
      if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });
      let currentPath = basePath;
      for (const p of pathArray) {
        if (p) currentPath = path.join(currentPath, p);
      }
      for (const itemName of itemNames) {
        const sourceFile = path.join(currentPath, itemName);
        const destFile = path.join(destFolder, itemName);
        if (!fs.existsSync(sourceFile)) continue;
        const stat = fs.statSync(sourceFile);
        if (stat.isDirectory()) continue;
        const totalSize = stat.size;
        let copiedSize = 0;
        await new Promise((resCopy) => {
          const readStream = fs.createReadStream(sourceFile);
          const writeStream = fs.createWriteStream(destFile);
          let lastUpdate = Date.now();
          readStream.on('data', (chunk) => {
            copiedSize += chunk.length;
            const now = Date.now();
            if (now - lastUpdate > 150 || copiedSize === totalSize) {
              lastUpdate = now;
              const percent = totalSize > 0 ? Math.round((copiedSize / totalSize) * 100) : 100;
              this.emit('progress', { file: itemName, percent, currentSize: copiedSize, totalSize, type: 'usb' });
            }
          });
          writeStream.on('finish', resCopy);
          readStream.on('error', (err) => { logger.error('LinuxStorageProvider:importItems:read_error', { error: err.message }); resCopy(); });
          writeStream.on('error', (err) => { logger.error('LinuxStorageProvider:importItems:write_error', { error: err.message }); resCopy(); });
          readStream.pipe(writeStream);
        });
      }
      return true;
    } catch (err) {
      logger.error('LinuxStorageProvider:importItems:error', { error: err.message });
      return false;
    }
  }
}

module.exports = { LinuxStorageProvider };
