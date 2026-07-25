const dbManager = require('../database/database');

class LibraryQueryService {
    /**
     * Retorna estatísticas gerais da biblioteca
     */
    static getStats() {
        const db = dbManager.get();
        
        const totals = db.prepare('SELECT COUNT(*) as count, SUM(filesize) as size FROM media WHERE status = "READY" AND missing = 0').get();
        
        const types = db.prepare(`
            SELECT 
                SUM(CASE WHEN filename LIKE '%.mp4' OR filename LIKE '%.mkv' OR filename LIKE '%.webm' OR filename LIKE '%.mov' THEN 1 ELSE 0 END) as videos,
                SUM(CASE WHEN filename LIKE '%.mp3' OR filename LIKE '%.m4a' OR filename LIKE '%.wav' THEN 1 ELSE 0 END) as audios,
                SUM(CASE WHEN filename LIKE '%.jpg' OR filename LIKE '%.png' THEN 1 ELSE 0 END) as photos
            FROM media WHERE status = "READY" AND missing = 0
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
     * Busca mídias com base em filtros complexos e termo de busca
     * @param {Object} options 
     */
    static searchMedia({ query = '', types = [], origins = [], albums = [], resolutions = [], fps = [], dates = [], projects = [], tags = [], favorites = false, sort = 'recorded_at', order = 'DESC', limit = 100 }) {
        const db = dbManager.get();
        
        let sql = 'SELECT m.* FROM media m WHERE m.status = "READY" AND m.missing = 0';
        const params = [];

        if (types && types.length > 0) {
            const typeConditions = [];
            if (types.includes('video')) typeConditions.push("(m.filename LIKE '%.mp4' OR m.filename LIKE '%.mkv' OR m.filename LIKE '%.webm' OR m.filename LIKE '%.mov')");
            if (types.includes('audio')) typeConditions.push("(m.filename LIKE '%.mp3' OR m.filename LIKE '%.m4a' OR m.filename LIKE '%.wav')");
            if (types.includes('photo')) typeConditions.push("(m.filename LIKE '%.jpg' OR m.filename LIKE '%.png')");
            
            if (typeConditions.length > 0) {
                sql += ' AND (' + typeConditions.join(' OR ') + ')';
            }
        }

        if (tags && tags.length > 0) {
            sql += ' AND m.id IN (SELECT media_id FROM media_tags WHERE tag_id IN (' + tags.map(() => '?').join(',') + '))';
            params.push(...tags);
        }

        if (query) {
            sql += ' AND (m.filename LIKE ? OR m.notes LIKE ? OR m.origin LIKE ?)';
            const q = `%${query}%`;
            params.push(q, q, q);
        }

        if (origins && origins.length > 0) {
            const placeholders = origins.map(() => '?').join(',');
            sql += ` AND m.origin IN (${placeholders})`;
            params.push(...origins);
        }

        if (albums && albums.length > 0) {
            const placeholders = albums.map(() => '?').join(',');
            sql += ` AND m.album IN (${placeholders})`;
            params.push(...albums);
        }

        if (resolutions && resolutions.length > 0) {
            const placeholders = resolutions.map(() => '?').join(',');
            sql += ` AND m.height IN (${placeholders})`;
            params.push(...resolutions);
        }

        if (fps && fps.length > 0) {
            const placeholders = fps.map(() => '?').join(',');
            sql += ` AND m.fps IN (${placeholders})`;
            params.push(...fps);
        }

        if (dates && dates.length > 0) {
            const placeholders = dates.map(() => '?').join(',');
            sql += ` AND date(m.recorded_at) IN (${placeholders})`;
            params.push(...dates);
        }
        
        if (projects && projects.length > 0) {
            const placeholders = projects.map(() => '?').join(',');
            sql += ` AND m.project_id IN (${placeholders})`;
            params.push(...projects);
        }
        
        if (favorites) {
            sql += ' AND m.favorite = 1';
        }

        const countSql = sql.replace('SELECT m.*', 'SELECT COUNT(m.id) as total');
        const totalCount = db.prepare(countSql).get(...params).total;

        const safeOrder = order === 'ASC' ? 'ASC' : 'DESC';
        if (sort === 'filesize') {
            sql += ` ORDER BY m.filesize ${safeOrder} LIMIT ?`;
        } else if (sort === 'imported_at') {
            sql += ` ORDER BY m.imported_at ${safeOrder} LIMIT ?`;
        } else {
            sql += ` ORDER BY COALESCE(m.recorded_at, m.imported_at) ${safeOrder} LIMIT ?`;
        }
        params.push(limit);

        const items = db.prepare(sql).all(...params);
        return { items, totalCount };
    }
    
    /**
     * Retorna os últimos adicionados
     */
    static getRecentMedia(limit = 10) {
        const db = dbManager.get();
        return db.prepare('SELECT * FROM media WHERE status = "READY" AND missing = 0 ORDER BY COALESCE(recorded_at, imported_at) DESC LIMIT ?').all(limit);
    }

    /**
     * Retorna as opções e contagens dinâmicas para os filtros
     */
    static getFilterOptions() {
        const db = dbManager.get();
        
        const typeCounts = db.prepare(`
            SELECT 
                SUM(CASE WHEN filename LIKE '%.mp4' OR filename LIKE '%.mkv' OR filename LIKE '%.webm' OR filename LIKE '%.mov' THEN 1 ELSE 0 END) as video,
                SUM(CASE WHEN filename LIKE '%.mp3' OR filename LIKE '%.m4a' OR filename LIKE '%.wav' OR filename LIKE '%.ogg' OR filename LIKE '%.flac' THEN 1 ELSE 0 END) as audio,
                SUM(CASE WHEN filename LIKE '%.jpg' OR filename LIKE '%.png' OR filename LIKE '%.jpeg' THEN 1 ELSE 0 END) as photo
            FROM media WHERE status = "READY" AND missing = 0
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
