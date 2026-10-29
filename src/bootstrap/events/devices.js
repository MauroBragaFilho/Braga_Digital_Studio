'use strict';

const { moduleRuntime } = require('../moduleRuntime');

/**
 * Eventos de descoberta de dispositivos, câmeras Sony e importação USB -> renderer.
 * Só são ligados quando o módulo Dispositivos liga (na abertura, se já ligado): até lá o código dos dispositivos nem é carregado.
 */
function bindDeviceEvents({ bridge }) {
  moduleRuntime.whenOn('devices', () => bindNow({ bridge }));
}

function bindNow({ bridge }) {
  const deviceDiscoveryService = require('../../core/devices/DeviceDiscoveryService');
  const sonyCameraService = require('../../core/devices/SonyCameraService');
  const UsbService = require('../../core/UsbService');
  // Discovery Events
  deviceDiscoveryService.on('device_added', (d) => bridge.send('bdsm:device_added', d));
  deviceDiscoveryService.on('device_removed', (id) => bridge.send('bdsm:device_removed', id));
  deviceDiscoveryService.on('device_updated', (d) => bridge.send('bdsm:device_updated', d));

  // [FASE 2.2] Sony Camera Events — unificados para canais do preload
  sonyCameraService.on('camera_connected', (cam) => bridge.send('sony-camera:connected', cam));
  sonyCameraService.on('camera_status_updated', (status) => bridge.send('sony-camera:status-update', status));

  // Hardware Provider Events
  // UsbService e MtpService repassam o MESMO 'progress' do DeviceManager: um único listener (senão o evento chega em dobro)
  UsbService.on('progress', (data) => {
    bridge.send('mtp:import-progress', data);
    // Barra de tarefas: porcentagem do arquivo em cópia (o fim da cópia é marcado pelo handler de importação)
    if (typeof data?.percent === 'number') bridge.reportProgressThrottled('copy', data.percent / 100);
  });

  // [FASE 2.2] Sony — eventos 'connected'/'photo-taken' já capturados acima via camera_connected
  // Não registrar listeners duplicados para o mesmo serviço
}

module.exports = bindDeviceEvents;
