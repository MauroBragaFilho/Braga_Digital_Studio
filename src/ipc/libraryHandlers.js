const { BrowserWindow, dialog, shell } = require('electron');
const { handle } = require('./channelRegistry');
const path = require('path');
const fs = require('fs');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');
const {
  assertSafeFileName, assertNonEmpty, assertPositiveInt, assertIdArray, assertUserDirectory,
  assertAbsolutePath, sqlPlaceholders, chunk
} = require('./validate');
const { countMediaLinks, countLibraryLinks, countAllLinks, describeLinks } = require('../core/library/mediaLinks');

const MAX_IDS = 50000;   // limite por operação em lote
const SQL_BATCH = 500;   // SQLite limita variáveis por consulta: processa em lotes

/** Devolve `dir/filename` sem sobrescrever: acrescenta " (n)" antes da extensão se já existir. */
function uniqueDestination(dir, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n++;
    if (n > 9999) throw new Error('Não foi possível gerar um nome livre no destino.');
  }
  return candidate;
}

/**
 * Move um arquivo sem sobrescrever o destino: rename; se falhar (ex.: outro drive),
 * copia (COPYFILE_EXCL) → confere o tamanho → apaga a origem.
 */
async function moveFileNoOverwrite(src, dest) {
  if (fs.existsSync(dest)) throw Object.assign(new Error('Destino já existe'), { code: 'EEXIST' });
  try {
    await fs.promises.rename(src, dest);
    return;
  } catch (_) {
    // fallback: copia/verifica/remove
  }
  await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
  try {
    const [a, b] = await Promise.all([fs.promises.stat(src), fs.promises.stat(dest)]);
    if (a.size !== b.size) throw new Error('Tamanho do arquivo copiado difere do original.');
  } catch (verifyErr) {
    try { await fs.promises.unlink(dest); } catch (_) { /* melhor esforço */ }
    throw verifyErr;
  }
  await fs.promises.unlink(src);
}

