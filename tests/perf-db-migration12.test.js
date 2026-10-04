'use strict';
// Migração 12: media.media_type / media.sort_date (backfill + triggers) e índices de desempenho.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-perfdb-mig-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');
const dbm = require('../src/core/database/database');
const { runMigrations } = require('../src/core/database/migrations');
const { libraryTypeOf } = require('../src/core/media/MediaTypes');

const EXTS = ['mp4', 'MKV', 'webm', 'mov', 'avi', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'jpg', 'JPEG', 'png', 'heic',
  'arw', 'CR2', 'cr3', 'nef', 'dng', 'raf', 'orf', 'rw2', 'gif', 'bmp', 'svg', 'txt'];

test.after(() => { try { dbm.close(); } catch (_) {} fs.rmSync(tmpRoot, { recursive: true, force: true }); });

test('migração 12: colunas, índices e triggers; backfill idêntico a libraryTypeOf', async () => {
  await dbm.init(path.join(tmpRoot, 'data'));
  runMigrations();
  const db = dbm.get();
  assert.ok(db.prepare('SELECT 1 x FROM schema_migrations WHERE version = 12').get(), 'versão 12 registrada');

  // Simula banco legado: remove a marca 12, zera as colunas e insere linhas "antigas"
  db.exec('DELETE FROM schema_migrations WHERE version = 12');
  db.exec('DROP TRIGGER trg_media_derived_ins; DROP TRIGGER trg_media_derived_upd;');
  EXTS.forEach((e, i) => {
    db.prepare("INSERT INTO media (uuid, filename, filepath, status, recorded_at, imported_at) VALUES (?, ?, ?, 'READY', ?, '2026-03-01 10:00:00')")
      .run('u' + i, `arq${i}.${e}`, `C:/x/arq${i}.${e}`, i % 3 === 0 ? null : `2026-01-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`);
  });
  db.exec('UPDATE media SET media_type = NULL, sort_date = NULL');
  runMigrations(); // reaplica só a 12 (backfill + triggers + índices)

  for (const r of db.prepare('SELECT filename, media_type, recorded_at, imported_at, sort_date FROM media').all()) {
    assert.strictEqual(r.media_type, libraryTypeOf(r.filename), `tipo de ${r.filename}`);
    assert.strictEqual(r.sort_date, r.recorded_at || r.imported_at, `sort_date de ${r.filename}`);
  }
  // RAW é 'raw'; foto inclui todas as imagens (gif/bmp/tiff/svg desde a migração 13)
  assert.strictEqual(db.prepare("SELECT media_type t FROM media WHERE filename LIKE '%.arw'").get().t, 'raw');
  assert.strictEqual(db.prepare("SELECT media_type t FROM media WHERE filename LIKE '%.gif'").get().t, 'photo'); // migração 13: GIF/BMP/TIFF/SVG também são foto

  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
  for (const n of ['idx_media_sort_listing', 'idx_media_type_stats', 'idx_media_type_hf', 'idx_media_imported_at',
    'idx_media_favorite', 'idx_project_media_media_id', 'idx_timeline_clips_media_id',
    'idx_timeline_clips_project_media_id', 'idx_sync_group_items_media_id', 'idx_sync_groups_project_id',
    'idx_project_markers_project_id']) {
    assert.ok(idx.includes(n), `índice ${n}`);
  }
  assert.ok(!idx.includes('idx_media_album'), 'idx_media_album substituído por idx_media_album_ready');
});

test('triggers mantêm media_type/sort_date em INSERT e UPDATE (inclusive fora do módulo de ingestão)', () => {
  const db = dbm.get();
  const ins = db.prepare("INSERT INTO media (uuid, filename, filepath, status) VALUES ('t1', 'novo.MP4', 'C:/n/novo.MP4', 'READY')").run();
  let r = db.prepare('SELECT media_type, sort_date, imported_at FROM media WHERE id = ?').get(ins.lastInsertRowid);
  assert.strictEqual(r.media_type, 'video');
  assert.strictEqual(r.sort_date, r.imported_at, 'sem recorded_at, ordena por imported_at');

  db.prepare("UPDATE media SET recorded_at = '2026-05-05T00:00:00.000Z' WHERE id = ?").run(ins.lastInsertRowid);
  r = db.prepare('SELECT sort_date FROM media WHERE id = ?').get(ins.lastInsertRowid);
  assert.strictEqual(r.sort_date, '2026-05-05T00:00:00.000Z');

  db.prepare("UPDATE media SET filename = 'novo.arw' WHERE id = ?").run(ins.lastInsertRowid); // renomear
  assert.strictEqual(db.prepare('SELECT media_type t FROM media WHERE id = ?').get(ins.lastInsertRowid).t, 'raw');

  // UPDATE de colunas não relacionadas não mexe nas derivadas
  db.prepare('UPDATE media SET favorite = 1 WHERE id = ?').run(ins.lastInsertRowid);
  assert.strictEqual(db.prepare('SELECT media_type t FROM media WHERE id = ?').get(ins.lastInsertRowid).t, 'raw');
});

test('migração é idempotente e a consulta de listagem usa o índice (EXPLAIN QUERY PLAN)', () => {
  const db = dbm.get();
  assert.doesNotThrow(() => runMigrations());
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT m.id FROM media m WHERE (+m.status = 'READY' OR +m.status IS NULL) AND (+m.missing = 0 OR +m.missing IS NULL) ORDER BY m.sort_date DESC, m.id DESC LIMIT 10")
    .all().map(r => r.detail).join(' | ');
  assert.match(plan, /idx_media_sort_listing/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
  const planFav = db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(id) FROM media WHERE favorite = 1').all().map(r => r.detail).join(' | ');
  assert.match(planFav, /idx_media_favorite/);
});
