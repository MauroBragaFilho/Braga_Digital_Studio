'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WhisperCppRunner } = require('../src/core/modules/WhisperCppRunner');

const FAKE_CLI = path.join(__dirname, 'fixtures', 'fake-whisper-cli.js');
const FAKE_FFMPEG = path.join(__dirname, 'fixtures', 'fake-ffmpeg.js');

/** Pasta de dados "do usuário" com acentos, modelo, motor de CPU e um vídeo de mentira de 12 s. */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-açãõ-'));
  const whisper = path.join(root, 'whisper');
  const modelDir = path.join(whisper, 'models', 'large-v3-turbo');
  const engineDir = path.join(whisper, 'engine');
  for (const d of [modelDir, engineDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'model.bin'), 'modelo');
  fs.writeFileSync(path.join(engineDir, 'whisper-cli.exe'), 'x');
  const media = path.join(root, 'aula 01.mp4');
  fs.writeFileSync(media, 'SECONDS=12');
  const record = path.join(root, 'record.jsonl');
  const work = path.join(whisper, 'work');
  const make = (cfg = {}) => new WhisperCppRunner({
    engineDir, cudaDir: null, tempDir: path.join(root, 'tmp'), workRoot: work,
    ffmpegPath: process.execPath, ffmpegBaseArgs: [FAKE_FFMPEG], cliCommand: process.execPath, cliBaseArgs: [FAKE_CLI], ...cfg
  });
  const calls = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { root, whisper, modelDir, engineDir, media, work, make, calls, record };
}

/** Roda `fn` com variáveis de ambiente temporárias (o executor repassa o ambiente ao whisper-cli). */
async function withEnv(vars, fn) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const ctx = (s, extra = {}) => ({ modelDir: s.modelDir, modelId: 'large-v3-turbo', modelName: 'large-v3-turbo', ...extra });
const exists = (...p) => fs.existsSync(path.join(...p));

test('transcreve: gera .srt e .md ao lado do arquivo e nunca sobrescreve (aula 01 (2).srt)', async () => {
  const s = setup();
  const res = await withEnv({ FAKE_RECORD: s.record }, () => s.make().run({ files: [s.media], srt: true, md: true }, ctx(s)));
  assert.deepEqual([res.ok, res.failed, res.errors], [1, 0, []]);
  assert.deepEqual(res.outputs.map((o) => [o.kind, path.basename(o.path)]), [['srt', 'aula 01.srt'], ['md', 'aula 01.md']]);
  assert.ok(res.outputs.every((o) => o.source === s.media));

  const srt = fs.readFileSync(path.join(s.root, 'aula 01.srt'), 'utf8');
  assert.match(srt, /^1\n00:00:00,\d{3} --> 00:00:\d{2},\d{3}\n/);
  assert.match(srt, /Bom dia, pessoal\./);
  const md = fs.readFileSync(path.join(s.root, 'aula 01.md'), 'utf8');
  assert.ok(md.startsWith('# aula 01\n\nTranscrição automática (Whisper large-v3-turbo). Duração: 00:00:12\n\n**[00:00:00]** Bom dia, pessoal.\n\n'), md.slice(0, 160));

  const again = await withEnv({ FAKE_RECORD: s.record }, () => s.make().run({ files: [s.media], srt: true, md: true }, ctx(s)));
  assert.deepEqual(again.outputs.map((o) => path.basename(o.path)), ['aula 01 (2).srt', 'aula 01 (2).md']);
  assert.ok(exists(s.root, 'aula 01.srt'), 'a primeira legenda foi mantida');
});

test('o whisper-cli recebe a configuração validada e só caminhos relativos em ASCII (usuário com acento)', async () => {
  const s = setup();
  await withEnv({ FAKE_RECORD: s.record }, () => s.make().run({ files: [s.media], srt: true }, ctx(s)));
  const [call] = s.calls();
  const a = call.args;
  const val = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(val('-m'), path.join('..', '..', 'models', 'large-v3-turbo', 'model.bin'));
  assert.equal(val('-f'), 'audio.wav');
  assert.equal(val('-l'), 'pt');
  assert.equal(val('-of'), 'out');
  assert.deepEqual([val('-bs'), val('-bo'), val('-mc')], ['1', '1', '0']);
  assert.equal(val('-dtw'), 'large.v3.turbo');
  assert.ok(a.includes('-nfa') && a.includes('-ojf') && a.includes('-pp'));
  assert.ok(a.every((x) => /^[\x20-\x7e]+$/.test(x)), `argumento não ASCII: ${a.filter((x) => !/^[\x20-\x7e]+$/.test(x))}`);
  assert.equal(path.dirname(call.cwd), s.work, 'roda dentro da pasta de trabalho, ao lado dos modelos');
});

