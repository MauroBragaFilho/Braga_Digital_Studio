'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const AdmZip = require('adm-zip');

const { ModuleManager } = require('../src/core/modules/ModuleManager');

const FAKE_CLI = path.join(__dirname, 'fixtures', 'fake-whisper-cli.js');
const FAKE_FFMPEG = path.join(__dirname, 'fixtures', 'fake-ffmpeg.js');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const zipOf = (files) => { const z = new AdmZip(); for (const [name, content] of Object.entries(files)) z.addFile(name, Buffer.from(content)); return z.toBuffer(); };

// Pacotes e modelos de mentira, servidos como o GitHub e o Hugging Face servem os de verdade.
const CPU_ZIP = zipOf({ 'Release/whisper-cli.exe': 'cli-cpu', 'Release/ggml-base.dll': 'dll', 'Release/ggml.dll': 'dll' });
const CUDA_ZIP = zipOf({ 'Release/whisper-cli.exe': 'cli-cuda', 'Release/ggml-cuda.dll': 'cuda', 'Release/cublas64_12.dll': 'cublas' });
const CUDA_ZIP_BROKEN = zipOf({ 'Release/whisper-cli.exe': 'cli-cuda' }); // falta o ggml-cuda.dll
const MODELS = {
  'ggml-large-v3-turbo-q5_0.bin': Buffer.alloc(150000, 7),
  'ggml-base-q5_1.bin': Buffer.alloc(60000, 3)
};
const REVISION = 'rev123abc';

let server;
let base;
let hits;

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push(url.pathname);
    const send = (body, type = 'application/octet-stream') => { res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }); res.end(body); };
    if (url.pathname === '/ggml-org/whisper.cpp/releases/download/btest/whisper-bin-x64.zip') return send(CPU_ZIP);
    if (url.pathname === '/ggml-org/whisper.cpp/releases/download/btest/whisper-cuda.zip') return send(CUDA_ZIP);
    if (url.pathname === '/ggml-org/whisper.cpp/releases/download/btest/whisper-cuda-broken.zip') return send(CUDA_ZIP_BROKEN);
    if (url.pathname === '/api/models/ggerganov/whisper.cpp') {
      return send(JSON.stringify({
        id: 'ggerganov/whisper.cpp', sha: REVISION,
        siblings: Object.entries(MODELS).map(([name, buf]) => ({ rfilename: name, size: buf.length, lfs: { sha256: sha(buf) } }))
      }), 'application/json');
    }
    const m = new RegExp(`^/ggerganov/whisper\\.cpp/resolve/${REVISION}/(.+)$`).exec(url.pathname);
    if (m && MODELS[decodeURIComponent(m[1])]) return send(MODELS[decodeURIComponent(m[1])]);
    res.writeHead(404); res.end('nada');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); });

const release = (over = {}) => ({
  tag: 'btest',
  assets: {
    cpu: { label: 'Motor (CPU)', name: 'whisper-bin-x64.zip', size: CPU_ZIP.length, sha256: sha(CPU_ZIP), ...(over.cpu || {}) },
    cuda: { label: 'NVIDIA', name: 'whisper-cuda.zip', size: CUDA_ZIP.length, sha256: sha(CUDA_ZIP), cudaVersion: '12.4', ...(over.cuda || {}) }
  }
});

function manager(over = {}) {
  hits = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-mod-'));
  const mgr = new ModuleManager({
    rootDir: path.join(root, 'data'), tempDir: path.join(root, 'tmp'),
    config: { githubBaseUrl: base, huggingFaceBaseUrl: base, release: release(over.release), platform: 'win32', ...(over.config || {}) }
  });
  return { root, mgr, whisper: path.join(root, 'data', 'modules', 'whisper') };
}
const exists = (...p) => fs.existsSync(path.join(...p));

