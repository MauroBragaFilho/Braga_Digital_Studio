'use strict';

/**
 * Erro cuja mensagem já está em português e pronta para o usuário. O que não for deste tipo (falha de disco, bug)
 * vira uma mensagem genérica na camada de IPC; o detalhe fica só no log.
 */
class LutUserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LutUserError';
    this.code = 'LUT_USER';
  }
}

/** Mensagem para mostrar: a do próprio erro se for de usuário, senão `fallback`. */
function userMessage(err, fallback) {
  return err instanceof LutUserError ? err.message : fallback;
}

module.exports = { LutUserError, userMessage };
