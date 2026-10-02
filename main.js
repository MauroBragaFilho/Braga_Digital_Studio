'use strict';

const { app, BrowserWindow, nativeImage, protocol, net, screen, session, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { resolveThumbRequest } = require('./src/ipc/thumbProtocol');
const { assertExternalUrl } = require('./src/ipc/validate');

// Identifica o app para o Windows — necessário para que notificações nativas
// (new Notification()) apareçam, especialmente em modo desenvolvimento (npm start),
// onde o app não tem AppUserModelID definido pelo electron-builder em produção.
app.setAppUserModelId('com.bragadev.digitalstudio');

// Configurações de inicialização do Electron
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// [FASE 1.1] Debug remoto: opt-in explícito e SOMENTE em desenvolvimento (nunca empacotado).
// Uso: BDS_DEBUG_PORT=8315 npm start   (escuta apenas em 127.0.0.1; o YouTubeBot espera a porta 8315)
const debugPort = process.env.BDS_DEBUG_PORT;
if (!app.isPackaged && debugPort && /^\d{2,5}$/.test(debugPort) && Number(debugPort) <= 65535) {
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
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

// Erros benignos de rede/IO que não justificam alarmar o usuário com um diálogo.
const BENIGN_ERROR_CODES = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR']);
// Erros graves: o processo pode estar instável → informa e encerra com segurança.
const FATAL_ERROR_CODES = new Set(['ERR_OUT_OF_MEMORY', 'ENOMEM', 'ERR_WORKER_OUT_OF_MEMORY']);
let fatalDialogShown = false;
let lastErrorDialogAt = 0;

function notifyUncaught(err) {
  try {
    if (!app.isReady()) return;
    const code = err && err.code;
    if (BENIGN_ERROR_CODES.has(code)) return;

    if (FATAL_ERROR_CODES.has(code)) {
      if (fatalDialogShown) return; // sem laço: um único diálogo fatal
      fatalDialogShown = true;
      dialog.showErrorBox('Braga Digital Studio — erro grave', `O aplicativo encontrou um erro grave e será encerrado.\n\n${err.message}`);
      app.quit(); // passa pelo before-quit (encerramento ordenado, idempotente)
      return;
    }

    // Erro comum: avisa no máximo 1x a cada 60s para não gerar uma enxurrada de diálogos.
    const now = Date.now();
    if (now - lastErrorDialogAt < 60000) return;
    lastErrorDialogAt = now;
    dialog.showErrorBox('Braga Digital Studio — erro inesperado', `Ocorreu um erro inesperado. Detalhes foram gravados no log.\n\n${err.message}`);
  } catch (_) { /* nunca lançar de dentro do handler de erros */ }
}

process.on('uncaughtException', (err) => {
  logger.error('[Main] Exceção não capturada:', { message: err.message, stack: err.stack });
  errorReporter.report(err, { source: 'main-process-uncaughtException' }).catch(() => {});
  notifyUncaught(err);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.error('[Main] Rejeição não tratada:', { message });
  errorReporter.report(reason instanceof Error ? reason : new Error(message), { source: 'main-process-unhandledRejection' }).catch(() => {});
});

/** Abre uma URL externa no navegador padrão, somente https:/mailto: (qualquer outra é ignorada). */
function openExternalSafe(url) {
  try {
    shell.openExternal(assertExternalUrl(url)).catch(() => {});
  } catch (_) { /* URL não permitida */ }
}

/** Hosts que o webview do YouTube Studio pode visitar (login Google + Studio). */
function isAllowedGuestUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'google.com' || h.endsWith('.google.com');
  } catch (_) {
    return false;
  }
}

/** Permissões que o app (e o webview do YouTube Studio) realmente usam; todo o resto é negado. */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

