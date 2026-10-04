'use strict';

const { handle } = require('./channelRegistry');
const logger = require('../services/logService');
const { deviceManager } = require('../infrastructure/hardware/DeviceManager');
const deviceDiscoveryService = require('../core/devices/DeviceDiscoveryService');
const sonyCameraService = require('../core/devices/SonyCameraService');
const MtpService = require('../core/MtpService');
const UsbService = require('../core/UsbService');

/** Lista unificada de dispositivos (MTP/USB/BDSM/Sony) e navegação/importação USB e MTP. */
module.exports = function registerDeviceListHandlers() {
  // Devices & Hardware
  handle('devices:get-all', async (_, force = false) => {
    if (force) {
      sonyCameraService.rescan();
      await deviceDiscoveryService.forceRescan();
    }
    // MTP e USB em paralelo, reaproveitando o cache de 25 s do DeviceManager (compartilhado com a
    // sidebar de armazenamento); "force" (atualizar manualmente) ignora o cache.
    const [mtpDevices, usbDevices] = await Promise.all([
      deviceManager.getMtpDevices({ force: !!force }),
      deviceManager.getStorageDevices({ force: !!force })
    ]);
    const bdsmDevices = deviceDiscoveryService.getDevices();
    const sonyDevices = sonyCameraService.getCameras();

    // Quando o mesmo aparelho físico já está acessível via o app BDSM (que dá acesso
    // direto às gravações do app), suprimimos a entrada MTP genérica equivalente — o
    // usuário quer trabalhar com as gravações do app, não navegar o sistema de arquivos
    // bruto do dispositivo via MTP. Não existe um ID compartilhado entre os dois
    // protocolos, então o cruzamento é feito pelo nome do dispositivo (normalizado).
    const normalizeDeviceName = (name) => (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const bdsmNames = new Set(bdsmDevices.map(d => normalizeDeviceName(d.name)));
    const mtpDevicesFiltered = mtpDevices.filter(d => {
      const mtpName = normalizeDeviceName(d.name || d.Name);
      const matchesBdsm = mtpName && bdsmNames.has(mtpName);
      if (matchesBdsm) {
        logger.debug('devices:get-all:mtp_suppressed_duplicate_of_bdsm', { name: d.name || d.Name });
      }
      return !matchesBdsm;
    });

    return [
      ...mtpDevicesFiltered.map(d => ({ ...d, type: 'MTP', isBdsm: false })),
      ...usbDevices.map(d => ({ ...d, type: 'USB', isBdsm: false })),
      ...bdsmDevices.map(d => ({ ...d, type: 'BDSM', isBdsm: true })),
      ...sonyDevices.map(d => ({ ...d, type: 'SONY', isBdsm: false }))
    ];
  });
  handle('usb:list-folder', (_, basePath, pathArray) => UsbService.listFolder(basePath, pathArray));
  handle('usb:import-items', (_, basePath, pathArray, itemNames, destFolder) => UsbService.importItems(basePath, pathArray, itemNames, destFolder));
  handle('mtp:list-folder', (_, deviceName, pathArray) => MtpService.listMtpFolder(deviceName, pathArray));
  handle('mtp:import-items', (_, deviceName, pathArray, itemNames, destFolder) => MtpService.importMtpItems(deviceName, pathArray, itemNames, destFolder));
};
