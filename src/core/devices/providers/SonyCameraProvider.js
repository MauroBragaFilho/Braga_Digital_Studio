const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const logger = require('../../../services/logService');
const SonyCameraClient = require('../../../infrastructure/network/sony/SonyCameraClient');

class SonyCameraProvider {
    /**
     * @param {Object} cameraInfo - { id, name, model, endpointURL, ip }
     */
    constructor(cameraInfo) {
        this.cameraInfo = cameraInfo;
        this.client = new SonyCameraClient(cameraInfo.endpointURL);
        this.availableApis = new Set();
    }

    /**
     * Inicializa e verifica capacidades da câmera
     */
    async initialize() {
        try {
            const apis = await this.client.getAvailableApiList();
            this.availableApis = new Set(apis);
            logger.info(`[SonyCameraProvider] APIs disponíveis para ${this.cameraInfo.name}: ${apis.join(', ')}`);
        } catch (e) {
            logger.warn(`[SonyCameraProvider] Não foi possível obter lista de APIs disponíveis: ${e.message}`);
        }
    }

    /**
     * Retorna a telemetria do dispositivo (bateria, armazenamento, lente se suportada)
     */
    async getDeviceStatus() {
        const status = {
            id: this.cameraInfo.id,
            name: this.cameraInfo.name,
            model: this.cameraInfo.model,
            ip: this.cameraInfo.ip,
            battery: null,
            storage: null,
            lens: null // Condicional: se a câmera não expor, permanece null
        };

        // 1. Bateria via getEvent
        try {
            const eventData = await this.client.getEvent(false);
            if (Array.isArray(eventData)) {
                for (const item of eventData) {
                    if (item && item.type === 'batteryInfo') {
                        status.battery = {
                            level: item.batteryLevel,
                            status: item.batteryStatus
                        };
                    }
                }
            }
        } catch (e) {
            logger.warn(`[SonyCameraProvider] Erro ao consultar bateria: ${e.message}`);
        }

        // 2. Armazenamento via getStorageInformation
        try {
            const storages = await this.client.getStorageInformation();
            if (Array.isArray(storages) && storages.length > 0) {
                const primary = storages[0];
                status.storage = {
                    total: primary.storageTotal || 0,
                    free: primary.storageFree || 0,
                    storageID: primary.storageID || 'memoryCard1'
                };
            }
        } catch (e) {
            logger.warn(`[SonyCameraProvider] Erro ao consultar armazenamento: ${e.message}`);
        }

        return status;
    }

    /**
     * Lista conteúdos do cartão de memória
     * @param {Object} options 
     */
    async list(options = {}) {
        try {
            const uri = options.uri || 'storage:memoryCard1';
            const pageSize = options.cnt || 100;
            const maxItems = options.maxItems || 5000;
            let stIndex = options.stIndex || 0;
            const all = [];
            // A câmera devolve em páginas: continua até vir uma página incompleta (ou o limite)
            for (;;) {
                const rawItems = await this.client.getContentList({ uri, stIndex, cnt: pageSize, view: options.view || 'flat' });
                const page = Array.isArray(rawItems) ? rawItems : [];
                all.push(...page);
                if (page.length < pageSize || all.length >= maxItems || options.stIndex !== undefined) break;
                stIndex += page.length;
            }
            return this.normalizeContentList(all);
        } catch (e) {
            logger.error(`[SonyCameraProvider] Falha ao listar conteúdo: ${e.message}`);
            return [];
        }
    }

    /**
     * Navega por pastas/datas
     */
    async browse(uri) {
        return this.list({ uri, view: 'flat' });
    }

    /**
     * Normaliza a lista de conteúdo da API Sony para um formato padronizado do BDS
     */
    normalizeContentList(items) {
        if (!Array.isArray(items)) return [];

        const normalized = [];

        for (const item of items) {
            // Itens podem ser pastas ou arquivos
            const isFolder = item.isFolder === 'true' || item.contentKind === 'directory';
            const filename = item.title || item.originalName || (item.uri ? path.basename(item.uri) : 'unknown');

            // Determinar URLs de download (JPG vs RAW/ARW vs MP4)
            let directUrl = null;
            let rawUrl = null;
            let thumbUrl = null;

            if (item.content && item.content.deliverUrl) {
                directUrl = item.content.deliverUrl;
            }

            // Checar se há URLs separadas para RAW e JPG ou representações de conteúdo
            if (Array.isArray(item.content?.urls)) {
                for (const u of item.content.urls) {
                    if (u.type === 'raw' || u.url?.toLowerCase().endsWith('.arw')) {
                        rawUrl = u.url;
                    } else if (u.type === 'jpeg' || u.type === 'main' || u.url?.toLowerCase().endsWith('.jpg')) {
                        directUrl = u.url;
                    }
                }
            }

            if (item.thumbnailUrl) {
                thumbUrl = item.thumbnailUrl;
            } else if (item.smallUrl) {
                thumbUrl = item.smallUrl;
            }

            normalized.push({
                id: item.uri || item.id || filename,
                uri: item.uri,
                title: filename,
                filename: filename,
                isFolder: isFolder,
                createdTime: item.createdTime || null,
                contentKind: item.contentKind || (filename.toLowerCase().endsWith('.mp4') ? 'movie' : 'still'),
                url: directUrl,
                rawUrl: rawUrl,
                thumbnailUrl: thumbUrl,
                size: item.content?.size || 0
            });
        }

        return normalized;
    }

