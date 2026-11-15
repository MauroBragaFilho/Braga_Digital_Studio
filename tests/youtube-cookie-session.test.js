'use strict';

// Conta do YouTube nos downloads (itens F-31 e F-94 da análise de conformidade): uso OPCIONAL, o arquivo com a sessão só existe
// enquanto um download ou uma consulta de link do YouTube o usa, e é apagado quando o último processo termina. Aqui: o ciclo de vida
// do arquivo, a integração com a fila de downloads e a consulta de links, e a limpeza dos arquivos que o app gerou.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const YoutubeCookieSession = require('../src/services/youtubeCookieSession');
const CookiesService = require('../src/core/CookiesService');
const DownloadService = require('../src/services/downloadService');
const ThumbnailService = require('../src/services/thumbnailService');
const { toolRunner } = require('../src/infrastructure/external-tools/ToolRunner');
const { ytDlpTool } = require('../src/infrastructure/external-tools/adapters/YtDlpTool');

// Sem banco nos testes: a carga da fila do SQLite é desligada
DownloadService.prototype.initDatabaseQueue = function initDatabaseQueue() { this.queue = []; };

const { GENERATED_MARKER } = CookiesService;
const FUTURE = Math.floor(Date.now() / 1000) + 86400 * 30;

/** Arquivo de sessão de mentira, no mesmo formato que o app gera (com cookie de login válido). */
function writeCookieFile(file, { generated = true } = {}) {
  const head = generated ? `# Netscape HTTP Cookie File\n# This file is ${GENERATED_MARKER}\n\n` : '# Netscape HTTP Cookie File\n\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${head}.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\t__Secure-3PSID\tvalor-secreto\n`);
}

/** Sessão de teste: o "arquivo" é um de verdade, numa pasta temporária; conta quantas vezes foi criado e apagado. */
function makeSession(t, { enabled = true, exportFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-cookie-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'youtube_cookies.txt');
  const log = { exports: 0, deletes: 0 };
  const state = { enabled };
  const session = new YoutubeCookieSession({
    isEnabled: () => state.enabled,
    exportFile: async () => { log.exports++; if (exportFails) return null; writeCookieFile(file); return file; },
    deleteFile: async () => { log.deletes++; fs.rmSync(file, { force: true }); },
    deleteFileSync: () => fs.rmSync(file, { force: true }),
    purge: () => CookiesService.purgeGeneratedFiles([file]),
    inspectSession: async () => ({ valid: true, expiresAt: 1_900_000_000_000, reason: null })
  });
  return { session, file, log, state, dir };
}

// ---------------------------------------------------------------- ciclo de vida do arquivo

test('conta desligada (padrão): nenhum arquivo é criado e o estado diz "desligado"', async (t) => {
  const { session, file, log } = makeSession(t, { enabled: false });
  assert.equal(await session.acquire(), null);
  assert.equal(fs.existsSync(file), false);
  assert.equal(log.exports, 0, 'nem tenta exportar a sessão');
  assert.deepEqual(await session.status(), { enabled: false, valid: false, expiresAt: null, reason: 'desligado' });
});

test('conta ligada: o arquivo é criado ao pedir e apagado quando o último processo termina', async (t) => {
  const { session, file, log } = makeSession(t);
  assert.equal(fs.existsSync(file), false, 'antes de pedir não existe');
  const a = await session.acquire();
  assert.equal(a.file, file);
  assert.equal(fs.existsSync(file), true);

  const b = await session.acquire(); // outro processo ao mesmo tempo: reaproveita, sem reescrever o arquivo em uso
  assert.equal(b.file, file);
  assert.equal(log.exports, 1, 'o arquivo em uso não é reescrito');
  assert.equal(session.leases, 2);

  await a.release();
  assert.equal(fs.existsSync(file), true, 'ainda há um processo usando');
  await a.release(); // chamar de novo não conta duas vezes
  assert.equal(session.leases, 1);
  await b.release();
  assert.equal(session.leases, 0);
  assert.equal(fs.existsSync(file), false, 'terminou o último: o arquivo foi apagado');
  assert.equal(log.deletes, 1);

  const c = await session.acquire(); // um novo pedido cria de novo
  assert.equal(log.exports, 2);
  assert.equal(fs.existsSync(file), true);
  await c.release();
  assert.equal(fs.existsSync(file), false);
});

