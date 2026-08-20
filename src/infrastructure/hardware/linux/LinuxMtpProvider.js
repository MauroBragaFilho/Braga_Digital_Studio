'use strict';

const { StorageProvider } = require('../StorageProvider');
const logger = require('../../../services/logService');

/**
 * LinuxMtpProvider — Stub para suporte futuro a dispositivos MTP no Linux.
 *
 * Implementacao futura via libmtp / jmtpfs / go-mtpfs.
 * Por enquanto retorna listas vazias para nao quebrar a inicializacao da app.
 *
 * Regra do roadmap (Sprint 5):
 *   Todos os providers devem existir para todas as plataformas suportadas,
 *   mesmo que ainda sejam stubs. Isso garante que o DeviceManager nunca
 *   lance erros ao importar o provider correto.
 */
class LinuxMtpProvider extends StorageProvider {
  async getDevices() {
    logger.info('LinuxMtpProvider:getDevices:not_implemented');
    // TODO Sprint 6: implementar via jmtpfs / libmtp
    return [];
  }

  async listFolder(deviceRef, pathArray) {
    logger.info('LinuxMtpProvider:listFolder:not_implemented');
    return { success: false, items: [] };
  }

  async importItems(deviceRef, pathArray, itemNames, destFolder) {
    logger.info('LinuxMtpProvider:importItems:not_implemented');
    return false;
  }
}

module.exports = { LinuxMtpProvider };
