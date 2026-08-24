const dbManager = require('../database/database');
const logger = require('../../services/logService');
const fs = require('fs');
const path = require('path');

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
                   (SELECT SUM(m.filesize) FROM project_media pm JOIN media m ON pm.media_id = m.id WHERE pm.project_id = p.id) as total_size
            FROM projects p
            ORDER BY p.created_at DESC
        `);
        return stmt.all();
    }

    getProjectById(id) {
        const stmt = this.db.prepare(`
            SELECT p.*, 
                   (SELECT COUNT(*) FROM project_media pm WHERE pm.project_id = p.id) as media_count,
                   (SELECT SUM(m.filesize) FROM project_media pm JOIN media m ON pm.media_id = m.id WHERE pm.project_id = p.id) as total_size
            FROM projects p
            WHERE p.id = ?
        `);
        return stmt.get(id);
    }

    createProject(data) {
        const { name, description, status, color, client, type, start_date, deadline, cover_path } = data;
        const stmt = this.db.prepare(`
            INSERT INTO projects (name, description, status, color, client, type, start_date, deadline, cover_path)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const info = stmt.run(
            name, 
            description || '', 
            status || 'Ativo', 
            color || '#3b82f6', 
            client || '', 
            type || '', 
            start_date || null, 
            deadline || null, 
            cover_path || ''
        );
        return info.lastInsertRowid;
    }

    updateProject(id, data) {
        const fields = [];
        const values = [];
        for (const [key, value] of Object.entries(data)) {
            if (key !== 'id') {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        if (fields.length === 0) return false;
        
        values.push(id);
        const stmt = this.db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`);
        const info = stmt.run(...values);
        return info.changes > 0;
    }

    deleteProject(id) {
        const stmt = this.db.prepare(`DELETE FROM projects WHERE id = ?`);
        const info = stmt.run(id);
        return info.changes > 0;
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
        this.db.exec('BEGIN TRANSACTION');
        try {
            for (const mediaId of mediaIds) {
                // Nota: cada statement é preparada dentro do loop porque o wrapper
                // do sql.js libera (`free()`) a statement automaticamente a cada
                // chamada de .run()/.get()/.all() — reusar a mesma statement em
                // múltiplas iterações causa erro "Statement closed".
                const existing = this.db.prepare(`SELECT id FROM project_media WHERE project_id = ? AND media_id = ?`).get(projectId, mediaId);
                if (!existing) {
                    this.db.prepare(`INSERT INTO project_media (project_id, bin_id, media_id) VALUES (?, ?, ?)`).run(projectId, binId || null, mediaId);
                    this.db.prepare(`UPDATE media SET project_id = ? WHERE id = ?`).run(projectId, mediaId);
                    count++;
                } else if (binId) {
                    this.db.prepare(`UPDATE project_media SET bin_id = ? WHERE id = ?`).run(binId, existing.id);
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
        const fields = [];
        const values = [];
        for (const [key, value] of Object.entries(data)) {
            if (key !== 'id') {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
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
        const fields = [];
        const values = [];
        for (const [key, value] of Object.entries(data)) {
            if (key !== 'id') {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
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
        const fields = [];
        const values = [];
        for (const [key, value] of Object.entries(data)) {
            if (key !== 'id') {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
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
        const stmtItems = this.db.prepare(`
            SELECT sgi.*, m.filename, m.filepath, m.duration, m.uuid
            FROM sync_group_items sgi
            JOIN media m ON sgi.media_id = m.id
            WHERE sgi.sync_group_id = ?
        `);
        return groups.map(g => ({
            ...g,
            items: stmtItems.all(g.id)
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

        const videoTracks = tracks.filter(t => t.track_type === 'video').map(t => ({
            ...t,
            clips: this.getClips(t.id)
        }));

        const audioTracks = tracks.filter(t => t.track_type === 'audio').map(t => ({
            ...t,
            clips: this.getClips(t.id)
        }));

        return {
            version: "1.0.0",
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
                created_at: project.created_at
            },
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

