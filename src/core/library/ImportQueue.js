const logger = require('../../../services/logService');
const ImportWorker = require('./ImportWorker');

class ImportQueue {
    /**
     * @param {Object} dependencies 
     */
    constructor(dependencies) {
        this.queue = [];
        this.isProcessing = false;
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
        if (this.isProcessing || this.queue.length === 0) return;
        
        this.isProcessing = true;
        const item = this.queue.shift();
        
        try {
            await this.worker.processFile(item);
        } catch (error) {
            logger.error(`[ImportQueue] Erro grave ao processar ${item.path}:`, error.message);
        } finally {
            this.isProcessing = false;
            // Chama o próximo da fila
            this.processNext();
        }
    }
}

module.exports = ImportQueue;
