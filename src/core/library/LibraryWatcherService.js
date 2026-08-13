const logger = require('../../services/logService');
const FolderWatcher = require('./FolderWatcher');
const dbManager = require('../database/database');
const EventBus = require('../EventBus');

class LibraryWatcherService {
    constructor(importQueue) {
        this.importQueue = importQueue;
        this.watchers = new Map(); 
        
        // Escuta os eventos e atualiza o banco
        EventBus.on('MEDIA_REMOVED', (payload) => this.handleMediaRemoved(payload));
    }

    startAll() {
        const db = dbManager.get();
        const libraries = db.prepare('SELECT * FROM libraries WHERE enabled = 1 AND auto_scan = 1').all();
        
        // Reconcilia arquivos deletados enquanto o app estava fechado
        this.reconcileMissingFiles();
        
        for (const lib of libraries) {
            if (lib.path) {
                this.startWatcher(lib.id, lib.path);
            }
        }
    }

    /**
     * Verifica todos os arquivos no banco e marca como missing=1
     * aqueles que não existem mais no disco.
     */
    reconcileMissingFiles() {
        const fs = require('fs');
        const db = dbManager.get();
        
        try {
            // Coleta IDs para marcar como ausentes
            const allMedia = db.prepare('SELECT id, filepath FROM media WHERE (missing = 0 OR missing IS NULL)').all();
            const toMark = [];
            for (const row of allMedia) {
                if (!row.filepath) continue;
                if (!fs.existsSync(row.filepath)) {
                    toMark.push(row.id);
                }
            }
            
            // Restaura arquivos que voltaram (e.g., drive remontado)
            const markedMissing = db.prepare('SELECT id, filepath FROM media WHERE missing = 1').all();
            const toRestore = [];
            for (const row of markedMissing) {
                if (!row.filepath) continue;
                if (fs.existsSync(row.filepath)) {
                    toRestore.push(row.id);
                }
            }
            
            // Batch UPDATE — cria cada statement uma única vez por chamada
            if (toMark.length > 0) {
                const placeholders = toMark.map(() => '?').join(',');
                db.prepare(`UPDATE media SET missing = 1 WHERE id IN (${placeholders})`).run(...toMark);
            }
            if (toRestore.length > 0) {
                const placeholders = toRestore.map(() => '?').join(',');
                db.prepare(`UPDATE media SET missing = 0 WHERE id IN (${placeholders})`).run(...toRestore);
            }
            
            if (toMark.length > 0 || toRestore.length > 0) {
                logger.info(`[LibraryWatcherService] Reconciliação: ${toMark.length} ausentes marcados, ${toRestore.length} restaurados.`);
            } else {
                logger.info('[LibraryWatcherService] Reconciliação concluída — todos os arquivos estão presentes.');
            }
        } catch (err) {
            logger.error(`[LibraryWatcherService] Erro na reconciliação de arquivos: ${err && (err.message || String(err))}`);
        }
    }


    startWatcher(libraryId, folderPath) {
        if (this.watchers.has(libraryId)) {
            return; 
        }
        
        const watcher = new FolderWatcher(libraryId, folderPath, this.importQueue);
        watcher.start();
        this.watchers.set(libraryId, watcher);
    }

    stopWatcher(libraryId) {
        const watcher = this.watchers.get(libraryId);
        if (watcher) {
            watcher.stop();
            this.watchers.delete(libraryId);
        }
    }

    stopAll() {
        for (const [id, watcher] of this.watchers) {
            watcher.stop();
        }
        this.watchers.clear();
    }
    
    handleMediaRemoved(payload) {
        const db = dbManager.get();
        const { path: filePath } = payload;
        
        // Marca como desaparecido, nunca deleta direto da base
        db.prepare('UPDATE media SET missing = 1 WHERE filepath = ?').run(filePath);
        logger.info(`[LibraryWatcherService] Marcado como perdido: ${filePath}`);
    }
}

module.exports = LibraryWatcherService;
