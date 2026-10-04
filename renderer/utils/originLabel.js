// Rótulo de exibição da origem de uma mídia. Os valores gravados (LOCAL, DOWNLOAD, CONVERTER, BDSM...) não mudam;
// só o texto que o usuário lê. Nomes de serviços/motores internos viram termos genéricos.
import { maskEngineNames } from './engineNames.js';

const FIXED = {
  LOCAL: 'Computador',
  DOWNLOAD: 'Download',
  CONVERTER: 'Conversor',
  RECOVERY: 'Recuperação',
  MONTAGE: 'Montagem'
};

/** @param {unknown} origin valor bruto de media.origin / item.platform */
export function originLabel(origin) {
  const raw = String(origin ?? '').trim();
  if (!raw) return 'Computador';
  const key = raw.toUpperCase();
  if (FIXED[key]) return FIXED[key];
  if (key.includes('BDSM')) return 'Celular';
  if (/spot(?:ify|dl)/i.test(raw)) return 'Música';
  return String(maskEngineNames(raw));
}
