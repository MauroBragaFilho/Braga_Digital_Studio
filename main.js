'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

// Identifica o app para o Windows — necessário para que notificações nativas
// (new Notification()) apareçam, especialmente em modo desenvolvimento (npm start),
// onde o app não tem AppUserModelID definido pelo electron-builder em produção.
app.setAppUserModelId('com.bragadev.digitalstudio');

// Configurações de inicialização do Electron
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// [FASE 1.1] Debug remoto só em desenvolvimento — NUNCA em produção
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '8315');
}

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

// [FASE 2.1] Tratamento de erros globais no processo principal
const logger = require('./src/services/logService');
const { errorReporter } = require('./src/infrastructure/telemetry/ErrorReporter');

process.on('uncaughtException', (err) => {
  logger.error('[Main] Exceção não capturada:', { message: err.message, stack: err.stack });
  errorReporter.report(err, { source: 'main-process-uncaughtException' }).catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.error('[Main] Rejeição não tratada:', { message });
  errorReporter.report(reason instanceof Error ? reason : new Error(message), { source: 'main-process-unhandledRejection' }).catch(() => {});
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 380,
    resizable: true,
    backgroundColor: '#121212',
    title: 'Braga Digital Studio',
    icon: path.join(appRoot, 'assets', 'icon.ico'), // [FASE 2.3] Usar appRoot em vez de __dirname
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,       // [FASE 1.3] Habilitar sandbox para reduzir superfície de ataque
      webviewTag: true     // Necessário: tela "Envio" (<webview> do YouTube Studio, partition persist:youtube_studio)
    }
  });

  // [SEGURANÇA] Restringe o <webview> a hospedar SOMENTE o YouTube Studio e força
  // o guest SEM nodeIntegration — compensa a reabilitação do webviewTag acima.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    let url;
    try {
      url = new URL(params.src || '');
    } catch (_) {
      event.preventDefault();
      return;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'studio.youtube.com') {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
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
