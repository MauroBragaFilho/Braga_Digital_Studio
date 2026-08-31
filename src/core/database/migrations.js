const logger = require('../../services/logService');
const fs = require('fs');
const path = require('path');
const dbManager = require('./database');

// [FASE 3.2] Controle de versao do schema com tabela de metadados.
const SCHEMA_VERSION = 10;

function getAppliedMigrations(db) {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );`);
        return db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version);
    } catch (e) {
        return [];
    }
}

function markMigrationApplied(db, version) {
    try {
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
    } catch (e) {
        logger.warn(`[Migrations] Nao foi possivel registrar migracao ${version}: ${e.message}`);
    }
}

function runMigrations() {
    const db = dbManager.get();
    const schemaPath = path.join(__dirname, 'schema.sql');
    const applied = getAppliedMigrations(db);
    
    if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf8');
        db.exec(schema);
        logger.info('[Migrations] Schema executado com sucesso no bds.db');
        markMigrationApplied(db, 1);
        
        if (!applied.includes(2)) {
            try { db.exec("ALTER TABLE media ADD COLUMN recorded_at DATETIME;"); } catch(e) {}
            markMigrationApplied(db, 2);
        }

        if (!applied.includes(3)) {
            try {
                db.exec("ALTER TABLE media ADD COLUMN album TEXT;");
                const rows = db.prepare('SELECT id, filepath FROM media WHERE album IS NULL').all();
                if (rows.length > 0) {
                    db.exec('BEGIN TRANSACTION');
                    for (const row of rows) {
                        const dir = path.dirname(row.filepath);
                        const albumName = path.basename(dir);
                        if (albumName && albumName !== '.' && albumName !== path.parse(dir).root) {
                            db.prepare('UPDATE media SET album = ? WHERE id = ?').run(albumName, row.id);
                        }
                    }
                    db.exec('COMMIT');
                }
            } catch(e) {}
            markMigrationApplied(db, 3);
        }

        if (!applied.includes(4)) {
            try {
                const projectCols = ['status', 'color', 'client', 'type', 'start_date', 'deadline', 'cover_path'];
                for (const col of projectCols) {
                    try { db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT;`); } catch(e) {}
                }
            } catch (e) {}
            markMigrationApplied(db, 4);
        }

        if (!applied.includes(5)) {
            try {
                db.exec(`CREATE TABLE IF NOT EXISTS sync_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    hash TEXT,
                    project_id INTEGER,
                    media_id INTEGER,
                    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );`);
            } catch (e) {}
            markMigrationApplied(db, 5);
        }

        if (!applied.includes(6)) {
            try {
                db.exec(`CREATE TABLE IF NOT EXISTS download_queue (
                    id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    title TEXT,
                    thumbnail TEXT,
                    channel TEXT,
                    platform TEXT,
                    duration REAL,
                    format TEXT,
                    quality TEXT,
                    status TEXT DEFAULT 'queued',
                    position INTEGER,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    started_at DATETIME,
                    completed_at DATETIME
                );`);
            } catch (e) {}
            markMigrationApplied(db, 6);
        }


        if (!applied.includes(7)) {
            try { db.exec("ALTER TABLE media ADD COLUMN missing INTEGER DEFAULT 0;"); } catch(e) {}
            try { db.exec("ALTER TABLE media ADD COLUMN status TEXT DEFAULT 'READY';"); } catch(e) {}
            try { db.exec("ALTER TABLE media ADD COLUMN favorite INTEGER DEFAULT 0;"); } catch(e) {}
            try { db.exec("ALTER TABLE media ADD COLUMN rating INTEGER DEFAULT 0;"); } catch(e) {}
            try { db.exec("ALTER TABLE media ADD COLUMN notes TEXT;"); } catch(e) {}
            try { db.exec("ALTER TABLE media ADD COLUMN origin TEXT;"); } catch(e) {}
            const bdsmCols = ['bdsm_camera', 'bdsm_profile', 'bdsm_lut', 'bdsm_metadata_json'];
            for (const col of bdsmCols) {
                try { db.exec(`ALTER TABLE media ADD COLUMN ${col} TEXT;`); } catch(e) {}
            }
            try {
                db.exec("UPDATE media SET status = 'READY' WHERE status IS NULL;");
                db.exec("UPDATE media SET missing = 0 WHERE missing IS NULL;");
            } catch(e) {}
            markMigrationApplied(db, 7);
        }

        if (!applied.includes(8)) {
            try { db.exec("ALTER TABLE media ADD COLUMN audio_track_count INTEGER DEFAULT 1;"); } catch(e) {}
            try { db.exec("ALTER TABLE timeline_clips ADD COLUMN audio_stream_index INTEGER DEFAULT 0;"); } catch(e) {}
            markMigrationApplied(db, 8);
        }

        if (!applied.includes(9)) {
            try { db.exec("ALTER TABLE sync_group_items ADD COLUMN confidence REAL DEFAULT 0;"); } catch(e) {}
            try { db.exec("ALTER TABLE sync_group_items ADD COLUMN drift_rate_ppm REAL DEFAULT 0;"); } catch(e) {}
            markMigrationApplied(db, 9);
        }

        markMigrationApplied(db, SCHEMA_VERSION);
    } else {
        logger.warn('[Migrations] Arquivo schema.sql nao encontrado.');
    }
}

module.exports = {
    runMigrations
};

