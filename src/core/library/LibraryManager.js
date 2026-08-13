const dbManager = require('../database/database');
const SourceTypes = require('./SourceTypes');

class LibraryManager {
    /**
     * Adiciona uma nova biblioteca ao banco de dados.
     * @param {Object} library - Objeto da biblioteca
     * @param {string} library.name - Nome da biblioteca
     * @param {string} library.type - Tipo da biblioteca (ex: OBS)
     * @param {string} [library.path] - Caminho local (opcional se for IP)
     * @param {string} [library.ip] - IP do dispositivo BDSM (opcional)
     * @returns {number} ID da biblioteca inserida
     */
    add({ name, type, path = null, ip = null }) {
        if (!SourceTypes[type]) {
            throw new Error(`Tipo de biblioteca inválido: ${type}`);
        }

        const db = dbManager.get();
        const stmt = db.prepare(`
            INSERT INTO libraries (name, type, path, ip, enabled, auto_scan)
            VALUES (?, ?, ?, ?, 1, 1)
        `);
        
        const info = stmt.run(name, type, path, ip);
        return info.lastInsertRowid;
    }

    /**
     * Retorna todas as bibliotecas cadastradas
     */
    list() {
        const db = dbManager.get();
        return db.prepare('SELECT * FROM libraries').all();
    }

    /**
     * Remove uma biblioteca pelo ID
     */
    remove(id) {
        const db = dbManager.get();
        // Remove também as mídias associadas devido ao pragma foreign_keys ON (com ON DELETE CASCADE se configurado) ou manualmente.
        db.prepare('DELETE FROM media WHERE library_id = ?').run(id);
        db.prepare('DELETE FROM libraries WHERE id = ?').run(id);
    }
}

module.exports = LibraryManager;
