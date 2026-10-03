'use strict';

const fs = require('fs');

/**
 * Cache LRU de resultados de ffprobe.
 *  - Chave: variante + caminho + tamanho + mtime (alterar o arquivo invalida a entrada).
 *  - Chamadas concorrentes para a mesma chave compartilham UMA execução do loader.
 *  - Só resultados bem-sucedidos são guardados (falhas nunca ficam em cache).
 *  - Devolve sempre uma cópia, então o chamador pode mutar o resultado sem contaminar o cache.
 */
class ProbeCache {
    constructor({ max = 500 } = {}) {
        this.max = max;
        this._map = new Map();      // chave -> valor (ordem de inserção = ordem LRU)
        this._inflight = new Map(); // chave -> Promise
        this.hits = 0;
        this.misses = 0;
    }

    async _key(filePath, variant) {
        const st = await fs.promises.stat(filePath);
        return `${variant}|${filePath}|${st.size}|${Math.round(st.mtimeMs)}`;
    }

    /**
     * @param {string} filePath
     * @param {() => Promise<any>} loader executa o ffprobe de fato
     * @param {string} [variant] distingue conjuntos de argumentos diferentes para o mesmo arquivo
     */
    async getOrLoad(filePath, loader, variant = 'default') {
        let key;
        try {
            key = await this._key(filePath, variant);
        } catch (_) {
            // Arquivo inexistente/ilegível: sem cache, deixa o loader produzir o erro habitual
            return loader();
        }

        if (this._map.has(key)) {
            const value = this._map.get(key);
            this._map.delete(key);
            this._map.set(key, value); // marca como recente
            this.hits++;
            return clone(value);
        }

        if (this._inflight.has(key)) {
            return clone(await this._inflight.get(key));
        }

        this.misses++;
        const promise = Promise.resolve().then(loader);
        this._inflight.set(key, promise);
        try {
            const value = await promise;
            this._map.set(key, value);
            while (this._map.size > this.max) {
                this._map.delete(this._map.keys().next().value);
            }
            return clone(value);
        } finally {
            this._inflight.delete(key);
        }
    }

    clear() {
        this._map.clear();
    }

    get size() {
        return this._map.size;
    }
}

function clone(value) {
    if (value === null || typeof value !== 'object') return value;
    return structuredClone(value);
}

const shared = new ProbeCache({ max: 500 });
module.exports = shared;
module.exports.ProbeCache = ProbeCache;
