'use strict';

// Carga preguiçosa na abertura: ferramentas e chat do assistente, ModuleManager e os serviços de Montagem e
// Recuperação só nascem no primeiro uso real. Cada teste prova que a abertura (registro dos handlers, eventos,
// chamadas que o renderer faz logo ao abrir) NÃO os constrói, e que o primeiro uso de verdade funciona.

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { lazyService, isCreated } = require('../src/core/modules/lazyService');
const { createRegistry, APP_PAGE } = require('../src/ipc/channelRegistry');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bds-lazy-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const loaded = (re) => Object.keys(require.cache).some((k) => re.test(k.replace(/\\/g, '/')));

const APP_URL = pathToFileURL(APP_PAGE).href;
const APP_EVENT = { senderFrame: { url: APP_URL, parent: null }, sender: { getType: () => 'window', getURL: () => APP_URL } };

// ---------------------------------------------------------------- assistente de IA

test('assistente: registrar e ler histórico/configuração não monta o chat nem as ferramentas; o 1º uso monta', async () => {
  const registerAiHandlers = require('../src/ipc/aiHandlers');
  const ChatHistory = require('../src/services/ai/ChatHistory');
  const dir = tmpDir();
  const handlers = new Map();
  const reg = createRegistry({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, logger: { warn() {} } });
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${s}`), decryptString: (b) => b.toString().replace(/^enc:/, '') };
  try {
    // histórico já gravado numa sessão anterior
    new ChatHistory({ dir }).append({ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá!' });

    const ai = registerAiHandlers({ configDir: dir }, {
      handle: reg.handle, isDev: true, safeStorage, projectService: {}, settingsManager: { load: () => ({ enabledModules: { ai: true } }) }, broadcast: () => {}
    });
    const call = (ch, ...a) => handlers.get(ch)(APP_EVENT, ...a);

    assert.equal(isCreated(ai.assistantChat), false, 'o chat não existe depois do registro');
    assert.equal(loaded(/services\/ai\/AssistantChat\.js$/), false, 'AssistantChat não foi carregado');
    assert.equal(loaded(/services\/ai\/tools\/index\.js$/), false, 'as ferramentas não foram carregadas');

    // o que o renderer pede ao abrir
    assert.equal((await call('ai:getConfig')).ok, true);
    const hist = await call('ai:historyGet');
    assert.deepEqual(hist.data.messages.map((m) => m.content), ['oi', 'olá!']);
    assert.equal(hist.data.busy, false);
    // desligar o assistente ou trocar de servidor sem chat criado não cria o chat
    assert.equal((await call('ai:saveConfig', { assistantEnabled: false })).ok, true);
    assert.equal((await call('ai:saveConfig', { assistantEnabled: true })).ok, true);
    assert.equal(isCreated(ai.assistantChat), false);
    assert.equal(loaded(/services\/ai\/AssistantChat\.js$/), false);
    assert.equal(loaded(/services\/ai\/tools\/index\.js$/), false);

    // 1º uso de verdade (cancelar a conversa): monta o chat e o histórico continua o mesmo
    assert.equal((await call('ai:chatCancel')).ok, true);
    assert.equal(isCreated(ai.assistantChat), true);
    assert.equal(loaded(/services\/ai\/AssistantChat\.js$/), true);
    assert.deepEqual((await call('ai:historyGet')).data.messages.map((m) => m.content), ['oi', 'olá!']);
  } finally { rm(dir); }
});

// ---------------------------------------------------------------- módulos (ModuleManager)

test('módulos: modules:list diz a verdade sobre o motor sem criar o ModuleManager; o 1º uso cria', async () => {
  // electron falso só para este processo de teste (o registrador pega o ipcMain na hora de registrar)
  const handlers = new Map();
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
      shell: {}, dialog: {}, app: { isPackaged: false, getPath: () => os.tmpdir() },
      safeStorage: { isEncryptionAvailable: () => false }
    }
  };
  const dataDir = tmpDir();
  try {
    const registerModuleHandlers = require('../src/ipc/moduleHandlers');
    const manager = registerModuleHandlers({ dataDir, tempDir: path.join(dataDir, 'tmp'), configDir: path.join(dataDir, 'cfg') }, {
      settingsManager: { load: () => ({ enabledModules: { transcription: true } }), save: () => {} }, isDev: true, tasks: {}
    });
    assert.equal(isCreated(manager), false, 'registrar os handlers não cria o ModuleManager');
    assert.equal(loaded(/core\/modules\/ModuleManager\.js$/), false);

    const list = async () => (await handlers.get('modules:list')(APP_EVENT)).data.find((m) => m.id === 'transcription');
    assert.equal((await list()).installed, false, 'sem o motor no disco: não instalado');
    assert.equal(isCreated(manager), false, 'listar módulos (o renderer faz isso ao abrir) não cria o ModuleManager');
    assert.equal(loaded(/core\/modules\/ModuleManager\.js$/), false);

    // com o arquivo do motor no disco a lista passa a dizer "instalado" (antes dizia sempre "não instalado")
    const { engineFiles } = require('../src/core/modules/sources');
    const engineDir = path.join(dataDir, 'modules', 'whisper', 'engine');
    fs.mkdirSync(engineDir, { recursive: true });
    fs.writeFileSync(path.join(engineDir, engineFiles(process.platform).cli), 'x');
    assert.equal((await list()).installed, true);
    assert.equal(isCreated(manager), false);

    // 1º uso de verdade (status do módulo na tela de Transcrição): cria e liga os ouvintes
    const status = (await handlers.get('modules:getStatus')(APP_EVENT)).data;
    assert.equal(status.whisper.engine.installed, true);
    assert.equal(isCreated(manager), true);
    assert.equal(loaded(/core\/modules\/ModuleManager\.js$/), true);
    assert.ok(manager.listenerCount('progress') >= 2 && manager.listenerCount('status') >= 1, 'ouvintes ligados quando o gerenciador nasce');
  } finally { rm(dataDir); }
});

// ---------------------------------------------------------------- eventos e encerramento

/** Serviço preguiçoso que conta quantas vezes foi construído. */
function lazyEmitter() {
  const made = { n: 0 };
  const proxy = lazyService(() => { made.n++; return new EventEmitter(); });
  return { proxy, made };
}

test('eventos: Montagem e Recuperação ligam os ouvintes só quando o serviço nasce, e repassam ao renderer', () => {
  const bindMediaEvents = require('../src/bootstrap/events/media');
  const sent = [];
  const bridge = {
    send: (ch, p) => sent.push([ch, p]), reportProgressThrottled() {}, cancelThrottled() {}, sendThrottled() {}
  };
  const lazy = { montage: lazyEmitter(), video: lazyEmitter(), raw: lazyEmitter(), jpg: lazyEmitter() };
  const services = {
    montageService: lazy.montage.proxy, videoRecoveryService: lazy.video.proxy, rawRecoveryService: lazy.raw.proxy, jpgRecoveryService: lazy.jpg.proxy,
    metadataService: new EventEmitter(), updateService: new EventEmitter()
  };
  bindMediaEvents({ bridge, services });
  for (const l of Object.values(lazy)) assert.equal(l.made.n, 0, 'ligar os eventos não constrói nada');
  assert.equal(services.metadataService.listenerCount('progress'), 1, 'serviços eager continuam ligados na hora');
  assert.equal(services.updateService.listenerCount('completed'), 1);

  // criar o serviço liga os ouvintes antes do primeiro uso; os canais continuam os mesmos
  lazy.montage.proxy.emit('queue-updated', { jobs: 1 });
  lazy.video.proxy.emit('stage', { name: 'x' });
  lazy.raw.proxy.emit('finished', { ok: true });
  lazy.jpg.proxy.emit('error', { message: 'falhou' });
  assert.deepEqual(sent.map((s) => s[0]), ['montage:queue-updated', 'recovery:stage', 'recovery:raw:finished', 'recovery:jpg:error']);
  assert.deepEqual(Object.values(lazy).map((l) => l.made.n), [1, 1, 1, 1]);
});

test('encerramento: não constrói serviços preguiçosos só para cancelá-los; cancela os que já existem', async () => {
  const { runShutdown } = require('../src/bootstrap/shutdown');
  const { liveService } = require('../src/core/modules/lazyService');
  const names = ['montageService', 'videoRecoveryService', 'rawRecoveryService', 'jpgRecoveryService'];
  const lazy = Object.fromEntries(names.map((n) => [n, { made: 0, cancelled: 0 }]));
  const services = {};
  for (const n of names) {
    services[n] = lazyService(() => { lazy[n].made++; return { cancel: () => { lazy[n].cancelled++; }, cancelMontage: () => { lazy[n].cancelled++; } }; });
  }
  const manager = { made: 0 };
  const moduleManager = lazyService(() => { manager.made++; return { cancel() {} }; });
  const settingsManager = { flush() {}, load: () => ({}) };
  const ctx = () => ({ services: { ...services }, getModuleManager: () => liveService(moduleManager), settingsManager });

  await runShutdown(ctx(), { timeoutMs: 2000 });
  assert.deepEqual(names.map((n) => lazy[n].made), [0, 0, 0, 0], 'nenhum serviço foi criado pelo encerramento');
  assert.equal(manager.made, 0, 'o ModuleManager também não');

  // se o serviço já foi usado, o encerramento o cancela
  services.rawRecoveryService.cancel; // acessar uma propriedade constrói (uso real)
  assert.equal(lazy.rawRecoveryService.made, 1);
  await runShutdown(ctx(), { timeoutMs: 2000 });
  assert.equal(lazy.rawRecoveryService.cancelled, 1);
  assert.equal(lazy.montageService.cancelled, 0);
});
