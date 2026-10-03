'use strict';

/**
 * Cache negativo simples: depois de uma falha, `shouldSkip()` devolve true durante `cooldownMs`,
 * evitando repetir uma operação cara que acabou de falhar (ex.: consulta WMI que estoura o timeout).
 */
class FailureCooldown {
  /** @param {number} cooldownMs duração do silêncio após uma falha */
  constructor(cooldownMs) {
    this.cooldownMs = cooldownMs;
    this._failedAt = null;
  }

  /** Registra uma falha agora (ou no instante `now`, para testes). */
  markFailure(now = Date.now()) {
    this._failedAt = now;
  }

  /** true se houve falha há menos de `cooldownMs`. */
  shouldSkip(now = Date.now()) {
    return this._failedAt !== null && (now - this._failedAt) < this.cooldownMs;
  }

  /** Esquece a falha (ex.: a operação voltou a funcionar). */
  reset() {
    this._failedAt = null;
  }
}

module.exports = FailureCooldown;
