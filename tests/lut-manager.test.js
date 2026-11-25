'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LutManager = require('../src/core/luts/LutManager');
const logger = require('../src/services/logService');

/** Gera um .cube 3D válido (tamanho 2 → 8 linhas); `tint` diferencia o conteúdo. */
function cube(tint = 0) {
  const rows = [];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(`${(r * 0.9 + tint).toFixed(3)} ${g} ${b}`);
  return `TITLE "t${tint}"\nLUT_3D_SIZE 2\n${rows.join('\n')}\n`;
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-lut-'));
  const lutsDir = path.join(root, 'luts');
  const inbox = path.join(root, 'inbox');
  fs.mkdirSync(lutsDir);
  fs.mkdirSync(inbox);
  const write = (name, content) => { const p = path.join(inbox, name); fs.writeFileSync(p, content); return p; };
  return { root, lutsDir, inbox, write, mgr: new LutManager(lutsDir) };
}

test('importar: copia, valida e devolve o resumo', () => {
  const { mgr, write } = setup();
  const res = mgr.importFiles([write('a.cube', cube(0)), write('lixo.cube', 'isto não é uma LUT'), write('nota.txt', 'x')]);
  assert.deepEqual(res.imported.map((i) => i.name), ['a.cube']);
  assert.equal(res.invalid.length, 2);
  assert.ok(res.invalid.find((i) => i.name === 'nota.txt').reason.includes('.cube'));
  assert.equal(mgr.list().length, 1);
});

test('importar: tabela incompleta é recusada', () => {
  const { mgr, write } = setup();
  const res = mgr.importFiles([write('curta.cube', 'LUT_3D_SIZE 2\n0 0 0\n1 1 1\n')]);
  assert.equal(res.imported.length, 0);
  assert.match(res.invalid[0].reason, /2 linhas; o esperado para tamanho 2 é 8/);
});

test('importar: nome repetido com conteúdo diferente NÃO sobrescreve (ganha sufixo)', () => {
  const { mgr, write, lutsDir } = setup();
  mgr.importFiles([write('a.cube', cube(0))]);
  const original = fs.readFileSync(path.join(lutsDir, 'a.cube'), 'utf-8');

  const res = mgr.importFiles([write('a.cube', cube(0.1))]);
  assert.deepEqual(res.renamed, [{ from: 'a.cube', to: 'a (2).cube' }]);
  assert.equal(fs.readFileSync(path.join(lutsDir, 'a.cube'), 'utf-8'), original); // intacta
  assert.equal(mgr.list().length, 2);
});

test('importar: conteúdo idêntico a uma LUT existente é ignorado', () => {
  const { mgr, write } = setup();
  mgr.importFiles([write('a.cube', cube(0))]);
  const res = mgr.importFiles([write('copia.cube', cube(0))]);
  assert.deepEqual(res.duplicates, ['copia.cube']);
  assert.equal(res.imported.length, 0);
  assert.equal(mgr.list().length, 1);
});

test('importar: lista vazia ou inválida retorna false', () => {
  const { mgr } = setup();
  assert.equal(mgr.importFiles([]), false);
  assert.equal(mgr.importFiles(null), false);
});

test('id: estável ao renomear e igual para conteúdos idênticos', async () => {
  const { mgr, write, lutsDir } = setup();
  const imported = mgr.importFiles([write('seed.cube', cube(0.5))]);
  assert.match(mgr.list()[0].hash, /^[0-9a-f]{64}$/, 'a importação já conhece o hash do que gravou (conferido na cópia) e o guarda');
  fs.unlinkSync(imported.imported[0].path);
  fs.writeFileSync(path.join(lutsDir, 'a.cube'), cube(0));
  assert.equal(mgr.list()[0].id, null, 'a lista nunca calcula o hash na hora: sem cache, o id ainda não existe');
  await mgr._hashFill; // o preenchimento em segundo plano terminou
  const before = mgr.list()[0];
  assert.match(before.id, /^[0-9a-f]{16}$/);
  assert.match(before.hash, /^[0-9a-f]{64}$/);

  assert.equal(mgr.rename(before.path, 'novo nome'), true);
  const after = mgr.list()[0];
  assert.equal(after.name, 'novo nome.cube');
  assert.equal(after.id, before.id, 'o hash acompanha o arquivo renomeado (sem ler de novo)');
});

