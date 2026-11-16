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

/** Processo falso. `failGpu`: quem leva -ngl (placa de vídeo) cai na hora, como um driver que não funciona. */
function fakeSpawn(log, { failGpu = false } = {}) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.exitCode = null; child.killed = false;
    log.push({ cmd, args });
    if (failGpu && args.includes('-ngl')) { setImmediate(() => { child.exitCode = 1; child.emit('exit', 1); }); child.kill = () => {}; return child; }
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

async function make({ gpu = true, failGpu = false } = {}) {
  const { srv, base } = await sources();
  const log = [];
  const dir = fs.mkdtempSync(path.join(tmp, 'c-'));
  const llm = new LocalLlm({
    rootDir: path.join(dir, 'data'), tempDir: path.join(dir, 'temp'),
    config: {
      platform: 'win32', arch: 'x64', port: await freePort(), spawn: fakeSpawn(log, { failGpu }), githubBaseUrl: base, huggingFaceBaseUrl: base,
      downloadAttempts: 1, startTimeoutMs: 3000, models: [MODEL_SMALL, MODEL_VISION],
      release: {
        tag: 'bT',
        assets: { 'win32-x64': { name: 'llama-bT-bin-win-cpu-x64.zip', size: ZIP_CPU.length, sha256: sha(ZIP_CPU) } },
        ...(gpu ? { gpu: { 'win32-x64': { name: 'llama-bT-bin-win-vulkan-x64.zip', size: ZIP_GPU.length, sha256: sha(ZIP_GPU) } } } : {})
      }
    }
  });
  return { llm, srv, log, dir };
}

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

test('a placa de vídeo não sobe: volta sozinha para a CPU, baixa o pacote e lembra a escolha', async () => {
  const { llm, srv, log } = await make({ failGpu: true });
  try {
    await llm.install();
    assert.equal(fs.existsSync(path.join(llm.paths.runtime, 'llama-server.exe')), false);
    await llm.ensureRunning();
    assert.equal(log.length, 2, 'tentou a placa de vídeo e depois a CPU');
    assert.ok(log[0].args.includes('-ngl') && !log[1].args.includes('-ngl'));
    assert.ok(fs.existsSync(path.join(llm.paths.runtime, 'llama-server.exe')), 'pacote de CPU baixado na hora');
    assert.equal(llm.getStatus().gpu, false);
    await llm.stop();
    await llm.ensureRunning();
    assert.equal(log.length, 3, 'da próxima vez vai direto para a CPU');
    assert.ok(!log[2].args.includes('-ngl'));
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
