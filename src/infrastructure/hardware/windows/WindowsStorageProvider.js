'use strict';

const { execOffThread } = require('../offThreadExec'); // criação do powershell fora do processo principal
const fs = require('node:fs');
const { copyFileUnique } = require('../copyUnique');
const path = require('node:path');
const { StorageProvider } = require('../StorageProvider');
const { systemExe } = require('../systemExe');
const logger = require('../../../services/logService');

/** Tempo máximo da enumeração. O leitor de cartão vazio de alguns computadores leva ~2 s só para dizer "sem mídia". */
const ENUMERATE_TIMEOUT_MS = 20000;

/**
 * Script que lista as unidades removíveis COM mídia. Parte dos discos físicos (Win32_DiskDrive, rápido) e só então
 * pergunta pelas letras deles: consultar o tamanho de um leitor de cartão vazio (Win32_LogicalDisk) trava de 2 a 8 s.
 * Entram discos em barramento USB (cartão, pen drive, SSD/HD externo, câmera em modo de armazenamento) e discos que
 * se declaram removíveis; discos internos ficam de fora.
 */
const DRIVES_SCRIPT = `
$ErrorActionPreference = 'Stop'
$rows = @()
$disks = @(Get-CimInstance Win32_DiskDrive | Where-Object {
    ($_.InterfaceType -eq 'USB' -or $_.MediaType -match 'Removable|External' -or $_.PNPDeviceID -like 'USBSTOR*') -and $_.Size -gt 0
})
foreach ($disk in $disks) {
    foreach ($part in @(Get-CimAssociatedInstance -InputObject $disk -Association Win32_DiskDriveToDiskPartition)) {
        foreach ($ld in @(Get-CimAssociatedInstance -InputObject $part -Association Win32_LogicalDiskToPartition)) {
            $rows += [pscustomobject]@{ id = $ld.DeviceID; name = $ld.VolumeName; size = $ld.Size; free = $ld.FreeSpace; model = $disk.Model }
        }
    }
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -Compress -InputObject @($rows)
`;

/**
 * Converte a saída do script nos dispositivos da tela. Só entra unidade com letra e tamanho (leitor vazio não é dispositivo).
 * @param {string} stdout JSON (lista, objeto único ou vazio)
 * @returns {Array<{id, name, type, storage}>}
 * @throws {Error} se o texto não for JSON válido
 */
function parseDrives(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  let rows = JSON.parse(text);
  if (!Array.isArray(rows)) rows = [rows];
  const seen = new Set();
  const out = [];
  for (const d of rows) {
    if (!d || !/^[A-Za-z]:$/.test(String(d.id || ''))) continue;
    const letter = String(d.id).toUpperCase();
    if (seen.has(letter) || d.name === 'PMHOME') continue; // PMHOME: volume virtual da câmera (PlayMemories), não é mídia
    const size = Number(d.size);
    if (!Number.isFinite(size) || size <= 0) continue;
    seen.add(letter);
    out.push({
      id: letter,
      name: d.name ? String(d.name) : `Unidade USB (${letter})`,
      type: 'usb',
      storage: [{ name: 'Mass Storage', path: `${letter}\\`, capacity: size, free: Number(d.free) || 0 }]
    });
  }
  return out;
}

/**
 * WindowsStorageProvider — Implementacao Windows-only do provider USB/Mass Storage.
 *
 * Encapsula TODA a logica de PowerShell / CIM para enumeracao de unidades
 * removiveis (cartoes SD, pendrives, discos USB) no Windows.
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
   * Lista as unidades removiveis com midia (cartao, pen drive, disco USB).
   * Falhou (tempo esgotado, PowerShell indisponivel): REJEITA, para o chamador nao confundir "deu erro" com "nao ha nada".
   * @returns {Promise<Array<{id, name, type, storage}>>}
   */
  getDevices() {
    return new Promise((resolve, reject) => {
      const encodedCommand = Buffer.from(DRIVES_SCRIPT, 'utf16le').toString('base64');
      execOffThread(
        `"${systemExe('powershell')}" -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`,
        { encoding: 'utf8', timeout: ENUMERATE_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if (error) {
            logger.error('WindowsStorageProvider:getDevices:error', { error: error.message });
            return reject(new Error(error.killed || /timed out|ETIMEDOUT/i.test(error.message) ? 'A consulta às unidades demorou demais.' : 'Não foi possível consultar as unidades.'));
          }
          try {
            resolve(parseDrives(stdout));
          } catch (e) {
            logger.error('WindowsStorageProvider:getDevices:parse_error', { error: e.message });
            reject(new Error('Resposta inesperada ao consultar as unidades.'));
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

module.exports = { WindowsStorageProvider, parseDrives, DRIVES_SCRIPT, ENUMERATE_TIMEOUT_MS };
