'use strict';

// LUTs no pacote .bdspro (S5): ida e volta, LUT já na coleção, pacote hostil (zip-slip, conteúdo que não bate com o
// hash, não-.cube, tamanho acima do teto, mais de 100 itens, hash repetido), pacote antigo (gerado pelo exportador de
// antes das LUTs), pacote sem LUT idêntico ao de antes, chave `luts` sem dados internos, orçamento do pacote e
// inspeção sem abrir os arquivos de LUT. Banco, coleções e pacotes ficam em pastas temporárias.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const AdmZip = require('adm-zip');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-bdsprolut-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');
const dbm = require('../src/core/database/database');
const { runMigrations } = require('../src/core/database/migrations');
const projectService = require('../src/core/projects/ProjectService');
const LutManager = require('../src/core/luts/LutManager');
const ProjectLutService = require('../src/core/projects/ProjectLutService');
const BdsproPackageService = require('../src/core/projects/BdsproPackageService');
const { sha256 } = require('../src/core/luts/lutFileOps');
const { cube3d, cube1d } = require('./helpers/cube-fixtures');

const srcDir = path.join(tmpRoot, 'colecao-origem');
const dstDir = path.join(tmpRoot, 'colecao-destino');
fs.mkdirSync(srcDir, { recursive: true });
fs.mkdirSync(dstDir, { recursive: true });
const srcManager = new LutManager(srcDir);
const dstManager = new LutManager(dstDir);
const srcLuts = new ProjectLutService({ db: () => dbm.get(), lutManager: srcManager, projectService });
const dstLuts = new ProjectLutService({ db: () => dbm.get(), lutManager: dstManager, projectService });
const exporter = new BdsproPackageService(projectService, { lutManager: srcManager, projectLutService: srcLuts });
const importer = new BdsproPackageService(projectService, { lutManager: dstManager, projectLutService: dstLuts });

