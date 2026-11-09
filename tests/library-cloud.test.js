'use strict';
// Biblioteca em pasta do Google Drive para computador: indexa sem ler o conteúdo (que faria o Drive baixar
// cada vídeo) e lê duração, dados técnicos e miniatura só quando a mídia é usada.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-cloud-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');
const dbm = require('../src/core/database/database');
const { runMigrations } = require('../src/core/database/migrations');
const { ingestFile } = require('../src/core/media/MediaIngest');
const { isCloudPath, cloudHash } = require('../src/core/media/CloudStorage');
const { regenerateMissingThumbnails } = require('../src/core/library/ThumbnailRegenService');

let db;
test.before(async () => {
  await dbm.init(path.join(tmpRoot, 'data'));
  runMigrations();
  db = dbm.get();
});
test.after(() => { try { dbm.close(); } catch (_) {} fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const touch = (p, content = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

/** ffprobe e miniatura falsos que contam as chamadas (cada uma leria o arquivo). */
function fakeTools({ fail = false } = {}) {
  const calls = { probe: 0, thumb: 0 };
  return {
    calls,
    ffprobe: { analyze: async () => { calls.probe++; if (fail) throw new Error('sem internet'); return { duration: 12.5, width: 1920, height: 1080, fps: 30, video_codec: 'h264', audio_codec: 'aac', bitrate: 8000000, filesize: 0, audio_streams: [] }; } },
    generateThumbnail: async (fp, uuid) => { calls.thumb++; return `${uuid}.jpg`; },
  };
}

test('isCloudPath: unidade do Google Drive no Windows e CloudStorage no macOS', () => {
  assert.equal(isCloudPath('G:\\My Drive\\Vídeo\\a.mp4', 'win32'), true);
  assert.equal(isCloudPath('Y:\\Meu Drive\\a.mp4', 'win32'), true);
  assert.equal(isCloudPath('Z:\\Shared drives\\Equipe\\a.mp4', 'win32'), true);
  assert.equal(isCloudPath('G:\\.shortcut-targets-by-id\\1abc\\a.mp4', 'win32'), true);
  assert.equal(isCloudPath('/Users/x/Library/CloudStorage/GoogleDrive-x@gmail.com/My Drive/a.mp4', 'darwin'), true);
  assert.equal(isCloudPath('/Volumes/GoogleDrive/Meu Drive/a.mp4', 'darwin'), true);
  // Modo "espelhar" (arquivos reais no perfil) e pastas locais com o mesmo nome não são nuvem
  assert.equal(isCloudPath('C:\\Users\\x\\My Drive\\a.mp4', 'win32'), false);
  assert.equal(isCloudPath('D:\\Videos\\My Drive\\a.mp4', 'win32'), false);
  assert.equal(isCloudPath('D:\\Gravações\\a.mp4', 'win32'), false);
  assert.equal(isCloudPath('', 'win32'), false);
});

test('cloudHash: não depende do conteúdo e nunca coincide com um SHA-256 puro', () => {
  const h = cloudHash('G:\\My Drive\\A.mp4', { size: 100, mtimeMs: 1700000000000 });
  assert.match(h, /^cloud:[0-9a-f]{64}$/);
  assert.equal(h, cloudHash('G:\\Outra\\a.MP4', { size: 100, mtimeMs: 1700000000000 }));
  assert.notEqual(h, cloudHash('G:\\My Drive\\A.mp4', { size: 101, mtimeMs: 1700000000000 }));
});

test('pasta do Drive: indexa sem ffprobe, sem miniatura e sem hash do conteúdo; usar a mídia completa os dados', async () => {
  const root = path.join(tmpRoot, 'GoogleDrive-amigo', 'My Drive', 'Gravações');
  const file = path.join(root, 'clipe.mp4');
  touch(file, 'conteudo-do-video');
  const libId = db.prepare("INSERT INTO libraries (name, type, path) VALUES ('Drive', 'Drive', ?)").run(root).lastInsertRowid;
  const library = { id: libId, type: 'Drive', path: root };

  const t1 = fakeTools();
  const r1 = await ingestFile({ db, ffprobe: t1.ffprobe, generateThumbnail: t1.generateThumbnail, library, filePath: file });
  assert.deepEqual(t1.calls, { probe: 0, thumb: 0 }, 'nada pode ler o conteúdo do arquivo da nuvem');
  assert.equal(r1.cloud, true);
  let row = db.prepare('SELECT * FROM media WHERE id = ?').get(r1.id);
  assert.equal(row.status, 'READY');
  assert.equal(row.cloud, 1);
  assert.equal(row.filesize, fs.statSync(file).size);
  assert.equal(row.thumbnail, null);
  assert.equal(row.duration, null);
  assert.match(row.hash, /^cloud:/);
  assert.ok(row.recorded_at, 'data de gravação vem da data de modificação');

  // Nova varredura/evento do watcher: continua sem ler nada
  const t2 = fakeTools();
  const r2 = await ingestFile({ db, ffprobe: t2.ffprobe, generateThumbnail: t2.generateThumbnail, library, filePath: file });
  assert.equal(r2.id, r1.id);
  assert.deepEqual(t2.calls, { probe: 0, thumb: 0 });

  // Leitura que falha (ex.: sem internet): a mídia continua na biblioteca, ainda pendente
  const tf = fakeTools({ fail: true });
  await assert.rejects(ingestFile({ db, ffprobe: tf.ffprobe, generateThumbnail: tf.generateThumbnail, library, filePath: file, loadCloud: true }));
  row = db.prepare('SELECT * FROM media WHERE id = ?').get(r1.id);
  assert.equal(row.status, 'READY');
  assert.equal(row.cloud, 1);
  assert.match(row.hash, /^cloud:/);

  // Mídia usada (preview, "Ler agora", levada ao projeto): lê tudo, mesmo id e mesma data de importação
  db.prepare("UPDATE media SET imported_at = '2026-01-02 03:04:05' WHERE id = ?").run(r1.id);
  const t3 = fakeTools();
  const r3 = await ingestFile({ db, ffprobe: t3.ffprobe, generateThumbnail: t3.generateThumbnail, library, filePath: file, loadCloud: true });
  assert.equal(r3.id, r1.id);
  assert.deepEqual(t3.calls, { probe: 1, thumb: 1 });
  row = db.prepare('SELECT * FROM media WHERE id = ?').get(r1.id);
  assert.equal(row.cloud, 0);
  assert.equal(row.duration, 12.5);
  assert.equal(row.width, 1920);
  assert.equal(row.thumbnail, `${row.uuid}.jpg`);
  assert.doesNotMatch(row.hash, /^cloud:/);
  assert.equal(row.imported_at, '2026-01-02 03:04:05');

  // Já completa: usar de novo não relê
  const t4 = fakeTools();
  await ingestFile({ db, ffprobe: t4.ffprobe, generateThumbnail: t4.generateThumbnail, library, filePath: file, loadCloud: true });
  assert.deepEqual(t4.calls, { probe: 0, thumb: 0 });
});

test('pasta local: loadCloud não muda nada (mídia READY não é reprocessada)', async () => {
  const file = path.join(tmpRoot, 'local', 'video.mp4');
  touch(file, 'local');
  const t1 = fakeTools();
  const r1 = await ingestFile({ db, ffprobe: t1.ffprobe, generateThumbnail: t1.generateThumbnail, library: null, filePath: file });
  assert.deepEqual(t1.calls, { probe: 1, thumb: 1 });
  assert.equal(db.prepare('SELECT cloud FROM media WHERE id = ?').get(r1.id).cloud, 0);
  const t2 = fakeTools();
  await ingestFile({ db, ffprobe: t2.ffprobe, generateThumbnail: t2.generateThumbnail, library: null, filePath: file, loadCloud: true });
  assert.deepEqual(t2.calls, { probe: 0, thumb: 0 });
});

test('regeneração de miniaturas ignora mídias da nuvem ainda não lidas', async () => {
  const file = path.join(tmpRoot, 'GoogleDrive-amigo', 'My Drive', 'outro.mp4');
  touch(file, 'outro');
  const t = fakeTools();
  await ingestFile({ db, ffprobe: t.ffprobe, generateThumbnail: t.generateThumbnail, library: null, filePath: file });
  // As demais mídias do banco já têm miniatura registrada: cria os arquivos para o atalho de contagem valer
  const thumbDir = path.join(tmpRoot, 'data', 'Thumbnails');
  fs.mkdirSync(thumbDir, { recursive: true });
  for (const r of db.prepare('SELECT thumbnail FROM media WHERE thumbnail IS NOT NULL').all()) touch(path.join(thumbDir, r.thumbnail), 'jpg');
  // ffmpeg inexistente: se a mídia da nuvem entrasse na fila, contaria como falha (total 1)
  require('../src/infrastructure/external-tools/adapters/FfmpegTool').ffmpegTool.setToolsDir(path.join(tmpRoot, 'tools'));
  const res = await regenerateMissingThumbnails({ paths: { dataDir: path.join(tmpRoot, 'data') }, dbManager: dbm });
  assert.deepEqual(res, { regenerated: 0, failed: 0, total: 0 });
});
