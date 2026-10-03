'use strict';
// ProjectService (clips em lote, addMediaBulk), MediaScanner, MediaTypes (cache de diretório),
// MediaImporter.importLibrary (pool) e ThumbnailRegenService (atalho de startup).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-perfdb-proj-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');
const dbm = require('../src/core/database/database');
const { runMigrations } = require('../src/core/database/migrations');
const projectService = require('../src/core/projects/ProjectService');
const MediaScanner = require('../src/core/media/MediaScanner');
const MediaTypes = require('../src/core/media/MediaTypes');
const MediaImporter = require('../src/core/media/MediaImporter');

test.before(async () => {
  await dbm.init(path.join(tmpRoot, 'data'));
  runMigrations();
});
test.after(() => { try { dbm.close(); } catch (_) {} fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const touch = (p, content = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

test('getClipsByTrackIds agrupa por trilha, ordena por start_time e getProjectFullModel o usa', () => {
  const db = dbm.get();
  const pid = projectService.createProject({ name: 'P' });
  const seq = projectService.getOrCreateDefaultSequence(pid);
  const tracks = projectService.getTracks(seq.id);
  const v1 = tracks.find(t => t.track_type === 'video');
  const a1 = tracks.find(t => t.track_type === 'audio');
  const v2 = projectService.createTrack(seq.id, 'video', 2);
  const mid = db.prepare("INSERT INTO media (uuid, filename, filepath, status) VALUES ('mm', 'a.mp4', 'C:/a.mp4', 'READY')").run().lastInsertRowid;
  projectService.addClip(v1.id, { media_id: mid, start_time: 5, end_time: 8 });
  projectService.addClip(v1.id, { media_id: mid, start_time: 1, end_time: 2 });
  projectService.addClip(v2, { media_id: mid, start_time: 0, end_time: 3 });

  const map = projectService.getClipsByTrackIds([v1.id, a1.id, v2]);
  assert.deepStrictEqual(map.get(v1.id).map(c => c.start_time), [1, 5]);
  assert.deepStrictEqual(map.get(a1.id), []);
  assert.strictEqual(map.get(v2).length, 1);
  assert.deepStrictEqual(map.get(v1.id), projectService.getClips(v1.id), 'idêntico a getClips por trilha');
  assert.strictEqual(map.get(v1.id)[0].filename, 'a.mp4');
  assert.strictEqual(projectService.getClipsByTrackIds([]).size, 0);

  const model = projectService.getProjectFullModel(pid);
  assert.strictEqual(model.sequence.video_tracks.length, 2);
  assert.deepStrictEqual(model.sequence.video_tracks.find(t => t.id === v1.id).clips.map(c => c.start_time), [1, 5]);
  assert.deepStrictEqual(model.sequence.audio_tracks[0].clips, []);
});

test('addMediaBulkToProject: conta só novos, duplicados na lista contam uma vez, atualiza bin dos existentes', () => {
  const db = dbm.get();
  const pid = projectService.createProject({ name: 'Bulk' });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(db.prepare("INSERT INTO media (uuid, filename, filepath, status) VALUES (?, ?, ?, 'READY')").run('b' + i, `b${i}.mp4`, `C:/b${i}.mp4`).lastInsertRowid);
  }
  assert.strictEqual(projectService.addMediaBulkToProject(pid, null, [ids[0], ids[1], ids[1], ids[2]]), 3);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM project_media WHERE project_id = ?').get(pid).c, 3);
  assert.strictEqual(db.prepare('SELECT project_id p FROM media WHERE id = ?').get(ids[0]).p, pid);
  // Repetir: só o novo conta; com bin, move os existentes
  const binId = db.prepare("INSERT INTO project_bins (project_id, name) VALUES (?, 'B')").run(pid).lastInsertRowid;
  assert.strictEqual(projectService.addMediaBulkToProject(pid, binId, [ids[0], ids[3]]), 1);
  assert.strictEqual(db.prepare('SELECT bin_id b FROM project_media WHERE project_id = ? AND media_id = ?').get(pid, ids[0]).b, binId);
  assert.strictEqual(projectService.addMediaBulkToProject(pid, null, []), 0);
  // Falha no meio (bin inexistente com foreign_keys ON) reverte a transação inteira
  assert.throws(() => projectService.addMediaBulkToProject(pid, 999999, [ids[4]]));
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM project_media WHERE project_id = ? AND media_id = ?').get(pid, ids[4]).c, 0);
});

test('MediaScanner: um passe recursivo, ignora ocultas, RAW tem prioridade sobre JPG do mesmo nome', async () => {
  const root = path.join(tmpRoot, 'scan');
  touch(path.join(root, 'a', 'IMG_1.ARW')); touch(path.join(root, 'a', 'IMG_1.JPG')); touch(path.join(root, 'a', 'IMG_2.jpg'));
  touch(path.join(root, 'a', 'b', 'c', 'v.mp4')); touch(path.join(root, '.oculta', 'x.mp4')); touch(path.join(root, 'leia.txt'));
  touch(path.join(root, 'z', 'IMG_1.jpg')); // mesmo nome em OUTRA pasta: não é duplicata
  const files = (await MediaScanner.scanDirectory(root)).map(f => path.relative(root, f).split(path.sep).join('/')).sort();
  assert.deepStrictEqual(files, ['a/IMG_1.ARW', 'a/IMG_2.jpg', 'a/b/c/v.mp4', 'z/IMG_1.jpg']);
  assert.deepStrictEqual(await MediaScanner.scanDirectory(path.join(tmpRoot, 'nao-existe')), []);
});

test('findSiblingJpg/findSiblingRaw usam cache de listagem por diretório (TTL) e são invalidáveis', () => {
  const dir = path.join(tmpRoot, 'sib');
  touch(path.join(dir, 'DSC1.ARW'));
  MediaTypes.invalidateDirCache();
  assert.strictEqual(MediaTypes.findSiblingJpg(path.join(dir, 'DSC1.ARW')), null);
  touch(path.join(dir, 'dsc1.jpg')); // criado depois da listagem em cache
  assert.strictEqual(MediaTypes.findSiblingJpg(path.join(dir, 'DSC1.ARW')), null, 'cache ainda vale');
  MediaTypes.invalidateDirCache(dir);
  assert.strictEqual(path.basename(MediaTypes.findSiblingJpg(path.join(dir, 'DSC1.ARW'))), 'dsc1.jpg');
  assert.strictEqual(path.basename(MediaTypes.findSiblingRaw(path.join(dir, 'dsc1.jpg'))), 'DSC1.ARW');
  assert.strictEqual(MediaTypes.findSiblingRaw(path.join(tmpRoot, 'inexistente', 'x.jpg')), null);
});

test('importLibrary: pool de até 3 workers, importa todos, preenche media_type e mantém o contrato de importFile', async () => {
  const lib = path.join(tmpRoot, 'lib');
  for (let i = 0; i < 8; i++) touch(path.join(lib, 'sub' + (i % 2), `clip${i}.mp4`), 'conteudo-' + i);
  touch(path.join(lib, 'foto.jpg'), 'f'); touch(path.join(lib, 'som.mp3'), 's');

  const imp = new MediaImporter({ ffprobePath: 'nao-usado' });
  let ativos = 0, maxAtivos = 0;
  imp.ffprobe = { analyze: async () => {
    ativos++; maxAtivos = Math.max(maxAtivos, ativos);
    await new Promise(r => setTimeout(r, 25));
    ativos--;
    return { duration: 1, width: 1920, height: 1080, fps: 30, video_codec: 'h264', audio_codec: 'aac', bitrate: 1, filesize: 10, creation_time: '2026-04-01T00:00:00.000Z' };
  } };
  imp._generateThumbnail = async (fp, fn, uuid) => `${uuid}.jpg`;

  const db = dbm.get();
  const libId = db.prepare("INSERT INTO libraries (name, type, path) VALUES ('L', 'OBS', ?)").run(lib).lastInsertRowid;
  await imp.importLibrary({ id: libId, name: 'L', type: 'OBS', path: lib });
  assert.ok(maxAtivos > 1 && maxAtivos <= 3, `concorrência observada: ${maxAtivos}`);
  const rows = db.prepare('SELECT filename, status, media_type, sort_date, recorded_at FROM media WHERE library_id = ?').all(libId);
  assert.strictEqual(rows.length, 10);
  assert.ok(rows.every(r => r.status === 'READY'));
  assert.strictEqual(rows.filter(r => r.media_type === 'video').length, 8);
  assert.strictEqual(rows.find(r => r.filename === 'foto.jpg').media_type, 'photo');
  assert.strictEqual(rows.find(r => r.filename === 'som.mp3').media_type, 'audio');
  assert.ok(rows.every(r => r.sort_date === r.recorded_at));

  // Reimportar: sem novos registros; contrato { id, created }
  const again = await imp.importFile({ id: libId, name: 'L', type: 'OBS', path: lib }, path.join(lib, 'foto.jpg'));
  assert.deepStrictEqual(Object.keys(again).sort(), ['created', 'id']);
  assert.strictEqual(again.created, false);
  const nova = path.join(lib, 'nova.mp4'); touch(nova, 'inteiramente-nova');
  const r2 = await imp.importFile({ id: libId, name: 'L', type: 'OBS', path: lib }, nova);
  assert.strictEqual(r2.created, true);
  assert.ok(Number.isInteger(r2.id));
});

test('ThumbnailRegenService: atalho de startup quando a pasta tem miniaturas suficientes', async () => {
  const { regenerateMissingThumbnails } = require('../src/core/library/ThumbnailRegenService');
  // ffmpeg não é necessário: o atalho retorna antes e, no caminho completo, a geração falha e conta como falha
  require('../src/infrastructure/external-tools/adapters/FfmpegTool').ffmpegTool.resolve = () => path.join(tmpRoot, 'ffmpeg-inexistente');
  const dataDir = path.join(tmpRoot, 'regen');
  const thumbs = path.join(dataDir, 'Thumbnails');
  fs.mkdirSync(thumbs, { recursive: true });
  const db = dbm.get();
  // Todas as mídias READY não-áudio ficam com miniatura registrada e presente no disco
  const alvo = db.prepare("SELECT id, uuid FROM media WHERE status = 'READY' AND (missing = 0 OR missing IS NULL) AND (media_type IS NULL OR media_type != 'audio')").all();
  for (const r of alvo) {
    db.prepare('UPDATE media SET thumbnail = ? WHERE id = ?').run(`${r.uuid}.jpg`, r.id);
    fs.writeFileSync(path.join(thumbs, `${r.uuid}.jpg`), 'j');
  }
  const prepares = [];
  const wrapped = { get: () => { const d = dbm.get(); return { prepare: (sql) => { prepares.push(sql); return d.prepare(sql); } }; } };
  const res = await regenerateMissingThumbnails({ paths: { dataDir }, dbManager: wrapped });
  assert.deepStrictEqual(res, { regenerated: 0, failed: 0, total: 0 });
  assert.ok(!prepares.some(s => /SELECT id, uuid, filepath/.test(s)), 'não deve rodar o SELECT completo');

  // Faltando um arquivo: cai no caminho completo e detecta a ausência
  fs.rmSync(path.join(thumbs, `${alvo[0].uuid}.jpg`));
  prepares.length = 0;
  const res2 = await regenerateMissingThumbnails({ paths: { dataDir }, dbManager: wrapped, batchSize: 10 });
  assert.ok(prepares.some(s => /SELECT id, uuid, filepath/.test(s)), 'caminho completo quando há ausentes');
  assert.strictEqual(res2.total, 1);
});
