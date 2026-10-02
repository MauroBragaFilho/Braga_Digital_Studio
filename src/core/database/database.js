const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const logger = require('../../services/logService');

const BACKUP_KEEP = 5; // Quantidade de backups datados mantidos por tipo (daily / premigrate)

class DBManager {
    constructor() {
        this.db = null;
        this.dbPath = null;
        this.backupDir = null;
        this.SQL = null;
        this.saveTimer = null;
        this.persisting = false;  // [FASE 3] Evita persistências concorrentes
        this.dirty = false;       // Houve escrita pedida enquanto uma gravação estava em andamento
        this.epoch = 0;           // Incrementa a cada persistSync: invalida gravações assíncronas mais antigas
        this.mainIsValid = false; // O arquivo atual em disco já foi validado (seguro de virar .bak)
    }

    /** Abre um buffer como banco e roda quick_check. Lança erro se inválido. */
    _openValidated(bytes) {
        const db = new this.SQL.Database(bytes);
        try {
            const r = db.exec('PRAGMA quick_check');
            const v = r[0] && r[0].values[0] ? r[0].values[0][0] : null;
            if (v !== 'ok') throw new Error(`quick_check: ${v}`);
            return db;
        } catch (e) {
            try { db.close(); } catch (_) {}
            throw e;
        }
    }

    /** Validação leve (abre e lê sqlite_master) usada a cada gravação. */
    _validateBytes(buffer) {
        const db = new this.SQL.Database(buffer);
        try {
            db.exec('SELECT count(*) FROM sqlite_master');
        } finally {
            try { db.close(); } catch (_) {}
        }
    }

    _tryLoad(file) {
        try {
            if (!fs.existsSync(file)) return null;
            return this._openValidated(fs.readFileSync(file));
        } catch (e) {
            logger.warn(`[DBManager] Falha ao carregar ${path.basename(file)}: ${e.message}`);
            return null;
        }
    }

    _listBackups(prefix) {
        try {
            return fs.readdirSync(this.backupDir)
                .filter(f => f.startsWith(prefix) && f.endsWith('.db'))
                .sort().reverse(); // nomes datados: mais novo primeiro
        } catch (_) { return []; }
    }

    _pruneBackups(prefix) {
        for (const f of this._listBackups(prefix).slice(BACKUP_KEEP)) {
            try { fs.unlinkSync(path.join(this.backupDir, f)); } catch (_) {}
        }
    }

