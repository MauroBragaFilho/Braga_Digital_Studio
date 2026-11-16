'use strict';

// Modelo local x memória da placa de vídeo. Os números vêm de medidas reais nesta máquina (GTX 1650 de 4 GB + Intel integrada,
// llama.cpp b12322 em Vulkan, Qwen3-VL 2B com imagens, contexto 8192):
//   placa livre ............................ modelo inteiro na placa, ~76 tokens/s, 2823 a 2889 MiB usados
//   outro programa com ~2 GB (livre 1896) ... com -ngl 99 ou --fit sozinho: 4 a 5 tokens/s (pior que a CPU, 21);
//                                              margem 2187 e projetor na CPU: 40 tokens/s e 571 MiB de folga
// O servidor (--list-devices) informa 3561 MiB livres nos dois casos: ele não desconta os outros programas.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const mem = require('../src/core/modules/llmMemory');
const { LocalLlm, MODELS, LOCAL_MODEL, VISION_MODEL, VISION_MODEL_4B, VISION_MODEL_8B } = require('../src/core/modules/LocalLlm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-llmmem-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Saída real de `llama-server --list-devices` e do nvidia-smi nesta máquina (placa livre, e com ~2 GB ocupados por outro programa)
const LIST_DEVICES = `Available devices:
  Vulkan0: Intel(R) Iris(R) Xe Graphics (12179 MiB, 11411 MiB free)
  Vulkan1: NVIDIA GeForce GTX 1650 (4152 MiB, 3561 MiB free)
`;
const SMI_IDLE = 'NVIDIA GeForce GTX 1650, 4096, 3938\n';
const SMI_BUSY = 'NVIDIA GeForce GTX 1650, 4096, 1896\n';
const raw = (smi) => ({ vulkan: mem.parseListDevices(LIST_DEVICES), nvidia: mem.parseNvidiaSmi(smi) });

const sizesOf = (m) => {
  const f = m.files || [{ role: 'model', size: m.size }];
  const by = (role) => f.filter((x) => x.role === role).reduce((n, x) => n + x.size, 0);
  return { weightsBytes: by('model'), projectorBytes: by('vision'), kvBytesPerToken: m.kvBytesPerToken, ctx: m.context || 8192 };
};
const fitOf = (m, gpu) => mem.fitFor(mem.estimateMB(sizesOf(m)), gpu, mem.safetyFor(gpu ? gpu.totalMB : 0));

// ------------------------------------------------------------------ leitura da placa

test('parseListDevices e parseNvidiaSmi leem a saída real; lixo e linhas quebradas são ignorados', () => {
  assert.deepEqual(mem.parseListDevices(LIST_DEVICES), [
    { id: 'Vulkan0', name: 'Intel(R) Iris(R) Xe Graphics', totalMB: 12179, freeMB: 11411 },
    { id: 'Vulkan1', name: 'NVIDIA GeForce GTX 1650', totalMB: 4152, freeMB: 3561 }
  ]);
  assert.deepEqual(mem.parseNvidiaSmi(SMI_BUSY), [{ name: 'NVIDIA GeForce GTX 1650', totalMB: 4096, freeMB: 1896 }]);
  assert.deepEqual(mem.parseNvidiaSmi('NVIDIA RTX A4000, Laptop GPU, 8192, 7000'), [{ name: 'NVIDIA RTX A4000, Laptop GPU', totalMB: 8192, freeMB: 7000 }]);
  for (const junk of ['', null, undefined, 'nvidia-smi: command not found', 'Available devices:\n', 'Vulkan0: sem números']) {
    assert.deepEqual(mem.parseListDevices(junk), []);
    assert.deepEqual(mem.parseNvidiaSmi(junk), []);
  }
});

test('placa integrada não conta como memória de vídeo; placa dedicada (inclusive Intel Arc) conta', () => {
  for (const n of ['Intel(R) Iris(R) Xe Graphics', 'Intel(R) UHD Graphics 620', 'Intel(R) HD Graphics 530', 'AMD Radeon(TM) Graphics', 'AMD Radeon 680M', 'Apple M2']) {
    assert.equal(mem.isIntegratedGpu(n), true, n);
  }
  for (const n of ['NVIDIA GeForce GTX 1650', 'NVIDIA GeForce RTX 4070', 'AMD Radeon RX 7800 XT', 'Intel(R) Arc(TM) A750 Graphics']) {
    assert.equal(mem.isIntegratedGpu(n), false, n);
  }
});

test('pickGpu: escolhe a dedicada, junta o nvidia-smi (memória livre de verdade) e guarda o que o servidor acha que está livre', () => {
  const gpu = mem.pickGpu(raw(SMI_BUSY));
  assert.deepEqual(gpu, { id: 'Vulkan1', name: 'NVIDIA GeForce GTX 1650', totalMB: 4096, freeMB: 1896, serverFreeMB: 3561, source: 'nvidia-smi' });
  // sem nvidia-smi (AMD, ou sem o programa): vale o que o servidor informa
  const amd = mem.pickGpu({ vulkan: mem.parseListDevices('  Vulkan0: AMD Radeon RX 7800 XT (16368 MiB, 15000 MiB free)\n'), nvidia: [] });
  assert.equal(amd.source, 'servidor');
  assert.equal(amd.freeMB, 15000);
  assert.equal(amd.serverFreeMB, 15000);
  // duas placas dedicadas: a de maior memória
  const two = mem.pickGpu({ vulkan: mem.parseListDevices('  Vulkan0: NVIDIA GeForce GTX 1650 (4152 MiB, 3561 MiB free)\n  Vulkan1: NVIDIA GeForce RTX 3090 (24576 MiB, 20000 MiB free)\n'), nvidia: [] });
  assert.equal(two.name, 'NVIDIA GeForce RTX 3090');
  // o servidor ainda não foi instalado: só dá para falar da placa NVIDIA
  const early = mem.pickGpu({ vulkan: [], nvidia: mem.parseNvidiaSmi(SMI_IDLE) });
  assert.deepEqual(early, { id: null, name: 'NVIDIA GeForce GTX 1650', totalMB: 4096, freeMB: 3938, serverFreeMB: null, source: 'nvidia-smi' });
  // só integrada, ou nada
  assert.equal(mem.pickGpu({ vulkan: mem.parseListDevices('  Vulkan0: Intel(R) Iris(R) Xe Graphics (12179 MiB, 11411 MiB free)\n'), nvidia: [] }), null);
  assert.equal(mem.pickGpu({}), null);
});

test('safetyFor: 512 MiB de folga, ou 8% quando a placa é grande', () => {
  assert.equal(mem.safetyFor(4096), 512);
  assert.equal(mem.safetyFor(8192), 655);
  assert.equal(mem.safetyFor(24576), 1966);
  assert.equal(mem.safetyFor(0), 512);
});

// ------------------------------------------------------------------ quanto o modelo pede e como se sai

test('estimateMB: o Qwen3-VL 2B no contexto 8192 dá ~2,95 GB, perto dos 2823 a 2889 MiB medidos (e nunca abaixo)', () => {
  const e = mem.estimateMB(sizesOf(VISION_MODEL));
  assert.ok(e.totalMB >= 2889 && e.totalMB <= 3050, `estimativa ${Math.round(e.totalMB)} MiB`);
  assert.equal(Math.round(e.kvMB), 896);
  assert.equal(Math.round(e.projectorMB), 424);
  // mais contexto, mais cache; modelos maiores pedem mais
  assert.ok(mem.estimateMB({ ...sizesOf(VISION_MODEL), ctx: 16384 }).totalMB > e.totalMB + 800);
  const mb = (m) => mem.estimateMB(sizesOf(m)).totalMB;
  assert.ok(mb(VISION_MODEL) < mb(VISION_MODEL_4B) && mb(VISION_MODEL_4B) < mb(VISION_MODEL_8B));
});

const GTX_IDLE = mem.pickGpu(raw(SMI_IDLE));
const GTX_BUSY = mem.pickGpu(raw(SMI_BUSY));

test('placa de 4 GB livre: o 2B cabe inteiro; o 4B fica parte no processador; o 8B é lento', () => {
  assert.equal(fitOf(VISION_MODEL, GTX_IDLE).state, 'fits');
  const f4 = fitOf(VISION_MODEL_4B, GTX_IDLE);
  assert.equal(f4.state, 'partial');
  assert.ok(f4.gpuPercent >= 70 && f4.gpuPercent < 100, `${f4.gpuPercent}%`);
  assert.equal(fitOf(VISION_MODEL_8B, GTX_IDLE).state, 'slow');
  assert.equal(fitOf(LOCAL_MODEL, GTX_IDLE).state, 'fits');
});

test('com outro programa usando ~2 GB: o 2B "cabe se liberarem a placa" e agora usa ~41% das camadas (o que o servidor posicionou: 12 de 29)', () => {
  const f = fitOf(VISION_MODEL, GTX_BUSY);
  assert.equal(f.state, 'tight');
  assert.ok(f.gpuPercent >= 38 && f.gpuPercent <= 44, `${f.gpuPercent}%`);
});

test('sem placa dedicada: tudo "cpu"; o recomendado é o menor modelo com visão', () => {
  assert.equal(fitOf(VISION_MODEL, null).state, 'cpu');
  const entries = MODELS.map((m) => ({ id: m.id, vision: Boolean(m.vision), weightsMB: mem.estimateMB(sizesOf(m)).weightsMB, fit: fitOf(m, null) }));
  assert.equal(mem.recommendId(entries), VISION_MODEL.id);
});

test('recomendado: o MAIOR modelo com visão que cabe inteiro agora, nunca o de texto', () => {
  const rec = (gpu) => mem.recommendId(MODELS.map((m) => ({ id: m.id, vision: Boolean(m.vision), weightsMB: mem.estimateMB(sizesOf(m)).weightsMB, fit: fitOf(m, gpu) })));
  const card = (totalMB, freeMB) => ({ id: 'Vulkan1', name: 'NVIDIA', totalMB, freeMB, serverFreeMB: freeMB, source: 'nvidia-smi' });
  assert.equal(rec(GTX_IDLE), VISION_MODEL.id, '4 GB livres: o 2B');
  assert.equal(rec(GTX_BUSY), VISION_MODEL.id, '4 GB com 2 GB ocupados: nenhum cabe inteiro, o menor');
  assert.equal(rec(card(6144, 5800)), VISION_MODEL_4B.id, '6 GB livres: o 4B');
  assert.equal(rec(card(8192, 7600)), VISION_MODEL_8B.id, '8 GB livres: o 8B');
  assert.equal(rec(card(24576, 22000)), VISION_MODEL_8B.id, 'o maior do catálogo');
  assert.notEqual(rec(card(24576, 22000)), LOCAL_MODEL.id);
});

// ------------------------------------------------------------------ argumentos do servidor

const est2b = mem.estimateMB(sizesOf(VISION_MODEL));

test('planLaunch, placa livre: tudo na placa, margem = folga + projetor de imagem (nada "escondido")', () => {
  const p = mem.planLaunch({ gpu: GTX_IDLE, est: est2b, safetyMB: mem.safetyFor(4096) });
  assert.equal(p.mode, 'gpu');
  assert.deepEqual(p.args, ['--fit', 'on', '--fit-target', String(Math.round(512 + est2b.projectorMB))]);
  assert.equal(p.args.includes('--no-mmproj-offload'), false);
  assert.equal(p.args.includes('-ngl'), false, 'o servidor decide as camadas dentro da margem');
});

test('planLaunch, outro programa na placa: a margem soma o que o servidor "enxerga a mais" e o projetor vai para a CPU (o caso dos 40 tokens/s)', () => {
  const p = mem.planLaunch({ gpu: GTX_BUSY, est: est2b, safetyMB: 512 });
  assert.equal(p.mode, 'partial');
  assert.equal(p.fitTargetMB, 3561 - 1896 + 512, 'o servidor acha 3561 livres e há 1896: margem 2177 (medido: 2187 deu 40 tokens/s)');
  assert.deepEqual(p.args, ['--fit', 'on', '--fit-target', '2177', '--no-mmproj-offload']);
  assert.ok(p.gpuPercent > 30 && p.gpuPercent < 60);
});

test('planLaunch, quase nada livre: tudo no processador, sem brigar pela placa; modelo sem projetor não leva a opção do projetor', () => {
  const nearly = { ...GTX_IDLE, freeMB: 700, serverFreeMB: 3561 };
  const p = mem.planLaunch({ gpu: nearly, est: est2b, safetyMB: 512 });
  assert.equal(p.mode, 'cpu');
  assert.deepEqual(p.args, ['--device', 'none', '-ngl', '0']);
  const noProjector = mem.estimateMB({ ...sizesOf(LOCAL_MODEL) });
  const q = mem.planLaunch({ gpu: { ...GTX_BUSY, freeMB: 900 }, est: { ...noProjector, kvMB: 5000 }, safetyMB: 512 });
  assert.equal(q.args.includes('--no-mmproj-offload'), false);
  // servidor sem leitura própria (ainda não instalado): nada "escondido" a somar
  const early = mem.planLaunch({ gpu: mem.pickGpu({ vulkan: [], nvidia: mem.parseNvidiaSmi(SMI_IDLE) }), est: est2b, safetyMB: 512 });
  assert.equal(early.fitTargetMB, Math.round(512 + est2b.projectorMB));
});

// ------------------------------------------------------------------ catálogo

test('catálogo: todos os modelos de visão são do repositório oficial da Qwen, com revisão e SHA-256 fixados e o cache por token do config.json', () => {
  assert.deepEqual(MODELS.map((m) => m.id), ['qwen2.5-0.5b-instruct', 'qwen3-vl-2b-instruct', 'qwen3-vl-4b-instruct', 'qwen3-vl-8b-instruct']);
  for (const m of [VISION_MODEL, VISION_MODEL_4B, VISION_MODEL_8B]) {
    const tag = m.id.replace('qwen3-vl-', '').replace('-instruct', '').toUpperCase();
    assert.equal(m.vision, true);
    assert.equal(m.license, 'Apache 2.0');
    assert.deepEqual(m.files.map((f) => f.role), ['model', 'vision']);
    for (const f of m.files) {
      assert.equal(f.repo, `Qwen/Qwen3-VL-${tag}-Instruct-GGUF`);
      assert.match(f.revision, /^[0-9a-f]{40}$/);
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.ok(f.size > 1e8);
    }
    assert.match(m.files[0].file, new RegExp(`^Qwen3VL-${tag}-Instruct-Q4_K_M\\.gguf$`));
    assert.match(m.files[1].file, new RegExp(`^mmproj-Qwen3VL-${tag}-Instruct-Q8_0\\.gguf$`));
  }
  assert.equal(VISION_MODEL.kvBytesPerToken, 2 * 28 * 8 * 128 * 2);
  assert.equal(VISION_MODEL_4B.kvBytesPerToken, 2 * 36 * 8 * 128 * 2);
  assert.equal(VISION_MODEL_8B.kvBytesPerToken, 2 * 36 * 8 * 128 * 2);
  assert.equal(LOCAL_MODEL.kvBytesPerToken, 2 * 24 * 2 * 64 * 2);
  assert.equal(MODELS[0].vision, undefined, 'o primeiro (padrão das instalações antigas) é o básico, sem imagens');
});

// ------------------------------------------------------------------ LocalLlm: leitura, lista e subida do servidor

function fakeSpawn(log) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.exitCode = null; child.killed = false;
    log.push({ cmd, args });
    const port = Number(args[args.indexOf('--port') + 1]);
    const s = http.createServer((q, r) => { r.writeHead(q.url === '/health' ? 200 : 404); r.end('{}'); });
    s.listen(port, '127.0.0.1');
    s.unref(); // um teste que falha no meio não deixa o servidor falso segurando o processo (antes ele ficava preso até estourar o tempo)
    child.kill = () => { child.killed = true; child.exitCode = 0; s.close(); s.closeAllConnections(); setImmediate(() => child.emit('exit', 0)); };
    return child;
  };
}
const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

