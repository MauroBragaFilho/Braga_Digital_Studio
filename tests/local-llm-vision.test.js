'use strict';

// Modelo local com visão e pacote com placa de vídeo: modelo de vários arquivos (conferidos por SHA-256), escolha do modelo,
// pacote Vulkan quando existe, volta automática para a CPU quando ele não sobe, e os argumentos do servidor (mmproj, -ngl).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const AdmZip = require('adm-zip');

const { LocalLlm, MODELS, VISION_MODEL, LLAMA_RELEASE } = require('../src/core/modules/LocalLlm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-llmv-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const zipOf = (marker) => { const z = new AdmZip(); z.addFile('llama-bin/llama-server.exe', Buffer.from(marker)); return z.toBuffer(); };
const ZIP_CPU = zipOf('MZ-cpu');
const ZIP_GPU = zipOf('MZ-gpu');
const SMALL = crypto.randomBytes(50000);
const BIG = crypto.randomBytes(120000);
const PROJ = crypto.randomBytes(60000);

function sources() {
  const srv = http.createServer((req, res) => {
    const send = (b) => { res.writeHead(200, { 'Content-Length': b.length }); res.end(b); };
    if (req.url.includes('vulkan')) return send(ZIP_GPU);
    if (req.url.endsWith('.zip')) return send(ZIP_CPU);
    if (req.url.includes('mmproj')) return send(PROJ);
    if (req.url.includes('big.gguf')) return send(BIG);
    if (req.url.endsWith('.gguf')) return send(SMALL);
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

/**
 * Processo falso. Quem leva -ngl é o servidor da placa de vídeo; `ctl` manda como ele se comporta (muda durante o teste):
 * `failGpu` cai na hora, como um driver que não funciona; `failGpuTimes` cai só nas N primeiras vezes (outro programa tomou a
 * memória de vídeo); `hangGpu` nunca fica pronto (demora demais).
 */
function fakeSpawn(log, ctl) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.exitCode = null; child.killed = false;
    log.push({ cmd, args, at: Date.now() });
    if (args.includes('-ngl') && (ctl.failGpu || ctl.failGpuTimes > 0)) {
      if (!ctl.failGpu) ctl.failGpuTimes -= 1;
      setImmediate(() => { child.exitCode = 1; child.emit('exit', 1); });
      child.kill = () => {};
      return child;
    }
    if (!args.includes('-ngl') && ctl.failCpu) { // o servidor de CPU também cai (arquivo estragado, antivírus...)
      setImmediate(() => { child.exitCode = 1; child.emit('exit', 1); });
      child.kill = () => {};
      return child;
    }
    if (args.includes('-ngl') && ctl.hangGpu) {
      child.kill = () => { child.killed = true; child.exitCode = 0; setImmediate(() => child.emit('exit', 0)); };
      return child;
    }
    const port = Number(args[args.indexOf('--port') + 1]);
    const s = http.createServer((q, r) => { r.writeHead(q.url === '/health' ? 200 : 404); r.end('{}'); });
    s.listen(port, '127.0.0.1');
    child.kill = () => { child.killed = true; child.exitCode = 0; s.close(); s.closeAllConnections(); setImmediate(() => child.emit('exit', 0)); };
    return child;
  };
}

const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

const MODEL_SMALL = { id: 'pequeno', label: 'Pequeno', repo: 'org/p', revision: 'r1', file: 'p.gguf', size: SMALL.length, sha256: sha(SMALL), license: 'Apache 2.0' };
const MODEL_VISION = {
  id: 'visao', label: 'Com visão', license: 'Apache 2.0', vision: true, context: 4096,
  files: [
    { role: 'model', repo: 'org/v', revision: 'r2', file: 'big.gguf', size: BIG.length, sha256: sha(BIG) },
    { role: 'vision', repo: 'org/v', revision: 'r2', file: 'mmproj-v.gguf', size: PROJ.length, sha256: sha(PROJ) }
  ]
};

const HOUR = 3600 * 1000;

async function make({ gpu = true, failGpu = false, startTimeoutMs = 3000, retryPauseMs = 0 } = {}) {
  const { srv, base } = await sources();
  const log = [];
  const ctl = { failGpu, failGpuTimes: 0, hangGpu: false, failCpu: false };
  const clock = { t: Date.UTC(2026, 10, 16, 12, 0, 0) }; // o relógio do teste: a falha da placa de vídeo vale até uma hora marcada
  const dir = fs.mkdtempSync(path.join(tmp, 'c-'));
  const llm = new LocalLlm({
    rootDir: path.join(dir, 'data'), tempDir: path.join(dir, 'temp'),
    config: {
      platform: 'win32', arch: 'x64', port: await freePort(), spawn: fakeSpawn(log, ctl), now: () => clock.t, githubBaseUrl: base, huggingFaceBaseUrl: base,
      downloadAttempts: 1, startTimeoutMs, retryPauseMs, models: [MODEL_SMALL, MODEL_VISION],
      release: {
        tag: 'bT',
        assets: { 'win32-x64': { name: 'llama-bT-bin-win-cpu-x64.zip', size: ZIP_CPU.length, sha256: sha(ZIP_CPU) } },
        ...(gpu ? { gpu: { 'win32-x64': { name: 'llama-bT-bin-win-vulkan-x64.zip', size: ZIP_GPU.length, sha256: sha(ZIP_GPU) } } } : {})
      }
    }
  });
  return { llm, srv, log, dir, ctl, clock };
}

const flagOf = (llm) => { try { return JSON.parse(fs.readFileSync(llm.paths.runtimeFlag, 'utf8')); } catch (_) { return null; } };
const isGpuLaunch = (l) => l.args.includes('-ngl');

test('catálogo real: modelo básico primeiro, modelo com visão do repositório oficial da Qwen e pacote Vulkan do Windows', () => {
  assert.equal(MODELS[0].id, 'qwen2.5-0.5b-instruct');
  assert.equal(VISION_MODEL.vision, true);
  assert.ok(VISION_MODEL.files.every((f) => f.repo === 'Qwen/Qwen3-VL-2B-Instruct-GGUF' && /^[0-9a-f]{40}$/.test(f.revision) && /^[0-9a-f]{64}$/.test(f.sha256) && f.size > 1e6));
  assert.deepEqual(VISION_MODEL.files.map((f) => f.role), ['model', 'vision']);
  const g = LLAMA_RELEASE.gpu['win32-x64'];
  assert.match(g.name, /vulkan/);
  assert.match(g.sha256, /^[0-9a-f]{64}$/);
});

test('modelo com visão: instala os dois arquivos, usa o pacote de placa de vídeo e liga com --mmproj e -ngl', async () => {
  const { llm, srv, log } = await make();
  try {
    assert.equal(llm.getStatus().models.length, 2);
    const st = await llm.install({ modelId: 'visao' });
    assert.equal(st.installed, true);
    assert.equal(st.vision, true);
    assert.equal(st.gpu, true);
    assert.ok(fs.existsSync(path.join(llm.paths.runtimeGpu, 'llama-server.exe')), 'pacote com placa de vídeo instalado');
    assert.equal(fs.existsSync(path.join(llm.paths.runtime, 'llama-server.exe')), false, 'o de CPU só vem se precisar');
    assert.deepEqual(fs.readFileSync(path.join(llm.paths.models, 'visao', 'big.gguf')), BIG);
    assert.equal(llm.supportsVision(), true);
    await llm.ensureRunning();
    const a = log[0].args;
    assert.equal(a[a.indexOf('-m') + 1], path.join(llm.paths.models, 'visao', 'big.gguf'));
    assert.equal(a[a.indexOf('--mmproj') + 1], path.join(llm.paths.models, 'visao', 'mmproj-v.gguf'));
    // o servidor anuncia o modelo pelo id; sem isto /v1/models devolve o CAMINHO do arquivo (com a pasta e o usuário do Windows)
    assert.equal(a[a.indexOf('--alias') + 1], 'visao');
    assert.equal(a[a.indexOf('-c') + 1], '4096');
    assert.ok(a.includes('-ngl'));
    assert.equal(a[a.indexOf('--host') + 1], '127.0.0.1');
    assert.match(log[0].cmd, /runtime-gpu/);
  } finally { await llm.stop(); srv.close(); }
});

test('a placa de vídeo não sobe: tenta de novo, volta sozinha para a CPU, baixa o pacote e anota a falha com prazo', async () => {
  const { llm, srv, log, clock } = await make({ failGpu: true });
  try {
    await llm.install();
    assert.equal(fs.existsSync(path.join(llm.paths.runtime, 'llama-server.exe')), false);
    await llm.ensureRunning();
    assert.deepEqual(log.map(isGpuLaunch), [true, true, false], 'a placa, a placa de novo (o servidor caiu ao subir) e só então a CPU');
    assert.ok(fs.existsSync(path.join(llm.paths.runtime, 'llama-server.exe')), 'pacote de CPU baixado na hora');
    const st = llm.getStatus();
    assert.equal(st.gpu, false);
    assert.equal(st.gpuRetryAt, clock.t + HOUR, 'o estado diz até quando a placa fica de molho');
    assert.deepEqual(flagOf(llm), { cpuOnly: true, failedAt: clock.t, fails: 1, modelId: 'pequeno' });
    await llm.stop();
    await llm.ensureRunning();
    assert.deepEqual(log.map(isGpuLaunch), [true, true, false, false], 'dentro do prazo vai direto para a CPU');
  } finally { await llm.stop(); srv.close(); }
});

test('depois do prazo a placa é tentada de novo; falhando, a espera cresce (1 h, 6 h, 24 h); ligando, a falha é esquecida', async () => {
  const { llm, srv, log, ctl, clock } = await make({ failGpu: true });
  const cycle = async () => { await llm.stop(); const n = log.length; await llm.ensureRunning(); return log.slice(n).map(isGpuLaunch); };
  const wait = () => [flagOf(llm).fails, llm.getStatus().gpuRetryAt - clock.t];
  try {
    await llm.install();
    await llm.ensureRunning();
    assert.deepEqual(wait(), [1, HOUR]);
    clock.t += 59 * 60 * 1000;
    assert.deepEqual(await cycle(), [false], 'dentro do prazo nem tenta a placa');
    clock.t += 2 * 60 * 1000;
    assert.equal(llm.getStatus().gpuRetryAt, null, 'passou 1 h: a placa volta a valer');
    assert.equal(llm.getStatus().gpu, true);
    assert.deepEqual(await cycle(), [true, true, false], 'tentou a placa (duas vezes), caiu de novo e voltou para a CPU');
    assert.deepEqual(wait(), [2, 6 * HOUR]);
    clock.t += 6 * HOUR + 1000;
    await cycle();
    assert.deepEqual(wait(), [3, 24 * HOUR]);
    clock.t += 24 * HOUR + 1000;
    await cycle();
    assert.deepEqual(wait(), [4, 24 * HOUR], 'a espera para em 24 h');
    // a placa volta a funcionar (driver novo, o outro programa fechou)
    clock.t += 24 * HOUR + 1000;
    ctl.failGpu = false;
    assert.deepEqual(await cycle(), [true], 'uma tentativa só, e subiu na placa');
    assert.equal(flagOf(llm), null, 'a falha foi esquecida');
    assert.equal(llm.getStatus().gpu, true);
    assert.equal(llm.getStatus().gpuRetryAt, null);
    // e a próxima falha recomeça da espera de 1 h
    ctl.failGpu = true;
    await cycle();
    assert.deepEqual(wait(), [1, HOUR]);
  } finally { await llm.stop(); srv.close(); }
});

test('o servidor da placa cai uma vez só (outro programa tomou a memória): a segunda tentativa liga e nada fica anotado', async () => {
  const { llm, srv, log, ctl } = await make();
  ctl.failGpuTimes = 1;
  try {
    await llm.install();
    await llm.ensureRunning();
    assert.deepEqual(log.map(isGpuLaunch), [true, true], 'a placa duas vezes, sem passar pela CPU');
    assert.equal(flagOf(llm), null);
    assert.equal(fs.existsSync(path.join(llm.paths.runtime, 'llama-server.exe')), false, 'nem baixou o pacote de CPU');
    assert.equal(llm.isRunning(), true);
    assert.equal(llm.getStatus().gpu, true);
    assert.equal(llm.getStatus().gpuRetryAt, null);
  } finally { await llm.stop(); srv.close(); }
});

test('a segunda tentativa espera um instante: a memória de vídeo do servidor que caiu ainda não voltou', async () => {
  const { llm, srv, log, ctl } = await make({ retryPauseMs: 1200 }); // (só a vigia de 300 ms do arranque já dá um tempo: a espera tem de passar disso)
  ctl.failGpuTimes = 1;
  try {
    await llm.install();
    await llm.ensureRunning();
    assert.equal(log.length, 2);
    assert.ok(log[1].at - log[0].at >= 1100, `esperou só ${log[1].at - log[0].at} ms`);
  } finally { await llm.stop(); srv.close(); }
});

test('a placa demora demais para subir: não repete a espera, vai direto para a CPU e anota a falha', async () => {
  const { llm, srv, log, ctl, clock } = await make({ startTimeoutMs: 700 });
  ctl.hangGpu = true;
  try {
    await llm.install();
    await llm.ensureRunning();
    assert.deepEqual(log.map(isGpuLaunch), [true, false], 'esperou a placa uma vez só');
    assert.deepEqual([flagOf(llm).fails, llm.getStatus().gpuRetryAt - clock.t], [1, HOUR]);
  } finally { await llm.stop(); srv.close(); }
});

test('a falha anotada vale só para o modelo que falhou', async () => {
  const { llm, srv, log, ctl } = await make({ failGpu: true });
  try {
    await llm.install();
    await llm.ensureRunning();
    assert.equal(flagOf(llm).modelId, 'pequeno');
    assert.ok(llm.getStatus().gpuRetryAt);
    await llm.install({ modelId: 'visao' });
    assert.equal(llm.getStatus().modelId, 'visao');
    assert.equal(llm.getStatus().gpuRetryAt, null, 'com o outro modelo a placa ainda não falhou');
    ctl.failGpu = false;
    const n = log.length;
    await llm.ensureRunning();
    assert.deepEqual(log.slice(n).map(isGpuLaunch), [true], 'o outro modelo sobe na placa');
    assert.equal(flagOf(llm).modelId, 'pequeno', 'subir com um modelo não apaga a falha do outro');
    await llm.setModel('pequeno');
    assert.ok(llm.getStatus().gpuRetryAt, 'de volta ao que falhou: a placa continua de molho até a hora');
    const m = log.length;
    await llm.ensureRunning();
    assert.deepEqual(log.slice(m).map(isGpuLaunch), [false]);
  } finally { await llm.stop(); srv.close(); }
});

test('marca da versão antiga (sem data), com data no futuro ou vencida não vale e some ao ligar a placa; dentro do prazo vale', async () => {
  const { llm, srv, log, clock } = await make();
  const write = (v) => { fs.mkdirSync(llm.root, { recursive: true }); fs.writeFileSync(llm.paths.runtimeFlag, JSON.stringify(v)); };
  try {
    write({ cpuOnly: true }); // a versão antiga: valia para sempre
    assert.equal(llm.getStatus().gpuRetryAt, null);
    write({ cpuOnly: true, failedAt: clock.t + 5 * HOUR, fails: 1, modelId: 'pequeno' }); // o relógio foi mudado
    assert.equal(llm.getStatus().gpuRetryAt, null);
    write({ cpuOnly: true, failedAt: clock.t - 2 * HOUR, fails: 1, modelId: 'pequeno' });
    assert.equal(llm.getStatus().gpuRetryAt, null);
    write({ cpuOnly: false, failedAt: clock.t, fails: 1, modelId: 'pequeno' });
    assert.equal(llm.getStatus().gpuRetryAt, null);
    write({ cpuOnly: true, failedAt: clock.t - 30 * 60 * 1000, fails: 1, modelId: 'pequeno' });
    assert.equal(llm.getStatus().gpuRetryAt, clock.t + 30 * 60 * 1000, 'dentro do prazo vale');
    write({ cpuOnly: true }); // com a marca antiga no disco a instalação e a subida usam a placa
    await llm.install();
    assert.ok(fs.existsSync(path.join(llm.paths.runtimeGpu, 'llama-server.exe')), 'baixou o pacote da placa, não o de CPU');
    await llm.ensureRunning();
    assert.equal(isGpuLaunch(log[0]), true);
    assert.equal(flagOf(llm), null, 'ligou na placa: a marca antiga some');
  } finally { await llm.stop(); srv.close(); }
});

test('sem internet para baixar o pacote de CPU: a falha da placa não fica anotada e a próxima pergunta tenta a placa de novo', async () => {
  const { llm, srv, log, ctl } = await make({ failGpu: true });
  try {
    await llm.install(); // só o pacote da placa
    srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve)); // sem rede
    await assert.rejects(llm.ensureRunning());
    assert.deepEqual(log.map(isGpuLaunch), [true, true]);
    assert.equal(flagOf(llm), null, 'a CPU não subiu: nada anotado');
    assert.equal(llm.isInstalled(), true, 'o modelo e o pacote da placa continuam valendo');
    ctl.failGpu = false; // a placa volta a funcionar
    await llm.ensureRunning();
    assert.equal(isGpuLaunch(log[log.length - 1]), true);
  } finally { await llm.stop(); }
});

