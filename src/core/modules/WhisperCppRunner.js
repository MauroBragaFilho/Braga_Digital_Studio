'use strict';

/**
 * WhisperCppRunner — motor de transcrição do BDS, sobre o whisper.cpp (`whisper-cli`).
 *
 * Para cada arquivo:
 *   1. o ffmpeg do BDS converte o vídeo/áudio em WAV mono 16 kHz (numa pasta de trabalho temporária);
 *   2. o `whisper-cli` transcreve e grava um JSON completo (trechos e tokens com tempo);
 *   3. o BDS agrupa os tokens em palavras (whisperCppOutput.js) e gera a legenda .srt e a transcrição .md
 *      (subtitles.js), sempre em nome livre ("aula (2).srt"), sem sobrescrever nada.
 *
 * Configuração validada contra o faster-whisper (medições no README do módulo): beam 1, sem contexto do
 * trecho anterior (-mc 0) e alinhamento por DTW (-dtw, que exige desligar a flash attention) para o tempo das
 * palavras. Sem DTW (modelo desconhecido) cai no tempo por token, que é bem menos preciso.
 *
 * O `whisper-cli.exe` oficial não aceita caminhos com acento nos argumentos. Por isso ele roda com a pasta de
 * trabalho como diretório atual e só recebe nomes relativos em ASCII (ver `asciiArgs`); os caminhos reais
 * (vídeo de origem, destino das legendas) ficam com o ffmpeg e com o Node, que lidam bem com Unicode.
 *
 * Eventos (onEvent): { type:'progress', percent } | { type:'status', text } | { type:'device', text } |
 *   { type:'line', text } | { type:'error', text } | { type:'file', index, state:'start'|'progress'|'done'|'error', percent?, text? }
 * Cancelar (AbortSignal) encerra o processo em andamento (e os filhos).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseWhisperCppJson } = require('../transcription/whisperCppOutput');
const { buildSrt, buildMarkdown, DEFAULT_MAX_CHARS } = require('../transcription/subtitles');
const { writeUnique } = require('../transcription/writeUnique');
const { getModel } = require('./WhisperCatalog');

const SUPPORTED_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4a', '.wav', '.mp3', '.flac', '.ogg']);
const CLI_NAME = 'whisper-cli.exe';
const MAX_FILES = 200;
const SAMPLE_RATE = 16000;
const WAV_HEADER_BYTES = 44;
const DECODE_SHARE = 2; // % do andamento de um arquivo usado pela leitura do áudio

class RunnerError extends Error {
  constructor(message, code, detail = null) { super(message); this.name = 'RunnerError'; this.code = code; this.detail = detail; }
}

const cancelledError = () => new RunnerError('Transcrição cancelada.', 'CANCELLED');

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

  // Linhas por legenda: 1 ou 2
  const lines = options.lines === undefined || options.lines === null ? 2 : Number(options.lines);
  if (lines !== 1 && lines !== 2) throw new RunnerError('Linhas por legenda deve ser 1 ou 2.', 'BAD_OPTION');

  const maxWords = Number(options.maxWords) || 0;
  if (!Number.isInteger(maxWords) || maxWords < 0 || maxWords > 40) {
    throw new RunnerError('Palavras por legenda deve ser um número entre 0 (automático) e 40.', 'BAD_OPTION');
  }

  const language = options.language === undefined || options.language === null ? 'pt' : String(options.language).toLowerCase();
  if (!/^(auto|[a-z]{2,3})$/.test(language)) throw new RunnerError('Idioma inválido.', 'BAD_OPTION');

  let outDir = null;
  if (options.outDir) {
    outDir = String(options.outDir);
    if (!path.isAbsolute(outDir)) throw new RunnerError('A pasta de saída deve ser um caminho completo.', 'BAD_PATH');
  }
  return { files, srt, md, maxWords, lines, language, outDir, forceCpu: options.forceCpu === true };
}

/** Encerra um processo e seus filhos. */
function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  } catch (_) { /* noop */ }
}

/**
 * Roda um programa acompanhando a saída por linha. Resolve com o código de saída e o fim do log.
 * @returns {Promise<{code:number|null, tail:string}>}
 */
