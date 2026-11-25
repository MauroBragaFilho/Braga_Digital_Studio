const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const BdsmClient = require('./BdsmClient');
const { BdsmError } = BdsmClient;
const logger = require('../../services/logService');
const { EventEmitter } = require('events');
const { PathGuard } = require('../../infrastructure/filesystem/PathGuard');
const { LUT_EXT, MAX_SEGMENTS, PHONE_MAX_PATH, COLLECTION_MAX_ENTRIES } = require('../luts/lutConstants');
const { walkTree } = require('../luts/lutTree');

const LUT_EXTENSIONS = new Set(['.cube', '.3dl']);

// O celular só aceita .cube, com até 4 segmentos e 255 caracteres (LutLibraryService.resolveSafe). A coleção do
// computador usa o MESMO limite de níveis (lutConstants.MAX_SEGMENTS): a tela e o celular veem a mesma árvore.
const PHONE_LUT_EXTENSION = LUT_EXT;
const PHONE_MAX_SEGMENTS = MAX_SEGMENTS;
const SCAN_DEADLINE_MS = 60000;
const MSG_TOO_MANY = 'A pasta de LUTs tem arquivos demais para sincronizar.';

/** Falhas que invalidam o resto da sincronização (não adianta tentar o próximo arquivo). */
const FATAL_CODES = new Set(['PAIRING_REQUIRED', 'DEVICE_UNREACHABLE']);

/**
 * Sincronização de LUTs com o celular.
 *
 * O servidor do celular só lista (GET /api/luts), recebe (POST /api/luts/upload) e apaga
 * (DELETE /api/luts/{caminho}) LUTs: NÃO existe download. Por isso a sincronização é de ida (PC -> celular):
 *  - LUTs só no computador: enviadas;
 *  - LUTs só no celular: apenas listadas (`remoteOnly`), não dá para baixá-las;
 *  - mesmo caminho com conteúdo diferente (conflito): por padrão nada muda; com resolution = 'overwrite_remote'
 *    a LUT do celular é apagada e a do computador enviada (o celular recusa sobrescrever com 409).
 */
class LutSyncService extends EventEmitter {
    /**
     * @param {string} lutsDir
     * @param {{ lutManager?: import('../luts/LutManager'), maxEntries?: number }} [deps] com o LutManager, o hash do conteúdo
     *   vem do cache persistente (não relê a coleção inteira a cada análise); maxEntries: teto de entradas lidas (o da coleção)
     */
    constructor(lutsDir, { lutManager = null, maxEntries = COLLECTION_MAX_ENTRIES } = {}) {
        super();
        this.lutsDir = lutsDir;
        this.lutManager = lutManager;
        this.maxEntries = maxEntries;
    }

