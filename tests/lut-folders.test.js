'use strict';

// Coleção com subpastas (LutManager): lista recursiva, caminhos relativos, renomear e excluir pasta em qualquer nível,
// trava única de escrita e criação segura de subpastas.

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LutManager = require('../src/core/luts/LutManager');
const logger = require('../src/services/logService');
const { cube3d } = require('./helpers/cube-fixtures');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-lut-fld-'));
  const lutsDir = path.join(root, 'luts');
  fs.mkdirSync(lutsDir);
  const mgr = new LutManager(lutsDir);
  t.after(async () => {
    await mgr._hashFill;
    if (mgr._persistTimer) clearTimeout(mgr._persistTimer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const put = (rel, content = cube3d(2)) => {
    const p = path.join(lutsDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  return { root, lutsDir, mgr, put };
}
const rels = (mgr) => mgr.list().map((l) => l.relPath).sort();
/** Lixeira simulada: apaga o arquivo e registra o que foi pedido. */
function fakeTrash() {
  const calls = [];
  const fn = async (p) => { calls.push(p); fs.rmSync(p, { recursive: true, force: true }); };
  fn.calls = calls;
  return fn;
}

// ─── Lista recursiva ─────────────────────────────────────────────────────────────────────────────

test('listar: inclui as subpastas (até 3 níveis), com relPath, folder e depth; o que é mais fundo vira aviso', (t) => {
  const { mgr, lutsDir, put } = setup(t);
  put('raiz.cube');
  put('A/um.cube', cube3d(2, { tint: 0.1 }));
  put('A/B/dois.cube', cube3d(2, { tint: 0.2 }));
  put('A/B/C/tres.cube', cube3d(2, { tint: 0.3 }));
  put('A/B/C/D/quatro.cube', cube3d(2, { tint: 0.4 }));
  put('A/film.3dl', 'x');
  const { items, problems } = mgr.listDetailed();
  assert.deepEqual(items.map((i) => i.relPath).sort(), ['A/B/C/tres.cube', 'A/B/dois.cube', 'A/um.cube', 'raiz.cube']);
  const tres = items.find((i) => i.name === 'tres.cube');
  assert.deepEqual({ folder: tres.folder, depth: tres.depth, path: tres.path }, { folder: 'A/B/C', depth: 3, path: path.join(lutsDir, 'A', 'B', 'C', 'tres.cube') });
  assert.deepEqual(items.find((i) => i.name === 'raiz.cube').folder, '');
  assert.deepEqual(problems.map((p) => p.name), ['A/B/C/D']);
  assert.match(problems[0].reason, /Pasta funda demais.*não são listadas nem sincronizadas/);
});

test('listar: atalho/junção para pasta não é seguido e vira aviso; a coleção que é um atalho continua lista', (t) => {
  const { mgr, lutsDir, root, put } = setup(t);
  const outside = path.join(root, 'fora');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'segredo.cube'), cube3d(2));
  put('real.cube');
  try { fs.symlinkSync(outside, path.join(lutsDir, 'atalho'), 'junction'); } catch (err) { t.skip('o sistema não permite criar links aqui'); return; }
  const { items, problems } = mgr.listDetailed();
  assert.deepEqual(items.map((i) => i.relPath), ['real.cube']);
  assert.deepEqual(problems.map((p) => p.name), ['atalho']);
  assert.match(problems[0].reason, /Atalho \(link\) para uma pasta/);
});

test('listar: o hash em cache acompanha o caminho relativo (também em subpastas)', async (t) => {
  const { mgr, put } = setup(t);
  put('A/B/x.cube');
  assert.equal(mgr.list()[0].hash, null);
  await mgr._hashFill;
  const [lut] = mgr.list();
  assert.match(lut.hash, /^[0-9a-f]{64}$/);
  assert.equal(lut.id, lut.hash.slice(0, 16));
});

// ─── Caminhos relativos e segurança ──────────────────────────────────────────────────────────────

test('resolveRel: aceita caminho relativo válido e recusa "..", ".", vazio, barra invertida, ":" e nomes reservados', (t) => {
  const { mgr, lutsDir } = setup(t);
  assert.equal(mgr.resolveRel('A/B'), path.join(lutsDir, 'A', 'B'));
  assert.equal(mgr.resolveRel('Look (2)'), path.join(lutsDir, 'Look (2)'));
  for (const bad of ['', '..', '.', 'A/..', '../fora', 'A//B', '/A', 'A/', 'A\\B', 'C:', 'C:/x', 'CON', 'A/nul', 'x.', 'A/ B', '.oculta', 'a/b/c/d/e', 'a\u0000b']) {
    assert.throws(() => mgr.resolveRel(bad), (err) => err.code === 'LUT_USER', `deveria recusar ${JSON.stringify(bad)}`);
  }
  assert.throws(() => mgr.resolveRel(undefined), /não existe mais/);
  assert.throws(() => mgr.resolveRel('x'.repeat(2000)), /não existe mais/);
});

test('assertFolderInside: só pasta comum que existe dentro da coleção (nunca a raiz, arquivo, atalho ou junção)', (t) => {
  const { mgr, lutsDir, root, put } = setup(t);
  put('A/B/x.cube');
  put('arquivo.cube');
  assert.equal(mgr.assertFolderInside('A/B'), path.join(lutsDir, 'A', 'B'));
  if (process.platform === 'win32' || process.platform === 'darwin') {
    // sistemas de arquivos que não diferenciam maiúsculas (padrão do Windows e do macOS) acham "A/B" por "a/b"
    assert.equal(mgr.assertFolderInside('a/b'), path.join(lutsDir, 'a', 'b'));
  } else {
    assert.throws(() => mgr.assertFolderInside('a/b'), /não existe mais/, 'no Linux "a/b" é outra pasta e não existe');
  }
  assert.throws(() => mgr.assertFolderInside('nao-existe'), /não existe mais/);
  assert.throws(() => mgr.assertFolderInside('arquivo.cube'), /não está na pasta de LUTs/);
  assert.throws(() => mgr.assertFolderInside(''), (err) => err.code === 'LUT_USER');
  const outside = path.join(root, 'fora');
  fs.mkdirSync(path.join(outside, 'S'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(lutsDir, 'juncao'), 'junction');
    fs.symlinkSync(lutsDir, path.join(lutsDir, 'A', 'volta'), 'junction');
  } catch (err) { return; }
  assert.throws(() => mgr.assertFolderInside('juncao'), /não está na pasta de LUTs/);
  assert.throws(() => mgr.assertFolderInside('juncao/S'), /não está na pasta de LUTs/);
  assert.throws(() => mgr.assertFolderInside('A/volta'), /não está na pasta de LUTs/, 'junção que volta para a raiz');
});

test('ensureFolders: cria a cadeia dentro da coleção e conta o que criou; recusa atalho, arquivo no lugar de pasta e nome inválido', (t) => {
  const { mgr, lutsDir, root, put } = setup(t);
  assert.deepEqual(mgr.ensureFolders(['A', 'B']), { dir: path.join(lutsDir, 'A', 'B'), created: 2 });
  assert.deepEqual(mgr.ensureFolders(['A', 'B', 'C']), { dir: path.join(lutsDir, 'A', 'B', 'C'), created: 1 });
  assert.deepEqual(mgr.ensureFolders([]), { dir: lutsDir, created: 0 });
  put('arquivo');
  assert.throws(() => mgr.ensureFolders(['arquivo']), /não é uma pasta comum/);
  for (const bad of ['..', 'a/b', 'CON', 'a:b']) assert.throws(() => mgr.ensureFolders([bad]), /inválido/, bad);
  const outside = path.join(root, 'fora');
  fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, path.join(lutsDir, 'juncao'), 'junction'); } catch (err) { return; }
  assert.throws(() => mgr.ensureFolders(['juncao', 'X']), /não é uma pasta comum|não está na pasta de LUTs/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nada foi criado fora da coleção');
});

test('rename e delete de LUT funcionam em qualquer nível', async (t) => {
  const { mgr, lutsDir, put } = setup(t);
  const deep = put('A/B/C/x.cube');
  assert.equal(mgr.rename(deep, 'Novo'), true);
  assert.ok(fs.existsSync(path.join(lutsDir, 'A', 'B', 'C', 'Novo.cube')));
  const trash = fakeTrash();
  assert.equal(await mgr.delete(path.join(lutsDir, 'A', 'B', 'C', 'Novo.cube'), trash), true);
  assert.deepEqual(trash.calls, [path.join(lutsDir, 'A', 'B', 'C', 'Novo.cube')]);
});

// ─── Trava única ─────────────────────────────────────────────────────────────────────────────────

test('withLock: quem chega com a trava ocupada recebe "Há outra operação em andamento."; com wait espera a vez, em ordem', async (t) => {
  const { mgr } = setup(t);
  const order = [];
  let release;
  const first = mgr.withLock(() => new Promise((resolve) => { release = resolve; order.push('primeira começou'); }));
  await assert.rejects(() => mgr.withLock(async () => order.push('nunca')), (err) => err.message === 'Há outra operação em andamento.' && err.code === 'LUT_USER');
  const waiting = mgr.withLock(async () => { order.push('segunda'); return 2; }, { wait: true });
  const waiting2 = mgr.withLock(async () => { order.push('terceira'); return 3; }, { wait: true });
  release('ok');
  assert.equal(await first, 'ok');
  assert.equal(await waiting, 2);
  assert.equal(await waiting2, 3);
  assert.deepEqual(order, ['primeira começou', 'segunda', 'terceira']);
  // a trava é liberada mesmo quando a operação falha
  await assert.rejects(() => mgr.withLock(async () => { throw new Error('falhou'); }), /falhou/);
  assert.equal(await mgr.withLock(async () => 'livre'), 'livre');
});

// ─── Renomear pasta ──────────────────────────────────────────────────────────────────────────────

test('renameFolder: renomeia em qualquer nível, move tudo que está dentro e mantém o hash já calculado', async (t) => {
  const { mgr, lutsDir, put } = setup(t);
  put('Looks/Rush/a.cube', cube3d(2, { tint: 0.1 }));
  put('Looks/Rush/Sub/b.cube', cube3d(2, { tint: 0.2 }));
  put('Looks/Rush/notas.txt', 'minhas notas');
  put('Looks/outra.cube', cube3d(2, { tint: 0.3 }));
  mgr.list();
  await mgr._hashFill;
  const before = Object.fromEntries(mgr.list().map((l) => [l.name, l.hash]));
  assert.equal(await mgr.renameFolder('Looks/Rush', 'Sprint'), true);
  assert.deepEqual(rels(mgr), ['Looks/Sprint/Sub/b.cube', 'Looks/Sprint/a.cube', 'Looks/outra.cube']);
  assert.ok(fs.existsSync(path.join(lutsDir, 'Looks', 'Sprint', 'notas.txt')), 'os outros arquivos vão junto');
  assert.ok(!fs.existsSync(path.join(lutsDir, 'Looks', 'Rush')));
  const after = Object.fromEntries(mgr.list().map((l) => [l.name, l.hash]));
  assert.deepEqual(after, before, 'o hash acompanha os arquivos (sem reler)');
  assert.equal(await mgr.renameFolder('Looks', 'Filtros'), true, 'também uma pasta que tem subpastas');
  assert.deepEqual(rels(mgr), ['Filtros/Sprint/Sub/b.cube', 'Filtros/Sprint/a.cube', 'Filtros/outra.cube']);
});

test('renameFolder: recusa, com o motivo, nome inválido ou reservado, nome já usado, pasta que sumiu e arquivo no lugar', async (t) => {
  const { mgr, put } = setup(t);
  put('A/x.cube', cube3d(2, { tint: 0.1 }));
  put('B/y.cube', cube3d(2, { tint: 0.2 }));
  put('arquivo.txt', 'x');
  const expectRejects = (relPath, name, pattern) => assert.rejects(() => mgr.renameFolder(relPath, name), pattern, `${relPath} -> ${name}`);
  await expectRejects('A', '', /Informe um nome/);
  await expectRejects('A', 'a/b', /caracteres/);
  await expectRejects('A', '..', /ponto/);
  await expectRejects('A', 'CON', /reservado pelo Windows/);
  await expectRejects('A', ' x', /espaço/);
  await expectRejects('A', 'z'.repeat(101), /longo demais/);
  await expectRejects('A', 'B', /Já existe/);
  await expectRejects('A', 'arquivo.txt', /Já existe/);
  await expectRejects('Sumiu', 'Novo', /não existe mais/);
  await expectRejects('arquivo.txt', 'Novo', /não está na pasta de LUTs/);
  await expectRejects('..', 'Novo', /não está na pasta de LUTs/);
  assert.deepEqual(rels(mgr), ['A/x.cube', 'B/y.cube'], 'nada mudou');
  assert.equal(await mgr.renameFolder('A', 'A'), true, 'mesmo nome: nada a fazer');
});

test('renameFolder: só trocar a caixa das letras funciona (por um nome temporário) e não deixa resto', async (t) => {
  const { mgr, lutsDir, put } = setup(t);
  put('Ignition/a.cube');
  assert.equal(await mgr.renameFolder('Ignition', 'ignition'), true);
  assert.deepEqual(fs.readdirSync(lutsDir), ['ignition']);
  assert.deepEqual(rels(mgr), ['ignition/a.cube']);
});

test('renameFolder: o novo nome que estouraria o caminho de algum arquivo é recusado e nada é renomeado', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-lut-fld-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lutsDir = path.join(root, 'L'.repeat(Math.max(1, 100 - root.length))); // pasta de LUTs comprida: o limite do Windows chega antes do de 100 letras
  fs.mkdirSync(path.join(lutsDir, 'Curta'), { recursive: true });
  const file = path.join(lutsDir, 'Curta', `${'n'.repeat(60)}.cube`);
  fs.writeFileSync(file, cube3d(2));
  const mgr = new LutManager(lutsDir);
  const room = 259 - lutsDir.length - 1 - 24 - (1 + 65); // letras que ainda cabem no nome da pasta
  assert.ok(room > 5 && room < 100, `room=${room}`);
  await assert.rejects(() => mgr.renameFolder('Curta', 'p'.repeat(room + 1)), /deixaria o caminho de 1 arquivo longo demais/);
  assert.deepEqual(rels(mgr), [`Curta/${'n'.repeat(60)}.cube`]);
  assert.equal(await mgr.renameFolder('Curta', 'p'.repeat(room)), true, 'no limite ainda cabe');
  await mgr._hashFill;
  if (mgr._persistTimer) clearTimeout(mgr._persistTimer);
});

