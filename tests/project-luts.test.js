'use strict';

// LUTs de projeto (ProjectLutService): adicionar por conteúdo, limite de 100, validação, leitura única do arquivo,
// estados ok / alterada / ausente, cópias idênticas, transação já aberta, duplicar e excluir projeto, e o modelo
// completo do projeto (usado no .bdspro) que não pode mudar por causa de LUTs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-projlut-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');
const dbm = require('../src/core/database/database');
const { runMigrations } = require('../src/core/database/migrations');
const projectService = require('../src/core/projects/ProjectService');
const LutManager = require('../src/core/luts/LutManager');
const ProjectLutService = require('../src/core/projects/ProjectLutService');
const { LutUserError } = require('../src/core/luts/lutErrors');
const { sha256 } = require('../src/core/luts/lutFileOps');
const { cube3d, cube1d, badCubes } = require('./helpers/cube-fixtures');

const lutsDir = path.join(tmpRoot, 'luts');
fs.mkdirSync(lutsDir, { recursive: true });
const manager = new LutManager(lutsDir);
const service = new ProjectLutService({ db: () => dbm.get(), lutManager: manager, projectService });

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
/** Coleção vazia + um projeto novo. */
function fresh(name = `Projeto ${++seq}`) {
  for (const n of fs.readdirSync(lutsDir)) fs.rmSync(path.join(lutsDir, n), { recursive: true, force: true });
  manager._hashes = null;
  return projectService.createProject({ name });
}
const put = (rel, content = cube3d(2)) => {
  const p = path.join(lutsDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};
const rows = (pid) => dbm.get().prepare('SELECT * FROM project_luts WHERE project_id = ? ORDER BY id').all(pid);
const activity = (pid) => projectService.listActivity(pid, 50);

test('adicionar: grava hash, nome, título, tipo, tamanho e caminho; registra a atividade "lut"', async () => {
  const pid = fresh();
  const file = put('Filmes/Kodak.cube', cube3d(3, { title: 'Kodak 2383' }));
  const res = await service.add(pid, ['Filmes/Kodak.cube']);
  assert.deepEqual(res, { added: 1, already: 0, invalid: [], overLimit: 0 });
  const [row] = rows(pid);
  assert.equal(row.lut_hash, sha256(fs.readFileSync(file)));
  assert.equal(row.lut_name, 'Kodak');
  assert.equal(row.lut_title, 'Kodak 2383');
  assert.equal(row.lut_kind, '3D');
  assert.equal(row.lut_size, 3);
  assert.equal(row.file_bytes, fs.statSync(file).size);
  assert.equal(row.lut_rel_path, 'Filmes/Kodak.cube');
  const last = activity(pid)[0];
  assert.equal(last.kind, 'lut', 'o tipo "lut" é aceito (não vira "editado")');
  assert.equal(last.message, 'LUT adicionada: Kodak');
});

test('adicionar várias: a atividade resume os nomes; LUT 1D também entra', async () => {
  const pid = fresh();
  for (const n of ['A', 'B', 'C', 'D']) put(`${n}.cube`, cube3d(2, { tint: n.charCodeAt(0) / 1000 }));
  put('curva.cube', cube1d(4));
  const res = await service.add(pid, ['A.cube', 'B.cube', 'C.cube', 'D.cube', 'curva.cube']);
  assert.equal(res.added, 5);
  assert.match(activity(pid)[0].message, /^LUTs adicionadas: A, B, C e mais 2$/);
  assert.equal(rows(pid).find((r) => r.lut_name === 'curva').lut_kind, '1D');
});

test('duplicidade: a mesma LUT duas vezes, ou uma cópia idêntica com outro nome, conta como "já tem"', async () => {
  const pid = fresh();
  put('A.cube');
  put('Copia/A-copia.cube'); // mesmo conteúdo
  const first = await service.add(pid, ['A.cube']);
  assert.equal(first.added, 1);
  const again = await service.add(pid, ['A.cube', 'Copia/A-copia.cube']);
  assert.deepEqual({ added: again.added, already: again.already }, { added: 0, already: 2 });
  assert.equal(rows(pid).length, 1);
  // as duas cópias na mesma chamada: entra uma só
  const other = fresh();
  put('X.cube');
  put('Y/X2.cube');
  const both = await service.add(other, ['X.cube', 'Y/X2.cube']);
  assert.deepEqual({ added: both.added, already: both.already }, { added: 1, already: 1 });
});

test('limite de 100 LUTs: conta as que o projeto já tem mais as novas e avisa o excedente', async () => {
  const pid = fresh();
  const names = [];
  for (let i = 0; i < 105; i++) { const n = `L${String(i).padStart(3, '0')}.cube`; put(n, cube3d(2, { tint: i / 1000 })); names.push(n); }
  const first = await service.add(pid, names.slice(0, 98));
  assert.equal(first.added, 98);
  const second = await service.add(pid, names.slice(98, 103));
  assert.deepEqual({ added: second.added, overLimit: second.overLimit }, { added: 2, overLimit: 3 });
  assert.equal(rows(pid).length, ProjectLutService.MAX_PROJECT_LUTS);
  // com o projeto cheio, só o que já existe é "já tem"; o resto é excedente
  const third = await service.add(pid, [names[0], names[103], names[104]]);
  assert.deepEqual({ added: third.added, already: third.already, overLimit: third.overLimit }, { added: 0, already: 1, overLimit: 2 });
  // e tudo de uma vez num projeto vazio
  const empty = fresh();
  for (let i = 0; i < 101; i++) put(`M${i}.cube`, cube3d(2, { tint: i / 1000 }));
  const all = await service.add(empty, Array.from({ length: 101 }, (_, i) => `M${i}.cube`));
  assert.deepEqual({ added: all.added, overLimit: all.overLimit }, { added: 100, overLimit: 1 });
});

test('mais caminhos do que uma chamada lê: o excedente é contado, nunca ignorado em silêncio', async () => {
  const pid = fresh();
  put('A.cube');
  const many = ['A.cube', ...Array.from({ length: ProjectLutService.MAX_ADD_ITEMS + 9 }, (_, i) => `nao-existe-${i}.cube`)];
  const res = await service.add(pid, many);
  assert.equal(res.added, 1);
  assert.equal(res.overLimit, 10, 'os 10 além do teto de leitura (510 pedidos, 500 lidos)');
  assert.equal(res.invalid.length, ProjectLutService.MAX_ADD_ITEMS - 1, 'os lidos e inexistentes voltam como inválidos');
});

test('LUT inválida é recusada com o motivo; caminho fora da coleção também', async () => {
  const pid = fresh();
  put('boa.cube');
  for (const bad of badCubes().slice(0, 4)) put(`ruim/${bad.name}.cube`, bad.content);
  put('1d3d.cube', badCubes().find((b) => b.code === 'MIXED').content);
  fs.writeFileSync(path.join(tmpRoot, 'fora.cube'), cube3d(2));
  const res = await service.add(pid, ['boa.cube', 'ruim/virgula-decimal.cube', '1d3d.cube', '../fora.cube', 'a/../../fora.cube', 'C:\\Windows\\x.cube', 'nao-existe.cube']);
  assert.equal(res.added, 1);
  assert.equal(res.invalid.length, 6);
  assert.match(res.invalid.find((i) => i.name === 'virgula-decimal.cube').reason, /valor inválido/);
  assert.match(res.invalid.find((i) => i.name === '1d3d.cube').reason, /1D e 3D no mesmo arquivo/);
  assert.match(res.invalid.find((i) => i.name === 'nao-existe.cube').reason, /não foi encontrada/);
  for (const name of ['fora.cube', 'x.cube']) assert.match(res.invalid.find((i) => i.name === name).reason, /não está na pasta de LUTs/);
  assert.equal(rows(pid).length, 1, 'nada fora da coleção entrou');
});

test('junção (atalho de pasta) para fora da coleção: as LUTs de dentro dela são recusadas, por caminho e por pasta', async (t) => {
  const pid = fresh();
  const outside = path.join(tmpRoot, 'fora-da-colecao');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'Secreta.cube'), cube3d(2, { tint: 0.77 }));
  const link = path.join(lutsDir, 'Atalho');
  try { fs.symlinkSync(outside, link, 'junction'); } catch (err) { t.skip(`não foi possível criar a junção (${err.code})`); return; }
  try {
    const res = await service.add(pid, ['Atalho/Secreta.cube']);
    assert.equal(res.added, 0);
    assert.match(res.invalid[0].reason, /não está na pasta de LUTs/);
    await assert.rejects(() => service.add(pid, [], { folders: ['Atalho'] }), (err) => err instanceof LutUserError && /não está na pasta de LUTs/.test(err.message), 'a pasta-atalho é recusada');
    assert.equal(rows(pid).length, 0);
  } finally {
    try { fs.rmdirSync(link); } catch (_) { /* a limpeza geral remove */ }
  }
});

