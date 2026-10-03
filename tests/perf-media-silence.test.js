'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-silence-'));
process.env.BMD_LOGS_DIR = path.join(tmp, 'logs');

const root = path.join(__dirname, '..');
const ffmpegExe = path.join(root, 'data', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffprobeExe = path.join(root, 'data', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const hasTools = fs.existsSync(ffmpegExe) && fs.existsSync(ffprobeExe);

const { ffmpegTool } = require('../src/infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../src/infrastructure/external-tools/adapters/FfprobeTool');
const SilenceService = require('../src/services/silenceService');

ffmpegTool.setToolsDir(path.join(root, 'data'));
ffprobeTool.setToolsDir(path.join(root, 'data'));

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const makeService = () => new SilenceService({ paths: { dataDir: tmp }, getSettings: () => ({ useHardwareAcceleration: false }) });
const durationOf = (f) => parseFloat(spawnSync(ffprobeExe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f], { encoding: 'utf8' }).stdout);

test('calculateKeepSegments (comportamento original)', () => {
  const svc = makeService();
  const sil = [{ start: 2, end: 4, duration: 2 }, { start: 6, end: 7, duration: 1 }];
  assert.deepStrictEqual(svc.calculateKeepSegments(10, sil, 'remove'), [
    { start: 0, end: 2 }, { start: 4, end: 6 }, { start: 7, end: 10 }
  ]);
  assert.deepStrictEqual(svc.calculateKeepSegments(10, sil, 'reduce10'), [
    { start: 0, end: 2.5 }, { start: 3.5, end: 6.5 }, { start: 6.5, end: 10 }
  ]);
});

test('_buildGraph: offset subtraído (blocos) e áudio-only sem ramo de vídeo', () => {
  const svc = makeService();
  const segs = [{ start: 100, end: 101.5 }, { start: 103, end: 104 }];
  const g = svc._buildGraph(segs, true, 100);
  assert.ok(g.includes('[0:v]trim=start=0.000000:end=1.500000,setpts=PTS-STARTPTS[v0]'));
  assert.ok(g.includes('[0:a]atrim=start=3.000000:end=4.000000,asetpts=PTS-STARTPTS[a1]'));
  assert.ok(g.endsWith('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vfinal][afinal]'));
  const a = svc._buildGraph(segs, false);
  assert.ok(!a.includes('[0:v]'));
  assert.ok(a.endsWith('[a0][a1]concat=n=2:v=0:a=1[afinal]'));
});

test('analyzeSilence em vídeo: -vn/-map 0:a:0 e parse em streaming', { skip: !hasTools && 'data/ffmpeg ausente' }, async () => {
  const media = path.join(tmp, 'v.mp4');
  const r = spawnSync(ffmpegExe, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=15:d=12',
    '-f', 'lavfi', '-i', "sine=f=440:r=48000:d=12,volume='lt(mod(t,3),2)':eval=frame",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', media]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const sil = await makeService().analyzeSilence(media, -30, 0.3);
  assert.ok(sil.length >= 3 && sil.length <= 4, `silêncios detectados: ${sil.length}`);
  for (const s of sil) assert.ok(s.end > s.start && Math.abs(s.duration - (s.end - s.start)) < 1e-6);
  assert.ok(Math.abs(sil[0].start - 2) < 0.2 && Math.abs(sil[0].end - 3) < 0.2);
});

test('corte de arquivo SÓ de áudio funciona (passada única)', { skip: !hasTools && 'data/ffmpeg ausente' }, async () => {
  const media = path.join(tmp, 'a.wav');
  spawnSync(ffmpegExe, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "sine=f=440:r=22050:d=20,volume='lt(mod(t,4),3)':eval=frame", media]);
  const out = path.join(tmp, 'out1');
  const svc = makeService();
  let finished;
  svc.on('finished', (f) => { finished = f; });
  await svc.processQueue({ files: [media], threshold: -30, minDuration: 0.3, mode: 'remove', outFolder: out });
  assert.strictEqual(finished.status, 'success', JSON.stringify(finished));
  const res = path.join(out, 'a_semsilencio.wav');
  assert.ok(fs.existsSync(res));
  // 20 s com 1 s de silêncio a cada 4 s (5 silêncios) => ~15 s
  const d = durationOf(res);
  assert.ok(Math.abs(d - 15) < 0.6, `duração ${d}`);
});

test('muitos trechos (> 60) usam blocos + concat e preservam a duração esperada', { skip: !hasTools && 'data/ffmpeg ausente' }, async () => {
  const media = path.join(tmp, 'many.wav');
  // 150 s, silêncio de 0.5 s a cada 2 s => 75 silêncios / 76 trechos
  spawnSync(ffmpegExe, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "sine=f=440:r=22050:d=150,volume='lt(mod(t,2),1.5)':eval=frame", media]);
  const svc = makeService();
  const logs = [];
  svc.on('log', (l) => logs.push(l));
  let finished;
  svc.on('finished', (f) => { finished = f; });
  const chunkSpy = svc._cutInChunks.bind(svc);
  let usedChunks = 0;
  svc._cutInChunks = (...a) => { usedChunks++; return chunkSpy(...a); };

  const out = path.join(tmp, 'out2');
  await svc.processQueue({ files: [media], threshold: -30, minDuration: 0.3, mode: 'remove', outFolder: out });
  assert.strictEqual(finished.status, 'success', JSON.stringify(finished));
  assert.strictEqual(usedChunks, 1, 'caminho em blocos acionado');
  assert.ok(!logs.join('').includes('Corte em blocos falhou'), 'não caiu no fallback de passada única');
  const d = durationOf(path.join(out, 'many_semsilencio.wav'));
  // 75 silêncios de 0.5 s removidos de 150 s => ~112.5 s (tolerância de 1 frame de áudio por junção)
  assert.ok(Math.abs(d - 112.5) < 1.5, `duração ${d}`);
});
