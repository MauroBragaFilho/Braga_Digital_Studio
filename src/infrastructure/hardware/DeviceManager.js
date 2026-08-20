'use strict';

const EventEmitter = require('node:events');

/**
 * DeviceManager — Facade multiplataforma para acesso a dispositivos de hardware.
 *
 * Seleciona automaticamente o provider correto com base em process.platform:
 *   - win32  → Windows{Mtp,Storage}Provider
 *   - linux  → Linux{Mtp,Storage}Provider
 *   - darwin → LinuxStorageProvider (compativel com macOS via lsblk-like)
 *
 * Regra do roadmap (Sprint 5):
 *   MtpService e UsbService devem delegar TODA a logica de dispositivo ao DeviceManager.
 *   O DeviceManager e o UNICO ponto que conhece os providers de plataforma.
 *
 * Uso:
 *   const { deviceManager } = require('./DeviceManager');
 *   const devices = await deviceManager.getMtpDevices();
 *   deviceManager.on('progress', (data) => ...);
 */
class DeviceManager extends EventEmitter {
  constructor() {
    super();
    this._mtpProvider = null;
    this._storageProvider = null;
    this._initialized = false;
  }

  /**
   * Inicializa os providers corretos para a plataforma atual.
   * Chamado automaticamente na primeira operacao.
   */
  _ensureInit() {
    if (this._initialized) return;

    const platform = process.platform;

    if (platform === 'win32') {
      const { WindowsMtpProvider } = require('./windows/WindowsMtpProvider');
      const { WindowsStorageProvider } = require('./windows/WindowsStorageProvider');
      this._mtpProvider = new WindowsMtpProvider();
      this._storageProvider = new WindowsStorageProvider();
    } else {
      // Linux e macOS: MTP via stub (futuro), Storage via lsblk/fs
      const { LinuxMtpProvider } = require('./linux/LinuxMtpProvider');
      const { LinuxStorageProvider } = require('./linux/LinuxStorageProvider');
      this._mtpProvider = new LinuxMtpProvider();
      this._storageProvider = new LinuxStorageProvider();
    }

    // Repassa eventos de progresso dos providers para os listeners do DeviceManager
    this._mtpProvider.on('progress', (data) => this.emit('progress', data));
    this._storageProvider.on('progress', (data) => this.emit('progress', data));

    this._initialized = true;
  }

  // ─── MTP ──────────────────────────────────────────────────────────────────

  /** @returns {Promise<Array>} */
  getMtpDevices() {
    this._ensureInit();
    return this._mtpProvider.getDevices();
  }

  /**
   * @param {string} deviceName
   * @param {string[]} pathArray
   * @returns {Promise<Array>}
   */
  listMtpFolder(deviceName, pathArray) {
    this._ensureInit();
    return this._mtpProvider.listFolder(deviceName, pathArray);
  }

  /**
   * @param {string} deviceName
   * @param {string[]} pathArray
   * @param {string[]} itemNames
   * @param {string} destFolder
   * @returns {Promise<boolean>}
   */
  importMtpItems(deviceName, pathArray, itemNames, destFolder) {
    this._ensureInit();
    return this._mtpProvider.importItems(deviceName, pathArray, itemNames, destFolder);
  }

  // ─── Storage / USB ────────────────────────────────────────────────────────

  /** @returns {Promise<Array>} */
  getStorageDevices() {
    this._ensureInit();
    return this._storageProvider.getDevices();
  }

  /**
   * @param {string} basePath
   * @param {string[]} pathArray
   * @returns {Promise<{success: boolean, items: Array}>}
   */
  listStorageFolder(basePath, pathArray) {
    this._ensureInit();
    return this._storageProvider.listFolder(basePath, pathArray);
  }

  /**
   * @param {string} basePath
   * @param {string[]} pathArray
   * @param {string[]} itemNames
   * @param {string} destFolder
   * @returns {Promise<boolean>}
   */
  importStorageItems(basePath, pathArray, itemNames, destFolder) {
    this._ensureInit();
    return this._storageProvider.importItems(basePath, pathArray, itemNames, destFolder);
  }
}

// Singleton
const deviceManager = new DeviceManager();
module.exports = { DeviceManager, deviceManager };