    /**
     * Baixa um arquivo da câmera (JPG, RAW e/ou MP4) com reporte de progresso.
     * Nunca sobrescreve (nome livre "x (2).ext") e só deixa o arquivo final depois de baixar por inteiro.
     * Se algo falhar depois de baixar parte dos arquivos, o erro traz `partial` com os que já estão no disco.
     * @param {Object} fileItem - Objeto do item normalizado
     * @param {string} destinationDirectory - Diretório destino no disco
     * @param {Function} onProgress - Callback ({phase,file,percent,downloaded,total})
     * @returns {Promise<string[]>} Caminhos dos arquivos baixados no disco
     */
    async import(fileItem, destinationDirectory, onProgress) {
        const downloadedFiles = [];
        const safe = (n, fallback) => {
            const clean = path.basename(String(n || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
            return clean && clean !== '.' && clean !== '..' ? clean : fallback;
        };

        try {
            // 1. Arquivo principal (JPG ou MP4)
            if (fileItem.url) {
                const mainFilename = safe(fileItem.filename, 'media_file.jpg');
                const dest = await this.downloadFileWithProgress(fileItem.url, destinationDirectory, mainFilename, (pct, dl, total) => {
                    if (onProgress) onProgress({ phase: 'main', file: mainFilename, percent: pct, downloaded: dl, total });
                });
                downloadedFiles.push(dest);
            }

            // 2. RAW (ARW) quando existe separadamente
            if (fileItem.rawUrl) {
                const rawFilename = safe(String(fileItem.filename || 'media_file').replace(/\.[^/.]+$/, '') + '.ARW', 'media_file.ARW');
                const dest = await this.downloadFileWithProgress(fileItem.rawUrl, destinationDirectory, rawFilename, (pct, dl, total) => {
                    if (onProgress) onProgress({ phase: 'raw', file: rawFilename, percent: pct, downloaded: dl, total });
                });
                downloadedFiles.push(dest);
            }
        } catch (err) {
            err.partial = downloadedFiles;
            throw err;
        }

        return downloadedFiles;
    }

    /** Só baixa de dentro da rede da própria câmera (o endereço vem do dispositivo, não do renderer). */
    _assertCameraUrl(url) {
        let target;
        try { target = new URL(url); } catch (_) { throw new Error('Endereço de download inválido.'); }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Protocolo de download não permitido.');
        const cameraHost = new URL(this.cameraInfo.endpointURL).hostname;
        if (target.hostname !== cameraHost) throw new Error('O arquivo não pertence à câmera conectada.');
    }

    /**
     * Download HTTP com progresso: grava em ".part" (com timeout de inatividade), confere o tamanho e
     * renomeia para um nome livre dentro de `dir`.
     */
    downloadFileWithProgress(url, dir, name, progressCallback) {
        return new Promise((resolve, reject) => {
            try { this._assertCameraUrl(url); } catch (e) { return reject(e); }
            const ext = path.extname(name);
            const base = path.basename(name, ext);
            const part = path.join(dir, `${base}.${process.pid}-${Date.now()}.part`);
            let settled = false;
            let fileStream = null;
            const fail = (err) => {
                if (settled) return;
                settled = true;
                try { if (fileStream) fileStream.destroy(); } catch (_) { /* noop */ }
                fs.unlink(part, () => {});
                reject(err);
            };

            const clientModule = url.startsWith('https') ? https : http;
            const req = clientModule.get(url, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return fail(new Error(`Falha no download. HTTP ${res.statusCode}`));
                }
                const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
                let downloadedBytes = 0;
                fileStream = fs.createWriteStream(part, { flags: 'wx' });
                fileStream.on('error', fail);
                res.on('error', fail);
                res.on('aborted', () => fail(new Error('Conexão com a câmera interrompida.')));

                res.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    if (progressCallback && totalBytes > 0) {
                        const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
                        progressCallback(percent, downloadedBytes, totalBytes);
                    }
                });

                fileStream.on('finish', () => {
                    if (settled) return;
                    try {
                        if (totalBytes > 0 && downloadedBytes !== totalBytes) throw new Error('Download incompleto.');
                        for (let n = 1; n < 10000; n++) {
                            const candidate = path.join(dir, n === 1 ? name : `${base} (${n})${ext}`);
                            if (fs.existsSync(candidate)) continue;
                            fs.renameSync(part, candidate);
                            settled = true;
                            return resolve(candidate);
                        }
                        throw new Error('Não foi possível escolher um nome livre para o arquivo.');
                    } catch (e) { fail(e); }
                });
                res.pipe(fileStream);
            });

            // Sem dados por 30 s = câmera travada ou fora de alcance
            req.setTimeout(30000, () => req.destroy(new Error('A câmera parou de responder (tempo esgotado).')));
            req.on('error', fail);
        });
    }
}

module.exports = SonyCameraProvider;
