'use strict';

/**
 * LocalLlm — modelo de IA PEQUENO que roda dentro do computador, para o assistente funcionar sem internet nem chave.
 *
 * Duas peças, ambas de fontes OFICIAIS e conferidas por SHA-256 (nada é compilado nem vem de build de terceiros):
 *  - o servidor `llama-server` da release oficial do llama.cpp (github.com/ggml-org/llama.cpp), versão FIXADA aqui;
 *  - o modelo Qwen2.5-0.5B-Instruct (Alibaba, licença Apache 2.0), em GGUF, do repositório oficial Qwen no Hugging Face,
 *    revisão FIXADA aqui.
 *
 * O servidor só liga quando o assistente precisa (`ensureRunning`), escuta SÓ em 127.0.0.1 e desliga sozinho depois de
 * alguns minutos sem uso. O app o trata como mais um provedor (preset "embedded", protocolo compatível com a OpenAI).
 * É um modelo básico: bom para consultas e pedidos simples; os comandos mais comuns ("baixa este link", "transcreve")
 * nem chegam a ele (ver services/ai/commands.js).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { spawn: nodeSpawn } = require('node:child_process');
const { downloadFile, sha256File, CANCELLED } = require('./FileDownloader');
const { extractZip, extractTarball, walkFiles } = require('./ZipExtractor');
const { EMBEDDED_PORT } = require('../../services/ai/providers/presets');

/**
 * Release do llama.cpp testada com o BDS (somente CPU: serve em qualquer computador). Para atualizar: escolha uma tag
 * "bNNNN" em https://github.com/ggml-org/llama.cpp/releases, copie o SHA-256 de cada pacote (campo "digest" da release),
 * troque os valores e rode o teste do modelo local.
 */
const LLAMA_RELEASE = {
  tag: 'b12322',
  assets: {
    'win32-x64': { name: 'llama-b12322-bin-win-cpu-x64.zip', size: 25084871, sha256: '35b6b69e69ae1a313768feb70bc1c4504bf070f7015704aaa88543812bcc5dd2' },
    'win32-arm64': { name: 'llama-b12322-bin-win-cpu-arm64.zip', size: 13433033, sha256: '5e09e459aa05110e6e5c1a4b9031ba2df534cf8f585e9aa77adf7ff1a8212c1e' },
    'linux-x64': { name: 'llama-b12322-bin-ubuntu-x64.tar.gz', size: 23311399, sha256: '735a12ee7711afc75d994a7b9fac654a7f8718d084d33cf001910f0d16c5a7d0' },
    'linux-arm64': { name: 'llama-b12322-bin-ubuntu-arm64.tar.gz', size: 18953520, sha256: '86e03e044b9ad39295c381cba6ee0ba49d9398457e7800d2370e4a453f8dea4d' },
    'darwin-arm64': { name: 'llama-b12322-bin-macos-arm64.tar.gz', size: 16895995, sha256: '009410b5a2d5d2b6952c38410a353773eaaa849684d53586f3f79315142c5fa4' },
    'darwin-x64': { name: 'llama-b12322-bin-macos-x64.tar.gz', size: 12639396, sha256: '950c2135e80b7da887c403203990ecd38c80961472fbd676a5414cc7ce7170f6' }
  }
};

/** Modelo padrão: pequeno (~490 MB), entende português e aceita chamada de ferramentas. */
const LOCAL_MODEL = {
  id: 'qwen2.5-0.5b-instruct',
  label: 'Qwen2.5 0.5B Instruct',
  repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
  revision: '9217f5db79a29953eb74d5343926648285ec7e67',
  file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
  size: 491400032,
  sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db',
  license: 'Apache 2.0'
};

const IDLE_MS = 10 * 60 * 1000;      // sem uso por 10 min: desliga o servidor e libera a memória
const START_TIMEOUT_MS = 120 * 1000; // carregar o modelo na memória

class LlmError extends Error {
  constructor(message, code) { super(message); this.name = 'LlmError'; this.code = code; }
}

const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { /* noop */ } };
const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(Math.max(n, 1)) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