test('renameFolder: recusa atalho/junção e não toca no que está fora da coleção', async (t) => {
  const { mgr, lutsDir, root, put } = setup(t);
  const outside = path.join(root, 'fora');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'x.cube'), cube3d(2));
  put('real/a.cube');
  try { fs.symlinkSync(outside, path.join(lutsDir, 'juncao'), 'junction'); } catch (err) { t.skip('o sistema não permite criar links aqui'); return; }
  await assert.rejects(() => mgr.renameFolder('juncao', 'Novo'), /não está na pasta de LUTs/);
  assert.ok(fs.existsSync(path.join(outside, 'x.cube')));
  assert.ok(fs.existsSync(path.join(lutsDir, 'juncao')));
});

test('renameFolder: falha do sistema (pasta em uso) vira mensagem amigável e nada muda; a trava é liberada', async (t) => {
  const { mgr, put } = setup(t);
  put('A/x.cube');
  const warn = mock.method(logger, 'warn', () => {});
  const realRename = fs.renameSync;
  const spy = mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('EBUSY: resource busy raw'), { code: 'EBUSY' }); });
  try {
    await assert.rejects(() => mgr.renameFolder('A', 'B'), (err) => /Não foi possível renomear a pasta/.test(err.message) && !/EBUSY|raw/.test(err.message));
  } finally { spy.mock.restore(); warn.mock.restore(); }
  assert.ok(realRename);
  assert.deepEqual(rels(mgr), ['A/x.cube']);
  assert.equal(await mgr.renameFolder('A', 'B'), true, 'a trava foi liberada');
});

