'use strict';
// LibraryQueryService com media_type/sort_date: resultados idênticos à semântica anterior (extensão + COALESCE).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-perfdb-lib-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');
const dbm = require('../src/core/database/database');
const { runMigrations } = require('../src/core/database/migrations');
const LQS = require('../src/core/library/LibraryQueryService');

const VIDEO = ['mp4', 'mkv', 'webm', 'mov', 'avi'];
const AUDIO = ['mp3', 'm4a', 'wav', 'flac', 'ogg'];
const RAW = ['arw', 'cr2', 'cr3', 'nef', 'dng', 'raf', 'orf', 'rw2'];
const PHOTO = ['jpg', 'jpeg', 'png', 'heic', 'gif', 'bmp', 'tiff', 'svg', ...RAW]; // gif/bmp/tiff/svg: migração 13
const ext = (f) => f.slice(f.lastIndexOf('.') + 1).toLowerCase();
let rows;

test.before(async () => {
  await dbm.init(path.join(tmpRoot, 'data'));
  runMigrations();
  const db = dbm.get();
  const exts = [...VIDEO, ...AUDIO, 'jpg', 'PNG', 'heic', 'ARW', 'cr2', 'gif'];
  db.exec('BEGIN');
  for (let i = 0; i < 240; i++) {
    const e = exts[i % exts.length];
    // Datas repetidas de propósito (empates exigem desempate por id) e alguns sem recorded_at
    const rec = i % 5 === 0 ? null : `2026-02-${String(1 + (i % 9)).padStart(2, '0')}T10:00:00.000Z`;
    db.prepare("INSERT INTO media (uuid, filename, filepath, filesize, status, missing, favorite, recorded_at, imported_at, height, fps) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run('u' + i, `f${i}.${e}`, `C:/m/f${i}.${e}`, 1000 + i, i % 29 === 0 ? 'ERROR' : 'READY', i % 17 === 0 ? 1 : 0, i % 7 === 0 ? 1 : 0,
        rec, `2026-03-${String(1 + (i % 4)).padStart(2, '0')} 10:00:00`, VIDEO.includes(e.toLowerCase()) ? 1080 : null, VIDEO.includes(e.toLowerCase()) ? 30 : null);
  }
  db.exec('COMMIT');
  rows = db.prepare('SELECT * FROM media').all();
});

