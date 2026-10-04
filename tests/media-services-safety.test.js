'use strict';
// Remover Silêncio / Conversor / Montagem: erros, arquivos problemáticos, nomes únicos (RK-017/030/031/032/109/110/111).
// Usa o ffmpeg/ffprobe reais quando existem (data/ ou %LOCALAPPDATA%\ffmpeg\bin); sem eles, só roda os testes sem mídia.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-safety-'));
process.env.BMD_LOGS_DIR = path.join(tmp, 'logs');

const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);
const candidates = [
  path.join(__dirname, '..', 'data'),
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ffmpeg', 'bin') : null
].filter(Boolean);
const toolsDir = candidates.find((d) => fs.existsSync(path.join(d, exe('ffmpeg'))) && fs.existsSync(path.join(d, exe('ffprobe'))));
const ffmpegExe = toolsDir && path.join(toolsDir, exe('ffmpeg'));
const ffprobeExe = toolsDir && path.join(toolsDir, exe('ffprobe'));
const hasTools = !!toolsDir;

const hardwareDetection = require('../src/core/HardwareDetectionService');
const { ffmpegTool } = require('../src/infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../src/infrastructure/external-tools/adapters/FfprobeTool');
const { processRunner } = require('../src/infrastructure/external-tools/ProcessRunner');
const { uniqueOutputPath, isSamePath } = require('../src/services/uniquePath');
const SilenceService = require('../src/services/silenceService');
const ConverterService = require('../src/services/converterService');
const MontageService = require('../src/services/montageService');

const realFfmpegResolve = ffmpegTool.resolve;
const realFfprobeResolve = ffprobeTool.resolve;
const realDetect = hardwareDetection.detectEncoder;
const realSpawn = processRunner.spawn;

test.beforeEach(() => {
  ffmpegTool.resolve = hasTools ? () => ffmpegExe : realFfmpegResolve;
  ffprobeTool.resolve = hasTools ? () => ffprobeExe : realFfprobeResolve;
  hardwareDetection.detectEncoder = async () => 'libx264';
  processRunner.spawn = realSpawn;
});
test.after(() => {
  ffmpegTool.resolve = realFfmpegResolve;
  ffprobeTool.resolve = realFfprobeResolve;
  hardwareDetection.detectEncoder = realDetect;
  processRunner.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mkdir = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };
const gen = (args) => {
  const r = spawnSync(ffmpegExe, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, String(r.stderr));
};
const SINE_GAPS = "sine=f=440:r=44100:d=9,volume='lt(mod(t,3),2)':eval=frame"; // 1 s de silêncio a cada 3 s
const probeJson = (f) => JSON.parse(spawnSync(ffprobeExe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f], { encoding: 'utf8' }).stdout);
const makeSilence = () => new SilenceService({ paths: {}, getSettings: () => ({ useHardwareAcceleration: false }) });
const runSilence = (svc, config) => new Promise((resolve) => {
  const events = [];
  svc.on('progress', (p) => events.push(p));
  svc.once('finished', (p) => resolve({ finished: p, events }));
  svc.processQueue(config);
});

// ---------------------------------------------------------------- uniquePath
test('uniqueOutputPath: nome livre, "(2)", "(3)", origem e reservados', () => {
  const d = mkdir('unique');
  assert.strictEqual(uniqueOutputPath(d, 'a.mp4'), path.join(d, 'a.mp4'));
  fs.writeFileSync(path.join(d, 'a.mp4'), 'x');
  assert.strictEqual(uniqueOutputPath(d, 'a.mp4'), path.join(d, 'a (2).mp4'));
  fs.writeFileSync(path.join(d, 'a (2).mp4'), 'x');
  assert.strictEqual(uniqueOutputPath(d, 'a.mp4'), path.join(d, 'a (3).mp4'));
  // arquivo de origem (ainda inexistente em disco) também é evitado, sem diferenciar maiúsculas
  assert.strictEqual(uniqueOutputPath(d, 'b.mp4', { avoid: [path.join(d, 'B.MP4')] }), path.join(d, 'b (2).mp4'));
  const reserved = new Set();
  assert.strictEqual(uniqueOutputPath(d, 'c.mp4', { reserved }), path.join(d, 'c.mp4'));
  assert.strictEqual(uniqueOutputPath(d, 'c.mp4', { reserved }), path.join(d, 'c (2).mp4'));
  assert.ok(isSamePath(path.join(d, 'x.mp4'), path.join(d, '.', 'X.MP4')));
});