test('pasta que se chama "x.cube" e arquivo gigante não entram (sem ler o gigante)', async () => {
  const pid = fresh();
  fs.mkdirSync(path.join(lutsDir, 'pasta.cube'));
  const big = path.join(lutsDir, 'gigante.cube');
  fs.closeSync(fs.openSync(big, 'w'));
  fs.truncateSync(big, 65 * 1024 * 1024); // arquivo esparso acima do limite
  const res = await service.add(pid, ['pasta.cube', 'gigante.cube']);
  assert.equal(res.added, 0);
  assert.equal(res.invalid.length, 2);
  assert.match(res.invalid.find((i) => i.name === 'gigante.cube').reason, /grande demais/);
});

test('o conteúdo gravado é o do buffer lido e validado: arquivo trocado depois da leitura não muda o vínculo', async () => {
  const pid = fresh();
  const target = put('A.cube', cube3d(2, { tint: 0.01 }));
  const original = fs.readFileSync(target);
  const realRead = fs.promises.readFile;
  const reads = [];
  fs.promises.readFile = async (...args) => {
    const data = await realRead.apply(fs.promises, args);
    if (String(args[0]) === target) { reads.push(args[0]); fs.writeFileSync(target, cube3d(2, { tint: 0.5 })); } // troca logo depois da leitura
    return data;
  };
  try {
    const res = await service.add(pid, ['A.cube']);
    assert.equal(res.added, 1);
  } finally { fs.promises.readFile = realRead; }
  assert.equal(reads.length, 1, 'o arquivo é lido uma única vez');
  assert.equal(rows(pid)[0].lut_hash, sha256(original), 'vale o conteúdo que foi validado, não o que está no disco agora');
  // e a lista agora reconhece que o arquivo do disco é outro
  const [item] = await service.list(pid);
  assert.equal(item.status, 'changed');
});