test('estado inicial: nada instalado e tudo opcional', async () => {
  const { mgr } = manager();
  const s = await mgr.getStatus();
  assert.equal(s.platformSupported, true);
  assert.equal(s.engineDownload, true);
  assert.equal(s.busy, null);
  const w = s.whisper;
  assert.deepEqual([w.engine.installed, w.cuda.installed, w.ready, w.activeModelId], [false, false, false, null]);
  assert.equal(w.engine.downloadBytes, CPU_ZIP.length);
  assert.equal(w.cuda.approxDownloadBytes, CUDA_ZIP.length);
  assert.ok(w.cuda.licenseLinks.length >= 1);
  assert.ok(w.models.length >= 5 && w.models.every((m) => !m.installed && m.sizeOnDisk === 0));
  assert.equal(w.defaultModelId, 'large-v3-turbo');
});

test('instala o motor da release oficial, confere o SHA-256 e deixa o whisper-cli em whisper/engine', async () => {
  const { mgr, whisper } = manager();
  const events = [];
  mgr.on('progress', (p) => events.push(p));
  const w = (await mgr.installEngine()).whisper;
  assert.equal(w.engine.installed, true);
  assert.deepEqual([w.engine.version, w.engine.source], ['btest', 'github']);
  assert.ok(exists(whisper, 'engine', 'whisper-cli.exe') && exists(whisper, 'engine', 'ggml.dll'), 'a pasta Release/ foi achatada');
  assert.ok(!exists(whisper, 'engine', 'Release'));
  assert.ok(events.some((e) => e.phase === 'download') && events[events.length - 1].phase === 'done');
  assert.equal((await mgr.getStatus()).busy, null);
});

test('SHA-256 divergente recusa o motor e não deixa nada instalado', async () => {
  const { mgr, whisper } = manager({ release: { cpu: { sha256: 'a'.repeat(64) } }, config: { downloadAttempts: 1 } });
  await assert.rejects(mgr.installEngine(), (e) => /checksum|sha|integridade|hash/i.test(`${e.code} ${e.message}`));
  assert.equal((await mgr.getStatus()).whisper.engine.installed, false);
  assert.ok(!exists(whisper, 'engine'));
});

test('instalar de um .zip local (offline) e recusar um .zip sem o whisper-cli', async () => {
  const { mgr, root } = manager();
  const good = path.join(root, 'motor.zip');
  fs.writeFileSync(good, CPU_ZIP);
  const w = (await mgr.installEngine({ zipPath: good })).whisper;
  assert.deepEqual([w.engine.installed, w.engine.source], [true, 'zip']);
  assert.equal(hits.length, 0, 'não deveria acessar a rede');

  const { mgr: other, root: root2 } = manager();
  const bad = path.join(root2, 'errado.zip');
  fs.writeFileSync(bad, zipOf({ 'Release/outro.exe': 'x' }));
  // .zip fora do SHA-256 fixado só chega à checagem de conteúdo se o usuário confirmar a origem não oficial
  await assert.rejects(other.installEngine({ zipPath: bad, confirmUnofficial: async () => true }), (e) => e.code === 'BAD_ZIP');
  await assert.rejects(other.installEngine({ zipPath: path.join(root2, 'nao-existe.zip') }), (e) => e.code === 'BAD_ZIP');
});

test('.zip local com SHA-256 diferente do fixado: recusa sem confirmação, instala com confirmação (RK-065)', async () => {
  const { mgr, root, whisper } = manager();
  const custom = path.join(root, 'motor-custom.zip');
  fs.writeFileSync(custom, zipOf({ 'whisper-cli.exe': 'cli-custom', 'ggml.dll': 'dll' }));

  await assert.rejects(mgr.installEngine({ zipPath: custom }), (e) => e.code === 'UNOFFICIAL_ZIP');
  assert.ok(!exists(whisper, 'engine'), 'nada instalado sem confirmação');
  await assert.rejects(mgr.installEngine({ zipPath: custom, confirmUnofficial: async () => false }), (e) => e.code === 'UNOFFICIAL_ZIP');

  let asked = null;
  const w = (await mgr.installEngine({ zipPath: custom, confirmUnofficial: async (info) => { asked = info; return true; } })).whisper;
  assert.equal(w.engine.installed, true);
  assert.equal(asked.sha256, sha(fs.readFileSync(custom)));
  assert.equal(hits.length, 0, 'não deveria acessar a rede');
});

