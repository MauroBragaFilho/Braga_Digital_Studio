'use strict';

const { app } = require('electron');
const logger = require('../services/logService');
const { liveService, lazyService } = require('../core/modules/lazyService');
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
    videoRecoveryService, rawRecoveryService, jpgRecoveryService, projectService, premiereExporter, bdsproPackageService,
    waveformService, audioSyncService, sequenceBuilder,
    uploadScannerService, youtubeUploadQueue, libManager, watcherService, lutSyncService, importQueue
  } = services;

  // Registra Handlers por Módulo
  require('./confirmHandlers')();
  require('./deviceHandlers')(logger, lutSyncService);
  require('./libraryHandlers')(paths, watcherService, { libManager, settingsManager });
  // 'isBusy': limpar o armazenamento temporário durante uma tarefa apagaria arquivos em uso
  require('./systemHandlers')(paths, settingsManager, {
    isBusy: () => {
      try {
        return Boolean(
          (liveService(services.downloadService)?.getQueue?.() || []).some((i) => i.status === 'downloading') ||
          liveService(services.converterService)?.running ||
          services.silenceService.running ||
          services.metadataService.currentProcess ||
          liveService(services.youtubeUploadQueue)?.running
        );
      } catch (_) { return false; }
    }
  });
  require('./recoveryHandlers')(videoRecoveryService, paths, rawRecoveryService, jpgRecoveryService);
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
    getMainWindow,
    // Serviços que as ferramentas do assistente reaproveitam (as mesmas instâncias das telas)
    downloadService,
    converterService,
    silenceService,
    deviceDiscovery: lazyService(() => require('../core/devices/DeviceDiscoveryService')),
    premiereExporter,
    bdsproPackageService,
    thumbnailsDir: appPaths.thumbnailsDir
  });
  // O ModuleManager é devolvido para ser cancelado no encerramento do app.
  moduleManager = require('./moduleHandlers')(paths, {
    getFfmpegPath: () => ffmpegTool.resolve({ mustExist: false }),
    settingsManager,
    isDev: !app.isPackaged,
    tasks: {
      silence: () => services.silenceService,
      // Serviços de módulos criados sob demanda: só há o que cancelar se já existirem
      download: () => {
        const d = liveService(services.downloadService);
        return d ? { running: (d.getQueue?.() || []).some((i) => i.status === 'downloading'), cancel: () => d.pause?.() } : null;
      },
      converter: () => {
        const c = liveService(services.converterService);
        return c ? { running: !!c.isRunning?.(), cancel: () => c.cancelCurrent?.() } : null;
      },
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
  require('./uploadHandlers')({ uploadScannerService, youtubeUploadQueue, settingsManager, getMainWindow });

  return { moduleManager };
}

module.exports = { registerIpcHandlers };
