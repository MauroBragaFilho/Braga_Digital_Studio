'use strict';

// Canais das LUTs de projeto (src/ipc/projectLutHandlers.js) registrados de verdade pelo channelRegistry, com o módulo
// "electron" simulado: esquema dos argumentos, mensagens em português (nunca o texto cru de uma exceção) e "Mostrar na pasta".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

const registered = new Map();
const shellCalls = { reveal: [] };
const electron = {
  ipcMain: { handle: (channel, fn) => registered.set(channel, fn) },
  shell: { showItemInFolder: (p) => { shellCalls.reveal.push(p); } }
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : originalLoad.call(this, request, ...rest); };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-projlut-ipc-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');
const { APP_PAGE, CHANNELS } = require('../src/ipc/channelRegistry');
const dbm = require('../src/core/database/database');
const { runMigrations } = require('../src/core/database/migrations');
const projectService = require('../src/core/projects/ProjectService');
const LutManager = require('../src/core/luts/LutManager');
const ProjectLutService = require('../src/core/projects/ProjectLutService');
const registerProjectLutHandlers = require('../src/ipc/projectLutHandlers');
const { cube3d } = require('./helpers/cube-fixtures');

const lutsDir = path.join(tmpRoot, 'luts');
fs.mkdirSync(lutsDir, { recursive: true });
const manager = new LutManager(lutsDir);
const service = new ProjectLutService({ db: () => dbm.get(), lutManager: manager, projectService });

test.before(async () => {
  await dbm.init(path.join(tmpRoot, 'data'));
  runMigrations();
  registerProjectLutHandlers(service);
});
test.after(async () => {
  await manager._hashFill;
  if (manager._persistTimer) clearTimeout(manager._persistTimer);
  Module._load = originalLoad;
  try { dbm.close(); } catch (_) { /* já fechado */ }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const appUrl = pathToFileURL(APP_PAGE).href;
const event = { senderFrame: { parent: null, url: appUrl }, sender: { getType: () => 'window', getURL: () => appUrl } };
const call = (channel, ...args) => registered.get(channel)(event, ...args);
const put = (rel, content = cube3d(2)) => {
  const p = path.join(lutsDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

test('todos os canais do domínio projectLuts têm handler (e só eles, fora os do domínio luts)', () => {
  const wanted = Object.keys(CHANNELS).filter((c) => CHANNELS[c].domain === 'projectLuts').sort();
  assert.deepEqual(wanted, ['luts:usage', 'projects:addLuts', 'projects:listLuts', 'projects:removeLut', 'projects:revealLut']);
  assert.deepEqual([...registered.keys()].sort(), wanted);
});

test('adicionar, listar, mostrar na pasta e remover, de ponta a ponta pelos canais', async () => {
  const pid = projectService.createProject({ name: 'Casamento' });
  const file = put('Filmes/Kodak.cube', cube3d(3, { tint: 0.1 }));
  put('B.cube', cube3d(2, { tint: 0.2 }));

  const res = await call('projects:addLuts', pid, ['Filmes/Kodak.cube', 'B.cube', 'ruim.cube']);
  assert.equal(res.added, 2);
  assert.equal(res.invalid.length, 1);
  assert.match(res.invalid[0].reason, /não foi encontrada/);

  const list = await call('projects:listLuts', pid);
  assert.deepEqual(list.map((l) => [l.name, l.status]), [['Kodak', 'ok'], ['B', 'ok']]);
  assert.equal(list[0].path, path.resolve(file));

  assert.equal(await call('projects:revealLut', pid, list[0].hash), true);
  assert.deepEqual(shellCalls.reveal, [path.resolve(file)]);

  assert.deepEqual(await call('luts:usage', ['Filmes/Kodak.cube']).then((r) => r.map((e) => e.projects.map((p) => p.name))), [['Casamento']]);
  assert.deepEqual(await call('luts:usage', undefined, ['Filmes']).then((r) => r.map((e) => e.relPath)), ['Filmes/Kodak.cube']);

  assert.equal(await call('projects:removeLut', pid, list[0].hash), true);
  assert.equal((await call('projects:listLuts', pid)).length, 1);
  assert.equal(await call('projects:removeLut', pid, list[0].hash), false);
});

test('esquema: hash que não é de 64 caracteres, caminhos demais, argumento extra e id inválido são recusados', async () => {
  const pid = projectService.createProject({ name: 'P' });
  await assert.rejects(() => call('projects:removeLut', pid, 'abc'), /LUT inválido/);
  await assert.rejects(() => call('projects:revealLut', pid, '../../x'), /LUT inválido/);
  await assert.rejects(() => call('projects:removeLut', pid, 'A'.repeat(64)), /LUT inválido/, 'só minúsculas');
  await assert.rejects(() => call('projects:addLuts', pid, Array.from({ length: 501 }, (_, i) => `${i}.cube`)), /máximo de 500/);
  await assert.rejects(() => call('projects:addLuts', 'abc', []), /inteiro positivo/);
  await assert.rejects(() => call('projects:addLuts', pid, 'A.cube'), /lista/);
  await assert.rejects(() => call('projects:listLuts', pid, 'extra'), /demais/);
  await assert.rejects(() => call('luts:usage', Array.from({ length: 5001 }, (_, i) => `${i}.cube`)), /máximo de 5000/);
  await assert.rejects(() => call('luts:usage', [], Array.from({ length: 51 }, () => 'A')), /máximo de 50/);
});

test('falhas voltam em português, sem o texto cru da exceção', async () => {
  const pid = projectService.createProject({ name: 'P' });
  await assert.rejects(() => call('projects:addLuts', 999999, ['A.cube']), /Este projeto não existe mais\./);
  await assert.rejects(() => call('projects:addLuts', pid, [], ['..']), /não está na pasta de LUTs|não existe/);
  await assert.rejects(() => call('projects:revealLut', pid, 'e'.repeat(64)), /não está neste projeto/);
  put('Some.cube', cube3d(2, { tint: 0.9 }));
  await call('projects:addLuts', pid, ['Some.cube']);
  const [only] = await call('projects:listLuts', pid);
  fs.rmSync(path.join(lutsDir, 'Some.cube'));
  await assert.rejects(() => call('projects:revealLut', pid, only.hash), /não está mais na coleção/);
  // erro inesperado do banco vira mensagem genérica
  const real = service.list;
  service.list = async () => { throw new Error('SQLITE_BUSY: detalhe interno'); };
  try {
    await assert.rejects(() => call('projects:listLuts', pid), (err) => /Não foi possível ler as LUTs do projeto\./.test(err.message) && !/SQLITE/.test(err.message));
  } finally { service.list = real; }
});
