const path = require('path');
const fs = require('fs');
const { ipcMain, dialog, BrowserWindow } = require('electron');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');
const {
  assertNonEmpty, assertPositiveInt, assertAbsolutePath, assertUserFile
} = require('./validate');

const UUID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** uuid de mídia vira nome de arquivo de cache (waveforms/<uuid>.json): nunca aceitar separadores. */
function assertUuid(uuid) {
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) throw new Error('Identificador de mídia inválido.');
  return uuid;
}

function assertStreamIndex(v) {
  const n = v == null ? 0 : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 64) throw new Error('Índice de stream inválido.');
  return n;
}

/** Caminho de saída: absoluto, com a extensão esperada e pasta pai existente. */
function assertOutputFile(p, exts, label) {
  const resolved = assertAbsolutePath(p, label);
  if (!exts.includes(path.extname(resolved).toLowerCase())) {
    throw new Error(`${label} deve terminar em ${exts.join(' ou ')}.`);
  }
  let st;
  try { st = fs.statSync(path.dirname(resolved)); } catch (_) { throw new Error(`Pasta de destino não encontrada para ${label}.`); }
  if (!st.isDirectory()) throw new Error(`Pasta de destino inválida para ${label}.`);
  return resolved;
}

/** Pasta de busca (relink): absoluta e existente; a raiz de um drive é permitida (varredura de mídia). */
function assertSearchFolder(p) {
  const resolved = assertAbsolutePath(p, 'Pasta');
  let st;
  try { st = fs.statSync(resolved); } catch (_) { throw new Error('Pasta não encontrada.'); }
  if (!st.isDirectory()) throw new Error('O caminho informado não é uma pasta.');
  return resolved;
}

