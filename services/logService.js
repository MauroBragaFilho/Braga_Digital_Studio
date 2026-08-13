const path = require('node:path');
const fs = require('node:fs');
const winston = require('winston');

const logsDir = process.env.BMD_LOGS_DIR || path.join(__dirname, '..', 'logs');
fs.mkdirSync(logsDir, { recursive: true });

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