/** LocalLlm com o catálogo REAL, tudo "instalado" (arquivos vazios no lugar) e a leitura da placa trocada por `readGpu`. */
async function made(readGpu, { modelId = VISION_MODEL.id } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'm-'));
  const log = [];
  const llm = new LocalLlm({
    rootDir: path.join(dir, 'data'), tempDir: path.join(dir, 'temp'),
    config: { platform: 'win32', arch: 'x64', port: await freePort(), spawn: fakeSpawn(log), startTimeoutMs: 3000, readGpu }
  });
  const m = MODELS.find((x) => x.id === modelId);
  for (const f of llm._filesOf(m)) { fs.mkdirSync(path.dirname(f.dest), { recursive: true }); fs.writeFileSync(f.dest, ''); }
  fs.mkdirSync(llm.paths.runtimeGpu, { recursive: true });
  fs.writeFileSync(path.join(llm.paths.runtimeGpu, 'llama-server.exe'), '');
  llm._writeChoice(m.id);
  return { llm, log };
}

test('LocalLlm.getStatus: antes da leitura não diz o que cabe; depois traz a placa, o que cabe em cada modelo e o recomendado', async () => {
  const { llm } = await made(async () => raw(SMI_IDLE));
  const before = llm.getStatus();
  assert.equal(before.memory.checked, false);
  assert.equal(before.recommendedId, '');
  assert.ok(before.models.every((m) => m.fit === null));

  await llm.probeGpu();
  const s = llm.getStatus();
  assert.equal(s.memory.checked, true);
  assert.deepEqual(s.memory.gpu, { name: 'NVIDIA GeForce GTX 1650', totalMB: 4096, freeMB: 3938, source: 'nvidia-smi' });
  assert.equal(s.recommendedId, VISION_MODEL.id);
  const by = Object.fromEntries(s.models.map((m) => [m.id, m.fit.state]));
  assert.deepEqual(by, { 'qwen2.5-0.5b-instruct': 'fits', 'qwen3-vl-2b-instruct': 'fits', 'qwen3-vl-4b-instruct': 'partial', 'qwen3-vl-8b-instruct': 'slow' });
});