test('a CPU também não sobe: o erro chega a quem perguntou, nada fica anotado e depois a placa é tentada de novo', async () => {
  const { llm, srv, log, ctl } = await make({ failGpu: true });
  ctl.failCpu = true;
  try {
    await llm.install();
    await assert.rejects(llm.ensureRunning(), (e) => e.code === 'START_FAILED');
    assert.deepEqual(log.map(isGpuLaunch), [true, true, false], 'placa, placa de novo e CPU');
    assert.equal(flagOf(llm), null, 'sem CPU funcionando não há o que anotar');
    assert.equal(llm.isRunning(), false);
    ctl.failCpu = false;
    ctl.failGpu = false;
    await llm.ensureRunning();
    assert.equal(isGpuLaunch(log[log.length - 1]), true);
    assert.equal(llm.getStatus().gpu, true);
  } finally { await llm.stop(); srv.close(); }
});

test('ligar e desligar o servidor não acumula ouvintes de saída do processo', async () => {
  const { llm, srv } = await make();
  try {
    await llm.install();
    const before = process.listenerCount('exit');
    for (let i = 0; i < 12; i++) { await llm.ensureRunning(); await llm.stop(); }
    assert.equal(process.listenerCount('exit'), before);
  } finally { await llm.stop(); srv.close(); }
});