test.before(async () => {
  await dbm.init(path.join(tmpRoot, 'data'));
  runMigrations();
});
test.after(async () => {
  await srcManager._hashFill;
  await dstManager._hashFill;
  for (const m of [srcManager, dstManager]) if (m._persistTimer) clearTimeout(m._persistTimer);
  try { dbm.close(); } catch (_) { /* já fechado */ }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let seq = 0;
const clearDir = (dir, manager) => {
  for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  manager._hashes = null;
};
const freshCollections = () => { clearDir(srcDir, srcManager); clearDir(dstDir, dstManager); };
const put = (dir, rel, content) => {
  const p = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};
const rows = (pid) => dbm.get().prepare('SELECT * FROM project_luts WHERE project_id = ? ORDER BY id').all(pid);
const db = () => dbm.get();
const outFile = (name) => path.join(tmpRoot, `${++seq}-${name}.bdspro`);
const HEX = (c) => c.repeat(64);

/** Projeto novo com LUTs da coleção de origem adicionadas pelo serviço (como a tela faz). */
async function projectWithLuts(files) {
  freshCollections();
  const pid = projectService.createProject({ name: `Projeto ${++seq}` });
  for (const [rel, content] of Object.entries(files)) put(srcDir, rel, content);
  const added = await srcLuts.add(pid, Object.keys(files));
  assert.equal(added.added, Object.keys(files).length);
  return pid;
}

/** Pacote montado à mão (para os casos hostis): project.json + entradas. */
function craftPackage(file, { luts, entries = {}, project = {} }) {
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(JSON.stringify({ metadata: { name: 'Pacote de teste' }, ...project, ...(luts === undefined ? {} : { luts }) }), 'utf8'));
  for (const [name, buf] of Object.entries(entries)) {
    try { zip.addFile(name, buf); } catch (_) { /* o adm-zip pode recusar o nome: o teste continua sem a entrada */ }
  }
  zip.writeZip(file);
  return file;
}
const readProjectJson = (file) => JSON.parse(new AdmZip(file).getEntry('project.json').getData().toString('utf8'));

test('ida e volta: as LUTs vão no pacote por hash e voltam numa coleção vazia, conferidas pelo conteúdo', async () => {
  const a = cube3d(3, { title: 'Kodak', tint: 0.01 });
  const b = cube1d(8);
  const pid = await projectWithLuts({ 'Kodak.cube': a, 'Filmes/Curva.cube': b });
  const out = outFile('ida-volta');
  const res = await exporter.exportBdspro(pid, out, '');
  assert.equal(res.success, true);
  assert.deepEqual({ included: res.luts.included, missing: res.luts.missing, skipped: res.luts.skipped, warnings: res.luts.warnings }, { included: 2, missing: 0, skipped: 0, warnings: [] });
  assert.equal(res.luts.bytes, Buffer.byteLength(a) + Buffer.byteLength(b));

  const hashA = sha256(Buffer.from(a));
  const hashB = sha256(Buffer.from(b));
  const names = new AdmZip(out).getEntries().map((e) => e.entryName).sort();
  assert.deepEqual(names, ['luts/' + hashA + '.cube', 'luts/' + hashB + '.cube', 'project.json'].sort(), 'nomes só pelo conteúdo, nunca o nome do usuário');

  // a chave `luts` do project.json: só os campos do plano, sem caminho da coleção, id nem projeto
  const json = readProjectJson(out);
  assert.equal(json.luts.length, 2);
  for (const item of json.luts) {
    assert.deepEqual(Object.keys(item).sort(), ['bytes', 'entry', 'hash', 'included', 'kind', 'lutSize', 'name', 'reason', 'title']);
    assert.equal(item.included, true);
    assert.equal(item.entry, `luts/${item.hash}.cube`);
  }
  assert.doesNotMatch(JSON.stringify(json.luts), /lut_rel_path|project_id|"id"|Filmes/);
  assert.equal(json.version, '1.1.0');

  // importa numa coleção vazia (outro "computador")
  const imp = await importer.importBdspro(out, {}, '', '');
  assert.equal(imp.success, true);
  assert.deepEqual({ linked: imp.luts.linked, restored: imp.luts.restored, existing: imp.luts.existing, failed: imp.luts.failed, linkOnly: imp.luts.linkOnly }, { linked: 2, restored: 2, existing: 0, failed: 0, linkOnly: 0 });
  assert.deepEqual(imp.lutsWarnings, []);
  const restored = fs.readdirSync(dstDir).filter((n) => n.endsWith('.cube')).sort();
  assert.deepEqual(restored, ['Curva.cube', 'Kodak.cube'], 'na raiz da coleção, pelo nome da LUT');
  assert.equal(sha256(fs.readFileSync(path.join(dstDir, 'Kodak.cube'))), hashA);
  assert.equal(sha256(fs.readFileSync(path.join(dstDir, 'Curva.cube'))), hashB);
  assert.equal(rows(imp.projectId).length, 2);
  assert.ok(rows(imp.projectId).every((r) => r.lut_rel_path === null), 'a ligação nasce só pelo conteúdo');
  const listed = await dstLuts.list(imp.projectId);
  assert.deepEqual(listed.map((l) => l.status), ['ok', 'ok']);
  assert.deepEqual(listed.map((l) => l.name).sort(), ['Curva', 'Kodak']);
});

test('LUT que já está na coleção só liga: nada é gravado de novo (mesmo conteúdo com outro nome conta)', async () => {
  const a = cube3d(2, { tint: 0.03 });
  const pid = await projectWithLuts({ 'Original.cube': a });
  const out = outFile('ja-existe');
  await exporter.exportBdspro(pid, out, '');
  put(dstDir, 'Meus/Outro nome.cube', a);
  const before = fs.readdirSync(dstDir, { recursive: true }).length;
  const imp = await importer.importBdspro(out, {}, '', '');
  assert.deepEqual({ restored: imp.luts.restored, existing: imp.luts.existing, linked: imp.luts.linked }, { restored: 0, existing: 1, linked: 1 });
  assert.equal(fs.readdirSync(dstDir, { recursive: true }).length, before);
  const [item] = await dstLuts.list(imp.projectId);
  assert.equal(item.status, 'ok');
  assert.equal(item.relPath, 'Meus/Outro nome.cube');
});

test('pacote hostil: entrada fora de luts/, conteúdo diferente do hash, não-.cube e arquivo ausente são descartados sem escrever fora da coleção', async () => {
  freshCollections();
  const good = Buffer.from(cube3d(2, { tint: 0.01 }));
  const liar = Buffer.from(cube3d(2, { tint: 0.02 }));
  const garbage = Buffer.from('isto nao e uma LUT\n');
  const hashGood = sha256(good);
  const liarName = HEX('1');
  const hashGarbage = sha256(garbage);
  const file = craftPackage(outFile('hostil'), {
    entries: {
      [`luts/${hashGood}.cube`]: good,
      [`luts/${liarName}.cube`]: liar, // o nome diz um hash, o conteúdo tem outro
      [`luts/${hashGarbage}.cube`]: garbage,
      'luts/../../fora.cube': good,
      '../fora-do-zip.cube': good
    },
    luts: [
      { hash: hashGood, name: 'Boa', kind: '3D', lutSize: 2, bytes: good.length, entry: `luts/${hashGood}.cube`, included: true },
      { hash: liarName, name: 'Mentirosa', entry: `luts/${liarName}.cube`, included: true },
      { hash: hashGarbage, name: 'Lixo', entry: `luts/${hashGarbage}.cube`, included: true },
      { hash: HEX('c'), name: 'Caminho', entry: 'luts/../../fora.cube', included: true },
      { hash: HEX('d'), name: 'Sem arquivo', entry: `luts/${HEX('d')}.cube`, included: true },
      { hash: 'nao-e-um-hash', name: 'Hash ruim', entry: 'luts/x.cube', included: true },
      { hash: hashGood, name: 'Repetida', entry: `luts/${hashGood}.cube`, included: true }
    ]
  });
  const imp = await importer.importBdspro(file, {}, '', '');
  assert.equal(imp.success, true, 'o projeto é importado mesmo com LUTs ruins');
  assert.deepEqual({ linked: imp.luts.linked, restored: imp.luts.restored, failed: imp.luts.failed, linkOnly: imp.luts.linkOnly }, { linked: 5, restored: 1, failed: 3, linkOnly: 1 });
  assert.ok(imp.lutsWarnings.some((w) => /Mentirosa.*conteúdo não confere com o nome/.test(w)));
  assert.ok(imp.lutsWarnings.some((w) => /Lixo/.test(w)));
  assert.ok(imp.lutsWarnings.some((w) => /Sem arquivo.*não está no pacote/.test(w)));
  assert.ok(imp.lutsWarnings.some((w) => /2 itens da lista de LUTs do pacote foram descartados/.test(w)), 'hash inválido e repetido');
  assert.deepEqual(fs.readdirSync(dstDir).filter((n) => !n.startsWith('.')), ['Boa.cube'], 'só a LUT boa foi gravada, com o nome limpo');
  for (const outside of [path.join(dstDir, '..', 'fora.cube'), path.join(dstDir, '..', '..', 'fora.cube'), path.join(tmpRoot, 'fora-do-zip.cube')]) {
    assert.equal(fs.existsSync(outside), false, `nada fora da coleção: ${outside}`);
  }
  assert.equal(rows(imp.projectId).length, 5);
  const byName = Object.fromEntries((await dstLuts.list(imp.projectId)).map((l) => [l.name, l.status]));
  assert.equal(byName.Boa, 'ok');
  assert.equal(byName.Mentirosa, 'missing', 'sem o arquivo, aparece como LUT ausente');
});

test('pacote hostil: arquivo de LUT acima do teto de 32 MB não é nem aberto', async () => {
  freshCollections();
  const huge = Buffer.alloc(33 * 1024 * 1024, 0x61);
  const hash = sha256(huge);
  const file = craftPackage(outFile('enorme'), {
    entries: { [`luts/${hash}.cube`]: huge },
    luts: [{ hash, name: 'Enorme', bytes: huge.length, entry: `luts/${hash}.cube`, included: true }]
  });
  // o tamanho declarado acima do teto é descartado na limpeza (vira desconhecido); o da entrada continua sendo conferido
  const imp = await importer.importBdspro(file, {}, '', '');
  assert.equal(imp.success, true);
  assert.equal(imp.luts.restored, 0);
  assert.equal(imp.luts.failed, 1);
  assert.match(imp.lutsWarnings[0], /Enorme.*tamanho fora do limite/);
  assert.equal(fs.readdirSync(dstDir).filter((n) => !n.startsWith('.')).length, 0);
});

test('pacote hostil: 101 itens ficam em 100 (com aviso) e itens repetidos viram um só', async () => {
  freshCollections();
  const list = Array.from({ length: 101 }, (_, i) => ({ hash: sha256(Buffer.from(`lut-${i}`)), name: `L${i}` }));
  list.push({ ...list[0] }); // repetida
  const file = craftPackage(outFile('muitas'), { luts: list });
  const info = await importer.inspectBdspro(file);
  assert.deepEqual({ total: info.luts.total, skipped: info.luts.skipped, bytes: info.luts.bytes }, { total: 102, skipped: 102, bytes: 0 }, 'sem arquivo no pacote: só vínculos');
  const imp = await importer.importBdspro(file, {}, '', '');
  assert.equal(imp.success, true);
  assert.equal(rows(imp.projectId).length, 100);
  assert.equal(imp.luts.linkOnly, 100);
  assert.ok(imp.lutsWarnings.some((w) => /2 itens da lista de LUTs do pacote foram descartados/.test(w)));
});

test('pacote hostil: nome e título com HTML, marcas bidirecionais e controles são limpos e limitados', async () => {
  freshCollections();
  const [bidiOverride, nul, bidiIsolate] = [0x202e, 0x0000, 0x2066].map((code) => String.fromCharCode(code));
  const evil = `<img src=x onerror=alert(1)>${bidiOverride}abc${nul}${bidiIsolate}x`;
  const file = craftPackage(outFile('nomes'), {
    luts: [
      { hash: HEX('a'), name: evil, title: `${evil}${'t'.repeat(500)}`, kind: '3D', lutSize: 17, bytes: 100 },
      { hash: HEX('b'), name: 'n'.repeat(500), title: 42, kind: 'XX', lutSize: 'grande', bytes: -5 }
    ]
  });
  const imp = await importer.importBdspro(file, {}, '', '');
  const [first, second] = rows(imp.projectId);
  for (const bad of [bidiOverride, nul, bidiIsolate]) assert.equal(first.lut_name.includes(bad), false);
  assert.match(first.lut_name, /^<img src=x onerror=alert\(1\)> ?abc ?x$/, 'o texto fica como texto (a tela usa textContent), sem marcas invisíveis');
  assert.ok(first.lut_title.length <= 200);
  assert.equal(second.lut_name.length, 120);
  assert.deepEqual([second.lut_title, second.lut_kind, second.lut_size, second.file_bytes], [null, null, null, null]);
  assert.equal(first.lut_rel_path, null);
});

test('pacote antigo (gerado pelo exportador de antes das LUTs) importa como antes, sem chave de LUTs no resultado', async () => {
  freshCollections();
  const legacy = path.join(__dirname, 'fixtures', 'legacy-package.bdspro');
  assert.equal(readProjectJson(legacy).luts, undefined, 'o pacote de teste realmente não tem a chave');
  const info = await importer.inspectBdspro(legacy);
  assert.equal(info.valid, true);
  assert.equal('luts' in info, false);
  const imp = await importer.importBdspro(legacy, {}, '', '');
  assert.deepEqual(Object.keys(imp).sort(), ['projectId', 'projectName', 'success']);
  assert.equal(imp.projectName, 'Pacote antigo');
  assert.equal(rows(imp.projectId).length, 0);
  assert.equal(projectService.getProjectMedia(imp.projectId).length, 1);
});

test('exportar projeto sem LUTs: project.json idêntico ao de antes (sem a chave luts) e resultado igual ao antigo', async () => {
  freshCollections();
  const pid = projectService.createProject({ name: 'Sem LUTs' });
  projectService.createBin(pid, null, 'Brutos');
  const expected = projectService.getProjectFullModel(pid);
  expected.metadata.cover_relative_path = null;
  const out = outFile('sem-luts');
  const res = await exporter.exportBdspro(pid, out, '');
  assert.deepEqual(Object.keys(res).sort(), ['filePath', 'markersCount', 'mediaCount', 'success', 'tracksCount']);
  const text = new AdmZip(out).getEntry('project.json').getData().toString('utf8');
  assert.equal(text, JSON.stringify(expected, null, 2));
  assert.equal('luts' in JSON.parse(text), false);
  assert.deepEqual(new AdmZip(out).getEntries().map((e) => e.entryName), ['project.json']);
});

test('LUT ausente ou alterada vai como vínculo (included:false com o motivo) e a exportação continua', async () => {
  const pid = await projectWithLuts({ 'Boa.cube': cube3d(2, { tint: 0.1 }), 'Some.cube': cube3d(2, { tint: 0.2 }), 'Muda.cube': cube3d(2, { tint: 0.3 }) });
  fs.rmSync(path.join(srcDir, 'Some.cube'));
  put(srcDir, 'Muda.cube', cube3d(2, { tint: 0.9 })); // outro conteúdo no mesmo caminho
  const out = outFile('ausente');
  const res = await exporter.exportBdspro(pid, out, '');
  assert.equal(res.luts.included, 1);
  assert.equal(res.luts.missing, 2);
  assert.ok(res.luts.warnings.some((w) => /2 LUTs do projeto não estão mais na coleção/.test(w)));
  const json = readProjectJson(out);
  const by = Object.fromEntries(json.luts.map((l) => [l.name, l]));
  assert.deepEqual([by.Boa.included, by.Some.included, by.Some.reason, by.Muda.included, by.Muda.reason], [true, false, 'LUT ausente', false, 'arquivo alterado']);
  assert.equal(by.Some.entry, null);
  assert.equal(new AdmZip(out).getEntries().filter((e) => e.entryName.startsWith('luts/')).length, 1);
  // reimportar: a que foi junto volta; as outras ficam só ligadas ("LUT ausente")
  const imp = await importer.importBdspro(out, {}, '', '');
  assert.deepEqual({ linked: imp.luts.linked, restored: imp.luts.restored, linkOnly: imp.luts.linkOnly }, { linked: 3, restored: 1, linkOnly: 2 });
});

test('renomear a LUT na coleção depois de adicionar não atrapalha: ela vai pelo conteúdo, com o nome de agora', async () => {
  const pid = await projectWithLuts({ 'Antiga.cube': cube3d(2, { tint: 0.4 }) });
  fs.renameSync(path.join(srcDir, 'Antiga.cube'), path.join(srcDir, 'Nova.cube'));
  const out = outFile('renomeada');
  const res = await exporter.exportBdspro(pid, out, '');
  assert.equal(res.luts.included, 1);
  assert.equal(readProjectJson(out).luts[0].name, 'Nova');
});

test('orçamento: a LUT que não cabe vira "pacote cheio" e é contada (nunca some em silêncio); LUT grande demais idem', async () => {
  const pid = await projectWithLuts({ 'A.cube': cube3d(4, { tint: 0.1 }), 'B.cube': cube3d(4, { tint: 0.2 }), 'C.cube': cube3d(4, { tint: 0.3 }) });
  const size = fs.statSync(path.join(srcDir, 'A.cube')).size;
  const got = await srcLuts.collectForExport(pid, { maxBytes: size * 2 + 10 });
  assert.deepEqual(got.summary, { included: 2, missing: 0, skipped: 1, bytes: size * 2 });
  assert.deepEqual(got.list.map((l) => [l.name, l.included, l.reason]), [['A', true, null], ['B', true, null], ['C', false, 'pacote cheio']]);
  assert.equal(got.buffers.size, 2);
  // zero de espaço: nenhuma entra, todas contadas
  const none = await srcLuts.collectForExport(pid, { maxBytes: 0 });
  assert.equal(none.summary.skipped, 3);
  // teto por arquivo (32 MB): registrada como grande demais sem nem procurar o arquivo
  db().prepare('UPDATE project_luts SET file_bytes = ? WHERE project_id = ? AND lut_name = ?').run(40 * 1024 * 1024, pid, 'C');
  const big = await srcLuts.collectForExport(pid);
  assert.equal(big.list.find((l) => l.name === 'C').reason, 'grande demais para o pacote');
  assert.equal(await srcLuts.collectForExport(projectService.createProject({ name: 'Vazio' })), null, 'projeto sem LUTs: null');
});

test('pacote acima do limite com as LUTs: apaga a saída, refaz sem elas e avisa', async () => {
  const pid = await projectWithLuts({ 'A.cube': cube3d(2, { tint: 0.5 }) });
  const out = outFile('cheio');
  const realStat = fs.statSync;
  let faked = 0;
  fs.statSync = function patched(p, ...rest) {
    const stats = realStat.call(fs, p, ...rest);
    if (typeof p === 'string' && p === out && !faked) { faked++; return new Proxy(stats, { get: (t, k) => (k === 'size' ? 600 * 1024 * 1024 : Reflect.get(t, k)) }); }
    return stats;
  };
  let res;
  try { res = await exporter.exportBdspro(pid, out, ''); } finally { fs.statSync = realStat; }
  assert.equal(faked, 1);
  assert.deepEqual({ included: res.luts.included, skipped: res.luts.skipped }, { included: 0, skipped: 1 });
  assert.ok(res.luts.warnings.some((w) => /ficou grande demais com as LUTs/.test(w)));
  const entries = new AdmZip(out).getEntries().map((e) => e.entryName);
  assert.deepEqual(entries, ['project.json'], 'o pacote refeito não leva nenhuma LUT');
  const json = readProjectJson(out);
  assert.deepEqual([json.luts[0].included, json.luts[0].entry, json.luts[0].reason], [false, null, 'pacote cheio']);
});

test('inspecionar: usa só o que o pacote declara (não abre os arquivos de LUT) e compara os hashes com a coleção', async () => {
  const a = cube3d(2, { tint: 0.6 });
  const b = cube3d(2, { tint: 0.7 });
  const pid = await projectWithLuts({ 'A.cube': a, 'B.cube': b });
  const out = outFile('inspecionar');
  await exporter.exportBdspro(pid, out, '');
  put(dstDir, 'A.cube', a); // uma das duas já existe no destino

  const realInflate = zlib.inflateRawSync;
  let inflated = 0;
  zlib.inflateRawSync = (...args) => { inflated++; return realInflate(...args); };
  let info;
  try { info = await importer.inspectBdspro(out); } finally { zlib.inflateRawSync = realInflate; }
  assert.ok(inflated <= 1, `só o project.json é lido (leituras: ${inflated})`);
  assert.deepEqual(info.luts, { total: 2, bytes: Buffer.byteLength(a) + Buffer.byteLength(b), declaredNew: 1, declaredExisting: 1, skipped: 0 });

  // a importação, essa sim, abre os arquivos
  inflated = 0;
  zlib.inflateRawSync = (...args) => { inflated++; return realInflate(...args); };
  try { await importer.importBdspro(out, {}, '', ''); } finally { zlib.inflateRawSync = realInflate; }
  assert.ok(inflated >= 2, `a importação descompacta as LUTs (leituras: ${inflated})`);
});

test('LutManager.addBuffers: nome do pacote nunca vira caminho (".." e reservados), conteúdo repetido não duplica', async () => {
  freshCollections();
  const one = Buffer.from(cube3d(2, { tint: 0.11 }));
  const two = Buffer.from(cube3d(2, { tint: 0.12 }));
  const three = Buffer.from(cube3d(2, { tint: 0.13 }));
  const answers = await dstManager.addBuffers([
    { buffer: one, name: '../../fora' },
    { buffer: two, name: 'CON' },
    { buffer: three },
    { buffer: one, name: 'repetida' },
    { buffer: Buffer.from('lixo'), name: 'ruim' },
    { buffer: Buffer.alloc(0), name: 'vazia' }
  ]);
  assert.deepEqual(answers.map((a) => a.status), ['added', 'added', 'added', 'exists', 'failed', 'failed']);
  const files = fs.readdirSync(dstDir).filter((n) => !n.startsWith('.'));
  assert.equal(files.length, 3);
  for (const rel of answers.filter((a) => a.status === 'added').map((a) => a.relPath)) {
    assert.equal(path.basename(rel), rel, 'sempre na raiz, sem pastas');
    assert.ok(fs.existsSync(path.join(dstDir, rel)));
  }
  assert.equal(fs.existsSync(path.join(tmpRoot, 'fora.cube')), false);
  assert.equal(answers[1].relPath, '_CON.cube', 'nome reservado ganha "_" na frente (nunca é gravado como CON)');
  assert.match(answers[2].relPath, /^LUT [0-9a-f]{8}\.cube$/, 'sem nome: usa o início do conteúdo');
  // nome igual com conteúdo diferente: "(2)", nunca sobrescreve
  const again = await dstManager.addBuffers([{ buffer: Buffer.from(cube3d(2, { tint: 0.5 })), name: 'repetida' }, { buffer: Buffer.from(cube3d(2, { tint: 0.6 })), name: 'repetida' }]);
  assert.deepEqual(again.map((a) => a.relPath), ['repetida.cube', 'repetida (2).cube']);
});
