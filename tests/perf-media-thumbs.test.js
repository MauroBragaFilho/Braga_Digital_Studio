'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-thumbs-'));
process.env.BMD_LOGS_DIR = path.join(tmp, 'logs');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const ffmpegExe = path.join(dataDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffprobeExe = path.join(dataDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const hasTools = fs.existsSync(ffmpegExe) && fs.existsSync(ffprobeExe);

const { ffmpegTool } = require('../src/infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../src/infrastructure/external-tools/adapters/FfprobeTool');
ffmpegTool.setToolsDir(dataDir);
ffprobeTool.setToolsDir(dataDir);
const ThumbnailGenerator = require('../src/core/media/ThumbnailGenerator');
const PhotoPreviewService = require('../src/services/photoPreviewService');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sizeOf = (f) => {
  const r = spawnSync(ffprobeExe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f], { encoding: 'utf8' });
  const [w, h] = r.stdout.trim().split(',').map(Number);
  return { w, h };
};
const run = (args) => {
  const r = spawnSync(ffmpegExe, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  assert.strictEqual(r.status, 0, String(r.stderr));
};

test('ThumbnailGenerator: vídeo 1080p vira JPG de 480 px pequeno', { skip: !hasTools && 'data/ffmpeg ausente' }, async () => {
  const video = path.join(tmp, 'v.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=8', '-c:v', 'libx264', '-preset', 'ultrafast', video]);
  const gen = new ThumbnailGenerator({ ffmpegPath: ffmpegExe, thumbnailsDir: path.join(tmp, 'thumbs') });
  const out = await gen.generate(video, 'uuid-1', 8);
  assert.strictEqual(path.basename(out), 'uuid-1.jpg');
  assert.deepStrictEqual(sizeOf(out), { w: 480, h: 270 });
  assert.ok(fs.statSync(out).size < 40 * 1024, `miniatura grande demais: ${fs.statSync(out).size}`);
});

test('ThumbnailGenerator: vídeo curto e duração desconhecida (primeiro frame) e foto', { skip: !hasTools && 'data/ffmpeg ausente' }, async () => {
  const video = path.join(tmp, 'short.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', video]);
  const photo = path.join(tmp, 'p.jpg');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=2000x1500:d=1', '-frames:v', '1', photo]);
  const gen = new ThumbnailGenerator({ ffmpegPath: ffmpegExe, thumbnailsDir: path.join(tmp, 'thumbs2') });

  const a = await gen.generate(video, 'u-short', 1);   // duration < 5 => meio do vídeo
  const b = await gen.generate(video, 'u-zero', 0);    // duração desconhecida => primeiro frame
  const c = await gen.generate(video, 'u-bad', 999);   // ponto de busca inválido => cai para o primeiro frame
  const d = await gen.generate(photo, 'u-photo', 0);
  for (const f of [a, b, c, d]) assert.ok(fs.statSync(f).size > 0);
  assert.deepStrictEqual(sizeOf(a), { w: 480, h: 270 });
  assert.deepStrictEqual(sizeOf(d), { w: 480, h: 360 });
  // mídia menor que a miniatura não é ampliada
  const tiny = path.join(tmp, 'tiny.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', tiny]);
  assert.deepStrictEqual(sizeOf(await gen.generate(tiny, 'u-tiny', 1)), { w: 320, h: 180 });
});

test('ThumbnailGenerator: vídeo longo (duração > 60 s) gera miniatura pelo caminho -skip_frame nokey', { skip: !hasTools && 'data/ffmpeg ausente' }, async () => {
  const video = path.join(tmp, 'long.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', video]);
  const gen = new ThumbnailGenerator({ ffmpegPath: ffmpegExe, thumbnailsDir: path.join(tmp, 'thumbs3') });
  // duração informada > 60 s: o primeiro ponto de busca usa -skip_frame nokey (o arquivo real tem keyframe a cada 1 s)
  const out = await gen.generate(video, 'u-long', 120);
  assert.ok(fs.statSync(out).size > 0);
  assert.deepStrictEqual(sizeOf(out), { w: 480, h: 270 });
  // GOP único (keyframe só em 0): nokey não produz frame no ponto de 5 s e o fallback para seek normal deve salvar
  const oneGop = path.join(tmp, 'onegop.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1000', '-sc_threshold', '0', oneGop]);
  const out2 = await gen.generate(oneGop, 'u-onegop', 120);
  assert.ok(fs.statSync(out2).size > 0, 'fallback gerou miniatura mesmo sem keyframe no ponto de busca');
});