module.exports = function registerLibraryHandlers(paths, watcherService) {
  const LibraryQueryService = require('../core/library/LibraryQueryService');

  handle('library:getStats', () => {
    return LibraryQueryService.getStats();
  });

  handle('library:getThumbDir', () => {
    return path.join(paths.dataDir, 'Thumbnails');
  });

  handle('library:search', (event, options) => {
    return LibraryQueryService.searchMedia(options);
  });

  handle('library:getRecent', (event, limit) => {
    return LibraryQueryService.getRecentMedia(limit);
  });

  handle('library:getFilterOptions', () => {
    return LibraryQueryService.getFilterOptions();
  });

  handle('library:addCustomSource', async (event, { name, folderPath } = {}) => {
    const dbManager = require('../core/database/database');
    const MediaImporter = require('../core/media/MediaImporter');
    const EventBus = require('../core/EventBus');
    const db = dbManager.get();

    // Validação de entrada no esquema do canal (channels.js): nome de 1 a 120 caracteres e pasta
    // absoluta, existente e que não seja a raiz de um drive (já resolvida).

    let lib = db.prepare('SELECT * FROM libraries WHERE path = ? OR name = ?').get(folderPath, name);
    if (!lib) {
      const info = db.prepare('INSERT INTO libraries (name, type, path) VALUES (?, ?, ?)').run(name, name, folderPath);
      lib = { id: info.lastInsertRowid, name, type: name, path: folderPath };
    }

    const importer = new MediaImporter({ ffprobePath: ffprobeTool.resolve() });
    await importer.importLibrary(lib);
    // Fonte nova passa a ser monitorada sem precisar reiniciar o app (RK-087)
    if (watcherService && lib.path) watcherService.startWatcher(lib.id, lib.path);

    EventBus.emit('MEDIA_IMPORTED', { source: name });
    return { ok: true, sourceName: lib.name, origin: lib.type };
  });

  handle('library:getCustomSources', () => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    const defaultTypes = ['OBS', 'SHADOWPLAY', 'BDSM_DEVICE', 'OBS Studio', 'NVIDIA ShadowPlay', 'NVIDIA Shadowplay', 'BDSM Devices'];
    const libraries = db.prepare('SELECT id, name, type, path FROM libraries').all();
    // 'MANUAL' (Importação Manual dos projetos) é interna: não aparece nem pode ser alterada/removida (RK-034)
    return libraries.filter(l => l.type !== 'MANUAL' && !defaultTypes.includes(l.name) && !defaultTypes.includes(l.type));
  });

  // Quantos vínculos de projeto seriam apagados ao excluir estas mídias (diálogo de confirmação, RK-015)
  handle('library:getMediaProjectLinks', (event, ids) => {
    const dbManager = require('../core/database/database');
    const list = assertIdArray(ids, { max: MAX_IDS });
    const r = countMediaLinks(dbManager.get(), list);
    return { links: r.links, projects: r.projects, text: describeLinks(r) };
  });

  handle('library:updateCustomSourcePath', async (event, { id, name, newFolderPath } = {}) => {
    const dbManager = require('../core/database/database');
    const MediaImporter = require('../core/media/MediaImporter');
    const EventBus = require('../core/EventBus');
    const db = dbManager.get();

    // Usa SOMENTE o id (antes "OR name" podia atualizar várias bibliotecas de mesmo nome).
    const libId = assertPositiveInt(id, 'ID da fonte');
    const folder = newFolderPath; // pasta validada e resolvida pelo esquema do canal
    const target = db.prepare('SELECT type FROM libraries WHERE id = ?').get(libId);
    if (target && target.type === 'MANUAL') throw new Error('A biblioteca "Importação Manual" é interna e não pode ser alterada.');

    db.prepare('UPDATE libraries SET path = ? WHERE id = ?').run(folder, libId);
    // O watcher antigo seguia na pasta anterior: troca para a nova (RK-087)
    if (watcherService) watcherService.stopWatcher(libId);

    const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(libId);
    if (watcherService && lib && lib.path && lib.enabled !== 0 && lib.auto_scan !== 0) watcherService.startWatcher(libId, lib.path);
    if (lib) {
      const importer = new MediaImporter({ ffprobePath: ffprobeTool.resolve() });
      await importer.importLibrary(lib);
    }

    EventBus.emit('MEDIA_IMPORTED', { action: 'update_source', name: lib ? lib.name : name });
    return { ok: true };
  });

  handle('library:removeCustomSource', async (event, { id, name } = {}) => {
    const dbManager = require('../core/database/database');
    const EventBus = require('../core/EventBus');
    const db = dbManager.get();

    const libId = assertPositiveInt(id, 'ID da fonte');
    // O nome usado para limpar `origin` vem do banco, não do renderer.
    const lib = db.prepare('SELECT id, name, type FROM libraries WHERE id = ?').get(libId);
    if (lib && lib.type === 'MANUAL') throw new Error('A biblioteca "Importação Manual" é interna e não pode ser removida.');
    const libName = lib ? lib.name : (typeof name === 'string' ? name : '');

    // Remover a fonte apaga as mídias dela e, em cascata, os vínculos de projeto: avisa antes (RK-015)
    const impact = countLibraryLinks(db, libId, libName);
    if (impact.links > 0) {
      const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
      const options = {
        type: 'warning',
        title: 'Remover fonte',
        message: `Remover "${libName}" também apaga ${describeLinks(impact)}.`,
        detail: 'As mídias saem dos projetos, dos grupos de sincronização e da timeline. Os arquivos do disco não são removidos.',
        buttons: ['Cancelar', 'Remover mesmo assim'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      };
      const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      if (response !== 1) throw new Error('Operação cancelada pelo usuário.');
    }

    if (watcherService) watcherService.stopWatcher(libId);
    db.prepare('DELETE FROM media WHERE library_id = ? OR origin = ?').run(libId, libName || '\u0000');
    db.prepare('DELETE FROM libraries WHERE id = ?').run(libId);

    EventBus.emit('MEDIA_IMPORTED', { action: 'delete_source', name: libName });
    return { ok: true };
  });

  handle('library:renameMedia', async (event, id, newName) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    const mediaId = assertPositiveInt(id, 'ID da mídia');
    const clean = typeof newName === 'string' ? newName.trim() : newName;
    assertSafeFileName(clean);

    // Semântica (RK-082): renomeia também o arquivo no disco e preserva a extensão (o tipo da mídia é
    // derivado dela por trigger), sem sobrescrever outro arquivo.
    const row = db.prepare('SELECT filename, filepath FROM media WHERE id = ?').get(mediaId);
    if (!row) throw new Error('Mídia não encontrada.');
    const ext = path.extname(row.filename || '');
    const newFilename = ext && !clean.toLowerCase().endsWith(ext.toLowerCase()) ? `${clean}${ext}` : clean;
    assertSafeFileName(newFilename);

    let newFilepath = row.filepath;
    if (row.filepath && fs.existsSync(row.filepath)) {
      newFilepath = path.join(path.dirname(row.filepath), newFilename);
      const sameFile = newFilepath.toLowerCase() === row.filepath.toLowerCase();
      if (!sameFile && fs.existsSync(newFilepath)) throw new Error('Já existe um arquivo com esse nome na pasta.');
      if (newFilepath !== row.filepath) await fs.promises.rename(row.filepath, newFilepath);
    }
    db.prepare('UPDATE media SET filename = ?, filepath = ? WHERE id = ?').run(newFilename, newFilepath, mediaId);
    return true;
  });

  handle('library:toggleFavorite', (event, id, isFav) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    db.prepare('UPDATE media SET favorite = ? WHERE id = ?').run(isFav ? 1 : 0, assertPositiveInt(id, 'ID da mídia'));
    return true;
  });

  handle('library:getMediaTags', (event, id) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    return db.prepare(`
      SELECT t.* FROM tags t
      JOIN media_tags mt ON mt.tag_id = t.id
      WHERE mt.media_id = ?
    `).all(id);
  });

  handle('library:addMediaTag', (event, mediaId, tagName) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    const normalizedName = tagName.toLowerCase(); // texto não vazio garantido pelo esquema do canal

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

  handle('library:removeMediaTag', (event, mediaId, tagId) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    db.prepare('DELETE FROM media_tags WHERE media_id = ? AND tag_id = ?').run(mediaId, tagId);
    return true;
  });

  // Exclui mídias em lote: arquivos vão para a Lixeira (recuperáveis). Se a Lixeira falhar para
  // um item, ele NÃO é apagado em definitivo — permanece (arquivo + registro) e entra em `failed`.
  handle('library:deleteMediaBulk', async (event, ids) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    const list = assertIdArray(ids, { max: MAX_IDS });
    if (list.length === 0) return { ok: true, deleted: 0, failed: [] };

    let deleted = 0;
    const failed = [];

    for (const batch of chunk(list, SQL_BATCH)) {
      const rows = db.prepare(`SELECT id, filepath FROM media WHERE id IN (${sqlPlaceholders(batch.length)})`).all(...batch);
      const removableIds = [];

      for (const r of rows) {
        // Arquivo inexistente (já removido manualmente): só limpa o registro.
        if (!r.filepath || !fs.existsSync(r.filepath)) { removableIds.push(r.id); continue; }
        try {
          await shell.trashItem(r.filepath);
          removableIds.push(r.id);
        } catch (err) {
          failed.push({ id: r.id, filepath: r.filepath, error: err.message });
        }
      }

      if (removableIds.length) {
        db.prepare(`DELETE FROM media_tags WHERE media_id IN (${sqlPlaceholders(removableIds.length)})`).run(...removableIds);
        db.prepare(`DELETE FROM media WHERE id IN (${sqlPlaceholders(removableIds.length)})`).run(...removableIds);
        deleted += removableIds.length;
      }
    }

    return { ok: failed.length === 0, deleted, failed };
  });

  handle('library:toggleFavoriteBulk', (event, ids, isFav) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    const list = assertIdArray(ids, { max: MAX_IDS });
    for (const batch of chunk(list, SQL_BATCH)) {
      db.prepare(`UPDATE media SET favorite = ? WHERE id IN (${sqlPlaceholders(batch.length)})`).run(isFav ? 1 : 0, ...batch);
    }
    return true;
  });

  handle('library:setProjectBulk', (event, ids, projectId) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    const list = assertIdArray(ids, { max: MAX_IDS });
    const pid = projectId == null ? null : assertPositiveInt(projectId, 'ID do projeto');
    for (const batch of chunk(list, SQL_BATCH)) {
      db.prepare(`UPDATE media SET project_id = ? WHERE id IN (${sqlPlaceholders(batch.length)})`).run(pid, ...batch);
    }
    return true;
  });

  handle('library:addMediaTagBulk', (event, ids, tagName) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    const list = assertIdArray(ids, { max: MAX_IDS });
    if (list.length === 0 || !tagName) return true;
    assertNonEmpty(tagName, 'Nome da tag');

    let tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
    if (!tag) {
        const res = db.prepare('INSERT INTO tags (name) VALUES (?)').run(tagName);
        tag = { id: res.lastInsertRowid };
    }
    db.exec('BEGIN TRANSACTION');
    try {
        for (const id of list) {
          db.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?, ?)').run(id, tag.id);
        }
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
    return true;
  });

  handle('library:renameMediaBulk', async (event, ids, baseName) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    if (!Array.isArray(ids) || ids.length === 0 || !baseName) return true;

    // [FASE 1.2] Validação de entrada (a numeração depende do conjunto todo: 1 consulta, abaixo do limite de variáveis SQLite)
    const list = assertIdArray(ids, { max: 900 });
    assertNonEmpty(baseName, 'Nome base');
    baseName = baseName.trim();
    assertSafeFileName(baseName);

    const rows = db.prepare(`SELECT id, filepath, filename FROM media WHERE id IN (${sqlPlaceholders(list.length)}) ORDER BY COALESCE(recorded_at, imported_at) ASC`).all(...list);

    // O wrapper sql.js finaliza o statement após run(): prepara a cada uso.
    const updateRow = (filename, filepath, id) => db.prepare(`UPDATE media SET filename = ?, filepath = ? WHERE id = ?`).run(filename, filepath, id);
    const failed = [];
    let renamed = 0;
    let counter = 1;
    for (const row of rows) {
      const ext = path.extname(row.filename || '');
      const newFilename = list.length === 1 ? `${baseName}${ext}` : `${baseName} - ${counter}${ext}`;
      counter++;
      try {
        assertSafeFileName(newFilename);
        const dir = path.dirname(row.filepath);
        let newFilepath = path.join(dir, newFilename);
        let finalName = newFilename;
        if (fs.existsSync(row.filepath)) {
          // Não sobrescreve outro arquivo existente com o mesmo nome (a menos que seja o próprio).
          if (newFilepath.toLowerCase() !== row.filepath.toLowerCase() && fs.existsSync(newFilepath)) {
            newFilepath = uniqueDestination(dir, newFilename);
            finalName = path.basename(newFilepath);
          }
          if (newFilepath !== row.filepath) await fs.promises.rename(row.filepath, newFilepath);
        }
        updateRow(finalName, newFilepath, row.id);
        renamed++;
      } catch (e) {
        failed.push({ id: row.id, error: e.message });
        console.error('Rename err:', e);
      }
    }
    return { ok: failed.length === 0, renamed, failed };
  });

  handle('library:moveMediaBulk', async (event, ids, newDir) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    if (!Array.isArray(ids) || ids.length === 0 || !newDir) return true;

    // [FASE 1.2] Destino = pasta escolhida pelo usuário (qualquer drive; o renderer usa dialog:selectFolder),
    // mas absoluta, existente e que não seja a raiz de um drive.
    const destDir = assertUserDirectory(newDir, 'Diretório de destino');
    const list = assertIdArray(ids, { max: MAX_IDS });

    // Atenção: o wrapper sql.js finaliza o statement após run(); por isso prepara a cada uso.
    const updatePath = (filepath, id) => db.prepare(`UPDATE media SET filepath = ? WHERE id = ?`).run(filepath, id);
    const failed = [];
    let moved = 0;

    for (const batch of chunk(list, SQL_BATCH)) {
      const rows = db.prepare(`SELECT id, filepath, filename FROM media WHERE id IN (${sqlPlaceholders(batch.length)})`).all(...batch);
      for (const row of rows) {
        try {
          if (!row.filepath || !fs.existsSync(row.filepath)) throw new Error('Arquivo de origem não encontrado.');
          const name = assertSafeFileName(path.basename(row.filepath));
          if (path.resolve(path.dirname(row.filepath)).toLowerCase() === destDir.toLowerCase()) { moved++; continue; }
          const dest = uniqueDestination(destDir, name);
          await moveFileNoOverwrite(row.filepath, dest);
          // Só atualiza o banco depois que o arquivo realmente chegou ao destino.
          updatePath(dest, row.id);
          moved++;
        } catch (e) {
          failed.push({ id: row.id, error: e.message });
          console.error('Move err:', e);
        }
      }
    }
    return { ok: failed.length === 0, moved, failed };
  });

  handle('library:clearDatabase', async (event) => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();

    // Confirmação nativa no processo principal: o renderer sozinho não pode apagar a biblioteca.
    const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
    const linksInfo = describeLinks(countAllLinks(db));
    const options = {
      type: 'warning',
      title: 'Limpar banco de dados',
      message: 'Limpar todo o banco de dados da biblioteca?',
      detail: 'Registros de mídia, tags e favoritos serão apagados' +
        (linksInfo ? `, junto com ${linksInfo}, grupos de sincronização e referências da timeline` : '') +
        '. Um backup do banco é criado antes. Os arquivos do disco não são removidos.',
      buttons: ['Cancelar', 'Limpar banco'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    };
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (response !== 1) throw new Error('Operação cancelada pelo usuário.');

    // Backup antes de apagar (RK-015); sem backup não limpa
    let backup = null;
    try { backup = dbManager.createBackup('preclear'); } catch (e) { throw new Error(`Não foi possível criar o backup antes de limpar: ${e.message}`); }
    if (!backup) throw new Error('Não foi possível criar o backup antes de limpar o banco.');

    const details = {};
    for (const table of ['media_tags', 'media']) {
      try {
        db.exec(`DELETE FROM ${table}`);
        details[table] = 'ok';
      } catch (e) {
        details[table] = `erro: ${e.message}`;
      }
    }
    try { db.exec('VACUUM'); } catch (e) { details.vacuum = `erro: ${e.message}`; }
    if (details.media !== 'ok') throw new Error(`Falha ao limpar o banco: ${details.media}`);
    return { ok: Object.values(details).every((v) => v === 'ok'), details };
  });

  handle('library:rescanAll', () => {
    if (watcherService) {
      watcherService.stopAll();
      setTimeout(() => {
        watcherService.startAll();
        // Rescan também indexa arquivos novos que o watcher (ignoreInitial) nunca veria (RK-019)
        watcherService.indexNewFiles().catch(() => {});
      }, 500);
    }
    return true;
  });

  handle('library:getAll', () => {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    return db.prepare('SELECT id, name, type, path FROM libraries ORDER BY name ASC').all();
  });

  handle('library:getFolderFiles', async (event, folderPath) => {
    if (!folderPath) return [];
    try {
      folderPath = assertAbsolutePath(folderPath, 'Pasta');
      // [PERF] Usa fs.promises.readdir (assíncrono) em vez de readdirSync,
      // para não bloquear o event loop do processo principal durante a leitura do diretório.
      const exists = await fs.promises.access(folderPath).then(() => true).catch(() => false);
      if (!exists) return [];
      const mediaExts = new Set(['.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.mts', '.m2ts',
                         '.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.wma', '.alac', '.aiff',
                         '.ac3', '.dts', '.3gp', '.mpg', '.mpeg', '.m4v', '.ts', '.vob']);
      const files = await fs.promises.readdir(folderPath);
      return files
        .filter(f => mediaExts.has(path.extname(f).toLowerCase()))
        .map(f => path.join(folderPath, f));
    } catch (e) {
      console.error('Erro ao ler pasta:', e);
      return [];
    }
  });

  // [FIX] Regenera thumbnails ausentes — usado no startup quando thumbnails foram deletadas indevidamente.
  // Lógica compartilhada com o bootstrap e com o clearCache (systemHandlers).
  handle('library:regenerateMissingThumbnails', async (event, { batchSize = 8 } = {}) => {
    const { regenerateMissingThumbnails: regenerate } = require('../core/library/ThumbnailRegenService');
    return regenerate({
      paths,
      dbManager: require('../core/database/database'),
      window: BrowserWindow.getAllWindows()[0] || null,
      batchSize,
      retryFailed: true, // pedido manual: tenta de novo também as que falharam recentemente
      logPrefix: '[RegenThumbs]',
    });
  });
};