test('a pasta de trabalho é apagada ao terminar, com sucesso ou não', async () => {
  const s = setup();
  await s.make().run({ files: [s.media] }, ctx(s));
  assert.deepEqual(fs.readdirSync(s.work), []);
  const bad = path.join(s.root, 'ruim.mp4');
  fs.writeFileSync(bad, 'NOAUDIO');
  await s.make().run({ files: [bad] }, ctx(s));
  assert.deepEqual(fs.readdirSync(s.work), []);
});

test('eventos: andamento por arquivo e geral até 100%, dispositivo e frases de log', async () => {
  const s = setup();
  const events = [];
  await s.make().run({ files: [s.media], srt: true, md: true }, ctx(s, { onEvent: (e) => events.push(e) }));
  const file = events.filter((e) => e.type === 'file');
  assert.deepEqual(file.filter((e) => e.state !== 'progress').map((e) => [e.index, e.state]), [[0, 'start'], [0, 'done']]);
  const filePct = file.filter((e) => e.state === 'progress').map((e) => e.percent);
  assert.ok(filePct.length >= 3 && filePct.every((p, i) => i === 0 || p >= filePct[i - 1]), filePct.join(','));
  assert.equal(filePct[filePct.length - 1], 100);
  const overall = events.filter((e) => e.type === 'progress').map((e) => e.percent);
  assert.equal(overall[overall.length - 1], 100);
  assert.deepEqual(events.filter((e) => e.type === 'device').map((e) => e.text), ['CPU']);
  assert.ok(events.some((e) => e.type === 'line' && /Legenda criada: aula 01\.srt/.test(e.text)));
  assert.ok(events.some((e) => e.type === 'status' && /Transcrevendo aula 01\.mp4/.test(e.text)));
});

test('com a aceleração NVIDIA instalada usa a GPU; forçar a CPU liga o -ng', async () => {
  const s = setup();
  const cudaDir = path.join(s.whisper, 'cuda');
  fs.mkdirSync(cudaDir, { recursive: true });
  fs.writeFileSync(path.join(cudaDir, 'whisper-cli.exe'), 'x');

  const events = [];
  const gpu = await withEnv({ FAKE_GPU: '1', FAKE_RECORD: s.record }, () => s.make({ cudaDir }).run({ files: [s.media] }, ctx(s, { onEvent: (e) => events.push(e) })));
  assert.equal(gpu.device, 'GPU (CUDA)');
  assert.deepEqual(events.filter((e) => e.type === 'device').map((e) => e.text), ['GPU (CUDA)']);
  assert.equal(s.calls()[0].noGpu, false);

  fs.rmSync(s.record);
  const cpu = await withEnv({ FAKE_GPU: '1', FAKE_RECORD: s.record }, () => s.make({ cudaDir }).run({ files: [s.media], forceCpu: true }, ctx(s)));
  assert.equal(cpu.device, 'CPU');
  assert.equal(s.calls()[0].noGpu, true);
});

test('se a GPU falhar, repete na CPU e não insiste nela nos próximos arquivos', async () => {
  const s = setup();
  const cudaDir = path.join(s.whisper, 'cuda');
  fs.mkdirSync(cudaDir, { recursive: true });
  fs.writeFileSync(path.join(cudaDir, 'whisper-cli.exe'), 'x');
  const second = path.join(s.root, 'aula 02.mp4');
  fs.writeFileSync(second, 'SECONDS=8');

  const events = [];
  const res = await withEnv({ FAKE_GPU: '1', FAKE_FAIL_GPU: '1', FAKE_RECORD: s.record }, () => (
    s.make({ cudaDir }).run({ files: [s.media, second] }, ctx(s, { onEvent: (e) => events.push(e) }))));
  assert.deepEqual([res.ok, res.failed, res.device], [2, 0, 'CPU']);
  assert.deepEqual(s.calls().map((c) => c.noGpu), [false, true, true]); // 1º arquivo: GPU (falhou) e CPU; 2º: direto na CPU
  assert.ok(events.some((e) => e.type === 'line' && /A GPU não respondeu \(erro da placa de vídeo\); usando a CPU\./.test(e.text)), JSON.stringify(events.filter((e) => e.type === 'line')));
});

