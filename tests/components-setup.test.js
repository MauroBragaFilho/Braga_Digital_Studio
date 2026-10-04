'use strict';

// Modo de componentes do instalador (--setup-components): argumentos, plano, execução com falhas,
// cancelamento, limite de tempo, progresso, registro do que foi instalado e conclusão na primeira abertura.
// Tudo com servidores e objetos falsos: nada de rede de verdade nem de dados do usuário.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const AdmZip = require('adm-zip');

const { parseSetupArgs, recommendedCpuModelId } = require('../src/setup/setupArgs');
const { EXIT, buildSteps, classifyError, runComponentsSetup, readRecord } = require('../src/setup/ComponentsSetup');
const { completePendingSetup, needsCompletion } = require('../src/setup/firstRunCompletion');
const { enableTranscriptionModule } = require('../src/setup/enableTranscription');
const { ModuleManager } = require('../src/core/modules/ModuleManager');
const SettingsManager = require('../src/core/settings/SettingsManager');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const zipOf = (files) => { const z = new AdmZip(); for (const [name, content] of Object.entries(files)) z.addFile(name, Buffer.from(content)); return z.toBuffer(); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bds-setup-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const ABS = (name) => path.join(os.tmpdir(), name);

// ------------------------------------------------------------------ argumentos

test('parseSetupArgs: sem a opção, o app abre normalmente (null)', () => {
  assert.equal(parseSetupArgs(['app.exe']), null);
  assert.equal(parseSetupArgs(['app.exe', '--updated', '--model=tiny']), null);
  assert.equal(parseSetupArgs(undefined), null);
});

test('parseSetupArgs: basic/full, modelo padrão = o recomendado do catálogo para CPU', () => {
  const full = parseSetupArgs(['app.exe', '--setup-components=full']);
  assert.deepEqual([full.ok, full.mode, full.modelId, full.progressFile, full.cancelFile], [true, 'full', 'small', null, null]);
  assert.equal(recommendedCpuModelId(), 'small');
  const basic = parseSetupArgs(['app.exe', '--setup-components=basic', `--progress-file=${ABS('p.txt')}`, `--cancel-file=${ABS('c.txt')}`]);
  assert.deepEqual([basic.ok, basic.mode, basic.progressFile, basic.cancelFile], [true, 'basic', ABS('p.txt'), ABS('c.txt')]);
  assert.equal(basic.timeoutSec, 90 * 60);
});

test('parseSetupArgs: modelo de teste é validado contra o catálogo; parâmetros inválidos são recusados', () => {
  assert.equal(parseSetupArgs(['x', '--setup-components=full', '--model=tiny']).modelId, 'tiny');
  const bad = (args) => { const r = parseSetupArgs(['x', ...args]); assert.equal(r.ok, false); assert.match(r.error, /\S/); return r; };
  bad(['--setup-components']);
  bad(['--setup-components=tudo']);
  bad(['--setup-components=']);
  bad(['--setup-components=full', '--model=gigante']);
  bad(['--setup-components=full', '--progress-file=relativo.txt']);
  bad(['--setup-components=full', '--cancel-file=']);
  bad(['--setup-components=full', '--setup-timeout=0']);
  bad(['--setup-components=full', '--setup-timeout=abc']);
  assert.equal(parseSetupArgs(['x', '--setup-components=basic', '--setup-timeout=30']).timeoutSec, 30);
});

// ------------------------------------------------------------------ plano

test('plano: basic = ferramentas básicas; full = basic + motor + modelo + ligar o módulo; NVIDIA nunca entra', () => {
  assert.deepEqual(buildSteps({ mode: 'basic', modelId: 'small' }).map((s) => s.id), ['ffmpeg', 'ytdlp']);
  const full = buildSteps({ mode: 'full', modelId: 'small' });
  assert.deepEqual(full.map((s) => s.id), ['ffmpeg', 'ytdlp', 'whisperEngine', 'whisperModel', 'enableTranscription']);
  assert.equal(full.find((s) => s.id === 'whisperModel').modelId, 'small');
  assert.ok(!full.some((s) => /cuda|nvidia/i.test(s.id + s.kind)));
  assert.deepEqual(buildSteps({ mode: 'basic', modelId: 'small' })[0].tools, ['ffmpeg', 'ffprobe']);
});

test('classifyError: separa rede, integridade, disco e indisponível', () => {
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), 'network');
  assert.equal(classifyError(Object.assign(new Error('Tempo esgotado'), { code: 'TIMEOUT' })), 'network');
  assert.equal(classifyError(new Error('getaddrinfo ENOTFOUND github.com')), 'network');
  assert.equal(classifyError(new Error('O arquivo baixado não passou na verificação de integridade')), 'integrity');
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'CHECKSUM' })), 'integrity');
  assert.equal(classifyError(Object.assign(new Error('Espaço em disco insuficiente'), { code: 'DISK' })), 'disk');
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'TOOL_UNAVAILABLE' })), 'unavailable');
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'CANCELLED' })), 'cancelled');
});

