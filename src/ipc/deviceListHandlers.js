'use strict';

const { handle } = require('./channelRegistry');
const logger = require('../services/logService');
const taskProgressCenter = require('../infrastructure/desktop/TaskProgressCenter');
const { deviceManager } = require('../infrastructure/hardware/DeviceManager');
// Carregado só quando um handler é usado (módulo Dispositivos): o código da descoberta não entra na abertura do app
const deviceDiscoveryService = require('../core/modules/lazyService').lazyService(() => require('../core/devices/DeviceDiscoveryService'));
const sonyCameraService = require('../core/devices/SonyCameraService');
const MtpService = require('../core/MtpService');
const UsbService = require('../core/UsbService');

const SONY_RESCAN_MIN_MS = 8000;

/**
 * Lista unificada de dispositivos (MTP/USB/BDSM/Sony) e navegação/importação USB e MTP.
 * `devices:get-all` devolve { devices, issues }: `issues` diz o que NÃO pôde ser consultado (tempo esgotado, PowerShell
 * indisponível...), para a tela não confundir "não consegui olhar" com "não há nada conectado".
 */
module.exports = function registerDeviceListHandlers() {
  // A busca de câmeras Sony só repete a cada 30 s sozinha; com a tela aberta e perguntando a cada poucos segundos, repete a
  // cada 8 s (uma câmera ligada agora aparece logo) e na hora no "atualizar".
  let lastSonyRescan = 0;
  // Devices & Hardware
  handle('devices:get-all', async (_, force = false) => {
    const now = Date.now();
    if (force || now - lastSonyRescan >= SONY_RESCAN_MIN_MS) {
      lastSonyRescan = now;
      sonyCameraService.rescan();
    }
    // MTP e USB em paralelo (e em paralelo com a nova busca de celulares, no "atualizar"), reaproveitando o cache do
    // DeviceManager (compartilhado com a sidebar de armazenamento), que só é refeito quando o hardware muda ou vence;
    // "force" (atualizar manualmente) ignora o cache.
    const [scan] = await Promise.all([
      deviceManager.scan({ force: !!force }),
      // A busca de celulares é complemento: se ela falhar, a lista de cartões, câmeras e celulares já vistos segue valendo
      force ? Promise.resolve(deviceDiscoveryService.forceRescan()).catch((err) => logger.warn(`devices:get-all:forceRescan:error ${err && err.message}`)) : null
    ]);
    const { mtp: mtpDevices, usb: usbDevices, issues } = scan;
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

    return {
      devices: [
        ...mtpDevicesFiltered.map(d => ({ ...d, type: 'MTP', isBdsm: false })),
        ...usbDevices.map(d => ({ ...d, type: 'USB', isBdsm: false })),
        ...bdsmDevices.map(d => ({ ...d, type: 'BDSM', isBdsm: true })),
        ...sonyDevices.map(d => ({ ...d, type: 'SONY', isBdsm: false }))
      ],
      issues
    };
  });
  handle('usb:list-folder', (_, basePath, pathArray) => UsbService.listFolder(basePath, pathArray));
  // Barra de tarefas: o andamento por arquivo chega pelo evento 'progress' do DeviceManager (events/devices.js);
  // aqui só se marca o fim (ou o erro) da cópia.
  const withTaskbar = async (fn) => {
    taskProgressCenter.reportIndeterminate('copy');
    try { const r = await fn(); taskProgressCenter.reportIdle('copy'); return r; } catch (err) { taskProgressCenter.reportError('copy'); throw err; }
  };
  handle('usb:import-items', (_, basePath, pathArray, itemNames, destFolder) => withTaskbar(() => UsbService.importItems(basePath, pathArray, itemNames, destFolder)));
  // Aparelho MTP em uso (navegando ou copiando): o DeviceManager não varre dispositivos enquanto isso, para não atrasar a cópia
  handle('mtp:list-folder', (_, deviceName, pathArray) => deviceManager.track(() => MtpService.listMtpFolder(deviceName, pathArray)));
  handle('mtp:import-items', (_, deviceName, pathArray, itemNames, destFolder) => deviceManager.track(() => withTaskbar(() => MtpService.importMtpItems(deviceName, pathArray, itemNames, destFolder))));
};
