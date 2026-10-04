'use strict';

// [PERF] Diagnóstico de inicialização (no-op sem BDS_PERF=1). Primeiro require: mede tudo que vem depois.
const perf = require('./src/infrastructure/diagnostics/startupPerf');

const { app, BrowserWindow, nativeImage, protocol, net, screen, session, shell, dialog } = require('electron');
const path = require('node:path');


const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { resolveThumbRequest } = require('./src/ipc/thumbProtocol');
const { assertExternalUrl } = require('./src/ipc/validate');
perf.mark('main:electron-and-ipc-required');

// Identifica o app para o Windows — necessário para que notificações nativas
// (new Notification()) apareçam, especialmente em modo desenvolvimento (npm start),
// onde o app não tem AppUserModelID definido pelo electron-builder em produção.
app.setAppUserModelId('com.bragadev.digitalstudio');

// Configurações de inicialização do Electron
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// [FASE 1.1] Debug remoto: opt-in explícito e SOMENTE em desenvolvimento (nunca empacotado).
// Uso: BDS_DEBUG_PORT=8315 npm start   (escuta apenas em 127.0.0.1)
const debugPort = process.env.BDS_DEBUG_PORT;
if (!app.isPackaged && debugPort && /^\d{2,5}$/.test(debugPort) && Number(debugPort) <= 65535) {
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}

// Instância única: duas instâncias carregariam o banco inteiro em memória e a última a gravar venceria.
// A segunda instância apenas foca a janela da primeira e sai antes de tocar em qualquer dado.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

// Modo de componentes do instalador (--setup-components=basic|full): sem janela, só baixa e confere os
// componentes e sai com um código (ver src/setup/ComponentsSetup.js). null = abertura normal do app.
const setupArgs = require('./src/setup/setupArgs').parseSetupArgs(process.argv);
if (!gotSingleInstanceLock) {
  app.exit(setupArgs ? 4 : 0); // 4 = o app já está aberto (o instalador deixa para a primeira abertura)
}

const { appPaths } = require('./src/infrastructure/filesystem/AppPaths');

// Inicialização dos caminhos e ambiente gravável
const isPackaged = app.isPackaged;
const appRoot = isPackaged ? process.resourcesPath : __dirname;
const writableRoot = isPackaged ? app.getPath('userData') : __dirname;

appPaths.init(writableRoot, appRoot);
appPaths.ensureDirectories();
process.env.BMD_LOGS_DIR = appPaths.logsDir;
perf.setOutputDir(appPaths.logsDir);
perf.mark('main:paths-ready');

// [PERF] O núcleo do app (Bootstrap, serviços, logger, telemetria) só é carregado DEPOIS de a janela existir:
// o Chromium sobe o renderer em paralelo com esse carregamento (ver whenReady e o portão em renderer/boot-gate.js).
let bootstrap = null;
let mainWindow = null;

/** Cede o processo principal ao Chromium (navegação do renderer, IPC) entre dois trechos síncronos. */
const yieldToChromium = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Carrega o núcleo do app (uma única vez). Chamado em whenReady, logo depois de criar a janela.
 * Os require() pesados são feitos em etapas, cedendo o processo principal ao Chromium entre elas: um único
 * trecho síncrono longo congelava a navegação do renderer (que sobe em paralelo) e atrasava a Home.
 */
async function initBootstrap() {
  if (bootstrap) return bootstrap;
  const { externalTools } = require('./src/infrastructure/external-tools/ExternalToolsManager');
  externalTools.init(appPaths.dataDir);
  await yieldToChromium();
  for (const mod of [
    './src/services/logService',                // fachada leve: o winston só carrega depois da Home (ver logService)
    './src/core/settings/SettingsManager',
    './src/bootstrap/services',                 // serviços de mídia, projetos, biblioteca
    './src/bootstrap/events',
    './src/ipc'                                 // registro dos handlers (os módulos de cada domínio carregam em registerIpcHandlers)
  ]) {
    require(mod);
    await yieldToChromium();
  }
  const Bootstrap = require('./src/bootstrap');
  bootstrap = new Bootstrap(appPaths);
  perf.mark('main:bootstrap-required');
  return bootstrap;
}

// [FASE 2.1] Tratamento de erros globais no processo principal.
// logger e errorReporter são carregados na primeira vez que são usados (winston e a telemetria
// não entram no caminho até a primeira janela).
const logger = {
  info: (...args) => require('./src/services/logService').info(...args),
  warn: (...args) => require('./src/services/logService').warn(...args),
  error: (...args) => require('./src/services/logService').error(...args)
};
const errorReporter = {
  report: (...args) => require('./src/infrastructure/telemetry/ErrorReporter').errorReporter.report(...args)
};