// ---------------------------------------------------------------- Silêncio: RK-109 / RK-010
test('silêncio: ffmpeg não encontrado vira "finished" com erro e libera o serviço (RK-109)', async () => {
  const svc = makeSilence();
  ffmpegTool.resolve = () => { throw new Error('FFmpeg não encontrado'); };
  const { finished } = await runSilence(svc, { files: ['x.mp4'], threshold: -30, minDuration: 0.5, mode: 'remove', outFolder: tmp });
  assert.strictEqual(finished.status, 'error');
  assert.match(finished.error, /FFmpeg/);
  assert.strictEqual(svc.running, false);
});

test('silêncio: limiar e duração inválidos são recusados (RK-010)', async () => {
  const svc = makeSilence();
  for (const bad of [{ threshold: 'abc', minDuration: 0.5 }, { threshold: 10, minDuration: 0.5 }, { threshold: -30, minDuration: 'x' }, { threshold: -30, minDuration: 0 }]) {
    const { finished } = await runSilence(svc, { files: ['x.mp4'], mode: 'remove', outFolder: tmp, ...bad });
    assert.strictEqual(finished.status, 'error', JSON.stringify(bad));
    assert.strictEqual(svc.running, false);
  }
  await assert.rejects(makeSilence().analyzeSilence('x.mp4', '-30;rm', 0.5), /inválida/);
});

// ---------------------------------------------------------------- Silêncio: RK-030 / RK-031 / RK-017 (mídia real)
test('silêncio: lote misto (capa, webm, sem áudio, todo silencioso, ausente) pula com aviso e segue', { skip: !hasTools && 'ffmpeg ausente' }, async () => {
  const src = mkdir('sil-src');
  const out = mkdir('sil-out');
  const cover = path.join(src, 'capa.mp3');
  gen(['-f', 'lavfi', '-i', SINE_GAPS, '-f', 'lavfi', '-i', 'testsrc=s=64x64:d=1', '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', cover]);
  assert.ok(probeJson(cover).streams.some((s) => s.codec_type === 'video'), 'mp3 de teste tem capa');
  const webmAudio = path.join(src, 'voz.webm');
  gen(['-f', 'lavfi', '-i', SINE_GAPS, '-c:a', 'libopus', webmAudio]);
  const webmVideo = path.join(src, 'tela.webm');
  gen(['-f', 'lavfi', '-i', 'testsrc=s=160x120:r=10:d=9', '-f', 'lavfi', '-i', SINE_GAPS, '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus', '-shortest', webmVideo]);
  const noAudio = path.join(src, 'mudo.mp4');
  gen(['-f', 'lavfi', '-i', 'testsrc=s=160x120:r=10:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-an', noAudio]);
  const allSilent = path.join(src, 'tudo-silencio.wav');
  gen(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '4', allSilent]);
  const missing = path.join(src, 'nao-existe.mp3');
  const plain = path.join(src, 'normal.wav');
  gen(['-f', 'lavfi', '-i', SINE_GAPS, plain]);
  // já existe um arquivo com o nome de saída: não pode ser sobrescrito
  fs.writeFileSync(path.join(out, 'normal_semsilencio.wav'), 'NAO-APAGAR');

  const svc = makeSilence();
  const files = [cover, webmAudio, webmVideo, noAudio, allSilent, missing, plain];
  const { finished, events } = await runSilence(svc, { files, threshold: -30, minDuration: 0.3, mode: 'remove', outFolder: out });

  assert.strictEqual(finished.status, 'partial', JSON.stringify(finished));
  assert.strictEqual(finished.processedCount, 4, JSON.stringify(finished));
  assert.strictEqual(finished.skipped.length, 3);
  assert.strictEqual(finished.failed.length, 0, JSON.stringify(finished.failed));
  const skippedNames = finished.skipped.map((s) => path.basename(s.file)).sort();
  assert.deepStrictEqual(skippedNames, ['mudo.mp4', 'nao-existe.mp3', 'tudo-silencio.wav']);
  assert.ok(events.some((e) => e.status === 'Ignorado' && e.message));
  assert.ok(events.some((e) => e.status === 'Concluído'));

  const names = fs.readdirSync(out).sort();
  assert.ok(names.includes('capa_semsilencio.mp3'), names.join());
  assert.ok(names.includes('voz_semsilencio.webm'), names.join());
  assert.ok(names.includes('tela_semsilencio.mp4'), `vídeo .webm sai como .mp4: ${names.join()}`);
  assert.ok(names.includes('normal_semsilencio (2).wav'), `colisão vira (2): ${names.join()}`);
  assert.strictEqual(fs.readFileSync(path.join(out, 'normal_semsilencio.wav'), 'utf8'), 'NAO-APAGAR');
  // o silêncio saiu: saída mais curta que a origem (9 s)
  const d = parseFloat(probeJson(path.join(out, 'capa_semsilencio.mp3')).format.duration);
  assert.ok(d < 8 && d > 4, `duração ${d}`);
  assert.strictEqual(svc.running, false);
});

