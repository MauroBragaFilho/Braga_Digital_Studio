'use strict';

/**
 * UsbService — Fachada de compatibilidade para acesso a drives USB/Mass Storage.
 *
 * SPRINT 5: Todo o codigo de PowerShell (CIM Win32_LogicalDisk) foi migrado para
 *   src/infrastructure/hardware/windows/WindowsStorageProvider.js
 *
 * Este arquivo agora delega integralmente ao DeviceManager, mantendo a mesma
 * API publica para que main.js e handlers IPC nao precisem de alteracoes.
 */
const { deviceManager } = require('../infrastructure/hardware/DeviceManager');

class UsbService {
  /** Propaga eventos de progresso do DeviceManager */
  on(event, listener) {
    deviceManager.on(event, listener);
    return this;
  }

  off(event, listener) {
    deviceManager.off(event, listener);
    return this;
  }

  /** Lista drives USB/removiveis conectados. */
  getDevices() {
    return deviceManager.getStorageDevices();
  }

  /** Lista o conteudo de uma pasta no drive USB. */
  listFolder(basePath, pathArray) {
    return deviceManager.listStorageFolder(basePath, pathArray);
  }

  /** Importa arquivos do drive USB para o disco local. */
  importItems(basePath, pathArray, itemNames, destFolder) {
    return deviceManager.importStorageItems(basePath, pathArray, itemNames, destFolder);
  }
}

module.exports = new UsbService();
