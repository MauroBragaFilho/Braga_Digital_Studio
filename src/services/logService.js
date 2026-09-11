const path = require('node:path');
const fs = require('node:fs');
const winston = require('winston');
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

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      // Horário de Curitiba (GMT-3), ex.: 2026-09-09T21:47:19.075-03:00
      format: () => zonedISO()
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: currentLogFile(),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 14
    }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

module.exports = logger;