test('silêncio: silêncio até o fim do arquivo também é removido', { skip: !hasTools && 'ffmpeg ausente' }, async () => {
  const src = mkdir('sil-tail');
  const out = mkdir('sil-tail-out');
  const f = path.join(src, 'cauda.wav');
  gen(['-f', 'lavfi', '-i', "sine=f=440:r=44100:d=8,volume='lt(t,3)':eval=frame", f]);
  const { finished } = await runSilence(makeSilence(), { files: [f], threshold: -30, minDuration: 0.5, mode: 'remove', outFolder: out });
  assert.strictEqual(finished.status, 'success', JSON.stringify(finished));
  const d = parseFloat(probeJson(path.join(out, 'cauda_semsilencio.wav')).format.duration);
  assert.ok(d < 4, `cauda de silêncio removida (duração ${d})`);
});

test('silêncio: todos os arquivos com problema => status "error" com mensagem (RK-030)', { skip: !hasTools && 'ffmpeg ausente' }, async () => {
  const src = mkdir('sil-bad');
  const f = path.join(src, 'mudo.mp4');
  gen(['-f', 'lavfi', '-i', 'testsrc=s=160x120:r=10:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-an', f]);
  const { finished } = await runSilence(makeSilence(), { files: [f], threshold: -30, minDuration: 0.5, mode: 'remove', outFolder: mkdir('sil-bad-out') });
  assert.strictEqual(finished.status, 'error');
  assert.match(finished.error, /sem faixa de áudio|áudio/);
});

test('silêncio: a saída nunca coincide com a origem (mesma pasta)', { skip: !hasTools && 'ffmpeg ausente' }, async () => {
  const src = mkdir('sil-same');
  const f = path.join(src, 'a_semsilencio.wav');
  gen(['-f', 'lavfi', '-i', SINE_GAPS, f]);
  const before = fs.statSync(f).size;
  const { finished } = await runSilence(makeSilence(), { files: [f], threshold: -30, minDuration: 0.3, mode: 'remove', outFolder: src, outFileName: 'a_semsilencio' });
  assert.strictEqual(finished.status, 'success');
  assert.strictEqual(fs.statSync(f).size, before, 'origem intacta');
  assert.ok(fs.existsSync(path.join(src, 'a_semsilencio (2).wav')));
});

// ---------------------------------------------------------------- Conversor
function makeConverter() {
  return new ConverterService({ paths: {}, getSettings: () => ({ useHardwareAcceleration: false }), historyService: { addConversion() {} } });
}
const touch = (dir, name) => { const p = path.join(dir, name); fs.writeFileSync(p, 'x'); return p; };

