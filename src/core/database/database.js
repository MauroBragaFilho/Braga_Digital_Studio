const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

class DBManager {
    constructor() {
        this.db = null;
        this.dbPath = null;
        this.SQL = null;
        this.saveTimer = null;
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
            const bytes = fs.readFileSync(this.dbPath);
            this.db = new this.SQL.Database(bytes);
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
                console.error('[DBManager] Erro ao persistir banco:', err.message);
            });
        }, 1000); // Salva 1000ms após a última escrita de forma agrupada
    }

    async persistAsync() {
        if (!this.db || !this.dbPath) return;
        try {
            const data = this.db.export();
            await fs.promises.writeFile(this.dbPath, Buffer.from(data));
        } catch (err) {
            console.error('[DBManager] Erro na persistência assíncrona:', err.message);
        }
    }

    persist() {
        if (!this.db || !this.dbPath) return;
        try {
            const data = this.db.export();
            fs.writeFileSync(this.dbPath, Buffer.from(data));
        } catch (err) {
            console.error('[DBManager] Erro na persistência síncrona:', err.message);
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
