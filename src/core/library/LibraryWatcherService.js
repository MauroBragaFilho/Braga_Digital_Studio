const logger = require('../../services/logService');
const fsp = require('fs').promises;
const dbManager = require('../database/database');
const EventBus = require('../EventBus');
const { mapLimit, classifyRows } = require('./reconcile');

// Concorrência moderada: disco frio/HD externo e a UI competem pelo mesmo I/O.
const RECONCILE_CONCURRENCY = 12;

class LibraryWatcherService {
    constructor(importQueue) {
        this.importQueue = importQueue;
        this.watchers = new Map();

        // Escuta os eventos e atualiza o banco (handler guardado para ser removido em stopAll)
        this._onMediaRemoved = (payload) => this.handleMediaRemoved(payload);
        EventBus.on('MEDIA_REMOVED', this._onMediaRemoved);
    }

    /**
     * Inicia os watchers das bibliotecas ativas. NÃO reconcilia arquivos: a reconciliação é
     * disparada à parte (startReconcile) só no startup — reiniciar watchers (ex.: ao trocar uma
     * pasta nas configurações) não precisa varrer o disco de novo.
     */
    startAll() {
        if (!this._onMediaRemoved) {
            this._onMediaRemoved = (payload) => this.handleMediaRemoved(payload);
            EventBus.on('MEDIA_REMOVED', this._onMediaRemoved);
        }
        const db = dbManager.get();
        const libraries = db.prepare('SELECT id, path FROM libraries WHERE enabled = 1 AND auto_scan = 1').all();

        for (const lib of libraries) {
            if (lib.path) {
                this.startWatcher(lib.id, lib.path);
            }
        }
    }

    /**
     * Agenda a reconciliação de arquivos (ausentes/restaurados) em segundo plano, após o startup.
     * [PERF] A promise é exposta via whenReconcileDone() para que o regen de thumbnails SÓ comece
     * depois da reconciliação terminar — os ffmpeg do regen competiam por I/O com ela.
     * Idempotente: chamadas repetidas reaproveitam a mesma execução.
     * @param {number} [delayMs=1500]
     */
    startReconcile(delayMs = 1500) {
        if (this._reconcilePromise) return this._reconcilePromise;
        this._reconcilePromise = new Promise((resolve) => {
            setTimeout(() => {
                this.reconcileMissingFiles()
                    .catch(err => logger.error(`[LibraryWatcherService] Falha na reconciliação: ${err.message}`))
                    .finally(resolve);
            }, delayMs);
        });
        return this._reconcilePromise;
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
     * [PERF] Verificação 100% assíncrona, agrupada por pasta (um readdir por pasta em vez de um
     * fs.access por arquivo), com concorrência moderada e cedendo ao event loop entre lotes.
     * Bibliotecas cuja raiz está inacessível (HD externo/rede desconectado) são puladas.
     */
    async reconcileMissingFiles() {
        const db = dbManager.get();
        const t0 = Date.now();

        try {
            // Só as colunas necessárias; a raiz de cada biblioteca vem de uma consulta pequena à parte
            const candidates = db.prepare('SELECT id, filepath, missing, library_id FROM media').all();

            if (candidates.length === 0) {
                logger.info('[LibraryWatcherService] Reconciliação concluída — nenhum arquivo para verificar.');
                return;
            }

            const libPaths = new Map(db.prepare('SELECT id, path FROM libraries').all().map(l => [l.id, l.path]));

            // Bibliotecas offline (raiz inacessível) são puladas:
            // nunca marcar tudo como ausente só porque o disco não está montado.
            const offlineRoots = new Set();
            const roots = [...new Set([...libPaths.values()].filter(Boolean))];
            await mapLimit(roots, RECONCILE_CONCURRENCY, async (root) => {
                const ok = await fsp.access(root).then(() => true).catch(() => false);
                if (!ok) {
                    offlineRoots.add(root);
                    logger.warn(`[LibraryWatcherService] Raiz da biblioteca inacessível, pulando reconciliação: ${root}`);
                }
            });

            const rows = candidates.filter((row) => {
                if (!row.filepath) return false;
                const root = libPaths.get(row.library_id);
                return !(root && offlineRoots.has(root));
            });

            const { toMark, toRestore } = await classifyRows(
                rows,
                { readdir: (dir) => fsp.readdir(dir), access: (file) => fsp.access(file) },
                { concurrency: RECONCILE_CONCURRENCY }
            );

            // Batch UPDATE (em fatias, para respeitar o limite de variáveis do SQLite)
            const updateIn = (value, ids) => {
                for (let i = 0; i < ids.length; i += 500) {
                    const slice = ids.slice(i, i + 500);
                    const placeholders = slice.map(() => '?').join(',');
                    db.prepare(`UPDATE media SET missing = ${value} WHERE id IN (${placeholders})`).run(...slice);
                }
            };
            if (toMark.length > 0) updateIn(1, toMark);
            if (toRestore.length > 0) updateIn(0, toRestore);

            await this.requeueStuckImports(offlineRoots);

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


    /**
     * Linhas presas em IMPORTING/ERROR (ex.: app fechado no meio da importação) são reenfileiradas
     * se o arquivo existe; o ImportWorker reaproveita a própria linha.
     */
    async requeueStuckImports(offlineRoots = new Set()) {
        const db = dbManager.get();
        const rows = db.prepare(`
            SELECT m.id, m.library_id, m.filepath, l.path AS lib_path
            FROM media m LEFT JOIN libraries l ON l.id = m.library_id
            WHERE m.status IN ('IMPORTING', 'ERROR') AND (m.missing = 0 OR m.missing IS NULL)
        `).all();
        const eligible = rows.filter(row => row.filepath && !(row.lib_path && offlineRoots.has(row.lib_path)));

        // Verificação de existência em lote paralelo limitado (antes era um fs.access sequencial por linha)
        const found = await mapLimit(eligible, 8, (row) => fsp.access(row.filepath).then(() => true, () => false));
        let queued = 0;
        eligible.forEach((row, i) => {
            if (!found[i]) return;
            this.importQueue.add({ libraryId: row.library_id, path: row.filepath, event: 'CREATE' });
            queued++;
        });
        if (queued > 0) logger.info(`[LibraryWatcherService] ${queued} importações pendentes/com erro reenfileiradas.`);
        return queued;
    }

    startWatcher(libraryId, folderPath) {
        if (this.watchers.has(libraryId)) {
            return;
        }

        // require tardio: o chokidar só é carregado quando existe uma pasta para monitorar
        const FolderWatcher = require('./FolderWatcher');
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
        if (this._onMediaRemoved) {
            EventBus.removeListener('MEDIA_REMOVED', this._onMediaRemoved);
            this._onMediaRemoved = null;
        }
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
