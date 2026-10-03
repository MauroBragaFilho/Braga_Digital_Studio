const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const logger = require('../../services/logService');

const BACKUP_KEEP = 5; // Quantidade de backups datados mantidos por tipo (daily / premigrate)
const PERSIST_DEBOUNCE_MS = 1000;   // Agrupa escritas: grava 1 s após a última
const PERSIST_MAX_WAIT_MS = 8000;   // Sob escrita contínua, força a gravação a cada ~8 s (maxWait)
const BAK_INTERVAL_MS = 10 * 60 * 1000; // O .bak (cópia do arquivo anterior) é renovado no máximo a cada 10 min nas gravações assíncronas
const STMT_CACHE_MAX = 300;         // Teto de statements compilados reutilizáveis (LRU simples)

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
        this.firstDirtyAt = 0;    // Instante da primeira escrita ainda não gravada (base do maxWait)
        this.lastBakAt = 0;       // Última vez que o .bak foi renovado
        this.writeSeq = 0;        // Incrementa a cada escrita efetiva via prepare().run (base de caches de leitura)
        this.stmtCache = new Map(); // SQL -> Statement compilado (reutilizado com reset)
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

    /**
     * Validação barata do .tmp recém-gravado (a cada gravação assíncrona): assinatura 'SQLite format 3',
     * tamanho de página válido, tamanho do arquivo coerente com o buffer e com a contagem de páginas do cabeçalho.
     * A validação completa (abrir o banco) fica para persistSync/init.
     */
    _validateTmpCheap(buffer, fileSize) {
        if (buffer.length < 100) throw new Error('arquivo .tmp pequeno demais');
        if (buffer.toString('latin1', 0, 15) !== 'SQLite format 3') throw new Error('assinatura SQLite ausente no .tmp');
        if (fileSize !== buffer.length) throw new Error(`tamanho do .tmp incoerente (${fileSize} != ${buffer.length})`);
        let pageSize = buffer.readUInt16BE(16);
        if (pageSize === 1) pageSize = 65536;
        if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) throw new Error(`tamanho de página inválido (${pageSize})`);
        if (buffer.length % pageSize !== 0) throw new Error('tamanho do .tmp não é múltiplo da página');
        const pages = buffer.readUInt32BE(28);
        if (pages > 0 && pages * pageSize !== buffer.length) throw new Error('contagem de páginas do cabeçalho incoerente');
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

    /** Descarta o cache de statements (sql.js já os libera em export()/close()). */
    _clearStmtCache() {
        this.stmtCache.clear();
    }

    /**
     * Obtém (ou compila) o statement do SQL. Statements são reutilizados com reset entre usos:
     * o wrapper é síncrono e nunca mantém um statement aberto entre chamadas, então reuso é seguro.
     */
    _getStmt(sql, rawPrepare) {
        let stmt = this.stmtCache.get(sql);
        if (stmt) {
            this.stmtCache.delete(sql); // reinsere para manter ordem LRU
            this.stmtCache.set(sql, stmt);
            return stmt;
        }
        stmt = rawPrepare(sql);
        if (this.stmtCache.size >= STMT_CACHE_MAX) {
            const oldestKey = this.stmtCache.keys().next().value;
            const old = this.stmtCache.get(oldestKey);
            this.stmtCache.delete(oldestKey);
            try { old.free(); } catch (_) {}
        }
        this.stmtCache.set(sql, stmt);
        return stmt;
    }

    /** Intercepta .prepare para imitar a API do better-sqlite3 com cache de statements por SQL */
    _applyPrepareWrapper() {
        if (this.db.__bdsWrapped) return;
        this.db.__bdsWrapped = true;
        const originalPrepare = this.db.prepare.bind(this.db);
        const isInsert = (sql) => /^\s*(INSERT|REPLACE)\b/i.test(sql);
        const isDml = (sql) => /^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i.test(sql);

        this.db.prepare = (sql) => {
            // Compila já aqui para que SQL inválido continue falhando em prepare()
            this._getStmt(sql, originalPrepare);
            const insert = isInsert(sql);
            const dml = isDml(sql);

            // Os métodos resolvem o statement no uso: se o sql.js o liberou (export/close), recompila.
            const use = (fn) => {
                const stmt = this._getStmt(sql, originalPrepare);
                try {
                    return fn(stmt);
                } finally {
                    try { stmt.reset(); } catch (_) {}
                }
            };

            const get = (...params) => use((stmt) => {
                stmt.bind(params);
                return stmt.step() ? stmt.getAsObject() : null;
            });

            const all = (...params) => use((stmt) => {
                stmt.bind(params);
                const res = [];
                while (stmt.step()) res.push(stmt.getAsObject());
                return res;
            });

            const run = (...params) => {
                use((stmt) => { stmt.run(params); });
                // changes precisa ser lido ANTES de qualquer outro SELECT
                const changes = this.db.getRowsModified();
                // Só agenda gravação se algo mudou (ou se não é DML, ex.: DDL)
                if (changes > 0 || !dml) { this.writeSeq++; this.schedulePersist(); }

                if (insert) {
                    // Inserts leem o rowid na hora (valor correto mesmo se lido depois de outros statements)
                    let id = 0;
                    try {
                        const result = this.db.exec('SELECT last_insert_rowid()')[0];
                        id = result ? result.values[0][0] : 0;
                    } catch (e) { id = 0; }
                    return { changes, lastInsertRowid: id };
                }
                // UPDATE/DELETE/DDL: lastInsertRowid sob demanda (getter lazy), sem exec extra a cada run()
                const self = this;
                return {
                    changes,
                    get lastInsertRowid() {
                        try {
                            const result = self.db.exec('SELECT last_insert_rowid()')[0];
                            return result ? result.values[0][0] : 0;
                        } catch (e) { return 0; }
                    }
                };
            };

            // free() é no-op: o statement pertence ao cache
            return { get, all, run, free: () => {} };
        };
    }

    get() {
        if (!this.db) {
            throw new Error('Banco de dados não foi inicializado. Chame init() primeiro.');
        }
        return this.db;
    }

    /**
     * Agenda a gravação com debounce de 1 s e maxWait de 8 s: sob escrita contínua o debounce
     * sozinho adiaria para sempre; o teto garante gravação periódica.
     */
    schedulePersist() {
        const now = Date.now();
        if (!this.firstDirtyAt) this.firstDirtyAt = now;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        const wait = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, this.firstDirtyAt + PERSIST_MAX_WAIT_MS - now));
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.persistAsync().catch(err => {
                logger.error('[DBManager] Erro ao persistir banco:', { error: err.message });
            });
        }, wait);
        if (this.saveTimer.unref) this.saveTimer.unref();
    }

    /** export() do sql.js reinicia a conexão e perde foreign_keys: reaplica sempre. */
    _export() {
        const data = this.db.export();
        this._clearStmtCache(); // export() do sql.js libera todos os statements abertos
        try { this.db.exec('PRAGMA foreign_keys = ON;'); } catch (_) {}
        // Sem cópia extra: Buffer sobre a mesma memória do Uint8Array exportado
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }

    async persistAsync() {
        if (!this.db || !this.dbPath) return;
        // Já há gravação em andamento: marca para regravar ao terminar (não descarta)
        if (this.persisting) { this.dirty = true; return; }
        this.persisting = true;
        const epoch = this.epoch;
        const tempPath = `${this.dbPath}.tmp`;
        try {
            this.firstDirtyAt = 0; // escritas a partir daqui iniciam novo ciclo de maxWait
            const buffer = this._export();
            // [FASE 3] Persistência atômica: escreve em .tmp, valida (barato) e renomeia
            await fs.promises.writeFile(tempPath, buffer);
            const tmpStat = await fs.promises.stat(tempPath);
            this._validateTmpCheap(buffer, tmpStat.size);
            // Um persistSync mais novo já gravou (ou o banco foi fechado): snapshot obsoleto
            if (epoch !== this.epoch || !this.db) {
                await fs.promises.unlink(tempPath).catch(() => {});
                return;
            }
            // Backup .bak do arquivo atual somente se ele foi validado e no máximo 1x por intervalo
            // (o .bak também é renovado em persistSync: shutdown e antes de migrar)
            if (this.mainIsValid && Date.now() - this.lastBakAt >= BAK_INTERVAL_MS && fs.existsSync(this.dbPath)) {
                await fs.promises.copyFile(this.dbPath, `${this.dbPath}.bak`).then(() => { this.lastBakAt = Date.now(); }).catch(() => {});
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
        this.firstDirtyAt = 0;
        const tempPath = `${this.dbPath}.tmp.sync`;
        try {
            const buffer = this._export();
            fs.writeFileSync(tempPath, buffer);
            this._validateBytes(buffer);
            if (this.mainIsValid && fs.existsSync(this.dbPath)) {
                try { fs.copyFileSync(this.dbPath, `${this.dbPath}.bak`); this.lastBakAt = Date.now(); } catch (_) {}
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
        this._clearStmtCache();
        try { this.db.close(); } catch (_) {}
        this.db = null;
    }
}

module.exports = new DBManager();