test('renomear: recusa (sem corrigir em silêncio) caracteres inválidos, vazio e nome já existente', () => {
  const { mgr, write } = setup();
  mgr.importFiles([write('a.cube', cube(0)), write('b.cube', cube(0.1))]);
  const [a, b] = mgr.list().sort((x, y) => x.name.localeCompare(y.name));

  assert.throws(() => mgr.rename(a.path, 'Filme: "Cena" 1/2?'), /caracteres/);
  assert.throws(() => mgr.rename(b.path, '../fora'), /caracteres/);
  assert.throws(() => mgr.rename(b.path, '  ..  '), /espaço|ponto/);
  assert.throws(() => mgr.rename(b.path, ''), /Informe um nome/);
  assert.deepEqual(mgr.list().map((l) => l.name).sort(), ['a.cube', 'b.cube'], 'nada foi renomeado');

  mgr.rename(a.path, 'Filme Cena 12');
  assert.throws(() => mgr.rename(b.path, 'Filme Cena 12'), /Já existe/);
  assert.ok(mgr.list().every((l) => path.dirname(l.path) === path.dirname(a.path)));
});

test('renomear: só trocar a caixa das letras é permitido', () => {
  const { mgr, write } = setup();
  mgr.importFiles([write('cena.cube', cube(0))]);
  const lut = mgr.list()[0];
  assert.equal(mgr.rename(lut.path, 'CENA'), true);
  assert.equal(mgr.list()[0].name, 'CENA.cube');
});

test('excluir: usa a lixeira quando fornecida e recusa caminhos fora da pasta', async () => {
  const { mgr, write, root } = setup();
  mgr.importFiles([write('a.cube', cube(0))]);
  const lut = mgr.list()[0];

  const trashed = [];
  assert.equal(await mgr.delete(lut.path, async (p) => { trashed.push(p); fs.unlinkSync(p); }), true);
  assert.deepEqual(trashed, [lut.path]);
  assert.equal(mgr.list().length, 0);
  assert.equal(await mgr.delete(lut.path), false); // já não existe

  const outside = path.join(root, 'outro.cube');
  fs.writeFileSync(outside, cube(0));
  await assert.rejects(() => mgr.delete(outside, async () => {}));
  assert.ok(fs.existsSync(outside));
});

// ─── Base confiável (S1): listagem tolerante, segurança de caminho, nomes, validação única ───────

const CubeParser = require('../src/core/luts/CubeParser');
const { cube3d, cube1d, badCubes } = require('./helpers/cube-fixtures');

/** Como setup(), mas apaga a pasta temporária ao fim do teste (e espera o hash em segundo plano terminar). */
function setupClean(t) {
  const ctx = setup();
  t.after(async () => {
    await ctx.mgr._hashFill;
    if (ctx.mgr._persistTimer) clearTimeout(ctx.mgr._persistTimer);
    fs.rmSync(ctx.root, { recursive: true, force: true });
  });
  return ctx;
}

const put = (dir, name, content = cube3d(2)) => { const p = path.join(dir, name); fs.writeFileSync(p, content); return p; };
const namesOf = (mgr) => mgr.list().map((l) => l.name).sort();

test('listar: só arquivos .cube comuns (pasta "x.cube", ocultos, temporários e outros tipos ficam de fora) e traz os campos novos', async (t) => {
  const { mgr, lutsDir } = setupClean(t);
  put(lutsDir, 'Ignition.cube');
  put(lutsDir, 'MAIÚSCULA.CUBE');
  put(lutsDir, 'nota.txt');
  put(lutsDir, '.escondida.cube');
  put(lutsDir, '.Look.cube.abc123.part');
  put(lutsDir, '.hash-cache.json', '{}');
  fs.mkdirSync(path.join(lutsDir, 'pasta.cube'));

  const { items, problems } = mgr.listDetailed();
  assert.deepEqual(problems, []);
  assert.deepEqual(items.map((i) => i.name).sort(), ['Ignition.cube', 'MAIÚSCULA.CUBE']);
  const lut = items.find((i) => i.name === 'Ignition.cube');
  assert.equal(lut.displayName, 'Ignition');
  assert.equal(lut.relPath, 'Ignition.cube');
  assert.equal(lut.path, path.join(lutsDir, 'Ignition.cube'));
  assert.equal(lut.size, fs.statSync(lut.path).size);
  assert.equal(lut.modifiedAt, fs.statSync(lut.path).mtimeMs);
  assert.ok(lut.mtime instanceof Date);
  assert.equal(lut.hash, null, 'o hash não é calculado na hora');
  assert.equal(lut.id, null);
  assert.deepEqual(mgr.list().map((l) => l.name).sort(), ['Ignition.cube', 'MAIÚSCULA.CUBE'], 'list() devolve só o array');
});