// ─── Excluir pasta ───────────────────────────────────────────────────────────────────────────────

test('deleteFolder: dryRun conta as LUTs e os outros arquivos reais (.3dl, texto, ocultos, além do limite de níveis) e não apaga nada', async (t) => {
  const { mgr, lutsDir, put } = setup(t);
  put('A/um.cube', cube3d(2, { tint: 0.1 }));
  put('A/B/dois.cube', cube3d(2, { tint: 0.2 }));
  put('A/film.3dl', 'x');
  put('A/notas.txt', 'x');
  put('A/.oculto', 'x');
  put('A/B/C/D/fundo.cube', cube3d(2, { tint: 0.3 })); // 5 níveis: a lista não mostra
  const trash = fakeTrash();
  assert.deepEqual(await mgr.deleteFolder('A', trash, { dryRun: true }), { luts: 2, others: 4 });
  assert.deepEqual(trash.calls, []);
  assert.equal(fs.readdirSync(path.join(lutsDir, 'A')).length, 5);
});

test('deleteFolder: manda só as LUTs, uma a uma, para a Lixeira; a pasta com outros arquivos fica e o resultado diz isso', async (t) => {
  const { mgr, lutsDir, put } = setup(t);
  put('A/um.cube', cube3d(2, { tint: 0.1 }));
  put('A/B/dois.cube', cube3d(2, { tint: 0.2 }));
  put('A/film.3dl', 'x');
  put('A/notas.txt', 'minhas notas');
  const trash = fakeTrash();
  const res = await mgr.deleteFolder('A', trash);
  assert.deepEqual(res, { trashed: 2, luts: 2, others: 2, remaining: 2, folderRemoved: false });
  assert.deepEqual(trash.calls.map((p) => path.basename(p)).sort(), ['dois.cube', 'um.cube']);
  assert.ok(trash.calls.every((p) => p.endsWith('.cube')), 'nunca a pasta inteira');
  assert.deepEqual(fs.readdirSync(path.join(lutsDir, 'A')).sort(), ['film.3dl', 'notas.txt'], 'a subpasta que ficou vazia foi removida; os outros arquivos ficaram');
  assert.equal(fs.readFileSync(path.join(lutsDir, 'A', 'notas.txt'), 'utf8'), 'minhas notas');
  assert.deepEqual(rels(mgr), []);
});

