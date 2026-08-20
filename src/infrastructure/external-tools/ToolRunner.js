'use strict';

const { processRunner } = require('./ProcessRunner');

/**
 * ToolRunner — Interface de alto nível para executar ferramentas externas.
 *
 * Responsabilidades (seção 8 do roadmap):
 *  - Executar processos via ProcessRunner
 *  - Capturar stdout e stderr
 *  - Emitir callbacks de progresso e log
 *  - Controlar timeout
 *  - Permitir cancelamento
 *  - Registrar duração e código de saída
 */
class ToolRunner {
  /**
   * Executa um executável externo e retorna Promise com resultado.
   *
   * A Promise retornada possui uma propriedade `.cancel()` para interrupção.
   *
   * @param {string} executablePath - Caminho completo para o executável
   * @param {string[]} args - Argumentos
   * @param {object} [opts]
   * @param {(line: string) => void} [opts.onStdout] - Callback linha a linha de stdout
   * @param {(line: string) => void} [opts.onStderr] - Callback linha a linha de stderr
   * @param {(data: object) => void} [opts.onProgress] - Callback de progresso (dados parseados)
   * @param {(line: string) => void} [opts.onLog] - Alias para onStderr (compatibilidade)
   * @param {number} [opts.timeout] - Timeout em ms (0 = sem timeout)
   * @param {string} [opts.cwd] - Diretório de trabalho
   * @param {object} [opts.env] - Variáveis de ambiente extras
   * @param {boolean} [opts.windowsHide=true] - Ocultar janela no Windows
   * @returns {Promise<{code: number, stdout: string, stderr: string, killed: boolean, durationMs: number}> & { cancel: () => void, process: import('child_process').ChildProcess }}
   */
  run(executablePath, args, opts = {}) {
    const {
      onStdout,
      onStderr,
      onProgress,
      onLog,
      timeout = 0,
      cwd,
      env,
      windowsHide = true,
    } = opts;

    let childProcess = null;
    let killed = false;
    let timeoutHandle = null;

    const promise = new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let stdoutLines = '';
      let stderrLines = '';

      try {
        childProcess = processRunner.spawn(executablePath, args, {
          cwd,
          windowsHide,
          env: env ? { ...process.env, ...env } : process.env,
        });
      } catch (err) {
        return reject(new Error(`Falha ao iniciar '${executablePath}': ${err.message}`));
      }

      // Timeout
      if (timeout > 0) {
        timeoutHandle = setTimeout(() => {
          killed = true;
          processRunner.cancel(childProcess);
          reject(new Error(`Timeout (${timeout}ms) ao executar '${executablePath}'`));
        }, timeout);
        if (timeoutHandle.unref) timeoutHandle.unref();
      }

      // stdout
      if (childProcess.stdout) {
        childProcess.stdout.on('data', (chunk) => {
          const data = chunk.toString('utf8');
          stdoutBuffer += data;
          stdoutLines += data;

          const lines = stdoutLines.split(/\r?\n/);
          stdoutLines = lines.pop(); // última linha (pode estar incompleta)
          for (const line of lines) {
            if (line) {
              if (onStdout) onStdout(line);
              if (onProgress) {
                try {
                  const parsed = _parseProgressLine(line);
                  if (parsed) onProgress(parsed);
                } catch (_) {}
              }
            }
          }
        });
      }

      // stderr
      if (childProcess.stderr) {
        childProcess.stderr.on('data', (chunk) => {
          const data = chunk.toString('utf8');
          stderrBuffer += data;
          stderrLines += data;

          const lines = stderrLines.split(/\r?\n/);
          stderrLines = lines.pop();
          for (const line of lines) {
            if (line) {
              if (onStderr) onStderr(line);
              if (onLog) onLog(line);
            }
          }
        });
      }

      childProcess.on('error', (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(new Error(`Erro ao executar '${executablePath}': ${err.message}`));
      });

      childProcess.on('close', (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);

        const durationMs = Date.now() - startedAt;
        resolve({
          code: code ?? -1,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          killed,
          durationMs,
        });
      });
    });

    // Anexar cancel() e process na promise para uso externo
    promise.cancel = () => {
      if (childProcess) {
        killed = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        processRunner.cancel(childProcess);
      }
    };

    Object.defineProperty(promise, 'process', {
      get: () => childProcess,
      enumerable: false,
    });

    return promise;
  }

  /**
   * Cancela um processo referenciado por um handle de processo ou uma promise
   * retornada por run().
   *
   * @param {object} handleOrPromise - ChildProcess ou promise de run()
   */
  cancel(handleOrPromise) {
    if (handleOrPromise && typeof handleOrPromise.cancel === 'function') {
      handleOrPromise.cancel();
    } else if (handleOrPromise) {
      processRunner.cancel(handleOrPromise);
    }
  }
}

function _parseProgressLine(line) {
  if (!line.includes('=')) return null;
  const [key, value] = line.split('=');
  if (!key || !value) return null;
  return { [key.trim()]: value.trim() };
}

// Singleton
const toolRunner = new ToolRunner();

module.exports = { ToolRunner, toolRunner };
