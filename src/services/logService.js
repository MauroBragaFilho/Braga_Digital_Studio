const path = require('node:path');
const fs = require('node:fs');
const winston = require('winston');
const { localDateKey, zonedISO } = require('./timeUtils');
const { redactDeep } = require('./redact');

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

const logsDir = resolveLogsDir();
try {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
} catch (_) {}

function currentLogFile() {
  const day = localDateKey();
  return path.join(logsDir, `${day}.log`);
}

/**
 * Transport de arquivo com rotação diária: o nome do arquivo é recalculado a cada escrita
 * (um processo que passa da meia-noite passa a gravar em <novo dia>.log). Por baixo usa o
 * winston.transports.File (que continua aplicando maxsize/maxFiles); ao virar o dia o
 * transport do dia anterior é fechado e outro é criado.
 */
class DailyFileTransport extends winston.Transport {
  constructor(opts = {}) {
    super(opts);
    this._fileOptions = opts.fileOptions || {};
    this._day = null;
    this._inner = null;
  }

  log(info, callback) {
    try {
      const day = localDateKey();
      if (day !== this._day || !this._inner) {
        const previous = this._inner;
        this._day = day;
        this._inner = new winston.transports.File({
          ...this._fileOptions,
          filename: currentLogFile()
        });
        if (previous && typeof previous.close === 'function') {
          try { previous.close(); } catch (_) { /* arquivo do dia anterior já fechado */ }
        }
      }
      this._inner.log(info, callback);
    } catch (err) {
      // Nunca derruba o app por falha de log
      if (typeof callback === 'function') callback();
    }
    this.emit('logged', info);
  }

  close() {
    if (this._inner && typeof this._inner.close === 'function') {
      try { this._inner.close(); } catch (_) { /* noop */ }
    }
  }
}

/**
 * Remove dados pessoais de cada entrada de log: diretório do usuário, query strings de URLs,
 * tokens, cookies e e-mails (ver ./redact.js). Aplica-se à mensagem, ao stack e a todo o metadata.
 */
const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (key === 'level') continue;
    info[key] = redactDeep(info[key]);
  }
  return info;
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      // Horário de Curitiba (GMT-3), ex.: 2026-09-09T21:47:19.075-03:00
      format: () => zonedISO()
    }),
    winston.format.errors({ stack: true }),
    redactFormat(),
    winston.format.json()
  ),
  transports: [
    new DailyFileTransport({
      fileOptions: {
        maxsize: 5 * 1024 * 1024,
        maxFiles: 14
      }
    }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Para quem precisa ler o log atual (ex.: ErrorReporter): o nome muda a cada dia.
logger.getCurrentLogFile = currentLogFile;
logger.logsDir = logsDir;

module.exports = logger;