test('list: ok, renomear mantém ok, mover mantém ok, conteúdo mudado vira "changed" e apagado vira "missing"', async () => {
  const pid = fresh();
  put('Pasta/Filme.cube', cube3d(2, { tint: 0.01 }));
  put('Outro.cube', cube3d(2, { tint: 0.02 }));
  put('Sumira.cube', cube3d(2, { tint: 0.03 }));
  await service.add(pid, ['Pasta/Filme.cube', 'Outro.cube', 'Sumira.cube']);

  let list = await service.list(pid);
  assert.deepEqual(list.map((l) => [l.name, l.status]), [['Filme', 'ok'], ['Outro', 'ok'], ['Sumira', 'ok']]);
  assert.equal(list[0].path, path.join(lutsDir, 'Pasta', 'Filme.cube'));
  assert.equal(list[0].relPath, 'Pasta/Filme.cube');
  assert.equal(list[0].kind, '3D');

  // renomear e mover na coleção: a ligação é pelo conteúdo
  fs.renameSync(path.join(lutsDir, 'Pasta', 'Filme.cube'), path.join(lutsDir, 'Pasta', 'Filme novo.cube'));
  fs.mkdirSync(path.join(lutsDir, 'Mudou'));
  fs.renameSync(path.join(lutsDir, 'Outro.cube'), path.join(lutsDir, 'Mudou', 'Outro.cube'));
  list = await service.list(pid);
  assert.deepEqual(list.map((l) => [l.name, l.status]), [['Filme novo', 'ok'], ['Outro', 'ok'], ['Sumira', 'ok']]);
  assert.equal(list[1].relPath, 'Mudou/Outro.cube');

  // conteúdo alterado no mesmo caminho de quando foi adicionada
  fs.writeFileSync(path.join(lutsDir, 'Sumira.cube'), cube3d(2, { tint: 0.9 }));
  list = await service.list(pid);
  assert.equal(list.find((l) => l.name === 'Sumira').status, 'changed');
  assert.ok(list.find((l) => l.name === 'Sumira').path, 'o arquivo alterado ainda pode ser mostrado na pasta');

  // apagado
  fs.rmSync(path.join(lutsDir, 'Sumira.cube'));
  list = await service.list(pid);
  const gone = list.find((l) => l.status === 'missing');
  assert.equal(gone.name, 'Sumira', 'ausente mostra o nome de quando foi adicionada');
  assert.equal(gone.path, null);
  assert.equal(gone.relPath, null);
});