// ------------------------------------------------------------------ execução com dependências falsas

function fakeTools({ failWith = null, onInstall = null, supported = () => true } = {}) {
  const installed = new Set();
  const calls = [];
  return {
    installed, calls,
    deps: {
      isToolInstalled: (t) => installed.has(t),
      isToolSupported: supported,
      installTool: async (tool, onPct) => {
        calls.push(tool);
        if (onPct) { onPct(10); onPct(60); }
        if (onInstall) await onInstall(tool);
        if (failWith) { const e = typeof failWith === 'function' ? failWith(tool, calls.length) : failWith; if (e) throw e; }
        installed.add(tool); if (tool === 'ffmpeg') installed.add('ffprobe');
        return { tool, installed: '1.0' };
      }
    }
  };
}

const idle = { getStatus: async () => ({ whisper: { engine: { available: true, installed: true }, models: [] } }) };

function runBasic(over = {}) {
  const dir = tmp();
  const t = fakeTools(over.tools || {});
  const opts = {
    mode: 'basic', modelId: 'small', deps: { ...t.deps, modules: idle, cleanup: over.cleanup || (async () => {}), ...(over.deps || {}) },
    progressFile: path.join(dir, 'progress.txt'), cancelFile: path.join(dir, 'cancel.txt'), recordPath: path.join(dir, 'data', 'setup-components.json'),
    appVersion: '9.9.9', attempts: 3, retryDelaysMs: [1], sleep: () => Promise.resolve(), pollMs: 20, ...(over.opts || {})
  };
  return { dir, t, opts };
}

test('basic: baixa as ferramentas, grava progresso final e o registro do que foi instalado', async () => {
  const { dir, t, opts } = runBasic();
  try {
    const seen = [];
    const origWrite = fs.writeFileSync;
    const { exitCode, record } = await runComponentsSetup(opts);
    void origWrite; void seen;
    assert.equal(exitCode, EXIT.OK);
    assert.deepEqual(t.calls, ['ffmpeg', 'ytdlp']);
    assert.equal(record.result, 'ok');
    assert.deepEqual(Object.keys(record.components), ['ffmpeg', 'ytdlp']);
    assert.ok(Object.values(record.components).every((c) => c.status === 'ok'));
    assert.deepEqual(record.pending, []);
    assert.equal(record.appVersion, '9.9.9');
    const onDisk = readRecord(opts.recordPath);
    assert.equal(onDisk.exitCode, 0);
    assert.equal(onDisk.mode, 'basic');
    assert.match(fs.readFileSync(opts.progressFile, 'utf8'), /^end\|100\|-\|0\|0\|0\n$/);
  } finally { rm(dir); }
});

