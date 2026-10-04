'use strict';

/**
 * Logger de arquivo propriamente dito (winston). Carregado SOB DEMANDA por ./logService.js: o winston custa
 * ~150 ms de require() e não precisa estar pronto antes da primeira janela. Não importe este módulo direto;
 * use `require('./logService')`.
 */

const winston = require('winston');
const { zonedISO } = require('./timeUtils');
const { redactDeep } = require('./redact');

/**
 * @param {Object} deps
 * @param {() => string} deps.cachedDateKey  chave do dia (AAAA-MM-DD), com cache por minuto
 * @param {() => string} deps.currentLogFile caminho do arquivo do dia
 * @param {boolean} deps.isPackaged          empacotado = sem Console
 * @param {() => (string|null)} deps.timestampOverride  instante original de uma entrada enfileirada (ou null)
 */
function createWinstonLogger({ cachedDateKey, currentLogFile, isPackaged, timestampOverride }) {
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
        const day = cachedDateKey();
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
      // Horário de Curitiba (GMT-3), ex.: 2026-09-09T21:47:19.075-03:00.
      // Entradas que esperaram na fila (logService) mantêm o horário em que foram emitidas.
      winston.format((info) => {
        info.timestamp = info.__bdsTs || timestampOverride() || zonedISO();
        delete info.__bdsTs;
        return info;
      })(),
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
      })
    ]
  });

  // Console só em desenvolvimento: empacotado não há terminal e o transporte só gasta CPU.
  if (!isPackaged) {
    logger.add(new winston.transports.Console({ format: winston.format.simple() }));
  }
  return logger;
}

module.exports = { createWinstonLogger };
