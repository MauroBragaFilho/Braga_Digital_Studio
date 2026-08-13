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
}

module.exports = new ProjectService();