test('LocalLlm: só placa integrada ou nenhuma placa: sem recomendação por memória, e o servidor sobe como antes (-ngl 99)', async () => {
  for (const [readGpu, checked] of [
    [async () => ({ vulkan: mem.parseListDevices('  Vulkan0: Intel(R) Iris(R) Xe Graphics (12179 MiB, 11411 MiB free)\n'), nvidia: [] }), true],
    [async () => ({ vulkan: [], nvidia: [] }), true],
    [async () => { throw new Error('nvidia-smi quebrou'); }, false] // a leitura falhou: não se sabe nada, não se recomenda nada
  ]) {
    const { llm, log } = await made(readGpu);
    await llm.probeGpu();
    const s = llm.getStatus();
    assert.equal(s.memory.gpu, null);
    assert.equal(s.memory.checked, checked);
    assert.equal(s.recommendedId, checked ? VISION_MODEL.id : '', checked ? 'sem placa dedicada: o menor modelo com visão' : 'sem leitura, sem recomendação');
    await llm.ensureRunning();
    assert.ok(log[0].args.includes('-ngl') && log[0].args[log[0].args.indexOf('-ngl') + 1] === '99', 'comportamento de antes');
    assert.equal(log[0].args.includes('--fit'), false);
    await llm.stop();
  }
  const { llm } = await made(async () => ({ vulkan: mem.parseListDevices('  Vulkan0: Intel(R) Iris(R) Xe Graphics (12179 MiB, 11411 MiB free)\n'), nvidia: [] }));
  await llm.probeGpu();
  assert.equal(llm.getStatus().memory.integratedOnly, true);
});

