'use strict';

/**
 * MtpService — Fachada de compatibilidade para acesso a dispositivos MTP.
 *
 * SPRINT 5: Todo o codigo de PowerShell foi migrado para
 *   src/infrastructure/hardware/windows/WindowsMtpProvider.js
 *
 * Este arquivo agora delega integralmente ao DeviceManager, mantendo a mesma
 * API publica para que main.js e handlers IPC nao precisem de alteracoes.
 */
const { deviceManager } = require('../infrastructure/hardware/DeviceManager');

class MtpService {
  /** Propaga eventos de progresso do DeviceManager */
  on(event, listener) {
    deviceManager.on(event, listener);
    return this;
  }

  off(event, listener) {
    deviceManager.off(event, listener);
    return this;
  }

  /** Lista dispositivos MTP conectados. */
  getDevices() {
    return deviceManager.getMtpDevices();
  }

  /** Lista o conteudo de uma pasta MTP. */
  listMtpFolder(deviceName, pathArray) {
    return deviceManager.listMtpFolder(deviceName, pathArray);
  }

  /** Importa arquivos MTP para o disco local. */
  importMtpItems(deviceName, pathArray, itemNames, destFolder) {
    return deviceManager.importMtpItems(deviceName, pathArray, itemNames, destFolder);
  }
}

module.exports = new MtpService();
