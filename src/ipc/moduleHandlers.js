'use strict';

const { BrowserWindow, shell, dialog } = require('electron');
const { handle } = require('./channelRegistry');
const path = require('node:path');
const { ModuleManager } = require('../core/modules/ModuleManager');
const { appPaths } = require('../infrastructure/filesystem/AppPaths');
const moduleConfig = require('../config/modules.config.json');
const { sanitizeSilenceOptions } = require('../core/transcription/silenceTrim');
const registry = require('../core/modules/ModuleRegistry');
const { dependencyManager } = require('../infrastructure/external-tools/DependencyManager');

/**
 * Handlers IPC dos módulos opcionais (Whisper). O registrador (estratégia 'wrap') devolve { ok, data } ou
 * { ok:false, error, code }.
 * O progresso das operações longas chega ao renderer pelo evento "modules:progress".
 *
 * @param {object} paths
 * @param {object} [deps]
 * @param {()=>string|null} [deps.getFfmpegPath]  o ffmpeg que o BDS já usa (lê vídeos e áudios).
 * @param {{load:Function,save:Function}} [deps.settingsManager]  habilita modules:list/setEnabled.
 * @param {boolean} [deps.isDev]  build de desenvolvimento (módulos devOnly só existem aqui).
 * @param {Record<string,()=>({running:boolean,cancel:()=>any})>} [deps.tasks]  tarefas de outros módulos (silence, metadata).
 */
module.exports = function registerModuleHandlers(paths, { getFfmpegPath = null, settingsManager = null, isDev = false, tasks = {} } = {}) {
  const dataDir = (paths && paths.dataDir) || appPaths.dataDir;
  const tempDir = (paths && paths.tempDir) || appPaths.tempDir;

  const manager = new ModuleManager({
    rootDir: dataDir,
    tempDir,
    config: { ...moduleConfig, ffmpegPath: getFfmpegPath || (() => process.env.WL_FFMPEG || null) }
  });

  const broadcast = (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };
  manager.on('progress', (p) => broadcast('modules:progress', p));
  manager.on('status', () => broadcast('modules:status', null));

  handle('modules:getStatus', () => manager.getStatus());
  // .zip local fora do SHA-256 oficial só instala com confirmação NATIVA (o renderer não consegue
  // se autoconfirmar), com aviso de origem não oficial (RK-065).
  const confirmUnofficialZip = async ({ zipPath, sha256 }) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const opts = {
      type: 'warning',
      buttons: ['Cancelar', 'Instalar mesmo assim'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Pacote de origem não oficial',
      message: 'Este arquivo não é o pacote oficial do recurso de transcrição.',
      detail: `A verificação de integridade não confere com o pacote oficial. O conteúdo será executado no seu computador; instale só se você confia na origem.

Arquivo: ${zipPath}`
    };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return r.response === 1;
  };

  // Os esquemas do canal (channels.js) já garantem os tipos e limites: textos de 1 a 500 caracteres.
  handle('modules:installEngine', (_, payload) => manager.installEngine({
    zipPath: payload && payload.zipPath ? payload.zipPath : null,
    confirmUnofficial: confirmUnofficialZip
  }));
  handle('modules:uninstallEngine', () => manager.uninstallEngine());
  handle('modules:installModel', (_, id) => manager.installModel(id));
  handle('modules:removeModel', (_, id) => manager.removeModel(id));
  handle('modules:setActiveModel', (_, id) => manager.setActiveModel(id));
  handle('modules:installCuda', (_, payload) => manager.installCuda({ acceptLicense: !!(payload && payload.acceptLicense === true) }));
  handle('modules:removeCuda', () => manager.removeCuda());
  handle('modules:cancel', () => manager.cancel());
  handle('modules:transcribe', (_, options) => {
    const o = options || {};
    return manager.transcribe({
      files: Array.isArray(o.files) ? o.files : [],
      srt: o.srt !== false,
      md: o.md === true,
      txt: o.txt === true,
      maxWords: Number(o.maxWords) || 0,
      lines: o.lines === 1 ? 1 : 2,
      outDir: o.outDir ? o.outDir : null,
      forceCpu: o.forceCpu === true,
      skipSilence: o.skipSilence !== false,
      silence: sanitizeSilenceOptions(o.silence)
    });
  });
  // Só revela o arquivo no Explorer (não abre nem executa nada).
  handle('modules:reveal', (_, p) => { shell.showItemInFolder(path.resolve(p)); return true; });

  // --- Sistema de módulos (ligar/desligar recursos) ---
  const loadSettings = () => (settingsManager && settingsManager.load ? settingsManager.load() : {});

  // Motor instalado? 'whisper' vem do ModuleManager; 'tool:<x>' é um componente sob demanda do DependencyManager.
  const engineIsInstalled = (m, whisperInstalled) => {
    if (!m.hasEngine) return true;
    if (m.engine && m.engine.startsWith('tool:')) {
      try { return dependencyManager.isAvailable(m.engine.slice(5)); } catch (_) { return false; }
    }
    return whisperInstalled;
  };

  handle('modules:list', async () => {
    const enabled = registry.resolveEnabled(loadSettings(), { isDev });
    let engineInstalled = false;
    try { engineInstalled = !!(await manager.getStatus()).engine?.installed; } catch (_) { /* sem status: não instalado */ }
    return registry.MODULES
      .filter((m) => !m.devOnly || isDev)
      .map((m) => ({
        id: m.id,
        title: m.title,
        description: m.description,
        screens: [...m.screens],
        devOnly: m.devOnly,
        hasEngine: m.hasEngine,
        engine: m.engine || null,
        enabled: enabled[m.id],
        installed: engineIsInstalled(m, engineInstalled),
        available: true // todos os motores atuais existem nos três sistemas; ajuste aqui por process.platform se algum não existir
      }));
  });

  // Tarefa em andamento do módulo (ou null). Usa o cancelamento que cada serviço já oferece.
  const runningTask = async (id) => {
    if (id === 'transcription') {
      const st = await manager.getStatus();
      return st && st.busy ? { cancel: () => manager.cancel() } : null;
    }
    const t = typeof tasks[id] === 'function' ? tasks[id]() : null;
    return t && t.running ? t : null;
  };

  handle('modules:setEnabled', async (_, id, enabled) => {
    if (!registry.isKnownId(id)) throw new Error('Módulo desconhecido.');
    if (!settingsManager) throw new Error('Configurações indisponíveis.');
    const def = registry.getModule(id);
    if (def.devOnly && !isDev) throw new Error('Módulo indisponível nesta versão.');
    if (!enabled) {
      const task = await runningTask(id);
      if (task) {
        try { await task.cancel(); } catch (_) { throw new Error('Termine ou cancele a tarefa em andamento antes de desligar este módulo.'); }
      }
    }
    const current = registry.sanitizeEnabledModules(loadSettings().enabledModules);
    settingsManager.save({ enabledModules: { ...current, [id]: enabled } });
    broadcast('modules:changed', registry.resolveEnabled(loadSettings(), { isDev }));
    return registry.resolveEnabled(loadSettings(), { isDev });
  });

  return manager;
};