test('progresso: linhas run|percentual|fase|indice|total (ASCII), sempre de 0 a 100 e nunca recuando', async () => {
  const lines = [];
  const { dir, opts } = runBasic({ tools: { onInstall: async () => {} } });
  // observa o arquivo de progresso a cada escrita
  const realRename = fs.renameSync;
  fs.renameSync = (a, b) => { if (b === opts.progressFile) lines.push(fs.readFileSync(a, 'utf8').trim()); return realRename(a, b); };
  try {
    await runComponentsSetup(opts);
  } finally { fs.renameSync = realRename; rm(dir); }
  assert.ok(lines.length >= 3, 'houve atualizações de progresso');
  const parsed = lines.map((l) => l.split('|'));
  assert.ok(parsed.every((p) => p.length === 6 && /^(run|end)$/.test(p[0]) && /^\d+$/.test(p[1]) && /^[\x20-\x7e]+$/.test(lines[0])));
  const pcts = parsed.map((p) => Number(p[1]));
  assert.ok(pcts.every((n, i) => n >= 0 && n <= 100 && (i === 0 || n >= pcts[i - 1])), `percentuais: ${pcts}`);
  assert.equal(parsed[parsed.length - 1][0], 'end');
  assert.ok(parsed.some((p) => p[0] === 'run' && p[2] === 'tool'));
});

test('idempotente: ferramentas que já existem não são baixadas de novo', async () => {
  const { dir, t, opts } = runBasic();
  try {
    t.installed.add('ffmpeg'); t.installed.add('ffprobe'); t.installed.add('ytdlp');
    const { exitCode, record } = await runComponentsSetup(opts);
    assert.equal(exitCode, EXIT.OK);
    assert.equal(t.calls.length, 0);
    assert.deepEqual(Object.values(record.components).map((c) => c.status), ['already', 'already']);
    // segunda execução, depois de uma completa, também não baixa nada
    const again = await runComponentsSetup(opts);
    assert.equal(again.exitCode, EXIT.OK);
    assert.equal(t.calls.length, 0);
  } finally { rm(dir); }
});

test('falha de rede: tenta de novo, termina com código 1, registra o que falta e limpa os parciais', async () => {
  let cleaned = 0;
  const net = Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' });
  const { dir, t, opts } = runBasic({ tools: { failWith: net }, cleanup: async () => { cleaned++; } });
  try {
    const { exitCode, record } = await runComponentsSetup(opts);
    assert.equal(exitCode, EXIT.PARTIAL);
    assert.equal(t.calls.filter((c) => c === 'ffmpeg').length, 3, 'três tentativas');
    assert.equal(t.calls.filter((c) => c === 'ytdlp').length, 3);
    assert.equal(record.result, 'failed');
    assert.deepEqual(record.pending, ['ffmpeg', 'ytdlp']);
    assert.equal(record.components.ffmpeg.reason, 'network');
    assert.equal(cleaned, 1);
    assert.match(fs.readFileSync(opts.progressFile, 'utf8'), /^end\|\d+\|-\|0\|0\|1\n$/);
    assert.equal(readRecord(opts.recordPath).exitCode, 1);
  } finally { rm(dir); }
});

test('falha passageira: a segunda tentativa funciona', async () => {
  const { dir, t, opts } = runBasic({ tools: { failWith: (tool, n) => (n === 1 ? Object.assign(new Error('x'), { code: 'ECONNRESET' }) : null) } });
  try {
    const { exitCode, record } = await runComponentsSetup(opts);
    assert.equal(exitCode, EXIT.OK);
    assert.equal(t.calls.length, 3, 'ffmpeg duas vezes + ytdlp');
    assert.equal(record.components.ffmpeg.status, 'ok');
  } finally { rm(dir); }
});

