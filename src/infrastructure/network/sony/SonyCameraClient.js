const http = require('http');
const logger = require('../../../services/logService');

class SonyCameraClient {
    /**
     * @param {string} endpointURL - Ex: 'http://192.168.122.1:8080/sony'
     */
    constructor(endpointURL = 'http://192.168.122.1:8080/sony') {
        this.endpointURL = endpointURL.replace(/\/+$/, '');
        this.requestId = 1;
    }

    /**
     * Executa chamada JSON-RPC para um serviço específico da Sony (ex: 'camera', 'avContent', 'system')
     * @param {string} service - 'camera' | 'avContent' | 'system'
     * @param {string} method - Nome do método JSON-RPC
     * @param {Array} params - Parâmetros
     * @param {string} version - Versão da API (padrão '1.0')
     * @param {number} timeout - Timeout em ms
     */
    async call(service, method, params = [], version = '1.0', timeout = 5000) {
        const id = this.requestId++;
        const payload = JSON.stringify({
            method,
            params,
            id,
            version
        });

        const url = new URL(`${this.endpointURL}/${service}`);

        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: url.hostname,
                port: url.port || 8080,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                },
                timeout
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            const err = new Error(`Sony RPC Error [${parsed.error[0]}]: ${parsed.error[1]}`);
                            err.code = parsed.error[0];
                            return reject(err);
                        }
                        resolve(parsed.result || parsed.results || []);
                    } catch (e) {
                        reject(new Error(`Failed to parse JSON response: ${e.message}`));
                    }
                });
            });

            req.on('error', (err) => {
                reject(err);
            });

            req.on('timeout', () => {
                req.destroy(new Error(`Sony API call timed out after ${timeout}ms: ${method}`));
            });

            req.write(payload);
            req.end();
        });
    }

    // --- Métodos de Conveniência (Service: camera) ---

    async getAvailableApiList() {
        try {
            const res = await this.call('camera', 'getAvailableApiList');
            return res[0] || [];
        } catch (e) {
            logger.warn(`[SonyCameraClient] getAvailableApiList falhou: ${e.message}`);
            return [];
        }
    }

    async getEvent(polling = false) {
        // version "1.0" or "1.1" depending on payload
        return await this.call('camera', 'getEvent', [polling], '1.0');
    }

    async startRecMode() {
        return await this.call('camera', 'startRecMode');
    }

    // --- Métodos de Conveniência (Service: avContent) ---

    async getStorageInformation() {
        try {
            const res = await this.call('avContent', 'getStorageInformation');
            return res[0] || [];
        } catch (e) {
            logger.warn(`[SonyCameraClient] getStorageInformation falhou: ${e.message}`);
            return [];
        }
    }

    /**
     * Lista diretórios ou conteúdos do cartão
     * @param {Object} options
     * @param {string} options.uri - URI do container (ex: 'storage:memoryCard1' ou 'directory:...')
     * @param {number} options.stIndex - Índice inicial
     * @param {number} options.cnt - Quantidade de itens
     * @param {string} options.type - Tipos a listar (ex: '["still", "movie_mp4"]')
     * @param {string} options.view - 'date' ou 'flat'
     */
    async getContentList(options = {}) {
        const params = [{
            uri: options.uri || 'storage:memoryCard1',
            stIndex: options.stIndex || 0,
            cnt: options.cnt || 50,
            view: options.view || 'flat',
            sort: options.sort || 'descending'
        }];

        if (options.types) {
            params[0].types = options.types;
        }

        try {
            const res = await this.call('avContent', 'getContentList', params, '1.3');
            return res[0] || [];
        } catch (e) {
            // Se falhar na 1.3, tenta na 1.0 (compatibilidade com versões mais antigas de firmware)
            const res = await this.call('avContent', 'getContentList', params, '1.0');
            return res[0] || [];
        }
    }

    async getSourceList() {
        try {
            const res = await this.call('avContent', 'getSourceList', [{ scheme: 'storage' }]);
            return res[0] || [];
        } catch (e) {
            return [];
        }
    }
}

module.exports = SonyCameraClient;
