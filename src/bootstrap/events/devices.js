'use strict';

const deviceDiscoveryService = require('../../core/devices/DeviceDiscoveryService');
const sonyCameraService = require('../../core/devices/SonyCameraService');
const UsbService = require('../../core/UsbService');

/** Eventos de descoberta de dispositivos, câmeras Sony e importação USB -> renderer. */
function bindDeviceEvents({ bridge }) {
  // Discovery Events
  deviceDiscoveryService.on('device_added', (d) => bridge.send('bdsm:device_added', d));
  deviceDiscoveryService.on('device_removed', (id) => bridge.send('bdsm:device_removed', id));
  deviceDiscoveryService.on('device_updated', (d) => bridge.send('bdsm:device_updated', d));

  // [FASE 2.2] Sony Camera Events — unificados para canais do preload
  sonyCameraService.on('camera_connected', (cam) => bridge.send('sony-camera:connected', cam));
  sonyCameraService.on('camera_status_updated', (status) => bridge.send('sony-camera:status-update', status));

  // Hardware Provider Events
  // UsbService e MtpService repassam o MESMO 'progress' do DeviceManager: um único listener (senão o evento chega em dobro)
  UsbService.on('progress', (data) => bridge.send('mtp:import-progress', data));

  // [FASE 2.2] Sony — eventos 'connected'/'photo-taken' já capturados acima via camera_connected
  // Não registrar listeners duplicados para o mesmo serviço
}

module.exports = bindDeviceEvents;
