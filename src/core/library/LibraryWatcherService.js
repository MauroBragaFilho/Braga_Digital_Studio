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
        
        // Reconcilia arquivos deletados em segundo plano após o startup.
        // [PERF] A promise é exposta via whenReconcileDone() para que o regen de
        // thumbnails SÓ comece depois da reconciliação terminar — os processos
        // ffmpeg do regen competiam por I/O com os fs.access() da reconciliação
        // (observado: reconciliação saltava de ~1.6s para ~13.5s quando rodavam juntos).
        this._reconcilePromise = new Promise((resolve) => {
            setTimeout(() => {
                this.reconcileMissingFiles()
                    .catch(err => logger.error(`[LibraryWatcherService] Falha na reconciliação: ${err.message}`))
                    .finally(resolve);
            }, 1500);
        });
        
        for (const lib of libraries) {
            if (lib.path) {
                this.startWatcher(lib.id, lib.path);
            }
        }
    }

    /**
     * [PERF] Promise que resolve quando a reconciliação de arquivos do startup terminar.
     * Útil para encadear trabalho pesado de I/O (ex: regen de thumbnails) SEM
     * competir por disco com a reconciliação.
     * @returns {Promise<void>}
     */
    whenReconcileDone() {
        return this._reconcilePromise || Promise.resolve();
    }

    /**
     * Verifica todos os arquivos no banco e marca como missing=1
     * aqueles que não existem mais no disco de forma assíncrona.
     * [PERF] Toda a verificação de disco é assíncrona (fs.promises) e
     * com concorrência limitada, para não travar o event loop do
     * processo principal mesmo com bibliotecas de milhares de arquivos.
     */
    async reconcileMissingFiles() {
        const db = dbManager.get();
        const t0 = Date.now();
        
        try {
            // Coleta todos os arquivos ativos (não ausentes) e já marcados como ausentes
            const allMedia = db.prepare('SELECT id, filepath, missing FROM media WHERE (missing = 0 OR missing IS NULL)').all();
            const markedMissing = db.prepare('SELECT id, filepath, missing FROM media WHERE missing = 1').all();
            const candidates = [...allMedia, ...markedMissing];

            if (candidates.length === 0) {
                logger.info('[LibraryWatcherService] Reconciliação concluída — nenhum arquivo para verificar.');
                return;
            }

            const CONCURRENCY = 32;
            const toMark = [];
            const toRestore = [];
            let cursor = 0;

            const worker = async () => {
                while (cursor < candidates.length) {
                    const row = candidates[cursor++];
                    if (!row.filepath) continue;
                    try {
                        const exists = await require('fs').promises.access(row.filepath).then(() => true).catch(() => false);
                        // Se não existe no disco e não estava ausente -> marcar ausente
                        if (!exists && row.missing !== 1) {
                            toMark.push(row.id);
                        }
                        // Se existe e estava ausente -> restaurar
                        if (exists && row.missing === 1) {
                            toRestore.push(row.id);
                        }
                    } catch (_) {
                        /* ignora erros de acesso isolados */
                    }
                }
            };

            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));

            // Batch UPDATE — cria cada statement uma única vez por chamada
            if (toMark.length > 0) {
                const placeholders = toMark.map(() => '?').join(',');
                db.prepare(`UPDATE media SET missing = 1 WHERE id IN (${placeholders})`).run(...toMark);
            }
            if (toRestore.length > 0) {
                const placeholders = toRestore.map(() => '?').join(',');
                db.prepare(`UPDATE media SET missing = 0 WHERE id IN (${placeholders})`).run(...toRestore);
            }
            
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            if (toMark.length > 0 || toRestore.length > 0) {
                logger.info(`[LibraryWatcherService] Reconciliação (${elapsed}s): ${toMark.length} ausentes marcados, ${toRestore.length} restaurados.`);
            } else {
                logger.info(`[LibraryWatcherService] Reconciliação concluída (${elapsed}s) — todos os arquivos estão presentes.`);
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
