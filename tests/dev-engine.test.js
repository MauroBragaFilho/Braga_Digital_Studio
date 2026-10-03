'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectDevEngine, findHfSnapshot } = require('../src/core/modules/devEngine');
const { ModuleManager } = require('../src/core/modules/ModuleManager');

const touch = (p, content = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

/** Monta uma "instalação" falsa: <raiz>/app, <raiz>/Whisper + LM Studio (.venv) e um cache do Hugging Face. */
function fakeSetup({ withVenv = true, models = ['Systran/faster-whisper-small', 'mobiuslabsgmbh/faster-whisper-large-v3-turbo'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-dev-'));
  const appRoot = path.join(root, 'app');
  const project = path.join(root, 'Whisper + LM Studio');
  const hub = path.join(root, 'hub');
  touch(path.join(appRoot, 'tools', 'whisper-dev', 'engine.py'));
  touch(path.join(project, 'legendar.py'));
  if (withVenv) {
    touch(path.join(project, '.venv', 'Scripts', 'python.exe'));
    touch(path.join(project, '.venv', 'Lib', 'site-packages', 'faster_whisper', '__init__.py'));
  }
  for (const repo of models) {
    const snap = path.join(hub, `models--${repo.replace('/', '--')}`, 'snapshots', 'abc123');
    for (const f of ['model.bin', 'config.json', 'tokenizer.json']) touch(path.join(snap, f));
  }
  return { root, appRoot, project, hub };
}

test('app empacotado nunca usa o motor de desenvolvimento', () => {
  const s = fakeSetup();
  assert.equal(detectDevEngine({ isPackaged: true, appRoot: s.appRoot, hubDir: s.hub }), null);
});

test('BDS_WHISPER_DEV=0 desliga o motor de desenvolvimento', () => {
  const s = fakeSetup();
  assert.equal(detectDevEngine({ isPackaged: false, appRoot: s.appRoot, hubDir: s.hub, env: { BDS_WHISPER_DEV: '0' } }), null);
});

test('sem a pasta do projeto, ou sem o .venv, não ativa', () => {
  const missing = fakeSetup({ withVenv: false });
  assert.equal(detectDevEngine({ isPackaged: false, appRoot: missing.appRoot, hubDir: missing.hub, env: {} }), null);
  const s = fakeSetup();
  assert.equal(detectDevEngine({ isPackaged: false, appRoot: s.appRoot, hubDir: s.hub, env: { BDS_WHISPER_DEV_DIR: path.join(s.root, 'nao-existe') } }), null);
});

test('detecta o Python do projeto e os modelos do cache (id do catálogo → snapshot)', () => {
  const s = fakeSetup();
  const dev = detectDevEngine({ isPackaged: false, appRoot: s.appRoot, hubDir: s.hub, env: {}, ffmpegPath: 'C:/ff/ffmpeg.exe' });
  assert.ok(dev);
  assert.equal(dev.command, path.join(s.project, '.venv', 'Scripts', 'python.exe'));
  assert.deepEqual(dev.baseArgs, [path.join(s.appRoot, 'tools', 'whisper-dev', 'engine.py')]);
  assert.deepEqual(Object.keys(dev.models).sort(), ['large-v3-turbo', 'small']);
  assert.equal(dev.env.WL_DEV_PROJECT, s.project);
  assert.equal(dev.env.WL_FFMPEG, 'C:/ff/ffmpeg.exe');
});

test('snapshot incompleto no cache do Hugging Face é ignorado', () => {
  const s = fakeSetup({ models: [] });
  const snap = path.join(s.hub, 'models--Systran--faster-whisper-base', 'snapshots', 'x');
  touch(path.join(snap, 'config.json')); // falta model.bin
  assert.equal(findHfSnapshot(s.hub, 'Systran/faster-whisper-base'), null);
});

test('ModuleManager em modo dev: pronto sem instalar nada, modelo recomendado ativo, motor e CUDA protegidos', async () => {
  const s = fakeSetup();
  const dev = detectDevEngine({ isPackaged: false, appRoot: s.appRoot, hubDir: s.hub, env: {} });
  const mgr = new ModuleManager({ rootDir: path.join(s.root, 'data'), tempDir: path.join(s.root, 'tmp'), config: { devEngine: dev, platform: 'win32' } });

  const w = (await mgr.getStatus()).whisper;
  assert.equal(w.ready, true);
  assert.equal(w.engine.installed, true);
  assert.equal(w.engine.source, 'dev');
  assert.equal(w.cuda.installed, true);
  assert.equal(w.activeModelId, 'large-v3-turbo'); // o recomendado, não o primeiro da lista
  const small = w.models.find((m) => m.id === 'small');
  assert.deepEqual([small.installed, small.external], [true, true]);
  assert.equal(w.models.find((m) => m.id === 'tiny').installed, false);

  // nada que baixe por cima do cache externo, nem mexa no motor/CUDA do ambiente local
  await assert.rejects(() => mgr.installModel('small'), (e) => e.code === 'DEV_ENGINE');
  await assert.rejects(() => mgr.uninstallEngine(), (e) => e.code === 'DEV_ENGINE');
  await assert.rejects(() => mgr.installCuda({ acceptLicense: true }), (e) => e.code === 'DEV_ENGINE');
  await assert.rejects(() => mgr.removeCuda(), (e) => e.code === 'DEV_ENGINE');
  assert.ok(fs.existsSync(path.join(dev.models.small, 'model.bin')));
});

test('remover modelo do cache (modo dev): libera a pasta do repositório, nunca o modelo em uso', async () => {
  const s = fakeSetup();
  const dev = detectDevEngine({ isPackaged: false, appRoot: s.appRoot, hubDir: s.hub, env: {} });
  const mgr = new ModuleManager({ rootDir: path.join(s.root, 'data'), tempDir: path.join(s.root, 'tmp'), config: { devEngine: dev, platform: 'win32' } });

  const smallRepo = path.join(s.hub, 'models--Systran--faster-whisper-small');
  const turboRepo = path.join(s.hub, 'models--mobiuslabsgmbh--faster-whisper-large-v3-turbo');
  assert.equal(dev.repoDirs.small, smallRepo);

  // o modelo em uso (large-v3-turbo) não pode ser removido
  await assert.rejects(() => mgr.removeModel('large-v3-turbo'), (e) => e.code === 'IN_USE');
  assert.ok(fs.existsSync(turboRepo));

  // um modelo sem uso é removido, e só o dele
  const w = (await mgr.removeModel('small')).whisper;
  assert.equal(fs.existsSync(smallRepo), false);
  assert.ok(fs.existsSync(turboRepo));
  assert.equal(w.models.find((m) => m.id === 'small').installed, false);
  assert.equal(w.activeModelId, 'large-v3-turbo');
  assert.equal(w.ready, true);
});

test('remover modelo do cache: recusa uma pasta que não seja de um repositório models--*', async () => {
  const s = fakeSetup();
  const dev = detectDevEngine({ isPackaged: false, appRoot: s.appRoot, hubDir: s.hub, env: {} });
  dev.repoDirs.small = s.hub; // pasta errada (o cache inteiro): nunca pode ser apagada
  const mgr = new ModuleManager({ rootDir: path.join(s.root, 'data'), tempDir: path.join(s.root, 'tmp'), config: { devEngine: dev, platform: 'win32' } });
  await assert.rejects(() => mgr.removeModel('small'), (e) => e.code === 'UNSAFE_PATH');
  assert.ok(fs.existsSync(path.join(s.hub, 'models--Systran--faster-whisper-small')));
  assert.ok(fs.existsSync(path.join(s.hub, 'models--mobiuslabsgmbh--faster-whisper-large-v3-turbo')));
});

test('sem o modo dev, nada muda: motor ausente continua "não instalado"', async () => {
  const s = fakeSetup();
  const mgr = new ModuleManager({ rootDir: path.join(s.root, 'data'), tempDir: path.join(s.root, 'tmp'), config: { platform: 'win32' } });
  const w = (await mgr.getStatus()).whisper;
  assert.equal(w.engine.installed, false);
  assert.equal(w.ready, false);
  assert.equal(w.engine.dev, null);
});

test('transcrever em modo dev: o motor recebe o modelo ativo e as variáveis do contrato', async () => {
  const s = fakeSetup();
  // "Motor" falso em Node que respeita o contrato: grava o ambiente recebido e um .srt de saída.
  const fake = path.join(s.root, 'fake-engine.js');
  fs.writeFileSync(fake, `
    const fs = require('fs'), path = require('path');
    const args = process.argv.slice(2);
    const files = args.filter((a) => /\\.wav$/.test(a));
    for (const f of files) fs.writeFileSync(path.join(path.dirname(f), path.basename(f, '.wav') + '.srt'), '1\\n00:00:00,000 --> 00:00:01,000\\nolá\\n');
    fs.appendFileSync(process.env.WL_LOG, '[device] CPU\\n[progress] 100.0\\n');
    fs.appendFileSync(process.env.WL_LOG, 'RESULTADO ok=' + files.length + ' falhas=0 [CPU]\\n');
    fs.writeFileSync(path.join(path.dirname(files[0]), 'env.json'), JSON.stringify({ model: process.env.WL_MODEL_DIR, proj: process.env.WL_DEV_PROJECT, cuda: process.env.WL_CUDA_DIR || null }));
  `);
  const dev = detectDevEngine({ isPackaged: false, appRoot: s.appRoot, hubDir: s.hub, env: {} });
  dev.command = process.execPath;
  dev.baseArgs = [fake];
  const mgr = new ModuleManager({ rootDir: path.join(s.root, 'data'), tempDir: path.join(s.root, 'tmp'), config: { devEngine: dev, platform: 'win32' } });

  const media = path.join(s.root, 'aula.wav');
  fs.writeFileSync(media, 'x');
  const res = await mgr.transcribe({ files: [media], srt: true });

  assert.equal(res.ok, 1);
  assert.equal(res.model, 'large-v3-turbo');
  assert.equal(res.outputs.length, 1);
  const env = JSON.parse(fs.readFileSync(path.join(s.root, 'env.json'), 'utf8'));
  assert.equal(env.model, dev.models['large-v3-turbo']);
  assert.equal(env.proj, s.project);
  assert.equal(env.cuda, null); // em modo dev as DLLs vêm do .venv, não de uma pasta do BDS
});