test('LocalLlm sobe o servidor com a memória LIVRE de agora: placa livre = tudo na placa; ocupada = parte na CPU e projetor na CPU; sem espaço = processador', async () => {
  const cases = [
    { smi: SMI_IDLE, mode: 'gpu', has: ['--fit', 'on', '--fit-target', String(Math.round(512 + est2b.projectorMB))], not: ['-ngl', '--no-mmproj-offload'] },
    { smi: SMI_BUSY, mode: 'partial', has: ['--fit-target', '2177', '--no-mmproj-offload'], not: ['-ngl'] },
    { smi: 'NVIDIA GeForce GTX 1650, 4096, 600\n', mode: 'cpu', has: ['--device', 'none', '-ngl', '0'], not: ['--fit'] }
  ];
  for (const c of cases) {
    const { llm, log } = await made(async () => raw(c.smi));
    await llm.ensureRunning();
    const a = log[0].args;
    for (const x of c.has) assert.ok(a.includes(x), `${c.mode}: faltou ${x} em ${a.join(' ')}`);
    for (const x of c.not) assert.equal(a.includes(x), false, `${c.mode}: não devia ter ${x}`);
    assert.equal(a[a.indexOf('-c') + 1], '8192', 'o contexto não muda');
    assert.ok(a.includes('--mmproj') && a.includes('--alias'));
    assert.match(log[0].cmd, /runtime-gpu/);
    assert.equal(llm._plan.mode, c.mode);
    assert.equal(llm.getStatus().plan.mode, c.mode, 'o estado diz como o servidor foi posicionado');
    await llm.stop();
  }
});

