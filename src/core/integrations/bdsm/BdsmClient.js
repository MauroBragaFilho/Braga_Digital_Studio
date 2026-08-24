'use strict';

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../../../services/logService');
const BdsmProtocol = require('./BdsmProtocol');

/**
 * BdsmClient — Cliente HTTP/REST para comunicação com dispositivos BDSM.
 */
class BdsmClient {
  /**
   * @param {string} ip - Endereço IP do dispositivo
   * @param {number} [port=8080] - Porta do serviço BDSM
   */
  constructor(ip, port = BdsmProtocol.DEFAULT_PORT) {
    this.ip = ip;
    this.port = port;
    this.baseUrl = `http://${ip}:${port}/api`;
  }

  async _fetch(endpoint, options = {}, silent = false) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), options.timeout || 10000);

      const headers = BdsmProtocol.buildHeaders(options.headers || {});
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        headers,
        signal: controller.signal
      });
      clearTimeout(id);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (e) {
      if (!silent) logger.error(`[BdsmClient] Erro na requisição para ${endpoint}: ${e.message}`);
      throw e;
    }
  }

  /**
   * Consulta informações do dispositivo.
   * @param {boolean} [silent=false]
   * @param {number} [timeout=2500]
   * @returns {Promise<Object>}
   */
  async getInfo(silent = false, timeout = 2500) {
    return this._fetch(BdsmProtocol.ENDPOINTS.DISCOVERY_INFO, { timeout }, silent);
  }

  /**
   * Lista todas as mídias disponíveis no dispositivo.
   * @returns {Promise<Array>}
   */
  async getMedia() {
    return this._fetch(BdsmProtocol.ENDPOINTS.MEDIA_LIST);
  }

  getMediaDownloadUrl(id) {
    return `${this.baseUrl}${BdsmProtocol.ENDPOINTS.MEDIA_DOWNLOAD(id)}`;
  }

  getMediaThumbnailUrl(id) {
    return `${this.baseUrl}${BdsmProtocol.ENDPOINTS.MEDIA_THUMBNAIL(id)}`;
  }

  /**
   * Remove uma mídia do dispositivo.
   * @param {string|number} id
   * @returns {Promise<boolean>}
   */
  async deleteMedia(id) {
    const response = await fetch(`${this.baseUrl}${BdsmProtocol.ENDPOINTS.MEDIA_DELETE(id)}`, {
      method: 'DELETE',
      headers: BdsmProtocol.buildHeaders()
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return true;
  }

  /**
   * Lista todas as LUTs disponíveis no dispositivo.
   * @returns {Promise<Array>}
   */
  async getLuts() {
    return this._fetch(BdsmProtocol.ENDPOINTS.LUTS_LIST);
  }

  getLutDownloadUrl(relativePath) {
    return `${this.baseUrl}${BdsmProtocol.ENDPOINTS.LUTS_DOWNLOAD(relativePath)}`;
  }

  /**
   * Faz upload de uma LUT (.cube) para o dispositivo.
   * @param {string} filePath - Caminho local da LUT
   * @param {string} destPath - Caminho de destino no dispositivo
   * @returns {Promise<boolean>}
   */
  async uploadLut(filePath, destPath) {
    try {
      const fileBuffer = fs.readFileSync(filePath);
      const blob = new Blob([fileBuffer], { type: 'application/octet-stream' });

      const formData = new FormData();
      formData.append('relativePath', destPath);
      formData.append('file', blob, path.basename(filePath));

      const response = await fetch(`${this.baseUrl}${BdsmProtocol.ENDPOINTS.LUTS_UPLOAD}`, {
        method: 'POST',
        headers: {
          [BdsmProtocol.HEADERS.CLIENT]: BdsmProtocol.HEADERS.CLIENT_VALUE,
          [BdsmProtocol.HEADERS.VERSION]: BdsmProtocol.HEADERS.VERSION_VALUE
        },
        body: formData
      });

      if (response.status === 409) {
        throw new Error('CONFLICT: Um arquivo com o mesmo nome e hash diferente já existe no celular.');
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    } catch (e) {
      logger.error(`[BdsmClient] Erro no upload de LUT: ${e.message}`);
      throw e;
    }
  }

  /**
   * Remove uma LUT do dispositivo.
   * @param {string} relativePath
   * @returns {Promise<boolean>}
   */
  async deleteLut(relativePath) {
    const parts = relativePath.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${this.baseUrl}/luts/${parts}`, {
      method: 'DELETE',
      headers: BdsmProtocol.buildHeaders()
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return true;
  }
}

module.exports = BdsmClient;