function runProcess({ command, args, cwd, env, signal = null, onLine = () => {} }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(cancelledError());
    let child;
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(new RunnerError(`Não foi possível iniciar ${path.basename(command)}: ${err.message}`, 'SPAWN'));
    }

    let tail = '';
    let cancelled = false;
    const watch = (stream) => {
      let carry = '';
      stream.on('data', (chunk) => {
        const parts = (carry + chunk.toString('utf8')).split(/\r\n|\n|\r/);
        carry = parts.pop();
        for (const line of parts) { tail = `${tail}${line}\n`.slice(-4000); onLine(line); }
      });
      stream.on('end', () => { if (carry) { tail = `${tail}${carry}\n`.slice(-4000); onLine(carry); } });
    };
    watch(child.stdout);
    watch(child.stderr);

    const onAbort = () => { cancelled = true; killTree(child); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const done = () => { if (signal) signal.removeEventListener('abort', onAbort); };

    child.on('error', (err) => {
      done();
      const missing = err.code === 'ENOENT';
      reject(new RunnerError(missing ? `Programa não encontrado: ${path.basename(command)}` : `Falha ao executar ${path.basename(command)}: ${err.message}`, missing ? 'NO_PROGRAM' : 'SPAWN'));
    });
    child.on('close', (code) => {
      done();
      if (cancelled) return reject(cancelledError());
      resolve({ code, tail });
    });
  });
}

const lastLine = (text) => String(text).trim().split('\n').filter(Boolean).pop() || '';

/** Caminho relativo a `cwd` quando o resultado é só ASCII; senão null. */
function asciiRelative(cwd, target) {
  const rel = path.relative(cwd, target);
  return !path.isAbsolute(rel) && /^[\x20-\x7e]+$/.test(rel) ? rel : null;
}

class WhisperCppRunner {
  /**
   * @param {{engineDir?:string, cudaDir?:string, tempDir:string, workRoot?:string, ffmpegPath?:string|null, cliName?:string,
   *          cliCommand?:string, cliBaseArgs?:string[], ffmpegBaseArgs?:string[]}} cfg
   *   engineDir: motor para CPU · cudaDir: motor NVIDIA (traz o CPU junto) · workRoot: onde ficam os arquivos
   *   temporários de cada transcrição (o ideal é junto dos modelos, para o caminho relativo do modelo ser curto
   *   e em ASCII) · cliCommand/cliBaseArgs: trocar o executável (usado nos testes com um motor falso).
   */
  constructor({ engineDir = null, cudaDir = null, tempDir, workRoot = null, ffmpegPath = null, cliName = CLI_NAME, cliCommand = null, cliBaseArgs = [], ffmpegBaseArgs = [] }) {
    this.engineDir = engineDir;
    this.cudaDir = cudaDir;
    this.tempDir = tempDir;
    this.workRoot = workRoot || tempDir;
    this.ffmpegPath = ffmpegPath;
    this.cliName = cliName;
    this.cliCommand = cliCommand;
    this.cliBaseArgs = cliBaseArgs;
    this.ffmpegBaseArgs = ffmpegBaseArgs;
  }

  /** Quais motores existem: o da GPU (CUDA) e o da CPU. Sem motor da CPU, o da GPU roda com -ng. */
  _engines() {
    const has = (dir) => Boolean(dir) && fs.existsSync(path.join(dir, this.cliName));
    return { cuda: has(this.cudaDir) ? this.cudaDir : null, cpu: has(this.engineDir) ? this.engineDir : null };
  }

