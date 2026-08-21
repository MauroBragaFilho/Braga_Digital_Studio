'use strict';

const EventEmitter = require('node:events');
const { v4: uuidv4 } = require('uuid');

/**
 * Status possíveis de um Job.
 */
const JobStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

/**
 * Tipos de Job suportados pelo BDS.
 */
const JobType = {
  DOWNLOAD: 'DOWNLOAD',
  CONVERT: 'CONVERT',
  SILENCE: 'SILENCE',
  MONTAGE: 'MONTAGE',
  IMPORT: 'IMPORT',
  THUMBNAIL: 'THUMBNAIL',
  SYNC: 'SYNC',
  CUSTOM: 'CUSTOM'
};

/**
 * Job — Unidade fundamental de execução em background no BDS.
 */
class Job extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} [options.id] - Identificador único (gerado se omitido)
   * @param {string} options.type - Tipo de job (JobType)
   * @param {string} [options.title] - Título amigável
   * @param {Object} [options.payload] - Parâmetros da tarefa
   * @param {Function} [options.executor] - Função assíncrona que executa a tarefa: async (job, updateProgress) => result
   */
  constructor(options = {}) {
    super();
    this.id = options.id || uuidv4();
    this.type = options.type || JobType.CUSTOM;
    this.title = options.title || `${this.type} Job`;
    this.payload = options.payload || {};
    this.executor = options.executor || null;

    this.status = JobStatus.QUEUED;
    this.progress = 0;
    this.result = null;
    this.error = null;

    this.createdAt = new Date().toISOString();
    this.startedAt = null;
    this.finishedAt = null;
    this.durationMs = 0;

    this._cancelHandler = null;
    this._isCancelled = false;
  }

  /**
   * Define um manipulador customizado de cancelamento.
   * @param {Function} handler
   */
  onCancel(handler) {
    this._cancelHandler = handler;
  }

  /**
   * Atualiza o progresso do job (0-100) e emite evento.
   * @param {number} percent
   * @param {Object} [details]
   */
  updateProgress(percent, details = {}) {
    this.progress = Math.min(100, Math.max(0, Math.round(percent)));
    this.emit('progress', { percent: this.progress, ...details });
  }

  /**
   * Executa a tarefa do job.
   * @returns {Promise<any>}
   */
  async run() {
    if (this._isCancelled) {
      this.status = JobStatus.CANCELLED;
      return null;
    }

    this.status = JobStatus.RUNNING;
    this.startedAt = new Date().toISOString();
    this.emit('started', this.toJSON());

    try {
      if (typeof this.executor !== 'function') {
        throw new Error(`Nenhum executor fornecido para o job ${this.id}`);
      }

      const result = await this.executor(this, (pct, details) => this.updateProgress(pct, details));

      if (this._isCancelled) {
        this.status = JobStatus.CANCELLED;
        return null;
      }

      this.result = result;
      this.progress = 100;
      this.status = JobStatus.COMPLETED;
      this.finishedAt = new Date().toISOString();
      this.durationMs = new Date(this.finishedAt).getTime() - new Date(this.startedAt).getTime();

      this.emit('completed', this.toJSON());
      return result;
    } catch (err) {
      if (this._isCancelled) {
        this.status = JobStatus.CANCELLED;
        return null;
      }

      this.error = err.message || String(err);
      this.status = JobStatus.FAILED;
      this.finishedAt = new Date().toISOString();
      this.durationMs = new Date(this.finishedAt).getTime() - new Date(this.startedAt).getTime();

      this.emit('failed', { error: this.error, job: this.toJSON() });
      throw err;
    }
  }

  /**
   * Solicita o cancelamento do job.
   */
  cancel() {
    if (this.status === JobStatus.COMPLETED || this.status === JobStatus.CANCELLED) return;
    this._isCancelled = true;
    this.status = JobStatus.CANCELLED;
    this.finishedAt = new Date().toISOString();
    if (this.startedAt) {
      this.durationMs = new Date(this.finishedAt).getTime() - new Date(this.startedAt).getTime();
    }

    try {
      if (typeof this._cancelHandler === 'function') {
        this._cancelHandler();
      }
    } catch (_) {}

    this.emit('cancelled', this.toJSON());
  }

  /**
   * Serializa o job para visualização ou envio via IPC.
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      title: this.title,
      status: this.status,
      progress: this.progress,
      payload: this.payload,
      result: this.result,
      error: this.error,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationMs: this.durationMs
    };
  }
}

module.exports = { Job, JobStatus, JobType };
