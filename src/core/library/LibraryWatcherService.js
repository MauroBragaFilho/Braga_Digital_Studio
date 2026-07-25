const logger = require('../../../services/logService');
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
        
        for (const lib of libraries) {
            if (lib.path) {
                this.startWatcher(lib.id, lib.path);
            }
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
