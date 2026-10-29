'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Utilidades comuns aos serviços de recuperação de mídia (vídeo, RAW e JPG).
 */

/** Logger de arquivo: grava em <logsDir>/<arquivo>. Nunca lança. */
function createRecoveryLogger(fileName, getLogsDir) {
  return function logRecovery(message, data = null) {
    try {
      const logsDir = (typeof getLogsDir === 'function' && getLogsDir()) || process.env.BMD_LOGS_DIR || path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
      fs.appendFileSync(path.join(logsDir, fileName), `[${new Date().toISOString()}] ${message}${dataStr}\n`, 'utf8');
    } catch (_) { /* log nunca derruba a recuperação */ }
  };
}

/** Pasta de logs do serviço: a do app quando houver; senão a variável de ambiente. */
function logsDirOf(paths) {
  try { return paths && paths.logsDir; } catch (_) { return null; }
}

/**
 * Trava global: só uma recuperação por vez entre vídeo, RAW e JPG (cada serviço guarda um único
 * processo filho e uma única flag de cancelamento; duas ao mesmo tempo se atrapalhariam).
 */
const recoveryLock = {
  owner: null,
  acquire(kind) {
    if (this.owner) {
      throw new Error('Já existe uma recuperação em andamento. Aguarde terminar ou cancele a atual antes de iniciar outra.');
    }
    this.owner = kind;
    return () => { if (this.owner === kind) this.owner = null; };
  },
};

/** Emite 'error' sem derrubar o processo quando ninguém escuta (EventEmitter lança nesse caso). */
function emitError(emitter, err) {
  if (emitter.listenerCount('error') > 0) emitter.emit('error', { message: err && err.message ? err.message : String(err) });
}

function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* melhor esforço */ }
}

function safeRmDir(p) {
  try { if (p) fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* melhor esforço */ }
}

/** Move um arquivo; entre discos diferentes (EXDEV) copia e remove a origem. */
function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err && (err.code === 'EXDEV' || err.code === 'EPERM' || err.code === 'EACCES')) {
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
      safeUnlink(src);
    } else {
      throw err;
    }
  }
}

/** A pasta aceita novos arquivos? */
function isWritableDir(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch (_) { return false; }
}

/**
 * Avalia a saída de uma recuperação de vídeo contra o original.
 * @param {{durationSec: number|null, sizeBytes: number}} input   dados do arquivo corrompido (duração só se legível)
 * @param {{durationSec: number|null, sizeBytes: number}} output
 * @returns {{complete: boolean, warnings: string[]}}
 */
function assessVideoOutput(input, output) {
  const warnings = [];
  if (input.durationSec > 0 && output.durationSec > 0) {
    const ratio = output.durationSec / input.durationSec;
    if (ratio < 0.9) warnings.push(`O vídeo recuperado tem ${Math.round(ratio * 100)}% da duração original (${Math.round(output.durationSec)}s de ${Math.round(input.durationSec)}s).`);
  } else if (input.sizeBytes > 0 && output.sizeBytes / input.sizeBytes < 0.5) {
    warnings.push(`O arquivo recuperado tem só ${Math.round((output.sizeBytes / input.sizeBytes) * 100)}% do tamanho do original; parte do conteúdo pode ter ficado de fora.`);
  }
  return { complete: warnings.length === 0, warnings };
}

/** Lê "out_time_us=123" / "out_time_ms=123" do `-progress` do FFmpeg e devolve segundos (ou null). */
function parseFfmpegProgressSeconds(line) {
  const m = /^out_time_(?:us|ms)=(\d+)/.exec(String(line).trim());
  if (!m) return null;
  return Number(m[1]) / 1e6; // out_time_ms do FFmpeg também é em microssegundos
}

module.exports = {
  createRecoveryLogger,
  logsDirOf,
  recoveryLock,
  emitError,
  safeUnlink,
  safeRmDir,
  moveFile,
  isWritableDir,
  assessVideoOutput,
  parseFfmpegProgressSeconds,
};
