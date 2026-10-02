'use strict';

/**
 * ModuleManager — módulos opcionais do BDS (hoje: Whisper, para legendas e transcrição).
 *
 * Nada é obrigatório: o BDS funciona sem nenhum módulo, e cada parte é instalada só quando o
 * usuário pede, direto da fonte:
 *   - Motor        : pacote publicado pelo desenvolvedor (manifesto) ou instalado de um .zip local.
 *   - Modelos      : Hugging Face (escolha do usuário; tamanho e SHA-256 vêm da fonte).
 *   - GPU (CUDA)   : bibliotecas oficiais da NVIDIA (exige aceitar a licença da NVIDIA).
 *
 * Layout em disco (<dataDir>/modules):
 *   modules.json                  estado (versões, modelo ativo, datas)
 *   whisper/engine/               motor (WhisperLegendas.exe + dependências)
 *   whisper/models/<id>/          um modelo faster-whisper por pasta
 *   whisper/cuda/                 DLLs do CUDA
 *
 * Eventos: 'progress' { opId, kind, phase, label, percent, receivedBytes, totalBytes, speedBps, message }
 *          'status'   (o estado mudou; a interface deve consultar getStatus())
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { downloadFile, fetchJson, sha256File, CANCELLED } = require('./FileDownloader');
const { extractZip, walkFiles } = require('./ZipExtractor');
const { HuggingFaceSource, NvidiaCudaSource, CUDA_DLL_PATTERNS, CUDA_REQUIRED_DLLS, CUDA_LICENSE_LINKS } = require('./sources');
const { WHISPER_MODELS, DEFAULT_MODEL_ID, REFERENCE_NOTE, getModel } = require('./WhisperCatalog');
const { WhisperEngineRunner, DEFAULT_EXE } = require('./WhisperEngineRunner');

const MODULE_API_VERSION = 1;
const CUDA_APPROX_DOWNLOAD_BYTES = 549731131 + 1924314965; // cuBLAS + cuDNN (valores reais atuais; o definitivo vem da NVIDIA)

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

const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* noop */ } };

