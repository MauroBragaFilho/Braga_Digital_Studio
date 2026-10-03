'use strict';

/** Degraus padrão do backoff do 'adb devices': 30 s, 60 s e 5 min (depois mantém 5 min). */
const ADB_BACKOFF_STEPS_MS = [30000, 60000, 300000];

/**
 * Atraso até a próxima tentativa depois de `failures` falhas consecutivas (>= 1).
 * Com 0 falhas não há espera.
 * @param {number} failures
 * @param {number[]} [steps]
 * @returns {number} ms
 */
function backoffDelay(failures, steps = ADB_BACKOFF_STEPS_MS) {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  return steps[Math.min(failures, steps.length) - 1];
}

/**
 * Compara dois registros de dispositivo ignorando campos voláteis (last_seen).
 * Usado para emitir 'device_updated' somente quando algo realmente mudou.
 */
function deviceChanged(prev, next, ignoreKeys = ['last_seen']) {
  if (!prev) return true;
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    if (ignoreKeys.includes(k)) continue;
    if (prev[k] !== next[k]) return true;
  }
  return false;
}

module.exports = { ADB_BACKOFF_STEPS_MS, backoffDelay, deviceChanged };