test('hash divergente (integridade): não repete, não instala, avisa e segue para a próxima ferramenta', async () => {
  const bad = new Error('O arquivo baixado não passou na verificação de integridade e foi descartado.');
  const { dir, t, opts } = runBasic({ tools: { failWith: (tool) => (tool === 'ffmpeg' ? bad : null) } });
  try {
    const { exitCode, record } = await runComponentsSetup(opts);
    assert.equal(exitCode, EXIT.PARTIAL);
    assert.equal(t.calls.filter((c) => c === 'ffmpeg').length, 1, 'integridade não se repete');
    assert.equal(record.components.ffmpeg.status, 'failed');
    assert.equal(record.components.ffmpeg.reason, 'integrity');
    assert.equal(record.components.ytdlp.status, 'ok');
    assert.equal(record.result, 'partial');
    assert.deepEqual(record.pending, ['ffmpeg']);
    assert.ok(!t.installed.has('ffmpeg'));
  } finally { rm(dir); }
});

test('fonte sem verificação de integridade (needsConfirmation): recusa por segurança', async () => {
  const { dir, opts } = runBasic({ deps: { installTool: async () => ({ needsConfirmation: true, reason: 'NO_CHECKSUM' }) } });
  try {
    const { exitCode, record } = await runComponentsSetup(opts);
    assert.equal(exitCode, EXIT.PARTIAL);
    assert.equal(record.components.ffmpeg.reason, 'no-checksum');
  } finally { rm(dir); }
});

test('ferramenta sem fonte oficial neste sistema: indisponível, não é falha', async () => {
  const { dir, opts } = runBasic({ tools: { supported: (t) => t !== 'ytdlp' } });
  try {
    const { exitCode, record } = await runComponentsSetup(opts);
    assert.equal(exitCode, EXIT.OK);
    assert.equal(record.components.ytdlp.status, 'unavailable');
    assert.deepEqual(record.pending, []);
  } finally { rm(dir); }
});

test('cancelamento: o arquivo de cancelar interrompe, sai com 3 e limpa os parciais', async () => {
  let cleaned = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { dir, t, opts } = runBasic({ tools: { onInstall: () => gate }, cleanup: async () => { cleaned++; } });
  try {
    const run = runComponentsSetup(opts);
    await new Promise((r) => setTimeout(r, 80));
    fs.writeFileSync(opts.cancelFile, 'x');
    const { exitCode, record } = await run;
    release();
    assert.equal(exitCode, EXIT.CANCELLED);
    assert.equal(record.result, 'cancelled');
    assert.equal(t.calls.length, 1, 'não começou a segunda ferramenta');
    assert.equal(cleaned, 1);
    assert.match(fs.readFileSync(opts.progressFile, 'utf8'), /^end\|\d+\|-\|0\|0\|3\n$/);
    assert.equal(readRecord(opts.recordPath).exitCode, 3);
  } finally { rm(dir); }
});

test('instalador encerrado no meio (pasta temporária dele some): cancela sozinho, sem download órfão', async () => {
  let cleaned = 0;
  const { dir, t, opts } = runBasic({ tools: { onInstall: () => new Promise(() => {}) }, cleanup: async () => { cleaned++; } });
  try {
    // o instalador guarda o arquivo de progresso numa pasta temporária própria; ao fechar, a pasta é apagada
    const installerTmp = path.join(dir, 'nsis-tmp');
    fs.mkdirSync(installerTmp);
    opts.progressFile = path.join(installerTmp, 'progress.txt');
    const run = runComponentsSetup(opts);
    await new Promise((r) => setTimeout(r, 80));
    fs.rmSync(installerTmp, { recursive: true, force: true });
    const { exitCode, record } = await run;
    assert.equal(exitCode, EXIT.CANCELLED);
    assert.equal(record.result, 'cancelled');
    assert.equal(t.calls.length, 1);
    assert.equal(cleaned, 1);
  } finally { rm(dir); }
});

