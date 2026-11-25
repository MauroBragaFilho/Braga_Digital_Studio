'use strict';

// LUTs embutidas: de onde o app lê (AppPaths), como o módulo as instala e como o build as confere.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppPaths } = require('../src/infrastructure/filesystem/AppPaths');
const { ModuleRuntime } = require('../src/bootstrap/moduleRuntime');
const { checkBundledLuts } = require('../scripts/verify-package-contents');
const { checkBundledLutsInPackage } = require('../scripts/after-pack-check');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bds-bundled-'));
}

// ─── AppPaths ────────────────────────────────────────────────────────────────

test('AppPaths.bundledLutsDir: instalado lê resources/luts-embutidas; desenvolvimento lê resources/luts-embutidas do repositório', () => {
  const installed = new AppPaths();
  installed.init(path.join('u', 'dados'), path.join('app', 'resources'), { packaged: true });
  assert.equal(installed.bundledLutsDir, path.join('app', 'resources', 'luts-embutidas'));

  const dev = new AppPaths();
  dev.init(path.join('repo'), path.join('repo'), { packaged: false });
  assert.equal(dev.bundledLutsDir, path.join('repo', 'resources', 'luts-embutidas'));

  const semOpcoes = new AppPaths();
  semOpcoes.init('w', 'repo');
  assert.equal(semOpcoes.bundledLutsDir, path.join('repo', 'resources', 'luts-embutidas'), 'sem opções vale o modo de desenvolvimento');
});

test('AppPaths.bundledLutsDir: só o valor true marca o app como instalado; fica separado da pasta gravável de LUTs', () => {
  const p = new AppPaths();
  p.init('w', 'r', { packaged: 'sim' });
  assert.equal(p.bundledLutsDir, path.join('r', 'resources', 'luts-embutidas'));
  p.init('w', 'r', { packaged: true });
  assert.notEqual(p.bundledLutsDir, p.lutsDir);
  assert.equal(p.toPlainObject().bundledLutsDir, p.bundledLutsDir);
  assert.throws(() => new AppPaths().bundledLutsDir, /não foi inicializado/);
});

test('main.js passa { packaged: isPackaged } ao inicializar os caminhos', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /appPaths\.init\(writableRoot, appRoot, \{ packaged: isPackaged \}\)/);
});

// ─── módulo de LUTs ──────────────────────────────────────────────────────────

test('módulo de LUTs: instala a partir de appPaths.bundledLutsDir (uma vez por execução)', () => {
  const calls = [];
  const rt = new ModuleRuntime();
  rt.setContext({
    settingsManager: { load: () => ({ enabledModules: {} }) },
    services: {},
    appPaths: { bundledLutsDir: path.join('onde', 'estao', 'luts-embutidas') },
    lutManager: { ensureBundledLuts: (dir) => calls.push(dir) }
  });
  assert.equal(rt.start('luts'), true);
  assert.deepEqual(calls, [path.join('onde', 'estao', 'luts-embutidas')]);
  assert.equal(rt.start('luts'), false, 'ligar de novo não repete');
  assert.equal(calls.length, 1);
});

// ─── verify-package-contents ─────────────────────────────────────────────────

/** Pasta com `files` ({ nome: conteúdo }) e um PROCEDENCIA.json montado a partir deles. */
function lutsFolder(files, { status = 'a-confirmar', release = false, extra = {} } = {}) {
  const dir = tmp();
  const arquivos = [];
  for (const [nome, content] of Object.entries(files)) {
    const buf = Buffer.from(content);
    fs.writeFileSync(path.join(dir, nome), buf);
    arquivos.push({ nome, bytes: buf.length, sha256: sha(buf), origem: 'x', licenca: 'x', status });
  }
  fs.writeFileSync(path.join(dir, 'PROCEDENCIA.json'), JSON.stringify({ release, excluidas: [{ nome: 'Adobe.cube' }], arquivos, ...extra }));
  return { dir, arquivos };
}

test('verify: pasta ausente ou sem PROCEDENCIA.json é erro, mesmo fora do release', () => {
  const root = tmp();
  assert.match(checkBundledLuts({ dir: path.join(root, 'nao-existe') }).problems[0], /Pasta ausente/);
  assert.match(checkBundledLuts({ dir: root }).problems[0], /PROCEDENCIA\.json ausente ou inválido/);
  fs.writeFileSync(path.join(root, 'PROCEDENCIA.json'), '{ quebrado');
  assert.match(checkBundledLuts({ dir: root }).problems[0], /PROCEDENCIA\.json ausente ou inválido/);
});

