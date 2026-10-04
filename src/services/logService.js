const path = require('node:path');
const fs = require('node:fs');
const { localDateKey, zonedISO } = require('./timeUtils');

function resolveLogsDir() {
  if (process.env.BMD_LOGS_DIR) {
    return process.env.BMD_LOGS_DIR;
  }
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'logs');
    }
  } catch (_) {}

  // Fallback para desenvolvimento fora de app.asar
  if (!__dirname.includes('app.asar')) {
    return path.join(__dirname, '..', 'logs');
  }
  const os = require('node:os');
  return path.join(os.homedir(), '.braga-digital-studio', 'logs');
}

function isPackagedApp() {
  try {
    const { app } = require('electron');
    return !!(app && app.isPackaged);
  } catch (_) {
    return false;
  }
}

const logsDir = resolveLogsDir();
try {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
} catch (_) {}

const LOG_RETENTION_DAYS = 14;

/**
 * Remove arquivos de log (*.log, *.log1 ...) com mais de `days` dias em `dir`.
 * Assíncrono e tolerante a falhas; devolve quantos arquivos apagou.
 */
async function pruneOldLogs(dir = logsDir, days = LOG_RETENTION_DAYS, now = Date.now()) {
  let removed = 0;
  try {
    const limit = now - days * 24 * 60 * 60 * 1000;
    const names = await fs.promises.readdir(dir);
    for (const name of names) {
      if (!/\.log\d*$/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = await fs.promises.stat(full);
        if (st.isFile() && st.mtimeMs < limit) {
          await fs.promises.unlink(full);
          removed++;
        }
      } catch (_) { /* arquivo em uso ou já removido */ }
    }
  } catch (_) { /* pasta inexistente */ }
  return removed;
}

// Poda na inicialização, fora do caminho crítico (não segura o carregamento do módulo).
{
  const t = setTimeout(() => { pruneOldLogs().catch(() => {}); }, 5000);
  if (t.unref) t.unref();
}

// [PERF] A chave do dia só é recalculada quando o minuto muda (Intl.DateTimeFormat é caro
// para ser chamado a cada linha de log; virar o dia só é detectado com até 1 min de atraso).
let _dayKeyMinute = -1;
let _dayKeyValue = '';
function cachedDateKey() {
  const minute = Math.floor(Date.now() / 60000);
  if (minute !== _dayKeyMinute) {
    _dayKeyMinute = minute;
    _dayKeyValue = localDateKey();
  }
  return _dayKeyValue;
}

function currentLogFile() {
  const day = cachedDateKey();
  return path.join(logsDir, `${day}.log`);
}

// ---------------------------------------------------------------------------------------------
// [PERF] Carga preguiçosa do winston (~150 ms de require, o maior custo isolado da abertura).
//
// As linhas de log emitidas ANTES de o winston existir (error/warn/info) entram numa fila, com o horário
// em que foram emitidas, e são gravadas quando o winston carrega: em até 250 ms para warn/error, em até 3 s
// para info, ou assim que algo pedir (flushSoon, qualquer outro método do logger, ou a fila encher).
// Se o processo sair antes disso, a fila é gravada de forma síncrona no arquivo do dia ('exit').
// ---------------------------------------------------------------------------------------------

const QUEUE_MAX = 400;
const FLUSH_ERROR_MS = 250;
const FLUSH_INFO_MS = 3000;

let real = null;          // logger do winston (depois de carregado)
let queue = [];           // { method, args, ts }
let flushTimer = null;
let flushAt = Infinity;
let replayTs = null;

/** Carrega o winston (uma vez) e grava a fila. */
function loadReal() {
  if (real) return real;
  const { createWinstonLogger } = require('./logWinston');
  real = createWinstonLogger({
    cachedDateKey,
    currentLogFile,
    isPackaged: isPackagedApp(),
    timestampOverride: () => replayTs
  });
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; flushAt = Infinity; }
  const pending = queue;
  queue = [];
  for (const e of pending) replay(e);
  return real;
}

