const dbManager = require('../database/database');
const logger = require('../../services/logService');
const fs = require('fs');
const {
    normalizeStatus, DEFAULT_STATUS, DELIVERY_STATUSES, DEFAULT_DELIVERY_ITEMS, DEFAULT_DELIVERY_DESTINATIONS,
    DEVICE_CATEGORY_IDS, ACTIVITY_KINDS, LIMITS
} = require('./projectStatus');

/** Colunas que a tela pode alterar em cada tabela: o SQL nunca recebe um nome de coluna vindo do renderer. */
const PROJECT_COLUMNS = Object.freeze(['name', 'description', 'status', 'color', 'client', 'type', 'start_date', 'deadline', 'cover_path']);
const SEQUENCE_COLUMNS = Object.freeze(['name', 'timebase', 'sample_rate', 'width', 'height']);
const TRACK_COLUMNS = Object.freeze(['name', 'track_index', 'muted', 'locked', 'solo', 'enabled', 'volume']);
const CLIP_COLUMNS = Object.freeze(['project_media_id', 'media_id', 'name', 'start_time', 'end_time', 'in_point', 'out_point', 'color', 'audio_stream_index', 'speed', 'volume', 'enabled']);

/** Monta "col = ?" só para as colunas permitidas que vieram em `data`. */
function pickColumns(data, allowed) {
    const fields = [];
    const values = [];
    for (const key of allowed) {
        if (data && Object.prototype.hasOwnProperty.call(data, key)) {
            fields.push(`${key} = ?`);
            values.push(data[key]);
        }
    }
    return { fields, values };
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const parseJsonList = (raw, fallback) => {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : fallback; } catch (_) { return fallback; }
};

class ProjectService {
    constructor() {
    }

    get db() {
        return dbManager.get();
    }

    getAllProjects() {
        const stmt = this.db.prepare(`
            SELECT p.*,
                   (SELECT COUNT(*) FROM project_media pm WHERE pm.project_id = p.id) as media_count,
                   (SELECT SUM(m.filesize) FROM project_media pm JOIN media m ON pm.media_id = m.id WHERE pm.project_id = p.id) as total_size,
                   (SELECT d.status FROM project_delivery d WHERE d.project_id = p.id) as delivery_status,
                   (SELECT d.items FROM project_delivery d WHERE d.project_id = p.id) as delivery_items_json
            FROM projects p
            ORDER BY p.created_at DESC
        `);
        // Progresso da entrega (itens concluídos / total) para o cartão; nada de JSON cru sai daqui
        return stmt.all().map((p) => {
            const items = parseJsonList(p.delivery_items_json, null);
            const { delivery_items_json, ...rest } = p;
            return { ...rest, delivery_done: items ? items.filter((i) => i && i.done).length : 0, delivery_total: items ? items.length : 0 };
        });
    }

    // --- ATIVIDADE (registro) ---

    /** Registra um evento do projeto e atualiza `last_activity_at`. Nunca lança (o registro é acessório). */
    logActivity(projectId, kind, message) {
        try {
            const k = ACTIVITY_KINDS.includes(kind) ? kind : 'editado';
            this.db.prepare(`INSERT INTO project_activity (project_id, kind, message) VALUES (?, ?, ?)`).run(projectId, k, text(message, 200));
            this.db.prepare(`UPDATE projects SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ?`).run(projectId);
        } catch (e) {
            logger.warn('[Projects] atividade não registrada', { error: e.message });
        }
    }

    listActivity(projectId, limit = 50) {
        const n = Math.max(1, Math.min(LIMITS.activityMax, Number(limit) || 50));
        return this.db.prepare(`SELECT id, kind, message, created_at FROM project_activity WHERE project_id = ? ORDER BY id DESC LIMIT ?`).all(projectId, n);
    }

    /** Atividade recente de TODOS os projetos (coluna lateral da tela Projetos). */
    listRecentActivity(limit = 20) {
        const n = Math.max(1, Math.min(100, Number(limit) || 20));
        return this.db.prepare(`
            SELECT a.id, a.project_id, p.name AS project_name, p.color AS project_color, a.kind, a.message, a.created_at
            FROM project_activity a JOIN projects p ON p.id = a.project_id
            ORDER BY a.id DESC LIMIT ?
        `).all(n);
    }