test('verify: a-confirmar só avisa em desenvolvimento e FALHA no release', () => {
  const { dir } = lutsFolder({ 'a.cube': 'LUT_3D_SIZE 2\n', 'b.cube': 'LUT_3D_SIZE 2\n0 0 0\n' });
  const dev = checkBundledLuts({ dir, release: false });
  assert.deepEqual(dev.problems, []);
  assert.match(dev.warnings.join('\n'), /a-confirmar/);
  const rel = checkBundledLuts({ dir, release: true });
  assert.match(rel.problems.join('\n'), /a-confirmar/);
});

test('verify: tudo confirmado passa no release; "release" precisa acompanhar o status', () => {
  const ok = lutsFolder({ 'a.cube': 'LUT_3D_SIZE 2\n' }, { status: 'confirmada', release: true });
  assert.deepEqual(checkBundledLuts({ dir: ok.dir, release: true }), { problems: [], warnings: [] });

  const esquecido = lutsFolder({ 'a.cube': 'LUT_3D_SIZE 2\n' }, { status: 'confirmada', release: false });
  assert.match(checkBundledLuts({ dir: esquecido.dir }).problems.join('\n'), /"release" não está true/);

  const incoerente = lutsFolder({ 'a.cube': 'LUT_3D_SIZE 2\n' }, { status: 'a-confirmar', release: true });
  assert.match(checkBundledLuts({ dir: incoerente.dir }).problems.join('\n'), /"release": true com LUTs ainda/);

  const invalido = lutsFolder({ 'a.cube': 'LUT_3D_SIZE 2\n' }, { status: 'talvez' });
  assert.match(checkBundledLuts({ dir: invalido.dir }).problems.join('\n'), /status inválido/);
});

test('verify: SHA-256 diferente, arquivo fora da lista, copyright no cabeçalho e LUT excluída reprovam sempre', () => {
  const { dir } = lutsFolder({ 'a.cube': 'LUT_3D_SIZE 2\n' }, { status: 'confirmada', release: true });
  fs.writeFileSync(path.join(dir, 'a.cube'), 'LUT_3D_SIZE 2\n0 0 0\n'); // conteúdo mudou depois do registro
  fs.writeFileSync(path.join(dir, 'intrusa.cube'), 'LUT_3D_SIZE 2\n');
  fs.writeFileSync(path.join(dir, 'Adobe.cube'), '# Copyright 2016, Adobe Systems Inc.\nLUT_1D_SIZE 2\n');
  const text = checkBundledLuts({ dir }).problems.join('\n');
  assert.match(text, /a\.cube: o conteúdo não confere com o SHA-256/);
  assert.match(text, /intrusa\.cube: não consta em PROCEDENCIA\.json/);
  assert.match(text, /Adobe\.cube: o cabeçalho traz aviso de copyright/);
  assert.match(text, /Adobe\.cube: está na lista de LUTs excluídas/);
});

test('verify: copyright no cabeçalho é detectado mesmo em letras minúsculas ou com "(c)"', () => {
  for (const header of ['# (c) 2020 alguém\n', '# COPYRIGHT alguém\n', '# feito pela adobe\n']) {
    const { dir } = lutsFolder({ 'a.cube': `${header}LUT_3D_SIZE 2\n` }, { status: 'confirmada', release: true });
    assert.match(checkBundledLuts({ dir }).problems.join('\n'), /aviso de copyright/, header);
  }
});

test('verify: clone limpo (sem .cube) só avisa fora do release e reprova no release', () => {
  const { dir, arquivos } = lutsFolder({ 'a.cube': 'LUT_3D_SIZE 2\n', 'b.cube': 'LUT_3D_SIZE 2\n0\n' }, { status: 'confirmada', release: true });
  for (const a of arquivos) fs.unlinkSync(path.join(dir, a.nome));
  const dev = checkBundledLuts({ dir });
  assert.deepEqual(dev.problems, []);
  assert.match(dev.warnings.join('\n'), /nenhuma das 2 LUTs/);
  assert.match(checkBundledLuts({ dir, release: true }).problems.join('\n'), /nenhuma das 2 LUTs/);
});

