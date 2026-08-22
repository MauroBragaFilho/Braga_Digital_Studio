const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Conjunto para gerenciar ouvintes e evitar vazamentos de memória
const listeners = new Set();

/**
 * Função auxiliar para registrar ouvintes de forma padronizada
 */
const registerListener = (channel, callback) => {
  const listener = (_, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  listeners.add([channel, listener]);
  // Retorna uma função de desinscrição para limpeza individual, se necessário
  return () => ipcRenderer.removeListener(channel, listener);
};

const api = {
  // --- Configurações e Sistema ---
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getVideosPath: () => ipcRenderer.invoke('system:getVideosPath'),
  getDownloadsPath: () => ipcRenderer.invoke('system:getDownloadsPath'),

  // --- Sistema de Telemetria e Relatório de Erros ---
  reportError: (error, context) => ipcRenderer.invoke('telemetry:reportError', error, context),
  getDeveloperEmail: () => ipcRenderer.invoke('telemetry:getDeveloperEmail'),
  getCrashReports: () => ipcRenderer.invoke('telemetry:getCrashReports'),
  openCrashReportsFolder: () => ipcRenderer.invoke('telemetry:openReportsFolder'),
  getMailtoErrorLink: (error, context) => ipcRenderer.invoke('telemetry:getMailtoLink', error, context),

  // Controles de Janela
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  fullscreenWindow: () => ipcRenderer.invoke('window:fullscreen'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  // Montagem (Fila/Lote)
  probeMontageFile: (filePath) => ipcRenderer.invoke('montage:probe', filePath),
  enqueueMontage: (config) => ipcRenderer.invoke('montage:enqueue', config),
  cancelMontageJob: (id) => ipcRenderer.invoke('montage:cancelJob', id),
  removeMontageJob: (id) => ipcRenderer.invoke('montage:removeJob', id),
  clearMontageQueue: () => ipcRenderer.invoke('montage:clearQueue'),
  getMontageQueue: () => ipcRenderer.invoke('montage:getQueue'),
  
  // Eventos de Montagem
  onMontageProgress: (cb) => registerListener('montage:progress', cb),
  onMontageFinished: (cb) => registerListener('montage:finished', cb),
  onMontageQueueUpdated: (cb) => registerListener('montage:queue-updated', cb),
  onMontageLog: (cb) => registerListener('montage:log', cb),

  // Remover Silêncio
  probeSilenceFile: (filePath) => ipcRenderer.invoke('silence:probe', filePath),
  analyzeSilence: (config) => ipcRenderer.invoke('silence:analyze', config),
  processSilence: (config) => ipcRenderer.invoke('silence:process', config),
  cancelSilence: () => ipcRenderer.invoke('silence:cancel'),
  
  onSilenceProgress: (cb) => registerListener('silence:progress', cb),
  onSilenceFinished: (cb) => registerListener('silence:finished', cb),
  onSilenceLog: (cb) => registerListener('silence:log', cb),
  
  // Devices (MTP)
  getAllDevices: (force = false) => ipcRenderer.invoke('devices:get-all', force),
  listUsbFolder: (basePath, pathArray) => ipcRenderer.invoke('usb:list-folder', basePath, pathArray),
  importUsbItems: (basePath, pathArray, itemNames, destFolder) => ipcRenderer.invoke('usb:import-items', basePath, pathArray, itemNames, destFolder),
  listMtpFolder: (deviceName, pathArray) => ipcRenderer.invoke('mtp:list-folder', deviceName, pathArray),
  importMtpItems: (deviceName, pathArray, itemNames, destFolder) => ipcRenderer.invoke('mtp:import-items', deviceName, pathArray, itemNames, destFolder),
  onMtpProgress: (cb) => registerListener('mtp:import-progress', cb),

  // Metadados
  probeMetadataFile: (filePath) => ipcRenderer.invoke('metadata:probe', filePath),
  extractMetadataThumb: (filePath) => ipcRenderer.invoke('metadata:extractThumb', filePath),
  saveMetadata: (config) => ipcRenderer.invoke('metadata:save', config),
  cancelMetadata: () => ipcRenderer.invoke('metadata:cancel'),
  
  onMetadataProgress: (cb) => registerListener('metadata:progress', cb),
  onMetadataLog: (cb) => registerListener('metadata:log', cb),

  // --- Utils ---
  selectFolder: (fallbackPath) => ipcRenderer.invoke('dialog:selectFolder', fallbackPath),
  selectFiles: () => ipcRenderer.invoke('dialog:selectFiles'),
  selectFile: (options) => ipcRenderer.invoke('dialog:selectFiles', options),

  // --- Conversor ---
  converterAddFiles: (files) => ipcRenderer.invoke('converter:addFiles', files),
  converterStart: (config) => ipcRenderer.invoke('converter:start', config),
  converterCancel: () => ipcRenderer.invoke('converter:cancel'),
  converterClearQueue: () => ipcRenderer.invoke('converter:clearQueue'),
  converterRemoveFile: (index) => ipcRenderer.invoke('converter:removeFile', index),

  // --- Downloads e Mídia ---
  getMetadata: (url) => ipcRenderer.invoke('media:metadata', url),
  inspectPlaylist: (url) => ipcRenderer.invoke('media:inspectPlaylist', url),
  expandPlaylist: (url) => ipcRenderer.invoke('media:expandPlaylist', url),
  exportYoutubeCookies: () => ipcRenderer.invoke('youtube:exportCookies'),
  openExternal: (url) => require('electron').shell.openExternal(url),
  startUpload: (request) => ipcRenderer.invoke('upload:start', request),

  // Automação Nível 2 (UploadService)
  uploadAddToQueue: (account, fileData) => ipcRenderer.invoke('upload:addToQueue', account, fileData),
  uploadStartJob: (jobId) => ipcRenderer.invoke('upload:startJob', jobId),
  uploadGetQueue: () => ipcRenderer.invoke('upload:getQueue'),
  uploadClearQueue: () => ipcRenderer.invoke('upload:clearQueue'),
  onUploadQueueUpdated: (callback) => ipcRenderer.on('upload:queue-updated', (event, q) => callback(q)),
  
  // Contas YouTube
  getYoutubeAccounts: () => ipcRenderer.invoke('youtube:get-accounts'),

  // --- Download Queue Manager API ---
  downloads: {
    add: (request) => ipcRenderer.invoke('downloads:add', request),
    start: () => ipcRenderer.invoke('downloads:start'),
    pause: () => ipcRenderer.invoke('downloads:pause'),
    cancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
    retry: (id) => ipcRenderer.invoke('downloads:retry', id),
    remove: (id) => ipcRenderer.invoke('downloads:remove', id),
    reorder: (id, direction) => ipcRenderer.invoke('downloads:reorder', id, direction),
    clearCompleted: () => ipcRenderer.invoke('downloads:clearCompleted'),
    clearAll: () => ipcRenderer.invoke('downloads:clearAll'),
    toggleFormat: (id, format) => ipcRenderer.invoke('downloads:toggleFormat', id, format),
    updateQuality: (id, quality) => ipcRenderer.invoke('downloads:updateQuality', id, quality),
    getQueue: () => ipcRenderer.invoke('downloads:getQueue'),
    onAdded: (cb) => registerListener('downloads:added', cb),
    onUpdated: (cb) => registerListener('downloads:updated', cb),
    onProgress: (cb) => registerListener('downloads:progress', cb),
    onCompleted: (cb) => registerListener('downloads:completed', cb),
    onFailed: (cb) => registerListener('downloads:failed', cb),
    onRemoved: (cb) => registerListener('downloads:removed', cb),
    onQueueCompleted: (cb) => registerListener('downloads:queue-completed', cb),
  },

  downloadGetQueue: () => ipcRenderer.invoke('downloads:getQueue'),
  downloadClearQueue: () => ipcRenderer.invoke('downloads:clearCompleted'),
  downloadRemoveJob: (id) => ipcRenderer.invoke('downloads:remove', id),

  // --- Histórico ---
  listHistory: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  listConversions: () => ipcRenderer.invoke('conversions:list'),
  clearConversions: () => ipcRenderer.invoke('conversions:clear'),

  // --- Atualizações Unificadas (BDS Update Manager) ---
  checkUpdates: () => ipcRenderer.invoke('updates:checkSystem'),
  installUpdates: () => ipcRenderer.invoke('updates:updateAll'),
  updateTool: (tool) => ipcRenderer.invoke('updates:updateTool', tool),
  updateAllDependencies: () => ipcRenderer.invoke('updates:updateAll'),
  onUpdateProgress: (cb) => registerListener('updates:progress', cb),
  onUpdateCompleted: (cb) => registerListener('updates:completed', cb),

  // --- Recuperação de Vídeo ---
  recovery: {
    diagnose: (corruptPath, referencePath) => ipcRenderer.invoke('recovery:diagnose', { corruptPath, referencePath }),
    start: (options) => ipcRenderer.invoke('recovery:start', options),
    cancel: () => ipcRenderer.invoke('recovery:cancel'),
    onProgress: (cb) => registerListener('recovery:progress', cb),
    onStage: (cb) => registerListener('recovery:stage', cb),
    onFinished: (cb) => registerListener('recovery:finished', cb),
    onError: (cb) => registerListener('recovery:error', cb),
  },

  // --- Logs e Diagnóstico ---
  exportDiagnosticLogs: () => ipcRenderer.invoke('logs:export'),

  // --- YouTube ---
  startYoutubeAuth: () => ipcRenderer.invoke('youtube:startAuth'),

  // --- Ouvintes (Events) ---
  onDownloadQueue: (cb) => registerListener('download:queue', cb),
  onProgress: (cb) => registerListener('download:progress', cb),
  onFinished: (cb) => registerListener('download:finished', cb),
  // Atualizações e Dependências Iniciais (legado)
  onUpdatesChecked: (cb) => registerListener('updates:checked', cb),
  onDependenciesDownloading: (cb) => registerListener('dependencies:downloading', cb),
  onDependenciesDone: (cb) => registerListener('dependencies:done', cb),
  

  // Conversor
  onConverterQueue: (cb) => registerListener('converter:queue', cb),
  onConverterFileStarted: (cb) => registerListener('converter:fileStarted', cb),
  onConverterProgress: (cb) => registerListener('converter:progress', cb),
  onConverterFileFinished: (cb) => registerListener('converter:fileFinished', cb),
  onConverterFinished: (cb) => registerListener('converter:finished', cb),

  // YouTube
  onYoutubeCode: (cb) => registerListener('youtube:code', cb),
  onYoutubeAuthStatus: (cb) => registerListener('youtube:authStatus', cb),
  
  // Media Library - Fase 1.3
  getLibraryStats: () => ipcRenderer.invoke('library:getStats'),
  searchLibrary: (options) => ipcRenderer.invoke('library:search', options),
  getRecentMedia: (limit) => ipcRenderer.invoke('library:getRecent', limit),
  getThumbDir: () => ipcRenderer.invoke('library:getThumbDir'),
  getLibraryFilterOptions: () => ipcRenderer.invoke('library:getFilterOptions'),
  renameMedia: (id, newName) => ipcRenderer.invoke('library:renameMedia', id, newName),
  toggleFavorite: (id, isFav) => ipcRenderer.invoke('library:toggleFavorite', id, isFav),
  getMediaTags: (id) => ipcRenderer.invoke('library:getMediaTags', id),
  addMediaTag: (id, tagName) => ipcRenderer.invoke('library:addMediaTag', id, tagName),
  removeMediaTag: (mediaId, tagId) => ipcRenderer.invoke('library:removeMediaTag', mediaId, tagId),
  deleteMediaBulk: (ids) => ipcRenderer.invoke('library:deleteMediaBulk', ids),
  moveMediaBulk: (ids, newDir) => ipcRenderer.invoke('library:moveMediaBulk', ids, newDir),
  setProjectBulk: (ids, projectId) => ipcRenderer.invoke('library:setProjectBulk', ids, projectId),
  renameMediaBulk: (ids, baseName) => ipcRenderer.invoke('library:renameMediaBulk', ids, baseName),
  addMediaTagBulk: (ids, tagName) => ipcRenderer.invoke('library:addMediaTagBulk', ids, tagName),
  toggleFavoriteBulk: (ids, isFav) => ipcRenderer.invoke('library:toggleFavoriteBulk', ids, isFav),
  addCustomSource: (config) => ipcRenderer.invoke('library:addCustomSource', config),
  getCustomSources: () => ipcRenderer.invoke('library:getCustomSources'),
  updateCustomSourcePath: (config) => ipcRenderer.invoke('library:updateCustomSourcePath', config),
  removeCustomSource: (config) => ipcRenderer.invoke('library:removeCustomSource', config),
  clearLibraryDatabase: () => ipcRenderer.invoke('library:clearDatabase'),
  rescanAllLibrary: () => ipcRenderer.invoke('library:rescanAll'),
  getAllLibraries: () => ipcRenderer.invoke('library:getAll'),
  getLibraryFolderFiles: (folderPath) => ipcRenderer.invoke('library:getFolderFiles', folderPath),
  getStorageInfo: () => ipcRenderer.invoke('system:getStorageInfo'),
  openLocalPath: (itemPath) => ipcRenderer.invoke('system:openPath', itemPath),
  exportCookies: (domain, outputPath) => ipcRenderer.invoke('system:exportCookies', domain, outputPath),
  youtubeLogin: () => ipcRenderer.invoke('youtube:login'),
  youtubeUpload: (config) => ipcRenderer.invoke('youtube:upload', config),

  // Upload Scanner & Automation APIs
  uploadScanDirectory: (customDir) => ipcRenderer.invoke('upload:scanDirectory', customDir),
  uploadSelectFolder: () => ipcRenderer.invoke('upload:selectFolder'),
  uploadSelectFiles: () => ipcRenderer.invoke('upload:selectFiles'),
  uploadAddToQueue: (account, fileData) => ipcRenderer.invoke('upload:addToQueue', account, fileData),
  uploadStartJob: (jobId) => ipcRenderer.invoke('upload:startJob', jobId),
  uploadGetQueue: () => ipcRenderer.invoke('upload:getQueue'),
  uploadClearQueue: () => ipcRenderer.invoke('upload:clearQueue'),
  onUploadQueueUpdated: (cb) => registerListener('upload:queue-updated', cb),

  // Media Library Eventos (Fase 1.2)
  onMediaImported: (cb) => registerListener('bds:media-imported', cb),
  onMediaRemoved: (cb) => registerListener('bds:media-removed', cb),
  onMediaUpdated: (cb) => registerListener('bds:media-updated', cb),

  // LUTs - Adicionado parse
  getLuts: () => ipcRenderer.invoke('luts:get'),
  importLut: () => ipcRenderer.invoke('luts:import'),
  deleteLut: (filePath) => ipcRenderer.invoke('luts:delete', filePath),
  renameLut: (oldPath, newName) => ipcRenderer.invoke('luts:rename', oldPath, newName),
  parseLutCube: (filePath) => ipcRenderer.invoke('luts:parse', filePath), // <-- Novo!
  onLutParsed: (cb) => registerListener('luts:parsed', cb), // <-- Se for emitir evento (opcional, o invoke já retorna)
  getLutHeader: (filePath) => ipcRenderer.invoke('luts:getHeader', filePath), // <-- Novo! Metadados/cabeçalho do .cube
  getLutRaw: (filePath) => ipcRenderer.invoke('luts:load', filePath), // <-- Conteúdo bruto do .cube (reaproveita handler existente)

  // Projetos
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getProject: (id) => ipcRenderer.invoke('projects:get', id),
  createProject: (data) => ipcRenderer.invoke('projects:create', data),
  updateProject: (id, data) => ipcRenderer.invoke('projects:update', id, data),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),
  getProjectBins: (projectId) => ipcRenderer.invoke('projects:getBins', projectId),
  createProjectBin: (projectId, parentId, name) => ipcRenderer.invoke('projects:createBin', projectId, parentId, name),
  updateProjectBin: (id, name, parentId) => ipcRenderer.invoke('projects:updateBin', id, name, parentId),
  deleteProjectBin: (id) => ipcRenderer.invoke('projects:deleteBin', id),
  getProjectMedia: (projectId) => ipcRenderer.invoke('projects:getMedia', projectId),
  getProjectMediaById: (pmId) => ipcRenderer.invoke('projects:getMediaById', pmId),
  addProjectMedia: (projectId, binId, mediaId, customName) => ipcRenderer.invoke('projects:addMedia', projectId, binId, mediaId, customName),
  addProjectMediaBulk: (projectId, binId, mediaIds) => ipcRenderer.invoke('projects:addMediaBulk', projectId, binId, mediaIds),
  importFilesToProjectBin: (projectId, binId) => ipcRenderer.invoke('projects:importFilesToBin', { projectId, binId }),
  importDroppedFilesToProjectBin: (projectId, binId, filePaths) => ipcRenderer.invoke('projects:importDroppedFilesToBin', { projectId, binId, filePaths }),
  onProjectImportProgress: (cb) => registerListener('projects:importProgress', cb),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  removeProjectMedia: (pmId) => ipcRenderer.invoke('projects:removeMedia', pmId),

  moveProjectMedia: (pmId, newBinId) => ipcRenderer.invoke('projects:moveMedia', pmId, newBinId),
  getProjectFullModel: (projectId) => ipcRenderer.invoke('projects:getFullModel', projectId),
  getProjectSequences: (projectId) => ipcRenderer.invoke('projects:getSequences', projectId),
  getOrCreateDefaultSequence: (projectId) => ipcRenderer.invoke('projects:getOrCreateDefaultSequence', projectId),
  createProjectSequence: (projectId, name, timebase, width, height) => ipcRenderer.invoke('projects:createSequence', projectId, name, timebase, width, height),
  updateProjectSequence: (id, data) => ipcRenderer.invoke('projects:updateSequence', id, data),
  deleteProjectSequence: (id) => ipcRenderer.invoke('projects:deleteSequence', id),
  getProjectTracks: (sequenceId) => ipcRenderer.invoke('projects:getTracks', sequenceId),
  createProjectTrack: (sequenceId, trackType, trackIndex, name) => ipcRenderer.invoke('projects:createTrack', sequenceId, trackType, trackIndex, name),
  updateProjectTrack: (id, data) => ipcRenderer.invoke('projects:updateTrack', id, data),
  deleteProjectTrack: (id) => ipcRenderer.invoke('projects:deleteTrack', id),
  getProjectClips: (trackId) => ipcRenderer.invoke('projects:getClips', trackId),
  addProjectClip: (trackId, data) => ipcRenderer.invoke('projects:addClip', trackId, data),
  updateProjectClip: (id, data) => ipcRenderer.invoke('projects:updateClip', id, data),
  deleteProjectClip: (id) => ipcRenderer.invoke('projects:deleteClip', id),
  getProjectMarkers: (projectId, sequenceId) => ipcRenderer.invoke('projects:getMarkers', projectId, sequenceId),
  addProjectMarker: (data) => ipcRenderer.invoke('projects:addMarker', data),
  deleteProjectMarker: (id) => ipcRenderer.invoke('projects:deleteMarker', id),
  getProjectSyncGroups: (projectId) => ipcRenderer.invoke('projects:getSyncGroups', projectId),
  createProjectSyncGroup: (projectId, name, masterMediaId, items) => ipcRenderer.invoke('projects:createSyncGroup', projectId, name, masterMediaId, items),
  updateProjectSyncGroup: (id, data) => ipcRenderer.invoke('projects:updateSyncGroup', id, data),
  deleteProjectSyncGroup: (id) => ipcRenderer.invoke('projects:deleteSyncGroup', id),
  removeProjectSyncGroupItem: (itemId) => ipcRenderer.invoke('projects:removeSyncGroupItem', itemId),

  // --- FASE H: Relink de mídia ausente ---
  getMissingProjectMedia: (projectId) => ipcRenderer.invoke('projects:getMissingMedia', projectId),
  relinkMedia: (mediaId, newFilepath) => ipcRenderer.invoke('projects:relinkMedia', mediaId, newFilepath),
  exportBdspro: (projectId, outputPath) => ipcRenderer.invoke('projects:exportBdspro', projectId, outputPath),
  inspectBdspro: (bdsproPath) => ipcRenderer.invoke('projects:inspectBdspro', bdsproPath),
  scanRelinkFolder: (folderPath) => ipcRenderer.invoke('projects:scanRelinkFolder', folderPath),
  matchMissingMedia: (missingList, scannedFiles) => ipcRenderer.invoke('projects:matchMissingMedia', missingList, scannedFiles),
  importBdspro: (bdsproPath, relinkMap) => ipcRenderer.invoke('projects:importBdspro', bdsproPath, relinkMap),
  exportProjectPremiere: (projectId, outputPath) => ipcRenderer.invoke('projects:exportPremiere', projectId, outputPath),
  exportProjectSequencePremiere: (projectId, outputPath) => ipcRenderer.invoke('projects:exportSequencePremiere', projectId, outputPath),
  getProjectSequenceModel: (projectId) => ipcRenderer.invoke('projects:getSequenceModel', projectId),

  // Waveforms (Fase 5)
  getMediaWaveform: (params) => ipcRenderer.invoke('projects:getWaveform', params),
  probeAudioStreams: (filePath) => ipcRenderer.invoke('projects:probeAudioStreams', filePath),
  hasWaveformCache: (uuid, streamIndex) => ipcRenderer.invoke('projects:hasWaveformCache', uuid, streamIndex),
  deleteWaveformCache: (uuid, streamIndex) => ipcRenderer.invoke('projects:deleteWaveformCache', uuid, streamIndex),

  // Sincronização por Áudio (Fase 6)
  runAudioSync: (params) => ipcRenderer.invoke('projects:runAudioSync', params),
  onAudioSyncProgress: (cb) => registerListener('projects:audioSyncProgress', cb),



  // BDSM
  onBdsmDeviceAdded: (callback) => ipcRenderer.on('bdsm:device_added', (e, device) => callback(device)),
  onBdsmDeviceRemoved: (callback) => ipcRenderer.on('bdsm:device_removed', (e, deviceId) => callback(deviceId)),
  onBdsmDeviceUpdated: (callback) => ipcRenderer.on('bdsm:device_updated', (e, device) => callback(device)),
  getBdsmMedia: (ip, port) => ipcRenderer.invoke('bdsm:getMedia', ip, port),
  getBdsmImportHistory: (deviceId) => ipcRenderer.invoke('bdsm:getImportHistory', deviceId),
  importBdsmMedia: (data) => ipcRenderer.invoke('bdsm:importMedia', data),
  onBdsmProgress: (callback) => ipcRenderer.on('bdsm:progress', (e, data) => callback(data)),
  analyzeBdsmLutSync: (ip, port) => ipcRenderer.invoke('bdsm:analyzeLutSync', ip, port),
  executeBdsmLutSync: (data) => ipcRenderer.invoke('bdsm:executeLutSync', data),
  onBdsmLutSyncProgress: (callback) => ipcRenderer.on('bdsm:lutSyncProgress', (e, data) => callback(data)),

  // Sony Camera a6000
  discoverSonyCamera: (timeoutMs) => ipcRenderer.invoke('sony-camera:discover', timeoutMs),
  getSonyCameraStatus: () => ipcRenderer.invoke('sony-camera:get-status'),
  takeSonyCameraPhoto: () => ipcRenderer.invoke('sony-camera:take-photo'),
  startSonyCameraLiveview: () => ipcRenderer.invoke('sony-camera:start-liveview'),
  stopSonyCameraLiveview: () => ipcRenderer.invoke('sony-camera:stop-liveview'),
  downloadSonyCameraMedia: (fileUrl, destPath) => ipcRenderer.invoke('sony-camera:download', fileUrl, destPath),
  disconnectSonyCamera: () => ipcRenderer.invoke('sony-camera:disconnect'),
  onSonyCameraConnected: (cb) => registerListener('sony-camera:connected', cb),
  onSonyCameraDisconnected: (cb) => registerListener('sony-camera:disconnected', cb),
  onSonyCameraPhotoTaken: (cb) => registerListener('sony-camera:photo-taken', cb),
  onSonyCameraStatusUpdate: (cb) => registerListener('sony-camera:status-update', cb),
  onSonyCameraDownloadProgress: (cb) => registerListener('sony-camera:download-progress', cb),

  // Limpeza Global
  removeAllListeners: () => {
    for (const [channel, listener] of listeners) {
      ipcRenderer.removeListener(channel, listener);
    }
    listeners.clear();
  }
};

contextBridge.exposeInMainWorld('bds', api);
contextBridge.exposeInMainWorld('bmd', api);