test.after(() => { try { dbm.close(); } catch (_) {} fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const ready = (r) => (r.status === 'READY' || r.status == null) && (r.missing === 0 || r.missing == null);
const sortKey = (r) => r.recorded_at || r.imported_at;
const expectedOrder = (list, dir) => list.slice().sort((a, b) => {
  const ka = sortKey(a), kb = sortKey(b);
  if (ka !== kb) return (ka < kb ? -1 : 1) * dir;
  return (a.id - b.id) * dir;
}).map(r => r.id);

test('getStats: contagens iguais à contagem por extensão (RAW conta como foto)', () => {
  const rd = rows.filter(ready);
  const s = LQS.getStats();
  assert.strictEqual(s.totalMedia, rd.length);
  assert.strictEqual(s.totalSizeBytes, rd.reduce((a, r) => a + r.filesize, 0));
  assert.strictEqual(s.videosCount, rd.filter(r => VIDEO.includes(ext(r.filename))).length);
  assert.strictEqual(s.audiosCount, rd.filter(r => AUDIO.includes(ext(r.filename))).length);
  assert.strictEqual(s.photosCount, rd.filter(r => PHOTO.includes(ext(r.filename))).length);
  assert.strictEqual(s.rawCount, rd.filter(r => RAW.includes(ext(r.filename))).length);
});

test('getFilterOptions: tipos, resoluções e fps coerentes', () => {
  LQS.invalidateFilterOptionsCache();
  const f = LQS.getFilterOptions();
  const rd = rows.filter(ready);
  assert.strictEqual(f.types.video, rd.filter(r => VIDEO.includes(ext(r.filename))).length);
  assert.strictEqual(f.types.photo, rd.filter(r => PHOTO.includes(ext(r.filename))).length);
  assert.strictEqual(f.types.raw, rd.filter(r => RAW.includes(ext(r.filename))).length);
  const vids = rows.filter(r => VIDEO.includes(ext(r.filename)));
  assert.deepStrictEqual(f.resolutions, [{ height: 1080, count: vids.length }]);
  assert.deepStrictEqual(f.fps, [{ fps: 30, count: vids.length }]);
  assert.strictEqual(f.favoritesCount, rows.filter(r => r.favorite === 1).length);
});

test('searchMedia: ordem COALESCE(recorded_at, imported_at) + id, DESC e ASC, paginação sem repetição', () => {
  const rd = rows.filter(ready);
  const all = LQS.searchMedia({ limit: 1000 });
  assert.deepStrictEqual(all.items.map(i => i.id), expectedOrder(rd, -1));
  assert.strictEqual(all.totalCount, rd.length);
  assert.strictEqual(all.total, all.totalCount);
  assert.strictEqual(all.hasMore, false);
  const asc = LQS.searchMedia({ limit: 1000, order: 'ASC' });
  assert.deepStrictEqual(asc.items.map(i => i.id), expectedOrder(rd, 1));

  const seen = [];
  for (let off = 0; off < rd.length; off += 50) {
    const p = LQS.searchMedia({ limit: 50, offset: off });
    assert.strictEqual(p.offset, off);
    assert.strictEqual(p.totalCount, rd.length, 'COUNT (cacheado em offset>0) continua correto');
    assert.strictEqual(p.hasMore, off + p.items.length < rd.length);
    seen.push(...p.items.map(i => i.id));
  }
  assert.deepStrictEqual(seen, expectedOrder(rd, -1));
  assert.ok('project_name' in all.items[0] && 'filename' in all.items[0], 'itens mantêm m.* + project_name');
});

test('searchMedia: filtros por tipo (photo inclui RAW, raw só RAW, múltiplos tipos)', () => {
  const rd = rows.filter(ready);
  const ids = (o) => LQS.searchMedia({ limit: 1000, ...o }).items.map(i => i.id);
  const exp = (pred) => expectedOrder(rd.filter(r => pred(ext(r.filename))), -1);
  assert.deepStrictEqual(ids({ types: ['video'] }), exp(e => VIDEO.includes(e)));
  assert.deepStrictEqual(ids({ types: ['audio'] }), exp(e => AUDIO.includes(e)));
  assert.deepStrictEqual(ids({ types: ['photo'] }), exp(e => PHOTO.includes(e)));
  assert.deepStrictEqual(ids({ types: ['raw'] }), exp(e => RAW.includes(e)));
  assert.deepStrictEqual(ids({ types: ['video', 'raw'] }), exp(e => VIDEO.includes(e) || RAW.includes(e)));
  assert.deepStrictEqual(ids({ types: ['desconhecido'] }), expectedOrder(rd, -1), 'tipo desconhecido não filtra (comportamento anterior)');
  assert.deepStrictEqual(ids({ favorites: true }), expectedOrder(rd.filter(r => r.favorite === 1), -1));
  assert.deepStrictEqual(ids({ query: 'f12' }), expectedOrder(rd.filter(r => r.filename.includes('f12')), -1));
  assert.deepStrictEqual(ids({ dates: ['2026-02-03'] }).length, rd.filter(r => r.recorded_at && r.recorded_at.startsWith('2026-02-03')).length);
});

test('limit tem teto de 5000 e COUNT em cache é invalidado por escritas', () => {
  assert.strictEqual(LQS.searchMedia({ limit: 999999 }).limit, 5000);
  const db = dbm.get();
  const antes = LQS.searchMedia({ limit: 10, offset: 10 }).totalCount; // popula cache
  db.prepare("INSERT INTO media (uuid, filename, filepath, status) VALUES ('novo', 'novo.mp4', 'C:/m/novo.mp4', 'READY')").run();
  const depois = LQS.searchMedia({ limit: 10, offset: 10 }).totalCount;
  assert.strictEqual(depois, antes + 1);
});

test('getRecentMedia ordena por sort_date (data de gravação ou importação)', () => {
  const r = LQS.getRecentMedia(5);
  assert.strictEqual(r.length, 5);
  for (let i = 1; i < r.length; i++) assert.ok((r[i - 1].sort_date || '') >= (r[i].sort_date || ''));
});
