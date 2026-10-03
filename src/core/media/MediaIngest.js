'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../services/logService');
const EventBus = require('../EventBus');
const HashGenerator = require('./HashGenerator');
const { isSupported, isRaw, isAudio, findSiblingJpg } = require('./MediaTypes');

/**
 * Pipeline único de ingestão de mídia, compartilhado por ImportWorker (watcher)
 * e MediaImporter (importação manual / projetos). Garante os mesmos metadados nos dois caminhos:
 * origem (BDSM_DEVICE -> subpasta), álbum, recorded_at, audio_track_count, miniatura e status READY.
 */

function resolveOrigin(library, filePath) {
    let origin = library && library.type ? library.type : 'OBS';
    if (origin === 'BDSM_DEVICE' && library.path) {
        const relativeDir = path.dirname(path.relative(library.path, filePath));
        if (relativeDir && relativeDir !== '.' && relativeDir !== '') {
            origin = relativeDir.split(path.sep)[0];
        }
    }
    return origin;
}

function resolveAlbum(filePath) {
    const dir = path.dirname(filePath);
    const album = path.basename(dir);
    if (!album || album === '.' || album === path.parse(dir).root) return null;
    return album;
}

/** Executa fn (síncrona) numa transação; se já houver uma aberta, apenas executa fn. */
function inTransaction(db, fn) {
    let started = false;
    try { db.exec('BEGIN TRANSACTION'); started = true; } catch (_) { /* transação já aberta */ }
    try {
        const r = fn();
        if (started) db.exec('COMMIT');
        return r;
    } catch (e) {
        if (started) { try { db.exec('ROLLBACK'); } catch (_) {} }
        throw e;
    }
}

/**
 * Obs.: media.media_type e media.sort_date são mantidos por triggers do banco (migração 12) a cada
 * INSERT/UPDATE de filename, recorded_at ou imported_at — não precisam ser preenchidos aqui.
 *
 * @param {Object} p
 * @param {Object} p.db                 better-sqlite3
 * @param {Object} p.ffprobe            instância FFProbe
 * @param {Function} p.generateThumbnail async (filePath, uuid, duration) => nome|null
 * @param {Object} p.library            { id, type, path } (pode ser null)
 * @param {string} p.filePath
 * @param {string} [p.event]            'CHANGE' => reprocessa se o tamanho mudou
 * @param {boolean} [p.emit=false]      emite MEDIA_IMPORTED ao concluir
 * @param {boolean} [p.batch=false]     importação em lote: logs por arquivo em debug (não info)
 * @returns {Promise<{id:number, created:boolean, status:string}|null>}
 */
