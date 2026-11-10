'use strict';

/**
 * Pastas de nuvem com arquivos sob demanda (Google Drive para computador, modo "streaming").
 *
 * Nessas pastas o arquivo só existe na nuvem até alguém ler o conteúdo: o hash, o ffprobe e a miniatura
 * fariam o Drive baixar cada vídeo inteiro. A ingestão usa isCloudPath() para indexar só com o que o
 * sistema informa sem abrir o arquivo (nome, tamanho, data) e deixa o resto para quando a mídia for usada.
 *
 * Detecção pelo caminho: o Drive monta uma unidade (G:, Y:...) cujas pastas de primeiro nível são sempre
 * estas (no Windows o volume aparece como "FAT32" e o `stat` informa espaço alocado mesmo sem o arquivo
 * estar baixado, então não há como distinguir pelo arquivo). No macOS a unidade fica em
 * ~/Library/CloudStorage/GoogleDrive-<conta>/ ou /Volumes/GoogleDrive/.
 */

const crypto = require('node:crypto');

const GOOGLE_DRIVE_ROOTS = new Set([
    'my drive', 'meu drive',
    'shared drives', 'drives compartilhados',
    'other computers', 'outros computadores',
    '.shortcut-targets-by-id',
]);

/** "G:\My Drive\x.mp4" -> ['G:', 'My Drive', 'x.mp4'] (aceita as duas barras). */
function segmentsOf(filePath) {
    return String(filePath || '').split(/[\\/]+/).filter(Boolean);
}

/**
 * true quando o caminho está numa unidade do Google Drive para computador.
 * @param {string} filePath
 * @param {string} [platform=process.platform]
 */
function isCloudPath(filePath, platform = process.platform) {
    const segs = segmentsOf(filePath);
    if (segs.length < 2) return false;
    for (let i = 1; i < segs.length; i++) {
        if (!GOOGLE_DRIVE_ROOTS.has(segs[i].toLowerCase())) continue;
        const prev = segs[i - 1];
        // Windows: logo abaixo da raiz da unidade montada pelo Drive ("G:")
        if (i === 1 && platform === 'win32' && /^[a-z]:$/i.test(prev)) return true;
        // macOS: CloudStorage/GoogleDrive-<conta>/My Drive ou /Volumes/GoogleDrive/My Drive
        if (/^googledrive/i.test(prev)) return true;
    }
    return false;
}

/**
 * Identidade de um arquivo da nuvem sem ler o conteúdo: nome + tamanho + data de modificação.
 * Prefixo "cloud:" para nunca coincidir com o hash de conteúdo (SHA-256 puro) de outra mídia.
 * @param {string} filePath
 * @param {{size:number, mtimeMs:number}} stats
 */
function cloudHash(filePath, stats) {
    const h = crypto.createHash('sha256');
    // Nome pelo último segmento (\ ou /): path.basename do Linux não separa "G:\pasta\a.mp4"
    const name = segmentsOf(filePath).pop() || '';
    h.update(`${name.toLowerCase()}|${stats.size}|${Math.round(stats.mtimeMs || 0)}`);
    return `cloud:${h.digest('hex')}`;
}

module.exports = { isCloudPath, cloudHash, GOOGLE_DRIVE_ROOTS };
