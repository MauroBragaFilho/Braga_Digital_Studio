'use strict';

const { dialog } = require('electron');

const perf = require('../infrastructure/diagnostics/startupPerf');

const logger = require('../services/logService');
const { DEVELOPER_EMAIL } = require('../config/appInfo');
const { errorReporter } = require('../infrastructure/telemetry/ErrorReporter');
const notificationCenter = require('../infrastructure/desktop/NotificationCenter');
const { ffmpegTool } = require('../infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');

const HistoryService = require('../services/historyService');
const UpdateService = require('../services/updateService');
const MontageService = require('../services/montageService');
const SilenceService = require('../services/silenceService');
const MetadataService = require('../services/metadataService');
const VideoRecoveryService = require('../services/videoRecoveryService');
const RawRecoveryService = require('../services/rawRecoveryService');
const PhotoPreviewService = require('../services/photoPreviewService');


const projectService = require('../core/projects/ProjectService');


const dbManager = require('../core/database/database');
const { runMigrations } = require('../core/database/migrations');
const LibraryManager = require('../core/library/LibraryManager');
const ImportQueue = require('../core/library/ImportQueue');
const LibraryWatcherService = require('../core/library/LibraryWatcherService');

const { syncLibraries } = require('./libraries');
const { lazyService } = require('../core/modules/lazyService');
const { moduleRuntime } = require('./moduleRuntime');

/**
 * Preparação da plataforma antes dos serviços: preferências de hardware, notificações,
 * telemetria de erros, LUTs embutidas e banco de dados (com migrações).
 */
async function initPlatform({ settings, appPaths, paths, settingsManager, lutManager }) {
  // Aplica as preferências de aceleração de hardware (GPU) ao serviço de detecção.
  perf.time('platform:hardwareDetection.configure', () => {
    const hardwareDetection = require('../core/HardwareDetectionService');
    hardwareDetection.configure(settings);
  });

  // Notificações nativas — refletir preferências do usuário já carregadas.
  notificationCenter.updateSettings(settings);


  // Inicializar Sistema de Envio de Erros / Telemetria
  errorReporter.init({
    logsDir: appPaths.logsDir,
    developerEmail: settings.developerEmail || DEVELOPER_EMAIL,
    endpointUrl: settings.errorReportingEndpoint || '',
    getSettings: () => settingsManager.load()
  });

  // LUTs embutidas: copiadas só com o módulo LUTs ou Dispositivos ligado (moduleRuntime.js; também ao ligá-los depois)
  moduleRuntime.setContext({ lutManager });

  // 1. Inicializar Banco de Dados
  await perf.timeAsync('db:init', () => dbManager.init(paths.databaseDir));
  const migration = perf.time('db:migrations', () => runMigrations());
  if (migration && !migration.ok) {
    // Falha de migração não derruba o app, mas o usuário precisa saber (e o backup pré-migração existe).
    logger.error('[Bootstrap] Migração do banco falhou', { failedVersion: migration.failedVersion, reason: migration.reason });
    try {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Braga Digital Studio',
        message: 'A atualização do banco de dados não foi concluída.',
        detail: 'Algumas funções podem não funcionar corretamente. Um backup do banco foi criado antes da tentativa (pasta "backups"). Detalhes foram gravados no log.'
      }).catch(() => {});
    } catch (_) { /* aviso é opcional */ }
  }
}

/** Cria todos os serviços do app (ordem de construção preservada) e devolve o mapa de serviços. */
async function createServices({ appPaths, paths, settingsManager, settings }) {
  const getSettings = () => settingsManager.load();

  // 2. Inicializar Serviços Core e Infraestrutura
  const historyService = await perf.timeAsync('services:historyService.create', () => HistoryService.create(paths.databaseDir));
  // Serviços dos módulos de tela: criados no PRIMEIRO uso (lazyService); com o módulo desligado nunca são carregados.
  const downloadService = lazyService(() => new (require('../services/downloadService'))({ paths, getSettings, historyService }));
  const converterService = lazyService(() => new (require('../services/converterService'))({ paths, getSettings, historyService }));
  const thumbnailService = lazyService(() => new (require('../services/thumbnailService'))({ paths, getSettings }));
  const updateService = new UpdateService({ paths, getSettings });
  const montageService = new MontageService({ paths, getSettings });
  const silenceService = new SilenceService({ paths, getSettings });
  const metadataServiceInstance = new MetadataService({ paths });
  const videoRecoveryService = new VideoRecoveryService({ paths });
  const rawRecoveryService = new RawRecoveryService({ paths });

  const sequenceBuilder = lazyService(() => new (require('../core/projects/SequenceBuilder'))(projectService));
  const premiereExporter = lazyService(() => new (require('../core/projects/PremiereExporter'))(projectService, sequenceBuilder));
  const bdsproPackageService = lazyService(() => new (require('../core/projects/BdsproPackageService'))(projectService));

  const waveformService = lazyService(() => new (require('../core/projects/WaveformService'))({
    ffmpegPath: ffmpegTool.resolve({ mustExist: false }),
    cacheDir: appPaths.waveformsDir
  }));
  const audioSyncService = lazyService(() => new (require('../core/projects/AudioSyncService'))({
    ffmpegPath: ffmpegTool.resolve({ mustExist: false })
  }));

  const lutSyncService = lazyService(() => new (require('../core/devices/LutSyncService'))(paths.lutsDir));
  const uploadScannerService = lazyService(() => new (require('../core/uploads/UploadScannerService'))({
    paths,
    ffprobePath: ffprobeTool.resolve({ mustExist: false }),
    ffmpegPath: ffmpegTool.resolve({ mustExist: false })
  }));

  // Fila de envio automático para o YouTube Studio (tela Envio); o histórico diário fica em dataDir
  const youtubeUploadQueue = lazyService(() => new (require('../core/uploads/YoutubeUploadQueue'))({
    getSettings,
    storeFile: require('node:path').join(appPaths.dataDir, 'youtube-uploads.json'),
    logger
  }));

  // 3. Inicializar Media Library e Watcher
  const libManager = new LibraryManager();
  const importQueue = new ImportQueue({
    ffprobePath: ffprobeTool.resolve({ mustExist: false }),
    ffmpegPath: ffmpegTool.resolve({ mustExist: false }),
    thumbnailsDir: appPaths.thumbnailsDir
  });
  const watcherService = new LibraryWatcherService(importQueue);

  // Sincronizar bibliotecas das configurações
  syncLibraries(libManager, settings);

  return {
    historyService,
    downloadService,
    converterService,
    thumbnailService,
    updateService,
    montageService,
    silenceService,
    metadataService: metadataServiceInstance,
    videoRecoveryService,
    rawRecoveryService,
    photoPreviewService: new PhotoPreviewService({ paths }),
    projectService,
    sequenceBuilder,
    premiereExporter,
    bdsproPackageService,
    waveformService,
    audioSyncService,
    lutSyncService,
    uploadScannerService,
    youtubeUploadQueue,
    libManager,
    importQueue,
    watcherService
  };
}

module.exports = { initPlatform, createServices };