    /** Estrutura de pastas sugerida (.docs/BDS_TELA_PROJETOS.md §6): só cria o que ainda não existe. */
    createDefaultBins(projectId) {
        const existing = new Set(this.getProjectBins(projectId).map((b) => b.name.trim().toUpperCase()));
        const created = [];
        const db = this.db;
        db.exec('BEGIN TRANSACTION');
        try {
            const mk = (name, parentId = null) => {
                if (parentId === null && existing.has(name.toUpperCase())) return this.getProjectBins(projectId).find((b) => !b.parent_id && b.name.trim().toUpperCase() === name.toUpperCase()).id;
                const id = this.createBin(projectId, parentId, name);
                created.push(name);
                return id;
            };
            const brutos = mk('BRUTOS');
            const subs = new Set(this.getProjectBins(projectId).filter((b) => b.parent_id === brutos).map((b) => b.name.trim().toUpperCase()));
            for (const s of ['CÂMERA A', 'CÂMERA B', 'ÁUDIO EXTERNO']) if (!subs.has(s)) mk(s, brutos);
            for (const n of ['FOTOS', 'ÁUDIO', 'EXPORTAÇÕES', 'PROJETO']) mk(n);
            db.exec('COMMIT');
        } catch (e) {
            try { db.exec('ROLLBACK'); } catch (_) { /* já revertida */ }
            throw e;
        }
        if (created.length) this.logActivity(projectId, 'pasta', `Estrutura de pastas criada (${created.length})`);
        return created;
    }

    /** Ajuste manual da posição de um clipe num grupo de sincronia (aba Áudio). */
    updateSyncGroupItem(itemId, { offset_seconds }) {
        const v = Number(offset_seconds);
        if (!Number.isFinite(v)) throw new Error('Posição inválida.');
        return this.db.prepare(`UPDATE sync_group_items SET offset_seconds = ?, confidence = 1 WHERE id = ?`).run(Number(v.toFixed(3)), itemId).changes > 0;
    }

    /** Acrescenta um clipe (ou atualiza) num grupo de sincronia: posição manual de um clipe ainda não posicionado. */
    upsertSyncGroupItem(groupId, mediaId, offsetSeconds) {
        const v = Number(offsetSeconds);
        if (!Number.isFinite(v)) throw new Error('Posição inválida.');
        const row = this.db.prepare('SELECT id FROM sync_group_items WHERE sync_group_id = ? AND media_id = ?').get(groupId, mediaId);
        if (row) { this.db.prepare('UPDATE sync_group_items SET offset_seconds = ?, confidence = 1 WHERE id = ?').run(Number(v.toFixed(3)), row.id); return row.id; }
        return this.db.prepare('INSERT INTO sync_group_items (sync_group_id, media_id, offset_seconds, confidence, drift_rate_ppm) VALUES (?, ?, ?, 1, 0)').run(groupId, mediaId, Number(v.toFixed(3))).lastInsertRowid;
    }

    getProjectById(id) {
        const stmt = this.db.prepare(`
            SELECT p.*,
                   (SELECT COUNT(*) FROM project_media pm WHERE pm.project_id = p.id) as media_count,
                   (SELECT SUM(m.filesize) FROM project_media pm JOIN media m ON pm.media_id = m.id WHERE pm.project_id = p.id) as total_size,
                   (SELECT d.status FROM project_delivery d WHERE d.project_id = p.id) as delivery_status
            FROM projects p
            WHERE p.id = ?
        `);
        return stmt.get(id);
    }

    createProject(data, { log = true } = {}) {
        const { name, description, status, color, client, type, start_date, deadline, cover_path } = data;
        const stmt = this.db.prepare(`
            INSERT INTO projects (name, description, status, color, client, type, start_date, deadline, cover_path, updated_at, last_activity_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `);
        const info = stmt.run(
            name,
            description || '',
            normalizeStatus(status),
            color || '#3b82f6',
            client || '',
            type || '',
            start_date || null,
            deadline || null,
            cover_path || ''
        );
        const id = info.lastInsertRowid;
        if (log) this.logActivity(id, 'criado', 'Projeto criado');
        return id;
    }