test('deleteFolder: pasta só com LUTs some inteira (inclusive as subpastas vazias)', async (t) => {
  const { mgr, lutsDir, put } = setup(t);
  put('Rush/Sub/Mais/a.cube', cube3d(2, { tint: 0.1 }));
  put('Rush/b.cube', cube3d(2, { tint: 0.2 }));
  put('Fica/c.cube', cube3d(2, { tint: 0.3 }));
  const trash = fakeTrash();
  const res = await mgr.deleteFolder('Rush', trash);
  assert.deepEqual(res, { trashed: 2, luts: 2, others: 0, remaining: 0, folderRemoved: true });
  assert.deepEqual(fs.readdirSync(lutsDir), ['Fica']);
  assert.ok(trash.calls.every((p) => p.endsWith('.cube')));
});

test('deleteFolder: arquivo oculto ou LUT em pasta oculta ou além do limite de níveis NUNCA vai para a Lixeira e a pasta fica', async (t) => {
  const { mgr, lutsDir, put } = setup(t);
  put('A/.rascunho.cube', cube3d(2, { tint: 0.1 }));
  put('A/.oculta/x.cube', cube3d(2, { tint: 0.2 }));
  put('A/B/C/D/fundo.cube', cube3d(2, { tint: 0.3 }));
  put('A/visivel.cube', cube3d(2, { tint: 0.4 }));
  const trash = fakeTrash();
  const res = await mgr.deleteFolder('A', trash);
  assert.deepEqual({ trashed: res.trashed, others: res.others, folderRemoved: res.folderRemoved }, { trashed: 1, others: 3, folderRemoved: false });
  assert.deepEqual(trash.calls.map((p) => path.basename(p)), ['visivel.cube']);
  assert.ok(fs.existsSync(path.join(lutsDir, 'A', '.rascunho.cube')));
  assert.ok(fs.existsSync(path.join(lutsDir, 'A', '.oculta', 'x.cube')));
  assert.ok(fs.existsSync(path.join(lutsDir, 'A', 'B', 'C', 'D', 'fundo.cube')));
});