// Erros benignos de rede/IO que não justificam alarmar o usuário com um diálogo.
const BENIGN_ERROR_CODES = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR']);
// Erros graves: o processo pode estar instável → informa e encerra com segurança.
const FATAL_ERROR_CODES = new Set(['ERR_OUT_OF_MEMORY', 'ENOMEM', 'ERR_WORKER_OUT_OF_MEMORY']);
let fatalDialogShown = false;
let lastErrorDialogAt = 0;

function notifyUncaught(err) {
  try {
    if (!app.isReady() || setupArgs) return; // o modo do instalador nunca mostra diálogo
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

// Limite de taxa: uma tempestade de exceções (ex.: laço de EPIPE) não pode gerar milhares de linhas
// de log/relatórios por segundo. Até ERROR_BURST_LIMIT por janela de 10 s; o resto é só contado.
const ERROR_WINDOW_MS = 10000;
const ERROR_BURST_LIMIT = 5;
let errorWindowStart = 0;
let errorWindowCount = 0;
let errorSuppressed = 0;

/** @returns {boolean} true se este erro deve ser registrado/relatado agora */
function allowErrorLogging() {
  const now = Date.now();
  if (now - errorWindowStart > ERROR_WINDOW_MS) {
    if (errorSuppressed > 0) {
      logger.warn('[Main] Erros globais suprimidos pelo limite de taxa', { suppressed: errorSuppressed });
    }
    errorWindowStart = now;
    errorWindowCount = 0;
    errorSuppressed = 0;
  }
  errorWindowCount++;
  if (errorWindowCount > ERROR_BURST_LIMIT) {
    errorSuppressed++;
    return false;
  }
  return true;
}

process.on('uncaughtException', (err) => {
  if (allowErrorLogging()) {
    logger.error('[Main] Exceção não capturada:', { message: err && err.message, stack: err && err.stack });
    errorReporter.report(err, { source: 'main-process-uncaughtException' }).catch(() => {});
  }
  notifyUncaught(err);
});

process.on('unhandledRejection', (reason) => {
  if (!allowErrorLogging()) return;
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.error('[Main] Rejeição não tratada:', { message });
  errorReporter.report(reason instanceof Error ? reason : new Error(message), { source: 'main-process-unhandledRejection' }).catch(() => {});
});

/**
 * Guarda global (RK-059): TODO webContents criado (janelas de login, webviews, janelas futuras) nasce
 * com navegação restrita e sem poder abrir janelas novas. Os handlers específicos (janela principal,
 * webview do YouTube Studio, login do YouTube) são registrados depois e só restringem mais.
 */
{
  const rendererDirUrl = pathToFileURL(path.join(__dirname, 'renderer') + path.sep).toString();
  app.on('web-contents-created', (_event, contents) => {
    // Qualquer window.open/target=_blank: nunca cria janela; só links https/mailto vão ao navegador padrão.
    contents.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url);
      return { action: 'deny' };
    });
    const guard = (event, url) => {
      let parsed;
      try { parsed = new URL(url); } catch (_) { event.preventDefault(); return; }
      if (parsed.protocol === 'https:') return; // hosts permitidos são decididos pelo guarda específico de cada janela
      if (parsed.protocol === 'file:' && String(url).startsWith(rendererDirUrl)) return;
      if (url === 'about:blank') return;
      event.preventDefault(); // http:, data:, javascript:, ftp:, file: fora do renderer...
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
  });
}

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
    // Leitura direta do settings.json: só estes dois campos importam antes de a janela existir
    // (arquivo ausente/ilegível = padrão: sem posição salva).
    const settings = JSON.parse(fs.readFileSync(path.join(appPaths.configDir, 'settings.json'), 'utf8'));
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

/**
 * Grava o tamanho/posição da janela (com atraso de 1,5 s) enquanto a opção estiver ligada.
 * A gravação em disco é adiada e assíncrona (defer): arrastar/redimensionar não bloqueia o
 * processo principal. No fechamento grava na hora (e o shutdown ainda descarrega pendências).
 */
function trackWindowBounds(win) {
  let timer = null;
  const persist = (immediate = false) => {
    try {
      if (!bootstrap || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      if (!bootstrap.settingsManager.load().rememberWindowBounds) return;
      const r = win.getNormalBounds();
      bootstrap.settingsManager.save(
        { windowBounds: { x: r.x, y: r.y, width: r.width, height: r.height, maximized: win.isMaximized() } },
        { defer: !immediate }
      );
    } catch (_) { /* não impede o app de funcionar */ }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => persist(false), 1500); };
  ['resize', 'move', 'maximize', 'unmaximize'].forEach((evt) => win.on(evt, schedule));
  win.on('close', () => { clearTimeout(timer); persist(true); });
}

