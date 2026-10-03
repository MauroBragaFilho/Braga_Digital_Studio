const logger = require('../../services/logService');
const fs = require('fs');
const path = require('path');
const dbManager = require('./database');
const { mediaTypeCaseSql } = require('../media/MediaTypes');

// [FASE 3.2] Controle de versao do schema com tabela de metadados.
const SCHEMA_VERSION = 12;

function getAppliedMigrations(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`);
    return db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version);
}

function markMigrationApplied(db, version) {
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
}

function tableExists(db, table) {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function columnExists(db, table, column) {
    if (!tableExists(db, table)) return false;
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

/** ALTER TABLE ADD COLUMN idempotente: confere table_info antes e só tolera 'duplicate column'. */
function addColumn(db, table, column, definition) {
    if (columnExists(db, table, column)) return;
    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    } catch (e) {
        if (/duplicate column/i.test(e.message)) return;
        throw e;
    }
}

function indexExists(db, name) {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
}

function createIndexes(db, defs) {
    for (const [name, table, cols] of defs) {
        const list = cols.split(',').map(c => c.trim());
        if (!list.every(c => columnExists(db, table, c))) {
            logger.warn(`[Migrations] Indice ${name} ignorado: coluna/tabela inexistente (${table}.${cols})`);
            continue;
        }
        db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${cols});`);
    }
}

// Cada migracao roda dentro de uma transacao; se falhar, faz ROLLBACK e NAO e marcada como aplicada.
const MIGRATIONS = [
    { version: 2, up: (db) => addColumn(db, 'media', 'recorded_at', 'DATETIME') },
    {
        version: 3,
        up: (db) => {
            addColumn(db, 'media', 'album', 'TEXT');
            const rows = db.prepare('SELECT id, filepath FROM media WHERE album IS NULL').all();
            for (const row of rows) {
                const dir = path.dirname(row.filepath);
                const albumName = path.basename(dir);
                if (albumName && albumName !== '.' && albumName !== path.parse(dir).root) {
                    db.prepare('UPDATE media SET album = ? WHERE id = ?').run(albumName, row.id);
                }
            }
        }
    },
    {
        version: 4,
        up: (db) => {
            for (const col of ['status', 'color', 'client', 'type', 'start_date', 'deadline', 'cover_path']) {
                addColumn(db, 'projects', col, 'TEXT');
            }
        }
    },
    {
        version: 5,
        up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS sync_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            hash TEXT,
            project_id INTEGER,
            media_id INTEGER,
            imported_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );`)
    },
    {
        version: 6,
        up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS download_queue (
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
        );`)
    },
    {
        version: 7,
        up: (db) => {
            addColumn(db, 'media', 'missing', 'INTEGER DEFAULT 0');
            addColumn(db, 'media', 'status', "TEXT DEFAULT 'READY'");
            addColumn(db, 'media', 'favorite', 'INTEGER DEFAULT 0');
            addColumn(db, 'media', 'rating', 'INTEGER DEFAULT 0');
            addColumn(db, 'media', 'notes', 'TEXT');
            addColumn(db, 'media', 'origin', 'TEXT');
            for (const col of ['bdsm_camera', 'bdsm_profile', 'bdsm_lut', 'bdsm_metadata_json']) {
                addColumn(db, 'media', col, 'TEXT');
            }
            db.exec("UPDATE media SET status = 'READY' WHERE status IS NULL;");
            db.exec("UPDATE media SET missing = 0 WHERE missing IS NULL;");
        }
    },
    {
        version: 8,
        up: (db) => {
            addColumn(db, 'media', 'audio_track_count', 'INTEGER DEFAULT 1');
            addColumn(db, 'timeline_clips', 'audio_stream_index', 'INTEGER DEFAULT 0');
        }
    },
    {
        version: 9,
        up: (db) => {
            addColumn(db, 'sync_group_items', 'confidence', 'REAL DEFAULT 0');
            addColumn(db, 'sync_group_items', 'drift_rate_ppm', 'REAL DEFAULT 0');
        }
    },
    { version: 10, up: () => {} }, // Marco historico (nao tinha alteracoes proprias)
    {
        // Indices de desempenho (so cria os de colunas que existem)
        version: 11,
        up: (db) => createIndexes(db, [
            ['idx_media_filepath', 'media', 'filepath'],
            ['idx_media_library_id', 'media', 'library_id'],
            ['idx_media_project_id', 'media', 'project_id'],
            ['idx_media_status_missing', 'media', 'status, missing'],
            ['idx_media_recorded_at', 'media', 'recorded_at'],
            ['idx_media_origin', 'media', 'origin'],
            ['idx_media_album', 'media', 'album'],
            ['idx_project_media_project_media', 'project_media', 'project_id, media_id'],
            ['idx_timeline_clips_track_id', 'timeline_clips', 'track_id'],
            ['idx_timeline_tracks_sequence_id', 'timeline_tracks', 'sequence_id'],
            ['idx_media_tags_tag_id', 'media_tags', 'tag_id'],
            ['idx_sync_group_items_group', 'sync_group_items', 'sync_group_id'],
            ['idx_sync_history_device_hash', 'sync_history', 'device_id, hash']
        ])
    },
    {
        // Colunas derivadas da listagem (media_type, sort_date) + índices de desempenho adicionais.
        // media_type: 'video'|'audio'|'photo'|'raw' (mesmas listas de extensão de MediaTypes; RAW = 'raw' e conta
        // também como foto nas consultas). sort_date = COALESCE(recorded_at, imported_at) materializada para o ORDER BY.
        // Triggers mantêm as duas colunas em qualquer INSERT/UPDATE de media (inclusive fora do módulo de ingestão).
        version: 12,
        up: (db) => {
            addColumn(db, 'media', 'media_type', 'TEXT');
            addColumn(db, 'media', 'sort_date', 'DATETIME');
            db.exec(`UPDATE media SET media_type = ${mediaTypeCaseSql('filename')}, sort_date = COALESCE(recorded_at, imported_at);`);
            const typeSql = mediaTypeCaseSql('NEW.filename');
            const derive = `UPDATE media SET media_type = ${typeSql}, sort_date = COALESCE(NEW.recorded_at, NEW.imported_at) WHERE id = NEW.id;`;
            db.exec(`CREATE TRIGGER IF NOT EXISTS trg_media_derived_ins AFTER INSERT ON media BEGIN ${derive} END;`);
            db.exec(`CREATE TRIGGER IF NOT EXISTS trg_media_derived_upd AFTER UPDATE OF filename, recorded_at, imported_at ON media BEGIN ${derive} END;`);
            createIndexes(db, [
                // Listagem: percorre por (sort_date, id) = o ORDER BY da biblioteca, sem ordenação temporária, e avalia status/missing/media_type só no índice (sem tabela)
                ['idx_media_sort_listing', 'media', 'sort_date, id, status, missing, media_type'],
                // Estatísticas/contagens por tipo: índice de cobertura (getStats/getFilterOptions sem ler a tabela)
                ['idx_media_type_stats', 'media', 'media_type, status, missing, filesize'],
                // Resoluções/FPS dos vídeos e álbuns (filtros da biblioteca) sem ler a tabela
                ['idx_media_type_hf', 'media', 'media_type, height, fps'],
                ['idx_media_album_ready', 'media', 'album, status, missing'],
                ['idx_media_imported_at', 'media', 'imported_at'],
                ['idx_project_media_media_id', 'project_media', 'media_id'],
                ['idx_timeline_clips_media_id', 'timeline_clips', 'media_id'],
                ['idx_timeline_clips_project_media_id', 'timeline_clips', 'project_media_id'],
                ['idx_sync_group_items_media_id', 'sync_group_items', 'media_id'],
                ['idx_sync_groups_project_id', 'sync_groups', 'project_id'],
                ['idx_project_markers_project_id', 'project_markers', 'project_id']
            ]);
            // idx_media_album (migração 11) passa a ser prefixo de idx_media_album_ready: remove a redundante
            if (indexExists(db, 'idx_media_album_ready')) db.exec('DROP INDEX IF EXISTS idx_media_album;');
            if (columnExists(db, 'media', 'favorite')) {
                db.exec('CREATE INDEX IF NOT EXISTS idx_media_favorite ON media(favorite) WHERE favorite = 1;');
            }
        }
    }
];

