'use strict';

// Migração 18 (tabela project_luts): usa o runMigrations REAL (schema.sql + MIGRATIONS) a partir de um banco na versão 17,
// confere que nenhum dado é perdido, que tabela e índices existem, que repetir é inofensivo e que o banco gravado,
// reaberto, passa nas verificações de integridade e de chaves estrangeiras (inclusive a exclusão em cascata).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-projlut-mig-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');
const dbm = require('../src/core/database/database');
const { runMigrations, MIGRATIONS, SCHEMA_VERSION } = require('../src/core/database/migrations');

test.before(async () => { await dbm.init(path.join(tmpRoot, 'data')); });
test.after(() => { try { dbm.close(); } catch (_) { /* já fechado */ } fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** Linhas de todas as tabelas (menos as de controle), para comparar antes e depois. */
function snapshotAll(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations', 'project_luts') ORDER BY name").all().map((r) => r.name);
  const out = {};
  for (const t of tables) out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all();
  return out;
}

/** Deixa o banco como um da versão 17: com dados, sem a tabela nova e sem a marca 18. */
function downgradeTo17(db) {
  db.exec('DROP TABLE IF EXISTS project_luts');
  db.exec('DELETE FROM schema_migrations WHERE version >= 18');
}

test('a versão do esquema é 18 e a migração 18 existe', () => {
  assert.equal(SCHEMA_VERSION, 18);
  assert.ok(MIGRATIONS.some((m) => m.version === 18));
  assert.equal(Math.max(...MIGRATIONS.map((m) => m.version)), 18);
});

test('banco novo: a tabela e os índices nascem, e a versão 18 fica registrada', () => {
  const result = runMigrations();
  assert.deepEqual(result, { ok: true, failedVersion: null });
  const db = dbm.get();
  assert.ok(db.prepare('SELECT 1 x FROM schema_migrations WHERE version = 18').get());
  const cols = db.prepare('PRAGMA table_info(project_luts)').all().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'project_id', 'lut_hash', 'lut_name', 'lut_title', 'lut_kind', 'lut_size', 'file_bytes', 'lut_rel_path', 'added_at']);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  assert.ok(idx.includes('idx_project_luts_project') && idx.includes('idx_project_luts_hash'));
});

test('a partir de um banco v17 com dados: tudo é preservado linha a linha e a tabela nasce vazia', () => {
  const db = dbm.get();
  // dados reais de projeto: projeto, pastas, mídia, dispositivo, entrega, atividade
  const pid = db.prepare("INSERT INTO projects (name, status, client) VALUES ('Casamento', 'Em produção', 'Ana')").run().lastInsertRowid;
  const bin = db.prepare("INSERT INTO project_bins (project_id, name) VALUES (?, 'BRUTOS')").run(pid).lastInsertRowid;
  const media = db.prepare("INSERT INTO media (uuid, filename, filepath, status) VALUES ('u1', 'a.mp4', 'C:/a.mp4', 'READY')").run().lastInsertRowid;
  db.prepare('INSERT INTO project_media (project_id, bin_id, media_id) VALUES (?, ?, ?)').run(pid, bin, media);
  db.prepare("INSERT INTO project_devices (project_id, category, name) VALUES (?, 'camera', 'Sony')").run(pid);
  db.prepare("INSERT INTO project_activity (project_id, kind, message) VALUES (?, 'criado', 'Projeto criado')").run(pid);
  db.prepare("INSERT INTO project_delivery (project_id, status, items) VALUES (?, 'Em preparação', '[]')").run(pid);

  downgradeTo17(db);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'project_luts'").get(), null, 'o ponto de partida não tem a tabela');
  const before = snapshotAll(db);

  // o runner reexecuta o schema.sql inteiro antes da migração pendente: a tabela já existe quando a 18 roda
  const result = runMigrations();
  assert.deepEqual(result, { ok: true, failedVersion: null });
  assert.deepEqual(snapshotAll(db), before, 'nenhuma linha de nenhuma tabela mudou');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_luts').get().n, 0);
  assert.ok(db.prepare('SELECT 1 x FROM schema_migrations WHERE version = 18').get());
});

