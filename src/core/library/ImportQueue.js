const logger = require('../../services/logService');
const ImportWorker = require('./ImportWorker');

class ImportQueue {
    /**
     * @param {Object} dependencies  { ffprobePath, ffmpegPath, thumbnailsDir, concurrency? }
     * @param {number} [concurrency=3]
     */
    constructor(dependencies, concurrency = 3) {
        this.queue = [];
        this.known = new Set();   // caminhos pendentes + ativos (dedup O(1))
        this.rerun = new Map();   // caminhos ativos que receberam novo evento durante o processamento
        this.activeCount = 0;
        this.concurrency = Math.max(1, (dependencies && dependencies.concurrency) || concurrency);
        this.paused = false;
        this.stats = { done: 0, failed: 0 };
        this.worker = new ImportWorker(dependencies);
    }

    /**
     * Adiciona um evento de arquivo na fila de importação
     * @param {Object} item 
     * @param {number} item.libraryId 
     * @param {string} item.path 
     */
    add(item) {
        if (!item || !item.path) return;
        if (this.known.has(item.path)) {
            // Já pendente: nada a fazer. Já ativo: reprocessa uma vez ao terminar (arquivo pode ter mudado).
            if (!this.queue.some(q => q.path === item.path) && item.event === 'CHANGE') {
                this.rerun.set(item.path, item);
            }
            return;
        }
        this.known.add(item.path);
        this.queue.push(item);
        this.processNext();
    }

    setConcurrency(n) {
        if (n > 0) { this.concurrency = n; this.processNext(); }
    }

    pause() { this.paused = true; }

    resume() {
        this.paused = false;
        for (let i = 0; i < this.concurrency; i++) this.processNext();
    }

    getProgress() {
        return {
            pending: this.queue.length,
            active: this.activeCount,
            done: this.stats.done,
            failed: this.stats.failed,
            paused: this.paused,
        };
    }

    async processNext() {
        if (this.paused || this.activeCount >= this.concurrency || this.queue.length === 0) return;

        this.activeCount++;
        const item = this.queue.shift();

        try {
            await this.worker.processFile(item);
            this.stats.done++;
        } catch (error) {
            this.stats.failed++;
            logger.error(`[ImportQueue] Erro grave ao processar ${item.path}:`, error.message);
        } finally {
            this.activeCount--;
            this.known.delete(item.path);
            const again = this.rerun.get(item.path);
            if (again) {
                this.rerun.delete(item.path);
                this.add(again);
            }
            // Chama o próximo da fila
            this.processNext();
        }
    }
}

module.exports = ImportQueue;