test('PhotoPreviewService: thumbnailOnly GERA e devolve <chave>_thumb.jpg (480 px) e reutiliza do cache', { skip: !hasTools && 'data/ffmpeg ausente' }, async () => {
  const svc = new PhotoPreviewService({ paths: { dataDir: path.join(tmp, 'appdata'), tools: dataDir } });
  const tiff = path.join(tmp, 'foto.tiff');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=1600x1200:d=1', '-frames:v', '1', tiff]);

  const first = await svc.getRenderablePath(tiff, { thumbnailOnly: true });
  assert.ok(first.isThumbnail);
  assert.ok(first.renderablePath.endsWith('_thumb.jpg'));
  assert.ok(fs.existsSync(first.renderablePath));
  const dim = sizeOf(first.renderablePath);
  assert.ok(Math.max(dim.w, dim.h) <= 480 && Math.max(dim.w, dim.h) >= 479, JSON.stringify(dim));
  assert.ok(!fs.readdirSync(svc.cacheDir).some((n) => n.includes('.tmp')), 'sem arquivos temporários sobrando');

  const mtime = fs.statSync(first.renderablePath).mtimeMs;
  const second = await svc.getRenderablePath(tiff, { thumbnailOnly: true });
  assert.strictEqual(second.renderablePath, first.renderablePath);
  assert.strictEqual(fs.statSync(second.renderablePath).mtimeMs, mtime, 'não regenerou');

  // pedidos simultâneos compartilham a geração
  const tiff2 = path.join(tmp, 'foto2.tiff');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=800x600:d=1', '-frames:v', '1', tiff2]);
  const [r1, r2] = await Promise.all([
    svc.getRenderablePath(tiff2, { thumbnailOnly: true }),
    svc.getRenderablePath(tiff2, { thumbnailOnly: true })
  ]);
  assert.strictEqual(r1.renderablePath, r2.renderablePath);
});

test('PhotoPreviewService: RAW com JPG par (qualquer caixa) gera miniatura a partir do JPG', { skip: !hasTools && 'data/ffmpeg ausente' }, async () => {
  const svc = new PhotoPreviewService({ paths: { dataDir: path.join(tmp, 'appdata2'), tools: dataDir } });
  // Pasta própria: MediaTypes mantém a listagem de diretório em cache (TTL curto); uma pasta já
  // listada por outro teste não enxergaria o JPG recém-criado.
  const rawDir = path.join(tmp, 'raw1');
  fs.mkdirSync(rawDir);
  const raw = path.join(rawDir, 'IMG_0001.cr2');
  fs.writeFileSync(raw, Buffer.from('II*\0 nao eh um raw de verdade'));
  run(['-f', 'lavfi', '-i', 'testsrc2=s=1200x800:d=1', '-frames:v', '1', path.join(rawDir, 'IMG_0001.JPG')]);

  const res = await svc.getRenderablePath(raw, { thumbnailOnly: true });
  assert.ok(res.isThumbnail && res.hasPeerJpg);
  assert.ok(res.renderablePath.endsWith('_thumb.jpg'));
  assert.strictEqual(sizeOf(res.renderablePath).w, 480);

  // sem thumbnailOnly: devolve o JPG par original
  const full = await svc.getRenderablePath(raw);
  assert.ok(full.hasPeerJpg);
  assert.strictEqual(path.basename(full.renderablePath).toLowerCase(), 'img_0001.jpg');
});
