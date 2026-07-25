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
    } else {
        logger.warn('[Migrations] Arquivo schema.sql não encontrado.');
    }
}

module.exports = {
    runMigrations
};
