const dbManager = require('../database/database');
const EventBus = require('../EventBus');

// Extensões por tipo — fonte única para getStats/searchMedia/getFilterOptions.
// (Quando existir src/core/media/MediaTypes.js, trocar por import.)
const VIDEO_EXTS = ['mp4', 'mkv', 'webm', 'mov', 'avi'];
const AUDIO_EXTS = ['mp3', 'm4a', 'wav', 'flac', 'ogg'];
const RAW_EXTS = ['arw', 'cr2', 'cr3', 'nef', 'dng', 'raf', 'orf', 'rw2'];
const PHOTO_EXTS = ['jpg', 'jpeg', 'png', 'heic', ...RAW_EXTS]; // RAW conta também como foto

const extCond = (col, exts) => '(' + exts.map(e => `${col} LIKE '%.${e}'`).join(' OR ') + ')';
const typeCase = (col, exts) => `SUM(CASE WHEN ${extCond(col, exts)} THEN 1 ELSE 0 END)`;
const READY_COND = (a = '') => `(${a}status = 'READY' OR ${a}status IS NULL) AND (${a}missing = 0 OR ${a}missing IS NULL)`;

// Cache de getFilterOptions: invalidado por eventos de mídia, com TTL de segurança
const FILTER_CACHE_TTL_MS = 10000;
let filterCache = null;
const invalidateFilterCache = () => { filterCache = null; };
EventBus.on('MEDIA_IMPORTED', invalidateFilterCache);
EventBus.on('MEDIA_REMOVED', invalidateFilterCache);

class LibraryQueryService {
    /**
     * Retorna estatísticas gerais da biblioteca
     */
    static getStats() {
        const db = dbManager.get();
        
        const totals = db.prepare(`SELECT COUNT(*) as count, SUM(filesize) as size FROM media WHERE ${READY_COND()}`).get();
        
        const types = db.prepare(`
            SELECT 
                ${typeCase('filename', VIDEO_EXTS)} as videos,
                ${typeCase('filename', AUDIO_EXTS)} as audios,
                ${typeCase('filename', PHOTO_EXTS)} as photos,
                ${typeCase('filename', RAW_EXTS)} as raws
            FROM media WHERE ${READY_COND()}
        `).get();

        const lastSync = db.prepare('SELECT MAX(imported_at) as last FROM media').get();

        return {
            totalMedia: totals ? (totals.count || 0) : 0,
            totalSizeBytes: totals ? (totals.size || 0) : 0,
            videosCount: types ? (types.videos || 0) : 0,
            audiosCount: types ? (types.audios || 0) : 0,
            photosCount: types ? (types.photos || 0) : 0,
            rawCount: types ? (types.raws || 0) : 0,
            lastSyncDate: lastSync ? lastSync.last : null
        };
    }

