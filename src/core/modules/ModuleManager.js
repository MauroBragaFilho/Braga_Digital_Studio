'use strict';

/**
 * ModuleManager — módulos opcionais do BDS (hoje: Whisper, para legendas e transcrição).
 *
 * Nada é obrigatório: o BDS funciona sem nenhum módulo, e cada parte é instalada só quando o
 * usuário pede, direto da fonte oficial:
 *   - Motor      : whisper.cpp (release oficial no GitHub, versão e SHA-256 fixados), versão para CPU (~8 MB).
 *   - Modelos    : Hugging Face, ggerganov/whisper.cpp (escolha do usuário; tamanho e SHA-256 vêm da fonte).
 *   - GPU NVIDIA : o mesmo whisper.cpp compilado para CUDA (~640 MB, já com as bibliotecas da NVIDIA);
 *                  exige aceitar a licença da NVIDIA. Sem ele tudo funciona na CPU, só que mais devagar.
 *
 * Layout em disco (<dataDir>/modules):
 *   modules.json                  estado (versões, modelo ativo, datas)
 *   whisper/engine/               motor para CPU (whisper-cli.exe + DLLs)
 *   whisper/cuda/                 motor para NVIDIA (whisper-cli.exe + ggml-cuda.dll + bibliotecas CUDA)
 *   whisper/models/<id>/model.bin um modelo ggml por pasta
 *   whisper/work/                 arquivos temporários de cada transcrição (apagados ao terminar)
 *
 * Eventos: 'progress' { opId, kind, phase, label, percent, receivedBytes, totalBytes, speedBps, message }
 *          'status'   (o estado mudou; a interface deve consultar getStatus())
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { downloadFile, fetchJson, sha256File, CANCELLED } = require('./FileDownloader');
const { extractZip, walkFiles } = require('./ZipExtractor');
const { WhisperCppSource, HuggingFaceSource, ENGINE_FILES, CUDA_LICENSE_LINKS } = require('./sources');
const { WHISPER_MODELS, DEFAULT_MODEL_ID, REFERENCE_NOTE, getModel } = require('./WhisperCatalog');
const { WhisperCppRunner } = require('./WhisperCppRunner');

const MODULE_API_VERSION = 2;

class ModuleError extends Error {
  constructor(message, code) { super(message); this.name = 'ModuleError'; this.code = code; }
}

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { /* noop */ } };

class ModuleManager extends EventEmitter {
  /**
   * @param {{rootDir:string, tempDir:string, config?:object, getJson?:Function}} opts
   *   config: { huggingFaceBaseUrl, githubBaseUrl, release, ffmpegPath (texto ou função), platform,
   *             cliCommand, cliBaseArgs, ffmpegBaseArgs, downloadAttempts (os quatro últimos, para testes) }
   */
  constructor({ rootDir, tempDir, config = {}, getJson = fetchJson }) {
    super();
    if (!rootDir || !tempDir) throw new Error('ModuleManager: rootDir e tempDir são obrigatórios.');
    this.config = config;
    this.root = path.join(rootDir, 'modules');
    this.tempDir = path.join(tempDir, 'modules');
    this.paths = {
      state: path.join(this.root, 'modules.json'),
      engine: path.join(this.root, 'whisper', 'engine'),
      models: path.join(this.root, 'whisper', 'models'),
      cuda: path.join(this.root, 'whisper', 'cuda'),
      work: path.join(this.root, 'whisper', 'work')
    };
    this._getJson = getJson;
    this.hf = new HuggingFaceSource({ baseUrl: config.huggingFaceBaseUrl, getJson });
    this.cpp = new WhisperCppSource({ baseUrl: config.githubBaseUrl, release: config.release });
    this._active = null;
    this._platform = config.platform || process.platform;
  }

  // ------------------------------------------------------------------ estado em disco

  _readState() {
    try { return JSON.parse(fs.readFileSync(this.paths.state, 'utf8')); } catch (_) { return { version: 1, whisper: {} }; }
  }

