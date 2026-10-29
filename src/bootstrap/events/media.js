'use strict';

const taskProgressCenter = require('../../infrastructure/desktop/TaskProgressCenter');

/** Eventos de montagem, metadados, recuperação de vídeo/RAW e atualizações -> renderer. */
function bindMediaEvents({ bridge, services }) {
  const { montageService, metadataService, videoRecoveryService, rawRecoveryService, jpgRecoveryService, updateService } = services;

  // Montage Events
  montageService.on('progress', (p) => {
    bridge.send('montage:progress', p);
    // Barra de tarefas: arquivo atual dentro do lote
    const total = Math.max(1, Number(p?.totalFiles) || 1);
    const done = Math.max(0, (Number(p?.currentFile) || 1) - 1);
    bridge.reportProgressThrottled('montage', (done + (Number(p?.percent) || 0) / 100) / total);
  });
  montageService.on('finished', (p) => {
    bridge.send('montage:finished', p);
    bridge.cancelThrottled('tpc:montage');
    if (p && p.status === 'error') taskProgressCenter.reportError('montage');
    else taskProgressCenter.reportIdle('montage');
  });
  montageService.on('queue-updated', (q) => bridge.send('montage:queue-updated', q));
  montageService.on('log', (t) => bridge.send('montage:log', t));

  // Metadata Events
  metadataService.on('progress', (p) => bridge.send('metadata:progress', p));
  metadataService.on('log', (p) => bridge.send('metadata:log', p));

  // Recovery Events
  videoRecoveryService.on('progress', (p) => {
    bridge.send('recovery:progress', p);
    if (typeof p?.percent === 'number') bridge.reportProgressThrottled('recovery', p.percent / 100);
    else taskProgressCenter.reportIndeterminate('recovery');
  });
  videoRecoveryService.on('stage', (p) => bridge.send('recovery:stage', p));
  videoRecoveryService.on('finished', (p) => { bridge.send('recovery:finished', p); bridge.cancelThrottled('tpc:recovery'); taskProgressCenter.reportIdle('recovery'); });
  videoRecoveryService.on('error', (p) => { bridge.send('recovery:error', p); bridge.cancelThrottled('tpc:recovery'); taskProgressCenter.reportError('recovery'); });

  rawRecoveryService.on('progress', (p) => {
    bridge.send('recovery:raw:progress', p);
    if (typeof p?.percent === 'number') bridge.reportProgressThrottled('recovery', p.percent / 100);
    else taskProgressCenter.reportIndeterminate('recovery');
  });
  rawRecoveryService.on('stage', (p) => bridge.send('recovery:raw:stage', p));
  rawRecoveryService.on('finished', (p) => { bridge.send('recovery:raw:finished', p); bridge.cancelThrottled('tpc:recovery'); taskProgressCenter.reportIdle('recovery'); });
  rawRecoveryService.on('error', (p) => { bridge.send('recovery:raw:error', p); bridge.cancelThrottled('tpc:recovery'); taskProgressCenter.reportError('recovery'); });

  jpgRecoveryService.on('progress', (p) => {
    bridge.send('recovery:jpg:progress', p);
    if (typeof p?.percent === 'number') bridge.reportProgressThrottled('recovery', p.percent / 100);
    else taskProgressCenter.reportIndeterminate('recovery');
  });
  jpgRecoveryService.on('stage', (p) => bridge.send('recovery:jpg:stage', p));
  jpgRecoveryService.on('finished', (p) => { bridge.send('recovery:jpg:finished', p); bridge.cancelThrottled('tpc:recovery'); taskProgressCenter.reportIdle('recovery'); });
  jpgRecoveryService.on('error', (p) => { bridge.send('recovery:jpg:error', p); bridge.cancelThrottled('tpc:recovery'); taskProgressCenter.reportError('recovery'); });

  // Update Events
  updateService.on('progress', (p) => {
    bridge.send('updates:progress', p);
    if (typeof p?.percent === 'number') bridge.reportProgressThrottled('updates', p.percent / 100);
    else taskProgressCenter.reportIndeterminate('updates');
  });
  updateService.on('completed', (p) => { bridge.send('updates:completed', p); bridge.cancelThrottled('tpc:updates'); taskProgressCenter.reportIdle('updates'); });
}

module.exports = bindMediaEvents;
