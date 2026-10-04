'use strict';

/**
 * runSetupMode — liga o modo de componentes (ComponentsSetup) ao app de verdade: ferramentas básicas
 * (ToolUpdater: fonte oficial + SHA-256), módulo de transcrição (ModuleManager: motor e modelo oficiais
 * com SHA-256) e configurações (liga o módulo). Chamado pelo main.js quando o instalador executa
 * `BragaDigitalStudio.exe --setup-components=basic|full`. Não abre janela e não inicia o app normal.
 */

const fs = require('node:fs');
const path = require('node:path');
const { runComponentsSetup } = require('./ComponentsSetup');

const RECORD_NAME = 'setup-components.json';
const recordPathFor = (appPaths) => path.join(appPaths.dataDir, RECORD_NAME);

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* noop */ } }

/** Apaga parciais de downloads (motor, modelo, ferramentas) deixados por falha, cancelamento ou limite de tempo. */
async function cleanupPartials({ appPaths, toolUpdater }) {
  const models = path.join(appPaths.dataDir, 'modules', 'whisper', 'models');
  try {
    for (const name of fs.readdirSync(models)) if (name.endsWith('.partial')) rmrf(path.join(models, name));
  } catch (_) { /* pasta ainda não existe */ }
  try {
    const tmp = path.join(appPaths.tempDir, 'modules');
    for (const name of fs.readdirSync(tmp)) if (/^(engine|cuda)_\d+$/.test(name)) rmrf(path.join(tmp, name));
  } catch (_) { /* sem temporários */ }
  try { await toolUpdater.cleanupStaleResidue({ maxAgeMs: 0 }); } catch (_) { /* noop */ }
}

/**
 * @param {{args:{mode:string, modelId:string, progressFile:string|null, cancelFile:string|null, timeoutSec:number},
 *          appPaths:object, appVersion?:string, log?:Function}} p
 * @returns {Promise<number>} código de saída (ver ComponentsSetup.EXIT)
 */
async function runSetupMode({ args, appPaths, appVersion = null, log = () => {} }) {
  const { externalTools } = require('../infrastructure/external-tools/ExternalToolsManager');
  const { toolUpdater } = require('../infrastructure/external-tools/ToolUpdater');
  const { hasSource } = require('../infrastructure/external-tools/ToolSources');
  const { ModuleManager } = require('../core/modules/ModuleManager');
  const moduleConfig = require('../config/modules.config.json');
  const SettingsManager = require('../core/settings/SettingsManager');
  const { enableTranscriptionModule } = require('./enableTranscription');

  externalTools.init(appPaths.dataDir);
  toolUpdater.init(appPaths.dataDir);
  const adapters = { ffmpeg: externalTools.ffmpeg, ffprobe: externalTools.ffprobe, ytdlp: externalTools.ytdlp };
  const manager = new ModuleManager({
    rootDir: appPaths.dataDir,
    tempDir: appPaths.tempDir,
    config: { ...moduleConfig, ffmpegPath: () => { try { return adapters.ffmpeg.resolve({ mustExist: false }); } catch (_) { return null; } } }
  });

  const deps = {
    isToolInstalled: (tool) => { try { return Boolean(adapters[tool] && adapters[tool].exists()); } catch (_) { return false; } },
    isToolSupported: (tool) => hasSource(tool),
    // Mesma política da primeira abertura do app para as ferramentas essenciais (ver bootstrap/startup.js):
    // a integridade é conferida por SHA-256 sempre que a release oficial o publica.
    installTool: (tool, onPercent) => toolUpdater.update(tool, onPercent, { allowUnverified: true }),
    modules: manager,
    enableTranscription: () => {
      const SM = SettingsManager.SettingsManager || SettingsManager;
      enableTranscriptionModule(new SM(appPaths.configDir, appPaths.dataDir));
    },
    cleanup: () => cleanupPartials({ appPaths, toolUpdater })
  };

  const { exitCode } = await runComponentsSetup({
    mode: args.mode,
    modelId: args.modelId,
    deps,
    progressFile: args.progressFile,
    cancelFile: args.cancelFile,
    recordPath: recordPathFor(appPaths),
    appVersion,
    timeoutMs: args.timeoutSec * 1000,
    log
  });
  return exitCode;
}

module.exports = { runSetupMode, recordPathFor, cleanupPartials, RECORD_NAME };
