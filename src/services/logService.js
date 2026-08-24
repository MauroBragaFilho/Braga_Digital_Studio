const path = require('node:path');
const fs = require('node:fs');
const winston = require('winston');

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
  const day = new Date().toISOString().slice(0, 10);
  return path.join(logsDir, `${day}.log`);
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
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
