const { ipcMain } = require('electron');

module.exports = function registerProjectHandlers(projectService, premiereExporter) {
  ipcMain.handle('projects:list', () => projectService.getAllProjects());
  ipcMain.handle('projects:get', (_, id) => projectService.getProjectById(id));
  ipcMain.handle('projects:create', (_, data) => projectService.createProject(data));
  ipcMain.handle('projects:update', (_, id, data) => projectService.updateProject(id, data));
  ipcMain.handle('projects:delete', (_, id) => projectService.deleteProject(id));

  ipcMain.handle('projects:getBins', (_, projectId) => projectService.getProjectBins(projectId));
  ipcMain.handle('projects:createBin', (_, projectId, parentId, name) => projectService.createBin(projectId, parentId, name));
  ipcMain.handle('projects:updateBin', (_, id, name, parentId) => projectService.updateBin(id, name, parentId));
  ipcMain.handle('projects:deleteBin', (_, id) => projectService.deleteBin(id));

  ipcMain.handle('projects:getMedia', (_, projectId) => projectService.getProjectMedia(projectId));
  ipcMain.handle('projects:addMedia', (_, projectId, binId, mediaId, customName) => projectService.addMediaToBin(projectId, binId, mediaId, customName));
  ipcMain.handle('projects:removeMedia', (_, pmId) => projectService.removeMediaFromBin(pmId));
  ipcMain.handle('projects:moveMedia', (_, pmId, newBinId) => projectService.moveMedia(pmId, newBinId));

  ipcMain.handle('projects:exportPremiere', (_, projectId, outputPath) => premiereExporter.exportToPremiereXml(projectId, outputPath));
};
