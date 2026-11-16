'use strict';

/**
 * LocalLlm — modelo de IA PEQUENO que roda dentro do computador, para o assistente funcionar sem internet nem chave.
 *
 * Duas peças, ambas de fontes OFICIAIS e conferidas por SHA-256 (nada é compilado nem vem de build de terceiros):
 *  - o servidor `llama-server` da release oficial do llama.cpp (github.com/ggml-org/llama.cpp), versão FIXADA aqui;
 *  - o modelo (Alibaba Qwen, licença Apache 2.0), em GGUF, do repositório oficial Qwen no Hugging Face, revisão FIXADA aqui:
 *    o Qwen2.5-0.5B (básico, ~490 MB) ou o Qwen3-VL 2B (enxerga imagens, ~1,5 GB), à escolha do usuário.
 *  Em Windows x64 usa o pacote com placa de vídeo (Vulkan) e volta sozinho para a CPU se ele não subir.
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
const { EMBEDDED_PORT, EMBEDDED_CONTEXT } = require('../../services/ai/providers/presets');

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
  },
  // Pacote com placa de vídeo (Vulkan: NVIDIA, AMD e Intel, sem instalar CUDA). Só onde existe pacote oficial; se não subir
  // neste computador, o app volta sozinho para o pacote de CPU acima (ver _start).
  gpu: {
    'win32-x64': { name: 'llama-b12322-bin-win-vulkan-x64.zip', size: 38051872, sha256: 'fea4d6d50357ce8faf15d144bb8f291fc80a42aa0cbafa924e87c8c92ee21417' }
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

/**
 * Modelo com VISÃO (entende imagens: miniaturas de fotos e vídeos) e ferramentas. Repositório OFICIAL da Qwen (Apache 2.0),
 * revisão fixada; dois arquivos: o modelo (Q4_K_M) e o projetor de imagem (mmproj). Tamanhos e SHA-256 conferem com o
 * campo LFS do Hugging Face (copiados de lá em 14/11/2026).
 */
