'use strict';

const taskProgressCenter = require('../../infrastructure/desktop/TaskProgressCenter');
const { onceCreated } = require('../../core/modules/lazyService');

/**
 * Eventos de montagem, metadados, recuperação de vídeo/RAW/JPG e atualizações -> renderer.
 * Montagem e recuperação são serviços criados no primeiro uso (lazyService): os ouvintes são ligados quando o
 * serviço passa a existir (onceCreated), então eles não entram no caminho da abertura.
 */
function bindMediaEvents({ bridge, services }) {
  const { montageService, metadataService, videoRecoveryService, rawRecoveryService, jpgRecoveryService, updateService } = services;

  // Montage Events
  onceCreated(montageService, (s) => {
    s.on('progress', (p) => {
      bridge.send('montage:progress', p);
      // Barra de tarefas: arquivo atual dentro do lote
      const total = Math.max(1, Number(p?.totalFiles) || 1);
      const done = Math.max(0, (Number(p?.currentFile) || 1) - 1);
      bridge.reportProgressThrottled('montage', (done + (Number(p?.percent) || 0) / 100) / total);
    });
    s.on('finished', (p) => {
      bridge.send('montage:finished', p);
      bridge.cancelThrottled('tpc:montage');
      if (p && p.status === 'error') taskProgressCenter.reportError('montage');
      else taskProgressCenter.reportIdle('montage');
    });
    s.on('queue-updated', (q) => bridge.send('montage:queue-updated', q));
    s.on('log', (t) => bridge.send('montage:log', t));
  });

  // Metadata Events
  metadataService.on('progress', (p) => bridge.send('metadata:progress', p));
  metadataService.on('log', (p) => bridge.send('metadata:log', p));

  // Recovery Events (vídeo, RAW e JPG compartilham a barra de tarefas; nomes de canal literais: os testes de fiação os procuram no código)
  onceCreated(videoRecoveryService, (s) => {
    s.on('progress', (p) => {
      bridge.send('recovery:progress', p);
      if (typeof p?.percent === 'number') bridge.reportProgressThrottled('recovery', p.percent / 100);
      else taskProgressCenter.reportIndeterminate('recovery');
    });
    s.on('stage', (p) => bridge.send('recovery:stage', p));
    s.on('finished', (p) => { bridge.send('recovery:finished', p); bridge.cancelThrottled('tpc:recovery'); taskProgressCenter.reportIdle('recovery'); });
    s.on('error', (p) => { bridge.send('recovery:error', p); bridge.cancelThrottled('tpc:recovery'); taskProgressCenter.reportError('recovery'); });
  });
  onceCreated(rawRecoveryService, (s) => {
    s.on('progress', (p) => {
      bridge.send('recovery:raw:progress', p);
      if (typeof p?.percent === 'number') bridge.reportProgressThrottled('recovery', p.percent / 100);
      else taskProgressCenter.reportIndeterminate('recovery');
    });
    s.on('stage', (p) => bridge.send('recovery:raw:stage', p));
    s.on('finished', (p) => { bridge.send('recovery:raw:finished', p); bridge.cancelThrottled('tpc:recovery'); taskProgressCenter.reportIdle('recovery'); });
    s.on('error', (p) => { bridge.send('recovery:raw:error', p); bridge.cancelThrottled('tpc:recovery'); taskProgressCenter.reportError('recovery'); });
  });
  onceCreated(jpgRecoveryService, (s) => {
    s.on('progress', (p) => {
      bridge.send('recovery:jpg:progress', p);
      if (typeof p?.percent === 'number') bridge.reportProgressThrottled('recovery', p.percent / 100);
      else taskProgressCenter.reportIndeterminate('recovery');
    });
    s.on('stage', (p) => bridge.send('recovery:jpg:stage', p));
    s.on('finished', (p) => { bridge.send('recovery:jpg:finished', p); bridge.cancelThrottled('tpc:recovery'); taskProgressCenter.reportIdle('recovery'); });
    s.on('error', (p) => { bridge.send('recovery:jpg:error', p); bridge.cancelThrottled('tpc:recovery'); taskProgressCenter.reportError('recovery'); });
  });

  // Update Events
  updateService.on('progress', (p) => {
    bridge.send('updates:progress', p);
    if (typeof p?.percent === 'number') bridge.reportProgressThrottled('updates', p.percent / 100);
    else taskProgressCenter.reportIndeterminate('updates');
  });
  updateService.on('completed', (p) => { bridge.send('updates:completed', p); bridge.cancelThrottled('tpc:updates'); taskProgressCenter.reportIdle('updates'); });
}

module.exports = bindMediaEvents;
