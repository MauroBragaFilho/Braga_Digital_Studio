'use strict';

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
 * o assistente só roda em DESENVOLVIMENTO (app não empacotado) + módulo "Assistente de IA" ligado + interruptor
 * "Ativar assistente" ligado. Devolve null se liberado, ou { code: 'AI_DISABLED', message }.
 * A parte "só desenvolvimento" é uma decisão única e documentada em src/services/ai/releaseGate.js (para liberar no app
 * final basta trocar a constante de lá).
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
 *    com o código estável AI_DISABLED. A resposta chega por eventos (ai:chatDelta / ai:chatDone / ai:chatError).
 *  - SERVIDOR DE IA e ANÁLISE DE TRANSCRIÇÃO (ai:getConfig, saveConfig, testConnection, listModels,
 *    analyzeTranscript, cancelAnalysis): usados também pelo módulo Transcrição (recurso do app final), então NÃO
 *    dependem do assistente. O assistente não consegue ser ligado fora do desenvolvimento por eles: o gate acima
 *    sempre confere o build.
 *
 * @param {object} paths
 * FERRAMENTAS do assistente (fases 2 e 3): só existem se `projectService` vier em `deps` (o app passa; testes antigos
 * não). O renderer NÃO tem canal para executar ferramentas nem para confirmar: tudo roda aqui e a confirmação é um
 * diálogo nativo preso à janela principal. Ver .docs/ASSISTENTE_IA_FERRAMENTAS.md.
 *
 * @param {{ settingsManager?:{load:Function}, isDev?:boolean, safeStorage?:object, handle?:Function,
 *           broadcast?:Function, chatTimeouts?:object,
 *           projectService?:object, getModuleManager?:()=>object|null, getMainWindow?:()=>object|null,
 *           confirm?:Function, dialog?:object, getDb?:Function, library?:object, log?:object }} [deps]
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
      library: deps.library || { searchMedia: (o) => require('../core/library/LibraryQueryService').searchMedia(o) },
      projects: deps.projectService,
      getModuleManager: deps.getModuleManager || (() => null),
      confirm: deps.confirm || createNativeConfirm({ dialog: deps.dialog || electron.dialog, getMainWindow: deps.getMainWindow || (() => null) }),
      log: deps.log || lazyLog
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
    if (patch && (patch.baseUrl !== undefined || patch.model !== undefined)) chat.forgetToolSupport(); // servidor/modelo novo: tenta ferramentas de novo
    return result;
  });
  handle('ai:testConnection', () => ai.testConnection());
  handle('ai:listModels', () => ai.listModels());
  // ai:chat (resposta inteira), ai:listTasks e ai:runTask foram removidos: o assistente usa o streaming abaixo e
  // o runTask aceitava caminhos arbitrários fora da trava de análise única.

  // --- Assistente (travado) ---
  handle('ai:chatStart', (_, payload) => { guard(); return { id: chat.start(payload.text) }; });
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