test('list: cópias idênticas — vale a do caminho de origem; sem ela, a primeira por nome; sem nenhuma, ausente', async () => {
  const pid = fresh();
  put('B/Igual.cube');
  put('A/Igual.cube');
  await service.add(pid, ['B/Igual.cube']);
  assert.equal((await service.list(pid))[0].relPath, 'B/Igual.cube', 'a dica do caminho de origem vence');
  fs.rmSync(path.join(lutsDir, 'B', 'Igual.cube'));
  assert.equal((await service.list(pid))[0].relPath, 'A/Igual.cube');
  assert.equal((await service.list(pid))[0].status, 'ok');
  fs.rmSync(path.join(lutsDir, 'A', 'Igual.cube'));
  assert.equal((await service.list(pid))[0].status, 'missing');
});

test('list: projeto sem LUTs e coleção inexistente não quebram', async () => {
  const pid = fresh();
  assert.deepEqual(await service.list(pid), []);
  put('A.cube');
  await service.add(pid, ['A.cube']);
  fs.rmSync(lutsDir, { recursive: true, force: true });
  const list = await service.list(pid);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'missing');
  fs.mkdirSync(lutsDir, { recursive: true });
});

test('adicionar dentro de uma transação já aberta não tenta abrir outra e acompanha o desfecho dela', async () => {
  const db = dbm.get();
  const pid = fresh();
  put('A.cube');
  put('B.cube', cube3d(2, { tint: 0.2 }));
  db.exec('BEGIN TRANSACTION');
  const res = await service.add(pid, ['A.cube']); // se tentasse BEGIN de novo, o SQLite recusaria
  assert.equal(res.added, 1);
  db.exec('ROLLBACK');
  assert.equal(rows(pid).length, 0, 'a transação externa desfeita leva a LUT junto');

  db.exec('BEGIN TRANSACTION');
  await service.add(pid, ['B.cube']);
  db.exec('COMMIT');
  assert.equal(rows(pid).length, 1);
  // fora de qualquer transação também funciona e fica gravada
  assert.equal((await service.add(pid, ['A.cube'])).added, 1);
  assert.equal(rows(pid).length, 2);
});

test('remover: tira só a ligação (a LUT da coleção fica), registra e devolve false se não havia', async () => {
  const pid = fresh();
  const file = put('A.cube');
  await service.add(pid, ['A.cube']);
  const hash = rows(pid)[0].lut_hash;
  assert.equal(service.remove(pid, hash), true);
  assert.equal(rows(pid).length, 0);
  assert.ok(fs.existsSync(file), 'a LUT da coleção não é tocada');
  assert.equal(activity(pid)[0].message, 'LUT removida: A');
  assert.equal(service.remove(pid, hash), false);
  assert.throws(() => service.remove(pid, 'nao-e-hash'), LutUserError);
  assert.throws(() => service.remove(pid, '../x'), /inválida/);
});

