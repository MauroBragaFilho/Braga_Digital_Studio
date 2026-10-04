'use strict';

/**
 * channelRegistry.js — ÚNICO ponto que chama `ipcMain.handle` (RK-010).
 *
 *   const { handle } = require('./channelRegistry');
 *   handle('projects:get', (event, id) => service.get(id));           // esquema vem da tabela (channels.js)
 *   handle('projects:get', [t.id({ name: 'id' })], fn);               // ou esquema explícito
 *
 * Para CADA chamada recebida o registrador:
 *   1. confere o REMETENTE: o frame principal da página do app (file:// renderer/index.html). Webviews
 *      (YouTube Studio), sub-frames, páginas externas e janelas sem a página do app são recusados;
 *   2. valida os argumentos contra o esquema do canal (schema.js), recusando argumentos extras;
 *   3. só então chama o handler. Falhas de 1 e 2 seguem a ESTRATÉGIA DE ERRO do domínio ('throw', 'wrap',
 *      'success', 'null', 'empty'), para o renderer continuar vendo o formato que já espera.
 *
 * Um canal sem entrada na tabela (e sem esquema) não registra: o app falha ao iniciar, em vez de expor
 * um canal sem validação. A tabela completa é exportada em `CHANNELS` / `listChannels()`.
 */

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { CHANNELS, EVENTS } = require('./channels');
const { validateArgs, SchemaError, describeSpec } = require('./schema');

const MSG_ORIGIN = 'Origem da chamada não autorizada.';
const MSG_ARGS_FALLBACK = 'Dados da requisição inválidos.';

const IS_WIN = process.platform === 'win32';
const samePath = (a, b) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Página do app: <raiz>/renderer/index.html (em desenvolvimento e empacotado, dentro do .asar). */
const APP_PAGE = path.join(__dirname, '..', '..', 'renderer', 'index.html');

/** true se `url` (string) é a página do app (consulta e âncora são ignoradas). */
function isAppPageUrl(url, appPage = APP_PAGE) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return false;
  let file;
  try { file = fileURLToPath(url); } catch (_) { return false; }
  return samePath(path.resolve(file), path.resolve(appPage));
}

/**
 * Devolve null se o remetente é confiável, ou o motivo da recusa (apenas para o log; nunca vai ao renderer).
 * Confiável = frame principal da página do app, em um WebContents que não é <webview>.
 */
function senderProblem(event, appPage = APP_PAGE) {
  const frame = event && event.senderFrame;
  const sender = event && event.sender;
  if (!frame || !sender) return 'sem frame/remetente';
  if (frame.parent != null) return 'não é o frame principal';
  let type = 'window';
  try { if (typeof sender.getType === 'function') type = sender.getType(); } catch (_) { /* usa 'window' */ }
  if (type === 'webview') return 'remetente é um webview';
  if (!isAppPageUrl(frame.url, appPage)) return 'URL do frame não é a página do app';
  try {
    if (typeof sender.getURL === 'function' && !isAppPageUrl(sender.getURL(), appPage)) return 'URL do WebContents não é a página do app';
  } catch (_) { return 'URL do WebContents indisponível'; }
  return null;
}

/** Resposta de uma recusa (remetente/argumentos) no padrão do domínio. */
function guardFailure(strategy, message, code) {
  switch (strategy) {
    case 'wrap': return { ok: false, error: message, code };
    case 'success': return { success: false, error: message };
    case 'null': return null;
    case 'empty': return [];
    default: throw Object.assign(new Error(message), { code });
  }
}

let cachedLogger;
function defaultLogger() {
  if (cachedLogger === undefined) {
    try { cachedLogger = require('../services/logService'); } catch (_) { cachedLogger = null; }
  }
  return cachedLogger;
}

const STRATEGIES = new Set(['throw', 'wrap', 'success', 'null', 'empty']);

/**
 * Cria um registrador. Em produção use o `handle` exportado; os parâmetros existem para teste.
 * @param {{ ipcMain?: object, table?: object, logger?: object, appPage?: string }} [opts]
 */
function createRegistry({ ipcMain, table = CHANNELS, logger = null, appPage = APP_PAGE } = {}) {
  const registered = new Map(); // canal -> { schema, error }

  const log = () => logger || defaultLogger();
  const getIpc = () => ipcMain || require('electron').ipcMain;

  function handle(channel, a, b, c) {
    if (typeof channel !== 'string' || !channel) throw new Error('handle: canal inválido.');
    const meta = table[channel];
    if (!meta) throw new Error(`Canal IPC sem entrada na tabela (src/ipc/channels.js): ${channel}`);
    let schema; let fn; let options;
    if (typeof a === 'function') { schema = meta.args; fn = a; options = b || {}; } else { schema = a; fn = b; options = c || {}; }
    if (!Array.isArray(schema)) throw new Error(`Canal ${channel}: esquema de argumentos ausente.`);
    if (typeof fn !== 'function') throw new Error(`Canal ${channel}: handler ausente.`);
    const error = options.error || meta.error || 'throw';
    if (!STRATEGIES.has(error)) throw new Error(`Canal ${channel}: estratégia de erro desconhecida (${error}).`);
    if (registered.has(channel)) throw new Error(`Canal IPC registrado duas vezes: ${channel}`);
    registered.set(channel, { schema, error });

    getIpc().handle(channel, async (event, ...args) => {
      const why = senderProblem(event, appPage);
      if (why) {
        try { const l = log(); l && l.warn && l.warn('IPC:remetente_recusado', { channel, motivo: why, url: String(event && event.senderFrame && event.senderFrame.url).slice(0, 200) }); } catch (_) { /* log opcional */ }
        return guardFailure(error, MSG_ORIGIN, 'EFORBIDDEN');
      }
      let validated;
      try {
        validated = validateArgs(schema, args, { maxArgs: options.maxArgs });
      } catch (err) {
        try { const l = log(); l && l.warn && l.warn('IPC:argumentos_recusados', { channel, erro: err && err.message }); } catch (_) { /* log opcional */ }
        return guardFailure(error, err instanceof SchemaError ? err.message : MSG_ARGS_FALLBACK, 'EINVALID');
      }
      if (error === 'wrap') {
        try { return { ok: true, data: await fn(event, ...validated) }; } catch (err) {
          return { ok: false, error: (err && err.message) || String(err), code: (err && err.code) || null };
        }
      }
      return fn(event, ...validated);
    });
  }

  return { handle, registered: () => new Map(registered) };
}

let defaultRegistry = null;
const getDefault = () => (defaultRegistry || (defaultRegistry = createRegistry()));

/** Registra um canal no ipcMain real (ver cabeçalho). */
function handle(channel, a, b, c) { return getDefault().handle(channel, a, b, c); }

/** Linhas da tabela (canal, domínio, args, retorno, erro, api) — documentação e testes. */
function listChannels(table = CHANNELS) {
  return Object.entries(table).map(([channel, m]) => ({
    channel,
    domain: m.domain,
    args: m.args.map(describeSpec),
    returns: m.returns,
    error: m.error,
    api: m.api.map((x) => (typeof x === 'string' ? x : x.name))
  }));
}

module.exports = {
  handle,
  createRegistry,
  listChannels,
  senderProblem,
  isAppPageUrl,
  CHANNELS,
  EVENTS,
  APP_PAGE,
  MSG_ORIGIN
};