test('deleteFolder: nunca a raiz da coleção, nunca atalho/junção, nunca pasta que sumiu; sem Lixeira não exclui', async (t) => {
  const { mgr, lutsDir, root, put } = setup(t);
  put('A/x.cube');
  const outside = path.join(root, 'fora');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'y.cube'), cube3d(2));
  const trash = fakeTrash();
  await assert.rejects(() => mgr.deleteFolder('', trash), (err) => err.code === 'LUT_USER');
  await assert.rejects(() => mgr.deleteFolder('.', trash), (err) => err.code === 'LUT_USER');
  await assert.rejects(() => mgr.deleteFolder('..', trash), (err) => err.code === 'LUT_USER');
  await assert.rejects(() => mgr.deleteFolder('Sumiu', trash), /não existe mais/);
  await assert.rejects(() => mgr.deleteFolder('A', undefined), /A Lixeira não está disponível/);
  assert.ok(fs.existsSync(path.join(lutsDir, 'A', 'x.cube')), 'sem Lixeira, nada foi excluído');
  try { fs.symlinkSync(outside, path.join(lutsDir, 'juncao'), 'junction'); } catch (err) { assert.deepEqual(trash.calls, []); return; }
  await assert.rejects(() => mgr.deleteFolder('juncao', trash), /não está na pasta de LUTs/);
  assert.ok(fs.existsSync(path.join(outside, 'y.cube')));
  assert.deepEqual(trash.calls, []);
});

