'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

const DownloadManager = require('../src/services/downloadService');
const { processRunner } = require('../src/infrastructure/external-tools/ProcessRunner');
const ThumbnailService = require('../src/services/thumbnailService');

// Sem banco nos testes: a carga da fila do SQLite é desligada
DownloadManager.prototype.initDatabaseQueue = function initDatabaseQueue() { this.queue = []; };

function makeManager(folder) {
  const m = new DownloadManager({
    paths: { dataDir: os.tmpdir() },
    getSettings: () => ({ mp3Folder: folder, mp4Folder: folder }),
    historyService: null
  });
  m.saveItemToDb = () => {};
  m.queue = [];
  return m;
}

function makeItem(extra = {}) {
  return {
    id: 'dl_1', url: 'https://www.youtube.com/watch?v=abc123DEF45', title: 't', format: 'MP4', quality: 'best',
    folder: os.tmpdir(), status: 'downloading', progress: 0, downloadedBytes: 0, totalBytes: 0,
    speed: '', eta: '', outputPath: '', error: '', ...extra
  };
}

test('RK-106: dedupe diferencia vídeos pelo identificador na query string', () => {
  const m = makeManager(os.tmpdir());
  assert.notEqual(m._videoKey('https://site.com/watch?id=1'), m._videoKey('https://site.com/watch?id=2'));
  assert.equal(m._videoKey('https://site.com/watch?id=1#t=5'), m._videoKey('https://site.com/watch?id=1'));
  // YouTube segue pelo ID, ignorando parâmetros de playlist
  assert.equal(
    m._videoKey('https://www.youtube.com/watch?v=abc&list=PL1'),
    m._videoKey('https://youtu.be/abc')
  );
});

test('RK-025: reconhece o destino do MP3 final ([ExtractAudio])', () => {
  const m = makeManager(os.tmpdir());
  const item = makeItem({ format: 'MP3' });
  m.handleOutput('[download] Destination: C:\\Musicas\\Faixa.webm\n', item);
  assert.equal(item.outputPath, 'C:\\Musicas\\Faixa.webm');
  m.handleOutput('[ExtractAudio] Destination: C:\\Musicas\\Faixa.mp3\n', item);
  assert.equal(item.outputPath, 'C:\\Musicas\\Faixa.mp3');
});

test('RK-025: _resolveOutputPath troca a extensão intermediária e acha o arquivo do Spotify', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-dl-'));
  try {
    const m = makeManager(dir);
    fs.writeFileSync(path.join(dir, 'Faixa.mp3'), 'x');
    const yt = makeItem({ format: 'MP3', folder: dir, outputPath: path.join(dir, 'Faixa.webm') });
    assert.equal(m._resolveOutputPath(yt), path.join(dir, 'Faixa.mp3'));

    const sp = makeItem({ format: 'MP3', isSpotify: true, folder: dir, outputPath: '', startedAt: new Date(Date.now() - 5000).toISOString() });
    assert.equal(m._resolveOutputPath(sp), path.join(dir, 'Faixa.mp3'));

    const none = makeItem({ folder: dir, outputPath: path.join(dir, 'inexistente.mp4') });
    assert.equal(m._resolveOutputPath(none), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RK-027: o yt-dlp do item recebe --no-playlist antes da URL', async () => {
  const m = makeManager(os.tmpdir());
  const { ytDlpTool } = require('../src/infrastructure/external-tools/adapters/YtDlpTool');
  const original = ytDlpTool.resolve;
  ytDlpTool.resolve = () => 'yt-dlp';
  try {
    const { args } = await m.buildCommand(makeItem({ url: 'https://www.youtube.com/watch?v=abc&list=PL1' }), m.getSettings());
    assert.ok(args.includes('--no-playlist'));
    assert.ok(args.indexOf('--no-playlist') < args.indexOf('--'));
  } finally {
    ytDlpTool.resolve = original;
  }
});

test('RK-021: PATH do processo usa path.delimiter', async () => {
  const m = makeManager(os.tmpdir());
  m.buildCommand = async () => ({ exe: 'yt-dlp', args: [] });
  let env = null;
  const origSpawn = processRunner.spawn;
  processRunner.spawn = (exe, args, opts) => {
    env = opts.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  try {
    await m.runProcess(makeItem());
    assert.ok(env.PATH.startsWith(os.tmpdir() + path.delimiter));
  } finally {
    processRunner.spawn = origSpawn;
  }
});

test('RK-105: processo morto por pausa não marca o item como failed (mesmo após start())', async () => {
  const m = makeManager(os.tmpdir());
  m.buildCommand = async () => ({ exe: 'yt-dlp', args: [] });
  let child = null;
  const origSpawn = processRunner.spawn;
  const origCancel = processRunner.cancel;
  processRunner.spawn = () => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  };
  processRunner.cancel = async () => {};
  try {
    const item = makeItem();
    m.queue = [item];
    m.currentItem = item;
    const running = m.runProcess(item);
    await new Promise((r) => setImmediate(r));
    m.currentProcess = child;
    m.isProcessing = true;
    m.pause();
    assert.equal(item.status, 'paused');
    // start() devolve o item para a fila antes de o processo antigo fechar
    item.status = 'queued';
    child.emit('close', 1);
    await running;
    assert.equal(item.status, 'queued');
  } finally {
    processRunner.spawn = origSpawn;
    processRunner.cancel = origCancel;
  }
});

test('RK-108: pause() emite downloads:paused para soltar a taskbar', () => {
  const m = makeManager(os.tmpdir());
  let fired = false;
  m.on('downloads:paused', () => { fired = true; });
  m.pause();
  assert.equal(fired, true);
});

test('RK-027: inspectPlaylist de vídeo com &list= usa --no-playlist', async () => {
  const svc = new ThumbnailService({ paths: {}, getSettings: () => ({}) });
  assert.equal(svc.isVideoWithPlaylistParam('https://www.youtube.com/watch?v=abc&list=PL1'), true);
  assert.equal(svc.isVideoWithPlaylistParam('https://www.youtube.com/playlist?list=PL1'), false);
  assert.equal(svc.isVideoWithPlaylistParam('lixo'), false);

  let capturedArgs = null;
  svc.runYtDlpJson = async (url, args) => { capturedArgs = args; return { _type: 'video', title: 'v' }; };
  const info = await svc.inspectPlaylist('https://www.youtube.com/watch?v=abc&list=PL1');
  assert.ok(capturedArgs.includes('--no-playlist'));
  assert.equal(info.isPlaylist, false);
});