    /**
     * Altera só as colunas permitidas (PROJECT_COLUMNS); `status` é normalizado para um dos 7 estados.
     * Mudança de status entra no registro de atividade.
     */
    updateProject(id, data) {
        const patch = { ...(data || {}) };
        if (Object.prototype.hasOwnProperty.call(patch, 'status')) patch.status = normalizeStatus(patch.status);
        const { fields, values } = pickColumns(patch, PROJECT_COLUMNS);
        if (fields.length === 0) return false;

        const before = Object.prototype.hasOwnProperty.call(patch, 'status') ? this.db.prepare('SELECT status FROM projects WHERE id = ?').get(id) : null;
        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);
        const stmt = this.db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`);
        const info = stmt.run(...values);
        if (info.changes > 0 && before && before.status !== patch.status) {
            this.logActivity(id, 'status', `Status: ${patch.status}`);
        }
        return info.changes > 0;
    }

    /** Arquivar = status "Arquivado" (nada é apagado). */
    archiveProject(id) {
        return this.updateProject(id, { status: 'Arquivado' });
    }

    /**
     * Duplica um projeto: dados, pastas, mídias referenciadas, dispositivos e entrega (sem sequências nem grupos de
     * sincronia, que são trabalho de edição). A cópia nasce em "Planejamento" e sem capa própria (referencia a mesma).
     */
    duplicateProject(id) {
        const src = this.getProjectById(id);
        if (!src) throw new Error('Projeto não encontrado');
        const db = this.db;
        db.exec('BEGIN TRANSACTION');
        try {
            const newId = this.createProject({
                name: `${src.name} (cópia)`.slice(0, LIMITS.nameMax), description: src.description, status: DEFAULT_STATUS, color: src.color,
                client: src.client, type: src.type, start_date: src.start_date, deadline: src.deadline, cover_path: src.cover_path
            }, { log: false });
            const binMap = new Map();
            const bins = this.getProjectBins(id);
            const pending = [...bins];
            // pais antes dos filhos (a lista é ordenada por nome, não por hierarquia)
            let guard = 0;
            while (pending.length && guard++ < 10000) {
                const b = pending.shift();
                if (b.parent_id && !binMap.has(b.parent_id)) { pending.push(b); continue; }
                binMap.set(b.id, this.createBin(newId, b.parent_id ? binMap.get(b.parent_id) : null, b.name));
            }
            for (const pm of db.prepare('SELECT bin_id, media_id, custom_name FROM project_media WHERE project_id = ?').all(id)) {
                db.prepare('INSERT INTO project_media (project_id, bin_id, media_id, custom_name) VALUES (?, ?, ?, ?)')
                    .run(newId, pm.bin_id ? (binMap.get(pm.bin_id) || null) : null, pm.media_id, pm.custom_name);
            }
            for (const d of this.listDevices(id)) {
                db.prepare('INSERT INTO project_devices (project_id, category, name, note) VALUES (?, ?, ?, ?)').run(newId, d.category, d.name, d.note);
            }
            const delivery = db.prepare('SELECT * FROM project_delivery WHERE project_id = ?').get(id);
            if (delivery) {
                db.prepare('INSERT INTO project_delivery (project_id, status, deadline, items, destinations, notes) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(newId, 'Não iniciada', delivery.deadline, delivery.items, delivery.destinations, delivery.notes);
            }
            this.logActivity(newId, 'duplicado', `Criado a partir de "${text(src.name, 80)}"`);
            this.logActivity(id, 'duplicado', 'Projeto duplicado');
            db.exec('COMMIT');
            return newId;
        } catch (e) {
            try { db.exec('ROLLBACK'); } catch (_) { /* já revertida */ }
            throw e;
        }
    }

    /**
     * Resumo da Visão Geral: contagens por tipo, espaço, mídias ausentes, pastas, dispositivos, transcrições ao lado
     * das mídias (conferidas em disco, até 500 arquivos), entrega e última atividade.
     */
    getProjectSummary(projectId) {
        const project = this.getProjectById(projectId);
        if (!project) throw new Error('Projeto não encontrado');
        const media = this.db.prepare(`
            SELECT m.filepath, m.filesize, m.missing, m.media_type, m.filename
            FROM project_media pm JOIN media m ON pm.media_id = m.id WHERE pm.project_id = ?
        `).all(projectId);
        const counts = { video: 0, audio: 0, photo: 0, other: 0 };
        let size = 0;
        let missing = 0;
        let transcripts = 0;
        let checked = 0;
        for (const m of media) {
            const t = m.media_type || 'other';
            counts[t] = (counts[t] || 0) + 1;
            size += Number(m.filesize) || 0;
            if (m.missing) missing++;
            if (checked < 500 && (t === 'video' || t === 'audio') && m.filepath) {
                checked++;
                const base = m.filepath.replace(/\.[^./\\]+$/, '');
                if (['.md', '.srt', '.txt', '.vtt'].some((ext) => { try { return fs.existsSync(base + ext); } catch (_) { return false; } })) transcripts++;
            }
        }
        const bins = this.db.prepare('SELECT COUNT(*) AS n FROM project_bins WHERE project_id = ?').get(projectId).n;
        const devices = this.db.prepare('SELECT COUNT(*) AS n FROM project_devices WHERE project_id = ?').get(projectId).n;
        const delivery = this.getDelivery(projectId);
        const last = this.db.prepare('SELECT kind, message, created_at FROM project_activity WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId) || null;
        return {
            id: project.id,
            videos: counts.video, audios: counts.audio, photos: counts.photo, others: counts.other, total: media.length,
            total_size: size, missing, bins, devices, transcripts,
            delivery: { status: delivery.status, done: delivery.items.filter((i) => i.done).length, items: delivery.items.length, deadline: delivery.deadline },
            last_activity_at: project.last_activity_at || project.created_at,
            last_activity: last
        };
    }

    // --- DISPOSITIVOS DO PROJETO ---

    listDevices(projectId) {
        return this.db.prepare(`SELECT id, category, name, note, created_at FROM project_devices WHERE project_id = ? ORDER BY category ASC, name ASC`).all(projectId);
    }

    addDevice(projectId, { category, name, note } = {}) {
        const cat = DEVICE_CATEGORY_IDS.includes(category) ? category : 'other';
        const nm = text(name, LIMITS.deviceNameMax);
        if (!nm) throw new Error('Informe o nome do dispositivo.');
        const info = this.db.prepare(`INSERT INTO project_devices (project_id, category, name, note) VALUES (?, ?, ?, ?)`)
            .run(projectId, cat, nm, text(note, LIMITS.deviceNoteMax) || null);
        this.logActivity(projectId, 'dispositivo', `Dispositivo adicionado: ${nm}`);
        return info.lastInsertRowid;
    }

    removeDevice(deviceId) {
        const row = this.db.prepare('SELECT project_id, name FROM project_devices WHERE id = ?').get(deviceId);
        if (!row) return false;
        const info = this.db.prepare(`DELETE FROM project_devices WHERE id = ?`).run(deviceId);
        if (info.changes > 0) this.logActivity(row.project_id, 'dispositivo', `Dispositivo removido: ${row.name}`);
        return info.changes > 0;
    }

    // --- ENTREGA ---

    /** Controle de entrega do projeto; sem linha gravada devolve o padrão (itens e destinos sugeridos, nada marcado). */
    getDelivery(projectId) {
        const row = this.db.prepare('SELECT * FROM project_delivery WHERE project_id = ?').get(projectId);
        const items = row ? parseJsonList(row.items, []) : DEFAULT_DELIVERY_ITEMS.map((label) => ({ label, done: false }));
        const destinations = row ? parseJsonList(row.destinations, []) : DEFAULT_DELIVERY_DESTINATIONS.map((label) => ({ label, checked: false }));
        return {
            project_id: projectId,
            status: row && DELIVERY_STATUSES.includes(row.status) ? row.status : DELIVERY_STATUSES[0],
            deadline: row ? row.deadline : null,
            items: items.map((i) => ({ label: text(i && i.label, 80), done: Boolean(i && i.done) })).filter((i) => i.label),
            destinations: destinations.map((d) => ({ label: text(d && d.label, 40), checked: Boolean(d && d.checked) })).filter((d) => d.label),
            notes: row ? (row.notes || '') : '',
            updated_at: row ? row.updated_at : null,
            saved: Boolean(row)
        };
    }

    setDelivery(projectId, data = {}) {
        const current = this.getDelivery(projectId);
        const next = {
            status: DELIVERY_STATUSES.includes(data.status) ? data.status : current.status,
            deadline: Object.prototype.hasOwnProperty.call(data, 'deadline') ? (text(data.deadline, 10) || null) : current.deadline,
            items: Array.isArray(data.items) ? data.items.slice(0, LIMITS.deliveryItemsMax).map((i) => ({ label: text(i && i.label, 80), done: Boolean(i && i.done) })).filter((i) => i.label) : current.items,
            destinations: Array.isArray(data.destinations) ? data.destinations.slice(0, LIMITS.deliveryItemsMax).map((d) => ({ label: text(d && d.label, 40), checked: Boolean(d && d.checked) })).filter((d) => d.label) : current.destinations,
            notes: Object.prototype.hasOwnProperty.call(data, 'notes') ? text(data.notes, LIMITS.textMax) : current.notes
        };
        this.db.prepare(`
            INSERT INTO project_delivery (project_id, status, deadline, items, destinations, notes, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(project_id) DO UPDATE SET status = excluded.status, deadline = excluded.deadline, items = excluded.items,
                destinations = excluded.destinations, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP
        `).run(projectId, next.status, next.deadline, JSON.stringify(next.items), JSON.stringify(next.destinations), next.notes);
        if (next.status !== current.status) this.logActivity(projectId, 'entrega', `Entrega: ${next.status}`);
        else this.logActivity(projectId, 'entrega', 'Entrega atualizada');
        return this.getDelivery(projectId);
    }

    deleteProject(id) {
        // media.project_id referencia projects(id) sem ON DELETE: solta as mídias da Biblioteca antes (RK-018)
        this.db.exec('BEGIN TRANSACTION');
        try {
            this.db.prepare(`UPDATE media SET project_id = NULL WHERE project_id = ?`).run(id);
            const info = this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
            this.db.exec('COMMIT');
            return info.changes > 0;
        } catch (e) {
            try { this.db.exec('ROLLBACK'); } catch (_) {}
            throw e;
        }
    }

    // --- BINS ---
    
    getProjectBins(projectId) {
        const stmt = this.db.prepare(`SELECT * FROM project_bins WHERE project_id = ? ORDER BY name ASC`);
        return stmt.all(projectId);
    }

    createBin(projectId, parentId, name) {
        const stmt = this.db.prepare(`INSERT INTO project_bins (project_id, parent_id, name) VALUES (?, ?, ?)`);
        const info = stmt.run(projectId, parentId || null, name);
        return info.lastInsertRowid;
    }

    updateBin(id, name, parentId) {
        const stmt = this.db.prepare(`UPDATE project_bins SET name = ?, parent_id = ? WHERE id = ?`);
        const info = stmt.run(name, parentId, id);
        return info.changes > 0;
    }

    deleteBin(id) {
        const stmt = this.db.prepare(`DELETE FROM project_bins WHERE id = ?`);
        const info = stmt.run(id);
        return info.changes > 0;
    }

    // --- MEDIA IN BINS ---

    getProjectMedia(projectId) {
        const stmt = this.db.prepare(`
            SELECT pm.id as pm_id, pm.bin_id, pm.custom_name, m.* 
            FROM project_media pm
            JOIN media m ON pm.media_id = m.id
            WHERE pm.project_id = ?
        `);
        return stmt.all(projectId);
    }

    addMediaToBin(projectId, binId, mediaId, customName = null) {
        // Dedupe por (project_id, media_id): reaproveita o vínculo existente (RK-084)
        const existing = this.db.prepare(`SELECT id FROM project_media WHERE project_id = ? AND media_id = ? LIMIT 1`).get(projectId, mediaId);
        if (existing) {
            if (binId) this.db.prepare(`UPDATE project_media SET bin_id = ? WHERE id = ?`).run(binId, existing.id);
            return existing.id;
        }
        const stmt = this.db.prepare(`
            INSERT INTO project_media (project_id, bin_id, media_id, custom_name)
            VALUES (?, ?, ?, ?)
        `);
        const info = stmt.run(projectId, binId || null, mediaId, customName);
        return info.lastInsertRowid;
    }

    removeMediaFromBin(pmId) {
        const stmt = this.db.prepare(`DELETE FROM project_media WHERE id = ?`);
        const info = stmt.run(pmId);
        return info.changes > 0;
    }

    moveMedia(pmId, newBinId) {
        const stmt = this.db.prepare(`UPDATE project_media SET bin_id = ? WHERE id = ?`);
        const info = stmt.run(newBinId || null, pmId);
        return info.changes > 0;
    }

    getProjectMediaById(pmId) {
        const stmt = this.db.prepare(`
            SELECT pm.id as pm_id, pm.bin_id, pm.custom_name, m.*
            FROM project_media pm
            JOIN media m ON pm.media_id = m.id
            WHERE pm.id = ?
        `);
        return stmt.get(pmId);
    }

    addMediaBulkToProject(projectId, binId, mediaIds = []) {
        if (!projectId || !Array.isArray(mediaIds) || mediaIds.length === 0) return 0;

        let count = 0;
        const db = this.db;
        this.db.exec('BEGIN TRANSACTION');
        try {
            // Pré-carrega, com 1 consulta, os vínculos já existentes do projeto (media_id -> project_media.id)
            const existingByMedia = new Map();
            for (const r of db.prepare(`SELECT id, media_id FROM project_media WHERE project_id = ?`).all(projectId)) {
                if (!existingByMedia.has(r.media_id)) existingByMedia.set(r.media_id, r.id);
            }
            // O wrapper do banco guarda os statements compilados em cache por SQL, então preparar dentro do
            // loop é barato (sem recompilar); o wrapper também não permite reusar o mesmo objeto após run().
            for (const mediaId of mediaIds) {
                const existingId = existingByMedia.get(mediaId);
                if (existingId === undefined) {
                    const info = db.prepare(`INSERT INTO project_media (project_id, bin_id, media_id) VALUES (?, ?, ?)`).run(projectId, binId || null, mediaId);
                    db.prepare(`UPDATE media SET project_id = ? WHERE id = ?`).run(projectId, mediaId);
                    existingByMedia.set(mediaId, info.lastInsertRowid); // ids repetidos na mesma lista contam uma vez
                    count++;
                } else if (binId) {
                    db.prepare(`UPDATE project_media SET bin_id = ? WHERE id = ?`).run(binId, existingId);
                }
            }
            this.db.exec('COMMIT');
            return count;
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }

    
    // --- SEQUÊNCIAS DE TIMELINE ---

    getSequences(projectId) {
        const stmt = this.db.prepare(`SELECT * FROM project_sequences WHERE project_id = ? ORDER BY id ASC`);
        return stmt.all(projectId);
    }

    getSequenceById(id) {
        const stmt = this.db.prepare(`SELECT * FROM project_sequences WHERE id = ?`);
        return stmt.get(id);
    }

    createSequence(projectId, name = 'Sequência Principal', timebase = 29.97, width = 1920, height = 1080) {
        const stmt = this.db.prepare(`
            INSERT INTO project_sequences (project_id, name, timebase, width, height)
            VALUES (?, ?, ?, ?, ?)
        `);
        const info = stmt.run(projectId, name, timebase, width, height);
        const sequenceId = info.lastInsertRowid;

        // Cria faixas padrão V1 e A1
        this.createTrack(sequenceId, 'video', 1, 'V1');
        this.createTrack(sequenceId, 'audio', 1, 'A1');

        return sequenceId;
    }

    getOrCreateDefaultSequence(projectId) {
        const sequences = this.getSequences(projectId);
        if (sequences.length > 0) return sequences[0];
        const proj = this.getProjectById(projectId);
        const seqId = this.createSequence(projectId, `${proj?.name || 'Projeto'} - Sequência`);
        return this.getSequenceById(seqId);
    }

    updateSequence(id, data) {
        const { fields, values } = pickColumns(data, SEQUENCE_COLUMNS);
        if (fields.length === 0) return false;
        fields.push("updated_at = CURRENT_TIMESTAMP");
        values.push(id);
        const stmt = this.db.prepare(`UPDATE project_sequences SET ${fields.join(', ')} WHERE id = ?`);
        return stmt.run(...values).changes > 0;
    }

    deleteSequence(id) {
        const stmt = this.db.prepare(`DELETE FROM project_sequences WHERE id = ?`);
        return stmt.run(id).changes > 0;
    }

    // --- TRACKS ---

    getTracks(sequenceId) {
        const stmt = this.db.prepare(`SELECT * FROM timeline_tracks WHERE sequence_id = ? ORDER BY track_type DESC, track_index ASC`);
        return stmt.all(sequenceId);
    }

    createTrack(sequenceId, trackType, trackIndex, name = null) {
        const defaultName = name || `${trackType === 'video' ? 'V' : 'A'}${trackIndex}`;
        const stmt = this.db.prepare(`
            INSERT INTO timeline_tracks (sequence_id, track_type, track_index, name)
            VALUES (?, ?, ?, ?)
        `);
        const info = stmt.run(sequenceId, trackType, trackIndex, defaultName);
        return info.lastInsertRowid;
    }

    updateTrack(id, data) {
        const { fields, values } = pickColumns(data, TRACK_COLUMNS);
        if (fields.length === 0) return false;
        values.push(id);
        const stmt = this.db.prepare(`UPDATE timeline_tracks SET ${fields.join(', ')} WHERE id = ?`);
        return stmt.run(...values).changes > 0;
    }

    deleteTrack(id) {
        const stmt = this.db.prepare(`DELETE FROM timeline_tracks WHERE id = ?`);
        return stmt.run(id).changes > 0;
    }

    // --- CLIPS ---

    getClips(trackId) {
        const stmt = this.db.prepare(`
            SELECT tc.*, pm.custom_name, m.filepath, m.filename, m.duration as media_duration, m.fps, m.width, m.height
            FROM timeline_clips tc
            LEFT JOIN project_media pm ON tc.project_media_id = pm.id
            LEFT JOIN media m ON tc.media_id = m.id
            WHERE tc.track_id = ?
            ORDER BY tc.start_time ASC
        `);
        return stmt.all(trackId);
    }

    /** Clips de várias trilhas numa única consulta: Map trackId -> clips (ordenados por start_time). */
    getClipsByTrackIds(trackIds) {
        const map = new Map();
        const ids = (trackIds || []).filter(id => id != null);
        for (const id of ids) map.set(id, []);
        if (ids.length === 0) return map;
        const rows = this.db.prepare(`
            SELECT tc.*, pm.custom_name, m.filepath, m.filename, m.duration as media_duration, m.fps, m.width, m.height
            FROM timeline_clips tc
            LEFT JOIN project_media pm ON tc.project_media_id = pm.id
            LEFT JOIN media m ON tc.media_id = m.id
            WHERE tc.track_id IN (${ids.map(() => '?').join(',')})
            ORDER BY tc.track_id ASC, tc.start_time ASC
        `).all(...ids);
        for (const row of rows) map.get(row.track_id).push(row);
        return map;
    }

    addClip(trackId, data) {
        const { project_media_id, media_id, name, start_time, end_time, in_point, out_point, color } = data;
        const stmt = this.db.prepare(`
            INSERT INTO timeline_clips (track_id, project_media_id, media_id, name, start_time, end_time, in_point, out_point, color)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const info = stmt.run(
            trackId,
            project_media_id || null,
            media_id || null,
            name || null,
            start_time || 0.0,
            end_time || 0.0,
            in_point || 0.0,
            out_point || (end_time - start_time),
            color || null
        );
        return info.lastInsertRowid;
    }

