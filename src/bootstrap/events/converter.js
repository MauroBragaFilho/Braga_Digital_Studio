'use strict';

const logger = require('../../services/logService');
const taskProgressCenter = require('../../infrastructure/desktop/TaskProgressCenter');
const notificationCenter = require('../../infrastructure/desktop/NotificationCenter');

/** Eventos do conversor -> renderer / taskbar / notificações. */
function bindConverterEvents({ bridge, services }) {
  const { converterService } = services;

  converterService.on('queue', (p) => bridge.send('converter:queue', p));
  converterService.on('fileStarted', (p) => {
    bridge.flushThrottled('ipc:converter:progress');
    bridge.send('converter:fileStarted', p);
  });
  converterService.on('progress', (p) => {
    bridge.reportProgressThrottled('converter', (p?.progress || 0) / 100);
    bridge.sendThrottled('converter:progress', p);
  });
  converterService.on('fileFinished', (p) => {
    bridge.flushThrottled('ipc:converter:progress');
    bridge.send('converter:fileFinished', p);
  });
  // Progresso geral do lote (ponderado por duração) emitido pelo serviço a cada ~500ms
  converterService.on('overallProgress', (p) => {
    bridge.reportProgressThrottled('converter', (p?.percent || 0) / 100);
    bridge.sendThrottled('converter:overallProgress', p);
  });
  converterService.on('finished', (p) => {
    bridge.flushThrottled('ipc:converter:progress', 'ipc:converter:overallProgress');
    bridge.cancelThrottled('tpc:converter');
    taskProgressCenter.reportIdle('converter');
    if (p?.status === 'error') {
      taskProgressCenter.reportError('converter');
    } else if (p?.status === 'cancelled') {
      // Cancelamento: apenas libera o centro de tarefas, sem notificar sucesso.
      logger.warn('converter:finished:cancelled');
    } else {
      // O payload 'finished' não traz contagem — calculamos pelos itens
      // efetivamente concluídos na fila do serviço.
      const count = converterService.getQueue().filter((it) => it.status === 'Concluído').length;
      notificationCenter.notifyTaskCompleted('converter', { count });
    }
    bridge.send('converter:finished', p);
  });
}

module.exports = bindConverterEvents;