class LocalLlm extends EventEmitter {
  /**
   * @param {{ rootDir:string, tempDir:string, config?:{ platform?:string, arch?:string, port?:number, spawn?:Function,
   *           release?:object, model?:object, githubBaseUrl?:string, huggingFaceBaseUrl?:string, idleMs?:number,
   *           startTimeoutMs?:number, downloadAttempts?:number, serverFile?:string } }} opts  (config: testes)
   */
  constructor({ rootDir, tempDir, config = {} }) {
    super();
    if (!rootDir || !tempDir) throw new Error('LocalLlm: rootDir e tempDir são obrigatórios.');
    this.config = config;
    this.root = path.join(rootDir, 'modules', 'llm');
    this.work = path.join(tempDir, 'modules', 'llm');
    this.paths = { runtime: path.join(this.root, 'runtime'), model: path.join(this.root, 'model.gguf') };
    this.release = config.release || LLAMA_RELEASE;
    this.model = config.model || LOCAL_MODEL;
    this.port = config.port || EMBEDDED_PORT;
    this._platform = config.platform || process.platform;
    this._arch = config.arch || process.arch;
    this._spawn = config.spawn || nodeSpawn;
    this._serverFile = config.serverFile || (this._platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    this._githubBase = (config.githubBaseUrl || 'https://github.com').replace(/\/+$/, '');
    this._hfBase = (config.huggingFaceBaseUrl || 'https://huggingface.co').replace(/\/+$/, '');
    this._active = null;
    this._child = null;
    this._starting = null;
    this._idleTimer = null;
  }

  // ------------------------------------------------------------------ estado

  _asset() { return this.release.assets[`${this._platform}-${this._arch}`] || null; }

  supported() { return Boolean(this._asset()); }

  _runtimeInstalled() { return fs.existsSync(path.join(this.paths.runtime, this._serverFile)); }
  _modelInstalled() { return fs.existsSync(this.paths.model); }
  isInstalled() { return this._runtimeInstalled() && this._modelInstalled(); }
  isRunning() { return Boolean(this._child && this._child.exitCode === null && !this._child.killed); }

  getStatus() {
    const supported = this.supported();
    return {
      supported,
      reason: supported ? '' : `O modelo local ainda não está disponível para este sistema (${this._platform}, ${this._arch}).`,
      installed: this.isInstalled(),
      running: this.isRunning(),
      port: this.port,
      modelLabel: this.model.label,
      license: this.model.license,
      sizeBytes: this.model.size + ((this._asset() || {}).size || 0),
      busy: this._active ? this._active.label : null
    };
  }

  // ------------------------------------------------------------------ instalação

  _begin(kind, label) {
    if (this._active) throw new LlmError(`Já existe uma operação em andamento: ${this._active.label}.`, 'BUSY');
    this._active = { kind, label, controller: new AbortController() };
    this.emit('status');
    return this._active;
  }

  _end() { this._active = null; this.emit('status'); }

  cancel() {
    if (!this._active) return false;
    this._active.controller.abort();
    return true;
  }

  _progress(patch) { this.emit('progress', { kind: 'llm', percent: null, ...patch }); }

  async _ensureSpace(dir, needBytes) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const s = await fs.promises.statfs(dir);
      const free = s.bavail * s.bsize;
      if (free < needBytes) throw new LlmError(`Espaço em disco insuficiente: são necessários cerca de ${fmtBytes(needBytes)} e há ${fmtBytes(free)} livres.`, 'DISK');
    } catch (err) {
      if (err instanceof LlmError) throw err; /* statfs indisponível: segue sem a checagem */
    }
  }

  async _fetch({ url, dest, sha256, size, onProgress, signal }) {
    if (fs.existsSync(dest) && fs.statSync(dest).size === size && (await sha256File(dest, signal)).toLowerCase() === sha256.toLowerCase()) return;
    rmrf(dest);
    await downloadFile({
      url, dest, expectedSha256: sha256, expectedSize: size, onProgress, signal,
      ...(this.config.downloadAttempts ? { attempts: this.config.downloadAttempts, backoffMs: 1 } : {})
    });
  }

  /** Baixa e instala o servidor (llama.cpp) e o modelo. Idempotente: o que já está instalado e íntegro é mantido. */
  async install() {
    const asset = this._asset();
    if (!asset) throw new LlmError(this.getStatus().reason, 'PLATFORM');
    const op = this._begin('install', 'Instalando o modelo local');
    const signal = op.controller.signal;
    try {
      const total = asset.size + this.model.size;
      await this._ensureSpace(this.root, total * 1.1);
      rmrf(this.work);
      fs.mkdirSync(this.work, { recursive: true });

      if (!this._runtimeInstalled()) {
        const archive = path.join(this.work, asset.name);
        this._progress({ phase: 'download', message: 'Baixando o servidor do modelo…', percent: 0 });
        await this._fetch({
          url: `${this._githubBase}/ggml-org/llama.cpp/releases/download/${this.release.tag}/${asset.name}`,
          dest: archive, sha256: asset.sha256, size: asset.size, signal,
          onProgress: (p) => this._progress({ phase: 'download', message: 'Baixando o servidor do modelo…', percent: (p.receivedBytes / total) * 100 })
        });
        this._progress({ phase: 'extract', message: 'Extraindo…', percent: (asset.size / total) * 100 });
        const extracted = path.join(this.work, 'files');
        if (/\.(tar\.gz|tgz)$/i.test(archive)) await extractTarball(archive, extracted, { signal });
        else await extractZip(archive, extracted, { signal });
        const exe = walkFiles(extracted).find((f) => path.basename(f) === this._serverFile);
        if (!exe) throw new LlmError('O pacote baixado não é o servidor do modelo. Tente de novo mais tarde.', 'BAD_PACKAGE');
        fs.mkdirSync(this.root, { recursive: true });
        rmrf(this.paths.runtime);
        fs.renameSync(path.dirname(exe), this.paths.runtime);
        if (this._platform !== 'win32') { try { fs.chmodSync(path.join(this.paths.runtime, this._serverFile), 0o755); } catch (_) { /* noop */ } }
      }

      if (!this._modelInstalled()) {
        const part = `${this.paths.model}.part`;
        this._progress({ phase: 'download', message: `Baixando o modelo ${this.model.label}…`, percent: (asset.size / total) * 100 });
        await this._fetch({
          url: `${this._hfBase}/${this.model.repo}/resolve/${this.model.revision}/${this.model.file}`,
          dest: part, sha256: this.model.sha256, size: this.model.size, signal,
          onProgress: (p) => this._progress({ phase: 'download', message: `Baixando o modelo ${this.model.label}…`, percent: ((asset.size + p.receivedBytes) / total) * 100, receivedBytes: p.receivedBytes, totalBytes: this.model.size, speedBps: p.speedBps })
        });
        fs.renameSync(part, this.paths.model);
      }
      this._progress({ phase: 'done', message: 'Modelo local instalado.', percent: 100 });
      return this.getStatus();
    } catch (err) {
      const cancelled = err && (err.code === CANCELLED || err.code === 'CANCELLED' || signal.aborted);
      this._progress({ phase: cancelled ? 'cancelled' : 'error', message: cancelled ? 'Cancelado.' : err.message });
      if (cancelled) throw new LlmError('Instalação cancelada.', 'CANCELLED');
      throw err;
    } finally {
      rmrf(this.work);
      this._end();
    }
  }

  async uninstall() {
    if (this._active) throw new LlmError(`Já existe uma operação em andamento: ${this._active.label}.`, 'BUSY');
    await this.stop();
    rmrf(this.root);
    this.emit('status');
    return this.getStatus();
  }

  // ------------------------------------------------------------------ servidor

  _healthy() {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path: '/health', timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  _touch() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => { this.stop(); }, this.config.idleMs || IDLE_MS);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  /**
   * Garante o servidor ligado (liga se preciso) e devolve quando ele responde. Chamado antes de cada pergunta.
   * @throws {LlmError} NOT_INSTALLED (o usuário precisa instalar), START_FAILED, CANCELLED
   */
  async ensureRunning({ signal = null } = {}) {
    if (!this.isInstalled()) throw new LlmError('O modelo local ainda não foi instalado. Instale em Configurações → Inteligência Artificial.', 'NOT_INSTALLED');
    if (this.isRunning() && (await this._healthy())) { this._touch(); return; }
    if (!this._starting) {
      this._starting = this._start().finally(() => { this._starting = null; });
    }
    await new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' }));
      if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
      this._starting.then(resolve, reject).finally(() => { if (signal) signal.removeEventListener('abort', onAbort); });
    });
    this._touch();
  }

  async _start() {
    // Sobrou um servidor de antes (o app fechou sem desligá-lo): aproveita em vez de brigar pela porta
    if (!this.isRunning() && (await this._healthy())) return;
    const threads = String(Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2))));
    const args = ['-m', this.paths.model, '--host', '127.0.0.1', '--port', String(this.port), '-c', '4096', '--jinja', '-t', threads];
    let child;
    try {
      child = this._spawn(path.join(this.paths.runtime, this._serverFile), args, { cwd: this.paths.runtime, stdio: 'ignore', windowsHide: true });
    } catch (_) {
      throw new LlmError('Não foi possível iniciar o modelo local.', 'START_FAILED');
    }
    this._child = child;
    process.once('exit', () => { try { child.kill(); } catch (_) { /* noop */ } }); // o app fechou: não deixa o servidor órfão
    let exited = false;
    child.on('exit', () => { exited = true; if (this._child === child) this._child = null; this.emit('status'); });
    child.on('error', () => { exited = true; });
    this.emit('status');

    const deadline = Date.now() + (this.config.startTimeoutMs || START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (exited) throw new LlmError('O modelo local fechou ao iniciar. Tente reinstalá-lo em Configurações → Inteligência Artificial.', 'START_FAILED');
      if (await this._healthy()) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    await this.stop();
    throw new LlmError('O modelo local demorou demais para iniciar.', 'START_FAILED');
  }

  async stop() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    const child = this._child;
    this._child = null;
    if (!child) return;
    await new Promise((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      try { child.kill(); } catch (_) { done(); }
      setTimeout(done, 3000).unref();
    });
    this.emit('status');
  }
}

module.exports = { LocalLlm, LlmError, LLAMA_RELEASE, LOCAL_MODEL };
