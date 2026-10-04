'use strict';

const { app } = require('electron');
const logger = require('../services/logService');
const { ffmpegTool } = require('../infrastructure/external-tools/adapters/FfmpegTool');

/**
 * Registra TODOS os handlers IPC (ipcMain.handle), por domínio, na ordem original do bootstrap.
 *
 * `ctx` = { paths, appPaths, settingsManager, lutManager, services, getMainWindow, syncLibraries }.
 * Devolve { moduleManager } (guardado pelo Bootstrap para cancelar no encerramento do app).
 */
function registerIpcHandlers(ctx) {
  const { paths, appPaths, settingsManager, lutManager, services, getMainWindow, syncLibraries } = ctx;
  const {
    downloadService, converterService, historyService, thumbnailService,
    updateService, montageService, silenceService, metadataService,
    videoRecoveryService, rawRecoveryService, projectService, premiereExporter, bdsproPackageService,
    waveformService, audioSyncService, sequenceBuilder,
    uploadScannerService, libManager, watcherService, lutSyncService, importQueue
  } = services;

  // Registra Handlers por Módulo
  require('./deviceHandlers')(logger, lutSyncService);
  require('./libraryHandlers')(paths, watcherService);
  // 'isBusy': limpar o armazenamento temporário durante uma tarefa apagaria arquivos em uso
  require('./systemHandlers')(paths, settingsManager, {
    isBusy: () => {
      try {
        return Boolean(
          (services.downloadService.getQueue?.() || []).some((i) => i.status === 'downloading') ||
          services.converterService.running ||
          services.silenceService.running ||
          services.metadataService.currentProcess
        );
      } catch (_) { return false; }
    }
  });
  require('./recoveryHandlers')(videoRecoveryService, paths, rawRecoveryService);
  require('./photoPreviewHandlers')(services.photoPreviewService);
  require('./youtubeHandlers')();
  require('./projectHandlers')(projectService, premiereExporter, bdsproPackageService, paths, waveformService, audioSyncService, sequenceBuilder);
  require('./lutHandlers')(lutManager);
  require('./telemetryHandlers')();
  require('./licensesHandlers')();
  require('./jobHandlers')();
  // O ModuleManager nasce logo abaixo: o assistente o pega só na hora de usar (transcrição).
  let moduleManager = null;
  require('./aiHandlers')(paths, {
    settingsManager,
    isDev: !app.isPackaged,
    projectService,
    getModuleManager: () => moduleManager,
    getMainWindow
  });
  // O ModuleManager é devolvido para ser cancelado no encerramento do app.
  moduleManager = require('./moduleHandlers')(paths, {
    getFfmpegPath: () => ffmpegTool.resolve({ mustExist: false }),
    settingsManager,
    isDev: !app.isPackaged,
    tasks: {
      silence: () => services.silenceService,
      metadata: () => ({ running: !!services.metadataService.currentProcess, cancel: () => services.metadataService.cancel() })
    }
  });

  // Handlers que antes eram inline no bootstrap
  require('./settingsHandlers')({ settingsManager, appPaths, libManager, watcherService, updateService, syncLibraries });
  require('./hardwareHandlers')({ settingsManager });
  require('./windowHandlers')(getMainWindow);
  require('./dialogHandlers')(getMainWindow);
  require('./downloadHandlers')({ downloadService, thumbnailService, settingsManager });
  require('./mediaToolsHandlers')({ converterService, montageService, silenceService, metadataService });
  require('./historyHandlers')(historyService);
  require('./updateHandlers')(updateService);
  require('./deviceListHandlers')();
  require('./sonyHandlers')({ importQueue });
  require('./uploadHandlers')({ uploadScannerService, settingsManager, getMainWindow });

  return { moduleManager };
}

module.exports = { registerIpcHandlers };