  /**
   * @param {object} options  { files, srt, md, maxWords, lines, language, outDir, forceCpu }
   * @param {{modelDir:string, modelId?:string, modelName?:string, dtwPreset?:string|null, signal?:AbortSignal, onEvent?:(e:object)=>void}} ctx
   * @returns {Promise<{ok:number, failed:number, device:string, outputs:Array<{source:string,kind:string,path:string}>, errors:string[]}>}
   */
  async run(options, { modelDir, modelId = '', modelName = '', dtwPreset, signal = null, onEvent = () => {} } = {}) {
    const opts = normalizeOptions(options);
    const modelFile = modelDir ? path.join(modelDir, 'model.bin') : '';
    if (!modelFile || !fs.existsSync(modelFile)) {
      throw new RunnerError('Nenhum modelo instalado. Baixe e escolha um modelo antes de transcrever.', 'NO_MODEL');
    }
    const engines = this._engines();
    if (!this.cliCommand && !engines.cuda && !engines.cpu) throw new RunnerError('O motor de transcrição não está instalado.', 'NO_ENGINE');
    if (!this.ffmpegPath && !this.ffmpegBaseArgs.length) throw new RunnerError('O ffmpeg não foi encontrado. Ele é necessário para ler vídeos e áudios.', 'NO_FFMPEG');
    if (opts.outDir) fs.mkdirSync(opts.outDir, { recursive: true });
    if (signal && signal.aborted) throw cancelledError();

    const dtw = dtwPreset !== undefined ? dtwPreset : (getModel(modelId) || {}).dtw || null;
    const label = modelName || modelId || 'whisper';
    const wantGpu = !opts.forceCpu && Boolean(engines.cuda);
    let gpuBroken = false;
    let device = '';

    const outputs = [];
    const errors = [];
    let ok = 0;
    let failed = 0;
    const total = opts.files.length;
    const emitFile = (index, state, extra = {}) => onEvent({ type: 'file', index, state, ...extra });

    for (let index = 0; index < total; index++) {
      if (signal && signal.aborted) throw cancelledError();
      const source = opts.files[index];
      const name = path.basename(source);
      const overall = (fraction) => onEvent({ type: 'progress', percent: Math.min(100, ((index + fraction) / total) * 100) });
      emitFile(index, 'start');
      overall(0);

      fs.mkdirSync(this.workRoot, { recursive: true });
      const work = fs.mkdtempSync(path.join(this.workRoot, 'whisper_'));
      try {
        onEvent({ type: 'status', text: `Lendo o áudio de ${name}` });
        const wav = path.join(work, 'audio.wav');
        await this._decode(source, wav, signal);
        const seconds = Math.max(0, (fs.statSync(wav).size - WAV_HEADER_BYTES) / (SAMPLE_RATE * 2));
        if (seconds < 0.2) throw new RunnerError('O arquivo não tem áudio legível.', 'NO_AUDIO');

        const fileProgress = (fraction) => {
          const pct = DECODE_SHARE + (100 - DECODE_SHARE) * Math.min(Math.max(fraction, 0), 1);
          emitFile(index, 'progress', { percent: pct });
          overall(pct / 100);
        };
        fileProgress(0);
        onEvent({ type: 'status', text: `Carregando o modelo (${name})` }); // pode levar de poucos segundos a mais de 1 minuto
        const onLoaded = () => onEvent({ type: 'status', text: `Transcrevendo ${name}` });

        let useGpu = wantGpu && !gpuBroken;
        let run;
        for (;;) {
          try {
            run = await this._runCli({ work, modelFile, useGpu, language: opts.language, dtw, engines, signal, onProgress: fileProgress, onLoaded });
            break;
          } catch (err) {
            if (!(err instanceof RunnerError) || err.code !== 'ENGINE_FAILED' || !useGpu) throw err;
            // A GPU falhou (driver, memória…): tenta de novo na CPU e não insiste nela nos próximos arquivos.
            gpuBroken = true;
            useGpu = false;
            onEvent({ type: 'line', text: `A GPU não respondeu (${err.detail || err.message}); usando a CPU.` });
            fileProgress(0);
            onEvent({ type: 'status', text: `Carregando o modelo na CPU (${name})` });
          }
        }
        if (run.device !== device) { device = run.device; onEvent({ type: 'device', text: device }); }

        const parsed = parseWhisperCppJson(fs.readFileSync(path.join(work, 'out.json')), { preferDtw: Boolean(dtw) });
        if (!parsed.segments.length) throw new RunnerError('Nenhuma fala foi detectada no arquivo.', 'NO_SPEECH');

        const dir = opts.outDir || path.dirname(source);
        const stem = path.basename(source, path.extname(source));
        const made = [];
        if (opts.srt) {
          const { cues, text } = buildSrt(parsed.words, { maxWords: opts.maxWords, lines: opts.lines, maxChars: DEFAULT_MAX_CHARS });
          made.push({ source, kind: 'srt', path: writeUnique(path.join(dir, `${stem}.srt`), text) });
          onEvent({ type: 'line', text: `Legenda criada: ${path.basename(made[made.length - 1].path)} (${cues.length} legendas)` });
        }
        if (opts.md) {
          const text = buildMarkdown({ title: stem, model: label, duration: seconds, segments: parsed.segments });
          made.push({ source, kind: 'md', path: writeUnique(path.join(dir, `${stem}.md`), text) });
          onEvent({ type: 'line', text: `Transcrição criada: ${path.basename(made[made.length - 1].path)}` });
        }
        outputs.push(...made);
        ok++;
        emitFile(index, 'progress', { percent: 100 });
        emitFile(index, 'done');
      } catch (err) {
        if (err instanceof RunnerError && err.code === 'CANCELLED') throw err;
        failed++;
        const message = err instanceof RunnerError ? err.message : `${err.name || 'Erro'}: ${err.message}`;
        errors.push(`${name}: ${message}`);
        onEvent({ type: 'error', text: `${name}: ${message}` });
        emitFile(index, 'error', { text: message });
      } finally {
        try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch (_) { /* a pasta temporária fica para a próxima limpeza */ }
      }
      overall(1);
    }
    return { ok, failed, device, outputs, errors };
  }

