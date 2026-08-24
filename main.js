'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

// Configurações de inicialização do Electron
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('remote-debugging-port', '8315');

const { appPaths } = require('./src/infrastructure/filesystem/AppPaths');

// Inicialização dos caminhos e ambiente gravável
const isPackaged = app.isPackaged;
const appRoot = isPackaged ? process.resourcesPath : __dirname;
const writableRoot = isPackaged ? app.getPath('userData') : __dirname;

appPaths.init(writableRoot, appRoot);
appPaths.ensureDirectories();
process.env.BMD_LOGS_DIR = appPaths.logsDir;

const { externalTools } = require('./src/infrastructure/external-tools/ExternalToolsManager');
externalTools.init(appPaths.dataDir);

const Bootstrap = require('./src/bootstrap');
const bootstrap = new Bootstrap(appPaths);
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 380,
    resizable: true,
    backgroundColor: '#121212',
    title: 'Braga Digital Studio',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  bootstrap.setMainWindow(mainWindow);
}

app.whenReady().then(async () => {
  await bootstrap.init();
  createWindow();

  // Inicia serviços de background (watchers, discovery) após a interface estar montada
  setTimeout(() => bootstrap.startBackgroundServices(), 500);

  // Verificação em background de ferramentas/atualizações
  setTimeout(() => bootstrap.checkInitialDependencies(), 2000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await bootstrap.cleanup();
});
