'use strict';

// Modelo local do app (LocalLlm): instalação com conferência de SHA-256 a partir de fontes (aqui, um servidor falso),
// ligar/desligar o servidor sob demanda, plataforma sem pacote oficial, remoção, e a integração com o AIService
// (provedor "embedded": liga antes do uso; sem instalar, vira "indisponível" e o fallback segue).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const AdmZip = require('adm-zip');

const { LocalLlm } = require('../src/core/modules/LocalLlm');
const AIService = require('../src/services/ai/AIService');
const presets = require('../src/services/ai/providers/presets');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-llm-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const zip = new AdmZip();
zip.addFile('llama-bin/llama-server.exe', Buffer.from('MZ-fake-server'));
zip.addFile('llama-bin/ggml.dll', Buffer.from('dll'));
const ZIP = zip.toBuffer();
const MODEL = crypto.randomBytes(200000);

function sources() {
  const srv = http.createServer((req, res) => {
    if (req.url.endsWith('.zip')) { res.writeHead(200, { 'Content-Length': ZIP.length }); res.end(ZIP); return; }
    if (req.url.endsWith('.gguf')) { res.writeHead(200, { 'Content-Length': MODEL.length }); res.end(MODEL); return; }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

/** Processo falso: sobe um servidor HTTP com /health na porta pedida (como o llama-server faria). */
function fakeSpawn(log) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.exitCode = null; child.killed = false;
    const port = Number(args[args.indexOf('--port') + 1]);
    log.push({ cmd, args });
    const s = http.createServer((q, r) => { r.writeHead(q.url === '/health' ? 200 : 404); r.end('{}'); });
    s.listen(port, '127.0.0.1');
    child.kill = () => { child.killed = true; child.exitCode = 0; s.close(); s.closeAllConnections(); setImmediate(() => child.emit('exit', 0)); };
    return child;
  };
}

const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function make(over = {}) {
  const { srv, base } = await sources();
  const log = [];
  const dir = fs.mkdtempSync(path.join(tmp, 'c-'));
  const llm = new LocalLlm({
    rootDir: path.join(dir, 'data'), tempDir: path.join(dir, 'temp'),
    config: {
      platform: 'win32', arch: 'x64', port: await freePort(), spawn: fakeSpawn(log), githubBaseUrl: base, huggingFaceBaseUrl: base,
      downloadAttempts: 1, startTimeoutMs: 5000,
      release: { tag: 'bTEST', assets: { 'win32-x64': { name: 'llama-bTEST-bin-win-cpu-x64.zip', size: ZIP.length, sha256: sha(ZIP) } } },
      model: { id: 'm', label: 'Modelo de teste', repo: 'org/modelo', revision: 'rev1', file: 'm.gguf', size: MODEL.length, sha256: sha(MODEL), license: 'Apache 2.0' },
      ...over
    }
  });
  return { llm, srv, log, dir };
}

test('sem instalar: ensureRunning recusa com NOT_INSTALLED e o estado diz isso', async () => {
  const { llm, srv } = await make();
  try {
    assert.equal(llm.getStatus().installed, false);
    await assert.rejects(llm.ensureRunning(), (e) => e.code === 'NOT_INSTALLED');
  } finally { srv.close(); }
});

test('instala o servidor e o modelo com SHA-256 conferido, com progresso, e é idempotente', async () => {
  const { llm, srv } = await make();
  const events = [];
  llm.on('progress', (p) => events.push(p));
  try {
    const st = await llm.install();
    assert.equal(st.installed, true);
    assert.ok(fs.existsSync(path.join(llm.paths.runtime, 'llama-server.exe')), 'servidor extraído (pasta interna achatada)');
    assert.ok(fs.existsSync(path.join(llm.paths.runtime, 'ggml.dll')));
    assert.deepEqual(fs.readFileSync(llm.paths.model), MODEL);
    assert.ok(events.some((e) => e.phase === 'download') && events.at(-1).phase === 'done');
    assert.ok(events.every((e) => e.percent === null || (e.percent >= 0 && e.percent <= 100)));
    assert.equal(fs.existsSync(llm.work), false, 'a pasta de trabalho é limpa');
    await llm.install(); // de novo: nada a fazer
    assert.equal(llm.getStatus().installed, true);
  } finally { srv.close(); }
});

test('hash errado recusa a instalação e não deixa o modelo no lugar', async () => {
  const { llm, srv } = await make({ model: { id: 'm', label: 'x', repo: 'org/modelo', revision: 'rev1', file: 'm.gguf', size: MODEL.length, sha256: 'a'.repeat(64), license: '-' } });
  try {
    await assert.rejects(llm.install());
    assert.equal(llm.getStatus().installed, false);
    assert.equal(fs.existsSync(llm.paths.model), false);
  } finally { srv.close(); }
});

test('liga sob demanda só em 127.0.0.1 com a porta e o modelo certos, reaproveita e desliga', async () => {
  const { llm, srv, log } = await make();
  try {
    await llm.install();
    await llm.ensureRunning();
    assert.equal(log.length, 1);
    const a = log[0].args;
    assert.equal(a[a.indexOf('--host') + 1], '127.0.0.1');
    assert.equal(a[a.indexOf('-m') + 1], llm.paths.model);
    assert.ok(a.includes('--jinja'));
    assert.equal(llm.isRunning(), true);
    await llm.ensureRunning();
    assert.equal(log.length, 1, 'não liga de novo');
    await llm.stop();
    assert.equal(llm.isRunning(), false);
    await llm.ensureRunning();
    assert.equal(log.length, 2, 'depois de desligar, liga de novo quando preciso');
  } finally { await llm.stop(); srv.close(); }
});

test('desliga sozinho depois de um tempo sem uso', async () => {
  const { llm, srv } = await make({ idleMs: 150 });
  try {
    await llm.install();
    await llm.ensureRunning();
    assert.equal(llm.isRunning(), true);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(llm.isRunning(), false);
  } finally { await llm.stop(); srv.close(); }
});

test('remover desliga e apaga tudo; sistema sem pacote oficial fica indisponível', async () => {
  const { llm, srv } = await make();
  try {
    await llm.install();
    await llm.ensureRunning();
    const st = await llm.uninstall();
    assert.equal(st.installed, false);
    assert.equal(fs.existsSync(llm.root), false);
    assert.equal(llm.isRunning(), false);
  } finally { srv.close(); }
  const { llm: other, srv: s2 } = await make({ platform: 'freebsd' });
  try {
    assert.equal(other.getStatus().supported, false);
    await assert.rejects(other.install(), (e) => e.code === 'PLATFORM');
  } finally { s2.close(); }
});

test('AIService: o provedor "embedded" liga o modelo antes do uso; sem instalar vira falha de disponibilidade', async () => {
  assert.equal(presets.detectPreset(`http://127.0.0.1:${presets.EMBEDDED_PORT}/v1`), 'embedded');
  assert.equal(presets.publicList().some((p) => p.id === 'embedded'), false, 'não aparece no menu "Adicionar provedor"');
  const dir = fs.mkdtempSync(path.join(tmp, 'ai-'));
  let started = 0;
  const ai = new AIService({ configDir: dir, embedded: { ensureRunning: async () => { started++; } } });
  const out = ai.saveConfig({ addProvider: { preset: 'embedded' } });
  const p = out.providers.find((x) => x.preset === 'embedded');
  assert.ok(p && p.isLocal && !p.needsRemoteConsent, 'local: sem aviso de privacidade');
  await ai._prepare({ preset: 'embedded' });
  await ai._prepare({ preset: 'groq' });
  assert.equal(started, 1, 'só o provedor embedded liga o modelo');
  const noLlm = new AIService({ configDir: dir });
  await assert.rejects(noLlm._prepare({ preset: 'embedded' }), (e) => e.code === 'AI_UNREACHABLE');
  const notInstalled = new AIService({ configDir: dir, embedded: { ensureRunning: async () => { throw Object.assign(new Error('não instalado'), { code: 'NOT_INSTALLED' }); } } });
  await assert.rejects(notInstalled._prepare({ preset: 'embedded' }), (e) => e.code === 'AI_UNREACHABLE' && /não instalado/.test(e.message));
});