/**
 * Portão de inicialização do renderer. A interface (HTML/CSS/módulos) é carregada JUNTO com a abertura do
 * banco e o registro dos handlers IPC, mas o app.js só começa a executar (e a chamar IPC) quando o portão
 * abre — ver renderer/boot-gate.js. Reaplica a liberação a cada navegação (Ctrl+R em desenvolvimento,
 * recarga após queda do renderer), pois a nova página nasce com o portão fechado.
 */
const rendererGate = {
  ready: false,
  _timer: null,
  watch(win) {
    const wc = win.webContents;
    wc.on('did-start-navigation', (details) => {
      if (details && details.isMainFrame && !details.isSameDocument && this.ready) this._release(win);
    });
    wc.on('dom-ready', () => { if (this.ready) this._release(win); });
  },
  open(win) {
    this.ready = true;
    this._release(win);
  },
  /** Tenta abrir o portão da página atual; repete a cada 25 ms até a página criá-lo (no máximo 30 s). */
  _release(win) {
    clearInterval(this._timer);
    const started = Date.now();
    let busy = false;
    const attempt = async () => {
      if (!win || win.isDestroyed() || Date.now() - started > 30000) { clearInterval(this._timer); return; }
      if (busy) return;
      busy = true;
      try {
        const opened = await win.webContents.executeJavaScript('Boolean(window.__bdsGate && window.__bdsGate.go())');
        if (opened) { clearInterval(this._timer); perf.mark('renderer:gate-opened'); }
      } catch (_) { /* página ainda carregando: tenta de novo */ }
      busy = false;
    };
    this._timer = setInterval(attempt, 25);
    attempt();
  }
};

/**
 * @param {Object} [opts]
 * @param {boolean} [opts.load=true] false = só cria a janela; o chamador chama loadMainWindow() depois.
 */
function createWindow({ load = true } = {}) {
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

  // Queda/travamento do renderer e desligamento forçado do Windows
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logger.error('[Main] Renderer encerrou inesperadamente:', { reason: details && details.reason, exitCode: details && details.exitCode });
    if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
    if (details && details.reason === 'clean-exit') return;
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Braga Digital Studio',
      message: 'A interface do aplicativo parou de responder e será recarregada.',
      detail: 'Seus dados estão salvos. Operações em andamento podem precisar ser reiniciadas.'
    }).catch(() => {}).finally(() => {
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); } catch (_) {}
    });
  });
  mainWindow.on('unresponsive', () => logger.warn('[Main] Janela sem resposta.'));
  mainWindow.on('responsive', () => logger.info('[Main] Janela voltou a responder.'));
  mainWindow.on('session-end', () => flushPersistenceSync('session-end'));

  perf.attachWindow(mainWindow);
  perf.mark('window:created');
  if (bootstrap) bootstrap.setMainWindow(mainWindow);
  rendererGate.watch(mainWindow);
  if (load) loadMainWindow();
}

/** Carrega a interface na janela principal (os handlers IPC já devem estar registrados). */
function loadMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  perf.mark('window:loadFile-called');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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

/** Grava de forma síncrona tudo que estiver pendente (usado quando o Windows força o encerramento). */
function flushPersistenceSync(reason) {
  try {
    logger.warn(`[Main] Gravação de emergência (${reason}).`);
    try { bootstrap.settingsManager.flush(); } catch (_) {}
    try { bootstrap.services && bootstrap.services.historyService && bootstrap.services.historyService.flush(); } catch (_) {}
    const dbManager = require('./src/core/database/database');
    if (typeof dbManager.persistSync === 'function') dbManager.persistSync();
  } catch (_) { /* nunca lançar durante o encerramento */ }
}

/** Executa o modo de componentes do instalador e devolve o código de saída (2 = parâmetros inválidos). */
async function runComponentsMode(args) {
  if (!args.ok) {
    logger.warn('[Setup] Parâmetros inválidos:', { error: args.error });
    return 2;
  }
  try {
    return await require('./src/setup/runSetupMode').runSetupMode({
      args, appPaths, appVersion: app.getVersion(), log: (m) => logger.info(`[Setup] ${m}`)
    });
  } catch (err) {
    logger.error('[Setup] Falha no modo de componentes:', { message: err && err.message, stack: err && err.stack });
    return 1;
  }
}

