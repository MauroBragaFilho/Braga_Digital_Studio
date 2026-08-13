const logger = require('../../../services/logService');

class BdsmClient {
    constructor(ip, port) {
        this.baseUrl = `http://${ip}:${port}/api`;
    }

    async _fetch(endpoint, options = {}, silent = false) {
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 10000);
            const response = await fetch(`${this.baseUrl}${endpoint}`, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(id);
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch(e) {
            if (!silent) logger.error(`[BdsmClient] Erro na requisição para ${endpoint}: ${e.message}`);
            throw e;
        }
    }

    async getInfo(silent = false) {
        return this._fetch('/discovery/info', {}, silent);
    }

    async getMedia() {
        return this._fetch('/media');
    }

    getMediaDownloadUrl(id) {
        return `${this.baseUrl}/media/${encodeURIComponent(id)}/download`;
    }

    getMediaThumbnailUrl(id) {
        return `${this.baseUrl}/media/${encodeURIComponent(id)}/thumbnail`;
    }

    async deleteMedia(id) {
        const response = await fetch(`${this.baseUrl}/media/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return true;
    }

    async getLuts() {
        return this._fetch('/luts');
    }

    getLutDownloadUrl(relativePath) {
        // Assumindo que a rota de download seja essa, apesar de não especificada claramente (provavelmente /api/luts/{relativePath} ou download)
        return `${this.baseUrl}/luts/${encodeURIComponent(relativePath)}`;
    }

    async uploadLut(filePath, destPath) {
        const fs = require('fs');
        const path = require('path');
        
        try {
            const fileBuffer = fs.readFileSync(filePath);
            const blob = new Blob([fileBuffer], { type: 'application/octet-stream' });
            
            const formData = new FormData();
            formData.append('relativePath', destPath);
            formData.append('file', blob, path.basename(filePath));

            const response = await fetch(`${this.baseUrl}/luts/upload`, {
                method: 'POST',
                body: formData
            });

            if (response.status === 409) {
                throw new Error('CONFLICT: Um arquivo com o mesmo nome e hash diferente já existe no celular.');
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return true;
        } catch(e) {
            logger.error(`[BdsmClient] Erro no upload de LUT: ${e.message}`);
            throw e;
        }
    }

    async deleteLut(relativePath) {
        // Encodando as partes do path
        const parts = relativePath.split('/').map(encodeURIComponent).join('/');
        const response = await fetch(`${this.baseUrl}/luts/${parts}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return true;
    }
}

module.exports = BdsmClient;
