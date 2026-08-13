const logger = require('../../../services/logService');
const fs = require('fs');
const path = require('path');
const dbManager = require('./database');

function runMigrations() {
    const db = dbManager.get();
    const schemaPath = path.join(__dirname, 'schema.sql');
    
    if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf8');
        db.exec(schema);
        logger.info('[Migrations] Schema executado com sucesso no bds.db');
        
        // Garante que a coluna recorded_at existe caso o BD já tenha sido criado antes
        try {
            db.exec("ALTER TABLE media ADD COLUMN recorded_at DATETIME;");
            logger.info('[Migrations] Coluna recorded_at adicionada (Alter Table).');
        } catch(e) {}

        // Garante que a coluna album existe
        try {
            db.exec("ALTER TABLE media ADD COLUMN album TEXT;");
            logger.info('[Migrations] Coluna album adicionada (Alter Table).');
            
            const rows = db.prepare('SELECT id, filepath FROM media WHERE album IS NULL').all();
            if (rows.length > 0) {
                const updateStmt = db.prepare('UPDATE media SET album = ? WHERE id = ?');
                db.exec('BEGIN TRANSACTION');
                for (const row of rows) {
                    const dir = path.dirname(row.filepath);
                    const albumName = path.basename(dir);
                    if (albumName && albumName !== '.' && albumName !== path.parse(dir).root) {
                        updateStmt.run(albumName, row.id);
                    }
                }
                db.exec('COMMIT');
                logger.info(`[Migrations] Atualizados álbuns de ${rows.length} mídias.`);
            }
        } catch(e) {}
        
        // Garante que as novas colunas de projetos existam
        try {
            const projectCols = ['status', 'color', 'client', 'type', 'start_date', 'deadline', 'cover_path'];
            for (const col of projectCols) {
                try {
                    db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT;`);
                    logger.info(`[Migrations] Coluna ${col} adicionada em projects.`);
                } catch(e) {} // Ignora se a coluna já existir
            }
        } catch (e) {}

        // Garante que a tabela sync_history exista
        try {
            db.exec(`
                CREATE TABLE IF NOT EXISTS sync_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    hash TEXT,
                    project_id INTEGER,
                    media_id INTEGER,
                    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
            logger.info(`[Migrations] Tabela sync_history verificada.`);
        } catch (e) {
            logger.error(`[Migrations] Erro ao criar sync_history: ${e.message}`);
        }

        // Garante que a tabela download_queue exista
        try {
            db.exec(`
                CREATE TABLE IF NOT EXISTS download_queue (
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
                    progress REAL DEFAULT 0,
                    downloaded_bytes INTEGER DEFAULT 0,
                    total_bytes INTEGER DEFAULT 0,
                    speed TEXT,
                    eta TEXT,
                    output_path TEXT,
                    error TEXT,
                    position INTEGER,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    started_at DATETIME,
                    completed_at DATETIME
                );
            `);
            const dqCols = ['channel', 'platform', 'duration'];
            for (const col of dqCols) {
                try {
                    db.exec(`ALTER TABLE download_queue ADD COLUMN ${col} TEXT;`);
                } catch(e) {}
            }
            logger.info(`[Migrations] Tabela download_queue verificada.`);
        } catch (e) {
            logger.error(`[Migrations] Erro ao criar download_queue: ${e.message}`);
        }

        // Garante coluna 'missing' (adicionada para controle de arquivos deletados do disco)
        try {
            db.exec("ALTER TABLE media ADD COLUMN missing INTEGER DEFAULT 0;");
            logger.info('[Migrations] Coluna missing adicionada em media.');
        } catch(e) {} // Já existe

        // Garante coluna 'status' com valor padrão READY
        try {
            db.exec("ALTER TABLE media ADD COLUMN status TEXT DEFAULT 'READY';");
            logger.info('[Migrations] Coluna status adicionada em media.');
        } catch(e) {} // Já existe

        // Garante coluna 'favorite' e 'rating' em media
        try {
            db.exec("ALTER TABLE media ADD COLUMN favorite INTEGER DEFAULT 0;");
        } catch(e) {}
        try {
            db.exec("ALTER TABLE media ADD COLUMN rating INTEGER DEFAULT 0;");
        } catch(e) {}
        try {
            db.exec("ALTER TABLE media ADD COLUMN notes TEXT;");
        } catch(e) {}
        try {
            db.exec("ALTER TABLE media ADD COLUMN origin TEXT;");
        } catch(e) {}

        // Normaliza todos os registros que têm status NULL para 'READY'
        try {
            db.exec("UPDATE media SET status = 'READY' WHERE status IS NULL;");
            db.exec("UPDATE media SET missing = 0 WHERE missing IS NULL;");
        } catch(e) {}

    } else {
        logger.warn('[Migrations] Arquivo schema.sql não encontrado.');
    }
}

module.exports = {
    runMigrations
};