function hardenSession(ses) {
  if (!ses || ses.__bdsHardened) return;
  ses.__bdsHardened = true;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
}

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
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
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
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    // Partition fixa: o guest sempre usa a sessão do YouTube Studio, independente do atributo do HTML.
    params.partition = 'persist:youtube_studio';
  });

  // Webview (guest): navegação restrita a *.youtube.com / *.google.com; popups nunca criam janelas.
  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    const guardNavigation = (event, url) => { if (!isAllowedGuestUrl(url)) event.preventDefault(); };
    guest.on('will-navigate', guardNavigation);
    guest.on('will-redirect', guardNavigation);
    guest.setWindowOpenHandler(({ url }) => {
      if (isAllowedGuestUrl(url)) setImmediate(() => { try { guest.loadURL(url); } catch (_) {} });
      else openExternalSafe(url);
      return { action: 'deny' };
    });
  });

  // Janela principal: só pode exibir os arquivos do próprio renderer; links externos vão ao navegador.
  const rendererFileUrl = pathToFileURL(path.join(__dirname, 'renderer') + path.sep).toString();
  const guardMainNavigation = (event, url) => {
    if (url.startsWith(rendererFileUrl)) return;
    event.preventDefault();
    openExternalSafe(url);
  };
  mainWindow.webContents.on('will-navigate', guardMainNavigation);
  mainWindow.webContents.on('will-redirect', guardMainNavigation);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
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

// Encerramento idempotente (ver before-quit no final do arquivo).
let quitting = false;
let shutdownComplete = false;

app.whenReady().then(async () => {
  // Permissões negadas por padrão em toda sessão (a padrão e as de partições persist:*).
  hardenSession(session.defaultSession);
  hardenSession(session.fromPartition('persist:youtube_studio'));
  hardenSession(session.fromPartition('persist:youtube'));
  app.on('session-created', hardenSession);

  // [THUMB] Intercepta bds-thumb://<caminho-absoluto> e serve SOMENTE imagens dos diretórios do app
  // (miniaturas, capas e previews de fotos). Qualquer outra coisa recebe 403/404.
  protocol.handle('bds-thumb', async (request) => {
    const allowedDirs = [
      appPaths.thumbnailsDir,
      appPaths.coversDir,
      path.join(appPaths.dataDir, 'cache', 'previews')
    ];
    const resolved = resolveThumbRequest(request.url, allowedDirs);
    if (!resolved.ok) {
      return new Response(resolved.reason, { status: resolved.status });
    }
    try {
      await fs.promises.access(resolved.filePath, fs.constants.R_OK);
      return await net.fetch(pathToFileURL(resolved.filePath).toString());
    } catch (_) {
      return new Response('Not found', { status: 404 });
    }
  });

  try {
    await bootstrap.init();
  } catch (err) {
    logger.error('[Main] Falha na inicialização:', { message: err.message, stack: err.stack });
    dialog.showErrorBox('Braga Digital Studio', `Não foi possível iniciar o aplicativo.\n\n${err.message}\n\nDetalhes foram gravados no log.`);
    app.exit(1);
    return;
  }
  createWindow();

  // Inicia serviços de background (watchers, discovery) após a interface estar montada
  setTimeout(() => { if (!quitting) bootstrap.startBackgroundServices(); }, 500);

  // Verificação em background de ferramentas/atualizações
  setTimeout(() => { if (!quitting) bootstrap.checkInitialDependencies(); }, 2000);

  // Registrado uma única vez (whenReady roda uma vez); createWindow() reaproveita janela existente.
  app.on('activate', () => {
    if (!quitting && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// O primeiro before-quit é cancelado; os serviços são cancelados (prazo total ~5s) e o banco é
// gravado de forma síncrona; só então o app sai de verdade (segunda passada com shutdownComplete).
app.on('before-quit', (event) => {
  if (shutdownComplete) return; // 2ª passada: deixa o app sair
  event.preventDefault();
  if (quitting) return;         // já encerrando: ignora chamadas repetidas
  quitting = true;

  const finish = () => {
    if (shutdownComplete) return;
    shutdownComplete = true;
    app.quit();
  };

  // Rede de segurança: mesmo que algo trave, a saída acontece em até 6,5s.
  const hardTimer = setTimeout(() => {
    logger.warn('[Main] Encerramento excedeu o prazo; forçando saída.');
    try {
      const dbManager = require('./src/core/database/database');
      if (typeof dbManager.persistSync === 'function') dbManager.persistSync();
      else if (typeof dbManager.persist === 'function') dbManager.persist();
    } catch (_) {}
    finish();
  }, 6500);

  Promise.resolve()
    .then(() => bootstrap.shutdown({ timeoutMs: 5000 }))
    .catch((err) => logger.error('[Main] Erro no encerramento:', { message: err && err.message }))
    .finally(() => { clearTimeout(hardTimer); finish(); });
});
