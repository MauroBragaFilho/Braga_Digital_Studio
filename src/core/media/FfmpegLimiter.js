'use strict';

/**
 * Semáforo simples para limitar processos ffmpeg simultâneos entre
 * ThumbnailGenerator, regen de miniaturas e WaveformService.
 */
class FfmpegLimiter {
    constructor(max = 4) {
        this.max = max;
        this.active = 0;
        this.waiting = [];
    }

    async _acquire() {
        if (this.active < this.max) { this.active++; return; }
        // O slot é transferido diretamente por _release (active não decrementa).
        await new Promise((resolve) => this.waiting.push(resolve));
    }

    _release() {
        const next = this.waiting.shift();
        if (next) next(); // transfere o slot
        else this.active--;
    }

    /** Executa fn() respeitando o limite. */
    async run(fn) {
        await this._acquire();
        try { return await fn(); } finally { this._release(); }
    }
}

const shared = new FfmpegLimiter(4);
module.exports = shared;
module.exports.FfmpegLimiter = FfmpegLimiter;
