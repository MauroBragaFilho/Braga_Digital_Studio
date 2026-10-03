'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-montage-'));
process.env.BMD_LOGS_DIR = path.join(tmp, 'logs');

const hardwareDetection = require('../src/core/HardwareDetectionService');
const { ffmpegTool } = require('../src/infrastructure/external-tools/adapters/FfmpegTool');
const { processRunner } = require('../src/infrastructure/external-tools/ProcessRunner');
const MontageService = require('../src/services/montageService');

const realSpawn = processRunner.spawn;
const realResolve = ffmpegTool.resolve;
const realDetect = hardwareDetection.detectEncoder;

test.after(() => {
  processRunner.spawn = realSpawn;
  ffmpegTool.resolve = realResolve;
  hardwareDetection.detectEncoder = realDetect;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function capture(svc, config, { stderr = '', code = 0 } = {}) {
  ffmpegTool.resolve = () => 'ffmpeg-fake';
  hardwareDetection.detectEncoder = async () => 'libx264';
  let captured = null;
  let child;
  processRunner.spawn = (exe, args) => {
    captured = args;
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  };
  return svc.runSingleRender(config).then(() => captured, (e) => { e.args = captured; throw e; });
}

const files = {};
for (const n of ['intro', 'main', 'outro']) {
  files[n] = path.join(tmp, `${n}.mp4`);
  fs.writeFileSync(files[n], 'x');
}

test('corte do principal vai como -ss/-t na ENTRADA, não como trim no filtro', async () => {
  const svc = new MontageService({ paths: {}, getSettings: () => ({ useHardwareAcceleration: false }) });
  const args = await capture(svc, {
    introPath: files.intro, mainPath: files.main, outroPath: files.outro,
    mainCutStart: 10, mainCutDuration: 12, resolution: '720p', fps: '30', codec: 'H.264', quality: 'Alta',
    outputPath: path.join(tmp, 'out.mp4'), totalDuration: 22
  });
  assert.deepStrictEqual(args.slice(0, 5), ['-y', '-nostdin', '-hide_banner', '-loglevel', 'warning']);
  const joined = args.join('|');
  assert.ok(joined.includes(`-ss|10|-t|12|-i|${files.main}`), joined);
  // intro e outro sem corte
  assert.ok(joined.includes(`-i|${files.intro}`) && !joined.includes(`|-ss|10|-t|12|-i|${files.intro}`));
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.ok(!/trim/.test(graph), 'sem trim/atrim no filtergraph');
  assert.ok(graph.includes('[1:v]scale=1280:720'));
  assert.ok(graph.endsWith('concat=n=3:v=1:a=1[vfinal][afinal]'));
});

test('sem início/duração não adiciona -ss/-t', async () => {
  const svc = new MontageService({ paths: {}, getSettings: () => ({ useHardwareAcceleration: false }) });
  const args = await capture(svc, {
    mainPath: files.main, mainCutStart: 0, mainCutDuration: 0, resolution: '1080p', fps: 'Manter original',
    codec: 'H.264', quality: 'Alta', outputPath: path.join(tmp, 'out2.mp4'), totalDuration: 30
  });
  assert.ok(!args.includes('-ss') && !args.includes('-t'));
});

test('erro do ffmpeg traz o final do stderr e o stderr é limitado', async () => {
  const svc = new MontageService({ paths: {}, getSettings: () => ({}) });
  await assert.rejects(
    capture(svc, {
      mainPath: files.main, mainCutStart: 0, mainCutDuration: 5, resolution: '720p', fps: '30', codec: 'H.264',
      quality: 'Alta', outputPath: path.join(tmp, 'out3.mp4'), totalDuration: 5
    }, { stderr: 'a'.repeat(50000) + 'FALHA-FINAL', code: 1 }),
    (err) => /código 1/.test(err.message) && err.message.includes('FALHA-FINAL') && err.message.length < 500
  );
});

test('log da UI é agrupado (throttle) em vez de uma emissão por chunk', async () => {
  const svc = new MontageService({ paths: {}, getSettings: () => ({}) });
  const logs = [];
  svc.on('log', (l) => logs.push(l));
  ffmpegTool.resolve = () => 'ffmpeg-fake';
  hardwareDetection.detectEncoder = async () => 'libx264';
  processRunner.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      for (let i = 0; i < 20; i++) child.stderr.emit('data', Buffer.from(`linha ${i}\n`));
      child.emit('close', 0);
    });
    return child;
  };
  await svc.runSingleRender({
    mainPath: files.main, mainCutStart: 0, mainCutDuration: 5, resolution: '720p', fps: '30', codec: 'H.264',
    quality: 'Alta', outputPath: path.join(tmp, 'out4.mp4'), totalDuration: 5
  });
  assert.strictEqual(logs.length, 1);
  assert.ok(logs[0].includes('linha 0') && logs[0].includes('linha 19'));
});