async function ingestFile({ db, ffprobe, generateThumbnail, library, filePath, event = null, emit = false, batch = false }) {
    const logFile = batch ? (m) => logger.debug(m) : (m) => logger.info(m);
    const filename = path.basename(filePath);
    if (!isSupported(filename)) return null;

    const existsByPath = db.prepare('SELECT id, status, filesize, uuid FROM media WHERE filepath = ?').get(filePath);
    const stats = await fsp.stat(filePath);

    if (existsByPath && existsByPath.status === 'READY') {
        const changed = event === 'CHANGE' && existsByPath.filesize != null && existsByPath.filesize !== stats.size;
        if (!changed) return { id: existsByPath.id, created: false, status: 'READY' };
        logFile(`[MediaIngest] Arquivo alterado (tamanho ${existsByPath.filesize} -> ${stats.size}), reprocessando: ${filename}`);
    }

    const hash = await HashGenerator.generate(filePath);
    const existingHash = db.prepare('SELECT id, filepath, status, filesize FROM media WHERE hash = ?').get(hash);
    let mediaId = existsByPath ? existsByPath.id : null;
    let created = !existsByPath;
    const origin = resolveOrigin(library, filePath);
    const album = resolveAlbum(filePath);
    const libraryId = library ? library.id : null;

    if (existingHash && existingHash.id !== mediaId) {
        const oldGone = !existingHash.filepath || !fs.existsSync(existingHash.filepath);
        const flagged = db.prepare('SELECT missing FROM media WHERE id = ?').get(existingHash.id);
        if (existingHash.filepath !== filePath && (oldGone || (flagged && flagged.missing === 1))) {
            // Arquivo movido/renomeado: preserva o id (projetos, tags, favoritos)
            // Remoção do placeholder + atualização do registro movido: uma transação (síncrona, sem await dentro)
            inTransaction(db, () => {
                if (mediaId != null) db.prepare('DELETE FROM media WHERE id = ? AND status != ?').run(mediaId, 'READY'); // placeholder órfão
                db.prepare(`UPDATE media SET filepath = ?, filename = ?, album = ?, origin = ?, library_id = COALESCE(?, library_id),
                            missing = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(filePath, filename, album, origin, libraryId, existingHash.id);
            });
            logFile(`[MediaIngest] Arquivo movido/renomeado reaproveitando registro #${existingHash.id}: ${filename}`);
            if (existingHash.status === 'READY') {
                if (emit) EventBus.emit('MEDIA_IMPORTED', db.prepare('SELECT * FROM media WHERE id = ?').get(existingHash.id));
                return { id: existingHash.id, created: false, status: 'READY', moved: true };
            }
            mediaId = existingHash.id;
            created = false;
        } else {
            // Duplicata de outro caminho (o hash é UNIQUE: não há como coexistirem)
            if (existingHash.filesize != null && existingHash.filesize !== stats.size) {
                logger.warn(`[MediaIngest] Hash igual com tamanhos diferentes (possível colisão): ${filename} (#${existingHash.id})`);
            } else {
                logFile(`[MediaIngest] Arquivo ignorado (hash duplicado com outro caminho): ${filename}`);
            }
            return { id: existingHash.id, created: false, status: existingHash.status };
        }
    }

    let fileUuid = null;
    try {
        if (mediaId == null) {
            fileUuid = uuidv4();
            const ins = db.prepare(`
                INSERT INTO media (library_id, uuid, filename, filepath, status, hash, origin, album)
                VALUES (?, ?, ?, ?, 'IMPORTING', ?, ?, ?)
            `).run(libraryId, fileUuid, filename, filePath, hash, origin, album);
            mediaId = ins.lastInsertRowid;
        } else {
            // Reaproveita a linha (presa em IMPORTING/ERROR, movida ou alterada)
            db.prepare(`UPDATE media SET status = 'IMPORTING', hash = ?, filename = ?, album = ?, origin = ?, missing = 0 WHERE id = ?`)
                .run(hash, filename, album, origin, mediaId);
            // uuid já veio na consulta inicial quando a linha é a mesma (existsByPath); senão busca
            fileUuid = (existsByPath && existsByPath.id === mediaId && existsByPath.uuid)
                ? existsByPath.uuid
                : db.prepare('SELECT uuid FROM media WHERE id = ?').get(mediaId).uuid;
        }

        let probeTarget = filePath;
        if (isRaw(filePath)) {
            const sibling = findSiblingJpg(filePath);
            if (sibling) probeTarget = sibling;
        }
        const info = await ffprobe.analyze(probeTarget);

        let thumbnailName = null;
        if (!isAudio(filePath)) thumbnailName = await generateThumbnail(filePath, fileUuid, info.duration);

        const recordedAt = info.creation_time || stats.mtime.toISOString();
        const audioTrackCount = (info.audio_streams && info.audio_streams.length)
            ? info.audio_streams.length : (info.audio_codec ? 1 : 0);

        db.prepare(`
            UPDATE media SET
                filesize = ?, duration = ?, width = ?, height = ?, fps = ?,
                video_codec = ?, audio_codec = ?, audio_track_count = ?, bitrate = ?, thumbnail = ?,
                status = 'READY', imported_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
                recorded_at = ?
            WHERE id = ?
        `).run(
            info.filesize || stats.size, info.duration, info.width, info.height, info.fps,
            info.video_codec, info.audio_codec, audioTrackCount, info.bitrate, thumbnailName,
            recordedAt, mediaId
        );

        logFile(`[MediaIngest] Arquivo indexado com sucesso: ${filename}`);
        if (emit) EventBus.emit('MEDIA_IMPORTED', db.prepare('SELECT * FROM media WHERE id = ?').get(mediaId));
        return { id: mediaId, created, status: 'READY' };
    } catch (err) {
        if (mediaId != null) {
            try { db.prepare('UPDATE media SET status = ? WHERE id = ?').run('ERROR', mediaId); } catch (_) {}
        }
        throw err;
    }
}

module.exports = { ingestFile, resolveOrigin, resolveAlbum };
