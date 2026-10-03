'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LutManager = require('../src/core/luts/LutManager');

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
  assert.match(res.invalid[0].reason, /incompleta/);
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

test('id: estável ao renomear e igual para conteúdos idênticos', () => {
  const { mgr, write } = setup();
  mgr.importFiles([write('a.cube', cube(0))]);
  const before = mgr.list()[0];
  assert.match(before.id, /^[0-9a-f]{16}$/);

  assert.equal(mgr.rename(before.path, 'novo nome'), true);
  const after = mgr.list()[0];
  assert.equal(after.name, 'novo nome.cube');
  assert.equal(after.id, before.id);
});

test('renomear: sanitiza caracteres inválidos, recusa vazio e nome já existente', () => {
  const { mgr, write } = setup();
  mgr.importFiles([write('a.cube', cube(0)), write('b.cube', cube(0.1))]);
  const [a, b] = mgr.list().sort((x, y) => x.name.localeCompare(y.name));

  mgr.rename(a.path, 'Filme: "Cena" 1/2?');
  assert.ok(mgr.list().some((l) => l.name === 'Filme Cena 12.cube'));

  assert.throws(() => mgr.rename(b.path, '  ..  '), /nome válido/);
  assert.throws(() => mgr.rename(b.path, 'Filme Cena 12'), /Já existe/);
  // tentativa de sair da pasta: as barras são removidas e o arquivo continua dentro dela
  mgr.rename(b.path, '../fora');
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

test('LUTs embutidas: instaladas uma vez; a que o usuário excluiu não volta', () => {
  const { mgr, root, lutsDir } = setup();
  const bundled = path.join(root, 'bundled');
  fs.mkdirSync(bundled);
  fs.writeFileSync(path.join(bundled, 'x.cube'), cube(0));
  fs.writeFileSync(path.join(bundled, 'y.cube'), cube(0.2));

  mgr.ensureBundledLuts(bundled);
  assert.deepEqual(mgr.list().map((l) => l.name).sort(), ['x.cube', 'y.cube']);

  fs.unlinkSync(path.join(lutsDir, 'x.cube')); // usuário exclui
  mgr.ensureBundledLuts(bundled); // "reabre o app"
  assert.deepEqual(mgr.list().map((l) => l.name), ['y.cube']);

  fs.writeFileSync(path.join(bundled, 'z.cube'), cube(0.3)); // atualização do app traz uma nova
  mgr.ensureBundledLuts(bundled);
  assert.deepEqual(mgr.list().map((l) => l.name).sort(), ['y.cube', 'z.cube']);
});