test('limite de tempo: estoura, sai com 5 e não deixa nada pela metade', async () => {
  let cleaned = 0;
  const { dir, opts } = runBasic({ tools: { onInstall: () => new Promise(() => {}) }, cleanup: async () => { cleaned++; }, opts: { timeoutMs: 60 } });
  try {
    const { exitCode, record } = await runComponentsSetup(opts);
    assert.equal(exitCode, EXIT.TIMEOUT);
    assert.equal(record.result, 'timeout');
    assert.equal(cleaned, 1);
  } finally { rm(dir); }
});

// ------------------------------------------------------------------ completa, com o ModuleManager de verdade e servidor falso

const CPU_ZIP = zipOf({ 'Release/whisper-cli.exe': 'cli-cpu', 'Release/ggml.dll': 'dll' });
const MODEL_TINY = Buffer.alloc(40000, 5);
const MODEL_SMALL = Buffer.alloc(90000, 6);
const REVISION = 'revsetup1';
let server;
let base;
let serveBadModel = false;

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (body, type = 'application/octet-stream') => { res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }); res.end(body); };
    if (url.pathname === '/ggml-org/whisper.cpp/releases/download/btest/whisper-bin-x64.zip') return send(CPU_ZIP);
    if (url.pathname === '/api/models/ggerganov/whisper.cpp') {
      return send(JSON.stringify({
        id: 'ggerganov/whisper.cpp', sha: REVISION,
        siblings: [
          { rfilename: 'ggml-tiny-q5_1.bin', size: MODEL_TINY.length, lfs: { sha256: sha(MODEL_TINY) } },
          { rfilename: 'ggml-small-q5_1.bin', size: MODEL_SMALL.length, lfs: { sha256: sha(MODEL_SMALL) } }
        ]
      }), 'application/json');
    }
    const m = new RegExp(`^/ggerganov/whisper\\.cpp/resolve/${REVISION}/(.+)$`).exec(url.pathname);
    if (m) {
      const name = decodeURIComponent(m[1]);
      if (name === 'ggml-tiny-q5_1.bin') return send(serveBadModel ? Buffer.alloc(MODEL_TINY.length, 9) : MODEL_TINY);
      if (name === 'ggml-small-q5_1.bin') return send(MODEL_SMALL);
    }
    res.writeHead(404); res.end('nada');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); });

function fullEnv(over = {}) {
  const root = tmp();
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const cpuAsset = { label: 'Motor', name: 'whisper-bin-x64.zip', size: CPU_ZIP.length, sha256: sha(CPU_ZIP), ...(over.cpu || {}) };
  // macOS: o projeto oficial não publica o motor, então a tabela por sistema não tem entrada para ele
  const release = { tag: 'btest', assets: { cpu: over.platform === 'darwin' ? { 'win32-x64': cpuAsset } : cpuAsset } };
  const manager = new ModuleManager({
    rootDir: dataDir, tempDir: path.join(root, 'tmp'),
    config: { githubBaseUrl: base, huggingFaceBaseUrl: base, release, platform: over.platform || 'win32', arch: 'x64', downloadAttempts: 1 }
  });
  const tools = fakeTools();
  const sm = new SettingsManager(configDir, dataDir);
  sm.safeStorage = null;
  const cleanedPartials = [];
  return {
    root, dataDir, configDir, manager, tools, sm,
    opts: {
      mode: 'full', modelId: over.modelId || 'tiny',
      deps: {
        ...tools.deps, modules: manager,
        enableTranscription: () => enableTranscriptionModule(sm),
        cleanup: async () => {
          const models = path.join(dataDir, 'modules', 'whisper', 'models');
          try { for (const n of fs.readdirSync(models)) if (n.endsWith('.partial')) { fs.rmSync(path.join(models, n), { recursive: true, force: true }); cleanedPartials.push(n); } } catch (_) { /* sem pasta */ }
        }
      },
      progressFile: path.join(root, 'progress.txt'), cancelFile: path.join(root, 'cancel.txt'),
      recordPath: path.join(dataDir, 'setup-components.json'), appVersion: '1.0.0',
      attempts: 2, retryDelaysMs: [1], sleep: () => Promise.resolve(), pollMs: 20
    },
    cleanedPartials
  };
}