test('modelo sem hash LFS na API do Hugging Face: falha fechado e não instala (RK-066)', async () => {
  const { mgr, whisper } = manager({ config: { downloadAttempts: 1 } });
  const original = mgr.hf.getModelFile.bind(mgr.hf);
  mgr.hf.getModelFile = async (...a) => { const r = await original(...a); r.file.sha256 = null; return r; };
  await assert.rejects(mgr.installModel('base'), (e) => e.code === 'NO_CHECKSUM');
  assert.ok(!exists(whisper, 'models', 'base'));
  assert.ok(!hits.some((h) => h.includes('/resolve/')), 'nem chegou a baixar o arquivo');
});

test('aceleração NVIDIA: exige o motor e a licença; instala e remove', async () => {
  const { mgr, whisper } = manager();
  await assert.rejects(mgr.installCuda({ acceptLicense: false }), (e) => e.code === 'LICENSE');
  await assert.rejects(mgr.installCuda({ acceptLicense: true }), (e) => e.code === 'NO_ENGINE');
  await mgr.installEngine();

  const w = (await mgr.installCuda({ acceptLicense: true })).whisper;
  assert.equal(w.cuda.installed, true);
  assert.deepEqual(w.cuda.versions, { whispercpp: 'btest', cuda: '12.4' });
  assert.ok(exists(whisper, 'cuda', 'whisper-cli.exe') && exists(whisper, 'cuda', 'ggml-cuda.dll') && exists(whisper, 'cuda', 'cublas64_12.dll'));
  assert.ok(exists(whisper, 'engine', 'whisper-cli.exe'), 'o motor de CPU continua lá');

  const after = (await mgr.removeCuda()).whisper;
  assert.equal(after.cuda.installed, false);
  assert.ok(!exists(whisper, 'cuda'));
  assert.equal(after.engine.installed, true);
});

test('pacote NVIDIA incompleto é recusado e não estraga a instalação anterior', async () => {
  const { mgr: first, whisper, root } = manager();
  await first.installEngine();
  await first.installCuda({ acceptLicense: true });
  fs.writeFileSync(path.join(whisper, 'cuda', 'marca.txt'), 'instalação anterior');

  const broken = new ModuleManager({
    rootDir: path.join(root, 'data'), tempDir: path.join(root, 'tmp'),
    config: { githubBaseUrl: base, huggingFaceBaseUrl: base, platform: 'win32', release: release({ cuda: { name: 'whisper-cuda-broken.zip', size: CUDA_ZIP_BROKEN.length, sha256: sha(CUDA_ZIP_BROKEN) } }) }
  });
  await assert.rejects(broken.installCuda({ acceptLicense: true }), (e) => e.code === 'BAD_ZIP' && /incompleto/.test(e.message));
  assert.ok(exists(whisper, 'cuda', 'marca.txt'), 'a instalação anterior foi mantida');
  assert.ok(!exists(`${path.join(whisper, 'cuda')}.old`));
});

test('modelo: baixa do Hugging Face, confere o hash, vira o ativo, troca e remove', async () => {
  const { mgr, whisper } = manager();
  const w1 = (await mgr.installModel('large-v3-turbo')).whisper;
  const turbo = w1.models.find((m) => m.id === 'large-v3-turbo');
  assert.deepEqual([turbo.installed, turbo.active, turbo.sizeOnDisk], [true, true, MODELS['ggml-large-v3-turbo-q5_0.bin'].length]);
  assert.ok(fs.readFileSync(path.join(whisper, 'models', 'large-v3-turbo', 'model.bin')).equals(MODELS['ggml-large-v3-turbo-q5_0.bin']));
  assert.equal(w1.activeModelId, 'large-v3-turbo');
  assert.ok(!exists(whisper, 'models', 'large-v3-turbo.partial'));

  const w2 = (await mgr.installModel('base')).whisper;
  assert.equal(w2.activeModelId, 'large-v3-turbo', 'um segundo modelo não rouba o lugar do ativo');
  assert.equal((await mgr.setActiveModel('base')).whisper.activeModelId, 'base');

  const w3 = (await mgr.removeModel('base')).whisper; // era o ativo: o outro assume
  assert.equal(w3.activeModelId, 'large-v3-turbo');
  assert.ok(!exists(whisper, 'models', 'base'));

  await assert.rejects(mgr.installModel('nao-existe'), (e) => e.code === 'BAD_MODEL');
  await assert.rejects(mgr.removeModel('nao-existe'), (e) => e.code === 'BAD_MODEL');
  await assert.rejects(mgr.setActiveModel('tiny'), (e) => e.code === 'NOT_INSTALLED');
});