    /**
     * Cria um backup datado (backups/bds-<tag>-<stamp>.db) a partir do estado atual.
     * Retorna o caminho ou null. Mantém só os últimos BACKUP_KEEP por tag.
     */
    createBackup(tag, { oncePerDay = false } = {}) {
        if (!this.db || !this.dbPath) return null;
        try {
            fs.mkdirSync(this.backupDir, { recursive: true });
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
            const stamp = oncePerDay ? day : `${day}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            const target = path.join(this.backupDir, `bds-${tag}-${stamp}.db`);
            if (oncePerDay && fs.existsSync(target)) return null;
            this.persistSync();
            if (!this.mainIsValid) return null; // nunca copia banco não validado
            fs.copyFileSync(this.dbPath, target);
            this._pruneBackups(`bds-${tag}-`);
            return target;
        } catch (e) {
            logger.warn(`[DBManager] Não foi possível criar backup (${tag}): ${e.message}`);
            return null;
        }
    }

    async init(dataDir) {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        this.dbPath = path.join(dataDir, 'bds.db');
        this.backupDir = path.join(dataDir, 'backups');

        this.SQL = await initSqlJs({
            locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
        });

        let needsWrite = false;
        if (fs.existsSync(this.dbPath)) {
            this.db = this._tryLoad(this.dbPath);
            if (this.db) {
                this.mainIsValid = true;
            } else {
                // Banco principal inválido: preserva o arquivo ruim e tenta .bak e backups datados
                try { fs.copyFileSync(this.dbPath, `${this.dbPath}.corrupt-${Date.now()}`); } catch (_) {}
                const candidates = [`${this.dbPath}.bak`, ...this._listBackups('bds-').map(f => path.join(this.backupDir, f))];
                for (const c of candidates) {
                    this.db = this._tryLoad(c);
                    if (this.db) {
                        logger.warn(`[DBManager] Banco principal corrompido. Restaurado de ${path.basename(c)}`);
                        break;
                    }
                }
                if (!this.db) {
                    logger.error('[DBManager] Banco corrompido e sem backup válido. Criando novo banco.');
                    this.db = new this.SQL.Database();
                }
                needsWrite = true;
            }
        } else {
            this.db = new this.SQL.Database();
            needsWrite = true;
        }

        this._applyPrepareWrapper();

        // Ativando foreign_keys e garantindo encoding UTF-8
        this.db.run("PRAGMA encoding = 'UTF-8';");
        this.db.exec('PRAGMA foreign_keys = ON;');

        // mainIsValid=false aqui: o .bak existente não é sobrescrito pelo arquivo ruim
        if (needsWrite) this.persistSync();

        // Backup diário (um por dia, últimos BACKUP_KEEP)
        if (this.mainIsValid) this.createBackup('daily', { oncePerDay: true });
    }

    /** Intercepta .prepare para imitar a API do better-sqlite3 e auto-liberar a memória */
    _applyPrepareWrapper() {
        if (this.db.__bdsWrapped) return;
        this.db.__bdsWrapped = true;
        const originalPrepare = this.db.prepare.bind(this.db);
        this.db.prepare = (sql) => {
            const stmt = originalPrepare(sql);

            const get = (...params) => {
                stmt.bind(params);
                const res = stmt.step() ? stmt.getAsObject() : null;
                stmt.free();
                return res;
            };

            const all = (...params) => {
                stmt.bind(params);
                const res = [];
                while(stmt.step()) {
                    res.push(stmt.getAsObject());
                }
                stmt.free();
                return res;
            };

            const run = (...params) => {
                stmt.run(params);
                stmt.free();
                // changes precisa ser lido ANTES de qualquer outro SELECT
                const changes = this.db.getRowsModified();
                this.schedulePersist();

                try {
                    // [PERF] Extrai o id diretamente do array retornado por exec()
                    const result = this.db.exec("SELECT last_insert_rowid()")[0];
                    const id = result ? result.values[0][0] : 0;
                    return { changes, lastInsertRowid: id };
                } catch(e) {
                    return { changes, lastInsertRowid: 0 };
                }
            };

            return { get, all, run, free: () => stmt.free() };
        };
    }

    get() {
        if (!this.db) {
            throw new Error('Banco de dados não foi inicializado. Chame init() primeiro.');
        }
        return this.db;
    }

    schedulePersist() {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.persistAsync().catch(err => {
                logger.error('[DBManager] Erro ao persistir banco:', { error: err.message });
            });
        }, 1000); // Salva 1000ms após a última escrita de forma agrupada
    }

    /** export() do sql.js reinicia a conexão e perde foreign_keys: reaplica sempre. */
    _export() {
        const data = this.db.export();
        try { this.db.exec('PRAGMA foreign_keys = ON;'); } catch (_) {}
        return Buffer.from(data);
    }

    async persistAsync() {
        if (!this.db || !this.dbPath) return;
        // Já há gravação em andamento: marca para regravar ao terminar (não descarta)
        if (this.persisting) { this.dirty = true; return; }
        this.persisting = true;
        const epoch = this.epoch;
        const tempPath = `${this.dbPath}.tmp`;
        try {
            const buffer = this._export();
            // [FASE 3] Persistência atômica: escreve em .tmp, valida e renomeia
            await fs.promises.writeFile(tempPath, buffer);
            this._validateBytes(buffer);
            // Um persistSync mais novo já gravou (ou o banco foi fechado): snapshot obsoleto
            if (epoch !== this.epoch || !this.db) {
                await fs.promises.unlink(tempPath).catch(() => {});
                return;
            }
            // Backup .bak do arquivo atual somente se ele foi validado
            if (this.mainIsValid && fs.existsSync(this.dbPath)) {
                await fs.promises.copyFile(this.dbPath, `${this.dbPath}.bak`).catch(() => {});
            }
            // No Windows, rename para um destino existente pode falhar com EPERM
            try {
                await fs.promises.rename(tempPath, this.dbPath);
            } catch (renameErr) {
                if (fs.existsSync(this.dbPath)) await fs.promises.unlink(this.dbPath);
                await fs.promises.rename(tempPath, this.dbPath);
            }
            this.mainIsValid = true;
        } catch (err) {
            logger.error('[DBManager] Erro na persistência assíncrona:', { error: err.message });
            await fs.promises.unlink(tempPath).catch(() => {});
        } finally {
            this.persisting = false;
            if (this.dirty && this.db) {
                this.dirty = false;
                this.schedulePersist();
            }
        }
    }

    /**
     * Gravação SÍNCRONA e atômica (.tmp -> rename). Usar no encerramento do app.
     * Cancela o timer pendente e invalida gravações assíncronas em andamento.
     */
    persistSync() {
        if (!this.db || !this.dbPath) return false;
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
        this.epoch++;
        this.dirty = false;
        const tempPath = `${this.dbPath}.tmp.sync`;
        try {
            const buffer = this._export();
            fs.writeFileSync(tempPath, buffer);
            this._validateBytes(buffer);
            if (this.mainIsValid && fs.existsSync(this.dbPath)) {
                try { fs.copyFileSync(this.dbPath, `${this.dbPath}.bak`); } catch (_) {}
            }
            try {
                fs.renameSync(tempPath, this.dbPath);
            } catch (renameErr) {
                if (fs.existsSync(this.dbPath)) fs.unlinkSync(this.dbPath);
                fs.renameSync(tempPath, this.dbPath);
            }
            this.mainIsValid = true;
            return true;
        } catch (err) {
            logger.error('[DBManager] Erro na persistência síncrona:', { error: err.message });
            try { fs.unlinkSync(tempPath); } catch (_) {}
            return false;
        }
    }

    /** Compat: antigo nome síncrono */
    persist() {
        return this.persistSync();
    }

    /** Seguro e idempotente: grava de forma síncrona e fecha o banco. */
    close() {
        if (!this.db) return;
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
        this.persistSync();
        try { this.db.close(); } catch (_) {}
        this.db = null;
    }
}

module.exports = new DBManager();
