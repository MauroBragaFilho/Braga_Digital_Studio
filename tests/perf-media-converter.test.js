'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-conv-'));
process.env.BMD_LOGS_DIR = path.join(tmp, 'logs');

const hardwareDetection = require('../src/core/HardwareDetectionService');
const { ffmpegTool } = require('../src/infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../src/infrastructure/external-tools/adapters/FfprobeTool');
const { processRunner } = require('../src/infrastructure/external-tools/ProcessRunner');
const ConverterService = require('../src/services/converterService');

const realSpawn = processRunner.spawn;
const realResolveFfmpeg = ffmpegTool.resolve;
const realResolveFfprobe = ffprobeTool.resolve;
const realDetect = hardwareDetection.detectEncoder;

test.after(() => {
  processRunner.spawn = realSpawn;
  ffmpegTool.resolve = realResolveFfmpeg;
  ffprobeTool.resolve = realResolveFfprobe;
  hardwareDetection.detectEncoder = realDetect;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeService(settings = { useHardwareAcceleration: true }) {
  const history = [];
  const svc = new ConverterService({
    paths: {},
    getSettings: () => settings,
    historyService: { addConversion: (r) => history.push(r) }
  });
  svc.history = history;
  return svc;
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 1;
  return child;
}

test('_planEncoder: usa hardware só para libx264/libx265 com aceleração ativa', () => {
  const svc = makeService();
  svc.hwEnabled = true;
  svc.encoderH264 = 'h264_nvenc';
  svc.encoderH265 = 'hevc_nvenc';
  const item = { outputType: 'mp4' };
  assert.deepStrictEqual(svc._planEncoder(item, { videoCodec: 'libx264' }), { encoder: 'h264_nvenc', software: 'libx264', hardware: true });
  assert.deepStrictEqual(svc._planEncoder(item, { videoCodec: 'libx265' }), { encoder: 'hevc_nvenc', software: 'libx265', hardware: true });
  assert.strictEqual(svc._planEncoder({ outputType: 'mp3' }, {}).encoder, 'libmp3lame');
  svc.hwEnabled = false;
  assert.deepStrictEqual(svc._planEncoder(item, { videoCodec: 'libx264' }), { encoder: 'libx264', software: 'libx264', hardware: false });
  svc.hwEnabled = true;
  svc.encoderH264 = 'libx264'; // nada detectado
  assert.strictEqual(svc._planEncoder(item, { videoCodec: 'libx264' }).hardware, false);
});

test('_buildArgs: software mantém -crf/-preset; NVENC usa -cq e VBR com b:v 0', () => {
  const svc = makeService();
  svc.hwEnabled = true;
  const item = { file: 'in.mkv', output: 'out.mp4', outputType: 'mp4' };
  const sw = svc._buildArgs(item, { videoCodec: 'libx264', videoCrf: 20, preset: 'fast' }, 'libx264');
  assert.deepStrictEqual(sw.slice(0, 5), ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error']);
  assert.ok(sw.join(' ').includes('-c:v libx264 -preset fast -crf 20'));

  const hw = svc._buildArgs(item, { videoCodec: 'libx264', videoCrf: 20, preset: 'medium' }, 'h264_nvenc').join(' ');
  assert.ok(hw.includes('-c:v h264_nvenc -preset p5 -cq 20 -rc vbr -b:v 0'), hw);
  assert.ok(!hw.includes('-crf'));

  const hevc = svc._buildArgs(item, { videoCodec: 'libx265' }, 'hevc_nvenc').join(' ');
  assert.ok(hevc.includes('-cq 28'), 'CRF padrão do x265 (28) preservado');
});

test('_buildArgs: com bitrate fixo preserva -b:v/-maxrate e não envia crf/cq', () => {
  const svc = makeService();
  const item = { file: 'in.mkv', output: 'out.mp4', outputType: 'mp4' };
  const args = svc._buildArgs(item, { videoCodec: 'libx264', videoBitrate: '4M', videoResolution: '720', preset: 'medium' }, 'h264_nvenc');
  const joined = args.join(' ');
  assert.ok(joined.includes('-b:v 4M -maxrate 4M -bufsize 8M'));
  assert.ok(joined.includes('-vf scale=-2:720'));
  assert.ok(!joined.includes('-cq') && !joined.includes('-crf') && !joined.includes('-rc vbr'));
  assert.ok(joined.includes('-preset p5'));
});

test('_buildArgs: mp3 ignora vídeo', () => {
  const svc = makeService();
  const args = svc._buildArgs({ file: 'a.mkv', output: 'a.mp3', outputType: 'mp3' }, { audioBitrate: '128k' }, 'libmp3lame').join(' ');
  assert.ok(args.includes('-vn -c:a libmp3lame -b:a 128k'));
});

test('progresso: linhas parciais acumuladas, último out_time_ms do chunk, throttle e stderr limitado', async () => {
  const svc = makeService();
  const item = { id: 7, file: 'in.mp4', progress: 0 };
  const child = fakeChild();
  processRunner.spawn = () => child;
  const events = [];
  svc.on('progress', (p) => events.push(p));
  svc.on('queue', () => events.push('QUEUE'));

  const promise = svc._runEncode(item, 'ffmpeg', [], 100);
  // chunk 1: dois valores; vale o último (40 s). A linha out_time_ms=5... fica cortada no fim.
  child.stdout.emit('data', Buffer.from('out_time_ms=10000000\nspeed=2.0x\nout_time_ms=40000000\nprogress=continue\nout_time_ms=5'));
  assert.strictEqual(item.progress, 40);
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(Object.keys(events[0]).sort(), ['id', 'progress', 'remainingSeconds', 'status']);
  assert.strictEqual(events[0].id, 7);

  // chunk 2 completa a linha parcial (50 s), mas cai dentro da janela de throttle: sem novo evento
  child.stdout.emit('data', Buffer.from('0000000\nprogress=continue\n'));
  assert.strictEqual(item.progress, 50, 'progresso interno segue atualizado');
  assert.strictEqual(events.length, 1, 'emissão é limitada por throttle');
  assert.ok(!events.includes('QUEUE'), 'a fila inteira não é emitida em ticks de progresso');

  child.stderr.emit('data', Buffer.from('x'.repeat(20000) + 'ERRO-FINAL'));
  child.emit('close', 1);
  const result = await promise;
  assert.strictEqual(result.code, 1);
  assert.ok(result.stderr.length <= 8192);
  assert.ok(result.stderr.endsWith('ERRO-FINAL'));
});

test('fallback: falha do NVENC repete UMA vez com libx264 e o histórico registra o encoder real', async () => {
  const svc = makeService();
  svc.hwEnabled = true;
  svc.encoderH264 = 'h264_nvenc';
  svc.currentConfig = { format: 'mp4', outFolder: tmp, videoCodec: 'libx264', videoCrf: 23 };
  ffmpegTool.resolve = () => 'ffmpeg-fake';

  const input = path.join(tmp, 'clip.mp4');
  fs.writeFileSync(input, 'x');
  const item = { id: 1, file: input, status: 'Pendente', progress: 0, knownDuration: 10 };

  const encodeArgs = [];
  processRunner.spawn = (exe, args) => {
    const child = fakeChild();
    encodeArgs.push(args);
    const first = encodeArgs.length === 1;
    setImmediate(() => {
      if (first) child.stderr.emit('data', Buffer.from('Error while opening encoder: h264_nvenc'));
      child.emit('close', first ? 1 : 0);
    });
    return child;
  };

  const events = [];
  svc.on('fileFinished', (e) => events.push(e));
  await svc.convertItem(item);

  assert.strictEqual(encodeArgs.length, 2, 'uma única repetição');
  assert.ok(encodeArgs[0].includes('h264_nvenc'));
  assert.ok(encodeArgs[1].includes('libx264') && !encodeArgs[1].includes('h264_nvenc'));
  assert.strictEqual(item.status, 'Concluído');
  assert.ok(fs.existsSync(input), 'o arquivo de ORIGEM nunca é apagado pela limpeza do parcial');
  assert.notStrictEqual(item.output, input, 'saída igual à origem recebe outro nome');
  assert.strictEqual(item.encoder, 'libx264');
  assert.strictEqual(svc.history.length, 1);
  assert.strictEqual(svc.history[0].encoder, 'libx264');
  assert.deepStrictEqual(events, [{ id: 1, status: 'Concluído' }]);
});

test('sem falha: histórico registra o encoder de hardware usado', async () => {
  const svc = makeService();
  svc.hwEnabled = true;
  svc.encoderH264 = 'h264_nvenc';
  svc.currentConfig = { format: 'mp4', outFolder: tmp, videoCodec: 'libx264' };
  ffmpegTool.resolve = () => 'ffmpeg-fake';
  const input = path.join(tmp, 'clip2.mp4');
  fs.writeFileSync(input, 'x');
  const item = { id: 2, file: input, status: 'Pendente', progress: 0, knownDuration: 10 };
  processRunner.spawn = () => {
    const child = fakeChild();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  await svc.convertItem(item);
  assert.strictEqual(svc.history[0].encoder, 'h264_nvenc');
});

test('falha de software (sem hardware) não repete e propaga o erro', async () => {
  const svc = makeService();
  svc.hwEnabled = false;
  svc.currentConfig = { format: 'mp4', outFolder: tmp, videoCodec: 'libx264' };
  ffmpegTool.resolve = () => 'ffmpeg-fake';
  const input = path.join(tmp, 'clip3.mp4');
  fs.writeFileSync(input, 'x');
  const item = { id: 3, file: input, status: 'Pendente', progress: 0, knownDuration: 10 };
  let runs = 0;
  processRunner.spawn = () => {
    runs++;
    const child = fakeChild();
    setImmediate(() => { child.stderr.emit('data', Buffer.from('arquivo corrompido')); child.emit('close', 1); });
    return child;
  };
  await assert.rejects(svc.convertItem(item), /arquivo corrompido/);
  assert.strictEqual(runs, 1);
  assert.strictEqual(item.status, 'Erro');
});

test('addFiles aceita { path, duration } e reaproveita a duração informada', () => {
  const svc = makeService();
  const f = path.join(tmp, 'known.mp4');
  fs.writeFileSync(f, 'x');
  ffprobeTool.resolve = () => { throw new Error('ffprobe não deve ser chamado'); };
  const res = svc.addFiles([{ path: f, duration: 42.5 }]);
  assert.strictEqual(res.count, 1);
  assert.strictEqual(res.items[0].knownDuration, 42.5);
});
