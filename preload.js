const { contextBridge, ipcRenderer } = require('electron');

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

  // Controles de Janela
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
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
  getAllDevices: () => ipcRenderer.invoke('devices:get-all'),
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
  startDownload: (request) => ipcRenderer.invoke('download:start', request),
  cancelDownload: () => ipcRenderer.invoke('download:cancel'),

  // --- Histórico ---
  listHistory: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  listConversions: () => ipcRenderer.invoke('conversions:list'),
  clearConversions: () => ipcRenderer.invoke('conversions:clear'),

  // --- Atualizações ---
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  updateTool: (tool) => ipcRenderer.invoke('updates:updateTool', tool),
  updateAllDependencies: () => ipcRenderer.invoke('updates:updateAll'),

  // --- YouTube ---
  startYoutubeAuth: () => ipcRenderer.invoke('youtube:startAuth'),

  // --- Ouvintes (Events) ---
  onProgress: (cb) => registerListener('download:progress', cb),
  onFinished: (cb) => registerListener('download:finished', cb),
  // Atualizações e Dependências Iniciais
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
  getStorageInfo: () => ipcRenderer.invoke('system:getStorageInfo'),
  openLocalPath: (itemPath) => ipcRenderer.invoke('system:openPath', itemPath),
  exportCookies: (domain, outputPath) => ipcRenderer.invoke('system:exportCookies', domain, outputPath),
  youtubeLogin: () => ipcRenderer.invoke('youtube:login'),
  youtubeUpload: (config) => ipcRenderer.invoke('youtube:upload', config),

  // Media Library Eventos (Fase 1.2)
  onMediaImported: (cb) => registerListener('bds:media-imported', cb),
  onMediaRemoved: (cb) => registerListener('bds:media-removed', cb),
  onMediaUpdated: (cb) => registerListener('bds:media-updated', cb),

  // LUTs
  getLuts: () => ipcRenderer.invoke('luts:get'),
  importLut: () => ipcRenderer.invoke('luts:import'),
  deleteLut: (filePath) => ipcRenderer.invoke('luts:delete', filePath),
    renameLut: (oldPath, newName) => ipcRenderer.invoke('luts:rename', oldPath, newName),

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