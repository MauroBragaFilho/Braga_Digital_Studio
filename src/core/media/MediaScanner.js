const logger = require('../../services/logService');
const fs = require('fs/promises');
const path = require('path');

const { SUPPORTED_EXTENSIONS, RAW_EXTENSIONS, isJpeg } = require('./MediaTypes');

class MediaScanner {
    /**
     * Percorre um diretório de forma recursiva e retorna todos os arquivos suportados.
     * @param {string} dirPath - Caminho base da biblioteca
     * @returns {Promise<string[]>} Array de caminhos completos dos arquivos
     */
    static async scanDirectory(dirPath) {
        let results = [];
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                
                if (entry.isDirectory()) {
                    // Ignora pastas ocultas ou do sistema se necessário
                    if (!entry.name.startsWith('.')) {
                        const subResults = await this.scanDirectory(fullPath);
                        results = results.concat(subResults);
                    }
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (SUPPORTED_EXTENSIONS.has(ext)) {
                        results.push(fullPath);
                    }
                }
            }
            
            // Lógica de desduplicação: Prioriza RAW sobre JPG na mesma pasta
            const filteredResults = [];
            const dirGroups = {};
            
            // Agrupar por pasta e nome base
            for (const resPath of results) {
                const dir = path.dirname(resPath);
                const ext = path.extname(resPath).toLowerCase();
                const base = path.parse(resPath).name.toLowerCase();
                
                if (!dirGroups[dir]) dirGroups[dir] = {};
                if (!dirGroups[dir][base]) dirGroups[dir][base] = [];
                
                dirGroups[dir][base].push({ path: resPath, ext });
            }
            
            
            for (const dir in dirGroups) {
                for (const base in dirGroups[dir]) {
                    const files = dirGroups[dir][base];
                    let hasRaw = files.some(f => RAW_EXTENSIONS.has(f.ext));
                    
                    for (const f of files) {
                        if (hasRaw && isJpeg(f.path)) {
                            // Pula o JPG se existir o RAW
                            continue;
                        }
                        filteredResults.push(f.path);
                    }
                }
            }
            
            results = filteredResults;

        } catch (error) {
            logger.error(`[MediaScanner] Erro ao ler o diretório ${dirPath}:`, error.message);
        }
        return results;
    }
}

module.exports = MediaScanner;
