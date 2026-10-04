'use strict';

/** Eventos de montagem, metadados, recuperação de vídeo/RAW e atualizações -> renderer. */
function bindMediaEvents({ bridge, services }) {
  const { montageService, metadataService, videoRecoveryService, rawRecoveryService, updateService } = services;

  // Montage Events
  montageService.on('progress', (p) => bridge.send('montage:progress', p));
  montageService.on('finished', (p) => bridge.send('montage:finished', p));
  montageService.on('queue-updated', (q) => bridge.send('montage:queue-updated', q));
  montageService.on('log', (t) => bridge.send('montage:log', t));

  // Metadata Events
  metadataService.on('progress', (p) => bridge.send('metadata:progress', p));
  metadataService.on('log', (p) => bridge.send('metadata:log', p));

  // Recovery Events
  videoRecoveryService.on('progress', (p) => bridge.send('recovery:progress', p));
  videoRecoveryService.on('stage', (p) => bridge.send('recovery:stage', p));
  videoRecoveryService.on('finished', (p) => bridge.send('recovery:finished', p));
  videoRecoveryService.on('error', (p) => bridge.send('recovery:error', p));

  rawRecoveryService.on('progress', (p) => bridge.send('recovery:raw:progress', p));
  rawRecoveryService.on('stage', (p) => bridge.send('recovery:raw:stage', p));
  rawRecoveryService.on('finished', (p) => bridge.send('recovery:raw:finished', p));
  rawRecoveryService.on('error', (p) => bridge.send('recovery:raw:error', p));

  // Update Events
  updateService.on('progress', (p) => bridge.send('updates:progress', p));
  updateService.on('completed', (p) => bridge.send('updates:completed', p));
}

module.exports = bindMediaEvents;
