const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const BdsmClient = require('./BdsmClient');
const logger = require('../../../services/logService');
const { EventEmitter } = require('events');

class LutSyncService extends EventEmitter {
    constructor(lutsDir) {
        super();
        this.lutsDir = lutsDir;
    }

    _getFileHash(filePath) {
        if (!fs.existsSync(filePath)) return null;
        const fileBuffer = fs.readFileSync(filePath);
        const hashSum = crypto.createHash('sha256');
        hashSum.update(fileBuffer);
        return hashSum.digest('hex');
    }

    _walkDir(dir, base = '') {
        let results = [];
        const list = fs.readdirSync(dir);
        list.forEach(file => {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);
            const relativePath = path.join(base, file).replace(/\\/g, '/');
            if (stat && stat.isDirectory()) {
                results = results.concat(this._walkDir(filePath, relativePath));
            } else {
                if (file.toLowerCase().endsWith('.cube') || file.toLowerCase().endsWith('.3dl')) {
                    results.push({
                        relativePath: relativePath,
                        absolutePath: filePath,
                        hash: this._getFileHash(filePath)
                    });
                }
            }
        });
        return results;
    }

    async analyzeSync(deviceIp, devicePort) {
        const client = new BdsmClient(deviceIp, devicePort);
        
        // 1. Obter LUTs Locais
        if (!fs.existsSync(this.lutsDir)) fs.mkdirSync(this.lutsDir, { recursive: true });
        const localLuts = this._walkDir(this.lutsDir);
        
        // 2. Obter LUTs Remotos
        let remoteLuts = [];
        try {
            remoteLuts = await client.getLuts();
        } catch(e) {
            throw new Error('Falha ao conectar com o dispositivo para listar LUTs');
        }

        const plan = {
            upload: [],
            download: [],
            conflict: [],
            identical: []
        };

        // Comparar
        const localMap = new Map();
        localLuts.forEach(l => localMap.set(l.relativePath, l));

        const remoteMap = new Map();
        remoteLuts.forEach(l => remoteMap.set(l.relativePath, l));

        // Checar os que estão no local
        for (const local of localLuts) {
            if (!remoteMap.has(local.relativePath)) {
                plan.upload.push(local);
            } else {
                const remote = remoteMap.get(local.relativePath);
                if (local.hash !== remote.hash) {
                    plan.conflict.push({ local, remote });
                } else {
                    plan.identical.push(local);
                }
            }
        }

        // Checar os que estão APENAS no remoto
        for (const remote of remoteLuts) {
            if (!localMap.has(remote.relativePath)) {
                plan.download.push(remote);
            }
        }

        return plan;
    }

    async executeSync(deviceIp, devicePort, plan) {
        const client = new BdsmClient(deviceIp, devicePort);
        let completed = 0;
        const total = plan.upload.length + plan.download.length + plan.conflict.length; // para simplificar, se conflitos vierem resolvidos

        this.emit('progress', { completed, total, current: 'Iniciando sincronização...' });

        // Download
        for (const item of plan.download) {
            this.emit('progress', { completed, total, current: `Baixando: ${item.relativePath}` });
            try {
                const downloadUrl = client.getLutDownloadUrl(item.relativePath);
                const response = await fetch(downloadUrl);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const buffer = await response.arrayBuffer();
                
                const dest = path.join(this.lutsDir, item.relativePath);
                const destDir = path.dirname(dest);
                if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                
                fs.writeFileSync(dest, Buffer.from(buffer));
                completed++;
            } catch(e) {
                logger.error(`Erro ao baixar LUT ${item.relativePath}: ${e.message}`);
            }
        }

        // Upload
        for (const item of plan.upload) {
            this.emit('progress', { completed, total, current: `Enviando: ${item.relativePath}` });
            try {
                await client.uploadLut(item.absolutePath, item.relativePath);
                completed++;
            } catch(e) {
                logger.error(`Erro ao enviar LUT ${item.relativePath}: ${e.message}`);
            }
        }

        // Conflict (Assume that the UI passed a "resolution" field inside each conflict object)
        // resolution pode ser: 'keep_both', 'overwrite_remote', 'overwrite_local'
        for (const item of plan.conflict) {
            this.emit('progress', { completed, total, current: `Resolvendo conflito: ${item.local.relativePath}` });
            try {
                if (item.resolution === 'overwrite_remote') {
                    await client.uploadLut(item.local.absolutePath, item.local.relativePath);
                } else if (item.resolution === 'overwrite_local') {
                    const downloadUrl = client.getLutDownloadUrl(item.remote.relativePath);
                    const response = await fetch(downloadUrl);
                    const buffer = await response.arrayBuffer();
                    fs.writeFileSync(item.local.absolutePath, Buffer.from(buffer));
                } else {
                    // keep_both
                    const parsed = path.parse(item.local.relativePath);
                    const newPath = path.join(parsed.dir, `${parsed.name}_mobile${parsed.ext}`).replace(/\\/g, '/');
                    
                    // Baixa o remoto como _mobile
                    const downloadUrl = client.getLutDownloadUrl(item.remote.relativePath);
                    const response = await fetch(downloadUrl);
                    const buffer = await response.arrayBuffer();
                    
                    const dest = path.join(this.lutsDir, newPath);
                    fs.writeFileSync(dest, Buffer.from(buffer));
                }
                completed++;
            } catch(e) {
                logger.error(`Erro ao resolver conflito LUT ${item.local.relativePath}: ${e.message}`);
            }
        }

        this.emit('done');
    }
}

module.exports = LutSyncService;