test('deleteFolder: uma junção dentro da pasta não é seguida (nada de fora é excluído) e conta como "outro item"', async (t) => {
  const { mgr, lutsDir, root, put } = setup(t);
  const outside = path.join(root, 'fora');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'y.cube'), cube3d(2));
  put('A/x.cube');
  try { fs.symlinkSync(outside, path.join(lutsDir, 'A', 'juncao'), 'junction'); } catch (err) { t.skip('o sistema não permite criar links aqui'); return; }
  const trash = fakeTrash();
  const res = await mgr.deleteFolder('A', trash);
  assert.deepEqual({ trashed: res.trashed, others: res.others, folderRemoved: res.folderRemoved }, { trashed: 1, others: 1, folderRemoved: false });
  assert.ok(fs.existsSync(path.join(outside, 'y.cube')));
  assert.ok(fs.existsSync(path.join(lutsDir, 'A', 'juncao')));
});

test('deleteFolder: falha da Lixeira em uma LUT não impede as outras; falha em todas é erro; o texto cru não vaza', async (t) => {
  const { mgr, lutsDir, put } = setup(t);
  put('A/ok1.cube', cube3d(2, { tint: 0.1 }));
  put('A/ruim.cube', cube3d(2, { tint: 0.2 }));
  put('A/ok2.cube', cube3d(2, { tint: 0.3 }));
  const warn = mock.method(logger, 'warn', () => {});
  try {
    const picky = async (p) => { if (p.endsWith('ruim.cube')) throw new Error('Failed to move item to trash: EPERM raw'); fs.unlinkSync(p); };
    const res = await mgr.deleteFolder('A', picky);
    assert.deepEqual(res, { trashed: 2, luts: 3, others: 0, remaining: 1, folderRemoved: false });
    assert.ok(fs.existsSync(path.join(lutsDir, 'A', 'ruim.cube')));
    await assert.rejects(() => mgr.deleteFolder('A', async () => { throw new Error('EPERM raw'); }), (err) => err.message === 'Não foi possível mover as LUTs para a Lixeira.');
  } finally { warn.mock.restore(); }
});

test('deleteFolder: duas operações de escrita ao mesmo tempo não se sobrepõem (a segunda recebe "outra operação em andamento")', async (t) => {
  const { mgr, put } = setup(t);
  put('A/x.cube', cube3d(2, { tint: 0.1 }));
  put('B/y.cube', cube3d(2, { tint: 0.2 }));
  let release;
  const slowTrash = (p) => new Promise((resolve) => { release = () => { fs.unlinkSync(p); resolve(); }; });
  const first = mgr.deleteFolder('A', slowTrash);
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(() => mgr.deleteFolder('B', fakeTrash()), { message: 'Há outra operação em andamento.' });
  await assert.rejects(() => mgr.renameFolder('B', 'C'), { message: 'Há outra operação em andamento.' });
  assert.deepEqual(await mgr.deleteFolder('B', fakeTrash(), { dryRun: true }), { luts: 1, others: 0 }, 'só contar não precisa da trava');
  release();
  assert.equal((await first).trashed, 1);
});

