const dbManager = require('../database/database');
const EventBus = require('../EventBus');

// Tipos vêm da coluna media.media_type (migração 12: 'video'|'audio'|'photo'|'raw'), sem LIKE de extensão.
// RAW conta também como foto nos totais; o filtro "raw" seleciona só os RAW.
const TYPE_TO_DB = { video: ['video'], audio: ['audio'], photo: ['photo', 'raw'], raw: ['raw'] };
// O "+" unário impede o planner de usar o OR como MULTI-INDEX OR (lento, com TEMP B-TREE no ORDER BY):
// o filtro é avaliado dentro do índice de listagem/estatística (ver migração 12).
const READY_COND = (a = '') => `(+${a}status = 'READY' OR +${a}status IS NULL) AND (+${a}missing = 0 OR +${a}missing IS NULL)`;

const MAX_LIMIT = 5000;           // teto de itens por página
const CACHE_TTL_MS = 10000;       // TTL de segurança de getFilterOptions
const STATS_TTL_MS = 3000;        // cache curto de getStats
const COUNT_TTL_MS = 30000;       // cache do COUNT por filtro (válido só enquanto o banco não recebe escritas)
const COUNT_CACHE_MAX = 50;
const INVALIDATE_WINDOW_MS = 1500; // janela de agrupamento da invalidação durante importação em massa
const FRESH_WINDOW_MS = 1500;      // dentro desta janela o cache vale mesmo que o banco tenha recebido escritas

let filterCache = null;
let statsCache = null;
const countCache = new Map(); // chave de filtro -> { at, seq, total }

const invalidateFilterCache = () => { filterCache = null; statsCache = null; };

// Cache de contadores/filtros: válido enquanto o banco não recebeu escritas (writeSeq) e dentro do TTL; escritas
// vindas de ações do usuário (favoritar, tags, excluir, renomear...) não emitem evento, então a mudança de
// writeSeq invalida o cache — exceto na janela curta FRESH_WINDOW_MS, que protege contra importações em massa.
const cacheValid = (c, ttl) => {
    if (!c) return false;
    const age = Date.now() - c.at;
    if (age < FRESH_WINDOW_MS) return true;
    return c.seq === dbManager.writeSeq && age < ttl;
};

// Invalidação com debounce (leading + trailing): o primeiro evento invalida na hora e abre uma janela;
// eventos dentro da janela só marcam "pendente" e a janela fecha invalidando uma vez. Evita recalcular os
// caches caros (varredura da tabela) a cada arquivo durante uma importação em massa.
let invalidateWindow = null;
let invalidatePending = false;
function scheduleInvalidate() {
    if (invalidateWindow) { invalidatePending = true; return; }
    invalidateFilterCache();
    const open = () => {
        invalidateWindow = setTimeout(() => {
            invalidateWindow = null;
            if (invalidatePending) { invalidatePending = false; invalidateFilterCache(); open(); }
        }, INVALIDATE_WINDOW_MS);
        if (invalidateWindow.unref) invalidateWindow.unref();
    };
    open();
}
EventBus.on('MEDIA_IMPORTED', scheduleInvalidate);
EventBus.on('MEDIA_REMOVED', scheduleInvalidate);

class LibraryQueryService {
    /**
     * Retorna estatísticas gerais da biblioteca
     */
    static getStats() {
        if (cacheValid(statsCache, STATS_TTL_MS)) return statsCache.value;
        const db = dbManager.get();

        // Uma única varredura: totais e contagens por tipo (RAW também conta como foto)
        const t = db.prepare(`
            SELECT COUNT(*) as count, SUM(filesize) as size,
                   SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) as videos,
                   SUM(CASE WHEN media_type = 'audio' THEN 1 ELSE 0 END) as audios,
                   SUM(CASE WHEN media_type IN ('photo', 'raw') THEN 1 ELSE 0 END) as photos,
                   SUM(CASE WHEN media_type = 'raw' THEN 1 ELSE 0 END) as raws
            FROM media WHERE ${READY_COND()}
        `).get();

        const lastSync = db.prepare('SELECT MAX(imported_at) as last FROM media').get();

        const value = {
            totalMedia: t ? (t.count || 0) : 0,
            totalSizeBytes: t ? (t.size || 0) : 0,
            videosCount: t ? (t.videos || 0) : 0,
            audiosCount: t ? (t.audios || 0) : 0,
            photosCount: t ? (t.photos || 0) : 0,
            rawCount: t ? (t.raws || 0) : 0,
            lastSyncDate: lastSync ? lastSync.last : null
        };
        statsCache = { at: Date.now(), seq: dbManager.writeSeq, value };
        return value;
    }

    /**
     * Busca mídias com base em filtros complexos e termo de busca em linguagem natural
     * @param {Object} options 
     */
    static searchMedia({ query = '', types = [], origins = [], albums = [], resolutions = [], fps = [], dates = [], projects = [], tags = [], favorites = false, sort = 'recorded_at', order = 'DESC', limit = 100, offset = 0 }) {
        const db = dbManager.get();
        const SearchQueryParser = require('./SearchQueryParser');

        const parsed = query ? SearchQueryParser.parse(query) : { cleanQuery: '', types: [], synonyms: [], termGroups: [] };

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
            const dbTypes = new Set();
            for (const t of finalTypes) (TYPE_TO_DB[t] || []).forEach(v => dbTypes.add(v));
            if (dbTypes.size > 0) {
                filterSql += ` AND {{T}}m.media_type IN (${Array.from(dbTypes).map(() => '?').join(',')})`;
                filterParams.push(...dbTypes);
            }
        }

        if (tags && tags.length > 0) {
            filterSql += ' AND m.id IN (SELECT media_id FROM media_tags WHERE tag_id IN (' + tags.map(() => '?').join(',') + '))';
            filterParams.push(...tags);
        }

