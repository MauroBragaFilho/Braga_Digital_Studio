'use strict';

const { spawn } = require('node:child_process');
const { systemExe } = require('../hardware/systemExe');

/**
 * ProcessRunner — Abstração de baixo nível para execução e cancelamento
 * de processos do sistema operacional.
 *
 * Encapsula o comportamento específico de plataforma para cancelamento:
 *  - Windows: taskkill /PID <pid> /T /F
 *  - Linux/macOS: processo lançado em grupo próprio (detached); kill(-pid, SIGTERM) com SIGKILL após 3s
 *
 * Regra do roadmap (seção 9):
 *   Nenhum serviço deve chamar taskkill diretamente.
 *   Todo cancelamento passa por ProcessRunner.cancel().
 */
class ProcessRunner {
  /**
   * Lança um processo filho.
   *
   * @param {string} executable - Caminho completo para o executável
   * @param {string[]} args - Argumentos
   * @param {object} [options] - Opções de child_process.spawn
   * @returns {import('child_process').ChildProcess}
   */
  spawn(executable, args, options = {}) {
    const defaults = { windowsHide: true };
    // POSIX: o filho vira líder de um novo grupo de processos (detached) para que o cancelamento
    // alcance também os netos (kill(-pid)). No Windows o taskkill /T já cobre a árvore.
    if (process.platform !== 'win32' && options.detached === undefined) defaults.detached = true;
    const child = spawn(executable, args, { ...defaults, ...options });
    if (process.platform !== 'win32' && child && ({ ...defaults, ...options }).detached) child.bdsProcessGroup = true;
    return child;
  }

  /**
   * Cancela um processo (e sua árvore de filhos) de forma multiplataforma.
   *
   * Devolve uma Promise que resolve quando o processo realmente terminou ('exit'/'close'),
   * ou quando o PID não existe mais. Nunca rejeita. Quando recebe só o PID não há como
   * observar o término: resolve ao final do taskkill/kill.
   *
   * Windows: taskkill /PID <pid> /T /F; se falhar (código != 0, exceto 128 = processo
   * já inexistente), registra e cai para child.kill().
   * Linux/macOS: SIGTERM e SIGKILL após 3s.
   *
   * @param {import('child_process').ChildProcess|number} childOrPid
   * @param {{ waitMs?: number }} [opts] waitMs: espera máxima pelo término (padrão 8000)
   * @returns {Promise<void>}
   */
  cancel(childOrPid, opts = {}) {
    if (!childOrPid) return Promise.resolve();
    const waitMs = opts.waitMs || 8000;

    let pid = null;
    let child = null;
    if (typeof childOrPid === 'number') {
      pid = childOrPid;
    } else if (typeof childOrPid === 'object') {
      // exitCode OU signalCode preenchidos indicam que o processo já terminou
      if (childOrPid.exitCode !== null && childOrPid.exitCode !== undefined) return Promise.resolve();
      if (childOrPid.signalCode) return Promise.resolve();
      pid = childOrPid.pid;
      child = childOrPid;
    }
    if (!pid) return Promise.resolve();

    // Promessa de término observável (apenas quando temos o ChildProcess)
    const exited = child
      ? new Promise((resolve) => {
        const done = () => resolve();
        child.once('exit', done);
        child.once('close', done);
        const t = setTimeout(done, waitMs);
        if (t.unref) t.unref();
      })
      : null;

    const fallbackKill = (signal) => {
      try {
        // POSIX: mata o grupo inteiro quando o filho foi lançado como líder de grupo
        if (process.platform !== 'win32' && child && child.bdsProcessGroup) {
          try { process.kill(-pid, signal || 'SIGTERM'); return; } catch (_) { /* grupo inexistente: cai para o PID */ }
        }
        if (child && typeof child.kill === 'function') child.kill(signal);
        else process.kill(pid, signal);
      } catch (_) { /* processo já terminou */ }
    };

    const killed = new Promise((resolve) => {
      if (process.platform === 'win32') {
        let killer;
        try {
          killer = spawn(systemExe('taskkill'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        } catch (_) {
          fallbackKill();
          return resolve();
        }
        killer.on('error', () => { fallbackKill(); resolve(); });
        killer.on('close', (code) => {
          if (code !== 0 && code !== 128) {
            this._log('warn', 'ProcessRunner:taskkill:nonzero', { pid, code });
            fallbackKill();
          }
          resolve();
        });
      } else {
        fallbackKill('SIGTERM');
        const timeout = setTimeout(() => fallbackKill('SIGKILL'), 3000);
        if (timeout.unref) timeout.unref();
        if (child) child.once('exit', () => clearTimeout(timeout));
        resolve();
      }
    });

    return killed.then(() => exited).catch(() => {});
  }

  _log(level, msg, meta) {
    try {
      // require tardio: evita dependência circular/carga do winston em quem só usa o runner
      require('../../services/logService')[level](msg, meta);
    } catch (_) { /* noop */ }
  }
}

// Singleton
const processRunner = new ProcessRunner();

module.exports = { ProcessRunner, processRunner };
