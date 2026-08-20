'use strict';

const { spawn } = require('node:child_process');

/**
 * ProcessRunner — Abstração de baixo nível para execução e cancelamento
 * de processos do sistema operacional.
 *
 * Encapsula o comportamento específico de plataforma para cancelamento:
 *  - Windows: taskkill /PID <pid> /T /F
 *  - Linux/macOS: process.kill(pid, 'SIGTERM') com fallback SIGKILL
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
    return spawn(executable, args, { ...defaults, ...options });
  }

  /**
   * Cancela um processo em execução de forma multiplataforma.
   *
   * @param {import('child_process').ChildProcess|number} childOrPid - Processo ou PID a cancelar
   */
  cancel(childOrPid) {
    if (!childOrPid) return;

    let pid = null;
    let childProcess = null;

    if (typeof childOrPid === 'number') {
      pid = childOrPid;
    } else if (typeof childOrPid === 'object') {
      if (childOrPid.exitCode !== null) return;
      pid = childOrPid.pid;
      childProcess = childOrPid;
    }

    if (!pid) return;

    if (process.platform === 'win32') {
      // No Windows, taskkill com /T encerra processo e todos os filhos
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => {}); // Ignorar erros silenciosamente
    } else {
      // Linux/macOS: SIGTERM primeiro, SIGKILL como fallback após 3s
      try {
        if (childProcess && typeof childProcess.kill === 'function') {
          childProcess.kill('SIGTERM');
        } else {
          process.kill(pid, 'SIGTERM');
        }
        const timeout = setTimeout(() => {
          try {
            if (childProcess && typeof childProcess.kill === 'function') {
              childProcess.kill('SIGKILL');
            } else {
              process.kill(pid, 'SIGKILL');
            }
          } catch (_) {}
        }, 3000);
        if (timeout.unref) timeout.unref();
      } catch (_) {}
    }
  }
}

// Singleton
const processRunner = new ProcessRunner();

module.exports = { ProcessRunner, processRunner };