    /**
     * Valida um relativePath vindo do celular/renderer: sem '..', sem caminho absoluto/drive/bytes nulos,
     * só .cube/.3dl, e o destino resolvido precisa ficar dentro da pasta de LUTs.
     * @returns {string} caminho absoluto seguro dentro de lutsDir
     */
    _safeDest(relativePath) {
        if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 512 || relativePath.includes('\0')) {
            throw new Error('Caminho de LUT inválido.');
        }
        const norm = relativePath.replace(/\\/g, '/');
        if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) throw new Error(`Caminho de LUT inválido: ${relativePath}`);
        const segments = norm.split('/');
        if (segments.some((s) => s === '' || s === '.' || s === '..')) throw new Error(`Caminho de LUT inválido: ${relativePath}`);
        if (!LUT_EXTENSIONS.has(path.extname(norm).toLowerCase())) throw new Error(`Extensão de LUT não permitida: ${relativePath}`);
        return PathGuard.assertWithin(this.lutsDir, path.join(this.lutsDir, ...segments));
    }

    /** O celular aceita este caminho relativo? (.cube, até 4 segmentos, 255 caracteres, sem barra invertida/controle) */
    _phoneAccepts(relativePath) {
        if (typeof relativePath !== 'string' || relativePath.length > PHONE_MAX_PATH) return false;
        if (path.extname(relativePath).toLowerCase() !== PHONE_LUT_EXTENSION) return false;
        if (/[\\\u0000-\u001f\u007f]/.test(relativePath)) return false;
        const seg = relativePath.split('/');
        return seg.length <= PHONE_MAX_SEGMENTS && !seg.some((s) => s === '' || s === '.' || s === '..');
    }

    /** SHA-256 do conteúdo: do cache do LutManager (quando há) ou lido na hora. null se não foi possível ler. */
    async _hashOf(filePath) {
        if (this.lutManager) return this.lutManager.hashOfAsync(filePath);
        try {
            return crypto.createHash('sha256').update(await fs.promises.readFile(filePath)).digest('hex');
        } catch (_) {
            return null;
        }
    }

    /**
     * As LUTs locais que o celular aceita, pela MESMA regra da lista da tela (walkTree: .cube, até 4 segmentos,
     * sem links, sem arquivos ocultos). Pasta com arquivos demais interrompe a análise com uma mensagem clara.
     */
    async _listLocal() {
        const walk = await walkTree(this.lutsDir, { maxSegments: PHONE_MAX_SEGMENTS, exts: [PHONE_LUT_EXTENSION], maxEntries: this.maxEntries, deadlineMs: SCAN_DEADLINE_MS });
        if (walk.rootError) throw walk.rootError;
        if (walk.truncated) throw new Error(MSG_TOO_MANY);
        const local = [];
        for (const file of walk.files) {
            if (!this._phoneAccepts(file.relPath)) continue;
            const hash = await this._hashOf(file.abs);
            if (!hash) {
                logger.warn(`[LutSync] LUT local ignorada (não foi possível ler o conteúdo): ${file.relPath}`);
                continue;
            }
            local.push({ relativePath: file.relPath, absolutePath: file.abs, hash });
        }
        return local;
    }

    async analyzeSync(deviceIp, devicePort) {
        const client = new BdsmClient(deviceIp, devicePort);

        // 1. LUTs locais que o celular aceita
        if (!fs.existsSync(this.lutsDir)) fs.mkdirSync(this.lutsDir, { recursive: true });
        const localLuts = await this._listLocal();

        // 2. LUTs do celular
        let remoteLuts = [];
        try {
            remoteLuts = await client.getLuts();
        } catch (e) {
            if (e instanceof BdsmError) throw e; // PAIRING_REQUIRED, DEVICE_UNREACHABLE...
            throw new Error('Falha ao conectar com o dispositivo para listar LUTs');
        }

        // `download` fica sempre vazio (o celular não serve LUTs); `remoteOnly` lista o que só ele tem.
        const plan = { upload: [], download: [], conflict: [], identical: [], remoteOnly: [] };

        const localMap = new Map();
        localLuts.forEach(l => localMap.set(l.relativePath, l));

        // Entradas remotas com caminho inválido são descartadas (nunca chegam ao plano)
        remoteLuts = (Array.isArray(remoteLuts) ? remoteLuts : []).filter((l) => {
            try { this._safeDest(l && l.relativePath); return true; } catch (_) {
                logger.warn(`[LutSync] LUT remota ignorada (caminho inválido): ${l && l.relativePath}`);
                return false;
            }
        });
        const remoteMap = new Map();
        remoteLuts.forEach(l => remoteMap.set(l.relativePath, l));

        for (const local of localLuts) {
            const remote = remoteMap.get(local.relativePath);
            if (!remote) plan.upload.push(local);
            else if (local.hash !== remote.hash) plan.conflict.push({ local, remote });
            else plan.identical.push(local);
        }
        for (const remote of remoteLuts) {
            if (!localMap.has(remote.relativePath)) plan.remoteOnly.push(remote);
        }

        return plan;
    }

    /**
     * Executa o plano. Devolve { completed, failed, skipped, total }; uma falha fatal (pareamento recusado,
     * celular sem resposta) interrompe e é relançada para a tela mostrar o motivo real.
     */
    async executeSync(deviceIp, devicePort, plan) {
        const client = new BdsmClient(deviceIp, devicePort);
        const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
        plan = {
            upload: list(plan && plan.upload).filter((i) => typeof i.relativePath === 'string'),
            conflict: list(plan && plan.conflict).filter((i) => i.local && i.remote && typeof i.local.relativePath === 'string' && typeof i.remote.relativePath === 'string')
        };
        const overwrite = plan.conflict.filter((i) => i.resolution === 'overwrite_remote');
        const skipped = plan.conflict.length - overwrite.length;
        const total = plan.upload.length + overwrite.length;
        let completed = 0;
        let failed = 0;

        this.emit('progress', { completed, total, current: 'Iniciando sincronização...' });

        const attempt = async (label, relativePath, fn) => {
            this.emit('progress', { completed, total, current: `${label}: ${relativePath}` });
            try {
                await fn();
                completed++;
            } catch (e) {
                if (e instanceof BdsmError && FATAL_CODES.has(e.code)) throw e;
                failed++;
                logger.error(`Erro ao sincronizar LUT ${relativePath}: ${e.code || ''} ${e.message}`);
            }
        };

        try {
            for (const item of plan.upload) {
                // O caminho local é reconstruído a partir do relativePath validado (o plano vem do renderer)
                await attempt('Enviando', item.relativePath, async () => {
                    if (!this._phoneAccepts(item.relativePath)) throw new Error('Caminho não aceito pelo celular.');
                    await client.uploadLut(this._safeDest(item.relativePath), item.relativePath);
                });
            }
            for (const item of overwrite) {
                await attempt('Substituindo', item.local.relativePath, async () => {
                    const rel = item.local.relativePath;
                    if (!this._phoneAccepts(rel)) throw new Error('Caminho não aceito pelo celular.');
                    const localPath = this._safeDest(rel);
                    await client.deleteLut(rel);
                    await client.uploadLut(localPath, rel);
                });
            }
        } finally {
            this.emit('done');
        }
        if (skipped) logger.info(`[LutSync] ${skipped} conflito(s) mantido(s) sem alteração.`);
        return { completed, failed, skipped, total };
    }
}

module.exports = LutSyncService;
