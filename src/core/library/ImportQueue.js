const logger = require('../../services/logService');
const ImportWorker = require('./ImportWorker');

class ImportQueue {
    /**
     * @param {Object} dependencies 
     */
    constructor(dependencies, concurrency = 3) {
        this.queue = [];
        this.activeCount = 0;
        this.concurrency = concurrency;
        this.worker = new ImportWorker(dependencies);
    }

    /**
     * Adiciona um evento de arquivo na fila de importação
     * @param {Object} item 
     * @param {number} item.libraryId 
     * @param {string} item.path 
     */
    add(item) {
        // Evita pendurar arquivos iguais simultaneamente na fila
        if (!this.queue.some(q => q.path === item.path)) {
            this.queue.push(item);
            this.processNext();
        }
    }

    async processNext() {
        if (this.activeCount >= this.concurrency || this.queue.length === 0) return;
        
        this.activeCount++;
        const item = this.queue.shift();
        
        try {
            await this.worker.processFile(item);
        } catch (error) {
            logger.error(`[ImportQueue] Erro grave ao processar ${item.path}:`, error.message);
        } finally {
            this.activeCount--;
            // Chama o próximo da fila
            this.processNext();
        }
    }
}

module.exports = ImportQueue;
