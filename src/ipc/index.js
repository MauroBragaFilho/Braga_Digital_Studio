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
  const isBusy = () => {
    try {
      return Boolean(
        (liveService(services.downloadService)?.getQueue?.() || []).some((i) => i.status === 'downloading') ||
        liveService(services.converterService)?.running ||
        services.silenceService.running ||
        services.metadataService.currentProcess ||
        liveService(services.youtubeUploadQueue)?.running
      );
    } catch (_) { return false; }
  };
  require('./systemHandlers')(paths, settingsManager, { isBusy });

  // Placa de vídeo NVIDIA com driver antigo para o FFmpeg padrão: o teste do NVENC falha e o app trocaria para o processador.
  // O conserto troca UMA vez (no máximo duas) o FFmpeg pela versão estável e lembra a escolha (FfmpegAutoFix.js).
  try {
    const { toolUpdater } = require('../infrastructure/external-tools/ToolUpdater');
    const { FfmpegAutoFix } = require('../infrastructure/external-tools/FfmpegAutoFix');
    const hardwareDetection = require('../core/HardwareDetectionService');
    const ffmpegAutoFix = new FfmpegAutoFix({
      updater: toolUpdater,
      getSettings: () => settingsManager.load(),
      saveSettings: (patch) => settingsManager.save(patch),
      getFfmpegVersion: () => {
        const exe = ffmpegTool.resolve({ mustExist: true });
        return exe ? toolUpdater._getVersion(exe, ['-version']) : null;
      },
      isBusy,
      onFixed: () => hardwareDetection.invalidateCache(),
      logger
    });
    ffmpegAutoFix.applyChannel();
    hardwareDetection.onEncoderFailure = (encoder, error) => (/nvenc/i.test(encoder) ? ffmpegAutoFix.check(error) : null);
  } catch (e) { logger.warn('ffmpeg:autofix_unavailable', { error: e && e.message }); }
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
  const aiApi = require('./aiHandlers')(paths, {
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
  // Organização dos arquivos ao copiar de um dispositivo (o sistema local é o mesmo do assistente, ligado só sob demanda)
  require('./organizerHandlers')({ getLlm: () => aiApi.localLlm, projectService, importQueue: services.importQueue, getDb: () => require('../core/database/database').get() });
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