test('sem pacote de placa de vídeo para o sistema: só CPU; instalação antiga (só CPU) continua funcionando', async () => {
  const { llm, srv, log } = await make({ gpu: false });
  try {
    await llm.install();
    assert.equal(llm.getStatus().gpu, false);
    await llm.ensureRunning();
    assert.ok(!log[0].args.includes('-ngl'));
    assert.equal(log[0].args.includes('--mmproj'), false, 'modelo básico não usa projetor de imagem');
    assert.ok(log[0].args.includes('--alias'), 'todo modelo sobe com um nome limpo');
  } finally { await llm.stop(); srv.close(); }
  // Instalação antiga: pacote de CPU e modelo já no disco, e agora o sistema oferece placa de vídeo
  const b = await make();
  try {
    fs.mkdirSync(b.llm.paths.runtime, { recursive: true });
    fs.writeFileSync(path.join(b.llm.paths.runtime, 'llama-server.exe'), 'MZ-velho');
    fs.writeFileSync(b.llm.paths.model, SMALL);
    assert.equal(b.llm.isInstalled(), true, 'o pacote de CPU antigo basta para usar');
    await b.llm.ensureRunning();
    assert.match(b.log[0].cmd, /runtime[\\/]llama-server/);
    assert.ok(!b.log[0].args.includes('-ngl'));
  } finally { await b.llm.stop(); b.srv.close(); }
});

