const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const logger = require('../../services/logService');

class DBManager {
    constructor() {
        this.db = null;
        this.dbPath = null;
        this.SQL = null;
        this.saveTimer = null;
        this.persisting = false; // [FASE 3] Evita persistências concorrentes
    }

    async init(dataDir) {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        this.dbPath = path.join(dataDir, 'bds.db');
        
        this.SQL = await initSqlJs({
            locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
        });

        if (fs.existsSync(this.dbPath)) {
            // [FASE 3] Se o DB foi corrompido, tenta recuperar do backup .bak
            let bytes = null;
            try {
                bytes = fs.readFileSync(this.dbPath);
                this.db = new this.SQL.Database(bytes);
            } catch (e) {
                const backupPath = `${this.dbPath}.bak`;
                if (fs.existsSync(backupPath)) {
                    logger.warn('[DBManager] Banco principal corrompido. Restaurando do backup .bak');
                    bytes = fs.readFileSync(backupPath);
                    this.db = new this.SQL.Database(bytes);
                    this.persist();
                } else {
                    logger.error('[DBManager] Banco corrompido e sem backup. Criando novo banco.', { error: e.message });
                    this.db = new this.SQL.Database();
                    this.persist();
                }
            }
        } else {
            this.db = new this.SQL.Database();
            this.persist();
        }

        // Interceptando .prepare para imitar a API do better-sqlite3 e auto-liberar a memória
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
                this.schedulePersist();
                
                try {
                    // [PERF] Extrai o id diretamente do array retornado por exec()
                    const result = this.db.exec("SELECT last_insert_rowid()")[0];
                    const id = result ? result.values[0][0] : 0;
                    return { lastInsertRowid: id };
                } catch(e) {
                    return { lastInsertRowid: 0 };
                }
            };
            
            return { get, all, run, free: () => stmt.free() };
        };
        
        // Ativando foreign_keys e garantindo encoding UTF-8
        this.db.run("PRAGMA encoding = 'UTF-8';");
        this.db.exec('PRAGMA foreign_keys = ON;');
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
            this.persistAsync().catch(err => {
                logger.error('[DBManager] Erro ao persistir banco:', { error: err.message });
            });
        }, 1000); // Salva 1000ms após a última escrita de forma agrupada
    }

    async persistAsync() {
        if (!this.db || !this.dbPath) return;
        // [FASE 3] Evita sobrescrever enquanto uma gravação já está em andamento
        if (this.persisting) return;
        this.persisting = true;
        try {
            const data = this.db.export();
            const buffer = Buffer.from(data);
            const tempPath = `${this.dbPath}.tmp`;
            // [FASE 3] Persistência atômica: escreve em .tmp e renomeia
            await fs.promises.writeFile(tempPath, buffer);
            // Faz backup do arquivo atual antes de substituir
            if (fs.existsSync(this.dbPath)) {
                await fs.promises.copyFile(this.dbPath, `${this.dbPath}.bak`).catch(() => {});
            }
            // No Windows, rename para um destino existente falha com EPERM;
            // removemos o destino existente antes de renomear para garantir atomicidade.
            try {
                await fs.promises.rename(tempPath, this.dbPath);
            } catch (renameErr) {
                if (fs.existsSync(this.dbPath)) await fs.promises.unlink(this.dbPath);
                await fs.promises.rename(tempPath, this.dbPath);
            }
        } catch (err) {
            logger.error('[DBManager] Erro na persistência assíncrona:', { error: err.message });
        } finally {
            this.persisting = false;
        }
    }

    persist() {
        if (!this.db || !this.dbPath) return;
        try {
            const data = this.db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(this.dbPath, buffer);
            // Também mantém backup sincronizado
            try { fs.copyFileSync(this.dbPath, `${this.dbPath}.bak`); } catch (_) {}
        } catch (err) {
            logger.error('[DBManager] Erro na persistência síncrona:', { error: err.message });
        }
    }

    close() {
        if (this.db) {
            if (this.saveTimer) clearTimeout(this.saveTimer);
            this.persist();
            this.db.close();
            this.db = null;
        }
    }
}

module.exports = new DBManager();
