'use strict';
// Biblioteca/mídia/projetos (RK-019, 036, 047, 083, 084, 088, 097): varredura de arquivos novos, resolução-mestre
// de waveform, teto de cache de previews, hash amostrado desambiguado, marcadores do .bdspro e correlação assíncrona.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-libmedia-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');
const dbm = require('../src/core/database/database');
const { runMigrations } = require('../src/core/database/migrations');
const ps = require('../src/core/projects/ProjectService');
const BdsproPackageService = require('../src/core/projects/BdsproPackageService');
const LibraryWatcherService = require('../src/core/library/LibraryWatcherService');
const WaveformService = require('../src/core/projects/WaveformService');
const AudioSyncService = require('../src/core/projects/AudioSyncService');
const CacheService = require('../src/core/CacheService');
const { ingestFile } = require('../src/core/media/MediaIngest');
const { libraryTypeOf } = require('../src/core/media/MediaTypes');

let db;
test.before(async () => {
  await dbm.init(path.join(tmpRoot, 'data'));
  runMigrations();
  db = dbm.get();
});
test.after(() => { try { dbm.close(); } catch (_) {} fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const touch = (p, content = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

test('RK-019: indexNewFiles enfileira só os caminhos ausentes do banco (arquivos criados com o app fechado)', async () => {
  const root = path.join(tmpRoot, 'lib1');
  touch(path.join(root, 'ja-indexado.mp4'));
  touch(path.join(root, 'novo.mp4'));
  touch(path.join(root, 'sub', 'novo-audio.mp3'));
  touch(path.join(root, 'sub', 'ignorado.txt'));
  touch(path.join(root, '.oculta', 'escondido.mp4'));
  const libId = db.prepare("INSERT INTO libraries (name, type, path) VALUES ('Lib1', 'OBS', ?)").run(root).lastInsertRowid;
  db.prepare("INSERT INTO media (uuid, filename, filepath, status, library_id) VALUES ('idx1', 'ja-indexado.mp4', ?, 'READY', ?)")
    .run(path.join(root, 'ja-indexado.mp4'), libId);
  // Biblioteca com raiz inexistente (disco desconectado) é ignorada sem erro
  db.prepare("INSERT INTO libraries (name, type, path) VALUES ('Offline', 'OBS', ?)").run(path.join(tmpRoot, 'nao-existe'));

  const added = [];
  const queue = { add: (item) => added.push(item), getProgress: () => ({ pending: 0 }) };
  const svc = new LibraryWatcherService(queue);
  const n = await svc.indexNewFiles();
  svc.stopAll();

  assert.strictEqual(n, 2);
  const names = added.map((i) => path.basename(i.path)).sort();
  assert.deepStrictEqual(names, ['novo-audio.mp3', 'novo.mp4']);
  assert.ok(added.every((i) => i.libraryId === libId && i.event === 'CREATE'));
});

test('RK-019: uma nova varredura (ou stopAll) interrompe a anterior', async () => {
  const root = path.join(tmpRoot, 'lib2');
  for (let i = 0; i < 350; i++) touch(path.join(root, `v${i}.mp4`));
  db.prepare("INSERT INTO libraries (name, type, path) VALUES ('Lib2', 'OBS', ?)").run(root);
  const added = [];
  const svc = new LibraryWatcherService({ add: (item) => added.push(item), getProgress: () => ({ pending: 0 }) });
  const p = svc.indexNewFiles();
  setImmediate(() => svc.stopAll());
  await p;
  assert.ok(added.length < 350 + 2, 'não passou do total');
  const total = await new LibraryWatcherService({ add: () => {}, getProgress: () => ({ pending: 0 }) }).indexNewFiles();
  assert.ok(total >= 350, 'varredura completa enfileira todos');
});

test('RK-036: reducePeaks faz max-pooling e a resolução-mestre atende várias taxas com uma só geração', async () => {
  const q = Uint8Array.from([1, 9, 3, 4, 8, 2, 7, 6, 5, 0]);
  assert.deepStrictEqual([...WaveformService.reducePeaks(q, 100, 50)], [9, 4, 8, 7, 5]);
  assert.strictEqual(WaveformService.reducePeaks(q, 100, 200), q, 'não amplia');
  const odd = WaveformService.reducePeaks(Uint8Array.from({ length: 100 }, (_, i) => i), 100, 60);
  assert.strictEqual(odd.length, 60);
  assert.strictEqual(odd[59], 99);

  const svc = new WaveformService({ ffmpegPath: 'x', cacheDir: path.join(tmpRoot, 'wf') });
  let calls = 0;
  svc._extractPeaks = async (file, pps) => { calls++; assert.strictEqual(pps, 100); return Uint8Array.from({ length: 300 }, (_, i) => i % 256); };
  const [a, b] = await Promise.all([
    svc.getOrGenerate({ uuid: 'w1', filePath: 'f', peaksPerSecond: 60 }),
    svc.getOrGenerate({ uuid: 'w1', filePath: 'f', peaksPerSecond: 40 }),
  ]);
  assert.strictEqual(calls, 1, 'duas resoluções simultâneas = uma geração (chave inclui a resolução-mestre)');
  assert.strictEqual(a.peaks_per_second, 60);
  assert.strictEqual(b.peaks_per_second, 40);
  assert.strictEqual(a.peaks.length, 180);
  assert.strictEqual(b.peaks.length, 120);
  const c = await svc.getOrGenerate({ uuid: 'w1', filePath: 'f', peaksPerSecond: 30 });
  assert.strictEqual(calls, 1, 'outra tela, outra resolução: sai do cache sem rodar o ffmpeg');
  assert.strictEqual(c.peaks_per_second, 30);
  const d = await svc.getOrGenerate({ uuid: 'w1', filePath: 'f', peaksPerSecond: 100 });
  assert.strictEqual(d.peaks.length, 300);
  assert.strictEqual(calls, 1);
});

test('RK-047: CacheService inclui os previews de foto e aplica o teto próprio (LRU)', () => {
  const dataDir = path.join(tmpRoot, 'cdata');
  const previews = path.join(dataDir, 'cache', 'previews');
  fs.mkdirSync(previews, { recursive: true });
  const old = Date.now() - 100000;
  for (let i = 0; i < 4; i++) {
    const f = path.join(previews, `p${i}.jpg`);
    fs.writeFileSync(f, Buffer.alloc(600 * 1024));
    const t = new Date(old + i * 1000);
    fs.utimesSync(f, t, t);
  }
  const svc = new CacheService({ dataDir, thumbnailsDir: path.join(dataDir, 't'), waveformsDir: path.join(dataDir, 'w'), tempDir: path.join(dataDir, 'tmp') },
    { autoClean: true, maxSizeMB: 0, previewsMaxMB: 1 });
  assert.ok(svc.getCacheInfo().categories.some((c) => c.key === 'previews' && c.sizeBytes === 4 * 600 * 1024));
  const r = svc.autoCleanIfNeeded();
  assert.ok(r.trimmed);
  const left = fs.readdirSync(previews).sort();
  assert.ok(left.length <= 1, 'ficou abaixo do teto de 1 MB');
  assert.ok(!left.includes('p0.jpg'), 'os mais antigos saem primeiro');
});

test('RK-083: arquivos grandes com o mesmo hash amostrado e conteúdo diferente são indexados como distintos', async () => {
  const ffprobe = { analyze: async () => ({ duration: 1, width: 1, height: 1, fps: 30, video_codec: 'h264', audio_codec: null, audio_streams: [], bitrate: 1 }) };
  const run = (file, library = { id: null, type: 'OBS', path: null }) => ingestFile({
    db, ffprobe, library, filePath: file, generateThumbnail: async () => null
  });
  const size = 6 * 1024 * 1024;
  const a = path.join(tmpRoot, 'big-a.mp4');
  const b = path.join(tmpRoot, 'big-b.mp4');
  const c = path.join(tmpRoot, 'big-c.mp4');
  const base = Buffer.alloc(size, 7);
  fs.writeFileSync(a, base);
  // Altera um byte fora das amostras do hash (início, meio, fim), mas dentro de um bloco da impressão estendida
  const other = Buffer.from(base); other[Math.floor(((size - 16384) * 5) / 31) + 100] = 99;
  fs.writeFileSync(b, other);
  fs.writeFileSync(c, base); // cópia idêntica de a

  const ra = await run(a);
  const rb = await run(b);
  assert.notStrictEqual(ra.id, rb.id, 'b não é duplicata de a');
  const rc = await run(c);
  assert.strictEqual(rc.id, ra.id, 'cópia idêntica continua sendo duplicata');
  // Reingestão de b mantém a identidade desambiguada (sem virar duplicata de a)
  const rb2 = await run(b);
  assert.strictEqual(rb2.id, rb.id);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM media WHERE filepath IN (?, ?)').get(a, b).n, 2);
});

test('RK-084: importBdspro remapeia sequence_id e clip_id dos marcadores', async () => {
  const mid = db.prepare("INSERT INTO media (uuid, filename, filepath, status) VALUES ('mk1', 'mk.mp4', 'C:/mk/mk.mp4', 'READY')").run().lastInsertRowid;
  const pid = ps.createProject({ name: 'Marcadores' });
  const pmId = ps.addMediaToBin(pid, null, mid);
  const seq = ps.getOrCreateDefaultSequence(pid);
  const track = ps.getTracks(seq.id).find((t) => t.track_type === 'video');
  const clipId = ps.addClip(track.id, { project_media_id: pmId, media_id: mid, name: 'clip', start_time: 0, end_time: 5 });
  ps.addMarker({ project_id: pid, sequence_id: seq.id, clip_id: clipId, time: 2, label: 'no clip' });
  ps.addMarker({ project_id: pid, time: 3, label: 'solto' });

  const svc = new BdsproPackageService(ps);
  const out = path.join(tmpRoot, 'marcadores.bdspro');
  await svc.exportBdspro(pid, out, '');
  const res = await svc.importBdspro(out, {}, '', '');

  const newSeq = db.prepare('SELECT id FROM project_sequences WHERE project_id = ?').all(res.projectId);
  assert.strictEqual(newSeq.length, 1);
  const newClip = db.prepare(`SELECT c.id FROM timeline_clips c JOIN timeline_tracks t ON t.id = c.track_id WHERE t.sequence_id = ?`).get(newSeq[0].id);
  assert.ok(newClip && newClip.id !== clipId);
  const markers = db.prepare('SELECT * FROM project_markers WHERE project_id = ? ORDER BY time').all(res.projectId);
  assert.strictEqual(markers.length, 2);
  assert.strictEqual(markers[0].sequence_id, newSeq[0].id, 'sequence_id aponta para a sequência nova');
  assert.strictEqual(markers[0].clip_id, newClip.id, 'clip_id aponta para o clip novo');
  assert.strictEqual(markers[1].sequence_id, null);
  assert.strictEqual(markers[1].clip_id, null);
});

test('RK-088: GIF/BMP/TIFF/SVG são fotos (MediaTypes é a fonte única, com migração 13)', () => {
  for (const ext of ['gif', 'bmp', 'tiff', 'svg', 'heic', 'jpg']) assert.strictEqual(libraryTypeOf(`x.${ext}`), 'photo', ext);
  assert.ok(db.prepare('SELECT 1 x FROM schema_migrations WHERE version = 13').get(), 'migração 13 registrada');
  const id = db.prepare("INSERT INTO media (uuid, filename, filepath, status) VALUES ('g1', 'anim.gif', 'C:/g/anim.gif', 'READY')").run().lastInsertRowid;
  assert.strictEqual(db.prepare('SELECT media_type t FROM media WHERE id = ?').get(id).t, 'photo');
});

test('RK-097: correlação assíncrona dá o mesmo resultado e a janela de busca tem teto', async () => {
  const svc = new AudioSyncService({ ffmpegPath: 'x' });
  const master = Float32Array.from({ length: 4000 }, (_, i) => Math.abs(Math.sin(i / 9)) * (1 + ((i * 7919) % 13) / 13));
  const target = master.subarray(150);
  const sync = svc.crossCorrelate(master, target, 10);
  const asyncRes = await svc.crossCorrelateAsync(master, target, 10);
  assert.deepStrictEqual(asyncRes, sync);
  assert.strictEqual(sync.offsetSeconds, 3);
  const full = await svc.syncWithDriftCorrectionAsync(master, target, 10);
  assert.strictEqual(full.offsetSeconds, 3);
  // Janela absurda é limitada (120 s): mesmo resultado que pedir 120 s, sem travar nem lançar
  assert.deepStrictEqual(svc.crossCorrelate(master, target, 1e9), svc.crossCorrelate(master, target, 120));
});