test('a migração 18 sozinha cria tabela e índices (sem depender do schema.sql) e repetir é inofensivo', () => {
  const db = dbm.get();
  db.exec('DROP TABLE IF EXISTS project_luts');
  const m18 = MIGRATIONS.find((m) => m.version === 18);
  db.exec('BEGIN TRANSACTION');
  m18.up(db);
  db.exec('COMMIT');
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'project_luts'").all().map((r) => r.name);
  assert.ok(idx.includes('idx_project_luts_project') && idx.includes('idx_project_luts_hash'));
  assert.doesNotThrow(() => m18.up(db), 'reaplicar não falha');
  assert.doesNotThrow(() => runMigrations());
  assert.doesNotThrow(() => runMigrations());
});

test('sem o registro 18 o runner reaplica sem erro e sem tocar nas LUTs já ligadas', () => {
  const db = dbm.get();
  const pid = db.prepare("INSERT INTO projects (name) VALUES ('P')").run().lastInsertRowid;
  db.prepare("INSERT INTO project_luts (project_id, lut_hash, lut_name) VALUES (?, ?, 'Filme')").run(pid, HASH_A);
  db.exec('DELETE FROM schema_migrations WHERE version = 18');
  assert.deepEqual(runMigrations(), { ok: true, failedVersion: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_luts WHERE project_id = ?').get(pid).n, 1);
  assert.ok(db.prepare('SELECT 1 x FROM schema_migrations WHERE version = 18').get());
});

test('o par (projeto, conteúdo) é único e o nome, o título e o tipo são só rótulos', () => {
  const db = dbm.get();
  const p1 = db.prepare("INSERT INTO projects (name) VALUES ('U1')").run().lastInsertRowid;
  const p2 = db.prepare("INSERT INTO projects (name) VALUES ('U2')").run().lastInsertRowid;
  const insert = db.prepare('INSERT INTO project_luts (project_id, lut_hash, lut_name) VALUES (?, ?, ?)');
  insert.run(p1, HASH_B, 'A');
  insert.run(p2, HASH_B, 'A'); // outro projeto pode ter a mesma LUT
  assert.throws(() => insert.run(p1, HASH_B, 'Outro nome'), /UNIQUE/i);
});

test('banco gravado e reaberto: integrity_check, foreign_key_check e exclusão do projeto em cascata', () => {
  const db = dbm.get();
  const pid = db.prepare("INSERT INTO projects (name) VALUES ('Cascata')").run().lastInsertRowid;
  db.prepare("INSERT INTO project_luts (project_id, lut_hash, lut_name, lut_kind, lut_size) VALUES (?, ?, 'X', '3D', 33)").run(pid, HASH_A);
  db.prepare("INSERT INTO project_luts (project_id, lut_hash, lut_name) VALUES (?, ?, 'Y')").run(pid, HASH_B);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_luts WHERE project_id = ?').get(pid).n, 2);

  // a mesma conexão: excluir o projeto leva as LUTs junto
  const projectService = require('../src/core/projects/ProjectService');
  assert.ok(projectService.deleteProject(pid));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_luts WHERE project_id = ?').get(pid).n, 0, 'cascata na conexão em uso');

  // grava, reabre os bytes do arquivo e confere
  const keep = db.prepare("INSERT INTO projects (name) VALUES ('Fica')").run().lastInsertRowid;
  db.prepare("INSERT INTO project_luts (project_id, lut_hash, lut_name) VALUES (?, ?, 'Z')").run(keep, HASH_A);
  assert.ok(dbm.persistSync());
  const reopened = new dbm.SQL.Database(fs.readFileSync(dbm.dbPath));
  try {
    assert.equal(reopened.exec('PRAGMA integrity_check')[0].values[0][0], 'ok');
    assert.equal(reopened.exec('PRAGMA foreign_key_check').length, 0, 'sem violações de chave estrangeira');
    assert.equal(reopened.exec('SELECT COUNT(*) FROM project_luts WHERE project_id = ' + keep)[0].values[0][0], 1, 'a LUT ligada sobrevive ao gravar e reabrir');
    reopened.exec('PRAGMA foreign_keys = ON');
    reopened.exec('DELETE FROM projects WHERE id = ' + keep);
    assert.equal(reopened.exec('SELECT COUNT(*) FROM project_luts WHERE project_id = ' + keep)[0].values[0][0], 0, 'cascata também no banco reaberto');
  } finally { reopened.close(); }
});
