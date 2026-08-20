'use strict';

const EventEmitter = require('node:events');

/**
 * StorageProvider — Interface base abstrata para providers de dispositivos de armazenamento.
 *
 * Regra do roadmap (Sprint 5):
 *   MtpService e UsbService nao devem conter comandos PowerShell ou shell diretamente.
 *   O codigo especifico de plataforma deve residir em providers isolados.
 *
 * Todos os providers concretos devem estender esta classe e implementar:
 *   - getDevices()   → Promise<Device[]>
 *   - listFolder()   → Promise<{success, items}>
 *   - importItems()  → Promise<boolean>  (emite eventos 'progress')
 */
class StorageProvider extends EventEmitter {
  /**
   * Retorna lista de dispositivos conectados.
   * @returns {Promise<Array<{id, name, type, storage}>>}
   */
  async getDevices() {
    throw new Error(`${this.constructor.name}.getDevices() nao implementado.`);
  }

  /**
   * Lista o conteudo de uma pasta dentro de um dispositivo.
   * @param {string} deviceRef - Referencia do dispositivo (nome para MTP, path para USB)
   * @param {string[]} pathArray - Caminho dentro do dispositivo
   * @returns {Promise<{success: boolean, items: Array<{name, isFolder, size}>}>}
   */
  async listFolder(deviceRef, pathArray) {
    throw new Error(`${this.constructor.name}.listFolder() nao implementado.`);
  }

  /**
   * Importa itens do dispositivo para o disco local.
   * Deve emitir eventos 'progress' com { file, percent, currentSize, totalSize, speedBps }.
   * @param {string} deviceRef
   * @param {string[]} pathArray
   * @param {string[]} itemNames
   * @param {string} destFolder
   * @returns {Promise<boolean>}
   */
  async importItems(deviceRef, pathArray, itemNames, destFolder) {
    throw new Error(`${this.constructor.name}.importItems() nao implementado.`);
  }
}

module.exports = { StorageProvider };
