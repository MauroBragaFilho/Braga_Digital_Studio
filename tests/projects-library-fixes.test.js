'use strict';
// Correções de Projetos/Biblioteca (RK-018, 015, 033, 038, 039, 045, 084): banco sql.js em memória/temporário,
// SequenceBuilder, PremiereExporter._pathUrl, sanitização de saída e importBdspro atômico.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-projlib-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');
const dbm = require('../src/core/database/database');
const { runMigrations } = require('../src/core/database/migrations');
const ps = require('../src/core/projects/ProjectService'); // singleton
const SequenceBuilder = require('../src/core/projects/SequenceBuilder');
const PremiereExporter = require('../src/core/projects/PremiereExporter');
const BdsproPackageService = require('../src/core/projects/BdsproPackageService');
const LQS = require('../src/core/library/LibraryQueryService');
const SearchQueryParser = require('../src/core/library/SearchQueryParser');
const { countMediaLinks, countLibraryLinks, countAllLinks, describeLinks } = require('../src/core/library/mediaLinks');
const { sanitizeFileName, buildOutputPath } = require('../src/core/projects/outputPath');

let db;
const mediaIds = {};

function addMedia(uuid, filename, extra = {}) {
  const info = db.prepare("INSERT INTO media (uuid, filename, filepath, filesize, status, missing, library_id) VALUES (?,?,?,?, 'READY', 0, ?)")
    .run(uuid, filename, `C:/m/${filename}`, 1000, extra.library_id || null);
  mediaIds[filename] = info.lastInsertRowid;
  return info.lastInsertRowid;
}

test.before(async () => {
  await dbm.init(path.join(tmpRoot, 'data'));
  runMigrations();
  db = dbm.get();
  addMedia('u1', 'passeio.mp4');
  addMedia('u2', 'predio centro.mp4');
  addMedia('u3', 'trilha.mp3');
  addMedia('u4', 'foto praia.jpg');
  addMedia('u5', 'foto predio.jpg');
});

test.after(() => { try { dbm.close(); } catch (_) {} fs.rmSync(tmpRoot, { recursive: true, force: true }); });

test('RK-018: excluir projeto depois de adicionar mídia da Biblioteca não falha por FOREIGN KEY', () => {
  const pid = ps.createProject({ name: 'P1' });
  const added = ps.addMediaBulkToProject(pid, null, [mediaIds['passeio.mp4'], mediaIds['trilha.mp3']]);
  assert.strictEqual(added, 2);
  assert.strictEqual(db.prepare('SELECT project_id FROM media WHERE id = ?').get(mediaIds['passeio.mp4']).project_id, pid);
  assert.strictEqual(ps.deleteProject(pid), true);
  assert.strictEqual(db.prepare('SELECT project_id FROM media WHERE id = ?').get(mediaIds['passeio.mp4']).project_id, null);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM project_media WHERE project_id = ?').get(pid).n, 0);
  assert.ok(db.prepare('SELECT id FROM media WHERE id = ?').get(mediaIds['passeio.mp4']), 'a mídia da Biblioteca permanece');
});

test('RK-084: addMediaToBin não duplica o vínculo (project_id, media_id)', () => {
  const pid = ps.createProject({ name: 'P2' });
  const a = ps.addMediaToBin(pid, null, mediaIds['passeio.mp4']);
  const b = ps.addMediaToBin(pid, null, mediaIds['passeio.mp4']);
  assert.strictEqual(a, b);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM project_media WHERE project_id = ?').get(pid).n, 1);
});

test('RK-015: contagem de vínculos por mídia, biblioteca e total, e texto do diálogo', () => {
  const lib = db.prepare("INSERT INTO libraries (name, type, path) VALUES ('Fonte X', 'Fonte X', 'C:/x')").run().lastInsertRowid;
  const mid = addMedia('u6', 'da fonte.mp4', { library_id: lib });
  const pid = ps.createProject({ name: 'Projeto Vinculado' });
  ps.addMediaToBin(pid, null, mid);
  ps.addMediaToBin(pid, null, mediaIds['trilha.mp3']);

  const r = countMediaLinks(db, [mid, mediaIds['trilha.mp3'], mediaIds['foto praia.jpg']]);
  assert.strictEqual(r.links, 2);
  assert.deepStrictEqual(r.projects, ['Projeto Vinculado']);
  assert.strictEqual(countLibraryLinks(db, lib, 'Fonte X').links, 1);
  assert.ok(countAllLinks(db).links >= 2);
  assert.match(describeLinks(r), /2 vínculos de projeto em 1 projeto \(Projeto Vinculado\)/);
  assert.strictEqual(describeLinks({ links: 0, projects: [] }), '');
  assert.strictEqual(countMediaLinks(db, []).links, 0);
});

test('RK-045: busca só por palavra de tipo devolve mídias do tipo; termos restantes combinam com AND', () => {
  const only = (q) => LQS.searchMedia({ query: q, limit: 100 }).items.map((m) => m.filename).sort();
  assert.deepStrictEqual(only('vídeos'), ['da fonte.mp4', 'passeio.mp4', 'predio centro.mp4']);
  assert.deepStrictEqual(only('fotos'), ['foto praia.jpg', 'foto predio.jpg']);
  assert.deepStrictEqual(only('áudio'), ['trilha.mp3']);
  assert.deepStrictEqual(only('fotos prédio'), ['foto predio.jpg']);
  assert.deepStrictEqual(only('vídeo praia'), []);
  const p = SearchQueryParser.parse('vídeos');
  assert.deepStrictEqual(p.termGroups, []);
  assert.deepStrictEqual(p.types, ['video']);
});

