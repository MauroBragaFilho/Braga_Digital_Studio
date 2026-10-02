'use strict';

/**
 * wrap.js — Envelope de resposta padrão para handlers IPC NOVOS.
 *
 *   sucesso: { ok: true, data }
 *   falha:   { ok: false, error, code }
 *
 * Usado por aiHandlers e moduleHandlers. Os handlers legados (library:*, projects:*,
 * downloads:*...) mantêm seus formatos originais para não quebrar o renderer.
 */
const wrap = (fn) => async (_event, ...args) => {
  try {
    return { ok: true, data: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: err?.code || null };
  }
};

module.exports = { wrap };
