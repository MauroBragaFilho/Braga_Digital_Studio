'use strict';

const { BrowserWindow, shell, safeStorage } = require('electron');
const { handle } = require('./channelRegistry');
const { appConfirm } = require('../infrastructure/desktop/AppConfirm');
const path = require('node:path');
const fs = require('node:fs');
const { lazyService, onceCreated } = require('../core/modules/lazyService');
const { engineFiles } = require('../core/modules/sources');
// [PERF] ModuleManager (e o que ele carrega: motor, fontes, transcrição) só entra no primeiro uso dos módulos.
const { appPaths } = require('../infrastructure/filesystem/AppPaths');
const moduleConfig = require('../config/modules.config.json');
const { sanitizeSilenceOptions } = require('../core/transcription/silenceTrim');
const { CloudConfig } = require('../core/transcription/CloudConfig');
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

  // Transcrição na nuvem (Groq/ElevenLabs): chaves próprias, separadas do assistente de IA, criptografadas no disco
  const cloudConfig = new CloudConfig({ configDir: (paths && paths.configDir) || appPaths.configDir, safeStorage });

  const manager = lazyService(() => {
    const { ModuleManager } = require('../core/modules/ModuleManager');
    return new ModuleManager({
      rootDir: dataDir,
      tempDir,
      config: { ...moduleConfig, ffmpegPath: getFfmpegPath || (() => process.env.WL_FFMPEG || null) },
      cloudConfig
    });
  });

  const broadcast = (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };
  onceCreated(manager, (m) => {
    m.on('progress', (p) => broadcast('modules:progress', p));
    // Barra de tarefas: transcrição e instalação de recursos (motor, modelo, aceleração) mostram o andamento no ícone
    m.on('progress', (p) => {
      const taskProgressCenter = require('../infrastructure/desktop/TaskProgressCenter');
      const phase = p && p.phase;
      if (phase === 'done' || phase === 'cancelled') return taskProgressCenter.reportIdle('modules');
      if (phase === 'error') return taskProgressCenter.reportError('modules');
      if (typeof p?.percent === 'number') taskProgressCenter.reportProgress('modules', p.percent / 100);
      else taskProgressCenter.reportIndeterminate('modules');
    });
    m.on('status', () => broadcast('modules:status', null));
  });

  handle('modules:getStatus', () => manager.getStatus());
  // .zip local fora do SHA-256 oficial só instala com confirmação NATIVA (o renderer não consegue
  // se autoconfirmar), com aviso de origem não oficial (RK-065).
  // O diálogo vai para a janela que pediu a instalação (P14): getFocusedWindow() podia ser outra janela
  // (ou nenhuma, com o app sem foco). Sem remetente válido, cai na primeira janela do app.
  const senderWebContents = (sender) => {
    if (sender && typeof sender.isDestroyed === 'function' && !sender.isDestroyed()) return sender;
    const win = BrowserWindow.getAllWindows()[0] || null;
    return win && !win.isDestroyed() ? win.webContents : null;
  };
  const confirmUnofficialZip = async ({ zipPath, sha256 }, sender) => {
    return appConfirm({
      webContents: senderWebContents(sender),
      title: 'Pacote de origem não oficial',
      message: 'Este arquivo não é o pacote oficial do recurso de transcrição.',
      detail: `A verificação de integridade não confere com o pacote oficial. O conteúdo será executado no seu computador; instale só se você confia na origem.

Arquivo: ${zipPath}`,
      confirmLabel: 'Instalar mesmo assim'
    });
  };

  // Os esquemas do canal (channels.js) já garantem os tipos e limites: textos de 1 a 500 caracteres.
  handle('modules:installEngine', (event, payload) => manager.installEngine({
    zipPath: payload && payload.zipPath ? payload.zipPath : null,
    confirmUnofficial: (info) => confirmUnofficialZip(info, event && event.sender)
  }));
  handle('modules:uninstallEngine', () => manager.uninstallEngine());
  handle('modules:installModel', (_, id) => manager.installModel(id));
  handle('modules:removeModel', (_, id) => manager.removeModel(id));
  handle('modules:setActiveModel', (_, id) => manager.setActiveModel(id));
  handle('modules:installCuda', (_, payload) => manager.installCuda({ acceptLicense: !!(payload && payload.acceptLicense === true) }));
  handle('modules:removeCuda', () => manager.removeCuda());
  handle('modules:cancel', () => manager.cancel());
  handle('modules:cloudGet', () => cloudConfig.getPublic());
  // A chave só entra aqui e fica criptografada no disco; nunca volta para a interface.
  handle('modules:cloudSet', (_, patch) => {
    const p = patch || {};
    return cloudConfig.set({
      provider: p.provider,
      apiKey: typeof p.apiKey === 'string' ? p.apiKey : undefined,
      clearApiKey: p.clearApiKey === true,
      model: typeof p.model === 'string' ? p.model : undefined
    });
  });
  handle('modules:cloudTest', (_, provider) => cloudConfig.test(provider));
  handle('modules:transcribe', (_, options) => {
    const o = options || {};
    const saved = settingsManager && settingsManager.load ? settingsManager.load() : {};
    return manager.transcribe({
      engine: ['groq', 'elevenlabs'].includes(o.engine) ? o.engine : 'local',
      // Para onde tentar de novo se o serviço escolhido falhar (Configurações → Transcrição). Com motor local, não vale.
      fallback: Array.isArray(saved.transcriptionFallback) ? saved.transcriptionFallback : [],
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

  // Motor da transcrição instalado? Confere o MESMO arquivo que o ModuleManager (whisper-cli) direto no disco, sem criar
  // o gerenciador na abertura. (A versão anterior lia getStatus().engine, que não existe — o campo é whisper.engine —,
  // e por isso a lista sempre dizia 'não instalado' e Configurações pedia 'instalar um componente' mesmo com o motor.)
  const whisperEngineInstalled = () => {
    try { return fs.existsSync(path.join(dataDir, 'modules', 'whisper', 'engine', engineFiles(process.platform).cli)); } catch (_) { return false; }
  };

  handle('modules:list', async () => {
    const enabled = registry.resolveEnabled(loadSettings(), { isDev });
    const engineInstalled = whisperEngineInstalled();
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
    // Tarefas de fundo do módulo (monitoramento, descoberta, prazos…) começam/param agora, sem reiniciar o app
    try { await require('../bootstrap/moduleRuntime').moduleRuntime.toggle(id, enabled); } catch (_) { /* a escolha já foi salva */ }
    broadcast('modules:changed', registry.resolveEnabled(loadSettings(), { isDev }));
    return registry.resolveEnabled(loadSettings(), { isDev });
  });

  return manager;
};
