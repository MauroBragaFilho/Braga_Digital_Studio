// ARQUIVO GERADO por scripts/generate-preload.js a partir de src/ipc/channels.js. NÃO EDITE À MÃO:
// altere a tabela de canais e rode "npm run generate:preload" ("npm run verify:preload" confere).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Conjunto para gerenciar ouvintes e evitar vazamentos de memória
const listeners = new Set();

/**
 * Função auxiliar para registrar ouvintes de forma padronizada
 */
const registerListener = (channel, callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_, payload) => callback(payload);
  const entry = [channel, listener];
  ipcRenderer.on(channel, listener);
  listeners.add(entry);
  // Retorna uma função de desinscrição (idempotente) que também remove a entrada do Set,
  // evitando que ele cresça indefinidamente a cada tela/montagem.
  return () => {
    ipcRenderer.removeListener(channel, listener);
    listeners.delete(entry);
  };
};

const api = {
  // --- Configurações ---
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getDefaultFolders: () => ipcRenderer.invoke('settings:getDefaultFolders'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getDefaultOutputDir: () => ipcRenderer.invoke('system:getConverterOutputDir'),

  // --- App ---
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkForAppUpdate: () => ipcRenderer.invoke('app:checkForUpdate'),

  // --- Atualizações ---
  checkUpdates: () => ipcRenderer.invoke('updates:checkSystem'),
  updateTool: (tool, opts) => ipcRenderer.invoke('updates:updateTool', tool, opts),
  rollbackTool: (tool) => ipcRenderer.invoke('updates:rollbackTool', tool),
  installUpdates: () => ipcRenderer.invoke('updates:updateAll'),
  updateAllDependencies: () => ipcRenderer.invoke('updates:updateAll'),
  checkEverything: () => ipcRenderer.invoke('updates:checkAll'),
  updateEverything: () => ipcRenderer.invoke('updates:updateEverything'),
  downloadAppUpdate: () => ipcRenderer.invoke('updates:downloadAppUpdate'),
  installAppUpdate: (installerPath) => ipcRenderer.invoke('updates:installAppUpdate', installerPath),
  relaunchApp: () => ipcRenderer.invoke('updates:relaunchApp'),

  // --- Telemetria e relatório de erros ---
  reportError: (error, context) => ipcRenderer.invoke('telemetry:reportError', error, context),
  getDeveloperEmail: () => ipcRenderer.invoke('telemetry:getDeveloperEmail'),
  getCrashReports: () => ipcRenderer.invoke('telemetry:getCrashReports'),
  clearCrashReports: () => ipcRenderer.invoke('telemetry:clearCrashReports'),
  sendCrashReports: () => ipcRenderer.invoke('telemetry:sendReports'),
  getMailtoErrorLink: (error, context) => ipcRenderer.invoke('telemetry:getMailtoLink', error, context),
  generateManualMailto: (description) => ipcRenderer.invoke('telemetry:generateManualMailto', description),

  // --- Controles de janela ---
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  fullscreenWindow: (mode) => ipcRenderer.invoke('window:fullscreen', mode === 'exit' ? 'exit' : undefined),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  // --- Diálogos ---
  selectFolder: (fallbackPath) => ipcRenderer.invoke('dialog:selectFolder', fallbackPath),
  selectFiles: () => ipcRenderer.invoke('dialog:selectFiles'),
  selectFile: (options) => ipcRenderer.invoke('dialog:selectFiles', options),

  // --- Montagem ---
  probeMontageFile: (filePath) => ipcRenderer.invoke('montage:probe', filePath),
  enqueueMontage: (config) => ipcRenderer.invoke('montage:enqueue', config),
  cancelMontageJob: (id) => ipcRenderer.invoke('montage:cancelJob', id),
  removeMontageJob: (id) => ipcRenderer.invoke('montage:removeJob', id),
  clearMontageQueue: () => ipcRenderer.invoke('montage:clearQueue'),
  getMontageQueue: () => ipcRenderer.invoke('montage:getQueue'),

  // --- Remover silêncio ---
  probeSilenceFile: (filePath) => ipcRenderer.invoke('silence:probe', filePath),
  analyzeSilence: (config) => ipcRenderer.invoke('silence:analyze', config),
  processSilence: (config) => ipcRenderer.invoke('silence:process', config),
  cancelSilence: () => ipcRenderer.invoke('silence:cancel'),

  // --- Metadados ---
  probeMetadataFile: (filePath) => ipcRenderer.invoke('metadata:probe', filePath),
  extractMetadataThumb: (filePath) => ipcRenderer.invoke('metadata:extractThumb', filePath),
  saveMetadata: (config) => ipcRenderer.invoke('metadata:save', config),
  cancelMetadata: () => ipcRenderer.invoke('metadata:cancel'),

  // --- Conversor ---
  converterAddFiles: (files) => ipcRenderer.invoke('converter:addFiles', files),
  converterStart: (config) => ipcRenderer.invoke('converter:start', config),
  converterCancel: () => ipcRenderer.invoke('converter:cancel'),
  converterClearQueue: () => ipcRenderer.invoke('converter:clearQueue'),
  converterRemoveFile: (index) => ipcRenderer.invoke('converter:removeFile', index),

  // --- Downloads e mídia ---
  getMetadata: (url) => ipcRenderer.invoke('media:metadata', url),
  inspectPlaylist: (url) => ipcRenderer.invoke('media:inspectPlaylist', url),
  expandPlaylist: (url) => ipcRenderer.invoke('media:expandPlaylist', url),

  // --- Namespace downloads ---
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
    skipWait: () => ipcRenderer.invoke('downloads:skipWait'),
    getWaitState: () => ipcRenderer.invoke('downloads:waitState'),
    cookiesStatus: () => ipcRenderer.invoke('downloads:cookiesStatus'),
    onWait: (cb) => registerListener('downloads:wait', cb),
    onAdded: (cb) => registerListener('downloads:added', cb),
    onUpdated: (cb) => registerListener('downloads:updated', cb),
    onProgress: (cb) => registerListener('downloads:progress', cb),
    onCompleted: (cb) => registerListener('downloads:completed', cb),
    onFailed: (cb) => registerListener('downloads:failed', cb),
    onRemoved: (cb) => registerListener('downloads:removed', cb),
    onQueueCompleted: (cb) => registerListener('downloads:queue-completed', cb),
  },
  // --- Downloads e mídia ---
  downloadRemoveJob: (id) => ipcRenderer.invoke('downloads:remove', id),
  downloadClearQueue: () => ipcRenderer.invoke('downloads:clearCompleted'),
  downloadGetQueue: () => ipcRenderer.invoke('downloads:getQueue'),

  // --- YouTube ---
  getYoutubeAccounts: () => ipcRenderer.invoke('youtube:get-accounts'),
  exportYoutubeCookies: () => ipcRenderer.invoke('youtube:exportCookies'),
  youtubeLogin: () => ipcRenderer.invoke('youtube:login'),

  // --- Histórico ---
  listHistory: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  listConversions: () => ipcRenderer.invoke('conversions:list'),
  clearConversions: () => ipcRenderer.invoke('conversions:clear'),

  // --- Dispositivos (MTP, USB e BDSM) ---
  getAllDevices: (force = false) => ipcRenderer.invoke('devices:get-all', force),
  listUsbFolder: (basePath, pathArray) => ipcRenderer.invoke('usb:list-folder', basePath, pathArray),
  importUsbItems: (basePath, pathArray, itemNames, destFolder) => ipcRenderer.invoke('usb:import-items', basePath, pathArray, itemNames, destFolder),
  listMtpFolder: (deviceName, pathArray) => ipcRenderer.invoke('mtp:list-folder', deviceName, pathArray),
  importMtpItems: (deviceName, pathArray, itemNames, destFolder) => ipcRenderer.invoke('mtp:import-items', deviceName, pathArray, itemNames, destFolder),

  // --- Câmeras Sony ---
  sonyList: (cameraId, options) => ipcRenderer.invoke('sony:list', cameraId, options),
  sonyBrowse: (cameraId, uri) => ipcRenderer.invoke('sony:browse', cameraId, uri),
  sonyGetStatus: (cameraId) => ipcRenderer.invoke('sony:get-status', cameraId),
  sonyImportItems: (cameraId, items, destFolder) => ipcRenderer.invoke('sony:import-items', { cameraId, items, destFolder }),

  // --- BDSM ---
  getBdsmMedia: (ip, port) => ipcRenderer.invoke('bdsm:getMedia', ip, port),
  getBdsmImportHistory: (deviceId) => ipcRenderer.invoke('bdsm:getImportHistory', deviceId),
  importBdsmMedia: (data) => ipcRenderer.invoke('bdsm:importMedia', data),
  analyzeBdsmLutSync: (ip, port) => ipcRenderer.invoke('bdsm:analyzeLutSync', ip, port),
  executeBdsmLutSync: (data) => ipcRenderer.invoke('bdsm:executeLutSync', data),
  getBdsmPairingStatus: (ip, port) => ipcRenderer.invoke('bdsm:pairingStatus', ip, port),
  startBdsmPairing: (ip, port) => ipcRenderer.invoke('bdsm:pairStart', ip, port),
  cancelBdsmPairing: (ip, port) => ipcRenderer.invoke('bdsm:pairCancel', ip, port),
  forgetBdsmPairing: (ip, port) => ipcRenderer.invoke('bdsm:pairForget', ip, port),
  getBdsmThumbnail: (ip, port, id) => ipcRenderer.invoke('bdsm:getThumbnail', ip, port, id),

  // --- Namespace recovery ---
  recovery: {
    diagnose: (corruptPath, referencePath) => ipcRenderer.invoke('recovery:diagnose', { corruptPath, referencePath }),
    start: (options) => ipcRenderer.invoke('recovery:start', options),
    cancel: () => ipcRenderer.invoke('recovery:cancel'),
    raw: {
      diagnose: (corruptPath, referencePath) => ipcRenderer.invoke('recovery:raw:diagnose', { corruptPath, referencePath }),
      start: (options) => ipcRenderer.invoke('recovery:raw:start', options),
      cancel: () => ipcRenderer.invoke('recovery:raw:cancel'),
      onProgress: (cb) => registerListener('recovery:raw:progress', cb),
      onStage: (cb) => registerListener('recovery:raw:stage', cb),
      onFinished: (cb) => registerListener('recovery:raw:finished', cb),
      onError: (cb) => registerListener('recovery:raw:error', cb),
    },
    onProgress: (cb) => registerListener('recovery:progress', cb),
    onStage: (cb) => registerListener('recovery:stage', cb),
    onFinished: (cb) => registerListener('recovery:finished', cb),
    onError: (cb) => registerListener('recovery:error', cb),
  },
  // --- Recuperação e logs ---
  exportDiagnosticLogs: () => ipcRenderer.invoke('logs:export'),

  // --- LUTs ---
  getLuts: () => ipcRenderer.invoke('luts:get'),
  importLut: (paths) => ipcRenderer.invoke('luts:import', paths),
  revealLut: (filePath) => ipcRenderer.invoke('luts:reveal', filePath),
  getLutReferenceImage: (filePath) => ipcRenderer.invoke('luts:getReferenceImage', filePath),
  deleteLut: (filePath) => ipcRenderer.invoke('luts:delete', filePath),
  renameLut: (oldPath, newName) => ipcRenderer.invoke('luts:rename', oldPath, newName),
  parseLutCube: (filePath) => ipcRenderer.invoke('luts:parse', filePath),
  getLutHeader: (filePath) => ipcRenderer.invoke('luts:getHeader', filePath),
  getLutRaw: (filePath) => ipcRenderer.invoke('luts:load', filePath),

  // --- IA (a chave de API nunca volta para o renderer) ---
  aiGetConfig: () => ipcRenderer.invoke('ai:getConfig'),
  aiSaveConfig: (patch) => ipcRenderer.invoke('ai:saveConfig', patch),
  aiTestConnection: () => ipcRenderer.invoke('ai:testConnection'),
  aiListModels: () => ipcRenderer.invoke('ai:listModels'),
  aiChatStart: (text) => ipcRenderer.invoke('ai:chatStart', { text }),
  aiChatCancel: (id) => ipcRenderer.invoke('ai:chatCancel', id),
  aiHistoryGet: () => ipcRenderer.invoke('ai:historyGet'),
  aiHistoryClear: () => ipcRenderer.invoke('ai:historyClear'),
  aiAnalyzeTranscript: (path) => ipcRenderer.invoke('ai:analyzeTranscript', { path }),
  aiCancelAnalysis: () => ipcRenderer.invoke('ai:cancelAnalysis'),

  // --- Módulos opcionais (Whisper) ---
  modulesGetStatus: () => ipcRenderer.invoke('modules:getStatus'),
  modulesInstallEngine: (payload) => ipcRenderer.invoke('modules:installEngine', payload),
  modulesUninstallEngine: () => ipcRenderer.invoke('modules:uninstallEngine'),
  modulesInstallModel: (id) => ipcRenderer.invoke('modules:installModel', id),
  modulesRemoveModel: (id) => ipcRenderer.invoke('modules:removeModel', id),
  modulesSetActiveModel: (id) => ipcRenderer.invoke('modules:setActiveModel', id),
  modulesInstallCuda: (payload) => ipcRenderer.invoke('modules:installCuda', payload),
  modulesRemoveCuda: () => ipcRenderer.invoke('modules:removeCuda'),
  modulesCancel: () => ipcRenderer.invoke('modules:cancel'),
  modulesTranscribe: (options) => ipcRenderer.invoke('modules:transcribe', options),
  modulesReveal: (p) => ipcRenderer.invoke('modules:reveal', p),
  modulesList: () => ipcRenderer.invoke('modules:list'),
  modulesSetEnabled: (id, enabled) => ipcRenderer.invoke('modules:setEnabled', id, enabled),

  // --- Biblioteca de mídia ---
  getLibraryStats: () => ipcRenderer.invoke('library:getStats'),
  getThumbDir: () => ipcRenderer.invoke('library:getThumbDir'),
  searchLibrary: (options) => ipcRenderer.invoke('library:search', options),
  getRecentMedia: (limit) => ipcRenderer.invoke('library:getRecent', limit),
  getLibraryFilterOptions: () => ipcRenderer.invoke('library:getFilterOptions'),
  addCustomSource: (config) => ipcRenderer.invoke('library:addCustomSource', config),
  getCustomSources: () => ipcRenderer.invoke('library:getCustomSources'),
  getMediaProjectLinks: (ids) => ipcRenderer.invoke('library:getMediaProjectLinks', ids),
  updateCustomSourcePath: (config) => ipcRenderer.invoke('library:updateCustomSourcePath', config),
  removeCustomSource: (config) => ipcRenderer.invoke('library:removeCustomSource', config),
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
  clearLibraryDatabase: () => ipcRenderer.invoke('library:clearDatabase'),
  rescanAllLibrary: () => ipcRenderer.invoke('library:rescanAll'),
  regenerateMissingThumbnails: (opts) => ipcRenderer.invoke('library:regenerateMissingThumbnails', opts || {}),
  getAllLibraries: () => ipcRenderer.invoke('library:getAll'),
  getLibraryFolderFiles: (folderPath) => ipcRenderer.invoke('library:getFolderFiles', folderPath),

  // --- Sistema ---
  getVideosPath: () => ipcRenderer.invoke('system:getVideosPath'),
  getDownloadsPath: () => ipcRenderer.invoke('system:getDownloadsPath'),
  getToolsPath: () => ipcRenderer.invoke('system:getToolsPath'),
  isPackaged: () => ipcRenderer.invoke('system:isPackaged'),
  getHardwareInfo: () => ipcRenderer.invoke('system:getHardwareInfo'),
  checkEncoders: () => ipcRenderer.invoke('system:checkEncoders'),
  getStorageInfo: () => ipcRenderer.invoke('system:getStorageInfo'),
  getCacheInfo: () => ipcRenderer.invoke('system:getCacheInfo'),
  clearCache: (categoryKey) => ipcRenderer.invoke('system:clearCache', categoryKey),
  openLocalPath: (itemPath) => ipcRenderer.invoke('system:openPath', itemPath),
  exportCookies: (domain, outputPath) => ipcRenderer.invoke('system:exportCookies', domain, outputPath),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // --- Licenças de terceiros ---
  getLicenses: () => ipcRenderer.invoke('licenses:getList'),
  getLicenseText: (id) => ipcRenderer.invoke('licenses:getText', id),

  // --- Upload ---
  uploadScanDirectory: (customDir) => ipcRenderer.invoke('upload:scanDirectory', customDir),
  uploadSelectFolder: () => ipcRenderer.invoke('upload:selectFolder'),
  uploadSelectFiles: () => ipcRenderer.invoke('upload:selectFiles'),

  // --- Prévia de fotos ---
  photoGetMetadata: (filePath) => ipcRenderer.invoke('photo:getMetadata', filePath),
  photoGetRenderablePath: (filePath, options) => ipcRenderer.invoke('photo:getRenderablePath', filePath, options),

  // --- Projetos ---
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
  getMediaWaveform: (params) => ipcRenderer.invoke('projects:getWaveform', params),
  probeAudioStreams: (filePath) => ipcRenderer.invoke('projects:probeAudioStreams', filePath),
  hasWaveformCache: (uuid, streamIndex) => ipcRenderer.invoke('projects:hasWaveformCache', uuid, streamIndex),
  deleteWaveformCache: (uuid, streamIndex) => ipcRenderer.invoke('projects:deleteWaveformCache', uuid, streamIndex),
  getTrackAudioPath: (params) => ipcRenderer.invoke('projects:getTrackAudioPath', params),
  runAudioSync: (params) => ipcRenderer.invoke('projects:runAudioSync', params),

  // --- Eventos (main → renderer) ---
  onMontageProgress: (cb) => registerListener('montage:progress', cb),
  onMontageFinished: (cb) => registerListener('montage:finished', cb),
  onMontageQueueUpdated: (cb) => registerListener('montage:queue-updated', cb),
  onMontageLog: (cb) => registerListener('montage:log', cb),
  onSilenceProgress: (cb) => registerListener('silence:progress', cb),
  onSilenceFinished: (cb) => registerListener('silence:finished', cb),
  onSilenceLog: (cb) => registerListener('silence:log', cb),
  onMtpProgress: (cb) => registerListener('mtp:import-progress', cb),
  onSonyImportProgress: (cb) => registerListener('sony:import-progress', cb),
  onSonyStatusUpdated: (cb) => registerListener('sony-camera:status-update', cb),
  onMetadataProgress: (cb) => registerListener('metadata:progress', cb),
  onMetadataLog: (cb) => registerListener('metadata:log', cb),
  onNavigateToScreen: (cb) => registerListener('bds:navigate-to-screen', cb),
  onUpdateProgress: (cb) => registerListener('updates:progress', cb),
  onUpdateCompleted: (cb) => registerListener('updates:completed', cb),
  onDownloadQueue: (cb) => registerListener('download:queue', cb),
  onProgress: (cb) => registerListener('download:progress', cb),
  onFinished: (cb) => registerListener('download:finished', cb),
  onUpdatesChecked: (cb) => registerListener('updates:checked', cb),
  onDependenciesDownloading: (cb) => registerListener('dependencies:downloading', cb),
  onDependenciesDone: (cb) => registerListener('dependencies:done', cb),
  onConverterQueue: (cb) => registerListener('converter:queue', cb),
  onConverterFileStarted: (cb) => registerListener('converter:fileStarted', cb),
  onConverterProgress: (cb) => registerListener('converter:progress', cb),
  onConverterFileFinished: (cb) => registerListener('converter:fileFinished', cb),
  onConverterFinished: (cb) => registerListener('converter:finished', cb),
  onConverterOverallProgress: (cb) => registerListener('converter:overallProgress', cb),
  onYoutubeCode: (cb) => registerListener('youtube:code', cb),
  onYoutubeAuthStatus: (cb) => registerListener('youtube:auth-status', cb),
  onAiAnalysisProgress: (cb) => registerListener('ai:analysisProgress', cb),
  onAiChatDelta: (cb) => registerListener('ai:chatDelta', cb),
  onAiChatDone: (cb) => registerListener('ai:chatDone', cb),
  onAiChatError: (cb) => registerListener('ai:chatError', cb),
  onAiChatStatus: (cb) => registerListener('ai:chatStatus', cb),
  onModulesChanged: (cb) => registerListener('modules:changed', cb),
  onModulesProgress: (cb) => registerListener('modules:progress', cb),
  onModulesStatus: (cb) => registerListener('modules:status', cb),
  onThumbsRegenProgress: (cb) => registerListener('bds:thumbs-regen-progress', cb),
  onMediaImported: (cb) => registerListener('bds:media-imported', cb),
  onMediaRemoved: (cb) => registerListener('bds:media-removed', cb),
  onMediaUpdated: (cb) => registerListener('bds:media-updated', cb),
  onProjectImportProgress: (cb) => registerListener('projects:importProgress', cb),
  onAudioSyncProgress: (cb) => registerListener('projects:audioSyncProgress', cb),
  onBdsmDeviceAdded: (cb) => registerListener('bdsm:device_added', cb),
  onBdsmDeviceRemoved: (cb) => registerListener('bdsm:device_removed', cb),
  onBdsmDeviceUpdated: (cb) => registerListener('bdsm:device_updated', cb),
  onBdsmProgress: (cb) => registerListener('bdsm:progress', cb),
  onBdsmLutSyncProgress: (cb) => registerListener('bdsm:lutSyncProgress', cb),
  onBdsmPairing: (cb) => registerListener('bdsm:pairing', cb),

  // --- Utilitários fixos ---
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Limpeza Global
  removeAllListeners: () => {
    for (const [channel, listener] of listeners) {
      ipcRenderer.removeListener(channel, listener);
    }
    listeners.clear();
  }
};

contextBridge.exposeInMainWorld('bds', api);