test('um arquivo ruim não derruba os demais: erro com o nome do arquivo', async () => {
  const s = setup();
  const bad = path.join(s.root, 'ruim.mp4');
  fs.writeFileSync(bad, 'NOAUDIO');
  const corrupt = path.join(s.root, 'quebrado.mp4');
  fs.writeFileSync(corrupt, 'CORRUPT');
  const events = [];
  const res = await s.make().run({ files: [bad, corrupt, s.media] }, ctx(s, { onEvent: (e) => events.push(e) }));
  assert.deepEqual([res.ok, res.failed], [1, 2]);
  assert.deepEqual(res.errors, [
    'ruim.mp4: O arquivo não tem faixa de áudio.',
    'quebrado.mp4: O ffmpeg não conseguiu ler o arquivo: Invalid data found when processing input'
  ]);
  assert.deepEqual(events.filter((e) => e.type === 'file' && (e.state === 'error' || e.state === 'done')).map((e) => [e.index, e.state]), [[0, 'error'], [1, 'error'], [2, 'done']]);
  assert.ok(exists(s.root, 'aula 01.srt'));
});

test('sem fala detectada: erro claro e nenhum arquivo criado', async () => {
  const s = setup();
  const empty = path.join(s.root, 'vazio.json');
  fs.writeFileSync(empty, JSON.stringify({ result: { language: 'pt' }, transcription: [] }));
  const res = await withEnv({ FAKE_JSON: empty }, () => s.make().run({ files: [s.media], md: true }, ctx(s)));
  assert.deepEqual(res.errors, ['aula 01.mp4: Nenhuma fala foi detectada no arquivo.']);
  assert.ok(!exists(s.root, 'aula 01.srt') && !exists(s.root, 'aula 01.md'));
});

test('saída em outra pasta (criada se preciso)', async () => {
  const s = setup();
  const outDir = path.join(s.root, 'legendas ção', 'nova');
  const res = await s.make().run({ files: [s.media], srt: true, md: true, outDir }, ctx(s));
  assert.deepEqual(res.outputs.map((o) => path.dirname(o.path)), [outDir, outDir]);
  assert.ok(exists(outDir, 'aula 01.srt') && exists(outDir, 'aula 01.md'));
  assert.ok(!exists(s.root, 'aula 01.srt'));
});

test('cancelar derruba o whisper-cli em andamento, rápido, sem deixar sobras', async () => {
  const s = setup();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1200);
  const started = Date.now();
  await assert.rejects(
    withEnv({ FAKE_SLEEP: '15000' }, () => s.make().run({ files: [s.media] }, ctx(s, { signal: controller.signal }))),
    (e) => e.code === 'CANCELLED'
  );
  assert.ok(Date.now() - started < 8000, 'demorou demais para cancelar');
  assert.deepEqual(fs.readdirSync(s.work), []);
  assert.ok(!exists(s.root, 'aula 01.srt'));
});

test('pré-requisitos: modelo, motor e ffmpeg ausentes dão erro específico', async () => {
  const s = setup();
  await assert.rejects(s.make().run({ files: [s.media] }, { modelDir: path.join(s.whisper, 'models', 'nada') }), (e) => e.code === 'NO_MODEL');
  const semMotor = new WhisperCppRunner({ engineDir: path.join(s.root, 'vazio'), tempDir: path.join(s.root, 'tmp'), ffmpegPath: process.execPath });
  await assert.rejects(semMotor.run({ files: [s.media] }, ctx(s)), (e) => e.code === 'NO_ENGINE');
  const semFfmpeg = new WhisperCppRunner({ engineDir: s.engineDir, tempDir: path.join(s.root, 'tmp') });
  await assert.rejects(semFfmpeg.run({ files: [s.media] }, ctx(s)), (e) => e.code === 'NO_FFMPEG');
  await assert.rejects(s.make().run({ files: [] }, ctx(s)), (e) => e.code === 'NO_FILES');
});

test('só o motor NVIDIA instalado (sem o de CPU): a CPU roda com -ng, sem exigir outro motor', async () => {
  const s = setup();
  const cudaDir = path.join(s.whisper, 'cuda');
  fs.mkdirSync(cudaDir, { recursive: true });
  fs.writeFileSync(path.join(cudaDir, 'whisper-cli.exe'), 'x');
  const runner = new WhisperCppRunner({
    engineDir: path.join(s.root, 'sem-motor-cpu'), cudaDir, tempDir: path.join(s.root, 'tmp'), workRoot: s.work,
    ffmpegPath: process.execPath, ffmpegBaseArgs: [FAKE_FFMPEG], cliCommand: process.execPath, cliBaseArgs: [FAKE_CLI]
  });
  const res = await withEnv({ FAKE_GPU: '1', FAKE_RECORD: s.record }, () => runner.run({ files: [s.media], forceCpu: true }, ctx(s)));
  assert.deepEqual([res.ok, res.device], [1, 'CPU']);
  assert.equal(s.calls()[0].noGpu, true);
});