test('modelo ausente no repositório ou com hash errado não deixa arquivos pela metade', async () => {
  const { mgr, whisper } = manager();
  await assert.rejects(mgr.installModel('tiny'), /não contém ggml-tiny-q5_1\.bin/); // o repositório de mentira não tem esse arquivo
  assert.ok(!exists(whisper, 'models', 'tiny'));

  const saved = MODELS['ggml-base-q5_1.bin'];
  const { mgr: m2 } = manager({ config: { downloadAttempts: 1 } });
  const original = m2.hf.getModelFile.bind(m2.hf);
  m2.hf.getModelFile = async (...a) => { const r = await original(...a); r.file.sha256 = 'b'.repeat(64); return r; };
  await assert.rejects(m2.installModel('base'));
  assert.equal(MODELS['ggml-base-q5_1.bin'], saved);
  assert.ok(!exists(m2.paths.models, 'base') && (await m2.getStatus()).whisper.activeModelId === null);
});

test('transcrever: usa o modelo ativo e o executor; pede motor e modelo antes', async () => {
  const { mgr, root } = manager({ config: { cliCommand: process.execPath, cliBaseArgs: [FAKE_CLI], ffmpegPath: () => process.execPath, ffmpegBaseArgs: [FAKE_FFMPEG] } });
  const media = path.join(root, 'aula.mp4');
  fs.writeFileSync(media, 'SECONDS=9');

  await assert.rejects(mgr.transcribe({ files: [media] }), (e) => e.code === 'NO_MODEL'); // com o executor de teste, o motor não é exigido
  await mgr.installModel('large-v3-turbo');
  const events = [];
  mgr.on('progress', (p) => events.push(p));
  const res = await mgr.transcribe({ files: [media], srt: true, md: true });
  assert.deepEqual([res.ok, res.failed, res.model, res.device], [1, 0, 'large-v3-turbo', 'CPU']);
  assert.deepEqual(res.outputs.map((o) => path.basename(o.path)), ['aula.srt', 'aula.md']);
  assert.ok(events.some((e) => e.phase === 'transcribe' && e.file && e.file.state === 'done'));
  assert.ok(events.some((e) => e.phase === 'transcribe' && e.device === 'CPU'));
  assert.equal((await mgr.getStatus()).busy, null);

  const semMotor = manager().mgr;
  await assert.rejects(semMotor.transcribe({ files: [media] }), (e) => e.code === 'NO_ENGINE');
});

test('remover o motor; uma operação por vez; cancelar sem operação devolve false', async () => {
  const { mgr, whisper } = manager();
  await mgr.installEngine();
  assert.equal((await mgr.uninstallEngine()).whisper.engine.installed, false);
  assert.ok(!exists(whisper, 'engine'));
  assert.equal(mgr.cancel(), false);

  mgr._begin('model', 'Baixando um modelo'); // simula operação em andamento
  await assert.rejects(mgr.installEngine(), (e) => e.code === 'BUSY');
  assert.equal(mgr.cancel(), true);
  mgr._end();
});

test('em sistema sem motor oficial (macOS) nada é instalado e o motivo vem em português', async () => {
  const { mgr } = manager({ config: { platform: 'darwin', arch: 'arm64', release: undefined } });
  const st = await mgr.getStatus();
  assert.equal(st.whisper.engine.available, false);
  assert.match(st.whisper.engine.unavailableReason, /não publica o motor para macOS/);
  assert.equal((await mgr.getStatus()).platformSupported, false);
  await assert.rejects(mgr.installEngine(), (e) => e.code === 'PLATFORM');
  await assert.rejects(mgr.installCuda({ acceptLicense: true }), (e) => e.code === 'PLATFORM');
  await assert.rejects(mgr.transcribe({ files: [] }), (e) => e.code === 'PLATFORM');
});
