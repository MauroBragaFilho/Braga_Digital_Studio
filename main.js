'use strict';

const { app, BrowserWindow, nativeImage, protocol, net, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

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

/**
 * Tamanho/posição salvos da janela (opção "Lembrar tamanho e posição" nas Configurações).
 * Devolve null se a opção estiver desligada ou se a janela ficaria fora de todos os monitores
 * (ex.: um monitor foi desconectado).
 */
function loadSavedWindowBounds() {
  try {
    const settings = bootstrap.settingsManager.load();
    const b = settings.rememberWindowBounds ? settings.windowBounds : null;
    if (!b) return null;
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
      const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
      return w >= 100 && h >= 100;
    });
    return visible ? b : null;
  } catch (_) {
    return null;
  }
}

/** Grava o tamanho/posição da janela (com atraso) enquanto a opção estiver ligada. */
function trackWindowBounds(win) {
  let timer = null;
  const persist = () => {
    try {
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      if (!bootstrap.settingsManager.load().rememberWindowBounds) return;
      const r = win.getNormalBounds();
      bootstrap.settingsManager.save({ windowBounds: { x: r.x, y: r.y, width: r.width, height: r.height, maximized: win.isMaximized() } });
    } catch (_) { /* não impede o app de funcionar */ }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(persist, 600); };
  ['resize', 'move', 'maximize', 'unmaximize'].forEach((evt) => win.on(evt, schedule));
  win.on('close', () => { clearTimeout(timer); persist(); });
}

function createWindow() {
  const savedBounds = loadSavedWindowBounds();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y, width: savedBounds.width, height: savedBounds.height } : {}),
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

  // Define o ícone da barra de tarefas via nativeImage — necessário porque
  // a propriedade "icon" do BrowserWindow nem sempre atualiza o ícone do
  // Windows Taskbar em modo de desenvolvimento (sem empaquetamento NSIS).
  const iconPath = path.join(appRoot, 'assets', 'icon.ico');
  const pngPath = path.join(appRoot, 'assets', 'icon.png');
  const applyIcon = () => {
    try {
      // Prefere o .ico (multi-resolução para a taskbar); usa o .png como fallback.
      let icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) icon = nativeImage.createFromPath(pngPath);
      if (!icon.isEmpty()) mainWindow.setIcon(icon);
    } catch (_) { /* ignora se os arquivos não existirem ou estiverem corrompidos */ }
  };
  applyIcon();
  // Reaplica o ícone quando a janela estiver visível e em foco — o Windows só
  // "pega" o ícone da barra de tarefas depois que a janela é exibida, então
  // aplicar antes do show pode ser ignorado em modo de desenvolvimento.
  mainWindow.once('ready-to-show', applyIcon);
  mainWindow.on('focus', applyIcon);

  // Somente em desenvolvimento: Ctrl+R / F5 recarrega a interface (Ctrl+Shift+R ignora o cache),
  // sem precisar fechar e abrir o app. O menu é nulo, então o atalho é tratado aqui.
  if (!isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key).toLowerCase();
      const isReload = (key === 'r' && (input.control || input.meta)) || key === 'f5';
      if (!isReload) return;
      event.preventDefault();
      if (input.shift) mainWindow.webContents.reloadIgnoringCache();
      else mainWindow.webContents.reload();
    });
  }

  if (savedBounds && savedBounds.maximized) mainWindow.maximize();
  trackWindowBounds(mainWindow);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  bootstrap.setMainWindow(mainWindow);
}

// [THUMB] Registra o esquema personalizado bds-thumb:// como seguro,
// para que o renderer em sandbox possa carregar miniaturas locais geradas pelo FFmpeg.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bds-thumb',
    privileges: { standard: false, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
]);

app.whenReady().then(async () => {
  // [THUMB] Intercepta bds-thumb://<caminho-absoluto> e serve o arquivo local
  protocol.handle('bds-thumb', (request) => {
    const rawPath = decodeURIComponent(
      request.url.slice('bds-thumb://'.length)
    );
    // Normaliza barras para o sistema operacional
    const filePath = rawPath.replace(/\//g, path.sep);
    return net.fetch(`file:///${filePath}`);
  });

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