function runMigrations() {
    const db = dbManager.get();
    const schemaPath = path.join(__dirname, 'schema.sql');

    if (!fs.existsSync(schemaPath)) {
        logger.warn('[Migrations] Arquivo schema.sql nao encontrado.');
        return;
    }

    let applied;
    try {
        applied = getAppliedMigrations(db);
    } catch (e) {
        logger.error('[Migrations] Nao foi possivel ler schema_migrations; migracoes abortadas.', { error: e.message });
        return;
    }

    const pending = MIGRATIONS.filter(m => !applied.includes(m.version));
    const needsSchema = !applied.includes(1) || pending.length > 0;
    if (!needsSchema) return; // banco ja esta na versao atual: nao reexecuta o schema

    // Backup antes de migrar (somente se ja existe um banco com dados/versoes anteriores)
    if (applied.length > 0) {
        const bak = dbManager.createBackup('premigrate');
        if (bak) logger.info(`[Migrations] Backup pre-migracao criado: ${path.basename(bak)}`);
    }

    try {
        db.exec(fs.readFileSync(schemaPath, 'utf8'));
        logger.info('[Migrations] Schema executado com sucesso no bds.db');
        markMigrationApplied(db, 1);
    } catch (e) {
        logger.error('[Migrations] Falha ao executar schema.sql; migracoes abortadas.', { error: e.message });
        return;
    }

    for (const m of pending) {
        try {
            db.exec('BEGIN TRANSACTION');
            m.up(db);
            markMigrationApplied(db, m.version);
            db.exec('COMMIT');
            logger.info(`[Migrations] Migracao ${m.version} aplicada`);
        } catch (e) {
            try { db.exec('ROLLBACK'); } catch (_) {}
            logger.error(`[Migrations] Migracao ${m.version} falhou e foi revertida: ${e.message}`);
            break; // migracoes seguintes podem depender desta
        }
    }
}

module.exports = {
    runMigrations,
    SCHEMA_VERSION
};
