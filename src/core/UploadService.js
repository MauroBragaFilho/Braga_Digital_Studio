const { BrowserWindow } = require('electron');
const EventEmitter = require('events');
const logger = require('../../services/logService');

class UploadService extends EventEmitter {
    constructor() {
        super();
        this.queue = [];
        this.activeUploads = new Map(); // id -> BrowserWindow
    }

    addToQueue(account, fileData) {
        const job = {
            id: Date.now().toString(),
            account,
            file: fileData,
            status: 'queued',
            progress: 0
        };
        this.queue.push(job);
        this.emit('queue-updated', this.queue);
        return job;
    }

    async startUpload(jobId) {
        const job = this.queue.find(j => j.id === jobId);
        if (!job || job.status === 'uploading') return;

        job.status = 'uploading';
        this.emit('queue-updated', this.queue);

        // Criar janela invisível com a sessão da conta
        const win = new BrowserWindow({
            width: 1280,
            height: 720,
            show: false, // Invisível
            webPreferences: {
                partition: job.account.id, // Usa a mesma sessão logada pelo usuário
                nodeIntegration: false,
                contextIsolation: true
            }
        });

        this.activeUploads.set(job.id, win);

        try {
            await win.loadURL('https://studio.youtube.com');
            
            // Aqui começa a Automação (Injeção de JS)
            // Simularemos o processo para fins visuais primeiro, 
            // a implementação real exige os seletores exatos do YT Studio.
            
            this._simulateProgress(job);

            // Código real seria semelhante a:
            // await this.waitForElement(win, 'ytcp-button#upload-icon');
            // await win.webContents.executeJavaScript(`document.querySelector('ytcp-button#upload-icon').click();`);
            // await this.waitForElement(win, 'input[type=file]');
            // ...

        } catch (error) {
            logger.error(`Erro no upload ${job.id}:`, error);
            job.status = 'error';
            job.error = error.message;
            this.emit('queue-updated', this.queue);
        }
    }

    _simulateProgress(job) {
        let p = 0;
        const interval = setInterval(() => {
            p += 5;
            job.progress = p;
            job.status = 'Enviando...';
            this.emit('queue-updated', this.queue);
            
            if (p >= 100) {
                clearInterval(interval);
                job.status = 'Concluído';
                
                // Fecha a janela invisível
                const win = this.activeUploads.get(job.id);
                if (win) {
                    win.close();
                    this.activeUploads.delete(job.id);
                }
                this.emit('queue-updated', this.queue);
            }
        }, 1000);
    }

    getQueue() {
        return this.queue;
    }

    clearQueue() {
        this.queue = this.queue.filter(j => j.status === 'Concluído' || j.status === 'error');
        this.emit('queue-updated', this.queue);
    }

    // Helper method for real automation
    async waitForElement(win, selector, timeout = 10000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const exists = await win.webContents.executeJavaScript(`!!document.querySelector('${selector}')`);
            if (exists) return true;
            await new Promise(r => setTimeout(r, 500));
        }
        throw new Error(`Timeout aguardando elemento: ${selector}`);
    }
}

module.exports = new UploadService();