    updateClip(id, data) {
        const { fields, values } = pickColumns(data, CLIP_COLUMNS);
        if (fields.length === 0) return false;
        values.push(id);
        const stmt = this.db.prepare(`UPDATE timeline_clips SET ${fields.join(', ')} WHERE id = ?`);
        return stmt.run(...values).changes > 0;
    }

    deleteClip(id) {
        const stmt = this.db.prepare(`DELETE FROM timeline_clips WHERE id = ?`);
        return stmt.run(id).changes > 0;
    }

    // --- MARCADORES ---

    getMarkers(projectId, sequenceId = null) {
        let sql = `SELECT * FROM project_markers WHERE project_id = ?`;
        const params = [projectId];
        if (sequenceId) {
            sql += ` AND (sequence_id = ? OR sequence_id IS NULL)`;
            params.push(sequenceId);
        }
        sql += ` ORDER BY time ASC`;
        return this.db.prepare(sql).all(...params);
    }

    addMarker(data) {
        const { project_id, sequence_id, clip_id, time, type, color, label, comment, target } = data;
        const stmt = this.db.prepare(`
            INSERT INTO project_markers (project_id, sequence_id, clip_id, time, type, color, label, comment, target)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const info = stmt.run(
            project_id,
            sequence_id || null,
            clip_id || null,
            time || 0.0,
            type || 'highlight',
            color || '#f59e0b',
            label || '',
            comment || '',
            target || 'timeline'
        );
        return info.lastInsertRowid;
    }

    deleteMarker(id) {
        const stmt = this.db.prepare(`DELETE FROM project_markers WHERE id = ?`);
        return stmt.run(id).changes > 0;
    }

    // --- SYNC GROUPS ---

    getSyncGroups(projectId) {
        const groups = this.db.prepare(`SELECT * FROM sync_groups WHERE project_id = ? ORDER BY id ASC`).all(projectId);
        if (groups.length === 0) return [];
        // Uma única consulta (o wrapper libera a statement após cada .all, então não dá para reutilizar em loop)
        const allItems = this.db.prepare(`
            SELECT sgi.*, m.filename, m.filepath, m.duration, m.uuid
            FROM sync_group_items sgi
            JOIN media m ON sgi.media_id = m.id
            WHERE sgi.sync_group_id IN (SELECT id FROM sync_groups WHERE project_id = ?)
            ORDER BY sgi.id ASC
        `).all(projectId);
        const byGroup = new Map();
        for (const it of allItems) {
            if (!byGroup.has(it.sync_group_id)) byGroup.set(it.sync_group_id, []);
            byGroup.get(it.sync_group_id).push(it);
        }
        return groups.map(g => ({
            ...g,
            items: byGroup.get(g.id) || []
        }));
    }

    createSyncGroup(projectId, name, masterMediaId = null, items = []) {
        const info = this.db.prepare(`INSERT INTO sync_groups (project_id, name, master_media_id) VALUES (?, ?, ?)`).run(projectId, name, masterMediaId || null);
        const groupId = info.lastInsertRowid;

        // Nota: uma statement nova por item — ver comentário em addMediaBulkToProject
        // sobre por que a mesma statement não pode ser reutilizada em loop aqui.
        for (const item of items) {
            this.db.prepare(`INSERT INTO sync_group_items (sync_group_id, media_id, offset_seconds, confidence, drift_rate_ppm) VALUES (?, ?, ?, ?, ?)`)
                .run(groupId, item.media_id, item.offset_seconds || 0.0, item.confidence || 0, item.drift_rate_ppm || 0);
        }
        return groupId;
    }

    deleteSyncGroup(id) {
        const stmt = this.db.prepare(`DELETE FROM sync_groups WHERE id = ?`);
        return stmt.run(id).changes > 0;
    }

    updateSyncGroup(id, data) {
        const fields = [];
        const values = [];
        const allowed = ['name', 'master_media_id'];
        for (const key of allowed) {
            if (Object.prototype.hasOwnProperty.call(data, key)) {
                fields.push(`${key} = ?`);
                values.push(data[key]);
            }
        }
        if (fields.length === 0) return false;
        values.push(id);
        const stmt = this.db.prepare(`UPDATE sync_groups SET ${fields.join(', ')} WHERE id = ?`);
        return stmt.run(...values).changes > 0;
    }

    removeSyncGroupItem(itemId) {
        const stmt = this.db.prepare(`DELETE FROM sync_group_items WHERE id = ?`);
        return stmt.run(itemId).changes > 0;
    }

    // --- FASE H: RELINK DE MÍDIA (arquivo não encontrado -> novo caminho local) ---

    /**
     * Atualiza o caminho local de uma mídia (relink) e limpa a flag `missing`.
     * Usado quando o usuário localiza manualmente um arquivo que não foi encontrado
     * no caminho original (ex: projeto aberto em outro computador, HD reorganizado).
     */
    relinkMedia(mediaId, newFilepath) {
        const stmt = this.db.prepare(`
            UPDATE media SET filepath = ?, missing = 0, status = 'READY', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        return stmt.run(newFilepath, mediaId).changes > 0;
    }

    /** Retorna as mídias do projeto atualmente marcadas como `missing = 1`. */
    getMissingProjectMedia(projectId) {
        const stmt = this.db.prepare(`
            SELECT pm.id as pm_id, pm.bin_id, pm.custom_name, m.*
            FROM project_media pm
            JOIN media m ON pm.media_id = m.id
            WHERE pm.project_id = ? AND m.missing = 1
        `);
        return stmt.all(projectId);
    }

    // --- PROJECT FULL MODEL (JSON) ---

    getProjectFullModel(projectId) {
        const project = this.getProjectById(projectId);
        if (!project) throw new Error('Projeto não encontrado');

        const folders = this.getProjectBins(projectId);
        const media = this.getProjectMedia(projectId);
        const syncGroups = this.getSyncGroups(projectId);
        const sequence = this.getOrCreateDefaultSequence(projectId);
        const tracks = this.getTracks(sequence.id);
        const markers = this.getMarkers(projectId, sequence.id);

        // Um único SELECT para os clips de todas as trilhas
        const clipsByTrack = this.getClipsByTrackIds(tracks.map(t => t.id));

        const videoTracks = tracks.filter(t => t.track_type === 'video').map(t => ({
            ...t,
            clips: clipsByTrack.get(t.id) || []
        }));

        const audioTracks = tracks.filter(t => t.track_type === 'audio').map(t => ({
            ...t,
            clips: clipsByTrack.get(t.id) || []
        }));

        // 1.1.0: dispositivos, atividade e entrega (campos opcionais; leitores antigos os ignoram)
        return {
            version: "1.1.0",
            metadata: {
                id: project.id,
                name: project.name,
                description: project.description,
                status: project.status,
                color: project.color,
                client: project.client,
                type: project.type,
                start_date: project.start_date,
                deadline: project.deadline,
                cover_path: project.cover_path,
                created_at: project.created_at,
                updated_at: project.updated_at || null,
                last_activity_at: project.last_activity_at || null
            },
            devices: this.listDevices(projectId),
            activity: this.listActivity(projectId, LIMITS.activityMax),
            delivery: this.getDelivery(projectId),
            settings: {
                timebase: sequence.timebase,
                sample_rate: sequence.sample_rate,
                width: sequence.width,
                height: sequence.height
            },
            folders,
            media,
            syncGroups,
            sequence: {
                ...sequence,
                video_tracks: videoTracks,
                audio_tracks: audioTracks
            },
            markers
        };
    }
}

module.exports = new ProjectService();

