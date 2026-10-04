'use strict';

const path = require('node:path');
// Fora do Electron (testes) o módulo 'electron' não existe como API: tudo que dele depende tem substituto em `deps`.
let electron = {};
try { electron = require('electron') || {}; } catch (_) { electron = {}; }
const { handle: defaultHandle } = require('./channelRegistry');
const AIService = require('../services/ai/AIService');
const ChatHistory = require('../services/ai/ChatHistory');
const AssistantChat = require('../services/ai/AssistantChat');
const { analyzeTranscriptFile } = require('../services/ai/analyzeFile');
const { appPaths } = require('../infrastructure/filesystem/AppPaths');
const registry = require('../core/modules/ModuleRegistry');
const { ToolBox } = require('../services/ai/tools');
const { createNativeConfirm } = require('../services/ai/tools/confirmDialog');
const { isAssistantBuildAllowed } = require('../services/ai/releaseGate');

/**
 * TRAVA DO ASSISTENTE (fase 0 do plano), imposta aqui no PROCESSO PRINCIPAL e não só escondida na interface:
 * o assistente só roda com o build liberado + módulo "Assistente de IA" ligado + interruptor "Ativar assistente"
 * ligado. Devolve null se liberado, ou { code: 'AI_DISABLED', message }.
 * A parte "build liberado" é uma decisão única e documentada em src/services/ai/releaseGate.js (hoje liberado no app
 * final; a constante pode voltar a "só desenvolvimento").
 * @param {{ isDev:boolean, settings:object, ai:{isAssistantEnabled:Function} }} ctx
 */
function assistantBlock({ isDev, settings, ai }) {
  if (!isAssistantBuildAllowed(isDev)) return { code: 'AI_DISABLED', message: 'O assistente de IA não está disponível nesta versão do aplicativo.' };
  if (!registry.isEnabled('ai', settings, { isDev })) return { code: 'AI_DISABLED', message: 'O assistente de IA está desligado nos módulos (Configurações → Módulos).' };
  if (!ai.isAssistantEnabled()) return { code: 'AI_DISABLED', message: 'O assistente de IA está desligado (Configurações → Inteligência Artificial).' };
  return null;
}

/**
 * Handlers IPC da IA. O registrador (estratégia 'wrap') devolve { ok, data } ou { ok:false, error, code }
 * para que o renderer trate falhas sem depender do formato de erro do Electron.
 *
 * Dois grupos de canais:
 *  - ASSISTENTE (ai:chatStart, ai:chatCancel, ai:historyGet, ai:historyClear): TRAVADOS por assistantBlock; recusam
 *    com o código estável AI_DISABLED. A resposta chega por eventos (ai:chatDelta / ai:chatDone / ai:chatError, mais
 *    ai:chatStatus e ai:navigate). ai:chatStart também recusa, com códigos estáveis, o PRIMEIRO USO sem servidor
 *    (AI_NOT_CONFIGURED) e o servidor fora da rede local sem o aviso de privacidade aceito (AI_REMOTE_CONSENT).
 *  - SERVIDOR DE IA e ANÁLISE DE TRANSCRIÇÃO (ai:getConfig, saveConfig, testConnection, listModels,
 *    analyzeTranscript, cancelAnalysis): usados também pelo módulo Transcrição (recurso do app final), então NÃO
 *    dependem do assistente.
 *
 * @param {object} paths
 * FERRAMENTAS do assistente (fases 2 e 3): só existem se `projectService` vier em `deps` (o app passa; testes antigos
 * não). O renderer NÃO tem canal para executar ferramentas nem para confirmar: tudo roda aqui e a confirmação é um
 * diálogo nativo preso à janela principal. Ver .docs/ASSISTENTE_IA_FERRAMENTAS.md.
 *
 * @param {{ settingsManager?:{load:Function}, isDev?:boolean, safeStorage?:object, handle?:Function,
 *           broadcast?:Function, chatTimeouts?:object,
 *           projectService?:object, getModuleManager?:()=>object|null, getMainWindow?:()=>object|null,
 *           confirm?:Function, dialog?:object, getDb?:Function, library?:object, log?:object,
 *           downloadService?:object, converterService?:object, silenceService?:object, deviceDiscovery?:object,
 *           premiereExporter?:object, bdsproPackageService?:object, thumbnailsDir?:string, videosDir?:string,
 *           chooseSavePath?:Function }} [deps]
 *        (todos opcionais; os de ferramentas e de teste existem para injeção)
 */
