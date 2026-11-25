'use strict';

// "Usada em N projetos" (luts:usage): calculado sobre o CONJUNTO de LUTs a excluir, para o aviso antes de excluir
// uma LUT (ou várias, ou uma pasta) que está em projetos. Cópias idênticas fora do conjunto não geram aviso;
// selecionar todas as cópias (ou excluir a pasta que as contém) avisa.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-lutusage-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');
const dbm = require('../src/core/database/database');
const { runMigrations } = require('../src/core/database/migrations');
const projectService = require('../src/core/projects/ProjectService');
const LutManager = require('../src/core/luts/LutManager');
const ProjectLutService = require('../src/core/projects/ProjectLutService');
const { LutUserError } = require('../src/core/luts/lutErrors');
const { cube3d } = require('./helpers/cube-fixtures');

const lutsDir = path.join(tmpRoot, 'luts');
fs.mkdirSync(lutsDir, { recursive: true });
const manager = new LutManager(lutsDir);
const service = new ProjectLutService({ db: () => dbm.get(), lutManager: manager, projectService });

test.before(async () => { await dbm.init(path.join(tmpRoot, 'data')); runMigrations(); });
test.after(async () => {
  await manager._hashFill;
  if (manager._persistTimer) clearTimeout(manager._persistTimer);
  try { dbm.close(); } catch (_) { /* já fechado */ }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const put = (rel, content) => {
  const p = path.join(lutsDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
function reset() {
  for (const n of fs.readdirSync(lutsDir)) fs.rmSync(path.join(lutsDir, n), { recursive: true, force: true });
  manager._hashes = null;
  dbm.get().exec('DELETE FROM project_luts; DELETE FROM projects;');
}
const names = (entry) => entry.projects.map((p) => p.name);
const byRel = (list) => Object.fromEntries(list.map((e) => [e.relPath, e]));

test('nenhuma LUT em projetos: nada a avisar (e a coleção nem é lida)', async () => {
  reset();
  put('A.cube', cube3d(2));
  const original = manager.hashOfAsync;
  let reads = 0;
  manager.hashOfAsync = (...a) => { reads++; return original.apply(manager, a); };
  try {
    assert.deepEqual(await service.usage({ relPaths: ['A.cube'] }), []);
  } finally { manager.hashOfAsync = original; }
  assert.equal(reads, 0, 'sem LUT em projeto, não há por que calcular o conteúdo da coleção');
  assert.deepEqual(await service.usage({}), []);
  assert.deepEqual(await service.usage({ relPaths: [] }), []);
});

test('uma LUT em um projeto e outra em dois: devolve só as usadas, com os nomes dos projetos em ordem', async () => {
  reset();
  put('Uma.cube', cube3d(2, { tint: 0.01 }));
  put('Duas.cube', cube3d(2, { tint: 0.02 }));
  put('Nenhuma.cube', cube3d(2, { tint: 0.03 }));
  const p1 = projectService.createProject({ name: 'Zeta' });
  const p2 = projectService.createProject({ name: 'Alfa' });
  await service.add(p1, ['Uma.cube', 'Duas.cube']);
  await service.add(p2, ['Duas.cube']);

  const res = byRel(await service.usage({ relPaths: ['Uma.cube', 'Duas.cube', 'Nenhuma.cube'] }));
  assert.deepEqual(Object.keys(res).sort(), ['Duas.cube', 'Uma.cube']);
  assert.deepEqual(names(res['Uma.cube']), ['Zeta']);
  assert.deepEqual(names(res['Duas.cube']), ['Alfa', 'Zeta']);
  assert.deepEqual(res['Duas.cube'].projects.map((p) => p.id), [p2, p1]);
  assert.equal(res['Uma.cube'].remainingCopies, 0);
  assert.match(res['Uma.cube'].hash, /^[0-9a-f]{64}$/);
});

test('cópia idêntica FORA do conjunto: a LUT não fica "ausente" no projeto (remainingCopies conta a que sobra)', async () => {
  reset();
  put('Cinema/Filme.cube', cube3d(2, { tint: 0.1 }));
  put('Backup/Filme-copia.cube', cube3d(2, { tint: 0.1 })); // idêntica
  const pid = projectService.createProject({ name: 'Casamento' });
  await service.add(pid, ['Cinema/Filme.cube']);
  const res = byRel(await service.usage({ relPaths: ['Cinema/Filme.cube'] }));
  assert.equal(res['Cinema/Filme.cube'].remainingCopies, 1, 'sobra uma cópia fora do conjunto: a tela não avisa');
});

test('selecionar as DUAS cópias idênticas avisa (nada sobra fora do conjunto)', async () => {
  reset();
  put('8Bits Parcial para Completo.cube', cube3d(2, { tint: 0.2 }));
  put('SMPTEToFull8.cube', cube3d(2, { tint: 0.2 })); // mesmo conteúdo, nome diferente
  const pid = projectService.createProject({ name: 'Evento' });
  await service.add(pid, ['SMPTEToFull8.cube']);
  const res = byRel(await service.usage({ relPaths: ['8Bits Parcial para Completo.cube', 'SMPTEToFull8.cube'] }));
  assert.equal(Object.keys(res).length, 2, 'as duas cópias estão ligadas ao projeto pelo conteúdo');
  assert.equal(res['8Bits Parcial para Completo.cube'].remainingCopies, 0);
  assert.equal(res['SMPTEToFull8.cube'].remainingCopies, 0);
  assert.deepEqual(names(res['SMPTEToFull8.cube']), ['Evento']);
});

test('excluir a pasta que contém as cópias avisa; a pasta é expandida no processo principal, em qualquer nível', async () => {
  reset();
  put('Pasta/A.cube', cube3d(2, { tint: 0.3 }));
  put('Pasta/Sub/A-copia.cube', cube3d(2, { tint: 0.3 }));
  put('Pasta/Sub/Fundo/B.cube', cube3d(2, { tint: 0.4 }));
  put('Fora/C.cube', cube3d(2, { tint: 0.5 }));
  const pid = projectService.createProject({ name: 'P' });
  await service.add(pid, ['Pasta/A.cube', 'Pasta/Sub/Fundo/B.cube', 'Fora/C.cube']);

  const res = byRel(await service.usage({ folders: ['Pasta'] }));
  assert.deepEqual(Object.keys(res).sort(), ['Pasta/A.cube', 'Pasta/Sub/A-copia.cube', 'Pasta/Sub/Fundo/B.cube']);
  assert.ok(Object.values(res).every((e) => e.remainingCopies === 0), 'as cópias idênticas estão dentro da pasta: nenhuma sobra');
  assert.ok(!res['Fora/C.cube']);

  // só a subpasta: a cópia que está em "Pasta/A.cube" sobra
  const sub = byRel(await service.usage({ folders: ['Pasta/Sub'] }));
  assert.equal(sub['Pasta/Sub/A-copia.cube'].remainingCopies, 1);
  assert.equal(sub['Pasta/Sub/Fundo/B.cube'].remainingCopies, 0);

  // pasta + caminho solto juntos, sem repetir
  const mix = await service.usage({ relPaths: ['Pasta/A.cube', 'Fora/C.cube'], folders: ['Pasta'] });
  assert.equal(mix.length, 4);
});

test('o aviso não depende do nome: renomear a LUT na coleção não esconde o uso', async () => {
  reset();
  put('Antes.cube', cube3d(2, { tint: 0.6 }));
  const pid = projectService.createProject({ name: 'P' });
  await service.add(pid, ['Antes.cube']);
  fs.renameSync(path.join(lutsDir, 'Antes.cube'), path.join(lutsDir, 'Depois.cube'));
  const res = await service.usage({ relPaths: ['Depois.cube'] });
  assert.deepEqual(res.map((e) => e.relPath), ['Depois.cube']);
});

test('caminho que não existe na coleção é ignorado; pasta com texto inválido é recusada', async () => {
  reset();
  put('A.cube', cube3d(2, { tint: 0.7 }));
  const pid = projectService.createProject({ name: 'P' });
  await service.add(pid, ['A.cube']);
  assert.deepEqual(await service.usage({ relPaths: ['nao-existe.cube', '../A.cube'] }), []);
  await assert.rejects(() => service.usage({ folders: ['..'] }), LutUserError);
});
