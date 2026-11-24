'use strict';

/**
 * Ordem dos motores de transcrição (Configurações → Inteligência Artificial → Provedores → Áudio).
 *   transcriptionOrder     todos os motores, na ordem escolhida pelo usuário
 *   transcriptionFallback  só os ligados (os que entram no modo Automático e no "se o escolhido falhar")
 * SEGURANÇA: sem nenhum motor ligado, o modo Automático usa só este computador: o áudio nunca sai do computador
 * sem o usuário ter ligado um serviço de nuvem.
 */

const { PROVIDER_IDS } = require('./CloudConfig');

const ENGINE_IDS = Object.freeze(['local', ...PROVIDER_IDS]);

/** Lista só com ids conhecidos, sem repetir, na ordem recebida. */
function sanitizeEngines(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((id) => ENGINE_IDS.includes(id)))];
}

/** A ordem escolhida, completada com os motores que faltarem (no fim, na ordem padrão). */
function completeOrder(list) {
  const chosen = sanitizeEngines(list);
  return [...chosen, ...ENGINE_IDS.filter((id) => !chosen.includes(id))];
}

/** Motores ligados, na ordem escolhida (pode ser vazia). */
function enabledInOrder(settings) {
  const s = settings || {};
  const on = sanitizeEngines(s.transcriptionFallback);
  return completeOrder(s.transcriptionOrder).filter((id) => on.includes(id));
}

/** Motores do modo Automático, na ordem de tentativa. Nunca devolve lista vazia. */
function autoEngines(settings) {
  const list = enabledInOrder(settings);
  return list.length ? list : ['local'];
}

module.exports = { ENGINE_IDS, sanitizeEngines, completeOrder, enabledInOrder, autoEngines };
