const logger = require('../../services/logService');
const fs = require('fs/promises');
const path = require('path');

const { SUPPORTED_EXTENSIONS, RAW_EXTENSIONS, JPEG_EXTENSIONS } = require('./MediaTypes');

const READDIR_CONCURRENCY = 4; // leituras de pasta em paralelo

class MediaScanner {
    /**
     * Percorre um diretório de forma recursiva e retorna todos os arquivos suportados.
     * Passe único e iterativo (sem recursão nem concat de arrays): acumula os arquivos num array,
     * lê subpastas em paralelo limitado e aplica a desduplicação RAW/JPG uma vez no final.
     * @param {string} dirPath - Caminho base da biblioteca
     * @returns {Promise<string[]>} Array de caminhos completos dos arquivos
     */
    static async scanDirectory(dirPath) {
        const found = [];
        const pending = [dirPath];
        let active = 0;

        const readOne = async (dir) => {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch (error) {
                logger.error(`[MediaScanner] Erro ao ler o diretório ${dir}:`, error.message);
                return;
            }
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    // Ignora pastas ocultas
                    if (!entry.name.startsWith('.')) pending.push(path.join(dir, entry.name));
                } else if (entry.isFile()) {
                    if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                        found.push(path.join(dir, entry.name));
                    }
                }
            }
        };

        await new Promise((resolve) => {
            const pump = () => {
                while (active < READDIR_CONCURRENCY && pending.length > 0) {
                    const dir = pending.pop();
                    active++;
                    readOne(dir).finally(() => { active--; pump(); });
                }
                if (active === 0 && pending.length === 0) resolve();
            };
            pump();
        });

        // Desduplicação: prioriza RAW sobre JPG de mesmo nome base na mesma pasta
        const rawKeys = new Set();
        const keyOf = (p) => path.join(path.dirname(p), path.parse(p).name.toLowerCase());
        for (const f of found) {
            if (RAW_EXTENSIONS.has(path.extname(f).toLowerCase())) rawKeys.add(keyOf(f));
        }
        if (rawKeys.size === 0) return found;
        return found.filter((f) => !(JPEG_EXTENSIONS.has(path.extname(f).toLowerCase()) && rawKeys.has(keyOf(f))));
    }
}

module.exports = MediaScanner;