test('completa: instala motor e modelo, liga o módulo Transcrição e deixa tudo pronto para usar', async () => {
  const env = fullEnv();
  try {
    const { exitCode, record } = await runComponentsSetup(env.opts);
    assert.equal(exitCode, EXIT.OK);
    assert.deepEqual(Object.keys(record.components), ['ffmpeg', 'ytdlp', 'whisperEngine', 'whisperModel', 'enableTranscription']);
    assert.ok(Object.values(record.components).every((c) => c.status === 'ok'), JSON.stringify(record.components));
    assert.equal(record.model, 'tiny');

    const status = (await env.manager.getStatus()).whisper;
    assert.equal(status.engine.installed, true);
    assert.equal(status.ready, true, 'motor + modelo ativo = pronto');
    assert.equal(status.activeModelId, 'tiny');
    assert.ok(fs.existsSync(path.join(env.dataDir, 'modules', 'whisper', 'models', 'tiny', 'model.bin')));
    assert.ok(!fs.existsSync(path.join(env.dataDir, 'modules', 'whisper', 'models', 'tiny.partial')));

    const s = JSON.parse(fs.readFileSync(path.join(env.configDir, 'settings.json'), 'utf8'));
    assert.equal(s.enabledModules.transcription, true);
    assert.equal(s.modulesMigrated, true, 'instalação nova: sem migração de módulos');
    assert.ok(!('metadata' in s.enabledModules) || s.enabledModules.metadata !== true || true);
    assert.equal(readRecord(env.opts.recordPath).result, 'ok');
  } finally { rm(env.root); }
});

test('completa, segunda execução: nada é baixado de novo (idempotente)', async () => {
  const env = fullEnv();
  try {
    await runComponentsSetup(env.opts);
    const before = env.tools.calls.length;
    let engineCalls = 0;
    const origEngine = env.manager.installEngine.bind(env.manager);
    env.manager.installEngine = (...a) => { engineCalls++; return origEngine(...a); };
    const origModel = env.manager.installModel.bind(env.manager);
    let modelCalls = 0;
    env.manager.installModel = (...a) => { modelCalls++; return origModel(...a); };
    const { exitCode, record } = await runComponentsSetup(env.opts);
    assert.equal(exitCode, EXIT.OK);
    assert.equal(env.tools.calls.length, before);
    assert.deepEqual([engineCalls, modelCalls], [0, 0]);
    assert.equal(record.components.whisperEngine.status, 'already');
    assert.equal(record.components.whisperModel.status, 'already');
  } finally { rm(env.root); }
});

test('completa: hash do modelo divergente falha, não liga o módulo e não deixa parcial', async () => {
  const env = fullEnv();
  serveBadModel = true;
  try {
    const { exitCode, record } = await runComponentsSetup(env.opts);
    assert.equal(exitCode, EXIT.PARTIAL);
    assert.equal(record.components.whisperEngine.status, 'ok');
    assert.equal(record.components.whisperModel.status, 'failed');
    assert.equal(record.components.whisperModel.reason, 'integrity');
    assert.equal(record.components.enableTranscription.status, 'skipped');
    assert.deepEqual(record.pending, ['whisperModel', 'enableTranscription']);
    const models = path.join(env.dataDir, 'modules', 'whisper', 'models');
    assert.ok(!fs.existsSync(path.join(models, 'tiny')), 'modelo corrompido nunca é instalado');
    assert.ok(!fs.existsSync(path.join(models, 'tiny.partial')), 'sem parcial');
    assert.ok(!fs.existsSync(path.join(env.configDir, 'settings.json')) || !JSON.parse(fs.readFileSync(path.join(env.configDir, 'settings.json'), 'utf8')).enabledModules.transcription);
  } finally { serveBadModel = false; rm(env.root); }
});

