const logger = require('../../services/logService');
const chokidar = require('chokidar');
const path = require('path');
const EventBus = require('../EventBus');

const SUPPORTED_EXTENSIONS = new Set(
    ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4a', '.mp3', '.flac', '.wav', '.ogg', 
     '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.svg', '.heic',
     '.arw', '.cr2', '.cr3', '.nef', '.dng', '.raf', '.rw2', '.orf']
);

class FolderWatcher {
    constructor(libraryId, folderPath, importQueue) {
        this.libraryId = libraryId;
        this.folderPath = folderPath;
        this.importQueue = importQueue;
        this.watcher = null;
    }

    start() {
        logger.info(`[FolderWatcher] Monitorando lib #${this.libraryId}: ${this.folderPath}`);
        
        // ignoreInitial: true -> Evita reprocessar arquivos existentes no startup, capturando apenas novas adições/modificações
        this.watcher = chokidar.watch(this.folderPath, {
            persistent: true,
            ignoreInitial: true, 
            ignored: (itemPath, stats) => {
                if (!itemPath) return false;
                const basename = path.basename(itemPath);
                
                // Ignora pastas/arquivos ocultos ou protegidos do sistema
                if (basename.startsWith('.') || 
                    ['System Volume Information', '$RECYCLE.BIN', 'WindowsApps', 'Program Files', 'Program Files (x86)', 'Windows', 'bootTel.dat', 'AppData'].includes(basename)) {
                    return true;
                }
                
                // Se for garantidamente um arquivo, ignora se não tiver extensão suportada
                if (stats && stats.isFile()) {
                    const ext = path.extname(basename).toLowerCase();
                    if (!SUPPORTED_EXTENSIONS.has(ext)) {
                        return true;
                    }
                }
                
                return false;
            },
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            }
        });

        this.watcher
            .on('add', filePath => this.handleFileEvent('CREATE', filePath))
            .on('change', filePath => this.handleFileEvent('CHANGE', filePath))
            .on('unlink', filePath => this.handleFileEvent('DELETE', filePath));
    }

    handleFileEvent(eventType, filePath) {
        const ext = path.extname(filePath).toLowerCase();
        
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
            return;
        }

        // Lógica de Desduplicação: Se for JPG, checa se tem RAW
        const isJpg = ext === '.jpg' || ext === '.jpeg';
        if (isJpg && (eventType === 'CREATE' || eventType === 'CHANGE')) {
            const dir = path.dirname(filePath);
            const base = path.parse(filePath).name;
            const rawExts = ['.arw', '.cr2', '.cr3', '.nef', '.dng', '.raf', '.rw2', '.orf'];
            const fs = require('fs');
            for (const rawExt of rawExts) {
                if (fs.existsSync(path.join(dir, base + rawExt)) || fs.existsSync(path.join(dir, base + rawExt.toUpperCase()))) {
                    return; // Ignora o evento deste JPG pois o RAW existe
                }
            }
        }

        const eventPayload = {
            libraryId: this.libraryId,
            event: eventType,
            path: filePath,
            timestamp: Date.now()
        };

        if (eventType === 'CREATE' || eventType === 'CHANGE') {
            this.importQueue.add({ libraryId: this.libraryId, path: filePath });
        } else if (eventType === 'DELETE') {
            EventBus.emit('MEDIA_REMOVED', eventPayload);
        }
    }

    stop() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
    }
}

module.exports = FolderWatcher;
