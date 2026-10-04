'use strict';

const os = require('os');

/** Prioridades: pedidos do usuário (interativos) passam na frente de importação/regeneração em lote. */
const PRIORITY = Object.freeze({ LOW: 0, NORMAL: 1, HIGH: 2 });

/** Tempo máximo que uma tarefa pode ocupar um slot antes do watchdog liberá-lo. */
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

function defaultMax() {
    const cpus = (os.cpus() || []).length || 4;
    return Math.min(6, Math.max(2, Math.floor(cpus / 2)));
}

/**
 * Semáforo simples para limitar processos ffmpeg simultâneos entre
 * ThumbnailGenerator, regen de miniaturas e WaveformService.
 * A fila de espera é ordenada por prioridade (maior primeiro) e FIFO dentro da mesma prioridade.
 */
class FfmpegLimiter {
    constructor(max = defaultMax(), { taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS } = {}) {
        this.max = max;
        this.taskTimeoutMs = taskTimeoutMs;
        this.active = 0;
        this.waiting = []; // { priority, resolve }
    }

    async _acquire(priority = PRIORITY.NORMAL) {
        if (this.active < this.max) { this.active++; return; }
        // O slot é transferido diretamente por _release (active não decrementa).
        await new Promise((resolve) => {
            const entry = { priority, resolve };
            // Insere antes do primeiro item de prioridade menor (mantém FIFO entre iguais)
            let i = this.waiting.length;
            while (i > 0 && this.waiting[i - 1].priority < priority) i--;
            this.waiting.splice(i, 0, entry);
        });
    }

    _release() {
        const next = this.waiting.shift();
        if (next) next.resolve(); // transfere o slot
        else this.active--;
    }

    /**
     * Executa fn(signal) respeitando o limite. `priority` é opcional (padrão NORMAL).
     *
     * Watchdog: se a tarefa passar de `timeoutMs` (padrão DEFAULT_TASK_TIMEOUT_MS; 0 desliga), o
     * AbortSignal entregue a fn é acionado (quem criou o processo deve matar a árvore ao ouvir
     * 'abort'), o slot é liberado e a Promise rejeita com code 'LIMITER_TIMEOUT'. Assim um ffmpeg
     * travado não segura um slot para sempre. Chamadores antigos que usam fn() sem argumento
     * continuam funcionando (só ganham a liberação do slot).
     */
    async run(fn, priority = PRIORITY.NORMAL, opts = {}) {
        const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : this.taskTimeoutMs;
        await this._acquire(priority);
        let released = false;
        const release = () => { if (!released) { released = true; this._release(); } };
        const controller = new AbortController();
        let timer = null;
        try {
            const task = Promise.resolve().then(() => fn(controller.signal));
            if (!(timeoutMs > 0)) return await task;
            const watchdog = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const err = new Error(`A tarefa de mídia demorou mais de ${Math.round(timeoutMs / 1000)}s e foi interrompida. Tente novamente com um arquivo menor.`);
                    err.code = 'LIMITER_TIMEOUT';
                    try { controller.abort(); } catch (_) { /* noop */ }
                    release();
                    reject(err);
                }, timeoutMs);
            });
            task.catch(() => {}); // evita rejeição não tratada se o watchdog vencer a corrida
            return await Promise.race([task, watchdog]);
        } finally {
            if (timer) clearTimeout(timer);
            release();
        }
    }
}

const shared = new FfmpegLimiter();
module.exports = shared;
module.exports.FfmpegLimiter = FfmpegLimiter;
module.exports.PRIORITY = PRIORITY;
module.exports.defaultMax = defaultMax;
module.exports.DEFAULT_TASK_TIMEOUT_MS = DEFAULT_TASK_TIMEOUT_MS;
