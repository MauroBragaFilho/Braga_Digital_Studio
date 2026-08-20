const { ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');

module.exports = function registerLibraryHandlers(paths, watcherService) {
  const LibraryQueryService = require('../core/library/LibraryQueryService');
  
  ipcMain.handle('library:getStats', () => {
    return LibraryQueryService.getStats();
  });

  ipcMain.handle('library:getThumbDir', () => {
    return path.join(paths.dataDir, 'Thumbnails');
  });

  ipcMain.handle('library:search', (event, options) => {
    return LibraryQueryService.searchMedia(options);
  });
  
  ipcMain.handle('library:getRecent', (event, limit) => {
    return LibraryQueryService.getRecentMedia(limit);
  });

  ipcMain.handle('library:getFilterOptions', () => {
    return LibraryQueryService.getFilterOptions();
  });

  ipcMain.handle('library:addCustomSource', async (event, { name, folderPath }) => {
    const dbManager = require('../core/database/database');
    const MediaImporter = require('../core/media/MediaImporter');
    const EventBus = require('../core/EventBus');
    const db = dbManager.get();

    if (!name || !folderPath) {
      throw new Error('Nome da fonte e caminho da pasta são obrigatórios.');
    }

    let lib = db.prepare('SELECT * FROM libraries WHERE path = ? OR name = ?').get(folderPath, name);
    if (!lib) {
      const info = db.prepare('INSERT INTO libraries (name, type, path) VALUES (?, ?, ?)').run(name, name, folderPath);
      lib = { id: info.lastInsertRowid, name, type: name, path: folderPath };
    }

    const importer = new MediaImporter({ ffprobePath: ffprobeTool.resolve() });
    await importer.importLibrary(lib);

    EventBus.emit('MEDIA_IMPORTED', { source: name });
    return { ok: true, sourceName: lib.name, origin: lib.type };
  });

  ipcMain.handle('library:getCustomSources', () => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    const defaultTypes = ['OBS', 'SHADOWPLAY', 'BDSM_DEVICE', 'OBS Studio', 'NVIDIA ShadowPlay', 'NVIDIA Shadowplay', 'BDSM Devices'];
    const libraries = db.prepare('SELECT id, name, type, path FROM libraries').all();
    return libraries.filter(l => !defaultTypes.includes(l.name) && !defaultTypes.includes(l.type));
  });

  ipcMain.handle('library:updateCustomSourcePath', async (event, { id, name, newFolderPath }) => {
    const dbManager = require('../core/database/database');
    const MediaImporter = require('../core/media/MediaImporter');
    const EventBus = require('../core/EventBus');
    const db = dbManager.get();

    if (!newFolderPath) throw new Error('Caminho da pasta é obrigatório.');

    db.prepare('UPDATE libraries SET path = ? WHERE id = ? OR name = ?').run(newFolderPath, id, name);

    let lib = db.prepare('SELECT * FROM libraries WHERE id = ? OR name = ?').get(id, name);
    if (lib) {
      const importer = new MediaImporter({ ffprobePath: ffprobeTool.resolve() });
      await importer.importLibrary(lib);
    }

    EventBus.emit('MEDIA_IMPORTED', { action: 'update_source', name });
    return { ok: true };
  });

  ipcMain.handle('library:removeCustomSource', (event, { id, name }) => {
    const dbManager = require('../core/database/database');
    const EventBus = require('../core/EventBus');
    const db = dbManager.get();
    
    db.prepare('DELETE FROM media WHERE origin = ? OR library_id = ?').run(name, id);
    db.prepare('DELETE FROM libraries WHERE id = ? OR name = ?').run(id, name);

    EventBus.emit('MEDIA_IMPORTED', { action: 'delete_source', name });
    return { ok: true };
  });

  ipcMain.handle('library:renameMedia', (event, id, newName) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    db.prepare('UPDATE media SET filename = ? WHERE id = ?').run(newName, id);
    return true;
  });

  ipcMain.handle('library:toggleFavorite', (event, id, isFav) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    db.prepare('UPDATE media SET favorite = ? WHERE id = ?').run(isFav ? 1 : 0, id);
    return true;
  });

  ipcMain.handle('library:getMediaTags', (event, id) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    return db.prepare(`
      SELECT t.* FROM tags t
      JOIN media_tags mt ON mt.tag_id = t.id
      WHERE mt.media_id = ?
    `).all(id);
  });

  ipcMain.handle('library:addMediaTag', (event, mediaId, tagName) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    const normalizedName = tagName.toLowerCase();
    
    let tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(normalizedName);
    if (!tag) {
      const info = db.prepare('INSERT INTO tags (name) VALUES (?)').run(normalizedName);
      tag = { id: info.lastInsertRowid };
    }
    
    try {
      db.prepare('INSERT INTO media_tags (media_id, tag_id) VALUES (?, ?)').run(mediaId, tag.id);
    } catch (e) {
      // Ignora erro se a tag já estiver associada
    }
    return true;
  });

  ipcMain.handle('library:removeMediaTag', (event, mediaId, tagId) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    db.prepare('DELETE FROM media_tags WHERE media_id = ? AND tag_id = ?').run(mediaId, tagId);
    return true;
  });

  ipcMain.handle('library:deleteMediaBulk', (event, ids) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    if (!ids || ids.length === 0) return true;
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT filepath FROM media WHERE id IN (${placeholders})`).all(...ids);
    rows.forEach(r => {
       try { if (fs.existsSync(r.filepath)) fs.unlinkSync(r.filepath); } catch(e) {}
    });
    db.prepare(`DELETE FROM media WHERE id IN (${placeholders})`).run(...ids);
    return true;
  });

  ipcMain.handle('library:toggleFavoriteBulk', (event, ids, isFav) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    if (!ids || ids.length === 0) return true;
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE media SET favorite = ? WHERE id IN (${placeholders})`).run(isFav ? 1 : 0, ...ids);
    return true;
  });

  ipcMain.handle('library:setProjectBulk', (event, ids, projectId) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    if (!ids || ids.length === 0) return true;
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE media SET project_id = ? WHERE id IN (${placeholders})`).run(projectId, ...ids);
    return true;
  });

  ipcMain.handle('library:addMediaTagBulk', (event, ids, tagName) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    if (!ids || ids.length === 0 || !tagName) return true;
    
    let tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
    if (!tag) {
        const res = db.prepare('INSERT INTO tags (name) VALUES (?)').run(tagName);
        tag = { id: res.lastInsertRowid };
    }
    db.exec('BEGIN TRANSACTION');
    try {
        for (const id of ids) {
            db.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?, ?)').run(id, tag.id);
        }
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
    }
    return true;
  });

  ipcMain.handle('library:renameMediaBulk', (event, ids, baseName) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    if (!ids || ids.length === 0 || !baseName) return true;
    
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, filepath, filename FROM media WHERE id IN (${placeholders}) ORDER BY COALESCE(recorded_at, imported_at) ASC`).all(...ids);
    
    let counter = 1;
    db.exec('BEGIN TRANSACTION');
    try {
       const update = db.prepare(`UPDATE media SET filename = ?, filepath = ? WHERE id = ?`);
       for (const row of rows) {
           const ext = path.extname(row.filename);
           let newFilename = ids.length === 1 ? `${baseName}${ext}` : `${baseName} - ${counter}${ext}`;
           const dir = path.dirname(row.filepath);
           const newFilepath = path.join(dir, newFilename);
           try {
              if (fs.existsSync(row.filepath)) {
                 fs.renameSync(row.filepath, newFilepath);
              }
              update.run(newFilename, newFilepath, row.id);
           } catch(e) { console.error('Rename err:', e) }
           counter++;
       }
       db.exec('COMMIT');
    } catch(e) {
        db.exec('ROLLBACK');
    }
    return true;
  });

  ipcMain.handle('library:moveMediaBulk', async (event, ids, newDir) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    if (!ids || ids.length === 0 || !newDir) return true;
    
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, filepath, filename FROM media WHERE id IN (${placeholders})`).all(...ids);
    
    db.exec('BEGIN TRANSACTION');
    try {
       const update = db.prepare(`UPDATE media SET filepath = ? WHERE id = ?`);
       for (const row of rows) {
           const newFilepath = path.join(newDir, row.filename);
           try {
              if (fs.existsSync(row.filepath)) {
                 fs.copyFileSync(row.filepath, newFilepath);
                 fs.unlinkSync(row.filepath);
              }
              update.run(newFilepath, row.id);
           } catch(e) { console.error('Move err:', e) }
       }
       db.exec('COMMIT');
    } catch(e) {
        db.exec('ROLLBACK');
    }
    return true;
  });

  ipcMain.handle('library:clearDatabase', () => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    db.exec('DELETE FROM media_tags; DELETE FROM media; VACUUM;');
    return true;
  });

  ipcMain.handle('library:rescanAll', () => {
    if (watcherService) {
      watcherService.stopAll();
      setTimeout(() => watcherService.startAll(), 500);
    }
    return true;
  });

  ipcMain.handle('library:getAll', () => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    return db.prepare('SELECT id, name, type, path FROM libraries ORDER BY name ASC').all();
  });

  ipcMain.handle('library:getFolderFiles', async (event, folderPath) => {
    if (!folderPath || !fs.existsSync(folderPath)) return [];
    const mediaExts = ['.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.mts', '.m2ts',
                       '.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.wma', '.alac', '.aiff',
                       '.ac3', '.dts', '.3gp', '.mpg', '.mpeg', '.m4v', '.ts', '.vob'];
    try {
      const files = fs.readdirSync(folderPath);
      return files
        .filter(f => mediaExts.includes(path.extname(f).toLowerCase()))
        .map(f => path.join(folderPath, f));
    } catch (e) {
      console.error('Erro ao ler pasta:', e);
      return [];
    }
  });
};