test('hashOfAsync: duas chamadas ao mesmo tempo para o mesmo arquivo leem o arquivo uma vez só', async (t) => {
  const { mgr, put } = setup(t);
  const file = put('A/x.cube');
  let reads = 0;
  const realStream = fs.createReadStream;
  fs.createReadStream = (...args) => { reads++; return realStream(...args); };
  try {
    const [a, b] = await Promise.all([mgr.hashOfAsync(file), mgr.hashOfAsync(file)]);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  } finally { fs.createReadStream = realStream; }
  assert.equal(reads, 1);
  assert.equal(await mgr.hashOfAsync(file), mgr._loadHashes().get('A/x.cube').hash, 'a terceira vem do cache');
  assert.equal(reads, 1);
});

// ─── Exclusão em lote (seleção múltipla) ─────────────────────────────────────────────────────────

test('deleteMany: existentes vão para a Lixeira, ausentes são só contadas e o que está fora da coleção é recusado sem impedir as demais', async (t) => {
  const { mgr, lutsDir, root, put } = setup(t);
  const a = put('a.cube', cube3d(2, { tint: 0.1 }));
  const b = put('Looks/b.cube', cube3d(2, { tint: 0.2 }));
  const c = put('Looks/Rush/c.cube', cube3d(2, { tint: 0.3 }));
  const keep = put('Looks/fica.cube', cube3d(2, { tint: 0.4 }));
  const gone = path.join(lutsDir, 'sumiu.cube');
  const outside = path.join(root, 'fora.cube');
  fs.writeFileSync(outside, cube3d(2, { tint: 0.5 }));
  const folder = path.join(lutsDir, 'Looks');
  const trash = fakeTrash();

  const res = await mgr.deleteMany([a, b, gone, outside, folder, c], trash);
  assert.equal(res.trashed, 3);
  assert.equal(res.missing, 1);
  assert.deepEqual(res.failed.map((f) => f.path), [outside, folder]);
  assert.ok(res.failed.every((f) => f.reason === 'Esta LUT não está na pasta de LUTs.'));
  assert.deepEqual(trash.calls, [a, b, c], 'só o que passou na conferência chegou à Lixeira, na ordem pedida');
  assert.ok(fs.existsSync(outside), 'o arquivo de fora nunca é tocado');
  assert.ok(fs.existsSync(keep) && fs.existsSync(folder), 'o que não foi pedido (e a pasta) continua lá');
  assert.deepEqual(rels(mgr), ['Looks/fica.cube']);
});

test('deleteMany: a própria coleção, caminho relativo, "..", item que não é texto e não-.cube não chegam à Lixeira', async (t) => {
  const { mgr, lutsDir, put } = setup(t);
  put('a.cube');
  fs.writeFileSync(path.join(lutsDir, 'notas.txt'), 'x');
  const trash = fakeTrash();
  const res = await mgr.deleteMany([lutsDir, `${lutsDir}${path.sep}`, 'a.cube', path.join(lutsDir, '..', 'x.cube'), path.join(lutsDir, 'notas.txt'), 42, ''], trash);
  assert.equal(res.trashed, 0);
  assert.equal(res.failed.length, 6, 'a coleção com e sem barra final é o mesmo item e conta uma vez');
  assert.deepEqual(trash.calls, []);
  assert.deepEqual(rels(mgr), ['a.cube']);
  assert.ok(fs.existsSync(path.join(lutsDir, 'notas.txt')));
});