  /** ffmpeg: qualquer vídeo/áudio → WAV mono 16 kHz. */
  async _decode(input, wav, signal) {
    const command = this.ffmpegPath || process.execPath;
    const { code, tail } = await runProcess({
      command,
      args: [...this.ffmpegBaseArgs, '-nostdin', '-v', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', wav],
      signal
    });
    if (code === 0 && fs.existsSync(wav)) return;
    if (/does not contain any stream|no audio|Output file is empty/i.test(tail)) throw new RunnerError('O arquivo não tem faixa de áudio.', 'NO_AUDIO');
    throw new RunnerError(`O ffmpeg não conseguiu ler o arquivo: ${lastLine(tail) || `código ${code}`}`, 'DECODE');
  }

  /** whisper-cli: grava <work>/out.json. Devolve onde rodou ("GPU (CUDA)" ou "CPU"). */
  async _runCli({ work, modelFile, useGpu, language, dtw, engines, signal, onProgress, onLoaded = () => {} }) {
    const engineDir = this.cliCommand ? (this.cudaDir || this.engineDir || work) : (useGpu ? engines.cuda : (engines.cpu || engines.cuda));
    const command = this.cliCommand || path.join(engineDir, this.cliName);
    const noGpuFlag = !useGpu && (Boolean(this.cliCommand) || !engines.cpu); // só o motor NVIDIA instalado: força a CPU com -ng

    // O whisper-cli não aceita acentos nos argumentos: só caminhos relativos em ASCII, com a pasta de trabalho como cwd.
    let model = asciiRelative(work, modelFile);
    let staged = null;
    if (!model) {
      // Pasta de dados em outro disco/com acento no trecho final: usa um atalho (hard link) ou, se não der, uma cópia.
      staged = path.join(work, 'model.bin');
      try { fs.linkSync(modelFile, staged); } catch (_) { fs.copyFileSync(modelFile, staged); }
      model = 'model.bin';
    }

    // Metade dos núcleos lógicos (≈ os físicos): o whisper.cpp espera ocupado entre as etapas, e usar quase todos os
    // núcleos com outros programas abertos derrubou o desempenho a quase zero nos testes.
    const threads = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
    const args = [...this.cliBaseArgs, '-m', model, '-f', 'audio.wav', '-l', language, '-ojf', '-of', 'out', '-pp',
      '-bs', '1', '-bo', '1', '-mc', '0', '-t', String(threads)];
    if (dtw) args.push('-dtw', dtw, '-nfa'); // o alinhamento por DTW exige a flash attention desligada
    if (noGpuFlag) args.push('-ng');

    let sawGpu = false;
    let sawCudaError = false;
    let loaded = false;
    const { code, tail } = await runProcess({
      command, args, cwd: work, signal,
      env: { ...process.env },
      onLine: (line) => {
        const p = /progress\s*=\s*(\d+)%/.exec(line);
        if (p) { onProgress(Number(p[1]) / 100); }
        if (!loaded && /^system_info:|whisper_init_state:|whisper_print_progress_callback/.test(line)) { loaded = true; onLoaded(); }
        if (p) return;
        if (/whisper_backend_init_gpu: using \S+ backend/.test(line)) sawGpu = true;
        if (/ggml_cuda_init: failed|CUDA error|cudaMalloc failed|failed to allocate/i.test(line)) sawCudaError = true;
      }
    });
    if (staged) fs.rmSync(staged, { force: true });

    if (code !== 0 || !fs.existsSync(path.join(work, 'out.json'))) {
      const reason = sawCudaError ? 'erro da placa de vídeo' : (lastLine(tail) || `código ${code}`);
      throw new RunnerError(`A transcrição falhou: ${reason}`, 'ENGINE_FAILED', reason);
    }
    return { device: useGpu && sawGpu ? 'GPU (CUDA)' : 'CPU' };
  }
}

module.exports = { WhisperCppRunner, RunnerError, normalizeOptions, runProcess, asciiRelative, SUPPORTED_EXTENSIONS, CLI_NAME };
