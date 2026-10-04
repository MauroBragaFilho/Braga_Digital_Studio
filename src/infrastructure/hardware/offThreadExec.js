'use strict';

/**
 * offThreadExec — igual a child_process.exec(command, options, callback), mas a criação do processo
 * acontece em uma worker thread.
 *
 * Por quê: no Windows, child_process.exec cria o processo de forma SÍNCRONA no processo principal.
 * Com antivírus/AMSI examinando o powershell.exe (principalmente a partir de um executável recém-
 * empacotado), essa chamada chegou a bloquear o processo principal por vários segundos, e com ele todo
 * IPC, a janela sem moldura e a abertura da Home. Na worker thread o bloqueio, se existir, não atrapalha
 * o app.
 *
 * Mesma assinatura de callback: (error, stdout, stderr). Se a worker não puder ser criada, usa exec direto.
 */

const { Worker } = require('node:worker_threads');
const { exec } = require('node:child_process');

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { exec } = require('node:child_process');
parentPort.on('message', ({ id, command, options }) => {
  try {
    exec(command, options, (error, stdout, stderr) => {
      parentPort.postMessage({
        id,
        error: error ? { message: error.message, code: error.code, killed: Boolean(error.killed), signal: error.signal || null } : null,
        stdout,
        stderr
      });
    });
  } catch (err) {
    parentPort.postMessage({ id, error: { message: err.message, code: err.code }, stdout: '', stderr: '' });
  }
});
`;

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> callback

function failAll(message) {
  for (const [id, cb] of pending) {
    pending.delete(id);
    cb(Object.assign(new Error(message), { code: 'WORKER_FAILED' }), '', '');
  }
}

function getWorker() {
  if (worker) return worker;
  const w = new Worker(WORKER_SOURCE, { eval: true });
  w.on('message', ({ id, error, stdout, stderr }) => {
    const cb = pending.get(id);
    if (!cb) return;
    pending.delete(id);
    if (pending.size === 0) w.unref(); // ociosa: não segura o encerramento do processo
    let err = null;
    if (error) {
      err = Object.assign(new Error(error.message), { code: error.code, killed: error.killed, signal: error.signal });
    }
    cb(err, stdout, stderr);
  });
  w.on('error', (e) => { if (worker === w) worker = null; failAll(e && e.message ? e.message : 'worker error'); });
  w.on('exit', () => { if (worker === w) worker = null; failAll('worker exited'); });
  w.unref(); // depois dos listeners: adicionar 'message' faz a porta voltar a ser referenciada
  worker = w;
  return w;
}

/**
 * @param {string} command
 * @param {object} options  mesmas opções do exec (precisam ser clonáveis: encoding, timeout, env, windowsHide...)
 * @param {(error: Error|null, stdout: string, stderr: string) => void} callback
 */
function execOffThread(command, options, callback) {
  let w;
  try {
    w = getWorker();
  } catch (_) {
    return exec(command, options, callback); // sem worker: comportamento anterior
  }
  const id = nextId++;
  pending.set(id, callback);
  w.ref(); // enquanto houver chamada em andamento, o processo espera a resposta
  try {
    w.postMessage({ id, command, options });
  } catch (err) {
    pending.delete(id);
    return exec(command, options, callback);
  }
  return undefined;
}

module.exports = { execOffThread };