test('sem login (a exportação não devolve arquivo): acquire devolve null e nada fica no disco', async (t) => {
  const { session, file } = makeSession(t, { exportFails: true });
  assert.equal(await session.acquire(), null);
  assert.equal(fs.existsSync(file), false);
  assert.equal(session.leases, 0);
});

test('sair da conta (dispose) apaga na hora; o processo que ainda usa apaga de novo ao terminar', async (t) => {
  const { session, file } = makeSession(t);
  const lease = await session.acquire();
  await session.dispose();
  assert.equal(fs.existsSync(file), false);
  writeCookieFile(file); // o yt-dlp grava o arquivo de volta ao sair
  await lease.release();
  assert.equal(fs.existsSync(file), false, 'o resto que o processo gravou ao sair também é apagado');
});

test('encerramento do app (disposeSync) apaga sem esperar; ao abrir, restos do app são limpos', async (t) => {
  const { session, file } = makeSession(t);
  await session.acquire();
  session.disposeSync();
  assert.equal(fs.existsSync(file), false);

  writeCookieFile(file); // sobra de um travamento
  assert.equal(await session.purgeStale(), 1);
  assert.equal(fs.existsSync(file), false);
});

test('limpeza: só apaga arquivos que o app gerou (cabeçalho do app); um cookies.txt do usuário nunca é tocado', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-cookie-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ours = path.join(dir, 'youtube_cookies.txt');
  const theirs = path.join(dir, 'cookies.txt');
  const missing = path.join(dir, 'nao-existe.txt');
  writeCookieFile(ours);
  writeCookieFile(theirs, { generated: false });
  assert.equal(await CookiesService.purgeGeneratedFiles([ours, theirs, missing, 'relativo.txt', path.join(dir, 'x.dat'), null]), 1);
  assert.equal(fs.existsSync(ours), false);
  assert.equal(fs.existsSync(theirs), true, 'o arquivo do usuário continua lá');
});

test('operações em sequência: pedir e devolver ao mesmo tempo nunca apaga o arquivo de quem acabou de pedir', async (t) => {
  const { session, file } = makeSession(t);
  const first = await session.acquire();
  const [released, second] = await Promise.all([first.release(), session.acquire()]);
  assert.equal(released, undefined);
  assert.ok(second, 'o segundo pedido recebeu o arquivo');
  assert.equal(fs.existsSync(file), true, 'e o arquivo existe para ele usar');
  await second.release();
  assert.equal(fs.existsSync(file), false);
});

// ---------------------------------------------------------------- integração com a fila de downloads

function makeDownloadService(session, calls) {
  const svc = new DownloadService({
    paths: { dataDir: os.tmpdir() },
    getSettings: () => ({ mp3Folder: os.tmpdir(), mp4Folder: os.tmpdir() }),
    historyService: null
  });
  svc.cookieSession = session;
  svc.runProcess = async (item) => { calls.push({ url: item.url, file: svc._cookiesFile, existed: svc._cookiesFile ? fs.existsSync(svc._cookiesFile) : null }); };
  return svc;
}

test('download do YouTube com a conta ligada usa o arquivo só durante o download e o apaga em seguida', async (t) => {
  const { session, file } = makeSession(t);
  const calls = [];
  const svc = makeDownloadService(session, calls);
  const item = { url: 'https://www.youtube.com/watch?v=abc' };
  const lease = await svc._leaseCookies(item);
  assert.ok(lease);
  assert.equal(svc._cookiesFile, file);
  assert.equal(fs.existsSync(file), true);
  await lease.release();
  assert.equal(fs.existsSync(file), false);
});

