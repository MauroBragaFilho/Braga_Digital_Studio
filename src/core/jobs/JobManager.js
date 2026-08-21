'use strict';

const EventEmitter = require('node:events');
const { Job, JobStatus, JobType } = require('./Job');
const logger = require('../../services/logService');

/**
 * JobManager — Gerenciador unificado de filas de tarefas assíncronas e controle de concorrência.
 *
 * Responsabilidades:
 * - Controle de limite de processos pesados em paralelo (concurrency limiter)
 * - Cancelamento cooperativo seguro
 * - Histórico e acompanhamento unificado de tarefas de longa duração
 * - Emissão reativa de eventos para a interface
 */
class JobManager extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {number} [options.concurrency=2] - Número máximo de tarefas em paralelo
   * @param {number} [options.maxHistory=100] - Máximo de itens mantidos no histórico
   */
  constructor(options = {}) {
    super();
    this.concurrency = options.concurrency || 2;
    this.maxHistory = options.maxHistory || 100;

    this.queue = [];                   // Array<Job> aguardando execução
    this.running = new Map();          // Map<jobId, Job> em execução
    this.history = [];                 // Array<Object> histórico finalizado
    this.isPaused = false;
  }

  /**
   * Submete um novo Job para a fila.
   * @param {Job|Object} jobOrOptions - Instância de Job ou opções de criação
   * @returns {Job}
   */
  submit(jobOrOptions) {
    const job = jobOrOptions instanceof Job ? jobOrOptions : new Job(jobOrOptions);

    this.queue.push(job);
    logger.info(`[JobManager] Job submetido: [${job.type}] ${job.title} (${job.id})`);

    // Conectar eventos internos do job
    job.on('progress', (data) => {
      this.emit('job:progress', { jobId: job.id, ...data });
    });

    job.on('completed', (data) => {
      this._onJobFinished(job, JobStatus.COMPLETED);
      this.emit('job:completed', data);
    });

    job.on('failed', (data) => {
      this._onJobFinished(job, JobStatus.FAILED);
      this.emit('job:failed', data);
    });

    job.on('cancelled', (data) => {
      this._onJobFinished(job, JobStatus.CANCELLED);
      this.emit('job:cancelled', data);
    });

    this.emit('job:queued', job.toJSON());
    this.emit('queue:updated', this.getStatus());

    // Processa próximo item da fila
    process.nextTick(() => this._processNext());

    return job;
  }

  /**
   * Processa os próximos jobs da fila respeitando a concorrência.
   * @private
   */
  _processNext() {
    if (this.isPaused) return;

    while (this.running.size < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;

      this.running.set(job.id, job);
      this.emit('job:started', job.toJSON());
      this.emit('queue:updated', this.getStatus());

      // Executa de forma assíncrona sem bloquear o loop
      job.run().catch((err) => {
        logger.error(`[JobManager] Erro na execução do job ${job.id}:`, { error: err.message });
      });
    }

    if (this.running.size === 0 && this.queue.length === 0) {
      this.emit('queue:empty');
    }
  }

  /**
   * Finaliza o ciclo de vida do job e move para o histórico.
   * @private
   */
  _onJobFinished(job, status) {
    this.running.delete(job.id);

    const record = job.toJSON();
    this.history.unshift(record);

    if (this.history.length > this.maxHistory) {
      this.history.pop();
    }

    this.emit('queue:updated', this.getStatus());
    process.nextTick(() => this._processNext());
  }

  /**
   * Cancela um job específico por ID (seja em execução ou na fila).
   * @param {string} jobId
   * @returns {boolean}
   */
  cancel(jobId) {
    // 1. Se estiver na fila aguardando
    const queueIndex = this.queue.findIndex(j => j.id === jobId);
    if (queueIndex !== -1) {
      const [job] = this.queue.splice(queueIndex, 1);
      job.cancel();
      this._onJobFinished(job, JobStatus.CANCELLED);
      return true;
    }

    // 2. Se estiver em execução
    const runningJob = this.running.get(jobId);
    if (runningJob) {
      runningJob.cancel();
      return true;
    }

    return false;
  }

  /**
   * Cancela todos os jobs na fila e em execução.
   */
  cancelAll() {
    // Limpa fila
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      job.cancel();
      this._onJobFinished(job, JobStatus.CANCELLED);
    }

    // Cancela os que estão rodando
    for (const job of this.running.values()) {
      job.cancel();
    }
  }

  /**
   * Obtém status geral da fila e estatísticas.
   * @returns {Object}
   */
  getStatus() {
    return {
      concurrency: this.concurrency,
      isPaused: this.isPaused,
      runningCount: this.running.size,
      queuedCount: this.queue.length,
      historyCount: this.history.length,
      running: Array.from(this.running.values()).map(j => j.toJSON()),
      queued: this.queue.map(j => j.toJSON())
    };
  }

  /**
   * Retorna um job por ID.
   * @param {string} jobId
   * @returns {Job|Object|null}
   */
  getJob(jobId) {
    if (this.running.has(jobId)) return this.running.get(jobId);
    const inQueue = this.queue.find(j => j.id === jobId);
    if (inQueue) return inQueue;
    const inHistory = this.history.find(j => j.id === jobId);
    return inHistory || null;
  }

  /**
   * Lista histórico de jobs concluídos / falhos.
   * @returns {Array<Object>}
   */
  listHistory() {
    return [...this.history];
  }

  /**
   * Limpa o histórico de tarefas finalizadas.
   */
  clearHistory() {
    this.history = [];
    this.emit('queue:updated', this.getStatus());
  }

  /**
   * Pausa o processamento de novos jobs.
   */
  pause() {
    this.isPaused = true;
    this.emit('queue:updated', this.getStatus());
  }

  /**
   * Retoma o processamento da fila.
   */
  resume() {
    this.isPaused = false;
    this.emit('queue:updated', this.getStatus());
    this._processNext();
  }
}

// Instância singleton
const jobManager = new JobManager({ concurrency: 2 });

module.exports = { JobManager, jobManager, Job, JobStatus, JobType };