        // Busca Semântica + multi-campo
        // Cada palavra restante vira um grupo (OR entre sinônimos); grupos combinados com AND.
        // Se a busca tinha só palavras de tipo ("vídeos"), não há filtro de texto (RK-045).
        if (query && parsed.termGroups && parsed.termGroups.length > 0) {
            const groupConditions = parsed.termGroups.map(group => {
                const termConditions = group.map(term => {
                    const q = `%${term}%`;
                    filterParams.push(q, q, q, q, q, q);
                    return `(m.filename LIKE ? OR m.notes LIKE ? OR m.origin LIKE ? OR p.name LIKE ? OR l.name LIKE ? OR EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id = m.id AND t.name LIKE ?))`;
                });
                return '(' + termConditions.join(' OR ') + ')';
            });
            filterSql += ' AND ' + groupConditions.join(' AND ');
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
        // Com offset>0 (paginação) reaproveita o COUNT da mesma combinação de filtros enquanto o banco
        // não recebeu escritas (dbManager.writeSeq) — evita recontar a cada página.
        const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
        const countKey = filterSql + '|' + JSON.stringify(filterParams);
        const seq = dbManager.writeSeq;
        let totalCount;
        const cached = safeOffset > 0 ? countCache.get(countKey) : null;
        if (cached && cached.seq === seq && Date.now() - cached.at < COUNT_TTL_MS) {
            totalCount = cached.total;
        } else {
            // O COUNT só precisa dos JOINs quando a busca por texto referencia projects/libraries (os LEFT JOINs por PK não alteram a contagem)
            const countJoins = query ? joins : 'FROM media m';
            const countRow = db.prepare(`SELECT COUNT(*) as total ${countJoins} ${filterSql.replace('{{T}}', '')}`).get(...filterParams);
            totalCount = countRow ? (countRow.total || 0) : 0;
            if (countCache.size >= COUNT_CACHE_MAX) countCache.delete(countCache.keys().next().value);
            countCache.set(countKey, { at: Date.now(), seq, total: totalCount });
        }

        // SELECT — mesmos filtros + ORDER BY + LIMIT
        const safeOrder = order === 'ASC' ? 'ASC' : 'DESC';
        // sort_date = COALESCE(recorded_at, imported_at) materializada. Com filtro por dia (date() não é indexável e
        // casa poucas linhas) o "+" evita varrer o índice de ordenação inteiro: filtra e ordena só o resultado.
        const sortCol = (dates && dates.length > 0) ? '+m.sort_date' : 'm.sort_date';
        let orderClause = `ORDER BY ${sortCol} ${safeOrder}`;
        if (sort === 'filesize') orderClause = `ORDER BY m.filesize ${safeOrder}`;
        else if (sort === 'imported_at') orderClause = `ORDER BY m.imported_at ${safeOrder}`;

        const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 100, MAX_LIMIT));
        // Desempate por id mantém a paginação estável
        const selectSql = `SELECT m.*, p.name as project_name ${joins} ${filterSql.replace('{{T}}', '+')} ${orderClause}, m.id ${safeOrder} LIMIT ? OFFSET ?`;
        const items = db.prepare(selectSql).all(...filterParams, safeLimit, safeOffset);

        // totalCount = total que casa com os filtros (independe de limit/offset); total é alias
        return { items, totalCount, total: totalCount, offset: safeOffset, limit: safeLimit, hasMore: safeOffset + items.length < totalCount };
    }



    
    /**
     * Retorna os últimos adicionados
     */
    static getRecentMedia(limit = 10) {
        const db = dbManager.get();
        return db.prepare(`SELECT * FROM media WHERE ${READY_COND()} ORDER BY sort_date DESC, id DESC LIMIT ?`).all(limit);
    }

    /**
     * Retorna as opções e contagens dinâmicas para os filtros
     */
    static getFilterOptions() {
        if (cacheValid(filterCache, CACHE_TTL_MS)) return filterCache.value;
        const db = dbManager.get();
        
        const typeCounts = db.prepare(`
            SELECT
                SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) as video,
                SUM(CASE WHEN media_type = 'audio' THEN 1 ELSE 0 END) as audio,
                SUM(CASE WHEN media_type IN ('photo', 'raw') THEN 1 ELSE 0 END) as photo,
                SUM(CASE WHEN media_type = 'raw' THEN 1 ELSE 0 END) as raw
            FROM media WHERE ${READY_COND()}
        `).get();

        // Resoluções e FPS dos vídeos numa única varredura do índice de cobertura (media_type, height, fps);
        // as contagens por altura e por fps são somadas aqui (mesmos filtros height>0 / fps>0 de antes).
        const resMap = new Map();
        const fpsMap = new Map();
        const hf = db.prepare("SELECT height, fps, COUNT(*) as count FROM media WHERE media_type = 'video' GROUP BY height, fps").all();
        for (const r of hf) {
            if (r.height != null && r.height > 0) resMap.set(r.height, (resMap.get(r.height) || 0) + r.count);
            if (r.fps != null && r.fps > 0) fpsMap.set(r.fps, (fpsMap.get(r.fps) || 0) + r.count);
        }
        const resolutions = [...resMap].map(([height, count]) => ({ height, count })).sort((a, b) => b.height - a.height);
        const fpsList = [...fpsMap].map(([fps, count]) => ({ fps, count })).sort((a, b) => b.fps - a.fps);
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
        filterCache = { at: Date.now(), seq: dbManager.writeSeq, value };
        return value;
    }

    /** Descarta o cache de getFilterOptions (ex.: após favoritar ou alterar tags). */
    static invalidateFilterOptionsCache() {
        invalidateFilterCache();
    }
}

module.exports = LibraryQueryService;