test('listar: pasta inexistente é lista vazia, sem problema', (t) => {
  const { root } = setupClean(t);
  const mgr = new LutManager(path.join(root, 'nao-existe'));
  assert.deepEqual(mgr.listDetailed(), { items: [], problems: [] });
  assert.deepEqual(mgr.list(), []);
});

test('listar: um arquivo que some durante a leitura não derruba a lista (as outras LUTs continuam e o problema é registrado)', (t) => {
  const { mgr, lutsDir } = setupClean(t);
  put(lutsDir, 'a.cube');
  put(lutsDir, 'b.cube');
  put(lutsDir, 'c.cube');
  const warn = mock.method(logger, 'warn', () => {});
  const realStat = fs.statSync;
  const stat = mock.method(fs, 'statSync', (p, ...rest) => {
    if (String(p) === path.join(lutsDir, 'b.cube')) throw Object.assign(new Error('ENOENT simulado'), { code: 'ENOENT' });
    return realStat(p, ...rest);
  });
  try {
    const { items, problems } = mgr.listDetailed();
    assert.deepEqual(items.map((i) => i.name).sort(), ['a.cube', 'c.cube']);
    assert.deepEqual(problems, [{ name: 'b.cube', reason: 'Não foi possível ler este arquivo.' }]);
  } finally { stat.mock.restore(); warn.mock.restore(); }
});

test('listar: falha ao ler a pasta (que não seja "não existe") vira problema, nunca uma lista vazia calada', (t) => {
  const { mgr, lutsDir } = setupClean(t);
  put(lutsDir, 'a.cube');
  const err = mock.method(logger, 'error', () => {});
  const realReaddir = fs.readdirSync;
  const readdir = mock.method(fs, 'readdirSync', (p, ...rest) => {
    if (String(p) === lutsDir) throw Object.assign(new Error('EACCES simulado'), { code: 'EACCES' });
    return realReaddir(p, ...rest);
  });
  try {
    const { items, problems } = mgr.listDetailed();
    assert.deepEqual(items, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0].reason, /Não foi possível ler a pasta de LUTs/);
  } finally { readdir.mock.restore(); err.mock.restore(); }
});

test('listar: atalho (link simbólico) para um .cube não é listado e vira aviso; link quebrado também', (t) => {
  const { mgr, lutsDir, root } = setupClean(t);
  const target = put(root, 'fora.cube');
  put(lutsDir, 'real.cube');
  try {
    fs.symlinkSync(target, path.join(lutsDir, 'atalho.cube'));
    fs.symlinkSync(path.join(root, 'sumiu.cube'), path.join(lutsDir, 'quebrado.cube'));
  } catch (err) {
    t.skip(`o sistema não permite criar links simbólicos aqui (${err.code})`);
    return;
  }
  const { items, problems } = mgr.listDetailed();
  assert.deepEqual(items.map((i) => i.name), ['real.cube']);
  assert.deepEqual(problems.map((p) => p.name).sort(), ['atalho.cube', 'quebrado.cube']);
});

