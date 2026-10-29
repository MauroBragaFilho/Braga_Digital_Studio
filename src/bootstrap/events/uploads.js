'use strict';

const { onceCreated } = require('../../core/modules/lazyService');
const taskProgressCenter = require('../../infrastructure/desktop/TaskProgressCenter');

/** Eventos da fila de envio automático para o YouTube -> renderer (tela Envio). */
function bindUploadEvents({ bridge, services }) {
  // A fila nasce no primeiro uso (tela Envio): os eventos são ligados nesse momento
  onceCreated(services.youtubeUploadQueue, (queue) => bindTo(queue, bridge));
}

function bindTo(queue, bridge) {
  queue.on('updated', (state) => {
    bridge.sendThrottled('upload:queue-updated', state);
    // Barra de tarefas: vídeo em envio mostra a porcentagem; na espera entre envios a barra pulsa; parada some
    const current = (state.items || []).find((i) => i.status === 'uploading');
    if (!state.running) taskProgressCenter.reportIdle('upload');
    else if (current) taskProgressCenter.reportProgress('upload', (current.progress || 0) / 100);
    else taskProgressCenter.reportIndeterminate('upload');
  });
  queue.on('wait', (data) => bridge.send('upload:wait', data));
  queue.on('attention', (data) => {
    bridge.flushThrottled('ipc:upload:queue-updated');
    bridge.send('upload:attention', data);
  });
  queue.on('item-done', (item) => {
    bridge.flushThrottled('ipc:upload:queue-updated');
    bridge.send('upload:item-done', item);
  });
  queue.on('item-failed', (item) => {
    bridge.flushThrottled('ipc:upload:queue-updated');
    bridge.send('upload:item-failed', item);
  });
}

module.exports = bindUploadEvents;