  _writeState(state) {
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = `${this.paths.state}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, this.paths.state);
  }

  _patchWhisper(fn) {
    const state = this._readState();
    state.whisper = state.whisper || {};
    fn(state.whisper);
    this._writeState(state);
  }

  _engineInstalled() { return fs.existsSync(path.join(this.paths.engine, ENGINE_FILES.cli)); }

  _cudaInstalled() {
    return fs.existsSync(path.join(this.paths.cuda, ENGINE_FILES.cli)) && fs.existsSync(path.join(this.paths.cuda, ENGINE_FILES.cuda));
  }

  _modelDir(id) { return path.join(this.paths.models, id); }

  _modelInstalled(id) { return fs.existsSync(path.join(this._modelDir(id), 'model.bin')); }

  _activeModelId() {
    const saved = this._readState().whisper.activeModel;
    if (saved && getModel(saved) && this._modelInstalled(saved)) return saved;
    if (this._modelInstalled(DEFAULT_MODEL_ID)) return DEFAULT_MODEL_ID; // o recomendado vem antes do primeiro da lista
    const first = WHISPER_MODELS.find((m) => this._modelInstalled(m.id));
    return first ? first.id : null;
  }

  _ffmpegPath() {
    const f = this.config.ffmpegPath;
    try { return (typeof f === 'function' ? f() : f) || null; } catch (_) { return null; }
  }

  // ------------------------------------------------------------------ consulta

  async getStatus() {
    const state = this._readState().whisper || {};
    const installedModels = state.models || {};
    const activeId = this._activeModelId();
    const engineOk = this._engineInstalled();
    const cudaOk = this._cudaInstalled();
    const cudaAsset = this.cpp.asset('cuda');

    let freeBytes = null;
    try {
      fs.mkdirSync(this.root, { recursive: true });
      const s = await fs.promises.statfs(this.root);
      freeBytes = s.bavail * s.bsize;
    } catch (_) { /* indisponível */ }

    return {
      apiVersion: MODULE_API_VERSION,
      platformSupported: this._platform === 'win32',
      engineDownload: true, // o motor é baixado da release oficial (também dá para instalar de um .zip)
      busy: this._active ? { opId: this._active.opId, kind: this._active.kind, label: this._active.label } : null,
      disk: { freeBytes },
      whisper: {
        id: 'whisper',
        name: 'Transcrição',
        description: 'Gera legendas (.srt) e transcrições com tempo (.md) de vídeos e áudios, em português e outros idiomas. O reconhecimento roda no seu computador: o áudio não é enviado para a internet.',
        engine: {
          installed: engineOk,
          version: engineOk ? (state.engine || {}).version || null : null,
          source: engineOk ? (state.engine || {}).source || null : null,
          installedAt: engineOk ? (state.engine || {}).installedAt || null : null,
          downloadBytes: this.cpp.asset('cpu').size
        },
        models: WHISPER_MODELS.map((m) => {
          const installed = this._modelInstalled(m.id);
          return {
            id: m.id, label: m.label, description: m.description, sizeBytes: m.sizeBytes,
            speed: m.speed, speedLevel: m.speedLevel, quality: m.quality, vramGb: m.vramGb,
            recommendedFor: m.recommendedFor || null,
            installed, active: installed && m.id === activeId,
            sizeOnDisk: installed ? this._sizeOnDisk(m.id, installedModels) : 0
          };
        }),
        referenceNote: REFERENCE_NOTE,
        defaultModelId: DEFAULT_MODEL_ID,
        activeModelId: activeId,
        cuda: {
          installed: cudaOk,
          versions: cudaOk ? (state.cuda || {}).versions || null : null,
          approxDownloadBytes: cudaAsset.size,
          licenseLinks: CUDA_LICENSE_LINKS,
          requirement: 'Exige uma placa de vídeo NVIDIA com driver atualizado (versão 551 ou mais nova). Sem a aceleração, a transcrição funciona normalmente na CPU, só que bem mais devagar.'
        },
        ready: engineOk && Boolean(activeId)
      }
    };
  }

  _sizeOnDisk(id, installedModels) {
    try { return fs.statSync(path.join(this._modelDir(id), 'model.bin')).size; } catch (_) { /* usa a estimativa */ }
    return (installedModels[id] || {}).sizeBytes || (getModel(id) || {}).sizeBytes || 0;
  }

  // ------------------------------------------------------------------ operações

  _begin(kind, label) {
    if (this._active) {
      throw new ModuleError(`Já existe uma operação em andamento: ${this._active.label}. Aguarde ou cancele.`, 'BUSY');
    }
    const controller = new AbortController();
    this._active = { opId: `${kind}-${Date.now()}`, kind, label, controller };
    this.emit('status');
    return this._active;
  }

  _end() {
    this._active = null;
    this.emit('status');
  }

  cancel() {
    if (!this._active) return false;
    this._active.controller.abort();
    return true;
  }

  _progress(op, patch) {
    this.emit('progress', { opId: op.opId, kind: op.kind, label: op.label, percent: null, ...patch });
  }

  async _run(kind, label, fn) {
    const op = this._begin(kind, label);
    try {
      const result = await fn(op);
      this._progress(op, { phase: 'done', percent: 100, message: 'Concluído.' });
      return result;
    } catch (err) {
      const cancelled = err && (err.code === CANCELLED || err.code === 'CANCELLED' || op.controller.signal.aborted);
      this._progress(op, { phase: cancelled ? 'cancelled' : 'error', message: cancelled ? 'Cancelado.' : err.message });
      if (cancelled) { const e = new ModuleError('Operação cancelada.', 'CANCELLED'); throw e; }
      throw err;
    } finally {
      this._end();
    }
  }

  async _ensureSpace(dir, needBytes) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const s = await fs.promises.statfs(dir);
      const free = s.bavail * s.bsize;
      if (free < needBytes) {
        throw new ModuleError(`Espaço em disco insuficiente: são necessários cerca de ${fmtBytes(needBytes)} e há ${fmtBytes(free)} livres.`, 'DISK');
      }
    } catch (err) {
      if (err instanceof ModuleError) throw err;
      /* statfs indisponível: segue sem a checagem */
    }
  }

  _requireWindows() {
    if (this._platform !== 'win32') throw new ModuleError('Este módulo está disponível apenas no Windows nesta versão.', 'PLATFORM');
  }

  /** Baixa um arquivo, aproveitando um download já concluído e íntegro. */
  async _fetchVerified({ url, dest, sha256, size, onProgress, signal }) {
    if (fs.existsSync(dest) && (!size || fs.statSync(dest).size === size)) {
      if (!sha256 || (await sha256File(dest, signal)).toLowerCase() === sha256.toLowerCase()) return { path: dest, size: fs.statSync(dest).size };
      rmrf(dest);
    }
    return downloadFile({
      url, dest, expectedSha256: sha256 || null, expectedSize: size || null, onProgress, signal,
      ...(this.config.downloadAttempts ? { attempts: this.config.downloadAttempts, backoffMs: 1 } : {}) // (testes: sem esperar entre tentativas)
    });
  }

  /**
   * Extrai um pacote do motor (.zip) e o coloca em `targetDir` de forma atômica (com desfazer se falhar).
   * O pacote pode ter o programa na raiz ou dentro de uma única pasta ("Release/").
   */
  async _placeEnginePackage({ archive, work, targetDir, requiredFiles, signal, op, label }) {
    this._progress(op, { phase: 'extract', message: `Extraindo ${label}…` });
    const extracted = path.join(work, 'files');
    await extractZip(archive, extracted, { signal });

    const cli = walkFiles(extracted).find((f) => path.basename(f).toLowerCase() === ENGINE_FILES.cli);
    if (!cli) throw new ModuleError(`O pacote não contém ${ENGINE_FILES.cli}.`, 'BAD_ZIP');
    const source = path.dirname(cli);
    for (const f of requiredFiles) {
      if (!fs.existsSync(path.join(source, f))) throw new ModuleError(`O pacote está incompleto (falta ${f}).`, 'BAD_ZIP');
    }

    this._progress(op, { phase: 'install', message: 'Instalando…' });
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    const backup = `${targetDir}.old`;
    rmrf(backup);
    if (fs.existsSync(targetDir)) fs.renameSync(targetDir, backup);
    try {
      fs.renameSync(source, targetDir);
    } catch (err) {
      if (fs.existsSync(backup)) fs.renameSync(backup, targetDir); // desfaz
      throw err;
    }
    rmrf(backup);
  }

  // ------------------------------------------------------------------ motor (CPU)

  /**
   * Instala o motor do Whisper (whisper.cpp para CPU).
   * @param {{zipPath?:string}} [opts]  Sem zipPath, baixa a release oficial; com zipPath, instala de um .zip local.
   */
  async installEngine({ zipPath = null } = {}) {
    this._requireWindows();
    return this._run('engine', 'Instalando o motor de transcrição', async (op) => {
      const signal = op.controller.signal;
      fs.mkdirSync(this.tempDir, { recursive: true });
      const work = path.join(this.tempDir, `engine_${Date.now()}`);
      let archive = zipPath;
      let meta;
      try {
        if (zipPath) {
          if (!/\.zip$/i.test(zipPath) || !fs.existsSync(zipPath)) throw new ModuleError('Selecione um arquivo .zip válido do motor.', 'BAD_ZIP');
          meta = { version: null, source: 'zip' };
        } else {
          const asset = this.cpp.asset('cpu');
          await this._ensureSpace(this.root, asset.size * 4);
          archive = path.join(work, asset.name);
          this._progress(op, { phase: 'download', message: 'Baixando o motor…' });
          await this._fetchVerified({
            url: asset.url, dest: archive, sha256: asset.sha256, size: asset.size, signal,
            onProgress: (p) => this._progress(op, { phase: 'download', message: 'Baixando o motor…', ...p })
          });
          meta = { version: asset.tag, source: 'github' };
        }
        await this._placeEnginePackage({ archive, work, targetDir: this.paths.engine, requiredFiles: [], signal, op, label: 'o motor' });
        this._patchWhisper((w) => { w.engine = { ...meta, installedAt: new Date().toISOString() }; });
      } finally {
        rmrf(work);
      }
      return this.getStatus();
    });
  }

  async uninstallEngine() {
    return this._run('engine', 'Removendo o motor de transcrição', async () => {
      rmrf(this.paths.engine);
      this._patchWhisper((w) => { delete w.engine; });
      return this.getStatus();
    });
  }

  // ------------------------------------------------------------------ modelos

  async installModel(modelId) {
    const model = getModel(modelId);
    if (!model) throw new ModuleError('Modelo desconhecido.', 'BAD_MODEL');
    return this._run('model', `Baixando o modelo ${model.label}`, async (op) => {
      const signal = op.controller.signal;
      this._progress(op, { phase: 'prepare', message: 'Consultando o Hugging Face…' });
      const info = await this.hf.getModelFile(model.repo, model.file);
      const totalBytes = info.file.size;
      await this._ensureSpace(this.paths.models, totalBytes * 1.05);

      const partial = path.join(this.paths.models, `${modelId}.partial`);
      rmrf(partial);
      fs.mkdirSync(partial, { recursive: true });

      this._progress(op, { phase: 'download', message: `Baixando ${model.label}…`, receivedBytes: 0, totalBytes, percent: 0 });
      await this._fetchVerified({
        url: this.hf.fileUrl(info.repoId, info.revision, info.file.path),
        dest: path.join(partial, 'model.bin'), sha256: info.file.sha256, size: info.file.size || null, signal,
        onProgress: (p) => this._progress(op, { phase: 'download', message: `Baixando ${model.label}…`, receivedBytes: p.receivedBytes, totalBytes, percent: totalBytes ? (p.receivedBytes / totalBytes) * 100 : null, speedBps: p.speedBps })
      });

      this._progress(op, { phase: 'install', message: 'Finalizando…', percent: 100 });
      // O modelo ativo só muda sozinho se ainda não houver nenhum utilizável.
      const hadActive = this._activeModelId() !== null;
      const finalDir = this._modelDir(modelId);
      rmrf(finalDir);
      fs.renameSync(partial, finalDir);

      this._patchWhisper((w) => {
        w.models = w.models || {};
        w.models[modelId] = { installedAt: new Date().toISOString(), sizeBytes: totalBytes, repo: info.repoId, revision: info.revision, file: info.file.path };
        if (!hadActive) w.activeModel = modelId;
      });
      return this.getStatus();
    });
  }

  async removeModel(modelId) {
    if (!getModel(modelId)) throw new ModuleError('Modelo desconhecido.', 'BAD_MODEL');
    return this._run('model', 'Removendo modelo', async () => {
      rmrf(this._modelDir(modelId));
      rmrf(path.join(this.paths.models, `${modelId}.partial`));
      // Se era o ativo, o próximo modelo instalado assume (e isso fica gravado).
      const next = WHISPER_MODELS.find((m) => m.id !== modelId && this._modelInstalled(m.id));
      this._patchWhisper((w) => {
        if (w.models) delete w.models[modelId];
        if (w.activeModel === modelId || !w.activeModel) {
          if (next) w.activeModel = next.id; else delete w.activeModel;
        }
      });
      return this.getStatus();
    });
  }

  async setActiveModel(modelId) {
    if (!getModel(modelId)) throw new ModuleError('Modelo desconhecido.', 'BAD_MODEL');
    if (!this._modelInstalled(modelId)) throw new ModuleError('Esse modelo ainda não foi baixado.', 'NOT_INSTALLED');
    this._patchWhisper((w) => { w.activeModel = modelId; });
    this.emit('status');
    return this.getStatus();
  }

  // ------------------------------------------------------------------ GPU (NVIDIA / CUDA)

  /**
   * Baixa o whisper.cpp para placas NVIDIA (já com as bibliotecas CUDA da NVIDIA).
   * Exige o motor instalado e que o usuário aceite a licença da NVIDIA.
   */
  async installCuda({ acceptLicense = false } = {}) {
    this._requireWindows();
    if (acceptLicense !== true) {
      throw new ModuleError('É preciso aceitar os termos de licença da NVIDIA (CUDA) para baixar as bibliotecas.', 'LICENSE');
    }
    if (!this._engineInstalled()) throw new ModuleError('Instale o motor de transcrição primeiro.', 'NO_ENGINE');
    return this._run('cuda', 'Baixando a aceleração NVIDIA (CUDA)', async (op) => {
      const signal = op.controller.signal;
      const asset = this.cpp.asset('cuda');
      await this._ensureSpace(this.root, asset.size * 2.4); // zip + arquivos extraídos

      fs.mkdirSync(this.tempDir, { recursive: true });
      const work = path.join(this.tempDir, `cuda_${Date.now()}`);
      try {
        const archive = path.join(work, asset.name);
        this._progress(op, { phase: 'download', message: `Baixando ${asset.label}…`, receivedBytes: 0, totalBytes: asset.size, percent: 0 });
        await this._fetchVerified({
          url: asset.url, dest: archive, sha256: asset.sha256, size: asset.size, signal,
          onProgress: (p) => this._progress(op, { phase: 'download', message: `Baixando ${asset.label}…`, ...p })
        });
        await this._placeEnginePackage({
          archive, work, targetDir: this.paths.cuda, requiredFiles: [ENGINE_FILES.cuda], signal, op, label: 'a aceleração NVIDIA'
        });
        this._patchWhisper((w) => {
          w.cuda = { installedAt: new Date().toISOString(), versions: { whispercpp: asset.tag, cuda: asset.cudaVersion } };
        });
      } finally {
        rmrf(work);
      }
      return this.getStatus();
    });
  }

  async removeCuda() {
    return this._run('cuda', 'Removendo a aceleração NVIDIA', async () => {
      rmrf(this.paths.cuda);
      rmrf(`${this.paths.cuda}.old`);
      this._patchWhisper((w) => { delete w.cuda; });
      return this.getStatus();
    });
  }

  // ------------------------------------------------------------------ transcrição

  /**
   * Gera legendas/transcrição com o modelo ativo. Usa a GPU se a aceleração NVIDIA estiver instalada
   * (e volta para a CPU sozinho se a placa falhar).
   * @param {{files:string[], srt?:boolean, md?:boolean, maxWords?:number, lines?:1|2, outDir?:string, forceCpu?:boolean}} options
   */
  async transcribe(options) {
    this._requireWindows();
    const custom = Boolean(this.config.cliCommand);
    if (!custom && !this._engineInstalled() && !this._cudaInstalled()) throw new ModuleError('Instale o motor de transcrição primeiro.', 'NO_ENGINE');
    const modelId = this._activeModelId();
    if (!modelId) throw new ModuleError('Baixe e escolha um modelo antes de transcrever.', 'NO_MODEL');

    return this._run('transcribe', 'Gerando legendas/transcrição', async (op) => {
      const runner = new WhisperCppRunner({
        engineDir: this.paths.engine,
        cudaDir: this._cudaInstalled() ? this.paths.cuda : null,
        tempDir: this.tempDir,
        workRoot: this.paths.work,
        ffmpegPath: this._ffmpegPath(),
        cliCommand: this.config.cliCommand || null,
        cliBaseArgs: this.config.cliBaseArgs || [],
        ffmpegBaseArgs: this.config.ffmpegBaseArgs || []
      });
      const result = await runner.run(options, {
        modelDir: this._modelDir(modelId),
        modelId,
        modelName: modelId,
        signal: op.controller.signal,
        onEvent: (ev) => {
          if (ev.type === 'progress') this._progress(op, { phase: 'transcribe', message: 'Transcrevendo…', percent: ev.percent });
          else if (ev.type === 'status') this._progress(op, { phase: 'transcribe', message: ev.text });
          else if (ev.type === 'device') this._progress(op, { phase: 'transcribe', message: `Dispositivo: ${ev.text}`, device: ev.text });
          else if (ev.type === 'file') this._progress(op, { phase: 'transcribe', file: { index: ev.index, state: ev.state, percent: ev.percent ?? null, message: ev.text || null } });
          else if (ev.type === 'line' || ev.type === 'error') this._progress(op, { phase: 'transcribe', message: ev.text, log: true });
        }
      });
      return { ...result, model: modelId };
    });
  }
}

module.exports = { ModuleManager, ModuleError, MODULE_API_VERSION, fmtBytes };