test('hash: preenchido em segundo plano, guardado em .hash-cache.json e reaproveitado por outra instância', async (t) => {
  const { mgr, lutsDir } = setupClean(t);
  put(lutsDir, 'a.cube', cube3d(2));
  put(lutsDir, 'b.cube', cube3d(2, { tint: 0.1 }));
  put(lutsDir, 'copia-de-a.cube', cube3d(2));

  assert.ok(mgr.list().every((l) => l.hash === null));
  await mgr._hashFill;
  const filled = mgr.list();
  assert.ok(filled.every((l) => /^[0-9a-f]{64}$/.test(l.hash)));
  const byName = Object.fromEntries(filled.map((l) => [l.name, l]));
  assert.equal(byName['a.cube'].hash, byName['copia-de-a.cube'].hash, 'conteúdo igual, hash igual');
  assert.notEqual(byName['a.cube'].hash, byName['b.cube'].hash);
  assert.equal(byName['a.cube'].id, byName['a.cube'].hash.slice(0, 16));

  mgr.flushHashCache();
  const saved = JSON.parse(fs.readFileSync(path.join(lutsDir, '.hash-cache.json'), 'utf-8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(Object.keys(saved.entries).sort(), ['a.cube', 'b.cube', 'copia-de-a.cube']);
  assert.ok(!fs.readdirSync(lutsDir).some((n) => n.endsWith('.tmp')), 'sem temporário sobrando');

  // "reabrir o app": outra instância já enxerga os hashes, sem calcular nada
  const reopened = new LutManager(lutsDir);
  const again = reopened.list();
  assert.ok(again.every((l) => l.hash && l.hash === byName[l.name].hash));
  assert.equal(reopened._hashFill, null, 'nada a preencher');
});

test('hash: arquivo alterado (tamanho ou data) perde o hash; arquivo apagado sai do cache; cache corrompido é ignorado', async (t) => {
  const { mgr, lutsDir } = setupClean(t);
  const a = put(lutsDir, 'a.cube', cube3d(2));
  put(lutsDir, 'b.cube', cube3d(2, { tint: 0.1 }));
  mgr.list();
  await mgr._hashFill;
  const before = mgr.list().find((l) => l.name === 'a.cube').hash;

  fs.writeFileSync(a, cube3d(2, { tint: 0.3 }));
  const changed = mgr.list().find((l) => l.name === 'a.cube');
  assert.equal(changed.hash, null, 'o hash antigo não vale mais');
  await mgr._hashFill;
  const after = mgr.list().find((l) => l.name === 'a.cube').hash;
  assert.notEqual(after, before);

  fs.unlinkSync(path.join(lutsDir, 'b.cube'));
  mgr.list();
  assert.deepEqual([...mgr._loadHashes().keys()], ['a.cube']);

  mgr.flushHashCache();
  fs.writeFileSync(path.join(lutsDir, '.hash-cache.json'), '{ isto não é json');
  const reopened = new LutManager(lutsDir);
  assert.equal(reopened.list()[0].hash, null);
  await reopened._hashFill;
  assert.match(reopened.list()[0].hash, /^[0-9a-f]{64}$/);
});

test('hash: entradas inválidas do cache em disco são descartadas', (t) => {
  const { lutsDir } = setupClean(t);
  put(lutsDir, 'a.cube');
  const size = fs.statSync(path.join(lutsDir, 'a.cube'));
  fs.writeFileSync(path.join(lutsDir, '.hash-cache.json'), JSON.stringify({
    version: 1, entries: { 'a.cube': { key: `${size.size}:${size.mtimeMs}`, hash: 'não-é-hash' }, 'b.cube': 42 }
  }));
  assert.equal(new LutManager(lutsDir).list()[0].hash, null);
});

test('hash: arquivo acima do limite nunca é lido nem tem hash (esparso de 100 MB)', async (t) => {
  const { mgr, lutsDir } = setupClean(t);
  const big = path.join(lutsDir, 'gigante.cube');
  const fd = fs.openSync(big, 'w');
  fs.ftruncateSync(fd, 100 * 1024 * 1024);
  fs.closeSync(fd);
  const stream = mock.method(fs, 'createReadStream');
  try {
    assert.equal(await mgr.hashOfAsync(big), null);
    assert.equal(stream.mock.calls.filter((c) => String(c.arguments[0]) === big).length, 0, 'nem abriu o arquivo');
    assert.equal(mgr.list()[0].hash, null);
  } finally { stream.mock.restore(); }
});

test('hash: arquivo alterado durante a leitura não é guardado no cache', async (t) => {
  const { mgr, lutsDir } = setupClean(t);
  const p = put(lutsDir, 'a.cube', cube3d(3));
  const realStat = fs.promises.stat;
  let calls = 0;
  const stat = mock.method(fs.promises, 'stat', async (...args) => {
    const s = await realStat(...args);
    calls++;
    if (calls === 2) return { isFile: () => true, size: s.size + 1, mtimeMs: s.mtimeMs }; // "mudou" entre o começo e o fim
    return s;
  });
  try {
    assert.equal(await mgr.hashOfAsync(p), null);
    assert.equal(mgr._loadHashes().size, 0);
  } finally { stat.mock.restore(); }
});

// Segurança de caminho

test('assertFileInside: aceita só .cube comum estritamente dentro da pasta (com barra final, outra caixa e caminhos com ..)', (t) => {
  const { mgr, lutsDir } = setupClean(t);
  const p = put(lutsDir, 'Cena.cube');
  assert.equal(mgr.assertFileInside(p), p);
  assert.equal(mgr.assertFileInside(path.join(lutsDir, '..', 'luts', 'Cena.cube')), path.join(lutsDir, 'Cena.cube'));
  const withSlash = new LutManager(`${lutsDir}${path.sep}`);
  assert.doesNotThrow(() => withSlash.assertFileInside(p));
  if (process.platform === 'win32') assert.doesNotThrow(() => mgr.assertFileInside(p.toUpperCase().replace(/\.CUBE$/, '.cube')), 'o Windows não diferencia maiúsculas');
});

test('assertFileInside: recusa a própria pasta, pasta, fora da coleção, relativo, não-.cube, atalho e inexistente', (t) => {
  const { mgr, lutsDir, root } = setupClean(t);
  put(lutsDir, 'Cena.cube');
  put(lutsDir, 'nota.txt', 'x');
  fs.mkdirSync(path.join(lutsDir, 'pasta.cube'));
  const outside = put(root, 'fora.cube');
  const inside = /Esta LUT não está na pasta de LUTs/;
  assert.throws(() => mgr.assertFileInside(lutsDir), inside);
  assert.throws(() => mgr.assertFileInside(`${lutsDir}${path.sep}`), inside);
  assert.throws(() => mgr.assertFileInside(path.join(lutsDir, 'pasta.cube')), inside);
  assert.throws(() => mgr.assertFileInside(outside), inside);
  assert.throws(() => mgr.assertFileInside(path.join(lutsDir, '..', 'fora.cube')), inside);
  assert.throws(() => mgr.assertFileInside('Cena.cube'), inside);
  assert.throws(() => mgr.assertFileInside(path.join(lutsDir, 'nota.txt')), inside);
  assert.throws(() => mgr.assertFileInside(''), inside);
  assert.throws(() => mgr.assertFileInside(null), inside);
  assert.throws(() => mgr.assertFileInside(path.join(lutsDir, 'sumiu.cube')), /não foi encontrada/);
  try {
    fs.symlinkSync(outside, path.join(lutsDir, 'atalho.cube'));
    assert.throws(() => mgr.assertFileInside(path.join(lutsDir, 'atalho.cube')), inside);
  } catch (err) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(err.code) && !/privilege/i.test(err.message)) throw err;
  }
});

