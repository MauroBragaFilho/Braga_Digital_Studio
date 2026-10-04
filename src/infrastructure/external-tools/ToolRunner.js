'use strict';

const { StringDecoder } = require('node:string_decoder');
const { processRunner } = require('./ProcessRunner');

/** Teto padrão de stdout/stderr acumulados por execução (por fluxo). */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Linha sem quebra acima disso é entregue em pedaços ao consumidor. */
const MAX_LINE_CARRY = 1024 * 1024;

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
   * @param {number} [opts.maxBytes=67108864] - Teto de stdout/stderr acumulados por fluxo (0 = sem teto); ao passar, mata a árvore e devolve truncated: true
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
      maxBytes = DEFAULT_MAX_BYTES,
    } = opts;

    let childProcess = null;
    let killed = false;
    let timedOut = false;
    let timeoutHandle = null;

    const promise = new Promise((resolve, reject) => {
      const startedAt = Date.now();
      // Acúmulo em pedaços (join no fim): concatenar string a cada chunk era quadrático em saídas grandes.
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let stdoutCarry = '';
      let stderrCarry = '';

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
          timedOut = true;
          // Aguarda o término real da árvore de processos antes de rejeitar
          processRunner.cancel(childProcess).then(() => {
            reject(new Error(`Timeout (${timeout}ms) ao executar '${executablePath}'`));
          });
        }, timeout);
        if (timeoutHandle.unref) timeoutHandle.unref();
      }

      // Teto de bytes por fluxo: passou, mata a árvore e devolve o que coube (truncated: true).
      const overLimit = (bytes) => {
        if (!(maxBytes > 0) || bytes <= maxBytes || truncated) return false;
        truncated = true;
        killed = true;
        processRunner.cancel(childProcess).catch(() => {});
        return true;
      };

      const emitStdoutLine = (line) => {
        if (!line) return;
        if (onStdout) onStdout(line);
        if (onProgress) {
          try {
            const parsed = _parseProgressLine(line);
            if (parsed) onProgress(parsed);
          } catch (_) {}
        }
      };
      const emitStderrLine = (line) => {
        if (!line) return;
        if (onStderr) onStderr(line);
        if (onLog) onLog(line);
      };
      // Só divide em linhas quando há quem consuma; uma linha gigante sem quebra é entregue em
      // pedaços de até MAX_LINE_CARRY para não crescer sem limite.
      const feedLines = (data, carry, emit) => {
        const joined = carry ? carry + data : data;
        const lines = joined.split(/\r?\n/);
        let rest = lines.pop();
        for (const line of lines) emit(line);
        if (rest.length > MAX_LINE_CARRY) { emit(rest); rest = ''; }
        return rest;
      };
      const wantsStdoutLines = !!(onStdout || onProgress);
      const wantsStderrLines = !!(onStderr || onLog);

      // stdout
      if (childProcess.stdout) {
        childProcess.stdout.on('data', (chunk) => {
          if (truncated) return;
          stdoutBytes += chunk.length;
          if (overLimit(stdoutBytes)) return;
          const data = stdoutDecoder.write(chunk);
          stdoutChunks.push(data);
          if (wantsStdoutLines && data) stdoutCarry = feedLines(data, stdoutCarry, emitStdoutLine);
        });
      }

      // stderr
      if (childProcess.stderr) {
        childProcess.stderr.on('data', (chunk) => {
          if (truncated) return;
          stderrBytes += chunk.length;
          if (overLimit(stderrBytes)) return;
          const data = stderrDecoder.write(chunk);
          stderrChunks.push(data);
          if (wantsStderrLines && data) stderrCarry = feedLines(data, stderrCarry, emitStderrLine);
        });
      }

      childProcess.on('error', (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(new Error(`Erro ao executar '${executablePath}': ${err.message}`));
      });

      childProcess.on('close', (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (timedOut) return; // o timeout rejeita depois que a árvore terminar

        // Resto dos decoders e última linha sem quebra (antes era perdida)
        const stdoutTail = stdoutDecoder.end();
        const stderrTail = stderrDecoder.end();
        if (stdoutTail && !truncated) { stdoutChunks.push(stdoutTail); stdoutCarry += stdoutTail; }
        if (stderrTail && !truncated) { stderrChunks.push(stderrTail); stderrCarry += stderrTail; }
        try {
          if (wantsStdoutLines && stdoutCarry) emitStdoutLine(stdoutCarry);
          if (wantsStderrLines && stderrCarry) emitStderrLine(stderrCarry);
        } catch (_) { /* callback do consumidor não derruba o resolve */ }

        const durationMs = Date.now() - startedAt;
        resolve({
          code: code ?? -1,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          killed,
          truncated,
          durationMs,
        });
      });
    });

    // Anexar cancel() e process na promise para uso externo
    promise.cancel = () => {
      if (childProcess) {
        killed = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        return processRunner.cancel(childProcess);
      }
      return Promise.resolve();
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
   * @returns {Promise<void>} resolve quando o processo terminou
   */
  cancel(handleOrPromise) {
    if (handleOrPromise && typeof handleOrPromise.cancel === 'function') {
      return handleOrPromise.cancel();
    }
    if (handleOrPromise) return processRunner.cancel(handleOrPromise);
    return Promise.resolve();
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
