const path = require('path');
const fs = require('fs');
const { dialog, BrowserWindow } = require('electron');
const { handle } = require('./channelRegistry');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');
const {
  assertNonEmpty, assertPositiveInt, assertAbsolutePath
} = require('./validate');

const { pathToFileURL } = require('url');
const { buildOutputPath } = require('../core/projects/outputPath');

// O uuid de mídia vira nome de arquivo de cache (waveforms/<uuid>.json): o esquema do canal
// (channels.js, UUID) nunca aceita separadores. Arquivos de mídia (t.file) chegam existentes e resolvidos.

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

module.exports = function registerProjectHandlers(projectService, premiereExporter, bdsproPackageService, paths = {}, waveformService = null, audioSyncService = null, sequenceBuilder = null) {
  const thumbnailsDir = paths.dataDir ? path.join(paths.dataDir, 'Thumbnails') : '';
  const coversDir = paths.dataDir ? path.join(paths.dataDir, 'covers') : '';
  let ffprobePath = '';
  try {
    ffprobePath = ffprobeTool.resolve();
  } catch (_) {
    ffprobePath = paths.dataDir ? path.join(paths.dataDir, 'ffprobe') : '';
  }

  // O esquema (t.file) já garante um arquivo existente e resolvido; aqui só a extensão.
  const assertBdsproFile = (file) => {
    if (path.extname(file).toLowerCase() !== '.bdspro') throw new Error('O arquivo deve ter a extensão .bdspro.');
    return file;
  };

  handle('projects:list', () => projectService.getAllProjects());
  handle('projects:get', (_, id) => projectService.getProjectById(id));
  handle('projects:create', (_, data) => {
    // [FASE 1.2] Validação de entrada
    if (data && data.name) assertNonEmpty(data.name, 'Nome do projeto');
    return projectService.createProject(data);
  });
  handle('projects:update', (_, id, data) => {
    const projectId = assertPositiveInt(id, 'ID do projeto');
    if (data.name !== undefined) assertNonEmpty(data.name, 'Nome do projeto');
    return projectService.updateProject(projectId, data);
  });
  handle('projects:delete', (_, id) => projectService.deleteProject(id));

  handle('projects:getBins', (_, projectId) => projectService.getProjectBins(projectId));
  handle('projects:createBin', (_, projectId, parentId, name) => projectService.createBin(projectId, parentId, name));
  handle('projects:updateBin', (_, id, name, parentId) => projectService.updateBin(id, name, parentId));
  handle('projects:deleteBin', (_, id) => projectService.deleteBin(id));

  handle('projects:getMedia', (_, projectId) => projectService.getProjectMedia(projectId));
  handle('projects:getMediaById', (_, pmId) => projectService.getProjectMediaById(pmId));
  handle('projects:addMedia', (_, projectId, binId, mediaId, customName) => projectService.addMediaToBin(projectId, binId, mediaId, customName));
  handle('projects:addMediaBulk', (_, projectId, binId, mediaIds) => projectService.addMediaBulkToProject(projectId, binId, mediaIds));
  handle('projects:removeMedia', (_, pmId) => projectService.removeMediaFromBin(pmId));
  handle('projects:moveMedia', (_, pmId, newBinId) => projectService.moveMedia(pmId, newBinId));

  // --- Importação Direta de Arquivos (Workspace → Bin) ---
  handle('projects:importFilesToBin', async (event, { projectId, binId }) => {
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

  handle('projects:importDroppedFilesToBin', async (event, { projectId, binId, filePaths }) => {
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
  handle('projects:getFullModel', (_, projectId) => projectService.getProjectFullModel(projectId));
  
  handle('projects:getSequences', (_, projectId) => projectService.getSequences(projectId));
  handle('projects:getOrCreateDefaultSequence', (_, projectId) => projectService.getOrCreateDefaultSequence(projectId));
  handle('projects:createSequence', (_, projectId, name, timebase, width, height) => projectService.createSequence(projectId, name, timebase, width, height));
  handle('projects:updateSequence', (_, id, data) => projectService.updateSequence(id, data));
  handle('projects:deleteSequence', (_, id) => projectService.deleteSequence(id));

  handle('projects:getTracks', (_, sequenceId) => projectService.getTracks(sequenceId));
  handle('projects:createTrack', (_, sequenceId, trackType, trackIndex, name) => projectService.createTrack(sequenceId, trackType, trackIndex, name));
  handle('projects:updateTrack', (_, id, data) => projectService.updateTrack(id, data));
  handle('projects:deleteTrack', (_, id) => projectService.deleteTrack(id));

  handle('projects:getClips', (_, trackId) => projectService.getClips(trackId));
  handle('projects:addClip', (_, trackId, data) => projectService.addClip(trackId, data));
  handle('projects:updateClip', (_, id, data) => projectService.updateClip(id, data));
  handle('projects:deleteClip', (_, id) => projectService.deleteClip(id));

  handle('projects:getMarkers', (_, projectId, sequenceId) => projectService.getMarkers(projectId, sequenceId));
  handle('projects:addMarker', (_, data) => projectService.addMarker(data));
  handle('projects:deleteMarker', (_, id) => projectService.deleteMarker(id));

  handle('projects:getSyncGroups', (_, projectId) => projectService.getSyncGroups(projectId));
  handle('projects:createSyncGroup', (_, projectId, name, masterMediaId, items) => projectService.createSyncGroup(projectId, name, masterMediaId, items));
  handle('projects:updateSyncGroup', (_, id, data) => projectService.updateSyncGroup(id, data));
  handle('projects:deleteSyncGroup', (_, id) => projectService.deleteSyncGroup(id));
  handle('projects:removeSyncGroupItem', (_, itemId) => projectService.removeSyncGroupItem(itemId));

  // --- FASE H: Relink de mídia ausente ---
  handle('projects:getMissingMedia', (_, projectId) => projectService.getMissingProjectMedia(projectId));
  handle('projects:relinkMedia', (_, mediaId, newFilepath) => {
    return projectService.relinkMedia(assertPositiveInt(mediaId, 'ID da mídia'), newFilepath);
  });

  // --- Pacote .bdspro (Exportação, Importação, Inspeção e Relink) ---
  // Destino da exportação: caminho completo (legado) ou { folder, name, suffix } montado aqui com nome
  // sanitizado e path.join; pede confirmação nativa antes de sobrescrever um arquivo existente (RK-039).
  async function resolveExportOutput(event, spec, ext, label) {
    const out = assertOutputFile(buildOutputPath(spec, ext), [ext], label);
    if (fs.existsSync(out)) {
      const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
      const options = {
        type: 'warning',
        title: 'Arquivo já existe',
        message: `Já existe um arquivo chamado "${path.basename(out)}" nesta pasta. Substituir?`,
        detail: out,
        buttons: ['Cancelar', 'Substituir'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      };
      const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      if (response !== 1) throw new Error('Exportação cancelada: o arquivo já existe e não foi substituído.');
    }
    return out;
  }

  handle('projects:exportBdspro', async (event, projectId, outputPath) => {
    if (!bdsproPackageService) throw new Error('BdsproPackageService não inicializado');
    const id = assertPositiveInt(projectId, 'ID do projeto');
    const out = await resolveExportOutput(event, outputPath, '.bdspro', 'Arquivo de saída');
    return bdsproPackageService.exportBdspro(id, out, thumbnailsDir);
  });

  handle('projects:inspectBdspro', (_, bdsproPath) => {
    if (!bdsproPackageService) throw new Error('BdsproPackageService não inicializado');
    return bdsproPackageService.inspectBdspro(assertBdsproFile(bdsproPath));
  });

  handle('projects:scanRelinkFolder', (_, folderPath) => {
    if (!bdsproPackageService) throw new Error('BdsproPackageService não inicializado');
    return bdsproPackageService.scanFolderForMedia(folderPath);
  });

  handle('projects:matchMissingMedia', (_, missingList, scannedFiles) => {
    if (!bdsproPackageService) throw new Error('BdsproPackageService não inicializado');
    return bdsproPackageService.findMatchesForMissing(missingList, scannedFiles);
  });

  handle('projects:importBdspro', (_, bdsproPath, relinkMap) => {
    if (!bdsproPackageService) throw new Error('BdsproPackageService não inicializado');
    const pkg = assertBdsproFile(bdsproPath);
    return bdsproPackageService.importBdspro(pkg, relinkMap, thumbnailsDir, coversDir);
  });

  handle('projects:exportPremiere', async (event, projectId, outputPath) => {
    const id = assertPositiveInt(projectId, 'ID do projeto');
    return premiereExporter.exportToPremiereXml(id, await resolveExportOutput(event, outputPath, '.xml', 'Arquivo de saída'));
  });
  handle('projects:exportSequencePremiere', async (event, projectId, outputPath) => {
    const id = assertPositiveInt(projectId, 'ID do projeto');
    return premiereExporter.exportSequenceXml(id, await resolveExportOutput(event, outputPath, '.xml', 'Arquivo de saída'));
  });
  handle('projects:getSequenceModel', (_, projectId) => {
    if (!sequenceBuilder) throw new Error('SequenceBuilder não inicializado');
    return sequenceBuilder.buildSequenceModel(projectId);
  });

  // --- Waveforms (Fase 5) ---
  handle('projects:getWaveform', (_, params) => {
    if (!waveformService) throw new Error('WaveformService não inicializado');
    const { uuid, filePath: safeFile, duration, peaksPerSecond, streamIndex, force } = params;
    const pps = peaksPerSecond == null ? peaksPerSecond : Number(peaksPerSecond);
    if (pps != null && (!Number.isFinite(pps) || pps < 1 || pps > 1000)) throw new Error('peaksPerSecond inválido.');
    const dur = duration == null ? duration : Number(duration);
    if (dur != null && (!Number.isFinite(dur) || dur < 0)) throw new Error('Duração inválida.');
    return waveformService.getOrGenerate({ uuid, filePath: safeFile, duration: dur, peaksPerSecond: pps, streamIndex: assertStreamIndex(streamIndex), force });
  });

  handle('projects:probeAudioStreams', async (_, filePath) => {
    const ffprobe = new (require('../core/ffmpeg/FFProbe'))({ ffprobePath });
    try {
      const data = await ffprobe.analyze(filePath);
      return data.audio_streams || [];
    } catch (e) {
      return [];
    }
  });

  handle('projects:hasWaveformCache', (_, uuid, streamIndex = 0) => {
    if (!waveformService) return false;
    return waveformService.hasCache(uuid, assertStreamIndex(streamIndex));
  });

  handle('projects:deleteWaveformCache', (_, uuid, streamIndex = 0) => {
    if (!waveformService) return false;
    waveformService.deleteCache(uuid, assertStreamIndex(streamIndex));
    return true;
  });

  // --- Extração de track isolada para mudo independente no Monitor de Origem ---
  handle('projects:getTrackAudioPath', async (_, params) => {
    if (!waveformService) throw new Error('WaveformService não inicializado');
    const { uuid, filePath: safeFile, streamIndex } = params;
    const outPath = await waveformService.getOrExtractTrack(uuid, safeFile, assertStreamIndex(streamIndex));
    return pathToFileURL(outPath).href;
  });

  // --- Sincronização Automática por Áudio (Fase 6) ---
  handle('projects:runAudioSync', async (event, { projectId, groupName, masterMediaId, mediaList, maxOffsetSeconds }) => {
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


