'use strict';

const { onceCreated } = require('../../core/modules/lazyService');

/** Eventos da fila de envio automático para o YouTube -> renderer (tela Envio). */
function bindUploadEvents({ bridge, services }) {
  // A fila nasce no primeiro uso (tela Envio): os eventos são ligados nesse momento
  onceCreated(services.youtubeUploadQueue, (queue) => bindTo(queue, bridge));
}

function bindTo(queue, bridge) {
  queue.on('updated', (state) => bridge.sendThrottled('upload:queue-updated', state));
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
