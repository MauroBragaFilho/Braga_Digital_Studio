'use strict';

// Orçamentos de tempo tolerantes (RK-104): testes que afirmam "terminou em menos de X ms" falham por ruído
// em runners de CI lentos/compartilhados. O limite continua existindo (pega regressão grosseira, como
// regex quadrática ou espera de timeout), mas escala com o ambiente.
//   BDS_TEST_TIME_FACTOR=<n>  força o fator; sem ele, 4x no CI (variável CI) e 1x localmente.

const FACTOR = Number(process.env.BDS_TEST_TIME_FACTOR) || (process.env.CI ? 4 : 1);

/** Limite em ms já ajustado ao ambiente. */
const budget = (ms) => ms * FACTOR;

module.exports = { budget, FACTOR };
