'use strict';

/**
 * Funções puras para decidir quais efeitos colaterais um settings:save precisa disparar.
 * Chaves de interface (sidebarCollapsed, theme, windowBounds...) só gravam o JSON.
 */

// Chaves que definem as pastas das bibliotecas monitoradas (ver Bootstrap._syncLibraries).
const LIBRARY_FOLDER_KEYS = ['obsFolder', 'shadowplayFolder', 'deviceFolder'];
// Chaves que alteram a escolha de encoder/GPU (invalidam o cache de detecção).
const HARDWARE_KEYS = ['useHardwareAcceleration', 'preferredGpuVendor'];

function _same(a, b) {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
  }
  return false;
}

/** Retorna true se alguma das chaves informadas mudou de valor entre `prev` e `next`. */
function anyKeyChanged(prev, next, keys) {
  const p = prev || {};
  const n = next || {};
  return keys.some((k) => !_same(p[k], n[k]));
}

// Chaves que afetam os lembretes de prazo (reavaliados imediatamente ao salvar).
const NOTIFICATION_KEY_PATTERN = /^(notify|deadline|telegram|notificationsEnabled)/;

/** true se alguma chave de notificação/prazo/Telegram mudou. */
function notificationSettingsChanged(prev, next) {
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  return anyKeyChanged(prev, next, [...keys].filter((k) => NOTIFICATION_KEY_PATTERN.test(k)));
}

const updateServerChanged = (prev, next) => anyKeyChanged(prev, next, ['updateServerUrl']);
const libraryFoldersChanged = (prev, next) => anyKeyChanged(prev, next, LIBRARY_FOLDER_KEYS);
const hardwareSettingsChanged = (prev, next) => anyKeyChanged(prev, next, HARDWARE_KEYS);

module.exports = {
  LIBRARY_FOLDER_KEYS,
  HARDWARE_KEYS,
  anyKeyChanged,
  libraryFoldersChanged,
  hardwareSettingsChanged,
  notificationSettingsChanged,
  updateServerChanged
};