test('LocalLlm: a leitura do lançamento é nova (a memória livre muda); a do estado vale 15 s; com o servidor ligado na placa vale a de antes de ligar', async () => {
  let smi = SMI_IDLE;
  let reads = 0;
  const { llm, log } = await made(async () => { reads += 1; return raw(smi); });
  await llm.probeGpu();
  await llm.probeGpu();
  assert.equal(reads, 1, 'segunda leitura em menos de 15 s vem do cache');
  smi = SMI_BUSY;
  await llm.ensureRunning();
  assert.equal(reads, 2, 'ao ligar o servidor lê de novo');
  assert.ok(log[0].args.includes('--no-mmproj-offload'), 'e usa o que está livre AGORA');
  smi = SMI_IDLE;
  await llm.probeGpu({ force: true });
  assert.equal(reads, 2, 'com o servidor ligado na placa, a leitura de agora incluiria a memória dele: não vale');
  await llm.stop();
});

test('LocalLlm sem pacote com placa de vídeo (outro sistema): memory é null e nada de memória nos argumentos', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'n-'));
  const log = [];
  const llm = new LocalLlm({
    rootDir: path.join(dir, 'data'), tempDir: path.join(dir, 'temp'),
    config: { platform: 'linux', arch: 'x64', port: await freePort(), spawn: fakeSpawn(log), startTimeoutMs: 3000 }
  });
  assert.equal(llm.getStatus().memory, null);
  assert.equal(await llm.probeGpu(), null);
  assert.equal(llm.getStatus().recommendedId, '');
});

