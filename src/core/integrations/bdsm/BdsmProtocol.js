'use strict';

/**
 * BdsmProtocol — Especificação e contratos do protocolo BDSM
 * (Braga Device Sync & Media Protocol).
 *
 * Responsável por padronizar as mensagens, endpoints e formatos de dados
 * trocados entre o Desktop (BDS) e os dispositivos conectados (smartphones,
 * câmeras móveis, BDS Companion App).
 */
const BdsmProtocol = {
  VERSION: '1.0',
  DEFAULT_PORT: 8080,
  SERVICE_TYPE: 'bdsm',

  // Endpoints REST
  ENDPOINTS: {
    DISCOVERY_INFO: '/discovery/info',
    MEDIA_LIST: '/media',
    MEDIA_DOWNLOAD: (id) => `/media/${encodeURIComponent(id)}/download`,
    MEDIA_THUMBNAIL: (id) => `/media/${encodeURIComponent(id)}/thumbnail`,
    MEDIA_DELETE: (id) => `/media/${encodeURIComponent(id)}`,
    LUTS_LIST: '/luts',
    LUTS_UPLOAD: '/luts/upload',
    LUTS_DOWNLOAD: (path) => `/luts/${encodeURIComponent(path)}`,
    LUTS_DELETE: (path) => `/luts/${encodeURIComponent(path)}`,
    PROJECT_SYNC: '/projects/sync',
    DEVICE_STATUS: '/device/status'
  },

  // Headers obrigatórios
  HEADERS: {
    CLIENT: 'X-BDSM-Client',
    VERSION: 'X-BDSM-Version',
    CLIENT_VALUE: 'BragaDigitalStudio-Desktop',
    VERSION_VALUE: '1.0'
  },

  /**
   * Valida se a resposta de descoberta atende ao contrato BDSM.
   * @param {Object} info
   * @returns {boolean}
   */
  validateDiscoveryInfo(info) {
    if (!info || typeof info !== 'object') return false;
    return !!(info.deviceName || info.deviceModel);
  },

  /**
   * Constrói o cabeçalho padrão de requisição para clientes BDSM.
   * @param {Object} [customHeaders]
   * @returns {Object}
   */
  buildHeaders(customHeaders = {}) {
    return {
      [this.HEADERS.CLIENT]: this.HEADERS.CLIENT_VALUE,
      [this.HEADERS.VERSION]: this.HEADERS.VERSION_VALUE,
      'Accept': 'application/json',
      ...customHeaders
    };
  }
};

module.exports = BdsmProtocol;
