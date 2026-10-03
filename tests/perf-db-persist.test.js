'use strict';
// Persistência do banco (src/core/database/database.js): debounce + maxWait, changes=0, validação barata,
// cache de statements, lastInsertRowid e .bak espaçado.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-perfdb-persist-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');
const DBManager = require('../src/core/database/database').constructor;

async function novoBanco(nome) {
  const m = new DBManager();
  await m.init(path.join(tmpRoot, nome));
  m.db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
  return m;
}

test.after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

test('run() só agenda gravação quando houve alteração (changes > 0)', async () => {
  const m = await novoBanco('a');
  if (m.saveTimer) { clearTimeout(m.saveTimer); m.saveTimer = null; }
  m.db.prepare('DELETE FROM t WHERE id = ?').run(999); // 0 linhas
  assert.strictEqual(m.saveTimer, null, 'DELETE sem efeito não deve agendar');
  const seq0 = m.writeSeq;
  const r = m.db.prepare('INSERT INTO t (v) VALUES (?)').run('x');
  assert.strictEqual(r.changes, 1);
  assert.ok(m.saveTimer, 'INSERT deve agendar');
  assert.strictEqual(m.writeSeq, seq0 + 1);
  m.close();
});

test('maxWait força a gravação sob escrita contínua (debounce sozinho nunca gravaria)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const m = new DBManager();
  m.db = {}; m.dbPath = 'x'; // só para schedulePersist/persistAsync stubado
  let gravacoes = 0;
  m.persistAsync = async () => { gravacoes++; m.firstDirtyAt = 0; };
  // Escreve a cada 500 ms (< debounce de 1 s) durante 7,5 s: nada deve gravar ainda
  for (let i = 0; i < 15; i++) { m.schedulePersist(); t.mock.timers.tick(500); }
  assert.strictEqual(gravacoes, 0, 'antes do maxWait não grava');
  for (let i = 0; i < 4; i++) { m.schedulePersist(); t.mock.timers.tick(500); }
  assert.ok(gravacoes >= 1, 'após ~8 s contínuos deve ter gravado pelo menos uma vez');
  // Sem novas escritas, o debounce de 1 s grava uma última vez
  const antes = gravacoes;
  m.schedulePersist(); t.mock.timers.tick(1000);
  assert.strictEqual(gravacoes, antes + 1);
});

test('validação barata do .tmp aceita export real e rejeita corrompidos', async () => {
  const m = await novoBanco('b');
  const buf = m._export();
  assert.ok(Buffer.isBuffer(buf));
  assert.doesNotThrow(() => m._validateTmpCheap(buf, buf.length));
  assert.throws(() => m._validateTmpCheap(buf, buf.length - 1), /incoerente/);
  const ruim = Buffer.from(buf); ruim.write('NotSQLite format', 0, 'latin1');
  assert.throws(() => m._validateTmpCheap(ruim, ruim.length), /assinatura/);
  assert.throws(() => m._validateTmpCheap(buf.subarray(0, 50), 50));
  const truncado = buf.subarray(0, buf.length - 100);
  assert.throws(() => m._validateTmpCheap(truncado, truncado.length));
  m.close();
});

test('persistAsync grava arquivo válido, renova .bak no máximo 1x por intervalo; persistSync sempre renova', async () => {
  const m = await novoBanco('c');
  m.persistSync();
  const bak = `${m.dbPath}.bak`;
  m.db.prepare('INSERT INTO t (v) VALUES (?)').run('um');
  await m.persistAsync();
  assert.ok(fs.existsSync(m.dbPath));
  // lastBakAt foi renovado pelo persistSync recente: a gravação assíncrona não copia de novo
  const marca = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(bak, marca, marca);
  m.db.prepare('INSERT INTO t (v) VALUES (?)').run('dois');
  await m.persistAsync();
  assert.ok(Math.abs(fs.statSync(bak).mtimeMs - marca.getTime()) < 2000, '.bak não deve ser recopiado dentro do intervalo');
  // Fora do intervalo, copia
  m.lastBakAt = Date.now() - 11 * 60 * 1000;
  m.db.prepare('INSERT INTO t (v) VALUES (?)').run('tres');
  await m.persistAsync();
  assert.ok(fs.statSync(bak).mtimeMs > marca.getTime() + 60000, '.bak deve ser renovado após o intervalo');
  // persistSync sempre copia
  fs.utimesSync(bak, marca, marca);
  m.persistSync();
  assert.ok(fs.statSync(bak).mtimeMs > marca.getTime() + 60000);
  // Reabre o arquivo gravado: dados íntegros
  m.close();
  const m2 = new DBManager();
  await m2.init(path.join(tmpRoot, 'c'));
  assert.strictEqual(m2.db.prepare('SELECT COUNT(*) c FROM t').get().c, 3);
  m2.close();
});

test('cache de statements: reuso, sobrevive a export() e persistSync, e SQL inválido falha em prepare()', async () => {
  const m = await novoBanco('d');
  const ins = 'INSERT INTO t (v) VALUES (?)';
  for (let i = 0; i < 50; i++) m.db.prepare(ins).run('v' + i);
  assert.ok(m.stmtCache.has(ins));
  assert.strictEqual(m.db.prepare('SELECT COUNT(*) c FROM t').get().c, 50);
  const sel = m.db.prepare('SELECT v FROM t WHERE id = ?');
  assert.strictEqual(sel.get(3).v, 'v2');
  m.persistSync(); // export() libera statements do sql.js; o wrapper deve recompilar
  assert.strictEqual(sel.get(4).v, 'v3');
  assert.strictEqual(m.db.prepare(ins).run('depois').changes, 1);
  assert.strictEqual(m.db.prepare('SELECT * FROM t WHERE id = ?').get(99999), null);
  assert.deepStrictEqual(m.db.prepare('SELECT * FROM t WHERE id = ?').all(99999), []);
  assert.throws(() => m.db.prepare('SELEC nada'));
  // erro de constraint em run() não deixa o statement "preso" para o próximo uso
  m.db.exec('CREATE TABLE u (k TEXT UNIQUE)');
  m.db.prepare('INSERT INTO u VALUES (?)').run('a');
  assert.throws(() => m.db.prepare('INSERT INTO u VALUES (?)').run('a'));
  assert.strictEqual(m.db.prepare('INSERT INTO u VALUES (?)').run('b').changes, 1);
  m.close();
});

test('lastInsertRowid: correto em INSERT e sob demanda (getter) em UPDATE', async () => {
  const m = await novoBanco('e');
  const a = m.db.prepare('INSERT INTO t (v) VALUES (?)').run('a');
  const b = m.db.prepare('INSERT INTO t (v) VALUES (?)').run('b');
  assert.strictEqual(a.lastInsertRowid, 1);
  assert.strictEqual(b.lastInsertRowid, 2);
  const u = m.db.prepare('UPDATE t SET v = ? WHERE id = 1').run('z');
  assert.strictEqual(u.changes, 1);
  assert.strictEqual(typeof u.lastInsertRowid, 'number'); // getter lazy não quebra quem lê
  m.close();
});