function registerAiHandlers(paths, deps = {}) {
  const configDir = (paths && paths.configDir) || appPaths.configDir;
  const handle = deps.handle || defaultHandle;
  const isDev = deps.isDev !== undefined ? deps.isDev === true : !(electron.app && electron.app.isPackaged);
  const settingsManager = deps.settingsManager || null;
  const ai = new AIService({ configDir, safeStorage: deps.safeStorage || electron.safeStorage });

  const broadcast = deps.broadcast || ((channel, payload) => {
    for (const win of (electron.BrowserWindow ? electron.BrowserWindow.getAllWindows() : [])) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  });

  // Ferramentas do assistente: dependências preguiçosas (o banco e o log só são carregados quando usados)
  let toolbox = null;
  if (deps.projectService) {
    const lazyLog = { info: (m) => require('../services/logService').info(m), warn: (m) => require('../services/logService').warn(m) };
    toolbox = new ToolBox({
      getDb: deps.getDb || (() => require('../core/database/database').get()),
      library: deps.library || {
        searchMedia: (o) => require('../core/library/LibraryQueryService').searchMedia(o),
        getStats: () => require('../core/library/LibraryQueryService').getStats()
      },
      projects: deps.projectService,
      getModuleManager: deps.getModuleManager || (() => null),
      confirm: deps.confirm || createNativeConfirm({ dialog: deps.dialog || electron.dialog, getMainWindow: deps.getMainWindow || (() => null) }),
      log: deps.log || lazyLog,
      // Serviços que as telas já usam: as ferramentas só os REAPROVEITAM (sem canal novo para o renderer)
      services: { downloads: deps.downloadService, converter: deps.converterService, silence: deps.silenceService, devices: deps.deviceDiscovery },
      settings: settingsManager,
      getEnabledModules: () => registry.resolveEnabled(settingsManager && settingsManager.load ? settingsManager.load() : {}, { isDev }),
      paths: { get videosDir() { return deps.videosDir || appPaths.videosDir; } },
      exporters: { premiere: deps.premiereExporter, bdspro: deps.bdsproPackageService, thumbnailsDir: deps.thumbnailsDir || '' },
      chooseSavePath: deps.chooseSavePath || (async ({ title, defaultName, extension, filterName }) => {
        // Diálogo de SALVAR do sistema: quem escolhe pasta e nome é o USUÁRIO (o modelo nunca informa caminho)
        const win = deps.getMainWindow ? deps.getMainWindow() : null;
        const dlg = deps.dialog || electron.dialog;
        if (!dlg || typeof dlg.showSaveDialog !== 'function' || !win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return null;
        const documents = electron.app && typeof electron.app.getPath === 'function' ? electron.app.getPath('documents') : '';
        const r = await dlg.showSaveDialog(win, { title, defaultPath: documents ? path.join(documents, defaultName) : defaultName, filters: [{ name: filterName, extensions: [extension] }] });
        return r && !r.canceled && r.filePath ? r.filePath : null;
      }),
      // Abrir tela: evento main → renderer (o renderer confere de novo contra a lista fixa antes de navegar)
      navigate: (screen) => broadcast('ai:navigate', { screen }),
      // Etiquetas e favoritos mudaram: a Biblioteca aberta recarrega (evento que o app já tem)
      notifyMediaChanged: (ids) => broadcast('bds:media-updated', { ids })
    });
  }

  const chat = new AssistantChat({
    ai,
    history: new ChatHistory({ dir: configDir }),
    emit: broadcast,
    timeouts: deps.chatTimeouts || {},
    toolbox
  });

  const block = () => assistantBlock({ isDev, settings: settingsManager && settingsManager.load ? settingsManager.load() : {}, ai });
  /** Lança AI_DISABLED (o registrador 'wrap' vira { ok:false, error, code }). */
  const guard = () => {
    const why = block();
    if (why) throw Object.assign(new Error(why.message), { code: why.code });
  };

  // --- Servidor de IA (compartilhado com a Transcrição) ---
  handle('ai:getConfig', () => ai.getPublicConfig());
  handle('ai:saveConfig', (_, patch) => {
    const result = ai.saveConfig(patch || {});
    if (patch && patch.assistantEnabled === false) chat.cancel(); // desligou: para a resposta em andamento
    // servidor/modelo/provedor novo: tenta ferramentas de novo
    if (patch && ['baseUrl', 'model', 'provider', 'addProvider', 'removeProvider', 'order'].some((k) => patch[k] !== undefined)) chat.forgetToolSupport();
    return result;
  });
  handle('ai:testConnection', (_, providerId) => ai.testConnection(providerId));
  handle('ai:listModels', (_, providerId) => ai.listModels(providerId));
  // ai:chat (resposta inteira), ai:listTasks e ai:runTask foram removidos: o assistente usa o streaming abaixo e
  // o runTask aceitava caminhos arbitrários fora da trava de análise única.

  // --- Assistente (travado) ---
  handle('ai:chatStart', (_, payload) => {
    guard();
    // PRIMEIRO USO: sem servidor configurado, o chat explica e oferece "Abrir configurações da IA" (código estável)
    const problem = ai.configProblem();
    if (problem) throw Object.assign(new Error(problem.message), { code: problem.code });
    // Servidor fora da máquina e da rede local: aviso de privacidade UMA vez por servidor (o aceite fica em ai.json)
    if (ai.needsRemoteConsent()) {
      throw Object.assign(new Error(`Antes de começar: o que você escrever aqui e o que eu consultar na sua biblioteca será enviado a este servidor (${ai.serverHost()}).`), { code: 'AI_REMOTE_CONSENT' });
    }
    // O contexto da tela (opcional) é validado em AssistantChat.start (esquema, limites e telas conhecidas)
    return { id: chat.start(payload.text, payload.context) };
  });
  handle('ai:chatCancel', (_, id) => { guard(); return chat.cancel(id); });
  handle('ai:historyGet', () => { guard(); return { messages: chat.getHistory(), busy: chat.isBusy() }; });
  handle('ai:historyClear', () => { guard(); return chat.clear(); });

  // --- Análise de transcrição: uma por vez (o modelo local é um só); cancelável ---
  // Decisão: não dá para restringir a "pastas conhecidas" sem quebrar o uso (a transcrição vai para a pasta que o
  // usuário escolhe). Por isso o caminho é validado em readTranscriptFile: absoluto, extensão .md/.srt/.vtt/.txt,
  // existe, é arquivo comum (NÃO link simbólico) e até 5 MB; o resultado é gravado ao lado com writeUnique (nunca
  // sobrescreve). Nada além do texto da transcrição sai do computador (e só para o servidor escolhido).
  let analysis = null;
  handle('ai:analyzeTranscript', async (_, payload) => {
    const filePath = payload.path; // texto de 1 a 500 caracteres (esquema do canal)
    if (analysis) throw Object.assign(new Error('Já existe uma análise em andamento.'), { code: 'BUSY' });
    const controller = new AbortController();
    analysis = { controller };
    try {
      return await analyzeTranscriptFile(ai, {
        filePath,
        signal: controller.signal,
        onProgress: (p) => broadcast('ai:analysisProgress', { path: filePath, ...p })
      });
    } finally {
      analysis = null;
    }
  });
  handle('ai:cancelAnalysis', () => { if (analysis) analysis.controller.abort(); return true; });

  ai.assistantChat = chat; // usado em testes
  return ai;
}

module.exports = registerAiHandlers;
module.exports.assistantBlock = assistantBlock;