test('assertFileInside: uma junção dentro da pasta que leva para fora não dá acesso ao que está fora', (t) => {
  const { mgr, lutsDir, root } = setupClean(t);
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  put(elsewhere, 'segredo.cube');
  const link = path.join(lutsDir, 'atalho-pasta');
  try { fs.symlinkSync(elsewhere, link, 'junction'); } catch (err) { t.skip(`sem permissão para criar junção (${err.code})`); return; }
  assert.throws(() => mgr.assertFileInside(path.join(link, 'segredo.cube')), /Esta LUT não está na pasta de LUTs/);
});

test('excluir, renomear: recusam a própria pasta de LUTs, pastas e variações do caminho (nada é apagado)', async (t) => {
  const { mgr, lutsDir } = setupClean(t);
  put(lutsDir, 'a.cube');
  fs.mkdirSync(path.join(lutsDir, 'pasta.cube'));
  const trashed = [];
  const trash = async (p) => { trashed.push(p); };
  for (const target of [lutsDir, `${lutsDir}${path.sep}`, path.join(lutsDir, 'pasta.cube'), path.join(lutsDir, '..')]) {
    await assert.rejects(() => mgr.delete(target, trash), /Esta LUT não está na pasta de LUTs/, target);
    assert.throws(() => mgr.rename(target, 'novo'), /Esta LUT não está na pasta de LUTs/, target);
  }
  assert.deepEqual(trashed, [], 'a Lixeira nunca foi chamada');
  assert.ok(fs.existsSync(lutsDir) && fs.existsSync(path.join(lutsDir, 'a.cube')) && fs.existsSync(path.join(lutsDir, 'pasta.cube')));
});