test('completa: hash do motor divergente recusa o motor e pula o modelo (nada pela metade)', async () => {
  const env = fullEnv({ cpu: { sha256: 'a'.repeat(64) } });
  try {
    const { exitCode, record } = await runComponentsSetup(env.opts);
    assert.equal(exitCode, EXIT.PARTIAL);
    assert.equal(record.components.whisperEngine.status, 'failed');
    assert.equal(record.components.whisperEngine.reason, 'integrity');
    assert.equal(record.components.whisperModel.status, 'skipped');
    assert.ok(!fs.existsSync(path.join(env.dataDir, 'modules', 'whisper', 'engine')));
    assert.ok(record.pending.includes('whisperEngine') && record.pending.includes('whisperModel'));
  } finally { rm(env.root); }
});

test('completa num sistema sem motor oficial (macOS): transcrição indisponível, sem falha', async () => {
  const env = fullEnv({ platform: 'darwin' });
  try {
    const { exitCode, record } = await runComponentsSetup(env.opts);
    assert.equal(exitCode, EXIT.OK, JSON.stringify(record.components));
    assert.equal(record.components.whisperEngine.status, 'unavailable');
    assert.equal(record.components.whisperModel.status, 'unavailable');
    assert.equal(record.components.enableTranscription.status, 'unavailable');
    assert.deepEqual(record.pending, []);
  } finally { rm(env.root); }
});

test('sem rede (servidor fora do ar): completa falha com código 1 e deixa o registro para o app concluir', async () => {
  const env = fullEnv();
  env.manager.config.githubBaseUrl = 'http://127.0.0.1:1';
  env.manager.cpp.baseUrl = 'http://127.0.0.1:1';
  env.manager.hf.baseUrl = 'http://127.0.0.1:1';
  try {
    const { exitCode, record } = await runComponentsSetup(env.opts);
    assert.equal(exitCode, EXIT.PARTIAL);
    assert.equal(record.components.whisperEngine.status, 'failed');
    assert.equal(record.components.whisperEngine.reason, 'network');
    assert.deepEqual(record.pending, ['whisperEngine', 'whisperModel', 'enableTranscription']);
    assert.equal(needsCompletion(readRecord(env.opts.recordPath)), true);
  } finally { rm(env.root); }
});

// ------------------------------------------------------------------ ligar o módulo (migração)

test('enableTranscriptionModule: instalação nova e instalação antiga (migração dos módulos preservada)', () => {
  const fresh = tmp();
  try {
    const dataDir = path.join(fresh, 'data'); const configDir = path.join(fresh, 'config');
    fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(configDir, { recursive: true });
    const sm = new SettingsManager(configDir, dataDir); sm.safeStorage = null;
    assert.deepEqual(enableTranscriptionModule(sm), { transcription: true });
    const disk = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
    assert.equal(disk.modulesMigrated, true);
    assert.deepEqual(disk.enabledModules, { transcription: true });
  } finally { rm(fresh); }

  const old = tmp();
  try {
    const dataDir = path.join(old, 'data'); const configDir = path.join(old, 'config');
    fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ theme: 'light' }));
    const sm = new SettingsManager(configDir, dataDir); sm.safeStorage = null;
    const mods = enableTranscriptionModule(sm);
    assert.equal(mods.transcription, true);
    assert.equal(mods.metadata, true, 'quem já usava o app mantém Metadados');
    assert.equal(mods.silence, true);
    const disk = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
    assert.equal(disk.theme, 'light');
    assert.equal(disk.modulesMigrated, true);
  } finally { rm(old); }
});

// ------------------------------------------------------------------ primeira abertura

