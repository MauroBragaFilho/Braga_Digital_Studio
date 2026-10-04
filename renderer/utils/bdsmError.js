/**
 * Erros do celular (BDS Mobile). O processo principal lança "BDSM:<CÓDIGO>:<mensagem em português>" (o Electron só
 * transporta a mensagem, o `code` se perde). Aqui o código é separado do texto para a tela decidir o que fazer
 * (ex.: PAIRING_REQUIRED abre o diálogo de pareamento) e mostrar uma mensagem específica, nunca um texto genérico.
 */
import { friendlyError } from './friendlyError.js';

const TAGGED = /BDSM:([A-Z_]+):\s*([\s\S]*)$/;

/** @returns {{ code: string|null, message: string }} */
export function bdsmErrorInfo(err, fallback = 'Algo deu errado ao falar com o celular. Tente de novo.') {
  const raw = typeof err === 'string' ? err : (err && (err.message || err.error)) || '';
  const m = TAGGED.exec(String(raw));
  if (m) return { code: m[1], message: m[2].trim() || fallback };
  return { code: null, message: friendlyError(err, fallback) };
}

/** Mensagem do estado final de um pareamento (eventos 'bdsm:pairing' com state DENIED/EXPIRED/ERROR). */
export function pairingStateMessage(state, message) {
  if (state === 'DENIED') return 'O pareamento foi recusado no celular.';
  if (state === 'EXPIRED') return 'O tempo para aprovar no celular acabou.';
  return message || 'Não foi possível parear com o celular. Tente de novo.';
}