test('download de outro site, ou com a conta desligada, nunca recebe o arquivo (nem cria o arquivo)', async (t) => {
  const on = makeSession(t);
  const svcOn = makeDownloadService(on.session, []);
  assert.equal(await svcOn._leaseCookies({ url: 'https://vimeo.com/123' }), null);
  assert.equal(await svcOn._leaseCookies({ url: 'https://youtube.com.evil.example/x' }), null);
  assert.equal(svcOn._cookiesFile, null);
  assert.equal(on.log.exports, 0, 'link de outro site nem pede a sessão');

  const off = makeSession(t, { enabled: false });
  const svcOff = makeDownloadService(off.session, []);
  assert.equal(await svcOff._leaseCookies({ url: 'https://www.youtube.com/watch?v=abc' }), null);
  assert.equal(svcOff._cookiesFile, null);
  assert.equal(off.log.exports, 0);
  assert.equal(fs.existsSync(off.file), false);

  const none = new DownloadService({ paths: { dataDir: os.tmpdir() }, getSettings: () => ({}), historyService: null });
  assert.equal(await none._leaseCookies({ url: 'https://www.youtube.com/watch?v=abc' }), null, 'sem o recurso ligado ao serviço');
});

test('a fila apaga o arquivo mesmo quando o download falha, e a linha da tela vem do estado da sessão (sem criar arquivo)', async (t) => {
  const { session, file, log } = makeSession(t);
  const svc = new DownloadService({ paths: { dataDir: os.tmpdir() }, getSettings: () => ({ mp3Folder: os.tmpdir(), mp4Folder: os.tmpdir() }), historyService: null });
  svc.cookieSession = session;
  svc._sleep = async () => {};
  const seen = [];
  svc.runProcess = async (item) => { seen.push(fs.existsSync(file)); item.status = 'failed'; throw new Error('quebrou'); };
  svc.findExistingFile = () => null;
  svc.saveItemToDb = () => {};
  svc.queue = [{ id: 'a', url: 'https://www.youtube.com/watch?v=abc', format: 'MP4', status: 'queued', title: 't' }];
  svc.isPaused = false;
  await svc._drainQueue();
  assert.deepEqual(seen, [true], 'durante o download o arquivo existia');
  assert.equal(fs.existsSync(file), false, 'depois da falha foi apagado');
  assert.equal(log.deletes, 1);

  const before = log.exports;
  assert.deepEqual(await svc.getCookiesStatus(), { enabled: true, valid: true, expiresAt: 1_900_000_000_000, reason: null });
  assert.equal(log.exports, before, 'consultar o estado para a tela não cria arquivo');
});

// ---------------------------------------------------------------- consulta de links (metadados)

test('consulta de link do YouTube: o arquivo vai ao yt-dlp só durante a consulta e outros sites não o recebem', async (t) => {
  const { session, file } = makeSession(t);
  const svc = new ThumbnailService({ paths: { dataDir: os.tmpdir() }, getSettings: () => ({}) });
  svc.cookieSession = session;
  const argsSeen = [];
  const originalResolve = ytDlpTool.resolve;
  ytDlpTool.resolve = () => 'yt-dlp-falso';
  toolRunner.run = async (exe, args) => { argsSeen.push({ args: [...args], existed: fs.existsSync(file) }); return { code: 0, stdout: '{}', stderr: '' }; };
  t.after(() => { delete toolRunner.run; ytDlpTool.resolve = originalResolve; }); // volta ao método da classe

  await svc.runYtDlpJson('https://www.youtube.com/watch?v=abc', ['--dump-single-json']);
  assert.equal(argsSeen[0].args.includes('--cookies'), true, 'link do YouTube com a conta ligada leva a sessão');
  assert.equal(argsSeen[0].args[argsSeen[0].args.indexOf('--cookies') + 1], file);
  assert.equal(argsSeen[0].existed, true);
  assert.equal(fs.existsSync(file), false, 'apagado ao fim da consulta');

  await svc.runYtDlpJson('https://vimeo.com/123', ['--dump-single-json']);
  assert.equal(argsSeen[1].args.includes('--cookies'), false, 'outro site nunca recebe a sessão');
  assert.equal(fs.existsSync(file), false);
});
