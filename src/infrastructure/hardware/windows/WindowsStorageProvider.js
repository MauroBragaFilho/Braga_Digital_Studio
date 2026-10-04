'use strict';

const { execOffThread } = require('../offThreadExec'); // criação do powershell fora do processo principal
const fs = require('node:fs');
const { copyFileUnique } = require('../copyUnique');
const path = require('node:path');
const { StorageProvider } = require('../StorageProvider');
const { systemExe } = require('../systemExe');
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
      execOffThread(
        `"${systemExe('powershell')}" -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`,
        { encoding: 'utf8', timeout: 8000, windowsHide: true },
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
      let lastUpdate = 0;
      let allOk = true;
      for (const itemName of itemNames) {
        const sourceFile = path.join(currentPath, itemName);
        if (!fs.existsSync(sourceFile)) continue;
        if (fs.statSync(sourceFile).isDirectory()) continue;
        try {
          await copyFileUnique(sourceFile, destFolder, path.basename(itemName), (copied, total) => {
            const now = Date.now();
            if (now - lastUpdate > 150 || copied === total) {
              lastUpdate = now;
              const percent = total > 0 ? Math.round((copied / total) * 100) : 100;
              this.emit('progress', { file: itemName, percent, currentSize: copied, totalSize: total, type: 'usb' });
            }
          });
        } catch (err) {
          allOk = false;
          logger.error('WindowsStorageProvider:importItems:copy_error', { file: itemName, error: err.message });
        }
      }
      // false se algum arquivo falhou: a tela avisa em vez de dizer que concluiu
      return allOk;
    } catch (err) {
      logger.error('WindowsStorageProvider:importItems:error', { error: err.message });
      return false;
    }
  }
}

module.exports = { WindowsStorageProvider };
