'use strict';

const os = require('os');

/** Prioridades: pedidos do usuário (interativos) passam na frente de importação/regeneração em lote. */
const PRIORITY = Object.freeze({ LOW: 0, NORMAL: 1, HIGH: 2 });

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
    constructor(max = defaultMax()) {
        this.max = max;
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

    /** Executa fn() respeitando o limite. `priority` é opcional (padrão NORMAL). */
    async run(fn, priority = PRIORITY.NORMAL) {
        await this._acquire(priority);
        try { return await fn(); } finally { this._release(); }
    }
}

const shared = new FfmpegLimiter();
module.exports = shared;
module.exports.FfmpegLimiter = FfmpegLimiter;
module.exports.PRIORITY = PRIORITY;
module.exports.defaultMax = defaultMax;