test('excluir: sem Lixeira não exclui de forma definitiva; falha da Lixeira vira erro em português e o arquivo fica', async (t) => {
  const { mgr, lutsDir } = setupClean(t);
  const p = put(lutsDir, 'a.cube');
  await assert.rejects(() => mgr.delete(p), /Lixeira não está disponível/);
  await assert.rejects(() => mgr.delete(p, 'não é função'), /Lixeira não está disponível/);
  assert.ok(fs.existsSync(p), 'continua no disco');

  const warn = mock.method(logger, 'warn', () => {});
  try {
    await assert.rejects(() => mgr.delete(p, async () => { throw new Error('Failed to move item to trash: EPERM'); }), (err) => err.message === 'Não foi possível mover a LUT para a Lixeira.');
  } finally { warn.mock.restore(); }
  assert.ok(fs.existsSync(p));
});

// Nomes

test('renomear: nomes reservados do Windows, caracteres proibidos e pontas inválidas são recusados com o motivo', (t) => {
  const { mgr, lutsDir } = setupClean(t);
  const p = put(lutsDir, 'a.cube');
  for (const bad of ['CON', 'con', 'aux.cube', 'Nul', 'COM1', 'com9.cube', 'LPT1', 'lpt3', 'nul.txt']) {
    assert.throws(() => mgr.rename(p, bad), /reservado pelo Windows/, bad);
  }
  for (const bad of ['a:b', 'a/b', 'a\\b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0001b', '../fora']) {
    assert.throws(() => mgr.rename(p, bad), /caracteres/, JSON.stringify(bad));
  }
  assert.throws(() => mgr.rename(p, 'termina com ponto.'), /terminar com espaço|terminar com ponto|começar nem terminar/);
  assert.throws(() => mgr.rename(p, 'termina com espaço '), /terminar/);
  assert.throws(() => mgr.rename(p, ' começa com espaço'), /começar/);
  assert.throws(() => mgr.rename(p, '.oculta'), /começar com ponto/);
  assert.throws(() => mgr.rename(p, '..'), /ponto|espaço/);
  assert.throws(() => mgr.rename(p, '   '), /espaço/);
  assert.throws(() => mgr.rename(p, ''), /Informe um nome/);
  assert.throws(() => mgr.rename(p, undefined), /Informe um nome/);
  assert.ok(fs.existsSync(p), 'continua com o nome de antes');
  assert.deepEqual(fs.readdirSync(lutsDir).filter((n) => n.endsWith('.cube')), ['a.cube']);
});

test('renomear: nomes válidos (acentos, espaços, pontos no meio, extensão opcional) e só trocar a caixa', (t) => {
  const { mgr, lutsDir } = setupClean(t);
  const p = put(lutsDir, 'a.cube');
  assert.equal(mgr.rename(p, 'Filme Ação v1.2 (final)'), true);
  assert.deepEqual(namesOf(mgr), ['Filme Ação v1.2 (final).cube']);
  assert.equal(mgr.rename(path.join(lutsDir, 'Filme Ação v1.2 (final).cube'), 'outro.CUBE'), true, 'a extensão informada não duplica');
  assert.deepEqual(namesOf(mgr), ['outro.cube']);
  assert.equal(mgr.rename(path.join(lutsDir, 'outro.cube'), 'Outro'), true);
  assert.deepEqual(namesOf(mgr), ['Outro.cube']);
  assert.equal(mgr.rename(path.join(lutsDir, 'Outro.cube'), 'Outro'), true, 'mesmo nome: nada a fazer');
  assert.equal(mgr.rename(path.join(lutsDir, 'nao-existe.cube'), 'x'), false, 'já não existe');
});

test('validateName: devolve o nome com a extensão e respeita o limite de caminho do Windows e do celular', (t) => {
  const { mgr, lutsDir } = setupClean(t);
  assert.deepEqual(mgr.validateName('Meu look'), { ok: true, name: 'Meu look.cube', reason: null });
  assert.deepEqual(mgr.validateName('Meu look.cube'), { ok: true, name: 'Meu look.cube', reason: null });
  assert.equal(mgr.validateName('CON').ok, false);
  const room = 259 - lutsDir.length - 1 - 24 - '.cube'.length; // o que ainda cabe sem estourar
  assert.equal(mgr.validateName('x'.repeat(room)).ok, true);
  const tooLong = mgr.validateName('x'.repeat(room + 1));
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.reason, /longo demais para o Windows/);
  const deep = path.join(lutsDir, 'a'.repeat(100), 'b'.repeat(100));
  assert.match(mgr.validateName('c'.repeat(60), deep).reason, /longo demais/);
  // limite do celular (255 no caminho relativo), com a pasta de LUTs curta
  const short = new LutManager(path.parse(lutsDir).root + 'L');
  assert.match(short.validateName('y'.repeat(251)).reason, /celular|Windows/);
});