function fakeProjectService(media, groups) {
  return {
    getProjectById: () => ({ id: 1, name: 'Proj' }),
    getProjectMedia: () => media,
    getSyncGroups: () => groups
  };
}

test('RK-033: offsets negativos deslocam a linha do tempo em vez de truncar em 0', () => {
  const media = [
    { id: 1, pm_id: 11, filename: 'cam.mp4', filepath: 'C:/cam.mp4', video_codec: 'h264', media_type: 'video', duration: 10, fps: 25 },
    { id: 2, pm_id: 12, filename: 'rec.wav', filepath: 'C:/rec.wav', media_type: 'audio', duration: 12, fps: 0 }
  ];
  const groups = [{ name: 'G', items: [{ media_id: 1, offset_seconds: 0 }, { media_id: 2, offset_seconds: -2.5 }] }];
  const m = new SequenceBuilder(fakeProjectService(media, groups)).buildSequenceModel(1);
  assert.strictEqual(m.offsetShift, 2.5);
  assert.strictEqual(m.audioTracks[0].clips[0].start, 0);
  assert.strictEqual(m.videoTracks[0].clips[0].start, 2.5);
  assert.strictEqual(m.duration, 12.5);
});

test('SequenceBuilder: foto/RAW não entram como áudio; classificação por media_type', () => {
  const media = [
    { id: 1, pm_id: 1, filename: 'a.jpg', filepath: 'C:/a.jpg', media_type: 'photo' },
    { id: 2, pm_id: 2, filename: 'b.mp3', filepath: 'C:/b.mp3', media_type: 'audio', duration: 3 }
  ];
  const m = new SequenceBuilder(fakeProjectService(media, [])).buildSequenceModel(1);
  assert.strictEqual(m.videoTracks.length, 0);
  assert.strictEqual(m.audioTracks.length, 1);
  assert.strictEqual(m.offsetShift, 0);
});

test('RK-038: pathurl codifica cada segmento e o XML da sequência usa o fps do clipe', () => {
  const ex = new PremiereExporter({}, null);
  assert.strictEqual(ex._pathUrl('C:\\Vídeos\\take #1 100%.mp4'), 'file://localhost/C:/V%C3%ADdeos/take%20%231%20100%25.mp4');
  assert.strictEqual(ex._pathUrl('\\\\srv\\share\\a b.mp4'), 'file://localhost//srv/share/a%20b.mp4');
  const xml = ex._buildClipItemXml({ media_id: 1, filename: 'x.mp4', filepath: 'C:/x.mp4', start: 1, duration: 2, in: 0, fps: 25 }, 30, false, '1-0');
  assert.match(xml, /<timebase>25<\/timebase>/);
  assert.match(xml, /<start>30<\/start>/);
  assert.match(xml, /<end>90<\/end>/);
  assert.match(xml, /<duration>50<\/duration>/);
});

test('RK-039: nome de saída sanitizado e path.join no processo principal', () => {
  assert.strictEqual(sanitizeFileName('Cliente: A/B?'), 'Cliente_ A_B_');
  assert.strictEqual(sanitizeFileName('  ..  '), 'Projeto');
  assert.strictEqual(sanitizeFileName('CON'), '_CON');
  assert.strictEqual(sanitizeFileName(''), 'Projeto');
  assert.ok(sanitizeFileName('x'.repeat(300)).length <= 120);
  const out = buildOutputPath({ folder: path.join(tmpRoot, 'out'), name: 'Meu <Projeto>', suffix: ' - Pastas' }, '.xml');
  assert.strictEqual(out, path.join(tmpRoot, 'out', 'Meu _Projeto_ - Pastas.xml'));
  assert.strictEqual(buildOutputPath('C:\\x\\y.xml', '.xml'), 'C:\\x\\y.xml');
  assert.throws(() => buildOutputPath({ name: 'x' }, '.xml'), /inválido/);
});

test('RK-084: importBdspro é atômico (falha no meio não deixa projeto parcial)', async () => {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(JSON.stringify({
    metadata: { name: 'Importado' },
    folders: [{ id: 1, name: 'Pasta', parent_id: null }],
    media: [{ id: 1, uuid: 'imp-1', filename: 'i.mp4', original_path: 'C:/m/i.mp4', bin_id: 1 }],
    syncGroups: [{ name: 'SG', master_media_id: 1, items: [{ media_id: 1, offset_seconds: 1 }] }]
  }), 'utf8'));
  const pkg = path.join(tmpRoot, 'a.bdspro');
  zip.writeZip(pkg);

  const svc = new BdsproPackageService(ps);
  const before = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  const original = ps.createSyncGroup;
  ps.createSyncGroup = () => { throw new Error('falha simulada'); };
  await assert.rejects(() => svc.importBdspro(pkg, {}, '', ''), /falha simulada/);
  ps.createSyncGroup = original;
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, before);

  const ok = await svc.importBdspro(pkg, {}, '', '');
  assert.strictEqual(ok.success, true);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, before + 1);
  // Reimportar o mesmo pacote reaproveita a mídia (uuid) em vez de abortar por UNIQUE
  const again = await svc.importBdspro(pkg, {}, '', '');
  assert.strictEqual(again.success, true);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM media WHERE uuid = 'imp-1'").get().n, 1);
});
