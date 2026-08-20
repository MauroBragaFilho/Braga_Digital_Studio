'use strict';

const { exec } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { StorageProvider } = require('../StorageProvider');
const logger = require('../../../services/logService');

/**
 * WindowsStorageProvider — Implementacao Windows-only do provider USB/Mass Storage.
 *
 * Encapsula TODA a logica de PowerShell / CIM para enumeracao de unidades
 * removiveis (cartoes SD, pendrives) no Windows via Win32_LogicalDisk.
 *
 * A listagem de pasta e importacao de arquivos usam o Node.js fs nativo
 * (multiplataforma), sem PowerShell — o PowerShell so e necessario na
 * enumeracao de dispositivos (GetDevices).
 *
 * Regra do roadmap (Sprint 5):
 *   Nenhum arquivo fora de src/infrastructure/hardware/windows/ deve conter
 *   chamadas a powershell.exe para dispositivos USB/Storage.
 */
class WindowsStorageProvider extends StorageProvider {
  /**
   * Lista drives removiveis USB via CIM Win32_LogicalDisk.
   * @returns {Promise<Array<{id, name, type, storage}>>}
   */
  async getDevices() {
    return new Promise((resolve) => {
      const psScript = `
$disks = Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 -and $_.VolumeName -ne "PMHOME" }
$results = @()
foreach ($disk in $disks) {
    $results += @{
        id = $disk.DeviceID
        name = if ($disk.VolumeName) { $disk.VolumeName } else { "Unidade USB ($($disk.DeviceID))" }
        capacity = $disk.Size
        free = $disk.FreeSpace
        type = "usb"
        path = "$($disk.DeviceID)\\"
    }
}
$results | ConvertTo-Json -Compress
      `;
      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
      exec(
        `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`,
        { encoding: 'utf8' },
        (error, stdout) => {
          if (error) {
            logger.error('WindowsStorageProvider:getDevices:error', { error: error.message });
            return resolve([]);
          }
          try {
            const str = stdout.trim();
            if (!str) return resolve([]);
            let parsed = JSON.parse(str);
            if (!Array.isArray(parsed)) parsed = [parsed];
            const devices = parsed.map(disk => ({
              id: disk.id,
              name: disk.name,
              type: 'usb',
              storage: [{
                name: 'Mass Storage',
                path: disk.path,
                capacity: disk.capacity || 0,
                free: disk.free || 0
              }]
            }));
            resolve(devices);
          } catch (e) {
            logger.error('WindowsStorageProvider:getDevices:parse_error', { error: e.message });
            resolve([]);
          }
        }
      );
    });
  }

  /**
   * Lista o conteudo de uma pasta via fs nativo (multiplataforma).
   * @param {string} basePath - Drive root (ex: 'E:\')
   * @param {string[]} pathArray - Subcaminhos
   * @returns {Promise<{success: boolean, items: Array}>}
   */
  async listFolder(basePath, pathArray) {
    try {
      let currentPath = basePath;
      for (const p of pathArray) {
        if (p) currentPath = path.join(currentPath, p);
      }
      if (!fs.existsSync(currentPath)) {
        return { success: false, items: [] };
      }
      const IGNORED = ['system volume information', 'info', 'mp_root', 'pmcademo', 'tweaklog.txt', 'avf_info'];
      const items = [];
      for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
        if (entry.name.startsWith('$') || IGNORED.includes(entry.name.toLowerCase())) continue;
        let size = 0;
        if (entry.isFile()) {
          try { size = fs.statSync(path.join(currentPath, entry.name)).size; } catch (_) {}
        }
        items.push({ name: entry.name, isFolder: entry.isDirectory(), size });
      }
      return { success: true, items };
    } catch (err) {
      logger.error('WindowsStorageProvider:listFolder:error', { error: err.message });
      return { success: false, items: [] };
    }
  }

  /**
   * Copia arquivos USB para destino local com rastreamento de progresso (via 'progress' event).
   * @param {string} basePath
   * @param {string[]} pathArray
   * @param {string[]} itemNames
   * @param {string} destFolder
   * @returns {Promise<boolean>}
   */
  async importItems(basePath, pathArray, itemNames, destFolder) {
    try {
      if (!fs.existsSync(destFolder)) {
        fs.mkdirSync(destFolder, { recursive: true });
      }
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
          readStream.on('error', (err) => { logger.error('WindowsStorageProvider:importItems:read_error', { error: err.message }); resCopy(); });
          writeStream.on('error', (err) => { logger.error('WindowsStorageProvider:importItems:write_error', { error: err.message }); resCopy(); });
          readStream.pipe(writeStream);
        });
      }
      return true;
    } catch (err) {
      logger.error('WindowsStorageProvider:importItems:error', { error: err.message });
      return false;
    }
  }
}

module.exports = { WindowsStorageProvider };