test('trocar de modelo religa o servidor com o novo; modelo desconhecido é recusado; o estado lista os modelos', async () => {
  const { llm, srv, log } = await make({ gpu: false });
  try {
    await llm.install();
    await llm.ensureRunning();
    assert.equal(llm.getStatus().modelId, 'pequeno');
    await llm.install({ modelId: 'visao' });
    assert.equal(llm.getStatus().modelId, 'visao');
    assert.equal(llm.isRunning(), false, 'ao trocar de modelo o servidor antigo é desligado');
    await llm.ensureRunning();
    assert.equal(log.length, 2);
    assert.ok(log[1].args.includes('--mmproj'));
    const models = llm.getStatus().models;
    assert.deepEqual(models.map((m) => [m.id, m.installed, m.selected]), [['pequeno', true, false], ['visao', true, true]]);
    await assert.rejects(llm.setModel('nao-existe'), (e) => e.code === 'BAD_MODEL');
    await llm.setModel('pequeno'); // já instalado: troca direto
    assert.equal(llm.getStatus().modelId, 'pequeno');
    llm.models.push({ id: 'outro', label: 'Outro', license: 'x', files: [{ role: 'model', repo: 'o/o', revision: 'r', file: 'outro.gguf', size: 10, sha256: 'a'.repeat(64) }] });
    await assert.rejects(llm.setModel('outro'), (e) => e.code === 'NOT_INSTALLED');
  } finally { await llm.stop(); srv.close(); }
});

test('hash errado em um dos arquivos do modelo recusa a instalação e não deixa arquivo no lugar', async () => {
  const { llm, srv } = await make({ gpu: false });
  try {
    llm.models[1] = { ...MODEL_VISION, files: [MODEL_VISION.files[0], { ...MODEL_VISION.files[1], sha256: 'a'.repeat(64) }] };
    await assert.rejects(llm.install({ modelId: 'visao' }));
    assert.equal(llm.getStatus().modelId, 'pequeno', 'instalação que falha não troca o modelo escolhido');
    assert.equal(llm.getStatus().installed, false);
    assert.equal(fs.existsSync(path.join(llm.paths.models, 'visao', 'mmproj-v.gguf')), false);
  } finally { srv.close(); }
});