const VISION_REPO = 'Qwen/Qwen3-VL-2B-Instruct-GGUF';
const VISION_REVISION = '52d6c8ffea26cc873ac5ad116f8631268d7eb503';
const VISION_MODEL = {
  id: 'qwen3-vl-2b-instruct',
  label: 'Qwen3-VL 2B Instruct (enxerga imagens)',
  license: 'Apache 2.0',
  vision: true,
  context: 8192,
  files: [
    { role: 'model', repo: VISION_REPO, revision: VISION_REVISION, file: 'Qwen3VL-2B-Instruct-Q4_K_M.gguf', size: 1107409952, sha256: '089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae' },
    { role: 'vision', repo: VISION_REPO, revision: VISION_REVISION, file: 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf', size: 445053216, sha256: 'f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82' }
  ]
};

/** Modelos que o app sabe instalar. O primeiro é o padrão (e o único das instalações antigas: arquivo model.gguf). */
const MODELS = [LOCAL_MODEL, VISION_MODEL];

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
   *           release?:object, model?:object, models?:object[], githubBaseUrl?:string, huggingFaceBaseUrl?:string, idleMs?:number,
   *           startTimeoutMs?:number, downloadAttempts?:number, serverFile?:string } }} opts  (config: testes)
   *   Modelo: { id, label, license, vision?, context?, files?:[{ role:'model'|'vision', repo, revision, file, size, sha256 }] }.
   *   Sem `files` (modelo antigo, arquivo único): { repo, revision, file, size, sha256 }, guardado em model.gguf.
   */
  constructor({ rootDir, tempDir, config = {} }) {
    super();
    if (!rootDir || !tempDir) throw new Error('LocalLlm: rootDir e tempDir são obrigatórios.');
    this.config = config;
    this.root = path.join(rootDir, 'modules', 'llm');
    this.work = path.join(tempDir, 'modules', 'llm');
    this.paths = {
      runtime: path.join(this.root, 'runtime'),        // pacote de CPU (e das instalações antigas)
      runtimeGpu: path.join(this.root, 'runtime-gpu'), // pacote com placa de vídeo (Vulkan), onde existir
      model: path.join(this.root, 'model.gguf'),       // modelo de arquivo único (o padrão antigo)
      models: path.join(this.root, 'models'),          // modelos de vários arquivos: models/<id>/<arquivo>
      choice: path.join(this.root, 'choice.json'),
      runtimeFlag: path.join(this.root, 'runtime.json')
    };
    this.release = config.release || LLAMA_RELEASE;
    this.models = config.model ? [config.model] : (config.models || MODELS);
    this.port = config.port || EMBEDDED_PORT;
    this._platform = config.platform || process.platform;
    this._arch = config.arch || process.arch;
    this._spawn = config.spawn || nodeSpawn;
    this._serverFile = config.serverFile || (this._platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    this._githubBase = (config.githubBaseUrl || 'https://github.com').replace(/\/+$/, '');
    this._hfBase = (config.huggingFaceBaseUrl || 'https://huggingface.co').replace(/\/+$/, '');
    this._active = null;
    this._child = null;
    this._childKind = 'cpu';
    this._childModel = null;
    this._starting = null;
    this._idleTimer = null;
  }

  // ------------------------------------------------------------------ modelos

  _readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

  /** Modelo escolhido (o padrão é o primeiro da lista). */
  get model() {
    const id = (this._readJson(this.paths.choice) || {}).modelId;
    return this.models.find((m) => m.id === id) || this.models[0];
  }

  /** Arquivos do modelo, com o caminho de cada um no disco. */
  _filesOf(m = this.model) {
    if (Array.isArray(m.files)) return m.files.map((f) => ({ ...f, dest: path.join(this.paths.models, m.id, f.file) }));
    return [{ role: 'model', repo: m.repo, revision: m.revision, file: m.file, size: m.size, sha256: m.sha256, dest: this.paths.model }];
  }

  _modelBytes(m = this.model) { return this._filesOf(m).reduce((n, f) => n + f.size, 0); }
  _modelInstalledOf(m = this.model) { return this._filesOf(m).every((f) => fs.existsSync(f.dest)); }
  _modelFile(m = this.model, role = 'model') { const f = this._filesOf(m).find((x) => x.role === role); return f ? f.dest : null; }

  _writeChoice(id) {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.paths.choice, JSON.stringify({ modelId: id }));
  }

  /**
   * Troca o modelo em uso (vale já na próxima pergunta: se o servidor está ligado com outro, desliga). Só aceita modelo já
   * instalado: para um novo, use install({ modelId }), que troca quando a instalação termina.
   */
  async setModel(id) {
    const m = this.models.find((x) => x.id === id);
    if (!m) throw new LlmError('Modelo desconhecido.', 'BAD_MODEL');
    if (this._active) throw new LlmError(`Já existe uma operação em andamento: ${this._active.label}.`, 'BUSY');
    if (!this._modelInstalledOf(m)) throw new LlmError('Esse modelo ainda não foi instalado.', 'NOT_INSTALLED');
    this._writeChoice(m.id);
    if (this.isRunning() && this._childModel !== m.id) await this.stop();
    this.emit('status');
    return this.getStatus();
  }

  /** O modelo em uso, já instalado, enxerga imagens? (a organização por assunto usa isto) */
  supportsVision() { return Boolean(this.model.vision) && this.isInstalled(); }
  baseUrl() { return `http://127.0.0.1:${this.port}/v1`; }

  // ------------------------------------------------------------------ pacote do servidor (CPU e placa de vídeo)

  _key() { return `${this._platform}-${this._arch}`; }
  _cpuAsset() { return this.release.assets[this._key()] || null; }
  _gpuAsset() { return (this.release.gpu && this.release.gpu[this._key()]) || null; }
  _asset() { return this._cpuAsset(); }
  supported() { return Boolean(this._cpuAsset()); }

  _cpuOnly() { return Boolean((this._readJson(this.paths.runtimeFlag) || {}).cpuOnly); }
  _setCpuOnly(on) { try { fs.mkdirSync(this.root, { recursive: true }); fs.writeFileSync(this.paths.runtimeFlag, JSON.stringify({ cpuOnly: on })); } catch (_) { /* só otimização */ } }

  _asKind(kind) { return kind === 'gpu' ? { asset: this._gpuAsset(), dir: this.paths.runtimeGpu } : { asset: this._cpuAsset(), dir: this.paths.runtime }; }
  _runtimeInstalledKind(kind) { return Boolean(this._asKind(kind).asset) && fs.existsSync(path.join(this._asKind(kind).dir, this._serverFile)); }
  /** Pacote que deve estar instalado: placa de vídeo quando existe e não falhou neste computador; senão CPU. */
  _wantedKind() { return this._gpuAsset() && !this._cpuOnly() ? 'gpu' : 'cpu'; }
  /** Pacote que dá para usar agora: o desejado, ou o de CPU (instalações antigas continuam funcionando). */
  _usableKind() {
    const want = this._wantedKind();
    if (this._runtimeInstalledKind(want)) return want;
    return this._runtimeInstalledKind('cpu') ? 'cpu' : null;
  }

  // ------------------------------------------------------------------ estado

  _runtimeInstalled() { return this._usableKind() !== null; }
  _modelInstalled() { return this._modelInstalledOf(); }
  isInstalled() { return this._runtimeInstalled() && this._modelInstalled(); }
  isRunning() { return Boolean(this._child && this._child.exitCode === null && !this._child.killed); }

  getStatus() {
    const supported = this.supported();
    const kind = this._usableKind() || this._wantedKind();
    const current = this.model;
    return {
      supported,
      reason: supported ? '' : `O modelo local ainda não está disponível para este sistema (${this._platform}, ${this._arch}).`,
      installed: this.isInstalled(),
      running: this.isRunning(),
      port: this.port,
      modelId: current.id,
      modelLabel: current.label,
      license: current.license,
      vision: Boolean(current.vision),
      gpu: Boolean(this._gpuAsset()) && kind === 'gpu',
      models: this.models.map((m) => ({ id: m.id, label: m.label, vision: Boolean(m.vision), sizeBytes: this._modelBytes(m), installed: this._modelInstalledOf(m), selected: m.id === current.id })),
      sizeBytes: this._modelBytes() + ((this._asKind(this._wantedKind()).asset || this._cpuAsset() || {}).size || 0),
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

  /** Baixa, confere e instala o pacote do servidor (`kind`: 'cpu' ou 'gpu'). `base` e `total` só servem para a barra de progresso. */
  async _installRuntime(kind, { signal, base = 0, total = 0 }) {
    const { asset, dir } = this._asKind(kind);
    if (!asset) throw new LlmError(this.getStatus().reason, 'PLATFORM');
    const size = total || asset.size;
    const archive = path.join(this.work, asset.name);
    this._progress({ phase: 'download', message: 'Baixando o servidor do modelo…', percent: (base / size) * 100 });
    await this._fetch({
      url: `${this._githubBase}/ggml-org/llama.cpp/releases/download/${this.release.tag}/${asset.name}`,
      dest: archive, sha256: asset.sha256, size: asset.size, signal,
      onProgress: (p) => this._progress({ phase: 'download', message: 'Baixando o servidor do modelo…', percent: ((base + p.receivedBytes) / size) * 100 })
    });
    this._progress({ phase: 'extract', message: 'Extraindo…', percent: ((base + asset.size) / size) * 100 });
    const extracted = path.join(this.work, `files-${kind}`);
    if (/\.(tar\.gz|tgz)$/i.test(archive)) await extractTarball(archive, extracted, { signal });
    else await extractZip(archive, extracted, { signal });
    const exe = walkFiles(extracted).find((f) => path.basename(f) === this._serverFile);
    if (!exe) throw new LlmError('O pacote baixado não é o servidor do modelo. Tente de novo mais tarde.', 'BAD_PACKAGE');
    fs.mkdirSync(this.root, { recursive: true });
    rmrf(dir);
    fs.renameSync(path.dirname(exe), dir);
    if (this._platform !== 'win32') { try { fs.chmodSync(path.join(dir, this._serverFile), 0o755); } catch (_) { /* noop */ } }
  }

  /**
   * Baixa e instala o servidor (llama.cpp) e o modelo escolhido. Idempotente: o que já está instalado e íntegro é mantido.
   * @param {{ modelId?: string }} [opts] modelo a instalar (o padrão é o escolhido); ele passa a ser o escolhido quando termina
   */
  async install({ modelId } = {}) {
    if (!this.supported()) throw new LlmError(this.getStatus().reason, 'PLATFORM');
    const target = modelId ? this.models.find((x) => x.id === modelId) : this.model;
    if (!target) throw new LlmError('Modelo desconhecido.', 'BAD_MODEL');
    const op = this._begin('install', 'Instalando o modelo local');
    const signal = op.controller.signal;
    try {
      const kind = this._wantedKind();
      const runtimeNeeded = !this._runtimeInstalledKind(kind);
      const runtimeBytes = runtimeNeeded ? this._asKind(kind).asset.size : 0;
      const files = this._filesOf(target).filter((f) => !fs.existsSync(f.dest));
      const total = runtimeBytes + files.reduce((n, f) => n + f.size, 0) || 1;
      await this._ensureSpace(this.root, total * 1.1);
      rmrf(this.work);
      fs.mkdirSync(this.work, { recursive: true });

      if (runtimeNeeded) await this._installRuntime(kind, { signal, base: 0, total });

      let done = runtimeBytes;
      for (const f of files) {
        const part = `${f.dest}.part`;
        fs.mkdirSync(path.dirname(f.dest), { recursive: true });
        const label = `Baixando o modelo ${target.label}…`;
        this._progress({ phase: 'download', message: label, percent: (done / total) * 100 });
        await this._fetch({
          url: `${this._hfBase}/${f.repo}/resolve/${f.revision}/${f.file}`,
          dest: part, sha256: f.sha256, size: f.size, signal,
          onProgress: (p) => this._progress({ phase: 'download', message: label, percent: ((done + p.receivedBytes) / total) * 100, receivedBytes: p.receivedBytes, totalBytes: f.size, speedBps: p.speedBps })
        });
        fs.renameSync(part, f.dest);
        done += f.size;
      }
      if (target.id !== this.model.id) {
        this._writeChoice(target.id);
        if (this.isRunning() && this._childModel !== target.id) await this.stop();
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
    if (this.isRunning() && this._childModel !== this.model.id) await this.stop(); // trocou de modelo: religa com o novo
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
    const kind = this._usableKind();
    try {
      await this._launch(kind);
    } catch (err) {
      // A versão para placa de vídeo não subiu neste computador (driver, memória de vídeo...): lembra e usa a de CPU
      if (kind !== 'gpu') throw err;
      await this.stop();
      this._setCpuOnly(true);
      if (!this._runtimeInstalledKind('cpu')) {
        rmrf(this.work);
        fs.mkdirSync(this.work, { recursive: true });
        try { await this._installRuntime('cpu', { signal: null }); } finally { rmrf(this.work); }
      }
      await this._launch('cpu');
    }
  }

  async _launch(kind) {
    const { dir } = this._asKind(kind);
    const m = this.model;
    const threads = String(Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2))));
    // --alias: o servidor anuncia o modelo pelo id (sem ele, /v1/models devolve o CAMINHO do arquivo, com a pasta do usuário)
    const args = ['-m', this._modelFile(m, 'model'), '--alias', m.id, '--host', '127.0.0.1', '--port', String(this.port), '-c', String(m.context || EMBEDDED_CONTEXT), '--jinja', '-t', threads];
    const vision = this._modelFile(m, 'vision');
    if (vision) args.push('--mmproj', vision);
    if (kind === 'gpu') args.push('-ngl', '99');
    let child;
    try {
      child = this._spawn(path.join(dir, this._serverFile), args, { cwd: dir, stdio: 'ignore', windowsHide: true });
    } catch (_) {
      throw new LlmError('Não foi possível iniciar o modelo local.', 'START_FAILED');
    }
    this._child = child;
    this._childKind = kind;
    this._childModel = m.id;
    process.once('exit', () => { try { child.kill(); } catch (_) { /* noop */ } }); // o app fechou: não deixa o servidor órfão
    let exited = false;
    child.on('exit', () => { exited = true; if (this._child === child) this._child = null; this.emit('status'); });
    child.on('error', () => { exited = true; });
    this.emit('status');

    // A placa de vídeo carrega o modelo mais devagar na primeira vez: dá tempo, mas desiste se o processo cair
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

module.exports = { LocalLlm, LlmError, LLAMA_RELEASE, LOCAL_MODEL, VISION_MODEL, MODELS };