/** Primeira abertura: conclui a transcrição pendente do instalador e avisa com um toast discreto. */
function finishPendingSetup() {
  if (quitting || !bootstrap || !bootstrap.moduleManager) return Promise.resolve();
  const toast = (type, text) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(
          `window.bdsToast && window.bdsToast(${JSON.stringify(text)}, { type: ${JSON.stringify(type)}, duration: 9000 })`
        ).catch(() => {});
      }
    } catch (_) { /* aviso é opcional */ }
  };
  return require('./src/setup/firstRunCompletion').completePendingSetup({
    recordPath: require('./src/setup/runSetupMode').recordPathFor(appPaths),
    moduleManager: bootstrap.moduleManager,
    enableTranscription: () => {
      require('./src/setup/enableTranscription').enableTranscriptionModule(bootstrap.settingsManager);
      // o menu e a Home aparecem/somem na hora (mesmo evento do botão em Configurações > Módulos)
      const enabled = require('./src/core/modules/ModuleRegistry').resolveEnabled(bootstrap.settingsManager.load(), { isDev: !isPackaged });
      bootstrap.bridge.send('modules:changed', enabled);
    },
    notify: toast,
    log: (m) => logger.info(`[Setup] ${m}`)
  }).catch((err) => logger.warn('[Setup] Conclusão na primeira abertura falhou:', { message: err && err.message }));
}

// Segunda instância: foca a janela da primeira.
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return; // outra instância já está aberta
  if (setupArgs) { // modo do instalador: nenhuma janela, nenhum serviço do app
    const code = await runComponentsMode(setupArgs);
    try { require('./src/services/logService').flushSoon(0); } catch (_) { /* log é opcional */ }
    setTimeout(() => app.exit(code), 400); // dá tempo de o log chegar ao disco
    return;
  }
  perf.mark('app:ready');
  perf.expect(['watchers', 'reconcile', 'regen', 'discovery', 'deadline', 'cache', 'deps']);
  // Permissões negadas por padrão em toda sessão (a padrão e as de partições persist:*).
  hardenSession(session.defaultSession);
  perf.mark('main:default-session-hardened');
  hardenSession(session.fromPartition('persist:youtube_studio'));
  hardenSession(session.fromPartition('persist:youtube'));
  perf.mark('main:partitions-hardened');
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

  // [PERF] A janela (e o processo do renderer) é criada ANTES da inicialização pesada (banco,
  // serviços, handlers IPC), para que o Chromium suba em paralelo. A interface só é carregada
  // (loadFile) depois do init(), pois o renderer chama IPC logo ao abrir.
  perf.mark('main:before-createWindow');
  createWindow({ load: true });

  try {
    await yieldToChromium(); // deixa o Chromium iniciar a navegação do renderer antes do trabalho pesado
    await initBootstrap();
    bootstrap.setMainWindow(mainWindow);
    await perf.timeAsync('bootstrap:init', () => bootstrap.init());
  } catch (err) {
    logger.error('[Main] Falha na inicialização:', { message: err.message, stack: err.stack });
    dialog.showErrorBox('Braga Digital Studio', `Não foi possível iniciar o aplicativo.\n\n${err.message}\n\nDetalhes foram gravados no log.`);
    app.exit(1);
    return;
  }
  rendererGate.open(mainWindow);
  // [PERF] O winston só é carregado agora (depois da Home liberada); as linhas de log da abertura estão na fila.
  try { require('./src/services/logService').flushSoon(1200); } catch (_) { /* log é opcional na abertura */ }

  // Serviços de segundo plano (watchers, descoberta de dispositivos, prazos, limpeza de cache): começam
  // logo DEPOIS de a Home ser liberada e pintada, uma etapa por vez (ver src/bootstrap/startup.js).
  setTimeout(() => {
    if (!quitting) bootstrap.startBackgroundServices().catch((err) => logger.error('[Main] Serviços em segundo plano:', { message: err && err.message }));
  }, 400);

  // Verificação em background de ferramentas/atualizações (sem rede no caminho crítico da abertura)
  // Depois disso, conclui a transcrição que o instalador não conseguiu baixar (se for o caso; ver src/setup/firstRunCompletion.js).
  setTimeout(() => {
    if (quitting) return;
    Promise.resolve(bootstrap.checkInitialDependencies()).catch(() => {}).then(() => finishPendingSetup());
  }, 1000);

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
  perf.flushSync();

  const finish = () => {
    if (shutdownComplete) return;
    shutdownComplete = true;
    app.quit();
  };

  // Rede de segurança: mesmo que algo trave, a saída acontece em até 6,5s.
  const hardTimer = setTimeout(() => {
    logger.warn('[Main] Encerramento excedeu o prazo; forçando saída.');
    flushPersistenceSync('shutdown-timeout');
    finish();
  }, 6500);

  Promise.resolve()
    .then(() => (bootstrap ? bootstrap.shutdown({ timeoutMs: 5000 }) : undefined))
    .catch((err) => logger.error('[Main] Erro no encerramento:', { message: err && err.message }))
    .finally(() => { clearTimeout(hardTimer); finish(); });
});