function isPlainMeta(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Error) && Object.getPrototypeOf(v) === Object.prototype;
}

/** Reenvia uma entrada enfileirada ao winston mantendo o horário original. */
function replay(e) {
  try {
    const [first, second] = e.args;
    if (e.args.length === 1 && typeof first === 'string') {
      real.log({ level: e.method, message: first, __bdsTs: e.ts });
    } else if (e.args.length === 2 && typeof first === 'string' && isPlainMeta(second)) {
      real.log({ ...second, level: e.method, message: first, __bdsTs: e.ts });
    } else {
      // Formas menos comuns (Error, vários argumentos): o winston trata; o horário vai pela variável.
      replayTs = e.ts;
      try { real[e.method](...e.args); } finally { replayTs = null; }
    }
  } catch (_) { /* nunca derruba o app por falha de log */ }
}

function scheduleFlush(ms) {
  if (real) return;
  const at = Date.now() + ms;
  if (flushTimer && at >= flushAt) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushAt = at;
  flushTimer = setTimeout(() => { flushTimer = null; flushAt = Infinity; loadReal(); }, ms);
  if (flushTimer.unref) flushTimer.unref();
}

function enqueue(method, args) {
  if (queue.length >= QUEUE_MAX) { loadReal(); real[method](...args); return; }
  queue.push({ method, args, ts: zonedISO() });
  scheduleFlush(method === 'info' ? FLUSH_INFO_MS : FLUSH_ERROR_MS);
}

function levelMethod(method) {
  const queued = method === 'error' || method === 'warn' || method === 'info';
  return (...args) => {
    if (real) return real[method](...args);
    // Abaixo de 'info' o winston descartaria a linha de qualquer forma.
    if (queued) enqueue(method, args);
    return undefined;
  };
}

/** Saída do processo com fila pendente: grava de forma síncrona (sem winston) no arquivo do dia. */
function writeQueueSync() {
  if (real || queue.length === 0) return;
  try {
    const { redactDeep } = require('./redact');
    const lines = queue.splice(0).map((e) => {
      const [first, second] = e.args;
      const entry = { level: e.method, message: typeof first === 'string' ? first : (first && first.message) || String(first) };
      if (isPlainMeta(second)) Object.assign(entry, second);
      else if (first instanceof Error) entry.stack = first.stack;
      entry.timestamp = e.ts;
      const safe = redactDeep(entry);
      try { return JSON.stringify(safe); } catch (_) { return JSON.stringify({ level: e.method, message: String(entry.message), timestamp: e.ts }); }
    });
    fs.appendFileSync(currentLogFile(), lines.join('\n') + '\n');
  } catch (_) { /* melhor esforço */ }
}
process.on('exit', writeQueueSync);

const facade = {
  error: levelMethod('error'),
  warn: levelMethod('warn'),
  info: levelMethod('info'),
  http: levelMethod('http'),
  verbose: levelMethod('verbose'),
  debug: levelMethod('debug'),
  silly: levelMethod('silly'),
  /** Pede a gravação da fila em breve (ex.: logo depois de a Home aparecer). */
  flushSoon(ms = 0) { scheduleFlush(Math.max(0, ms)); },
  /** Carrega o winston agora e grava a fila. */
  flushNow() { loadReal(); },
  isLoaded() { return !!real; },
  getCurrentLogFile: currentLogFile,
  logsDir,
  pruneOldLogs
};

// Qualquer outra propriedade do logger do winston (log, add, on, transports, level...) carrega o winston.
const logger = new Proxy(facade, {
  get(target, prop) {
    if (prop in target) return target[prop];
    const r = loadReal();
    const v = r[prop];
    return typeof v === 'function' ? v.bind(r) : v;
  },
  has(target, prop) {
    return prop in target || prop in loadReal();
  },
  set(target, prop, value) {
    if (prop in target) { target[prop] = value; return true; }
    loadReal()[prop] = value;
    return true;
  }
});

module.exports = logger;
