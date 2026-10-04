'use strict';

/**
 * Ferramentas do assistente de IA (function calling do protocolo compatível com a OpenAI).
 * Documentação completa: .docs/ASSISTENTE_IA_FERRAMENTAS.md
 *
 * A lista é FIXA e tem três tipos: LEITURA (consultas), INTERFACE (open_screen, só navega) e AÇÃO "aditiva" (baixar,
 * converter, tirar silêncio, transcrever, criar projeto, adicionar a projeto, etiquetar, favoritar, exportar). Não existe
 * ferramenta que apague, mova, renomeie, mude configurações ou execute comandos, e o modelo só consegue chamar o que
 * está nesta lista: qualquer outro nome (por exemplo uma ferramenta destrutiva sugerida por texto injetado em um nome
 * de arquivo) é recusado.
 *
 * Quem executa é o ToolBox, SEMPRE no processo principal:
 *   1. acha a ferramenta pelo nome (desconhecida = recusa);
 *   2. valida os argumentos com o esquema estrito (schema.js);
 *   3. ferramenta de LEITURA ou de INTERFACE: executa; ferramenta de AÇÃO: prepare() → diálogo nativo de confirmação
 *      (confirm) → run();
 *   4. devolve um texto curto e seguro (results.js: sem caminhos, com limite, marcado como dado).
 * O renderer não tem canal para executar ferramentas nem para confirmar: a confirmação é do app, não do modelo.
 */

const { validateArgs, parseArgs, ArgError } = require('./schema');
const { serializeResult, serializeError, safeText } = require('./results');
const { ToolError } = require('./common');
const { readTools } = require('./readTools');
const { statusTools } = require('./statusTools');
const { actionTools } = require('./actionTools');
const { mediaActionTools } = require('./mediaActionTools');
const { libraryActionTools } = require('./libraryActionTools');
const { selectToolNames } = require('./toolSelect');
const { ASSISTANT_ALLOWED_IN_PACKAGED_APP, isAssistantBuildAllowed } = require('../releaseGate');

/** Lista fixa de ferramentas: leitura, interface (open_screen) e ações com confirmação. */
const TOOLS = Object.freeze([...readTools, ...statusTools, ...actionTools, ...mediaActionTools, ...libraryActionTools].map((t) => Object.freeze(t)));
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function listTools() { return TOOLS; }

/**
 * Definições no formato `tools` do protocolo de chat (tipo "function" + esquema JSON).
 * @param {Set<string>|string[]|null} [only]  nomes a incluir (subconjunto por turno, ver toolSelect.js); sem isso, todas
 */
