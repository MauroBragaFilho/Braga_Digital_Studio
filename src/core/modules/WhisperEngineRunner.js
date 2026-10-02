'use strict';

/**
 * WhisperEngineRunner — executa o motor de legendas/transcrição (WhisperLegendas) como processo
 * separado e traduz a saída dele em eventos.
 *
 * Contrato com o motor (já existente, nenhuma alteração necessária):
 *   WhisperLegendas.exe --cli jobs [--srt] [--md] [--cpu] [--saida DIR] [--palavras N] <arquivos...>
 *   Variáveis de ambiente:
 *     WL_MODEL_DIR   pasta do modelo faster-whisper (com model.bin)  → modelo escolhido pelo usuário
 *     WL_CUDA_DIR    pasta com as DLLs do CUDA                        → GPU, quando instalada
 *     WL_FORCE_CPU   "1" força CPU
 *     WL_LOG         arquivo onde o motor grava o progresso (linhas "[progress] 12.3", "[status] ...",
 *                    "[device] ...", "[line] ..." e, no fim, "RESULTADO ok=N falhas=M [dispositivo]")
 *
 * O progresso é lido acompanhando esse arquivo de log. Cancelar encerra o processo (e os filhos).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SUPPORTED_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4a', '.wav', '.mp3', '.flac', '.ogg']);
const DEFAULT_EXE = 'WhisperLegendas.exe';
const POLL_MS = 250;
const MAX_FILES = 200;

class RunnerError extends Error {
  constructor(message, code) { super(message); this.name = 'RunnerError'; this.code = code; }
}

/** Valida e normaliza as opções de uma transcrição. */
function normalizeOptions(options = {}) {
  const files = Array.isArray(options.files) ? options.files.map((f) => String(f)) : [];
  if (files.length === 0) throw new RunnerError('Selecione ao menos um arquivo.', 'NO_FILES');
  if (files.length > MAX_FILES) throw new RunnerError(`Muitos arquivos de uma vez (máximo ${MAX_FILES}).`, 'TOO_MANY');

  for (const f of files) {
    if (!path.isAbsolute(f)) throw new RunnerError(`Caminho inválido: ${f}`, 'BAD_PATH');
    if (/^https?:/i.test(f)) throw new RunnerError('Links não são aceitos aqui; use arquivos locais.', 'BAD_PATH');
    const ext = path.extname(f).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new RunnerError(`Formato não suportado: ${path.basename(f)} (aceitos: ${[...SUPPORTED_EXTENSIONS].join(', ')}).`, 'BAD_FORMAT');
    }
    let stat;
    try { stat = fs.statSync(f); } catch (_) { throw new RunnerError(`Arquivo não encontrado: ${f}`, 'NOT_FOUND'); }
    if (!stat.isFile()) throw new RunnerError(`Não é um arquivo: ${f}`, 'NOT_FOUND');
  }

  const srt = options.srt !== false;
  const md = options.md === true;
  if (!srt && !md) throw new RunnerError('Marque ao menos uma saída: legenda (.srt) ou transcrição (.md).', 'NO_OUTPUT');

  let maxWords = Number(options.maxWords) || 0;
  if (!Number.isInteger(maxWords) || maxWords < 0 || maxWords > 40) {
    throw new RunnerError('Palavras por legenda deve ser um número entre 0 (automático) e 40.', 'BAD_OPTION');
  }

  let outDir = null;
  if (options.outDir) {
    outDir = String(options.outDir);
    if (!path.isAbsolute(outDir)) throw new RunnerError('A pasta de saída deve ser um caminho completo.', 'BAD_PATH');
  }
  return { files, srt, md, maxWords, outDir, forceCpu: options.forceCpu === true };
}

/** Interpreta uma linha do log do motor. */
function parseLogLine(line) {
  const text = line.replace(/\r$/, '');
  let m = /^\[(progress|status|line|device)\]\s?(.*)$/.exec(text);
  if (m) {
    if (m[1] === 'progress') {
      const pct = parseFloat(m[2]);
      return Number.isFinite(pct) ? { type: 'progress', percent: Math.min(100, Math.max(0, pct)) } : null;
    }
    return { type: m[1], text: m[2] };
  }
  m = /^RESULTADO ok=(\d+) falhas=(\d+)(?:\s+\[(.*)\])?/.exec(text);
  if (m) return { type: 'result', ok: Number(m[1]), failed: Number(m[2]), device: m[3] || '' };
  m = /^ERRO:\s*(.*)$/.exec(text);
  if (m) return { type: 'error', text: m[1] };
  if (/^cancelado/i.test(text)) return { type: 'cancelled' };
  return null;
}

/** Encerra um processo e seus filhos. */
function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  } catch (_) { /* noop */ }
}

class WhisperEngineRunner {
  /**
   * @param {{engineDir:string, exeName?:string, tempDir:string, command?:string, baseArgs?:string[]}} cfg
   *   command/baseArgs permitem trocar o executável (usado nos testes com um motor falso).
   */
  constructor({ engineDir, exeName = DEFAULT_EXE, tempDir, command = null, baseArgs = [] }) {
    this.engineDir = engineDir;
    this.exeName = exeName;
    this.tempDir = tempDir;
    this.command = command;
    this.baseArgs = baseArgs;
  }

