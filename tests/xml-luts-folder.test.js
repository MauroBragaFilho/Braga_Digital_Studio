'use strict';

// LUTs ao lado do XML (S5): os três exportadores (XML de pastas e sequência multicâmera do XmemlExporter, XML de pastas
// e de sequência do PremiereExporter) copiam as LUTs do projeto para "<nome do XML> - LUTs", conferidas pelo conteúdo,
// sem sobrescrever, sem derrubar o XML e sem mudar o XML; também pelo caminho do assistente (ctx.exporters).
// Banco, coleção e saídas ficam em pastas temporárias.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-xmlluts-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');
const dbm = require('../src/core/database/database');
const { runMigrations } = require('../src/core/database/migrations');
const projectService = require('../src/core/projects/ProjectService');
const LutManager = require('../src/core/luts/LutManager');
const ProjectLutService = require('../src/core/projects/ProjectLutService');
const PremiereExporter = require('../src/core/projects/PremiereExporter');
const XmemlExporter = require('../src/core/projects/XmemlExporter');
const BdsproPackageService = require('../src/core/projects/BdsproPackageService');
const { libraryActionTools } = require('../src/services/ai/tools/libraryActionTools');
const { sha256 } = require('../src/core/luts/lutFileOps');
const { cube3d } = require('./helpers/cube-fixtures');

