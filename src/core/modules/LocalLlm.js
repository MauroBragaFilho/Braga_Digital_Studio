'use strict';

/**
 * LocalLlm — modelo de IA PEQUENO que roda dentro do computador, para o assistente funcionar sem internet nem chave.
 *
 * Duas peças, ambas de fontes OFICIAIS e conferidas por SHA-256 (nada é compilado nem vem de build de terceiros):
 *  - o servidor `llama-server` da release oficial do llama.cpp (github.com/ggml-org/llama.cpp), versão FIXADA aqui;
 *  - o modelo (Alibaba Qwen, licença Apache 2.0), em GGUF, do repositório oficial Qwen no Hugging Face, revisão FIXADA aqui:
 *    o Qwen2.5-0.5B (básico, ~490 MB, sem imagens) ou o Qwen3-VL de 2B, 4B ou 8B (enxergam imagens, de ~1,5 a ~5,8 GB), à
 *    escolha do usuário; a tela recomenda o maior que cabe inteiro na placa de vídeo (ver llmMemory.js).
 *  Em Windows x64 usa o pacote com placa de vídeo (Vulkan) só até onde há memória LIVRE nela (llmMemory.js). Se ele não sobe,
 *  tenta mais uma vez e depois usa a CPU; a placa fica de molho por um tempo (1 h, 6 h, 24 h) e o app tenta de novo (ver _start).
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
const { spawn: nodeSpawn, execFile } = require('node:child_process');
const { downloadFile, sha256File, CANCELLED } = require('./FileDownloader');
const { extractZip, extractTarball, walkFiles } = require('./ZipExtractor');
const { EMBEDDED_PORT, EMBEDDED_CONTEXT } = require('../../services/ai/providers/presets');
const memory = require('./llmMemory');

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
  license: 'Apache 2.0',
  kvBytesPerToken: 12288 // 2 × 24 camadas × 2 cabeças KV × 64 × 2 bytes (config.json oficial)
};

/**
 * Modelos com VISÃO (entendem imagens: miniaturas de fotos e vídeos) e ferramentas: Qwen3-VL de 2B, 4B e 8B. Repositórios
 * OFICIAIS da Qwen (Apache 2.0), revisão fixada; dois arquivos cada: o modelo (Q4_K_M) e o projetor de imagem (mmproj, Q8_0).
 * Tamanhos e SHA-256 conferem com o campo LFS do Hugging Face (copiados de lá em 14/11/2026 o de 2B e em 15/11/2026 os de 4B e
 * 8B). `kvBytesPerToken` = 2 (K e V) × camadas × cabeças KV × tamanho da cabeça × 2 bytes, do config.json oficial de cada um
 * (usado só para dizer na lista o que cabe na placa de vídeo; quem posiciona as camadas é o servidor).
 */