function toolDefinitions(only = null) {
  const keep = only ? new Set(only) : null;
  return TOOLS.filter((t) => !keep || keep.has(t.name))
    .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Promessa que rejeita com CANCELLED se o sinal abortar antes dela terminar. */
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' }));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

class ToolBox {
  /**
   * @param {object} deps
   * @param {() => object} deps.getDb                  banco SQLite (better-sqlite3 ou o wrapper do app)
   * @param {object} deps.library                      LibraryQueryService (searchMedia)
   * @param {object} deps.projects                     ProjectService
   * @param {() => object|null} deps.getModuleManager  ModuleManager (transcrição) ou null
   * @param {(req:{title:string,message:string,detail:string,signal?:AbortSignal}) => Promise<boolean>} deps.confirm
   *        diálogo de confirmação NATIVO (injetável em teste). Só `true` explícito executa a ação.
   * @param {{info:Function,warn:Function}} [deps.log]
   * @param {() => void} [deps.onProjectsChanged]      avisa as telas que a lista de projetos mudou
   * @param {{downloads?:object, converter?:object, silence?:object, devices?:object}} [deps.services]
   *        serviços que as telas já usam (fila de Downloads, Conversor, Remover Silêncio, descoberta de dispositivos)
   * @param {{load:Function}} [deps.settings]            SettingsManager (só leitura: tema, módulos, pastas de destino)
   * @param {() => Record<string,boolean>} [deps.getEnabledModules]  módulos ligados agora
   * @param {{videosDir?:string}} [deps.paths]           pastas padrão do app
   * @param {{premiere?:object, bdspro?:object, thumbnailsDir?:string}} [deps.exporters]  exportadores de projeto
   * @param {(req:object) => Promise<string|null>} [deps.chooseSavePath]  diálogo de SALVAR do sistema (escolha do usuário)
   * @param {(screen:string) => void} [deps.navigate]     manda o renderer abrir uma tela (evento ai:navigate)
   * @param {(ids:number[]) => void} [deps.notifyMediaChanged]  avisa a Biblioteca que mídias mudaram
   */
  constructor({
    getDb, library, projects, getModuleManager = () => null, confirm, log = null, onProjectsChanged = null,
    services = {}, settings = null, getEnabledModules = () => ({}), paths = {}, exporters = {}, chooseSavePath = null,
    navigate = null, notifyMediaChanged = null
  }) {
    this.deps = {
      getDb, library, projects, getModuleManager, onProjectsChanged,
      services, settings, getEnabledModules, paths, exporters, chooseSavePath, navigate, notifyMediaChanged
    };
    this.confirm = confirm;
    this.log = log || { info() {}, warn() {} };
  }

  /**
   * Definições a oferecer ao modelo. Sem `hints` = todas. Com `hints` ({ texts, screen, used }) = só o subconjunto
   * relevante (toolSelect.js). Isto NÃO limita o que o ToolBox aceita na execução: a lista fixa inteira continua valendo.
   */
  definitions(hints = null) {
    return toolDefinitions(hints ? selectToolNames(hints) : null);
  }

  /** Resposta para chamadas além do limite por pergunta (o laço do chat as recusa sem executar). */
  limitReached() {
    return serializeError('Limite de chamadas de ferramentas atingido nesta pergunta. Responda ao usuário com o que já tem.');
  }

  /**
   * Executa UMA chamada de ferramenta pedida pelo modelo e devolve o texto do resultado (nunca lança, exceto
   * cancelamento: lança { code:'CANCELLED' } para o laço do chat encerrar).
   * @param {string} name
   * @param {string|object} rawArgs      texto JSON ou objeto vindo do modelo
   * @param {{signal?:AbortSignal, onStatus?:(text:string, kind?:string)=>void}} [run]
   * @returns {Promise<string>}
   */
  async execute(name, rawArgs, { signal = null, onStatus = () => {} } = {}) {
    const cancelled = () => Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' });
    if (signal && signal.aborted) throw cancelled();
    const tool = typeof name === 'string' ? BY_NAME.get(name) : undefined;
    if (!tool) {
      this.log.warn(`[Assistente] ferramenta desconhecida recusada: ${safeText(name, 40)}`);
      return serializeError(`A ferramenta "${safeText(name, 40)}" não existe. Ferramentas disponíveis: ${TOOLS.map((t) => t.name).join(', ')}.`);
    }
    const ctx = { ...this.deps, signal, onStatus: (text, kind) => onStatus(text, kind) };
    try {
      const args = validateArgs(tool.parameters, parseArgs(rawArgs));
      onStatus(tool.status(args), tool.kind === 'action' ? 'confirm' : 'tool');
      if (tool.kind !== 'action') return serializeResult(await tool.run(args, ctx), tool.resultOptions); // leitura e interface

      // ---- AÇÃO: prepara (valida no banco), pede confirmação NATIVA e só então executa ----
      const prep = await tool.prepare(args, ctx);
      if (signal && signal.aborted) throw cancelled();
      let confirmed = false;
      try {
        // Corrida com o cancelamento: parar o chat encerra o fluxo na hora (o diálogo nativo fecha pelo mesmo sinal)
        confirmed = (await abortable(this.confirm({ title: 'Confirmar ação do assistente', message: prep.message, detail: prep.detail, signal }), signal)) === true;
      } catch (err) {
        if (err && err.code === 'CANCELLED') throw err;
        confirmed = false;
      }
      if (signal && signal.aborted) throw cancelled(); // cancelou durante a confirmação: não executa
      if (!confirmed) {
        this.log.info(`[Assistente] ação RECUSADA pelo usuário: ${tool.name} (${prep.auditSummary || 'sem detalhes'})`);
        return serializeResult({ resultado: 'O usuário recusou. Nada foi feito.' });
      }
      this.log.info(`[Assistente] ação CONFIRMADA pelo usuário: ${tool.name} (${prep.auditSummary || 'sem detalhes'})`);
      onStatus('Executando…', 'tool');
      const out = await tool.run(prep.plan, ctx);
      this.log.info(`[Assistente] ação concluída: ${tool.name}`);
      if (signal && signal.aborted) throw cancelled(); // parou no meio: o laço do chat encerra
      return serializeResult(out, tool.resultOptions);
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' });
      if (err instanceof ArgError || err instanceof ToolError) return serializeError(err.message);
      this.log.warn(`[Assistente] falha na ferramenta ${tool.name}: ${safeText(err && err.message, 120)}`);
      return serializeError('Não foi possível concluir esta consulta ou ação agora.');
    }
  }
}

module.exports = { TOOLS, listTools, toolDefinitions, ToolBox, selectToolNames, isAssistantBuildAllowed, ASSISTANT_ALLOWED_IN_PACKAGED_APP };
