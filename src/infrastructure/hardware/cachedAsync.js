'use strict';

/**
 * Envolve uma função assíncrona com cache de curta duração e deduplicação de chamadas
 * concorrentes (várias chamadas simultâneas compartilham a mesma promise em andamento).
 * Rejeições NÃO são guardadas em cache.
 *
 * @param {() => Promise<any>} fn função cara (ex.: enumerar dispositivos via PowerShell)
 * @param {number|(() => number)} ttlMs validade do resultado em ms (ou função que a devolve: vale a do momento da leitura)
 * @param {() => number} [now] relógio injetável (testes)
 * @returns {{ get: (opts?: {force?: boolean}) => Promise<any>, invalidate: () => void }}
 */
function cachedAsync(fn, ttlMs, now = Date.now) {
  let value;
  let hasValue = false;
  let at = 0;
  let inflight = null;
  let generation = 0; // invalidate() durante uma chamada em voo descarta o resultado dela

  function get({ force = false } = {}) {
    if (!force && hasValue && (now() - at) < (typeof ttlMs === 'function' ? ttlMs() : ttlMs)) return Promise.resolve(value);
    if (inflight && !force) return inflight;

    const myGen = ++generation;
    const p = Promise.resolve()
      .then(fn)
      .then((result) => {
        if (myGen === generation) {
          value = result;
          hasValue = true;
          at = now();
        }
        return result;
      })
      .finally(() => {
        if (inflight === p) inflight = null;
      });
    inflight = p;
    return p;
  }

  function invalidate() {
    hasValue = false;
    generation++;
    inflight = null;
  }

  /** Último resultado guardado, mesmo vencido (undefined se não há ou se foi invalidado). Serve de reserva quando a nova consulta falha. */
  function peek() {
    return hasValue ? value : undefined;
  }

  return { get, invalidate, peek };
}

module.exports = { cachedAsync };