module.exports = function registerProjectHandlers(projectService, premiereExporter, bdsproPackageService, paths = {}, waveformService = null, audioSyncService = null, sequenceBuilder = null) {
  const thumbnailsDir = paths.dataDir ? path.join(paths.dataDir, 'Thumbnails') : '';
  const coversDir = paths.dataDir ? path.join(paths.dataDir, 'covers') : '';
  let ffprobePath = '';
  try {
    ffprobePath = ffprobeTool.resolve();
  } catch (_) {
    ffprobePath = paths.dataDir ? path.join(paths.dataDir, 'ffprobe') : '';
  }

  const assertBdsproFile = (p) => {
    const file = assertUserFile(p, 'Pacote .bdspro');
    if (path.extname(file).toLowerCase() !== '.bdspro') throw new Error('O arquivo deve ter a extensão .bdspro.');
    return file;
  };

  ipcMain.handle('projects:list', () => projectService.getAllProjects());
  ipcMain.handle('projects:get', (_, id) => projectService.getProjectById(id));
  ipcMain.handle('projects:create', (_, data) => {
    // [FASE 1.2] Validação de entrada
    if (data && data.name) assertNonEmpty(data.name, 'Nome do projeto');
    return projectService.createProject(data);
  });
  ipcMain.handle('projects:update', (_, id, data) => {
    const projectId = assertPositiveInt(id, 'ID do projeto');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Dados do projeto inválidos.');
    if (data.name !== undefined) assertNonEmpty(data.name, 'Nome do projeto');
    return projectService.updateProject(projectId, data);
  });
  ipcMain.handle('projects:delete', (_, id) => projectService.deleteProject(id));

  ipcMain.handle('projects:getBins', (_, projectId) => projectService.getProjectBins(projectId));
  ipcMain.handle('projects:createBin', (_, projectId, parentId, name) => projectService.createBin(projectId, parentId, name));
  ipcMain.handle('projects:updateBin', (_, id, name, parentId) => projectService.updateBin(id, name, parentId));
  ipcMain.handle('projects:deleteBin', (_, id) => projectService.deleteBin(id));

  ipcMain.handle('projects:getMedia', (_, projectId) => projectService.getProjectMedia(projectId));
  ipcMain.handle('projects:getMediaById', (_, pmId) => projectService.getProjectMediaById(pmId));
  ipcMain.handle('projects:addMedia', (_, projectId, binId, mediaId, customName) => projectService.addMediaToBin(projectId, binId, mediaId, customName));
  ipcMain.handle('projects:addMediaBulk', (_, projectId, binId, mediaIds) => projectService.addMediaBulkToProject(projectId, binId, mediaIds));
  ipcMain.handle('projects:removeMedia', (_, pmId) => projectService.removeMediaFromBin(pmId));
  ipcMain.handle('projects:moveMedia', (_, pmId, newBinId) => projectService.moveMedia(pmId, newBinId));

  // --- Importação Direta de Arquivos (Workspace → Bin) ---
  ipcMain.handle('projects:importFilesToBin', async (event, { projectId, binId }) => {
    const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();

    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Importar Arquivos para o Projeto',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Mídia Suportada', extensions: ['mp4','mkv','avi','mov','webm','m4a','mp3','flac','wav','ogg','jpg','jpeg','png','gif','bmp','tiff','svg','heic','arw','cr2','cr3','nef','dng','raf','rw2','orf'] },
        { name: 'Todos os arquivos', extensions: ['*'] }
      ]
    });

    if (canceled || !filePaths || filePaths.length === 0) return { imported: 0, skipped: 0 };

    return await importFilePathsIntoBin(projectId, binId, filePaths, event);
  });

  ipcMain.handle('projects:importDroppedFilesToBin', async (event, { projectId, binId, filePaths }) => {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return { imported: 0, skipped: 0 };
    return await importFilePathsIntoBin(projectId, binId, filePaths, event);
  });

  let manualImportLibraryId = null;
  function getOrCreateManualLibrary() {
    const dbManager = require('../core/database/database');
    const db = dbManager.get();
    if (manualImportLibraryId) {
      const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(manualImportLibraryId);
      if (lib) return lib;
    }
    let lib = db.prepare(`SELECT * FROM libraries WHERE name = ? AND type = ?`).get('Importação Manual', 'MANUAL');
    if (!lib) {
      const info = db.prepare(`INSERT INTO libraries (name, type, path) VALUES (?, ?, ?)`).run('Importação Manual', 'MANUAL', null);
      lib = { id: info.lastInsertRowid, name: 'Importação Manual', type: 'MANUAL', path: null };
    }
    manualImportLibraryId = lib.id;
    return lib;
  }

  async function importFilePathsIntoBin(projectId, binId, filePaths, event) {
    const MediaImporter = require('../core/media/MediaImporter');
    const importer = new MediaImporter({ ffprobePath });
    const library = getOrCreateManualLibrary();

    let imported = 0;
    let skipped = 0;
    let failed = 0;

    for (const rawPath of filePaths) {
      let filePath = String(rawPath);
      try {
        filePath = assertAbsolutePath(rawPath, 'Arquivo');
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { skipped++; continue; }

        if (event?.sender) {
          event.sender.send('projects:importProgress', { fileName: path.basename(filePath), status: 'processing' });
        }

        const result = await importer.importFile(library, filePath);
        if (!result || result.id == null) { skipped++; continue; }

        projectService.addMediaToBin(projectId, binId || null, result.id, null);
        imported++;
      } catch (e) {
        failed++;
        if (event?.sender) {
          event.sender.send('projects:importProgress', { fileName: path.basename(filePath), status: 'error', error: e.message });
        }
      }
    }

    return { imported, skipped, failed, total: filePaths.length };
  }

  // --- Pré-edição, Sequências, Tracks, Clips, Marcadores e Sync Groups ---
  ipcMain.handle('projects:getFullModel', (_, projectId) => projectService.getProjectFullModel(projectId));
  
  ipcMain.handle('projects:getSequences', (_, projectId) => projectService.getSequences(projectId));
  ipcMain.handle('projects:getOrCreateDefaultSequence', (_, projectId) => projectService.getOrCreateDefaultSequence(projectId));
  ipcMain.handle('projects:createSequence', (_, projectId, name, timebase, width, height) => projectService.createSequence(projectId, name, timebase, width, height));
  ipcMain.handle('projects:updateSequence', (_, id, data) => projectService.updateSequence(id, data));
  ipcMain.handle('projects:deleteSequence', (_, id) => projectService.deleteSequence(id));

  ipcMain.handle('projects:getTracks', (_, sequenceId) => projectService.getTracks(sequenceId));
  ipcMain.handle('projects:createTrack', (_, sequenceId, trackType, trackIndex, name) => projectService.createTrack(sequenceId, trackType, trackIndex, name));
  ipcMain.handle('projects:updateTrack', (_, id, data) => projectService.updateTrack(id, data));
  ipcMain.handle('projects:deleteTrack', (_, id) => projectService.deleteTrack(id));

  ipcMain.handle('projects:getClips', (_, trackId) => projectService.getClips(trackId));
  ipcMain.handle('projects:addClip', (_, trackId, data) => projectService.addClip(trackId, data));
  ipcMain.handle('projects:updateClip', (_, id, data) => projectService.updateClip(id, data));
  ipcMain.handle('projects:deleteClip', (_, id) => projectService.deleteClip(id));

  ipcMain.handle('projects:getMarkers', (_, projectId, sequenceId) => projectService.getMarkers(projectId, sequenceId));
  ipcMain.handle('projects:addMarker', (_, data) => projectService.addMarker(data));
  ipcMain.handle('projects:deleteMarker', (_, id) => projectService.deleteMarker(id));

  ipcMain.handle('projects:getSyncGroups', (_, projectId) => projectService.getSyncGroups(projectId));
  ipcMain.handle('projects:createSyncGroup', (_, projectId, name, masterMediaId, items) => projectService.createSyncGroup(projectId, name, masterMediaId, items));
  ipcMain.handle('projects:updateSyncGroup', (_, id, data) => projectService.updateSyncGroup(id, data));
  ipcMain.handle('projects:deleteSyncGroup', (_, id) => projectService.deleteSyncGroup(id));
  ipcMain.handle('projects:removeSyncGroupItem', (_, itemId) => projectService.removeSyncGroupItem(itemId));

  // --- FASE H: Relink de mídia ausente ---
  ipcMain.handle('projects:getMissingMedia', (_, projectId) => projectService.getMissingProjectMedia(projectId));
  ipcMain.handle('projects:relinkMedia', (_, mediaId, newFilepath) => {
    return projectService.relinkMedia(assertPositiveInt(mediaId, 'ID da mídia'), assertUserFile(newFilepath, 'Novo arquivo'));
  });

  // --- Pacote .bdspro (Exportação, Importação, Inspeção e Relink) ---
  ipcMain.handle('projects:exportBdspro', (_, projectId, outputPath) => {
    if (!bdsproPackageService) throw new Error('BdsproPackageService não inicializado');
    const id = assertPositiveInt(projectId, 'ID do projeto');
    const out = assertOutputFile(outputPath, ['.bdspro'], 'Arquivo de saída');
    return bdsproPackageService.exportBdspro(id, out, thumbnailsDir);
  });

  ipcMain.handle('projects:inspectBdspro', (_, bdsproPath) => {
    if (!bdsproPackageService) throw new Error('BdsproPackageService não inicializado');
    return bdsproPackageService.inspectBdspro(assertBdsproFile(bdsproPath));
  });

  ipcMain.handle('projects:scanRelinkFolder', (_, folderPath) => {
    if (!bdsproPackageService) throw new Error('BdsproPackageService não inicializado');
    return bdsproPackageService.scanFolderForMedia(assertSearchFolder(folderPath));
  });

  ipcMain.handle('projects:matchMissingMedia', (_, missingList, scannedFiles) => {
    if (!bdsproPackageService) throw new Error('BdsproPackageService não inicializado');
    if (!Array.isArray(missingList) || !Array.isArray(scannedFiles)) throw new Error('Listas inválidas.');
    return bdsproPackageService.findMatchesForMissing(missingList, scannedFiles);
  });

  ipcMain.handle('projects:importBdspro', (_, bdsproPath, relinkMap) => {
    if (!bdsproPackageService) throw new Error('BdsproPackageService não inicializado');
    const pkg = assertBdsproFile(bdsproPath);
    if (relinkMap != null && typeof relinkMap !== 'object') throw new Error('Mapa de relink inválido.');
    return bdsproPackageService.importBdspro(pkg, relinkMap, thumbnailsDir, coversDir);
  });

  ipcMain.handle('projects:exportPremiere', (_, projectId, outputPath) => {
    return premiereExporter.exportToPremiereXml(assertPositiveInt(projectId, 'ID do projeto'), assertOutputFile(outputPath, ['.xml'], 'Arquivo de saída'));
  });
  ipcMain.handle('projects:exportSequencePremiere', (_, projectId, outputPath) => {
    return premiereExporter.exportSequenceXml(assertPositiveInt(projectId, 'ID do projeto'), assertOutputFile(outputPath, ['.xml'], 'Arquivo de saída'));
  });
  ipcMain.handle('projects:getSequenceModel', (_, projectId) => {
    if (!sequenceBuilder) throw new Error('SequenceBuilder não inicializado');
    return sequenceBuilder.buildSequenceModel(projectId);
  });

  // --- Waveforms (Fase 5) ---
  ipcMain.handle('projects:getWaveform', (_, params) => {
    if (!waveformService) throw new Error('WaveformService não inicializado');
    const { uuid, filePath, duration, peaksPerSecond, streamIndex, force } = params || {};
    assertUuid(uuid);
    const safeFile = assertUserFile(filePath, 'Arquivo de mídia');
    const pps = peaksPerSecond == null ? peaksPerSecond : Number(peaksPerSecond);
    if (pps != null && (!Number.isFinite(pps) || pps < 1 || pps > 1000)) throw new Error('peaksPerSecond inválido.');
    const dur = duration == null ? duration : Number(duration);
    if (dur != null && (!Number.isFinite(dur) || dur < 0)) throw new Error('Duração inválida.');
    return waveformService.getOrGenerate({ uuid, filePath: safeFile, duration: dur, peaksPerSecond: pps, streamIndex: assertStreamIndex(streamIndex), force });
  });

  ipcMain.handle('projects:probeAudioStreams', async (_, filePath) => {
    const ffprobe = new (require('../core/ffmpeg/FFProbe'))({ ffprobePath });
    try {
      const data = await ffprobe.analyze(assertUserFile(filePath, 'Arquivo de mídia'));
      return data.audio_streams || [];
    } catch (e) {
      return [];
    }
  });

  ipcMain.handle('projects:hasWaveformCache', (_, uuid, streamIndex = 0) => {
    if (!waveformService) return false;
    return waveformService.hasCache(assertUuid(uuid), assertStreamIndex(streamIndex));
  });

  ipcMain.handle('projects:deleteWaveformCache', (_, uuid, streamIndex = 0) => {
    if (!waveformService) return false;
    waveformService.deleteCache(assertUuid(uuid), assertStreamIndex(streamIndex));
    return true;
  });

  // --- Extração de track isolada para mudo independente no Monitor de Origem ---
  ipcMain.handle('projects:getTrackAudioPath', async (_, params) => {
    if (!waveformService) throw new Error('WaveformService não inicializado');
    const { uuid, filePath, streamIndex } = params || {};
    assertUuid(uuid);
    const safeFile = assertUserFile(filePath, 'Arquivo de mídia');
    const outPath = await waveformService.getOrExtractTrack(uuid, safeFile, assertStreamIndex(streamIndex));
    return `file:///${outPath.replace(/\\/g, '/')}`;
  });

  // --- Sincronização Automática por Áudio (Fase 6) ---
  ipcMain.handle('projects:runAudioSync', async (event, { projectId, groupName, masterMediaId, mediaList, maxOffsetSeconds }) => {
    console.log('[IPC] projects:runAudioSync chamado', { projectId, groupName, masterMediaId, mediaCount: mediaList?.length });
    if (!audioSyncService) throw new Error('Sincronização de áudio indisponível — verifique se o motor de mídia foi carregado corretamente.');
    if (!Array.isArray(mediaList) || mediaList.length < 2) {
      throw new Error('São necessárias ao menos 2 mídias para sincronizar.');
    }

    let results;
    try {
      results = await audioSyncService.syncGroup(
        mediaList,
        masterMediaId,
        maxOffsetSeconds || 30,
        (mediaId, status) => {
          event.sender.send('projects:audioSyncProgress', { mediaId, status });
        }
      );
    } catch (syncErr) {
      console.error('[IPC] Falha no AudioSyncService.syncGroup:', syncErr);
      throw new Error(`Falha ao processar o áudio: ${syncErr.message}`);
    }
    console.log('[IPC] syncGroup concluído, resultados:', results);

    let groupId;
    try {
      groupId = projectService.createSyncGroup(
        projectId,
        groupName || `Sync Group ${new Date().toLocaleString('pt-BR')}`,
        masterMediaId,
        results.map(r => ({ media_id: r.media_id, offset_seconds: r.offset_seconds, confidence: r.confidence, drift_rate_ppm: r.drift_rate_ppm }))
      );
    } catch (dbErr) {
      console.error('[IPC] Falha ao gravar Sync Group no banco:', dbErr);
      throw new Error(`Falha ao salvar o Sync Group no banco de dados: ${dbErr.message}`);
    }
    console.log('[IPC] Sync Group criado com id:', groupId);

    return { groupId, results };
  });
};