// Importação: a mesma validação da leitura

test('importar: toda LUT ruim da tabela é recusada com o motivo e nenhuma entra na coleção', (t) => {
  const { mgr, inbox, lutsDir } = setupClean(t);
  const files = badCubes().map((bad) => { const p = path.join(inbox, `${bad.name}.cube`); fs.writeFileSync(p, bad.content); return p; });
  const res = mgr.importFiles(files);
  assert.equal(res.imported.length, 0);
  assert.equal(res.invalid.length, files.length);
  for (const bad of badCubes()) {
    const item = res.invalid.find((i) => i.name === `${bad.name}.cube`);
    assert.equal(item.reason, CubeParser.validate(path.join(inbox, `${bad.name}.cube`)).reason, bad.name);
  }
  assert.deepEqual(fs.readdirSync(lutsDir), []);
});

test('importar: o que entra é sempre o que a leitura consegue abrir (1D, 3D, CRLF, BOM) e 1D+3D juntos é recusada com mensagem clara', (t) => {
  const { mgr, inbox, lutsDir } = setupClean(t);
  const good = {
    '3d.cube': cube3d(17), '1d.cube': cube1d(256), 'crlf.cube': cube3d(2, { eol: '\r\n' }), 'bom.cube': cube3d(3, { bom: true })
  };
  const paths = Object.entries(good).map(([name, content]) => { const p = path.join(inbox, name); fs.writeFileSync(p, content); return p; });
  const mixed = path.join(inbox, 'mista.cube');
  fs.writeFileSync(mixed, 'LUT_1D_SIZE 3\n0 0 0\n.5 .5 .5\n1 1 1\nLUT_3D_SIZE 2\n');
  const res = mgr.importFiles([...paths, mixed]);
  assert.equal(res.imported.length, 4);
  assert.deepEqual(res.invalid, [{ name: 'mista.cube', reason: 'Esta LUT traz tabelas 1D e 3D no mesmo arquivo, formato que o programa não aceita.' }]);
  for (const item of res.imported) assert.doesNotThrow(() => CubeParser.parse(item.path), item.name);
  assert.equal(mgr.list().length, 4);
  assert.ok(!fs.existsSync(path.join(lutsDir, 'mista.cube')));
});

test('importar: conteúdo igual a uma LUT que já está numa subpasta da coleção também é ignorado', (t) => {
  const { mgr, lutsDir, write } = setupClean(t);
  fs.mkdirSync(path.join(lutsDir, 'Meus Looks'));
  put(path.join(lutsDir, 'Meus Looks'), 'guardada.cube', cube3d(2));
  const res = mgr.importFiles([write('nova.cube', cube3d(2)), write('outra.cube', cube3d(2, { tint: 0.2 }))]);
  assert.deepEqual(res.duplicates, ['nova.cube']);
  assert.deepEqual(res.imported.map((i) => i.name), ['outra.cube']);
});

test('importar: duas cópias iguais no mesmo lote entram uma vez só', (t) => {
  const { mgr, write } = setupClean(t);
  const res = mgr.importFiles([write('um.cube', cube3d(2)), write('dois.cube', cube3d(2))]);
  assert.deepEqual(res.imported.map((i) => i.name), ['um.cube']);
  assert.deepEqual(res.duplicates, ['dois.cube']);
});

test('importar: pasta no lugar de arquivo, caminho relativo e extensão errada são recusados ou ignorados com motivo', (t) => {
  const { mgr, inbox, write } = setupClean(t);
  fs.mkdirSync(path.join(inbox, 'pasta.cube'));
  const res = mgr.importFiles([path.join(inbox, 'pasta.cube'), write('nota.txt', cube3d(2)), 'relativo.cube', write('ok.cube', cube3d(2))]);
  assert.deepEqual(res.imported.map((i) => i.name), ['ok.cube']);
  assert.deepEqual(res.invalid.map((i) => [i.name, i.reason]), [['pasta.cube', 'Não é um arquivo.'], ['nota.txt', 'Não é um arquivo .cube.']]);
});