test('deleteMany: o mesmo caminho repetido (ou com outra caixa/barra) conta uma vez só e o cache de conteúdo acompanha', async (t) => {
  const { mgr, lutsDir, put } = setup(t);
  const a = put('A/x.cube', cube3d(2, { tint: 0.1 }));
  put('A/y.cube', cube3d(2, { tint: 0.2 }));
  await mgr.hashOfAsync(a);
  await mgr.hashOfAsync(path.join(lutsDir, 'A', 'y.cube'));
  assert.ok(mgr._loadHashes().has('A/x.cube'));
  const trash = fakeTrash();
  const variants = [a, a, path.join(lutsDir, 'A', '..', 'A', 'x.cube')];
  const res = await mgr.deleteMany(variants, trash);
  assert.deepEqual({ trashed: res.trashed, missing: res.missing, failed: res.failed.length }, { trashed: 1, missing: 0, failed: 0 });
  assert.equal(trash.calls.length, 1);
  assert.ok(!mgr._loadHashes().has('A/x.cube'), 'a LUT excluída sai do cache');
  assert.ok(mgr._loadHashes().has('A/y.cube'), 'as outras ficam');
});

test('deleteMany: sem lista ou sem Lixeira nada é excluído (nunca de forma definitiva); falha da Lixeira em uma LUT não impede as outras e não vaza texto cru', async (t) => {
  const { mgr, put } = setup(t);
  const a = put('a.cube', cube3d(2, { tint: 0.1 }));
  const bad = put('ruim.cube', cube3d(2, { tint: 0.2 }));
  const c = put('c.cube', cube3d(2, { tint: 0.3 }));
  await assert.rejects(() => mgr.deleteMany([], fakeTrash()), /Nenhuma LUT/);
  await assert.rejects(() => mgr.deleteMany('a.cube', fakeTrash()), /Nenhuma LUT/);
  await assert.rejects(() => mgr.deleteMany([a]), /Lixeira não está disponível/);
  await assert.rejects(() => mgr.deleteMany([a], 'não é função'), /Lixeira não está disponível/);
  assert.ok(fs.existsSync(a), 'continua no disco');

  const warn = mock.method(logger, 'warn', () => {});
  try {
    const picky = async (p) => { if (p === bad) throw new Error('Failed to move item to trash: EPERM raw'); fs.unlinkSync(p); };
    const res = await mgr.deleteMany([a, bad, c], picky);
    assert.equal(res.trashed, 2);
    assert.deepEqual(res.failed, [{ path: bad, reason: 'Não foi possível mover a LUT para a Lixeira.' }]);
    assert.ok(fs.existsSync(bad));
  } finally { warn.mock.restore(); }
  assert.deepEqual(rels(mgr), ['ruim.cube']);
});

test('deleteMany: usa a trava única (a segunda operação recebe "outra operação em andamento") e a libera ao terminar', async (t) => {
  const { mgr, put } = setup(t);
  const a = put('A/x.cube', cube3d(2, { tint: 0.1 }));
  const b = put('B/y.cube', cube3d(2, { tint: 0.2 }));
  let release;
  const slowTrash = (p) => new Promise((resolve) => { release = () => { fs.unlinkSync(p); resolve(); }; });
  const first = mgr.deleteMany([a], slowTrash);
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(() => mgr.deleteMany([b], fakeTrash()), { message: 'Há outra operação em andamento.' });
  await assert.rejects(() => mgr.deleteFolder('B', fakeTrash()), { message: 'Há outra operação em andamento.' });
  release();
  assert.equal((await first).trashed, 1);
  assert.equal((await mgr.deleteMany([b], fakeTrash())).trashed, 1);
});

test('deleteMany: 1200 LUTs de uma vez (o teto do canal é 5000) e todas vão para a Lixeira uma a uma', async (t) => {
  const { mgr, lutsDir, put } = setup(t);
  const paths = [];
  for (let i = 0; i < 1200; i++) paths.push(put(`Lote/l${i}.cube`, cube3d(2, { tint: i / 10000 })));
  const trash = fakeTrash();
  const res = await mgr.deleteMany(paths, trash);
  assert.deepEqual({ trashed: res.trashed, missing: res.missing, failed: res.failed.length }, { trashed: 1200, missing: 0, failed: 0 });
  assert.equal(trash.calls.length, 1200);
  assert.equal(mgr.list().length, 0);
  assert.ok(fs.existsSync(path.join(lutsDir, 'Lote')), 'a pasta (agora vazia) não é removida por este canal');
});