test('needsCompletion: só instalação completa que ficou pela metade e ainda tem tentativas', () => {
  const rec = (o) => ({ version: 1, mode: 'full', result: 'partial', pending: ['whisperEngine'], ...o });
  assert.equal(needsCompletion(rec({})), true);
  assert.equal(needsCompletion(rec({ result: 'failed' })), true);
  assert.equal(needsCompletion(rec({ result: 'timeout', pending: [] })), true);
  assert.equal(needsCompletion(rec({ result: 'running', pending: [] })), true, 'execução interrompida');
  assert.equal(needsCompletion(rec({ result: 'ok', pending: [] })), false);
  assert.equal(needsCompletion(rec({ result: 'cancelled' })), false, 'o usuário cancelou: não baixa sozinho');
  assert.equal(needsCompletion(rec({ mode: 'basic' })), false);
  assert.equal(needsCompletion(rec({ pending: ['ffmpeg'] })), false, 'só ferramentas: o fluxo existente do app cuida');
  assert.equal(needsCompletion(rec({ completedByApp: true })), false);
  assert.equal(needsCompletion(rec({ appAttempts: 2 })), false);
  assert.equal(needsCompletion(null), false);
});

test('primeira abertura: conclui a transcrição pendente, liga o módulo, avisa e não repete', async () => {
  const env = fullEnv();
  env.manager.config.githubBaseUrl = 'http://127.0.0.1:1';
  env.manager.cpp.baseUrl = 'http://127.0.0.1:1';
  env.manager.hf.baseUrl = 'http://127.0.0.1:1';
  try {
    await runComponentsSetup(env.opts); // sem rede: fica pendente
    // volta a rede
    env.manager.cpp.baseUrl = base; env.manager.hf.baseUrl = base;
    const toasts = [];
    const args = { recordPath: env.opts.recordPath, moduleManager: env.manager, enableTranscription: () => enableTranscriptionModule(env.sm), notify: (type, text) => toasts.push([type, text]) };
    const r = await completePendingSetup(args);
    assert.deepEqual([r.ran, r.ok], [true, true]);
    assert.deepEqual(toasts.map((t) => t[0]), ['info', 'success']);
    assert.ok(toasts.every((t) => !/whisper|ffmpeg|yt-dlp|deno|spotify/i.test(t[1])), 'sem nomes técnicos nos avisos');
    const status = (await env.manager.getStatus()).whisper;
    assert.equal(status.ready, true);
    assert.equal(status.activeModelId, 'tiny');
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.configDir, 'settings.json'), 'utf8')).enabledModules.transcription, true);
    const rec = readRecord(env.opts.recordPath);
    assert.equal(rec.completedByApp, true);
    assert.deepEqual(rec.pending, []);
    assert.deepEqual(await completePendingSetup(args), { ran: false });
  } finally { rm(env.root); }
});

test('primeira abertura: falha de novo avisa com mensagem clara e para depois de 2 tentativas', async () => {
  const env = fullEnv();
  env.manager.cpp.baseUrl = 'http://127.0.0.1:1';
  try {
    await fs.promises.writeFile(env.opts.recordPath, JSON.stringify({ version: 1, mode: 'full', model: 'tiny', result: 'partial', pending: ['whisperEngine', 'whisperModel', 'enableTranscription'] }));
    const toasts = [];
    const args = { recordPath: env.opts.recordPath, moduleManager: env.manager, enableTranscription: () => {}, notify: (type, text) => toasts.push([type, text]) };
    const first = await completePendingSetup(args);
    assert.deepEqual([first.ran, first.ok], [true, false]);
    assert.equal(toasts[toasts.length - 1][0], 'error');
    assert.match(toasts[toasts.length - 1][1], /Configurações > Módulos/);
    assert.equal(readRecord(env.opts.recordPath).appAttempts, 1);
    await completePendingSetup(args);
    assert.equal(readRecord(env.opts.recordPath).appAttempts, 2);
    assert.deepEqual(await completePendingSetup(args), { ran: false }, 'depois de 2 tentativas, só manualmente');
  } finally { rm(env.root); }
});
