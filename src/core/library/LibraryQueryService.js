const dbManager = require('../database/database');

class LibraryQueryService {
    /**
     * Retorna estatÃ­sticas gerais da biblioteca
     */
    static getStats() {
        const db = dbManager.get();
        
        const totals = db.prepare('SELECT COUNT(*) as count, SUM(filesize) as size FROM media WHERE (status = "READY" OR status IS NULL) AND (missing = 0 OR missing IS NULL)').get();
        
        const types = db.prepare(`
            SELECT 
                SUM(CASE WHEN filename LIKE '%.mp4' OR filename LIKE '%.mkv' OR filename LIKE '%.webm' OR filename LIKE '%.mov' THEN 1 ELSE 0 END) as videos,
                SUM(CASE WHEN filename LIKE '%.mp3' OR filename LIKE '%.m4a' OR filename LIKE '%.wav' THEN 1 ELSE 0 END) as audios,
                SUM(CASE WHEN filename LIKE '%.jpg' OR filename LIKE '%.png' THEN 1 ELSE 0 END) as photos
            FROM media WHERE (status = "READY" OR status IS NULL) AND (missing = 0 OR missing IS NULL)
        `).get();

        const lastSync = db.prepare('SELECT MAX(imported_at) as last FROM media').get();

        return {
            totalMedia: totals ? (totals.count || 0) : 0,
            totalSizeBytes: totals ? (totals.size || 0) : 0,
            videosCount: types ? (types.videos || 0) : 0,
            audiosCount: types ? (types.audios || 0) : 0,
            photosCount: types ? (types.photos || 0) : 0,
            lastSyncDate: lastSync ? lastSync.last : null
        };
    }

