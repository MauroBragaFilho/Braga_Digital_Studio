'use strict';

const EventEmitter = require('node:events');
const path = require('node:path');
const { cachedAsync } = require('./cachedAsync');

// Enumerar MTP/USB custa um PowerShell cada: o resultado é reaproveitado por este tempo
// (sidebar de armazenamento, tela Dispositivos) e chamadas simultâneas são deduplicadas.
const DEVICE_LIST_TTL_MS = 25000;

/**
 * Valida a lista de segmentos de caminho/nomes vindos do renderer: só nomes simples
 * (sem separadores, '..', ':' ou bytes nulos). Segmentos vazios são descartados.
 * @returns {string[]}
 */
function cleanSegments(list, label = 'Caminho') {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 5000) throw new Error(`${label} inválido.`);
  const out = [];
  for (const seg of list) {
    if (seg == null || seg === '') continue;
    if (typeof seg !== 'string' || seg.length > 255 || /[\\/:\0]/.test(seg) || seg === '.' || seg === '..') {
      throw new Error(`${label} inválido: segmento não permitido.`);
    }
    out.push(seg);
  }
  return out;
}

/** Pasta de destino: caminho absoluto, sem bytes nulos e que não seja a raiz de um drive. */
function assertDestFolder(dest) {
  if (!dest || typeof dest !== 'string' || dest.includes('\0') || dest.length > 4096 || !path.isAbsolute(dest)) {
    throw new Error('Pasta de destino inválida.');
  }
  const resolved = path.resolve(dest);
  if (path.parse(resolved).root === resolved || path.parse(resolved).root === resolved + path.sep) {
    throw new Error('A pasta de destino não pode ser a raiz de um drive.');
  }
  return resolved;
}

const normBase = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();

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
    this._mtpList = cachedAsync(() => { this._ensureInit(); return this._mtpProvider.getDevices(); }, DEVICE_LIST_TTL_MS);
    this._storageList = cachedAsync(() => { this._ensureInit(); return this._storageProvider.getDevices(); }, DEVICE_LIST_TTL_MS);
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
  getMtpDevices({ force = false } = {}) {
    return this._mtpList.get({ force });
  }

  /**
   * @param {string} deviceName
   * @param {string[]} pathArray
   * @returns {Promise<Array>}
   */
  listMtpFolder(deviceName, pathArray) {
    this._ensureInit();
    return this._mtpProvider.listFolder(deviceName, cleanSegments(pathArray));
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
    return this._mtpProvider.importItems(
      deviceName, cleanSegments(pathArray), cleanSegments(itemNames, 'Nome de arquivo'), assertDestFolder(destFolder)
    );
  }

  // ─── Storage / USB ────────────────────────────────────────────────────────

  /** @returns {Promise<Array>} */
  getStorageDevices({ force = false } = {}) {
    return this._storageList.get({ force });
  }

  /** Descarta as listas em cache (ex.: após importar/ejetar). */
  invalidateDeviceCache() {
    this._mtpList.invalidate();
    this._storageList.invalidate();
  }

  /**
   * @param {string} basePath
   * @param {string[]} pathArray
   * @returns {Promise<{success: boolean, items: Array}>}
   */
  async listStorageFolder(basePath, pathArray) {
    this._ensureInit();
    const segments = cleanSegments(pathArray);
    const base = await this._assertListedStorage(basePath);
    return this._storageProvider.listFolder(base, segments);
  }

  /** basePath precisa ser exatamente uma unidade/ponto de montagem listado pelo provider. */
  async _assertListedStorage(basePath) {
    if (!basePath || typeof basePath !== 'string' || basePath.includes('\0') || !path.isAbsolute(basePath)) {
      throw new Error('Unidade inválida.');
    }
    const wanted = normBase(basePath);
    const find = (devices) => {
      for (const d of devices || []) {
        for (const s of d.storage || []) {
          if (s && s.path && normBase(s.path) === wanted) return s.path;
        }
      }
      return null;
    };
    let found = find(await this.getStorageDevices());
    if (!found) found = find(await this.getStorageDevices({ force: true })); // unidade recém-conectada
    if (!found) throw new Error('A unidade informada não está entre os dispositivos conectados.');
    return found;
  }

  /**
   * @param {string} basePath
   * @param {string[]} pathArray
   * @param {string[]} itemNames
   * @param {string} destFolder
   * @returns {Promise<boolean>}
   */
  async importStorageItems(basePath, pathArray, itemNames, destFolder) {
    this._ensureInit();
    const segments = cleanSegments(pathArray);
    const names = cleanSegments(itemNames, 'Nome de arquivo');
    const dest = assertDestFolder(destFolder);
    const base = await this._assertListedStorage(basePath);
    return this._storageProvider.importItems(base, segments, names, dest);
  }
}

// Singleton
const deviceManager = new DeviceManager();
module.exports = { DeviceManager, deviceManager, cleanSegments, assertDestFolder };
