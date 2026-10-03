'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-dlq-'));
process.env.BMD_LOGS_DIR = path.join(tmp, 'logs');

const initSqlJs = require('sql.js');
const dbManager = require('../src/core/database/database');
const DownloadManager = require('../src/services/downloadService');

let sqlDb;
let realGet;

/** Adaptador mínimo no estilo better-sqlite3 sobre o sql.js (SQLite real, para validar o UPSERT). */
function adapter(db) {
  return {
    prepare(sql) {
      return {
        run: (...params) => { const st = db.prepare(sql); st.run(params); st.free(); },
        get: (...params) => { const st = db.prepare(sql); st.bind(params); const r = st.step() ? st.getAsObject() : undefined; st.free(); return r; },
        all: (...params) => { const st = db.prepare(sql); st.bind(params); const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free(); return rows; }
      };
    }
  };
}

test.before(async () => {
  const SQL = await initSqlJs();
  sqlDb = new SQL.Database();
  sqlDb.run(`CREATE TABLE download_queue (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, thumbnail TEXT, channel TEXT, platform TEXT,
    duration REAL, format TEXT, quality TEXT, status TEXT DEFAULT 'queued', position INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, started_at DATETIME, completed_at DATETIME,
    progress REAL DEFAULT 0, downloaded_bytes INTEGER DEFAULT 0, total_bytes INTEGER DEFAULT 0,
    speed TEXT, eta TEXT, output_path TEXT, error TEXT
  )`);
  realGet = dbManager.get;
  dbManager.get = () => adapter(sqlDb);
});

test.after(() => {
  dbManager.get = realGet;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function newManager() {
  return new DownloadManager({ paths: { dataDir: tmp }, getSettings: () => ({ mp4Folder: tmp, mp3Folder: tmp }), historyService: null });
}

const baseItem = () => ({
  id: 'dl_1', url: 'https://example.com/v', title: 'T', thumbnail: '', channel: 'C', platform: 'YouTube',
  duration: 10, format: 'MP4', quality: 'best', status: 'queued', progress: 0, downloadedBytes: 0,
  totalBytes: 0, speed: '', eta: '', outputPath: '', error: '', position: 1,
  createdAt: '2026-01-01T00:00:00.000Z', startedAt: null, completedAt: null
});

test('saveItemToDb: UPSERT insere e depois atualiza sem tocar em created_at', () => {
  const m = newManager();
  const item = baseItem();
  m.saveItemToDb(item);
  let rows = adapter(sqlDb).prepare('SELECT * FROM download_queue').all();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'queued');

  item.status = 'completed';
  item.progress = 100;
  item.createdAt = '2030-01-01T00:00:00.000Z'; // não deve sobrescrever created_at já gravado
  item.completedAt = '2026-02-02T00:00:00.000Z';
  m.saveItemToDb(item);
  rows = adapter(sqlDb).prepare('SELECT * FROM download_queue').all();
  assert.strictEqual(rows.length, 1, 'continua uma linha');
  assert.strictEqual(rows[0].status, 'completed');
  assert.strictEqual(rows[0].progress, 100);
  assert.strictEqual(rows[0].created_at, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(rows[0].completed_at, '2026-02-02T00:00:00.000Z');
});

test('saveItemToDb usa um único prepare/run por gravação (sem SELECT prévio)', () => {
  const m = newManager();
  const sqls = [];
  const orig = dbManager.get;
  dbManager.get = () => {
    const a = adapter(sqlDb);
    return { prepare: (sql) => { sqls.push(sql.trim().split(/\s+/)[0].toUpperCase()); return a.prepare(sql); } };
  };
  try {
    m.saveItemToDb({ ...baseItem(), id: 'dl_2' });
  } finally {
    dbManager.get = orig;
  }
  assert.deepStrictEqual(sqls, ['INSERT']);
});

test('handleOutput: ticks de progresso não gravam no banco nem emitem a fila inteira', () => {
  const m = newManager();
  const item = { ...baseItem(), id: 'dl_3', status: 'downloading' };
  m.queue.push(item);
  let saves = 0;
  m.saveItemToDb = () => { saves++; };
  const events = [];
  m.on('downloads:progress', (e) => events.push(e));
  m.on('downloads:updated', () => events.push('FULL_QUEUE'));

  m.handleOutput('[download]  12.5% of 100.00MiB at 2.00MiB/s ETA 00:40', item);
  m.handleOutput('[download]  60.0% of 100.00MiB at 2.00MiB/s ETA 00:20', item);
  assert.strictEqual(saves, 0, 'progresso parcial não é persistido a cada tick');
  assert.strictEqual(item.progress, 60);
  assert.strictEqual(events.filter((e) => e === 'FULL_QUEUE').length, 0);
  assert.strictEqual(events.length, 1, 'emissão limitada por throttle');
  assert.strictEqual(events[0].id, 'dl_3');

  // mudança de destino é gravada na hora
  m.handleOutput('[download] Destination: C:\\videos\\Meu Video.mp4', item);
  assert.strictEqual(saves, 1);
  assert.strictEqual(item.title, 'Meu Video');
});