    /**
     * Busca mÃ­dias com base em filtros complexos e termo de busca em linguagem natural
     * @param {Object} options 
     */
    static searchMedia({ query = '', types = [], origins = [], albums = [], resolutions = [], fps = [], dates = [], projects = [], tags = [], favorites = false, sort = 'recorded_at', order = 'DESC', limit = 100 }) {
        const db = dbManager.get();
        const SearchQueryParser = require('./SearchQueryParser');
        const fs = require('fs');

        const parsed = query ? SearchQueryParser.parse(query) : { cleanQuery: '', types: [], synonyms: [] };

        // Tipos detectados em linguagem natural + filtros manuais
        const finalTypes = new Set([...(types || [])]);
        if (parsed.types && parsed.types.length > 0) {
            parsed.types.forEach(t => finalTypes.add(t));
        }

        // JOINs base â€” reutilizados em SELECT e COUNT
        const joins = `FROM media m
            LEFT JOIN projects p ON m.project_id = p.id
            LEFT JOIN libraries l ON m.library_id = l.id
            LEFT JOIN media_tags mt ON mt.media_id = m.id
            LEFT JOIN tags t ON mt.tag_id = t.id`;

        // Filtros acumulados separados para poder usar no COUNT sem LIMIT/ORDER
        let filterSql = `WHERE (m.status = "READY" OR m.status IS NULL) AND (m.missing = 0 OR m.missing IS NULL)`;
        const filterParams = [];

        if (finalTypes.size > 0) {
            const typeArr = Array.from(finalTypes);
            const typeConditions = [];
            if (typeArr.includes('video')) typeConditions.push("(m.filename LIKE '%.mp4' OR m.filename LIKE '%.mkv' OR m.filename LIKE '%.webm' OR m.filename LIKE '%.mov' OR m.filename LIKE '%.avi')");
            if (typeArr.includes('audio')) typeConditions.push("(m.filename LIKE '%.mp3' OR m.filename LIKE '%.m4a' OR m.filename LIKE '%.wav' OR m.filename LIKE '%.flac' OR m.filename LIKE '%.ogg')");
            if (typeArr.includes('photo')) typeConditions.push("(m.filename LIKE '%.jpg' OR m.filename LIKE '%.jpeg' OR m.filename LIKE '%.png' OR m.filename LIKE '%.heic' OR m.filename LIKE '%.arw')");
            if (typeConditions.length > 0) filterSql += ' AND (' + typeConditions.join(' OR ') + ')';
        }

        if (tags && tags.length > 0) {
            filterSql += ' AND m.id IN (SELECT media_id FROM media_tags WHERE tag_id IN (' + tags.map(() => '?').join(',') + '))';
            filterParams.push(...tags);
        }

        // Busca SemÃ¢ntica + multi-campo
        if (query) {
            const searchTerms = parsed.synonyms && parsed.synonyms.length > 0 ? parsed.synonyms : [query];
            const termConditions = searchTerms.map(term => {
                const q = `%${term}%`;
                filterParams.push(q, q, q, q, q, q);
                return `(m.filename LIKE ? OR m.notes LIKE ? OR m.origin LIKE ? OR p.name LIKE ? OR l.name LIKE ? OR t.name LIKE ?)`;
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

        // COUNT â€” exatamente os mesmos filtros, sem ORDER/LIMIT
        const countSql = `SELECT COUNT(DISTINCT m.id) as total ${joins} ${filterSql}`;
        const countRow = db.prepare(countSql).get(...filterParams);
        const totalCount = countRow ? (countRow.total || 0) : 0;

        // SELECT â€” mesmos filtros + ORDER BY + LIMIT
        const safeOrder = order === 'ASC' ? 'ASC' : 'DESC';
        let orderClause = `ORDER BY COALESCE(m.recorded_at, m.imported_at) ${safeOrder}`;
        if (sort === 'filesize') orderClause = `ORDER BY m.filesize ${safeOrder}`;
        else if (sort === 'imported_at') orderClause = `ORDER BY m.imported_at ${safeOrder}`;

        const selectSql = `SELECT DISTINCT m.* ${joins} ${filterSql} ${orderClause} LIMIT ?`;
        const items = db.prepare(selectSql).all(...filterParams, limit);

        return { items, totalCount };
    }


    
    /**
     * Retorna os Ãºltimos adicionados
     */
    static getRecentMedia(limit = 10) {
        const db = dbManager.get();
        return db.prepare('SELECT * FROM media WHERE (status = "READY" OR status IS NULL) AND (missing = 0 OR missing IS NULL) ORDER BY COALESCE(recorded_at, imported_at) DESC LIMIT ?').all(limit);
    }

    /**
     * Retorna as opÃ§Ãµes e contagens dinÃ¢micas para os filtros
     */
    static getFilterOptions() {
        const db = dbManager.get();
        
        const typeCounts = db.prepare(`
            SELECT 
                SUM(CASE WHEN filename LIKE '%.mp4' OR filename LIKE '%.mkv' OR filename LIKE '%.webm' OR filename LIKE '%.mov' THEN 1 ELSE 0 END) as video,
                SUM(CASE WHEN filename LIKE '%.mp3' OR filename LIKE '%.m4a' OR filename LIKE '%.wav' OR filename LIKE '%.ogg' OR filename LIKE '%.flac' THEN 1 ELSE 0 END) as audio,
                SUM(CASE WHEN filename LIKE '%.jpg' OR filename LIKE '%.png' OR filename LIKE '%.jpeg' THEN 1 ELSE 0 END) as photo
            FROM media WHERE (status = "READY" OR status IS NULL) AND (missing = 0 OR missing IS NULL)
        `).get();
        
        const resolutions = db.prepare("SELECT DISTINCT height, COUNT(id) as count FROM media WHERE height IS NOT NULL AND height > 0 AND (filename LIKE '%.mp4' OR filename LIKE '%.mkv' OR filename LIKE '%.webm' OR filename LIKE '%.mov') GROUP BY height ORDER BY height DESC").all();
        const fpsList = db.prepare("SELECT DISTINCT fps, COUNT(id) as count FROM media WHERE fps IS NOT NULL AND fps > 0 AND (filename LIKE '%.mp4' OR filename LIKE '%.mkv' OR filename LIKE '%.webm' OR filename LIKE '%.mov') GROUP BY fps ORDER BY fps DESC").all();
        const projects = db.prepare('SELECT p.id, p.name, COUNT(m.id) as count FROM projects p LEFT JOIN media m ON m.project_id = p.id GROUP BY p.id ORDER BY p.name ASC').all();
        const tags = db.prepare('SELECT t.id, t.name, t.color, COUNT(mt.media_id) as count FROM tags t LEFT JOIN media_tags mt ON mt.tag_id = t.id GROUP BY t.id ORDER BY t.name ASC').all();
        const favorites = db.prepare('SELECT COUNT(id) as count FROM media WHERE favorite = 1').get();
        const origins = db.prepare('SELECT DISTINCT origin, COUNT(id) as count FROM media WHERE origin IS NOT NULL GROUP BY origin ORDER BY count DESC').all();
        const albums = db.prepare('SELECT DISTINCT album as name, COUNT(id) as count FROM media WHERE status="READY" AND missing=0 AND album IS NOT NULL GROUP BY album ORDER BY name ASC').all();
        const dates = db.prepare('SELECT date(recorded_at) as dt, COUNT(id) as count FROM media WHERE recorded_at IS NOT NULL GROUP BY dt ORDER BY dt DESC LIMIT 10').all();
        
        return {
            types: typeCounts || { video: 0, audio: 0, photo: 0 },
            resolutions,
            fps: fpsList,
            projects,
            tags,
            favoritesCount: favorites ? favorites.count : 0,
            origins,
            albums,
            dates
        };
    }
}

module.exports = LibraryQueryService;