  /**
   * @param {object} options  { files, srt, md, maxWords, outDir, forceCpu }
   * @param {{modelDir:string, cudaDir?:string|null, signal?:AbortSignal, onEvent?:(e:object)=>void}} ctx
   * @returns {Promise<{ok:number, failed:number, device:string, outputs:Array<{source:string,kind:string,path:string}>, errors:string[]}>}
   */
  async run(options, { modelDir, cudaDir = null, signal = null, onEvent = () => {} } = {}) {
    const opts = normalizeOptions(options);
    if (!modelDir || !fs.existsSync(path.join(modelDir, 'model.bin'))) {
      throw new RunnerError('Nenhum modelo instalado. Baixe e escolha um modelo antes de transcrever.', 'NO_MODEL');
    }
    const exe = this.command || path.join(this.engineDir, this.exeName);
    if (!this.command && !fs.existsSync(exe)) throw new RunnerError('O motor do Whisper não está instalado.', 'NO_ENGINE');
    if (opts.outDir) fs.mkdirSync(opts.outDir, { recursive: true });
    if (signal && signal.aborted) throw new RunnerError('Cancelado.', 'CANCELLED');

    fs.mkdirSync(this.tempDir, { recursive: true });
    const logPath = path.join(this.tempDir, `whisper_${Date.now()}.log`);
    fs.writeFileSync(logPath, '');

    const args = [...this.baseArgs, '--cli', 'jobs'];
    if (opts.srt) args.push('--srt');
    if (opts.md) args.push('--md');
    if (opts.forceCpu) args.push('--cpu');
    if (opts.outDir) args.push('--saida', opts.outDir);
    if (opts.maxWords > 0) args.push('--palavras', String(opts.maxWords));
    args.push(...opts.files);

    const env = { ...process.env, WL_MODEL_DIR: modelDir, WL_LOG: logPath, PYTHONIOENCODING: 'utf-8' };
    if (cudaDir && !opts.forceCpu) env.WL_CUDA_DIR = cudaDir;
    if (opts.forceCpu) env.WL_FORCE_CPU = '1';

    const startedAt = Date.now();
    const errors = [];
    let result = null;
    let device = '';
    let offset = 0;
    let carry = '';

    const readLog = () => {
      let fd;
      try {
        fd = fs.openSync(logPath, 'r');
        const size = fs.fstatSync(fd).size;
        if (size > offset) {
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          offset = size;
          carry += buf.toString('utf8');
          const lines = carry.split('\n');
          carry = lines.pop();
          for (const line of lines) handle(parseLogLine(line));
        }
      } catch (_) { /* log ainda não existe/ocupado: tenta no próximo ciclo */ } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* noop */ } }
      }
    };

    const handle = (ev) => {
      if (!ev) return;
      if (ev.type === 'result') { result = ev; device = ev.device || device; }
      else if (ev.type === 'device') { device = ev.text; onEvent(ev); }
      else if (ev.type === 'error') { errors.push(ev.text); onEvent(ev); }
      else if (ev.type === 'line' && /^ERRO em /.test(ev.text)) { errors.push(ev.text.replace(/^ERRO em /, '')); onEvent(ev); }
      else onEvent(ev);
    };

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(exe, args, { cwd: this.engineDir && fs.existsSync(this.engineDir) ? this.engineDir : undefined, env, windowsHide: true });
      } catch (err) {
        return reject(new RunnerError(`Não foi possível iniciar o motor: ${err.message}`, 'SPAWN'));
      }

      let cancelled = false;
      let stderr = '';
      child.stderr && child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
      child.stdout && child.stdout.on('data', () => { /* o motor escreve no log */ });

      const timer = setInterval(readLog, POLL_MS);
      const onAbort = () => { cancelled = true; killTree(child); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        clearInterval(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(new RunnerError(`Falha ao executar o motor: ${err.message}`, 'SPAWN'));
      });

      child.on('close', (code) => {
        clearInterval(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        readLog();
        if (carry.trim()) { handle(parseLogLine(carry)); carry = ''; }
        try { fs.rmSync(logPath, { force: true }); } catch (_) { /* noop */ }

        if (cancelled) return reject(new RunnerError('Transcrição cancelada.', 'CANCELLED'));
        if (!result) {
          const detail = errors[errors.length - 1] || stderr.trim().split('\n').pop() || `o motor terminou com código ${code}`;
          return reject(new RunnerError(`A transcrição falhou: ${detail}`, 'ENGINE'));
        }
        resolve({
          ok: result.ok, failed: result.failed, device,
          outputs: this._findOutputs(opts, startedAt),
          errors
        });
      });
    });
  }

  /** Localiza os arquivos gerados (o motor nomeia <nome>.srt / <nome>.md, com " (2)" se já existir). */
  _findOutputs(opts, startedAt) {
    const found = [];
    const kinds = [opts.srt ? 'srt' : null, opts.md ? 'md' : null].filter(Boolean);
    for (const source of opts.files) {
      const dir = opts.outDir || path.dirname(source);
      const stem = path.basename(source, path.extname(source));
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) { continue; }
      for (const kind of kinds) {
        const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\(\\d+\\))?\\.${kind}$`, 'i');
        const candidates = names.filter((n) => re.test(n))
          .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
          .filter((c) => c.t >= startedAt - 2000)
          .sort((a, b) => b.t - a.t);
        if (candidates[0]) found.push({ source, kind, path: path.join(dir, candidates[0].n) });
      }
    }
    return found;
  }
}

module.exports = { WhisperEngineRunner, RunnerError, normalizeOptions, parseLogLine, SUPPORTED_EXTENSIONS, DEFAULT_EXE };