test('verify: faltando só algumas LUTs avisa em desenvolvimento e reprova no release', () => {
  const { dir } = lutsFolder({ 'a.cube': 'LUT_3D_SIZE 2\n', 'b.cube': 'LUT_3D_SIZE 2\n0\n' }, { status: 'confirmada', release: true });
  fs.unlinkSync(path.join(dir, 'b.cube'));
  assert.match(checkBundledLuts({ dir }).warnings.join('\n'), /faltam 1 das 2/);
  assert.match(checkBundledLuts({ dir, release: true }).problems.join('\n'), /faltam 1 das 2/);
});

test('verify: o script real, rodado sem --release, termina com sucesso e avisa; com --release recusa enquanto a-confirmar', () => {
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'scripts', 'verify-package-contents.js');
  const provenance = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'luts-embutidas', 'PROCEDENCIA.json'), 'utf8'));
  const pending = provenance.arquivos.some((a) => a.status !== 'confirmada');
  const env = { ...process.env };
  delete env.BDS_RELEASE;

  const dev = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
  assert.equal(dev.status, 0, dev.stderr);
  const rel = spawnSync(process.execPath, [script, '--release'], { encoding: 'utf8', env });
  assert.equal(rel.status, pending ? 1 : 0, rel.stderr);
  const viaEnv = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...env, BDS_RELEASE: '1' } });
  assert.equal(viaEnv.status, pending ? 1 : 0, viaEnv.stderr);
});

// ─── after-pack-check ────────────────────────────────────────────────────────

function packedWith(sourceNames, packedNames) {
  const root = tmp();
  const sourceDir = path.join(root, 'projeto', 'resources', 'luts-embutidas');
  const resourcesDir = path.join(root, 'saida', 'resources');
  const packedDir = path.join(resourcesDir, 'luts-embutidas');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(packedDir, { recursive: true });
  for (const n of sourceNames) fs.writeFileSync(path.join(sourceDir, n), 'x');
  for (const n of packedNames) fs.writeFileSync(path.join(packedDir, n), 'x');
  return { sourceDir, resourcesDir };
}

test('after-pack: o pacote precisa ter as mesmas .cube do projeto', () => {
  const ok = packedWith(['a.cube', 'b.cube'], ['a.cube', 'b.cube']);
  assert.deepEqual(checkBundledLutsInPackage({ ...ok }), { problems: [], warnings: [] });

  const faltando = packedWith(['a.cube', 'b.cube'], ['a.cube']);
  assert.match(checkBundledLutsInPackage({ ...faltando }).problems.join('\n'), /1 no pacote, 2 em resources/);

  const trocada = packedWith(['a.cube', 'b.cube'], ['a.cube', 'c.cube']);
  assert.equal(checkBundledLutsInPackage({ ...trocada }).problems.length, 1);
});

test('after-pack: pacote sem nenhuma LUT avisa e, em release, reprova', () => {
  const vazio = packedWith([], []);
  const dev = checkBundledLutsInPackage({ ...vazio });
  assert.deepEqual(dev.problems, []);
  assert.match(dev.warnings.join('\n'), /nenhuma LUT embutida/);
  assert.match(checkBundledLutsInPackage({ ...vazio, release: true }).problems.join('\n'), /nenhuma LUT embutida/);

  const semPasta = { sourceDir: vazio.sourceDir, resourcesDir: path.join(tmp(), 'resources') };
  assert.match(checkBundledLutsInPackage({ ...semPasta, release: true }).problems.join('\n'), /nenhuma LUT embutida/);
});

// ─── workflows de release ────────────────────────────────────────────────────

test('workflows: todo build de instalador confere as LUTs embutidas antes (--release) e roda com BDS_RELEASE=1', () => {
  // Num clone limpo as .cube não estão no Git: sem isto o instalador publicado sairia sem nenhuma LUT.
  const dir = path.join(__dirname, '..', '.github', 'workflows');
  const builds = { 'build-bds-release.yml': 1, 'build-bds-linux.yml': 1, 'release-sign.yml': 1, 'release-bds.yml': 2 };
  for (const [file, expected] of Object.entries(builds)) {
    const steps = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').split(/\n {6}- name: /).slice(1);
    const buildIndexes = steps.map((s, i) => (/--publish never/.test(s) ? i : -1)).filter((i) => i >= 0);
    assert.equal(buildIndexes.length, expected, `${file}: passos de build`);
    for (const i of buildIndexes) {
      assert.match(steps[i], /BDS_RELEASE: '1'/, `${file}: o build precisa de BDS_RELEASE=1`);
      assert.match(steps[i - 1], /^Conferir as LUTs embutidas \(release\)\n[\s\S]*run: npm run verify:package -- --release/, `${file}: falta conferir as LUTs logo antes do build`);
    }
  }
});
