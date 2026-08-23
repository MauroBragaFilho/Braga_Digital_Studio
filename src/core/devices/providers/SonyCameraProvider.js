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
            const rawItems = await this.client.getContentList({
                uri: options.uri || 'storage:memoryCard1',
                stIndex: options.stIndex || 0,
                cnt: options.cnt || 100,
                view: options.view || 'flat'
            });

            return this.normalizeContentList(rawItems);
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
     * Baixa um arquivo da câmera (JPG, RAW e/ou MP4) com reporte de progresso
     * @param {Object} fileItem - Objeto do item normalizado
     * @param {string} destinationDirectory - Diretório destino no disco
     * @param {Function} onProgress - Callback (percent, bytesDownloaded, totalBytes)
     * @returns {Promise<string[]>} Caminhos dos arquivos baixados no disco
     */
    async import(fileItem, destinationDirectory, onProgress) {
        const downloadedFiles = [];

        // 1. Download do arquivo principal (JPG ou MP4)
        if (fileItem.url) {
            const mainFilename = fileItem.filename || 'media_file.jpg';
            const destPath = path.join(destinationDirectory, mainFilename);
            await this.downloadFileWithProgress(fileItem.url, destPath, (pct, dl, total) => {
                if (onProgress) onProgress({ phase: 'main', file: mainFilename, percent: pct, downloaded: dl, total });
            });
            downloadedFiles.push(destPath);
        }

        // 2. Download do arquivo RAW (ARW) se existir separadamente
        if (fileItem.rawUrl) {
            let rawFilename = fileItem.filename.replace(/\.[^/.]+$/, "") + '.ARW';
            const destRawPath = path.join(destinationDirectory, rawFilename);
            await this.downloadFileWithProgress(fileItem.rawUrl, destRawPath, (pct, dl, total) => {
                if (onProgress) onProgress({ phase: 'raw', file: rawFilename, percent: pct, downloaded: dl, total });
            });
            downloadedFiles.push(destRawPath);
        }

        return downloadedFiles;
    }

    /**
     * Helper de stream para download HTTP com progresso
     */
    downloadFileWithProgress(url, destPath, progressCallback) {
        return new Promise((resolve, reject) => {
            const fileStream = fs.createWriteStream(destPath);
            const clientModule = url.startsWith('https') ? https : http;

            const req = clientModule.get(url, (res) => {
                if (res.statusCode !== 200) {
                    fileStream.close();
                    fs.unlink(destPath, () => {});
                    return reject(new Error(`Falha no download. HTTP ${res.statusCode}`));
                }

                const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
                let downloadedBytes = 0;

                res.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    if (progressCallback && totalBytes > 0) {
                        const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
                        progressCallback(percent, downloadedBytes, totalBytes);
                    }
                });

                res.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve(destPath);
                });
            });

            req.on('error', (err) => {
                fileStream.close();
                fs.unlink(destPath, () => {});
                reject(err);
            });

            fileStream.on('error', (err) => {
                fs.unlink(destPath, () => {});
                reject(err);
            });
        });
    }
}

module.exports = SonyCameraProvider;