const VISION_REPO = 'Qwen/Qwen3-VL-2B-Instruct-GGUF';
const VISION_REVISION = '52d6c8ffea26cc873ac5ad116f8631268d7eb503';
const VISION_MODEL = {
  id: 'qwen3-vl-2b-instruct',
  label: 'Qwen3-VL 2B Instruct',
  license: 'Apache 2.0',
  vision: true,
  context: 8192,
  kvBytesPerToken: 114688, // 28 camadas, 8 cabeças KV, cabeça de 128
  files: [
    { role: 'model', repo: VISION_REPO, revision: VISION_REVISION, file: 'Qwen3VL-2B-Instruct-Q4_K_M.gguf', size: 1107409952, sha256: '089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae' },
    { role: 'vision', repo: VISION_REPO, revision: VISION_REVISION, file: 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf', size: 445053216, sha256: 'f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82' }
  ]
};

const VISION_MODEL_4B = {
  id: 'qwen3-vl-4b-instruct',
  label: 'Qwen3-VL 4B Instruct',
  license: 'Apache 2.0',
  vision: true,
  context: 8192,
  kvBytesPerToken: 147456, // 36 camadas, 8 cabeças KV, cabeça de 128
  files: [
    { role: 'model', repo: 'Qwen/Qwen3-VL-4B-Instruct-GGUF', revision: '1cd86afb9a95c410a6038ab3b40d8b578c892266', file: 'Qwen3VL-4B-Instruct-Q4_K_M.gguf', size: 2497281664, sha256: '66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a' },
    { role: 'vision', repo: 'Qwen/Qwen3-VL-4B-Instruct-GGUF', revision: '1cd86afb9a95c410a6038ab3b40d8b578c892266', file: 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf', size: 453974304, sha256: '30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d' }
  ]
};

const VISION_MODEL_8B = {
  id: 'qwen3-vl-8b-instruct',
  label: 'Qwen3-VL 8B Instruct',
  license: 'Apache 2.0',
  vision: true,
  context: 8192,
  kvBytesPerToken: 147456, // 36 camadas, 8 cabeças KV, cabeça de 128
  files: [
    { role: 'model', repo: 'Qwen/Qwen3-VL-8B-Instruct-GGUF', revision: 'f982a07559d4a2f6c8744d840bf6fccab30eea96', file: 'Qwen3VL-8B-Instruct-Q4_K_M.gguf', size: 5027784800, sha256: '67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2' },
    { role: 'vision', repo: 'Qwen/Qwen3-VL-8B-Instruct-GGUF', revision: 'f982a07559d4a2f6c8744d840bf6fccab30eea96', file: 'mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf', size: 752289728, sha256: 'c6ba85508d82f42590e6eb77d5340369ab6fecf107a7561d809523d8aa5f3bfd' }
  ]
};

/** Modelos que o app sabe instalar. O primeiro é o padrão (e o único das instalações antigas: arquivo model.gguf). */
const MODELS = [LOCAL_MODEL, VISION_MODEL, VISION_MODEL_4B, VISION_MODEL_8B];

const IDLE_MS = 10 * 60 * 1000;      // sem uso por 10 min: desliga o servidor e libera a memória
const GPU_CACHE_MS = 15 * 1000;      // a memória livre da placa muda a toda hora: a leitura vale 15 s
const START_TIMEOUT_MS = 120 * 1000; // carregar o modelo na memória
// A placa de vídeo não subiu (nem na segunda tentativa): o app usa a CPU e tenta a placa de novo depois de 1 h; falhando de novo,
// depois de 6 h e depois de 24 h (o driver pode ter sido atualizado, o outro programa fechado). Ligar a placa zera a contagem.
const GPU_RETRY_MS = [60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
const GPU_RETRY_PAUSE_MS = 500; // entre as duas tentativas: a memória de vídeo do servidor que caiu leva um instante para voltar (medido: ~0,3 s)
const gpuRetryWaitMs = (fails) => GPU_RETRY_MS[Math.min(Math.max(Number(fails) || 1, 1), GPU_RETRY_MS.length) - 1];

/** Falha ao ligar o servidor; `reason` diz como foi: 'exited' (o processo caiu), 'timeout' (demorou) ou 'spawn' (nem iniciou). */
const startFailure = (message, reason) => Object.assign(new LlmError(message, 'START_FAILED'), { reason });

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
    this._now = config.now || Date.now; // relógio (testes trocam): a falha da placa de vídeo vale até uma hora marcada
    this._serverFile = config.serverFile || (this._platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    this._githubBase = (config.githubBaseUrl || 'https://github.com').replace(/\/+$/, '');
    this._hfBase = (config.huggingFaceBaseUrl || 'https://huggingface.co').replace(/\/+$/, '');
    this._active = null;
    this._child = null;
    this._childKind = 'cpu';
    this._childModel = null;
    this._starting = null;
    this._idleTimer = null;
    this._gpuCache = null;   // última leitura da placa de vídeo: { at, value:{ gpu, integratedOnly, safetyMB } }
    this._gpuPending = null;
    this._plan = null;       // como o servidor em uso foi posicionado na placa: { mode, gpuPercent, args }
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

  // Falha da placa de vídeo ao ligar, em runtime.json: { cpuOnly: true, failedAt, fails, modelId }. Não é mais uma marca para
  // sempre: vale até a hora de tentar de novo (GPU_RETRY_MS) e só para o modelo que falhou. `cpuOnly` fica no arquivo para as
  // versões antigas continuarem lendo.

  /** Hora (ms) em que o app volta a tentar a placa de vídeo com o modelo em uso; null = a placa não está de molho. */
  _gpuRetryAt() {
    const f = this._readJson(this.paths.runtimeFlag) || {};
    if (!f.cpuOnly) return null;
    if (f.modelId && f.modelId !== this.model.id) return null; // a falha foi com outro modelo: com este ainda não se sabe
    const failedAt = Number(f.failedAt);
    if (!Number.isFinite(failedAt)) return null;               // marca da versão antiga (valia para sempre): tenta de novo
    const retryAt = failedAt + gpuRetryWaitMs(f.fails);
    const now = this._now();
    return now >= failedAt && now < retryAt ? retryAt : null;  // data no futuro (o relógio foi mudado): tenta de novo
  }
  _cpuOnly() { return this._gpuRetryAt() !== null; }

  /** A placa de vídeo não subiu com este modelo: anota quando e quantas vezes seguidas (a espera cresce a cada uma). */
  _markGpuFailed(modelId) {
    const prev = this._readJson(this.paths.runtimeFlag) || {};
    const fails = prev.cpuOnly && prev.modelId === modelId ? Math.min((Number(prev.fails) || 1) + 1, 99) : 1;
    try {
      fs.mkdirSync(this.root, { recursive: true });
      fs.writeFileSync(this.paths.runtimeFlag, JSON.stringify({ cpuOnly: true, failedAt: this._now(), fails, modelId }));
    } catch (_) { /* só otimização */ }
  }

  /** A placa de vídeo ligou com este modelo: esquece a falha anotada (a próxima começa de novo na espera de 1 h). */
  _clearGpuFailure(modelId) {
    const f = this._readJson(this.paths.runtimeFlag);
    if (!f || !f.cpuOnly || (f.modelId && f.modelId !== modelId)) return;
    try { fs.rmSync(this.paths.runtimeFlag, { force: true }); } catch (_) { /* noop */ }
  }

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
    const view = this._memoryView();
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
      gpuRetryAt: this._gpuRetryAt(), // a placa de vídeo não ligou: o app usa a CPU até esta hora (ms) e então tenta de novo; null = sem falha
      // memória da placa de vídeo (null onde não há pacote com placa); `fit` diz como cada modelo se sai nela AGORA
      memory: view.memory,
      recommendedId: view.recommendedId,
      plan: this.isRunning() && this._plan ? { mode: this._plan.mode, gpuPercent: this._plan.gpuPercent } : null,
      models: this.models.map((m) => ({ id: m.id, label: m.label, vision: Boolean(m.vision), sizeBytes: this._modelBytes(m), installed: this._modelInstalledOf(m), selected: m.id === current.id, fit: view.fits[m.id] || null })),
      sizeBytes: this._modelBytes() + ((this._asKind(this._wantedKind()).asset || this._cpuAsset() || {}).size || 0),
      busy: this._active ? this._active.label : null
    };
  }

  // ------------------------------------------------------------------ memória da placa de vídeo (ver llmMemory.js)

  /** O que o modelo pede na placa no contexto dele: pesos + projetor de imagem + cache do contexto + buffers. */
  _estimateFor(m) {
    const files = this._filesOf(m);
    const bytesOf = (role) => files.filter((f) => f.role === role).reduce((n, f) => n + f.size, 0);
    return memory.estimateMB({
      weightsBytes: bytesOf('model'), projectorBytes: bytesOf('vision'),
      kvBytesPerToken: m.kvBytesPerToken || undefined, ctx: m.context || EMBEDDED_CONTEXT
    });
  }

  /** A placa, o que cabe nela e o modelo recomendado, pela última leitura (não espera nada: `probeGpu` atualiza a leitura). */
  _memoryView() {
    if (!this._gpuAsset()) return { memory: null, fits: {}, recommendedId: '' };
    const probe = this._gpuCache ? this._gpuCache.value : null;
    if (!probe) return { memory: { checked: false, gpu: null, integratedOnly: false, safetyMB: memory.MIN_SAFETY_MB }, fits: {}, recommendedId: '' };
    const fits = {};
    const entries = [];
    for (const m of this.models) {
      const est = this._estimateFor(m);
      const fit = memory.fitFor(est, probe.gpu, probe.safetyMB);
      fits[m.id] = fit;
      entries.push({ id: m.id, vision: Boolean(m.vision), weightsMB: est.weightsMB, fit });
    }
    const g = probe.gpu;
    return {
      memory: {
        checked: true,
        gpu: g ? { name: g.name, totalMB: g.totalMB, freeMB: g.freeMB, source: g.source } : null,
        integratedOnly: Boolean(probe.integratedOnly),
        safetyMB: probe.safetyMB
      },
      fits,
      recommendedId: memory.recommendId(entries)
    };
  }

  /** Lê a placa de vídeo (nome, memória total e LIVRE de verdade) no nvidia-smi e no servidor (`--list-devices`). */
  async _readGpu() {
    const run = (file, args, ms) => new Promise((resolve) => {
      try {
        execFile(file, args, { timeout: ms, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => resolve(`${stdout || ''}\n${stderr || ''}`));
      } catch (_) { resolve(''); }
    });
    const server = this._runtimeInstalledKind('gpu') ? path.join(this._asKind('gpu').dir, this._serverFile) : null;
    const [vk, smi] = await Promise.all([
      server ? run(server, ['--list-devices'], 8000) : '',
      run('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], 4000)
    ]);
    return { vulkan: memory.parseListDevices(vk), nvidia: memory.parseNvidiaSmi(smi) };
  }

  /**
   * Lê a placa de vídeo e guarda a leitura por 15 s. Devolve a leitura de agora, ou a anterior se a nova demorar mais que
   * `timeoutMs`. Com o servidor ligado na placa, a leitura de agora inclui a memória dele: vale a de antes de ligar.
   * Nos testes (`config.spawn` trocado) não roda programa nenhum: `config.readGpu` entrega a leitura.
   */
  async probeGpu({ force = false, timeoutMs = 3000 } = {}) {
    if (!this._gpuAsset()) return null;
    const cached = this._gpuCache ? this._gpuCache.value : null;
    const fresh = this._gpuCache && Date.now() - this._gpuCache.at < GPU_CACHE_MS;
    if (cached && ((fresh && !force) || (this.isRunning() && this._childKind === 'gpu'))) return cached;
    if (!this._gpuPending) {
      const read = this.config.readGpu || (this.config.spawn ? async () => ({ vulkan: [], nvidia: [] }) : () => this._readGpu());
      this._gpuPending = Promise.resolve().then(read).then((raw) => {
        const gpu = memory.pickGpu(raw || {});
        const integratedOnly = !gpu && ((raw && raw.vulkan) || []).some((d) => memory.isIntegratedGpu(d.name));
        const value = { gpu, integratedOnly, safetyMB: memory.safetyFor(gpu ? gpu.totalMB : 0) };
        this._gpuCache = { at: Date.now(), value };
        return value;
      }).catch(() => cached).finally(() => { this._gpuPending = null; });
    }
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(cached), timeoutMs); if (timer.unref) timer.unref(); });
    try { return await Promise.race([this._gpuPending, late]); } finally { clearTimeout(timer); }
  }

  /** Argumentos de memória do servidor para ESTE modelo e a memória livre de agora; null = sem leitura (tudo na placa, como antes). */
  async _planMemory(m) {
    let probe = null;
    try { probe = await this.probeGpu({ force: true, timeoutMs: 8000 }); } catch (_) { probe = null; }
    if (!probe || !probe.gpu) return null;
    return memory.planLaunch({ gpu: probe.gpu, est: this._estimateFor(m), safetyMB: probe.safetyMB });
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

  /** true se o servidor da porta anuncia o modelo `id` em /v1/models (o app sobe com --alias = id). */
  _servesModel(id) {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path: '/v1/models', timeout: 1500 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 65536) body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const list = Array.isArray(data && data.data) ? data.data : [];
            resolve(res.statusCode === 200 && list.some((m) => m && m.id === id));
          } catch (_) { resolve(false); }
        });
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
    // Só aproveita se for o llama-server do app com ESTE modelo (o --alias faz /v1/models anunciar o id); outro programa
    // na porta ou outro modelo não é reaproveitado (a subida abaixo falha com erro claro se a porta estiver ocupada).
    if (!this.isRunning() && (await this._healthy()) && (await this._servesModel(this.model.id))) return;
    const kind = this._usableKind();
    if (kind !== 'gpu') { await this._launch(kind); return; }
    const modelId = this.model.id;
    // Se o servidor CAIU ao subir (e não só demorou), tenta mais uma vez, com leitura nova da placa: o motivo mais comum é outro
    // programa ter tomado a memória de vídeo entre a leitura e a subida, e a segunda tentativa já enxerga isso.
    let failure = await this._tryLaunch('gpu');
    if (failure && failure.reason === 'exited') {
      await new Promise((resolve) => setTimeout(resolve, this.config.retryPauseMs ?? GPU_RETRY_PAUSE_MS));
      failure = await this._tryLaunch('gpu');
    }
    if (!failure) { this._clearGpuFailure(modelId); return; }
    // A placa de vídeo não sobe agora (driver, memória de vídeo...): usa a CPU e só tenta a placa de novo na hora marcada (ver
    // _gpuRetryAt). A falha é anotada DEPOIS de a CPU subir: se ela também falhar (sem internet para baixar o pacote, por
    // exemplo), nada fica marcado e a próxima pergunta tenta a placa de novo.
    if (!this._runtimeInstalledKind('cpu')) {
      rmrf(this.work);
      fs.mkdirSync(this.work, { recursive: true });
      try { await this._installRuntime('cpu', { signal: null }); } finally { rmrf(this.work); }
    }
    await this._launch('cpu');
    this._markGpuFailed(modelId);
  }

  /** Liga o servidor do pacote `kind`: devolve null se subiu, ou o erro da falha (com o servidor já desligado). */
  async _tryLaunch(kind) {
    try { await this._launch(kind); return null; } catch (err) { await this.stop(); return err; }
  }

  async _launch(kind) {
    const { dir } = this._asKind(kind);
    const m = this.model;
    const threads = String(Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2))));
    // --alias: o servidor anuncia o modelo pelo id (sem ele, /v1/models devolve o CAMINHO do arquivo, com a pasta do usuário)
    const args = ['-m', this._modelFile(m, 'model'), '--alias', m.id, '--host', '127.0.0.1', '--port', String(this.port), '-c', String(m.context || EMBEDDED_CONTEXT), '--jinja', '-t', threads];
    const vision = this._modelFile(m, 'vision');
    if (vision) args.push('--mmproj', vision);
    // Placa de vídeo: só até onde há memória LIVRE (llmMemory.js). Sem leitura da placa, tudo nela, como antes.
    this._plan = null;
    if (kind === 'gpu') {
      this._plan = await this._planMemory(m);
      args.push(...(this._plan ? this._plan.args : ['-ngl', '99']));
    }
    let child;
    try {
      child = this._spawn(path.join(dir, this._serverFile), args, { cwd: dir, stdio: 'ignore', windowsHide: true });
    } catch (_) {
      throw startFailure('Não foi possível iniciar o modelo local.', 'spawn');
    }
    this._child = child;
    this._childKind = kind;
    this._childModel = m.id;
    const killOnExit = () => { try { child.kill(); } catch (_) { /* noop */ } };
    process.once('exit', killOnExit); // o app fechou: não deixa o servidor órfão
    let exited = false;
    child.on('exit', () => { exited = true; process.removeListener('exit', killOnExit); if (this._child === child) this._child = null; this.emit('status'); });
    child.on('error', () => { exited = true; process.removeListener('exit', killOnExit); });
    this.emit('status');

    // A placa de vídeo carrega o modelo mais devagar na primeira vez: dá tempo, mas desiste se o processo cair
    const deadline = Date.now() + (this.config.startTimeoutMs || START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (exited) throw startFailure('O modelo local fechou ao iniciar. Tente reinstalá-lo em Configurações → Inteligência Artificial.', 'exited');
      if (await this._healthy()) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    await this.stop();
    throw startFailure('O modelo local demorou demais para iniciar.', 'timeout');
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

module.exports = { LocalLlm, LlmError, LLAMA_RELEASE, LOCAL_MODEL, VISION_MODEL, VISION_MODEL_4B, VISION_MODEL_8B, MODELS };
