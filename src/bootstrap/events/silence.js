'use strict';

const taskProgressCenter = require('../../infrastructure/desktop/TaskProgressCenter');
const notificationCenter = require('../../infrastructure/desktop/NotificationCenter');

/** Eventos do removedor de silêncio -> renderer / taskbar / notificações. */
function bindSilenceEvents({ bridge, services }) {
  const { silenceService } = services;

  silenceService.on('progress', (p) => {
    bridge.reportProgressThrottled('silence', (p?.percent || 0) / 100);
    // Mudança de estado de um arquivo (Analisando, Concluído, Ignorado, Erro...) nunca é descartada pelo throttle:
    // senão a tela perde o estado final dos arquivos que não eram o último da fila.
    if (p?.status && p.status !== 'Processando...') {
      bridge.flushThrottled('ipc:silence:progress');
      bridge.send('silence:progress', p);
    } else {
      bridge.sendThrottled('silence:progress', p);
    }
  });
  silenceService.on('finished', (p) => {
    bridge.flushThrottled('ipc:silence:progress');
    bridge.cancelThrottled('tpc:silence');
    taskProgressCenter.reportIdle('silence');
    if (p?.status === 'error') {
      taskProgressCenter.reportError('silence');
    } else if (p?.status !== 'canceled') {
      // payload.file fica undefined até o silenceService emitir o nome do
      // último arquivo — o NotificationCenter cai no texto genérico.
      notificationCenter.notifyTaskCompleted('silence', { file: p?.lastFile });
    }
    bridge.send('silence:finished', p);
  });
  silenceService.on('log', (p) => bridge.send('silence:log', p));
}

module.exports = bindSilenceEvents;