test('resolvePath: arquivo da LUT para mostrar na pasta; ausente e fora do projeto dão mensagem amigável', async () => {
  const pid = fresh();
  const file = put('Pasta/A.cube');
  await service.add(pid, ['Pasta/A.cube']);
  const hash = rows(pid)[0].lut_hash;
  assert.equal(await service.resolvePath(pid, hash), path.resolve(file));
  await assert.rejects(() => service.resolvePath(pid, 'f'.repeat(64)), /não está neste projeto/);
  fs.rmSync(file);
  await assert.rejects(() => service.resolvePath(pid, hash), /não está mais na coleção/);
});

test('adicionar por pasta: as LUTs de todos os níveis entram; pasta inválida é recusada', async () => {
  const pid = fresh();
  put('Cinema/A.cube', cube3d(2, { tint: 0.01 }));
  put('Cinema/Sub/B.cube', cube3d(2, { tint: 0.02 }));
  put('Cinema/Sub/Fundo/C.cube', cube3d(2, { tint: 0.03 }));
  put('Fora/D.cube', cube3d(2, { tint: 0.04 }));
  const res = await service.add(pid, [], { folders: ['Cinema'] });
  assert.equal(res.added, 3);
  assert.deepEqual(rows(pid).map((r) => r.lut_name).sort(), ['A', 'B', 'C']);
  await assert.rejects(() => service.add(pid, [], { folders: ['..'] }), LutUserError);
  await assert.rejects(() => service.add(pid, [], { folders: ['a\\b'] }), LutUserError);
});

test('projeto inexistente: mensagem amigável, nada gravado', async () => {
  fresh();
  put('A.cube');
  await assert.rejects(() => service.add(999999, ['A.cube']), /Este projeto não existe mais\./);
});

test('duplicar o projeto copia as LUTs; excluir o projeto leva as LUTs junto', async () => {
  const pid = fresh();
  put('A.cube');
  put('B.cube', cube3d(2, { tint: 0.2 }));
  await service.add(pid, ['A.cube', 'B.cube']);
  const copyId = projectService.duplicateProject(pid);
  assert.deepEqual(rows(copyId).map((r) => [r.lut_hash, r.lut_name, r.lut_rel_path]), rows(pid).map((r) => [r.lut_hash, r.lut_name, r.lut_rel_path]));
  assert.equal((await service.list(copyId)).length, 2);
  // a cópia é independente
  service.remove(copyId, rows(copyId)[0].lut_hash);
  assert.equal(rows(pid).length, 2);
  assert.ok(projectService.deleteProject(pid));
  assert.equal(rows(pid).length, 0, 'cascata');
  assert.equal(rows(copyId).length, 1);
});

test('projeto antigo, sem LUTs: duplicar, resumo e modelo completo seguem normais', async () => {
  const pid = fresh();
  const copyId = projectService.duplicateProject(pid);
  assert.equal(rows(copyId).length, 0);
  assert.equal(projectService.getProjectSummary(pid).luts, 0);
});

test('o resumo do projeto traz a contagem de LUTs', async () => {
  const pid = fresh();
  put('A.cube');
  await service.add(pid, ['A.cube']);
  assert.equal(projectService.getProjectSummary(pid).luts, 1);
});

test('o modelo completo do projeto (base do .bdspro) é idêntico com ou sem LUTs: nada vaza para o pacote', async () => {
  const pid = fresh();
  const before = projectService.getProjectFullModel(pid);
  put('A.cube');
  await service.add(pid, ['A.cube']);
  const after = projectService.getProjectFullModel(pid);
  // a única diferença é a linha de atividade "LUT adicionada: A" (o registro de atividade já ia no pacote)
  assert.deepEqual(after.activity.map((a) => a.kind), ['lut', 'criado']);
  // (a data da última atividade acompanha o relógio: também fica de fora da comparação)
  const plain = (model) => ({ ...model, activity: null, metadata: { ...model.metadata, last_activity_at: null } });
  assert.deepEqual(plain(after), plain(before), 'o restante do modelo é idêntico');
  const text = JSON.stringify(after);
  assert.doesNotMatch(text, /lut_rel_path|lut_hash|project_luts|"luts"/, 'nenhum dado da ligação vaza para o modelo');
  assert.equal(after.version, '1.1.0');
});
