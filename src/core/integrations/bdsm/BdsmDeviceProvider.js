'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { StorageProvider } = require('../../../infrastructure/hardware/StorageProvider');
const BdsmClient = require('./BdsmClient');
const logger = require('../../../services/logService');

/**
 * BdsmDeviceProvider — Provider de dispositivos BDSM (Wi-Fi e USB ADB).
 *
 * Integra dispositivos móveis e câmeras compatíveis com o protocolo BDSM
 * ao ecossistema de importação e gerenciamento de hardware do BDS.
 */
class BdsmDeviceProvider extends StorageProvider {
  /**
   * @param {import('../../devices/DeviceDiscoveryService')} discoveryService
   */
  constructor(discoveryService) {
    super();
    this.discoveryService = discoveryService;
  }

  /**
   * Retorna os dispositivos BDSM descobertos na rede ou USB.
   * @returns {Promise<Array>}
   */
  async getDevices() {
    if (!this.discoveryService) return [];
    return this.discoveryService.getDevices().map(d => ({
      id: d.id,
      name: d.name,
      model: d.model,
      type: 'bdsm',
      ip: d.ip,
      port: d.port,
      connection: d.connection,
      battery: d.battery,
      storage: [{
        name: 'Memória Interna BDSM',
        path: `bdsm://${d.ip}:${d.port}`,
        capacity: d.storage_total || 0,
        free: d.storage_free || 0
      }]
    }));
  }

  /**
   * Lista arquivos de mídia de um dispositivo BDSM.
   * @param {string} deviceId
   * @returns {Promise<{success: boolean, items: Array}>}
   */
  async listFolder(deviceId) {
    try {
      const device = this._findDevice(deviceId);
      if (!device) return { success: false, items: [] };

      const client = new BdsmClient(device.ip, device.port);
      const mediaList = await client.getMedia();

      const items = (mediaList || []).map(m => ({
        id: m.id,
        name: m.filename || m.name,
        isFolder: false,
        size: m.size || m.filesize || 0,
        duration: m.duration || 0,
        thumbnailUrl: client.getMediaThumbnailUrl(m.id),
        downloadUrl: client.getMediaDownloadUrl(m.id)
      }));

      return { success: true, items };
    } catch (err) {
      logger.error('BdsmDeviceProvider:listFolder:error', { error: err.message });
      return { success: false, items: [] };
    }
  }

  /**
   * Importa arquivos selecionados de um dispositivo BDSM para o destino local.
   * @param {string} deviceId
   * @param {string[]} pathArray - Não usado em BDSM (usa IDs)
   * @param {Array<string|Object>} itemIds
   * @param {string} destFolder
   * @returns {Promise<boolean>}
   */
  async importItems(deviceId, pathArray, itemIds, destFolder) {
    try {
      const device = this._findDevice(deviceId);
      if (!device) return false;

      if (!fs.existsSync(destFolder)) {
        fs.mkdirSync(destFolder, { recursive: true });
      }

      const client = new BdsmClient(device.ip, device.port);
      const mediaList = await client.getMedia();
      const mediaMap = new Map((mediaList || []).map(m => [String(m.id), m]));

      for (const rawItem of itemIds) {
        const itemId = typeof rawItem === 'object' ? String(rawItem.id || rawItem.name) : String(rawItem);
        const media = mediaMap.get(itemId);
        const fileName = media ? (media.filename || media.name) : `bdsm_media_${itemId}.mp4`;
        const destFilePath = path.join(destFolder, fileName);
        const downloadUrl = client.getMediaDownloadUrl(itemId);

        await this._downloadStream(downloadUrl, destFilePath, fileName);
      }

      return true;
    } catch (err) {
      logger.error('BdsmDeviceProvider:importItems:error', { error: err.message });
      return false;
    }
  }

  _findDevice(deviceId) {
    if (!this.discoveryService) return null;
    const devices = this.discoveryService.getDevices();
    return devices.find(d => d.id === deviceId || d.ip === deviceId);
  }

  async _downloadStream(url, destPath, fileName) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} ao baixar ${fileName}`);

    const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);
    const fileStream = fs.createWriteStream(destPath);

    let receivedBytes = 0;
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      receivedBytes += value.length;
      fileStream.write(Buffer.from(value));

      const percent = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0;
      this.emit('progress', {
        file: fileName,
        percent,
        currentSize: receivedBytes,
        totalSize: totalBytes,
        type: 'bdsm'
      });
    }

    fileStream.end();
  }
}

module.exports = { BdsmDeviceProvider };
