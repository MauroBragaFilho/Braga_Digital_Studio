const logger = require('../../services/logService');
const chokidar = require('chokidar');
const path = require('path');
const EventBus = require('../EventBus');

const { SUPPORTED_EXTENSIONS, isJpeg, findSiblingRaw } = require('../media/MediaTypes');

const JPG_DEFER_MS = 6000;      // espera o RAW irmão chegar antes de indexar um JPG
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 5000;

class FolderWatcher {
    constructor(libraryId, folderPath, importQueue) {
        this.libraryId = libraryId;
        this.folderPath = folderPath;
        this.importQueue = importQueue;
        this.watcher = null;
        this.restarts = 0;
        this.stopped = false;
        this.pendingJpgs = new Map(); // caminho -> timer (JPG aguardando o RAW irmão)
    }

    start() {
        this.stopped = false;
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
            .on('unlink', filePath => this.handleFileEvent('DELETE', filePath))
            .on('error', err => this._handleError(err));
    }

    handleFileEvent(eventType, filePath) {
        const ext = path.extname(filePath).toLowerCase();
        
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
            return;
        }

        // Deduplicação RAW/JPG (função única): o RAW tem prioridade sobre o JPG irmão
        if (isJpeg(filePath) && (eventType === 'CREATE' || eventType === 'CHANGE')) {
            if (findSiblingRaw(filePath)) return; // RAW já existe: ignora o JPG
            // O JPG pode chegar antes do RAW: adia e reavalia (cancela se o RAW aparecer)
            this._deferJpg(eventType, filePath);
            return;
        }

        const eventPayload = {
            libraryId: this.libraryId,
            event: eventType,
            path: filePath,
            timestamp: Date.now()
        };

        if (eventType === 'CREATE' || eventType === 'CHANGE') {
            this.importQueue.add({ libraryId: this.libraryId, path: filePath, event: eventType });
        } else if (eventType === 'DELETE') {
            EventBus.emit('MEDIA_REMOVED', eventPayload);
        }
    }

    _deferJpg(eventType, filePath) {
        if (this.pendingJpgs.has(filePath)) return;
        const timer = setTimeout(() => {
            this.pendingJpgs.delete(filePath);
            if (this.stopped) return;
            if (findSiblingRaw(filePath)) return; // RAW chegou: mantém só o RAW
            this.importQueue.add({ libraryId: this.libraryId, path: filePath, event: eventType });
        }, JPG_DEFER_MS);
        if (timer.unref) timer.unref();
        this.pendingJpgs.set(filePath, timer);
    }

    _handleError(err) {
        logger.error(`[FolderWatcher] Erro no watcher da lib #${this.libraryId} (${this.folderPath}): ${err && (err.message || err)}`);
        if (this.stopped || this.restarts >= MAX_RESTARTS) return;
        this.restarts++;
        logger.warn(`[FolderWatcher] Reiniciando watcher da lib #${this.libraryId} (tentativa ${this.restarts}/${MAX_RESTARTS})`);
        const old = this.watcher;
        this.watcher = null;
        if (old) { try { Promise.resolve(old.close()).catch(() => {}); } catch (_) {} }
        const t = setTimeout(() => { if (!this.stopped && !this.watcher) this.start(); }, RESTART_DELAY_MS);
        if (t.unref) t.unref();
    }

    stop() {
        this.stopped = true;
        for (const t of this.pendingJpgs.values()) clearTimeout(t);
        this.pendingJpgs.clear();
        if (this.watcher) {
            try { Promise.resolve(this.watcher.close()).catch(() => {}); } catch (_) {}
            this.watcher = null;
        }
    }
}

module.exports = FolderWatcher;