test('conversor: remover por id e alinhar a ordem da tela com a fila (RK-032)', () => {
  const d = mkdir('conv-q');
  const svc = makeConverter();
  svc._prefetchDurations = () => {};
  const r = svc.addFiles([touch(d, 'a.mp4'), touch(d, 'b.mp4'), touch(d, 'c.mp4')]);
  const [a, b, c] = r.items;
  svc._syncOrder([String(c.id), String(a.id), String(b.id)]);
  assert.deepStrictEqual(svc.getQueue().map((i) => path.basename(i.file)), ['c.mp4', 'a.mp4', 'b.mp4']);
  assert.deepStrictEqual(svc.removeFile(String(a.id)), { ok: true, removed: 1 });
  assert.deepStrictEqual(svc.getQueue().map((i) => path.basename(i.file)), ['c.mp4', 'b.mp4']);
  // item que a tela não mostra mais é descartado ao iniciar
  svc._syncOrder([String(b.id)]);
  assert.strictEqual(svc.getQueue().length, 1);
  svc.running = true;
  assert.throws(() => svc.removeFile(String(b.id)), /durante uma conversão/);
  assert.throws(() => svc.clearQueue(), /durante uma conversão/);
});

test('conversor: H.265 leva -tag:v hvc1 e a repetição por software não leva -hwaccel (RK-111)', () => {
  const svc = makeConverter();
  svc.hwEnabled = true;
  const item = { file: path.join(tmp, 'in.mkv'), output: path.join(tmp, 'out.mp4'), outputType: 'mp4' };
  const cfg = { videoCodec: 'libx265', format: 'mp4' };
  const hw = svc._buildArgs(item, cfg, 'hevc_nvenc');
  assert.ok(hw.includes('-hwaccel'));
  assert.strictEqual(hw[hw.indexOf('-tag:v') + 1], 'hvc1');
  const sw = svc._buildArgs(item, cfg, 'libx265', { noHwaccel: true });
  assert.ok(!sw.includes('-hwaccel'));
  assert.strictEqual(sw[sw.indexOf('-tag:v') + 1], 'hvc1');
  assert.ok(!svc._buildArgs(item, { videoCodec: 'libx264', format: 'mp4' }, 'libx264').includes('-tag:v'));
});

test('conversor: ETA do lote usa só pendentes e erros não travam o geral (RK-111)', () => {
  const svc = makeConverter();
  const mk = (id, status, duration, progress = 0) => ({ id, status, duration, progress });
  const cur = Object.assign(mk(2, 'Convertendo', 100, 50), { startedAt: Date.now() - 60000 });
  svc.queue = [mk(1, 'Concluído', 100, 100), cur, mk(3, 'Pendente', 100), mk(4, 'Erro', 100)];
  svc.currentItem = cur;
  const events = [];
  svc.on('overallProgress', (p) => events.push(p));
  svc._lastOverallProgressEmit = 0;
  svc._emitOverallProgress();
  const p = events[0];
  assert.strictEqual(p.total, 400);
  assert.strictEqual(p.completed, 250); // concluído + erro + metade do atual
  // atual: 60 s para 50% => 60 s restantes; 1 pendente de 100 s na mesma velocidade (50 s de vídeo em 60 s) => +120 s
  assert.ok(Math.abs(p.remainingSeconds - 180) < 2, `ETA ${p.remainingSeconds}`);
});

