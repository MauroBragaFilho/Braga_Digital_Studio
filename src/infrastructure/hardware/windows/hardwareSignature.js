'use strict';

const crypto = require('node:crypto');
const { execOffThread } = require('../offThreadExec'); // criação do processo fora do processo principal
const { systemExe } = require('../systemExe');

/**
 * Assinatura barata do que está conectado: muda quando um pen drive, cartão, câmera ou celular entra ou sai.
 * Serve para saber QUANDO vale a pena refazer a enumeração de dispositivos (que custa um PowerShell, ~1 s) em vez de
 * refazê-la às cegas a cada poucos segundos.
 *
 * Duas fontes nativas do Windows, juntas (~100 ms no total):
 *   - `pnputil /enum-devices /connected /class <classe>` nas classes que mudam quando algo é plugado: USB (aparelho novo ou
 *     trocando de modo: um celular em "só carregar" vira "transferência de arquivos") e WPD (câmeras e celulares). Sem `/class`
 *     o pnputil leva mais de 10 s: nunca chame sem a classe.
 *   - `mountvol` (sem argumentos): volumes e letras montados. É ele que percebe um cartão inserido num leitor que já estava
 *     ligado (o leitor continua o mesmo; muda o volume montado na letra dele) e uma unidade virtual montada ou desmontada.
 */

const CLASSES = ['USB', 'WPD'];
const COMMAND_TIMEOUT_MS = 8000;

/**
 * Hash das linhas relevantes (as que têm "\": IDs de instância do pnputil, volumes e letras do mountvol), ordenadas.
 * @param {string} text saídas concatenadas
 * @returns {string|null} null se não há nenhuma linha reconhecível (comandos indisponíveis ou formato diferente)
 */
function signatureFromOutputs(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes('\\'));
  if (!lines.length) return null;
  lines.sort();
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
}

function run(command) {
  return new Promise((resolve) => {
    execOffThread(
      command,
      { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : String(stdout || ''))
    );
  });
}

/** Lê a assinatura agora. Devolve null se não for possível (o chamador cai no cache por tempo). */
async function readSignature() {
  const pnputil = systemExe('pnputil');
  const parts = await Promise.all([
    ...CLASSES.map((cls) => run(`"${pnputil}" /enum-devices /connected /class ${cls}`)),
    run(`"${systemExe('mountvol')}"`)
  ]);
  if (parts.every((p) => p === null)) return null; // nenhuma das fontes respondeu
  return signatureFromOutputs(parts.map((p) => p || '').join('\n'));
}

module.exports = { readSignature, signatureFromOutputs, CLASSES };
