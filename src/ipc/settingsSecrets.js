'use strict';

/**
 * settingsSecrets.js — Mascara segredos das configurações antes de enviá-los ao renderer.
 *
 * O renderer nunca recebe segredos em texto puro (chaves em SECRET_KEYS; hoje nenhuma): recebe "••••" + últimos 4
 * caracteres. Ao salvar, se o campo voltar ainda mascarado (usuário não alterou), o valor
 * real guardado no main é preservado; se vier vazio, o segredo é apagado; se vier um valor
 * novo, ele substitui o antigo.
 */

const SECRET_KEYS = [];
const MASK = '••••'; // ••••

function isMasked(value) {
  return typeof value === 'string' && value.startsWith(MASK);
}

function maskSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (isMasked(value)) return value;
  return value.length > 8 ? MASK + value.slice(-4) : MASK;
}

/** Cópia das configurações com os segredos mascarados (para enviar ao renderer). */
function maskSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const out = { ...settings };
  for (const key of SECRET_KEYS) {
    if (key in out) out[key] = maskSecret(out[key]);
  }
  return out;
}

/** Substitui valores ainda mascarados vindos do renderer pelos valores reais guardados. */
function restoreMaskedSecrets(incoming, current) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  const out = { ...incoming };
  for (const key of SECRET_KEYS) {
    if (isMasked(out[key])) out[key] = current && typeof current[key] === 'string' ? current[key] : '';
  }
  return out;
}

module.exports = { SECRET_KEYS, MASK, isMasked, maskSecret, maskSettings, restoreMaskedSecrets };