    /**
     * Busca mídias com base em filtros complexos e termo de busca em linguagem natural
     * @param {Object} options 
     */
    static searchMedia({ query = '', types = [], origins = [], albums = [], resolutions = [], fps = [], dates = [], projects = [], tags = [], favorites = false, sort = 'recorded_at', order = 'DESC', limit = 100, offset = 0 }) {
        const db = dbManager.get();
        const SearchQueryParser = require('./SearchQueryParser');
        const fs = require('fs');

        const parsed = query ? SearchQueryParser.parse(query) : { cleanQuery: '', types: [], synonyms: [] };

        // Tipos detectados em linguagem natural + filtros manuais
        const finalTypes = new Set([...(types || [])]);
        if (parsed.types && parsed.types.length > 0) {
            parsed.types.forEach(t => finalTypes.add(t));
        }

        // JOINs base — reutilizados em SELECT e COUNT
        const joins = `FROM media m
            LEFT JOIN projects p ON m.project_id = p.id
            LEFT JOIN libraries l ON m.library_id = l.id`;

        // Filtros acumulados separados para poder usar no COUNT sem LIMIT/ORDER
        let filterSql = `WHERE ${READY_COND('m.')}`;
        const filterParams = [];

        if (finalTypes.size > 0) {
            const typeArr = Array.from(finalTypes);
            const typeConditions = [];
            if (typeArr.includes('video')) typeConditions.push(extCond('m.filename', VIDEO_EXTS));
            if (typeArr.includes('audio')) typeConditions.push(extCond('m.filename', AUDIO_EXTS));
            if (typeArr.includes('photo')) typeConditions.push(extCond('m.filename', PHOTO_EXTS));
            if (typeArr.includes('raw')) typeConditions.push(extCond('m.filename', RAW_EXTS));
            if (typeConditions.length > 0) filterSql += ' AND (' + typeConditions.join(' OR ') + ')';
        }

        if (tags && tags.length > 0) {
            filterSql += ' AND m.id IN (SELECT media_id FROM media_tags WHERE tag_id IN (' + tags.map(() => '?').join(',') + '))';
            filterParams.push(...tags);
        }

        // Busca Semântica + multi-campo
        if (query) {
            const searchTerms = parsed.synonyms && parsed.synonyms.length > 0 ? parsed.synonyms : [query];
            const termConditions = searchTerms.map(term => {
                const q = `%${term}%`;
                filterParams.push(q, q, q, q, q, q);
                return `(m.filename LIKE ? OR m.notes LIKE ? OR m.origin LIKE ? OR p.name LIKE ? OR l.name LIKE ? OR EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id = m.id AND t.name LIKE ?))`;
            });
            filterSql += ' AND (' + termConditions.join(' OR ') + ')';
        }

        if (origins && origins.length > 0) {
            filterSql += ` AND m.origin IN (${origins.map(() => '?').join(',')})`;
            filterParams.push(...origins);
        }

        if (albums && albums.length > 0) {
            filterSql += ` AND m.album IN (${albums.map(() => '?').join(',')})`;
            filterParams.push(...albums);
        }

        if (resolutions && resolutions.length > 0) {
            filterSql += ` AND m.height IN (${resolutions.map(() => '?').join(',')})`;
            filterParams.push(...resolutions);
        }

        if (fps && fps.length > 0) {
            filterSql += ` AND m.fps IN (${fps.map(() => '?').join(',')})`;
            filterParams.push(...fps);
        }

        if (dates && dates.length > 0) {
            filterSql += ` AND date(m.recorded_at) IN (${dates.map(() => '?').join(',')})`;
            filterParams.push(...dates);
        }

        if (projects && projects.length > 0) {
            filterSql += ` AND m.project_id IN (${projects.map(() => '?').join(',')})`;
            filterParams.push(...projects);
        }

        if (favorites) {
            filterSql += ' AND m.favorite = 1';
        }

        // COUNT — exatamente os mesmos filtros, sem ORDER/LIMIT
        const countSql = `SELECT COUNT(*) as total ${joins} ${filterSql}`;
        const countRow = db.prepare(countSql).get(...filterParams);
        const totalCount = countRow ? (countRow.total || 0) : 0;

        // SELECT — mesmos filtros + ORDER BY + LIMIT
        const safeOrder = order === 'ASC' ? 'ASC' : 'DESC';
        let orderClause = `ORDER BY COALESCE(m.recorded_at, m.imported_at) ${safeOrder}`;
        if (sort === 'filesize') orderClause = `ORDER BY m.filesize ${safeOrder}`;
        else if (sort === 'imported_at') orderClause = `ORDER BY m.imported_at ${safeOrder}`;

        const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 100, 100000));
        const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
        // Desempate por id mantém a paginação estável
        const selectSql = `SELECT m.*, p.name as project_name ${joins} ${filterSql} ${orderClause}, m.id ${safeOrder} LIMIT ? OFFSET ?`;
        const items = db.prepare(selectSql).all(...filterParams, safeLimit, safeOffset);

        // totalCount = total que casa com os filtros (independe de limit/offset); total é alias
        return { items, totalCount, total: totalCount, offset: safeOffset, limit: safeLimit, hasMore: safeOffset + items.length < totalCount };
    }



    
    /**
     * Retorna os últimos adicionados
     */
    static getRecentMedia(limit = 10) {
        const db = dbManager.get();
        return db.prepare(`SELECT * FROM media WHERE ${READY_COND()} ORDER BY COALESCE(recorded_at, imported_at) DESC LIMIT ?`).all(limit);
    }

    /**
     * Retorna as opções e contagens dinâmicas para os filtros
     */
    static getFilterOptions() {
        if (filterCache && Date.now() - filterCache.at < FILTER_CACHE_TTL_MS) return filterCache.value;
        const db = dbManager.get();
        
        const typeCounts = db.prepare(`
            SELECT 
                ${typeCase('filename', VIDEO_EXTS)} as video,
                ${typeCase('filename', AUDIO_EXTS)} as audio,
                ${typeCase('filename', PHOTO_EXTS)} as photo,
                ${typeCase('filename', RAW_EXTS)} as raw
            FROM media WHERE ${READY_COND()}
        `).get();
        
        const videoCond = extCond('filename', VIDEO_EXTS);
        const resolutions = db.prepare(`SELECT height, COUNT(id) as count FROM media WHERE height IS NOT NULL AND height > 0 AND ${videoCond} GROUP BY height ORDER BY height DESC`).all();
        const fpsList = db.prepare(`SELECT fps, COUNT(id) as count FROM media WHERE fps IS NOT NULL AND fps > 0 AND ${videoCond} GROUP BY fps ORDER BY fps DESC`).all();
        const projects = db.prepare('SELECT p.id, p.name, COUNT(m.id) as count FROM projects p LEFT JOIN media m ON m.project_id = p.id GROUP BY p.id ORDER BY p.name ASC').all();
        const tags = db.prepare('SELECT t.id, t.name, t.color, COUNT(mt.media_id) as count FROM tags t LEFT JOIN media_tags mt ON mt.tag_id = t.id GROUP BY t.id ORDER BY t.name ASC').all();
        const favorites = db.prepare('SELECT COUNT(id) as count FROM media WHERE favorite = 1').get();
        const origins = db.prepare('SELECT DISTINCT origin, COUNT(id) as count FROM media WHERE origin IS NOT NULL GROUP BY origin ORDER BY count DESC').all();
        const albums = db.prepare(`SELECT DISTINCT album as name, COUNT(id) as count FROM media WHERE status = 'READY' AND missing = 0 AND album IS NOT NULL GROUP BY album ORDER BY name ASC`).all();
        const dates = db.prepare('SELECT date(recorded_at) as dt, COUNT(id) as count FROM media WHERE recorded_at IS NOT NULL GROUP BY dt ORDER BY dt DESC LIMIT 10').all();
        
        const value = {
            types: typeCounts || { video: 0, audio: 0, photo: 0, raw: 0 },
            resolutions,
            fps: fpsList,
            projects,
            tags,
            favoritesCount: favorites ? favorites.count : 0,
            origins,
            albums,
            dates
        };
        filterCache = { at: Date.now(), value };
        return value;
    }

    /** Descarta o cache de getFilterOptions (ex.: após favoritar ou alterar tags). */
    static invalidateFilterOptionsCache() {
        invalidateFilterCache();
    }
}

module.exports = LibraryQueryService;