const lutsDir = path.join(tmpRoot, 'colecao');
const outDir = path.join(tmpRoot, 'saida');
fs.mkdirSync(lutsDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const manager = new LutManager(lutsDir);
const projectLuts = new ProjectLutService({ db: () => dbm.get(), lutManager: manager, projectService });
const sequenceStub = { buildSequenceModel: () => ({ projectName: 'Seq', fps: 30, duration: 0, width: 1920, height: 1080, videoTracks: [], audioTracks: [] }) };
const premiere = new PremiereExporter(projectService, sequenceStub, { projectLutService: projectLuts });
const premiereNoLuts = new PremiereExporter(projectService, sequenceStub);
const xmeml = new XmemlExporter(projectService, { projectLutService: projectLuts });
const emptyModel = { start: 0, lanes: [] };

test.before(async () => {
  await dbm.init(path.join(tmpRoot, 'data'));
  runMigrations();
});
test.after(async () => {
  await manager._hashFill;
  if (manager._persistTimer) clearTimeout(manager._persistTimer);
  try { dbm.close(); } catch (_) { /* já fechado */ }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let seq = 0;
const freshDirs = () => {
  for (const dir of [lutsDir, outDir]) for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  manager._hashes = null;
};
const put = (rel, content) => {
  const p = path.join(lutsDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};
async function projectWith(files) {
  freshDirs();
  const pid = projectService.createProject({ name: `Projeto ${++seq}` });
  for (const [rel, content] of Object.entries(files)) put(rel, content);
  if (Object.keys(files).length) assert.equal((await projectLuts.add(pid, Object.keys(files))).added, Object.keys(files).length);
  return pid;
}
const lutFiles = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.cube')).sort();
const activity = (pid) => projectService.listActivity(pid, 50);
const A = cube3d(2, { tint: 0.01 });
const B = cube3d(2, { tint: 0.02 });

test('XML de pastas do Premiere: copia as LUTs para "<nome do XML> - LUTs" e o XML é idêntico ao de antes', async () => {
  const pid = await projectWith({ 'Kodak.cube': A, 'Filmes/Fuji.cube': B });
  const withLuts = path.join(outDir, 'Projeto A.xml');
  const without = path.join(outDir, 'Controle.xml');
  assert.equal(premiere.exportToPremiereXml(pid, withLuts), withLuts, 'o retorno continua sendo o caminho do XML');
  premiereNoLuts.exportToPremiereXml(pid, without);
  assert.equal(fs.readFileSync(withLuts, 'utf8'), fs.readFileSync(without, 'utf8'), 'o XML em si não muda');

  const folder = path.join(outDir, 'Projeto A - LUTs');
  assert.deepEqual(lutFiles(folder), ['Fuji.cube', 'Kodak.cube'], 'achatadas, pelo nome da LUT');
  assert.equal(sha256(fs.readFileSync(path.join(folder, 'Kodak.cube'))), sha256(Buffer.from(A)));
  assert.equal(fs.existsSync(path.join(outDir, 'Controle - LUTs')), false, 'sem o serviço de LUTs, nada muda');
  assert.deepEqual(fs.readdirSync(folder).filter((n) => !n.endsWith('.cube')), [], 'nenhum temporário esquecido');
  const last = activity(pid)[0];
  assert.deepEqual([last.kind, last.message], ['lut', 'LUTs copiadas ao lado do XML']);
});

test('XML de sequência do Premiere: também leva as LUTs', async () => {
  const pid = await projectWith({ 'Kodak.cube': A });
  const xml = path.join(outDir, 'Sequência.xml');
  assert.equal(premiere.exportSequenceXml(pid, xml), xml);
  assert.deepEqual(lutFiles(path.join(outDir, 'Sequência - LUTs')), ['Kodak.cube']);
});

test('XML de pastas e multicâmera (xmeml): o resultado traz `luts` e a pasta é criada; o XML não menciona LUTs', async () => {
  const pid = await projectWith({ 'Kodak.cube': A, 'Fuji.cube': B });
  const bins = xmeml.exportBins(pid, path.join(outDir, 'pastas.xml'));
  assert.deepEqual(bins.luts, { folder: path.join(outDir, 'pastas - LUTs'), copied: 2, existing: 0, missing: 0, changed: 0, failed: 0 });
  const multi = xmeml.exportMulticam(pid, emptyModel, path.join(outDir, 'multicam.xml'));
  assert.equal(multi.luts.copied, 2);
  assert.deepEqual(lutFiles(path.join(outDir, 'multicam - LUTs')), ['Fuji.cube', 'Kodak.cube']);
  for (const f of ['pastas.xml', 'multicam.xml']) assert.doesNotMatch(fs.readFileSync(path.join(outDir, f), 'utf8'), /LUT|\.cube/i);
  // projeto sem LUTs: resultado idêntico ao de antes e nenhuma pasta
  const empty = await projectWith({});
  const plain = xmeml.exportBins(empty, path.join(outDir, 'vazio.xml'));
  assert.deepEqual(Object.keys(plain).sort(), ['clips', 'filePath']);
  assert.equal(fs.existsSync(path.join(outDir, 'vazio - LUTs')), false);
});

test('reexportar no mesmo lugar: o mesmo conteúdo é pulado, nunca duplicado (funciona com o cache de conteúdo frio e quente)', async () => {
  const pid = await projectWith({ 'Kodak.cube': A, 'Fuji.cube': B });
  const xml = path.join(outDir, 'a.xml');
  const first = xmeml.exportBins(pid, xml).luts;
  await manager.hashIndex(); // esquenta o cache de conteúdo
  const second = xmeml.exportBins(pid, xml).luts;
  assert.deepEqual([first.copied, first.existing, second.copied, second.existing], [2, 0, 0, 2]);
  assert.deepEqual(lutFiles(path.join(outDir, 'a - LUTs')), ['Fuji.cube', 'Kodak.cube']);
});

test('nome igual com conteúdo diferente ganha "(2)" e o arquivo que já estava lá nunca é sobrescrito', async () => {
  const pid = await projectWith({ 'Kodak.cube': A });
  const folder = path.join(outDir, 'b - LUTs');
  fs.mkdirSync(folder, { recursive: true });
  const theirs = cube3d(2, { tint: 0.77 });
  fs.writeFileSync(path.join(folder, 'Kodak.cube'), theirs);
  const result = xmeml.exportBins(pid, path.join(outDir, 'b.xml')).luts;
  assert.deepEqual([result.copied, result.existing], [1, 0]);
  assert.deepEqual(lutFiles(folder), ['Kodak (2).cube', 'Kodak.cube']);
  assert.equal(fs.readFileSync(path.join(folder, 'Kodak.cube'), 'utf8'), theirs, 'o arquivo do usuário continua intacto');
  assert.equal(fs.readFileSync(path.join(folder, 'Kodak (2).cube'), 'utf8'), A);
});

test('LUT alterada ou ausente não é copiada (e é contada); com cópia boa em outro lugar, vale o conteúdo', async () => {
  const pid = await projectWith({ 'Boa.cube': A, 'Muda.cube': B, 'Some.cube': cube3d(2, { tint: 0.03 }), 'Renomeada.cube': cube3d(2, { tint: 0.04 }) });
  put('Muda.cube', cube3d(2, { tint: 0.99 })); // outro conteúdo no mesmo caminho
  fs.rmSync(path.join(lutsDir, 'Some.cube'));
  fs.renameSync(path.join(lutsDir, 'Renomeada.cube'), path.join(lutsDir, 'Outro nome.cube'));
  const result = xmeml.exportBins(pid, path.join(outDir, 'c.xml')).luts;
  assert.deepEqual({ copied: result.copied, missing: result.missing, changed: result.changed, failed: result.failed }, { copied: 2, missing: 1, changed: 1, failed: 0 });
  assert.deepEqual(lutFiles(path.join(outDir, 'c - LUTs')), ['Boa.cube', 'Outro nome.cube']);
  assert.equal(fs.readFileSync(path.join(outDir, 'c - LUTs', 'Boa.cube'), 'utf8'), A);
});

test('só LUTs ausentes: nenhuma pasta é criada', async () => {
  const pid = await projectWith({ 'Some.cube': A });
  fs.rmSync(path.join(lutsDir, 'Some.cube'));
  const result = xmeml.exportBins(pid, path.join(outDir, 'd.xml')).luts;
  assert.deepEqual({ folder: result.folder, copied: result.copied, missing: result.missing }, { folder: null, copied: 0, missing: 1 });
  assert.equal(fs.existsSync(path.join(outDir, 'd - LUTs')), false);
  assert.equal(activity(pid).some((a) => a.message === 'LUTs copiadas ao lado do XML'), false, 'nada copiado: nada na atividade');
});

test('falha ao copiar não derruba a exportação: o XML sai, o resultado conta a falha', async () => {
  const pid = await projectWith({ 'Kodak.cube': A });
  fs.writeFileSync(path.join(outDir, 'e - LUTs'), 'sou um arquivo, não uma pasta');
  const xml = path.join(outDir, 'e.xml');
  const out = premiere.exportToPremiereXml(pid, xml);
  assert.equal(out, xml);
  assert.ok(fs.existsSync(xml), 'o XML foi gravado');
  assert.equal(fs.readFileSync(path.join(outDir, 'e - LUTs'), 'utf8'), 'sou um arquivo, não uma pasta', 'nada foi sobrescrito');
  const result = projectLuts.copyBesideXml(pid, xml);
  assert.deepEqual({ copied: result.copied, failed: result.failed }, { copied: 0, failed: 1 });
  // banco indisponível para a consulta: devolve null em vez de lançar
  const broken = new ProjectLutService({ db: () => ({ prepare() { throw new Error('banco fechado'); } }), lutManager: manager, projectService });
  assert.equal(broken.copyBesideXml(pid, xml), null);
  assert.doesNotThrow(() => new PremiereExporter(projectService, sequenceStub, { projectLutService: broken }).exportToPremiereXml(pid, path.join(outDir, 'f.xml')));
});

test('pasta de destino que é atalho/junção é recusada (nada é gravado fora)', async (t) => {
  const pid = await projectWith({ 'Kodak.cube': A });
  const target = path.join(tmpRoot, 'alvo-do-atalho');
  fs.mkdirSync(target, { recursive: true });
  try { fs.symlinkSync(target, path.join(outDir, 'g - LUTs'), 'junction'); } catch (_) { t.skip('o sistema não permite criar o atalho'); return; }
  const result = xmeml.exportBins(pid, path.join(outDir, 'g.xml')).luts;
  assert.equal(result.copied, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(fs.readdirSync(target), [], 'nada foi gravado no destino do atalho');
});

test('pelo caminho do assistente (ctx.exporters): o XML do Premiere e o pacote levam as LUTs sem tocar nas ferramentas', async () => {
  const pid = await projectWith({ 'Kodak.cube': A, 'Fuji.cube': B });
  const exportProject = libraryActionTools.find((tool) => tool.name === 'export_project');
  const exporters = {
    premiere,
    bdspro: new BdsproPackageService(projectService, { lutManager: manager, projectLutService: projectLuts }),
    thumbnailsDir: ''
  };
  const run = (format, file) => exportProject.run(
    { projectId: pid, projectName: 'Casamento', format },
    { exporters, chooseSavePath: async () => path.join(outDir, file), onStatus() {}, signal: null }
  );

  const x = await run('premiere', 'assistente.xml');
  assert.equal(x.exportado, true);
  assert.deepEqual(lutFiles(path.join(outDir, 'assistente - LUTs')), ['Fuji.cube', 'Kodak.cube']);

  const p = await run('bdspro', 'assistente.bdspro');
  assert.equal(p.exportado, true);
  const entries = new AdmZip(path.join(outDir, 'assistente.bdspro')).getEntries().map((e) => e.entryName).filter((n) => n.startsWith('luts/'));
  assert.equal(entries.length, 2);
});