test('conversor: nunca sobrescreve e a saída nunca é a origem (RK-017) + erro por arquivo não derruba a fila', async () => {
  const d = mkdir('conv-out');
  const svc = makeConverter();
  svc._prefetchDurations = () => {};
  const x = touch(d, 'x.mp4'); // origem .mp4 -> saída .mp4 na MESMA pasta
  const y = touch(d, 'y.mp4');
  fs.writeFileSync(path.join(d, 'y (2).mp4'), 'EXISTENTE');
  svc.addFiles([x, y]);
  const outputs = [];
  svc._runEncode = async (item) => { outputs.push(item.output); fs.writeFileSync(item.output, 'novo'); return { code: 0, stderr: '' }; };
  svc.getVideoDuration = async () => 10;
  const finished = new Promise((r) => svc.once('finished', r));
  await svc.start({ format: 'mp4', videoCodec: 'libx264', outFolder: d });
  const f = await finished;
  assert.strictEqual(f.status, 'success');
  assert.deepStrictEqual(outputs.map((o) => path.basename(o)), ['x (2).mp4', 'y (3).mp4']);
  assert.strictEqual(fs.readFileSync(x, 'utf8'), 'x');
  assert.strictEqual(fs.readFileSync(path.join(d, 'y (2).mp4'), 'utf8'), 'EXISTENTE');

  // erro em um arquivo: o outro segue
  const e1 = touch(d, 'e1.mp4');
  const e2 = touch(d, 'e2.mp4');
  const svc2 = makeConverter();
  svc2._prefetchDurations = () => {};
  svc2.addFiles([e1, e2]);
  svc2.getVideoDuration = async () => 10;
  svc2._runEncode = async (item) => (item.file === e1 ? { code: 1, stderr: 'boom' } : (fs.writeFileSync(item.output, 'ok'), { code: 0, stderr: '' }));
  const fin2 = new Promise((r) => svc2.once('finished', r));
  await svc2.start({ format: 'mp4', videoCodec: 'libx264', outFolder: d });
  const f2 = await fin2;
  assert.strictEqual(f2.status, 'partial');
  assert.strictEqual(f2.done, 1);
  assert.strictEqual(f2.failed, 1);
});

// ---------------------------------------------------------------- Montagem
function captureMontage(svc, config, probes) {
  ffmpegTool.resolve = () => 'ffmpeg-fake';
  svc.probeFile = async (p) => {
    const info = probes[path.basename(p)];
    if (!info) throw new Error('probe inesperado');
    return info;
  };
  let captured = null;
  processRunner.spawn = (_exe, args) => {
    captured = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  return svc.runSingleRender(config).then(() => captured);
}

test('montagem: entrada sem áudio ganha anullsrc, arquivo ausente e duração 0 falham, saída é única (RK-110/RK-017)', async () => {
  const d = mkdir('mont');
  const svc = new MontageService({ paths: {}, getSettings: () => ({ useHardwareAcceleration: false }) });
  const main = touch(d, 'main.mp4');
  const intro = touch(d, 'intro.mp4');
  const outPath = path.join(d, 'saida.mp4');
  fs.writeFileSync(outPath, 'EXISTENTE');
  const cfg = { introPath: intro, mainPath: main, mainCutStart: 0, mainCutDuration: 10, resolution: '720p', fps: '30', codec: 'H.264', quality: 'Alta', outputPath: outPath, totalDuration: 10 };
  const probes = { 'main.mp4': { duration: 60, hasAudio: true }, 'intro.mp4': { duration: 5, hasAudio: false } };
  const args = await captureMontage(svc, cfg, probes);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.ok(graph.includes('anullsrc=r=48000:cl=stereo,atrim=duration=5.000'), graph);
  assert.ok(graph.includes('[1:a]aformat'));
  assert.strictEqual(args[args.length - 1], path.join(d, 'saida (2).mp4'));
  assert.strictEqual(fs.readFileSync(outPath, 'utf8'), 'EXISTENTE');

  await assert.rejects(captureMontage(svc, { ...cfg, mainPath: path.join(d, 'sumiu.mp4') }, probes), /não encontrado/);
  await assert.rejects(captureMontage(svc, cfg, { ...probes, 'main.mp4': { duration: 0, hasAudio: true } }), /Duração desconhecida/);
  await assert.rejects(captureMontage(svc, { ...cfg, mainCutStart: 90 }, probes), /além do fim/);
  // saída igual a uma entrada nunca é usada
  const args2 = await captureMontage(svc, { ...cfg, outputPath: main }, probes);
  assert.notStrictEqual(args2[args2.length - 1], main);
});