class ModuleManager extends EventEmitter {
  /**
   * @param {{rootDir:string, tempDir:string, config?:object, getJson?:Function}} opts
   *   config: { manifestUrl, huggingFaceBaseUrl, nvidiaBaseUrl, bdsVersion, engineCommand, engineBaseArgs, platform }
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
      cuda: path.join(this.root, 'whisper', 'cuda')
    };
    this._getJson = getJson;
    this.hf = new HuggingFaceSource({ baseUrl: config.huggingFaceBaseUrl, getJson });
    this.nvidia = new NvidiaCudaSource({ baseUrl: config.nvidiaBaseUrl, getJson });
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

  _exeName() { return (this._readState().whisper.engine || {}).exe || DEFAULT_EXE; }

  _engineInstalled() {
    return fs.existsSync(path.join(this.paths.engine, this._exeName()));
  }

  _modelDir(id) { return path.join(this.paths.models, id); }

  _modelInstalled(id) {
    const dir = this._modelDir(id);
    return ['model.bin', 'config.json', 'tokenizer.json'].every((f) => fs.existsSync(path.join(dir, f)));
  }

  _cudaInstalled() {
    return CUDA_REQUIRED_DLLS.every((f) => fs.existsSync(path.join(this.paths.cuda, f)));
  }

  _activeModelId() {
    const saved = this._readState().whisper.activeModel;
    if (saved && getModel(saved) && this._modelInstalled(saved)) return saved;
    const first = WHISPER_MODELS.find((m) => this._modelInstalled(m.id));
    return first ? first.id : null;
  }

  // ------------------------------------------------------------------ consulta

  async getStatus() {
    const state = this._readState().whisper || {};
    const installedModels = state.models || {};
    const activeId = this._activeModelId();
    const engineOk = this._engineInstalled();
    const cudaOk = this._cudaInstalled();

    let freeBytes = null;
    try {
      fs.mkdirSync(this.root, { recursive: true });
      const s = await fs.promises.statfs(this.root);
      freeBytes = s.bavail * s.bsize;
    } catch (_) { /* indisponível */ }

    return {
      apiVersion: MODULE_API_VERSION,
      platformSupported: this._platform === 'win32',
      manifestConfigured: Boolean(this.config.manifestUrl),
      busy: this._active ? { opId: this._active.opId, kind: this._active.kind, label: this._active.label } : null,
      disk: { freeBytes },
      whisper: {
        id: 'whisper',
        name: 'Legendas e Transcrição (Whisper)',
        description: 'Gera legendas (.srt) e transcrições com tempo (.md) de vídeos e áudios, em português e outros idiomas. O reconhecimento roda no seu computador: o áudio não é enviado para a internet.',
        engine: {
          installed: engineOk,
          version: engineOk ? (state.engine || {}).version || null : null,
          source: engineOk ? (state.engine || {}).source || null : null,
          installedAt: engineOk ? (state.engine || {}).installedAt || null : null
        },
        models: WHISPER_MODELS.map((m) => {
          const installed = this._modelInstalled(m.id);
          return {
            id: m.id, label: m.label, description: m.description, sizeBytes: m.sizeBytes,
            speed: m.speed, speedLevel: m.speedLevel, quality: m.quality, vramGb: m.vramGb,
            recommendedFor: m.recommendedFor || null,
            installed, active: installed && m.id === activeId,
            sizeOnDisk: installed ? (installedModels[m.id] || {}).sizeBytes || m.sizeBytes : 0
          };
        }),
        referenceNote: REFERENCE_NOTE,
        defaultModelId: DEFAULT_MODEL_ID,
        activeModelId: activeId,
        cuda: {
          installed: cudaOk,
          versions: cudaOk ? (state.cuda || {}).versions || null : null,
          approxDownloadBytes: CUDA_APPROX_DOWNLOAD_BYTES,
          licenseLinks: CUDA_LICENSE_LINKS,
          requirement: 'Exige uma placa de vídeo NVIDIA com driver atualizado. Sem o CUDA, a transcrição funciona normalmente, só que mais devagar (na CPU).'
        },
        ready: engineOk && Boolean(activeId)
      }
    };
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
    return downloadFile({ url, dest, expectedSha256: sha256 || null, expectedSize: size || null, onProgress, signal });
  }

  // ------------------------------------------------------------------ motor

  /**
   * Instala o motor do Whisper.
   * @param {{zipPath?:string}} [opts]  Sem zipPath, usa o manifesto publicado (config.manifestUrl).
   */
  async installEngine({ zipPath = null } = {}) {
    this._requireWindows();
    return this._run('engine', 'Instalando o motor do Whisper', async (op) => {
      const signal = op.controller.signal;
      fs.mkdirSync(this.tempDir, { recursive: true });
      const work = path.join(this.tempDir, `engine_${Date.now()}`);
      let archive = zipPath;
      let meta = { version: null, source: 'zip', exe: DEFAULT_EXE };

      try {
        if (zipPath) {
          if (!/\.zip$/i.test(zipPath) || !fs.existsSync(zipPath)) throw new ModuleError('Selecione um arquivo .zip válido do motor.', 'BAD_ZIP');
        } else {
          if (!this.config.manifestUrl) {
            throw new ModuleError('A distribuição do motor ainda não foi configurada (manifestUrl vazio). Instale a partir de um arquivo .zip.', 'NO_MANIFEST');
          }
          this._progress(op, { phase: 'prepare', message: 'Consultando o servidor de módulos…' });
          const manifest = await this._getJson(this.config.manifestUrl);
          const entry = manifest && manifest.modules && manifest.modules.whisper;
          const plat = entry && entry.platform && entry.platform[this._platform];
          if (!entry || !plat || !plat.url || !plat.sha256) throw new ModuleError('O manifesto não traz o motor do Whisper para este sistema.', 'BAD_MANIFEST');
          if (entry.apiVersion && entry.apiVersion > MODULE_API_VERSION) {
            throw new ModuleError('Este motor exige uma versão mais nova do BDS. Atualize o BDS e tente de novo.', 'INCOMPATIBLE');
          }
          await this._ensureSpace(this.root, (Number(plat.size) || 0) * 2.2);
          archive = path.join(work, 'engine.zip');
          this._progress(op, { phase: 'download', message: 'Baixando o motor…' });
          await this._fetchVerified({
            url: plat.url, dest: archive, sha256: plat.sha256, size: Number(plat.size) || null, signal,
            onProgress: (p) => this._progress(op, { phase: 'download', message: 'Baixando o motor…', ...p })
          });
          meta = { version: entry.version || null, source: 'manifest', exe: plat.exe || DEFAULT_EXE };
        }

        this._progress(op, { phase: 'extract', message: 'Extraindo arquivos…' });
        const extracted = path.join(work, 'files');
        await extractZip(archive, extracted, { signal });

        const exeFile = walkFiles(extracted).find((f) => path.basename(f).toLowerCase() === meta.exe.toLowerCase());
        if (!exeFile) throw new ModuleError(`O pacote não contém ${meta.exe}.`, 'BAD_ZIP');

        this._progress(op, { phase: 'install', message: 'Instalando…' });
        fs.mkdirSync(path.dirname(this.paths.engine), { recursive: true });
        const backup = `${this.paths.engine}.old`;
        rmrf(backup);
        if (fs.existsSync(this.paths.engine)) fs.renameSync(this.paths.engine, backup);
        try {
          fs.renameSync(path.dirname(exeFile), this.paths.engine);
        } catch (err) {
          if (fs.existsSync(backup)) fs.renameSync(backup, this.paths.engine); // rollback
          throw err;
        }
        rmrf(backup);

        this._patchWhisper((w) => { w.engine = { ...meta, installedAt: new Date().toISOString() }; });
      } finally {
        rmrf(work);
      }
      return this.getStatus();
    });
  }

  async uninstallEngine() {
    return this._run('engine', 'Removendo o motor do Whisper', async () => {
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
      const info = await this.hf.getModelFiles(model.repo);
      const totalBytes = info.files.reduce((s, f) => s + f.size, 0);
      await this._ensureSpace(this.paths.models, totalBytes * 1.05);

      const partial = path.join(this.paths.models, `${modelId}.partial`);
      fs.mkdirSync(partial, { recursive: true });

      let done = 0;
      for (const file of info.files) {
        const dest = path.join(partial, file.path);
        const base = done;
        this._progress(op, { phase: 'download', message: `Baixando ${file.path}…`, receivedBytes: base, totalBytes, percent: (base / totalBytes) * 100 });
        await this._fetchVerified({
          url: this.hf.fileUrl(info.repoId, info.revision, file.path),
          dest, sha256: file.sha256, size: file.size || null, signal,
          onProgress: (p) => {
            const received = base + p.receivedBytes;
            this._progress(op, { phase: 'download', message: `Baixando ${file.path}…`, receivedBytes: received, totalBytes, percent: (received / totalBytes) * 100, speedBps: p.speedBps });
          }
        });
        done += file.size;
      }

      this._progress(op, { phase: 'install', message: 'Finalizando…', percent: 100 });
      // O modelo ativo só muda sozinho se ainda não houver nenhum utilizável.
      const hadActive = this._activeModelId() !== null;
      const finalDir = this._modelDir(modelId);
      rmrf(finalDir);
      fs.renameSync(partial, finalDir);

      this._patchWhisper((w) => {
        w.models = w.models || {};
        w.models[modelId] = { installedAt: new Date().toISOString(), sizeBytes: totalBytes, repo: info.repoId, revision: info.revision };
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

  // ------------------------------------------------------------------ GPU (CUDA)

  /** Baixa as bibliotecas CUDA (cuBLAS + cuDNN) da NVIDIA. Exige aceitar a licença da NVIDIA. */
  async installCuda({ acceptLicense = false } = {}) {
    this._requireWindows();
    if (acceptLicense !== true) {
      throw new ModuleError('É preciso aceitar os termos de licença da NVIDIA (CUDA e cuDNN) para baixar as bibliotecas.', 'LICENSE');
    }
    return this._run('cuda', 'Baixando o CUDA (NVIDIA)', async (op) => {
      const signal = op.controller.signal;
      this._progress(op, { phase: 'prepare', message: 'Consultando os pacotes oficiais da NVIDIA…' });
      const plan = await this.nvidia.resolve();
      const totalBytes = plan.reduce((s, c) => s + c.size, 0);
      await this._ensureSpace(this.root, totalBytes * 1.8);

      fs.mkdirSync(this.tempDir, { recursive: true });
      const work = path.join(this.tempDir, `cuda_${Date.now()}`);
      const staging = path.join(this.root, 'whisper', 'cuda.partial');
      rmrf(staging);
      fs.mkdirSync(staging, { recursive: true });

      try {
        let done = 0;
        const versions = {};
        for (const comp of plan) {
          const base = done;
          const zip = path.join(work, `${comp.id}.zip`);
          this._progress(op, { phase: 'download', message: `Baixando ${comp.label} ${comp.version}…`, receivedBytes: base, totalBytes, percent: (base / totalBytes) * 100 });
          await this._fetchVerified({
            url: comp.url, dest: zip, sha256: comp.sha256, size: comp.size, signal,
            onProgress: (p) => {
              const received = base + p.receivedBytes;
              this._progress(op, { phase: 'download', message: `Baixando ${comp.label} ${comp.version}…`, receivedBytes: received, totalBytes, percent: (received / totalBytes) * 100, speedBps: p.speedBps });
            }
          });
          done += comp.size;

          this._progress(op, { phase: 'extract', message: `Extraindo ${comp.label}…`, percent: (done / totalBytes) * 100 });
          const out = path.join(work, `${comp.id}_files`);
          await extractZip(zip, out, { include: ['*.dll'], signal });
          for (const file of walkFiles(out)) {
            const name = path.basename(file);
            if (CUDA_DLL_PATTERNS.some((re) => re.test(name))) fs.copyFileSync(file, path.join(staging, name));
          }
          rmrf(zip);
          rmrf(out);
          versions[comp.id] = comp.version;
        }

        const missing = CUDA_REQUIRED_DLLS.filter((f) => !fs.existsSync(path.join(staging, f)));
        if (missing.length) throw new ModuleError(`Pacote da NVIDIA incompleto (faltam: ${missing.join(', ')}).`, 'BAD_CUDA');

        rmrf(this.paths.cuda);
        fs.renameSync(staging, this.paths.cuda);
        this._patchWhisper((w) => { w.cuda = { installedAt: new Date().toISOString(), versions }; });
      } finally {
        rmrf(work);
        rmrf(staging);
      }
      return this.getStatus();
    });
  }

  async removeCuda() {
    return this._run('cuda', 'Removendo o CUDA', async () => {
      rmrf(this.paths.cuda);
      rmrf(path.join(this.root, 'whisper', 'cuda.partial'));
      this._patchWhisper((w) => { delete w.cuda; });
      return this.getStatus();
    });
  }

  // ------------------------------------------------------------------ transcrição

  /**
   * Gera legendas/transcrição com o modelo ativo. Usa a GPU se o CUDA estiver instalado.
   * @param {{files:string[], srt?:boolean, md?:boolean, maxWords?:number, outDir?:string, forceCpu?:boolean}} options
   */
  async transcribe(options) {
    this._requireWindows();
    if (!this._engineInstalled() && !this.config.engineCommand) throw new ModuleError('Instale o motor do Whisper primeiro.', 'NO_ENGINE');
    const modelId = this._activeModelId();
    if (!modelId) throw new ModuleError('Baixe e escolha um modelo antes de transcrever.', 'NO_MODEL');

    return this._run('transcribe', 'Gerando legendas/transcrição', async (op) => {
      const runner = new WhisperEngineRunner({
        engineDir: this.paths.engine,
        exeName: this._exeName(),
        tempDir: this.tempDir,
        command: this.config.engineCommand || null,
        baseArgs: this.config.engineBaseArgs || []
      });
      const result = await runner.run(options, {
        modelDir: this._modelDir(modelId),
        cudaDir: this._cudaInstalled() ? this.paths.cuda : null,
        signal: op.controller.signal,
        onEvent: (ev) => {
          if (ev.type === 'progress') this._progress(op, { phase: 'transcribe', message: 'Transcrevendo…', percent: ev.percent });
          else if (ev.type === 'status') this._progress(op, { phase: 'transcribe', message: ev.text });
          else if (ev.type === 'device') this._progress(op, { phase: 'transcribe', message: `Dispositivo: ${ev.text}`, device: ev.text });
          else if (ev.type === 'line' || ev.type === 'error') this._progress(op, { phase: 'transcribe', message: ev.text, log: true });
        }
      });
      return { ...result, model: modelId };
    });
  }
}

module.exports = { ModuleManager, ModuleError, MODULE_API_VERSION, fmtBytes };