// ------------------------------------------------------------------ canal ai:localLlmStatus: lê a placa antes de responder

const { pathToFileURL } = require('node:url');
const { createRegistry, APP_PAGE } = require('../src/ipc/channelRegistry');
const registerAiHandlers = require('../src/ipc/aiHandlers');

function statusChannel(readGpu) {
  const dir = fs.mkdtempSync(path.join(tmp, 'h-'));
  const handlers = new Map();
  const reg = createRegistry({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, logger: { warn() {} } });
  registerAiHandlers({ configDir: path.join(dir, 'cfg'), dataDir: path.join(dir, 'data'), tempDir: path.join(dir, 'temp') }, {
    handle: reg.handle, isDev: false,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    settingsManager: { load: () => ({}) }, broadcast() {},
    localLlmConfig: { platform: 'win32', arch: 'x64', readGpu }
  });
  const url = pathToFileURL(APP_PAGE).href;
  const ev = { senderFrame: { url, parent: null }, sender: { getType: () => 'window', getURL: () => url } };
  return (ch, ...a) => handlers.get(ch)(ev, ...a);
}

test('ai:localLlmStatus devolve a placa, o que cabe em cada modelo e o recomendado (e não quebra se a leitura falhar)', async () => {
  const call = statusChannel(async () => raw(SMI_BUSY));
  const r = await call('ai:localLlmStatus');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.memory.gpu, { name: 'NVIDIA GeForce GTX 1650', totalMB: 4096, freeMB: 1896, source: 'nvidia-smi' });
  assert.equal(r.data.recommendedId, VISION_MODEL.id);
  const by = Object.fromEntries(r.data.models.map((m) => [m.id, m.fit.state]));
  assert.equal(by[VISION_MODEL.id], 'tight');
  assert.equal(r.data.providerAdded, false);

  const broken = statusChannel(async () => { throw new Error('sem nvidia-smi'); });
  const b = await broken('ai:localLlmStatus');
  assert.equal(b.ok, true, 'o estado sai mesmo sem a leitura da placa');
  assert.equal(b.data.memory.checked, false);
  assert.ok(b.data.models.every((m) => m.fit === null));
});
