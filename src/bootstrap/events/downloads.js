'use strict';

const logger = require('../../services/logService');
const taskProgressCenter = require('../../infrastructure/desktop/TaskProgressCenter');
const notificationCenter = require('../../infrastructure/desktop/NotificationCenter');
const dbManager = require('../../core/database/database');

/** Eventos do serviço de downloads -> renderer / taskbar / biblioteca. */
function bindDownloadEvents({ bridge, services }) {
  const { downloadService, importQueue } = services;

  downloadService.on('downloads:added', (item) => bridge.send('downloads:added', item));
  downloadService.on('downloads:updated', (queue) => bridge.sendThrottled('downloads:updated', queue));
  downloadService.on('downloads:progress', (data) => {
    bridge.reportProgressThrottled('downloads', (data.progress || 0) / 100);
    bridge.sendThrottled('downloads:progress', data);
  });
  downloadService.on('downloads:completed', (item) => {
    bridge.flushThrottled('ipc:downloads:updated', 'ipc:downloads:progress');
    bridge.send('downloads:completed', item);
    if (item.outputPath && importQueue) {
      try {
        const db = dbManager.get();
        let lib = db.prepare("SELECT * FROM libraries WHERE type = 'DOWNLOADER'").get();
        if (!lib) {
          const info = db.prepare("INSERT INTO libraries (name, type, path, enabled, auto_scan) VALUES (?, ?, ?, 1, 0)").run('Downloads', 'DOWNLOADER', '');
          lib = { id: info.lastInsertRowid, type: 'DOWNLOADER' };
        }
        importQueue.add({ libraryId: lib.id, path: item.outputPath });
      } catch (err) {
        logger.error('Erro ao adicionar download à biblioteca:', { error: err.message });
      }
    }
  });
  downloadService.on('downloads:failed', (data) => {
    bridge.flushThrottled('ipc:downloads:updated', 'ipc:downloads:progress');
    bridge.cancelThrottled('tpc:downloads');
    taskProgressCenter.reportError('downloads');
    bridge.send('downloads:failed', data);
  });
  // Pausar não pode deixar a barra de progresso da taskbar presa
  downloadService.on('downloads:wait', (data) => bridge.send('downloads:wait', data));
  downloadService.on('downloads:paused', () => {
    bridge.cancelThrottled('tpc:downloads');
    taskProgressCenter.reportIdle('downloads');
  });
  downloadService.on('downloads:removed', (id) => {
    bridge.flushThrottled('ipc:downloads:updated');
    bridge.send('downloads:removed', id);
  });
  downloadService.on('downloads:queue-completed', () => {
    bridge.flushThrottled('ipc:downloads:updated', 'ipc:downloads:progress');
    bridge.cancelThrottled('tpc:downloads');
    taskProgressCenter.reportIdle('downloads');
    notificationCenter.notifyTaskCompleted('downloads', {});
    bridge.send('downloads:queue-completed');
  });
  downloadService.on('queue', (payload) => bridge.send('download:queue', payload));
  downloadService.on('progress', (payload) => bridge.send('download:progress', payload));
  downloadService.on('finished', (payload) => bridge.send('download:finished', payload));
  downloadService.on('youtube:code', (data) => bridge.send('youtube:code', data));
  downloadService.on('youtube:auth-status', (status) => bridge.send('youtube:auth-status', status));
}

module.exports = bindDownloadEvents;
