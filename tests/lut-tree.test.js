'use strict';

// Regra única da árvore de LUTs (src/core/luts/lutTree.js): varredura em segundo plano e síncrona com o mesmo
// resultado, limite de níveis, links e junções nunca seguidos, tetos, cancelamento, e o destino de cada arquivo importado.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { walkTree, walkTreeSync, planDestination, compareRel, maxRelPathLength } = require('../src/core/luts/lutTree');
const { budget } = require('./helpers/timing');

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-lut-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const put = (root, rel, content = 'x') => {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};
const rels = (walk) => walk.files.map((f) => f.relPath);

// ─── walkTree ────────────────────────────────────────────────────────────────────────────────────

test('walkTree: profundidade máxima conta o arquivo (3 níveis de pasta); mais fundo é relatado, não listado', async (t) => {
  const root = tmp(t);
  put(root, 'raiz.cube');
  put(root, 'A/um.cube');
  put(root, 'A/B/dois.cube');
  put(root, 'A/B/C/tres.cube');
  put(root, 'A/B/C/D/quatro.cube');
  put(root, 'A/B/C/D/E/cinco.cube');
  const walk = await walkTree(root, { maxSegments: 4 });
  assert.deepEqual(rels(walk), ['A/B/C/tres.cube', 'A/B/dois.cube', 'A/um.cube', 'raiz.cube'].sort((a, b) => compareRel(a, b)));
  assert.deepEqual(walk.tooDeep, ['A/B/C/D']);
  assert.equal(walk.tooDeepCount, 1);
  const byRel = Object.fromEntries(walk.files.map((f) => [f.relPath, f]));
  assert.equal(byRel['raiz.cube'].depth, 0);
  assert.equal(byRel['A/B/C/tres.cube'].depth, 3);
  assert.equal(byRel['A/B/C/tres.cube'].folder, 'A/B/C');
  assert.equal(byRel['A/um.cube'].size, 1);
  assert.equal(byRel['A/um.cube'].abs, path.join(root, 'A', 'um.cube'));
  assert.ok(Number.isFinite(byRel['A/um.cube'].mtimeMs));
  // com limite maior, o fundo aparece
  assert.equal((await walkTree(root, { maxSegments: 16 })).files.length, 6);
});

test('walkTreeSync e walkTree dão o mesmo resultado', async (t) => {
  const root = tmp(t);
  for (const rel of ['b.cube', 'a.cube', 'Look 10/x.cube', 'Look 2/y.cube', 'Look 2/Sub/z.cube', 'nota.txt', 'film.3dl']) put(root, rel);
  const a = await walkTree(root, { maxSegments: 4 });
  const s = walkTreeSync(root, { maxSegments: 4 });
  assert.deepEqual(rels(a), rels(s));
  assert.deepEqual(a.ignoredExt, s.ignoredExt);
  assert.deepEqual(rels(a), ['a.cube', 'b.cube', 'Look 2/Sub/z.cube', 'Look 2/y.cube', 'Look 10/x.cube'].sort((x, y) => compareRel(x, y)));
  assert.equal(rels(a).indexOf('Look 2/y.cube') < rels(a).indexOf('Look 10/x.cube'), true, 'ordem natural: "Look 2" antes de "Look 10"');
});

test('walkTree: ignora ocultos, temporários, lixeira do volume e conta os outros tipos (.3dl) sem listá-los', async (t) => {
  const root = tmp(t);
  put(root, 'boa.cube');
  put(root, 'MAIÚSCULA.CUBE');
  put(root, '.escondida.cube');
  put(root, '.Look.cube.abc123abc123.part');
  put(root, '.hash-cache.json');
  put(root, '.pasta-oculta/x.cube');
  put(root, '$Recycle.Bin/x.cube');
  put(root, 'System Volume Information/x.cube');
  put(root, 'film.3dl');
  put(root, 'outro.3DL');
  put(root, 'nota.txt');
  put(root, 'semextensao');
  const walk = await walkTree(root, { maxSegments: 4 });
  assert.deepEqual(rels(walk).sort(), ['MAIÚSCULA.CUBE', 'boa.cube']);
  assert.deepEqual(walk.ignoredExt, { '.3dl': 2, '.txt': 1, '(sem extensão)': 1 });
});

test('walkTree: com exts null devolve todos os arquivos e com includeHidden enxerga os ocultos (inspeção antes de excluir pasta)', async (t) => {
  const root = tmp(t);
  put(root, 'a.cube');
  put(root, 'nota.txt');
  put(root, '.oculto');
  put(root, 'Sub/.x.cube.aaaaaaaaaaaa.part');
  const all = await walkTree(root, { exts: null, includeHidden: true, maxSegments: Infinity });
  assert.deepEqual(rels(all).sort(), ['.oculto', 'Sub/.x.cube.aaaaaaaaaaaa.part', 'a.cube', 'nota.txt']);
  assert.deepEqual(all.dirs.map((d) => d.relPath).sort(), ['', 'Sub']);
  const plain = await walkTree(root, { exts: null, maxSegments: Infinity });
  assert.deepEqual(rels(plain).sort(), ['a.cube', 'nota.txt']);
});

test('walkTree: junção e link simbólico NUNCA são seguidos e são contados', async (t) => {
  const root = tmp(t);
  const outside = tmp(t);
  put(outside, 'segredo.cube');
  put(root, 'real/ok.cube');
  let made = [];
  try {
    fs.symlinkSync(outside, path.join(root, 'juncao'), 'junction');
    made.push('juncao');
  } catch (err) { /* sem permissão */ }
  try {
    fs.symlinkSync(path.join(root, 'real', 'ok.cube'), path.join(root, 'atalho.cube'), 'file');
    made.push('atalho.cube');
  } catch (err) { /* o Windows comum não cria link de arquivo sem privilégio */ }
  if (!made.length) { t.skip('o sistema não permite criar links aqui'); return; }
  for (const walk of [await walkTree(root, { maxSegments: 4 }), walkTreeSync(root, { maxSegments: 4 })]) {
    assert.deepEqual(rels(walk), ['real/ok.cube'], 'nada de fora da pasta entrou');
    assert.equal(walk.ignoredLinks, made.length);
    assert.deepEqual(walk.links.map((l) => l.relPath).sort(), [...made].sort());
    if (made.includes('juncao')) assert.equal(walk.links.find((l) => l.relPath === 'juncao').isDir, true);
  }
});

test('walkTree: a raiz pode ser um link (é resolvida antes de varrer); dentro dela os links continuam ignorados', async (t) => {
  const real = tmp(t);
  const holder = tmp(t);
  put(real, 'a.cube');
  put(real, 'S/b.cube');
  const link = path.join(holder, 'colecao');
  try { fs.symlinkSync(real, link, 'junction'); } catch (err) { t.skip('o sistema não permite criar links aqui'); return; }
  const walk = await walkTree(link, { maxSegments: 4 });
  assert.deepEqual(rels(walk), ['S/b.cube', 'a.cube'].sort((x, y) => compareRel(x, y)));
  assert.equal(walk.ignoredLinks, 0);
});

test('walkTree: pasta inexistente devolve rootError (sem lançar)', async (t) => {
  const root = tmp(t);
  const walk = await walkTree(path.join(root, 'nao-existe'));
  assert.equal(walk.rootError.code, 'ENOENT');
  assert.deepEqual(walk.files, []);
  assert.equal(walkTreeSync(path.join(root, 'nao-existe')).rootError.code, 'ENOENT');
});

test('walkTree: teto de entradas conta TODA entrada visitada e avisa com truncated', async (t) => {
  const root = tmp(t);
  for (let i = 0; i < 30; i++) put(root, `Pasta ${i}/x.cube`);
  const walk = await walkTree(root, { maxEntries: 10, maxSegments: 4 });
  assert.equal(walk.truncated, true);
  assert.ok(walk.entries <= 11);
  const full = await walkTree(root, { maxEntries: 1000, maxSegments: 4 });
  assert.equal(full.truncated, false);
  assert.equal(full.files.length, 30);
});

test('walkTree: prazo esgotado interrompe com truncated/timedOut', async (t) => {
  const root = tmp(t);
  for (let i = 0; i < 5; i++) put(root, `P${i}/x.cube`);
  const walk = await walkTree(root, { deadlineMs: -1, maxSegments: 4 }); // prazo já vencido
  assert.equal(walk.truncated, true);
  assert.equal(walk.timedOut, true);
});

test('walkTree: AbortSignal cancela no meio (checado entre pastas) e devolve o que já havia', async (t) => {
  const root = tmp(t);
  for (let i = 0; i < 20; i++) put(root, `P${i}/x.cube`);
  const pre = new AbortController();
  pre.abort();
  const before = await walkTree(root, { signal: pre.signal, maxSegments: 4 });
  assert.equal(before.canceled, true);
  assert.deepEqual(before.files, []);

  const during = new AbortController();
  const walk = await walkTree(root, { signal: during.signal, maxSegments: 4, onProgress: () => during.abort() });
  assert.equal(walk.canceled, true);
  assert.ok(walk.files.length < 20);
});

test('walkTree: cede o laço entre pastas (o processo continua respondendo durante uma varredura grande)', async (t) => {
  const root = tmp(t);
  for (let i = 0; i < 300; i++) put(root, `P${i}/x.cube`);
  let ticks = 0;
  let maxGap = 0;
  let last = Date.now();
  const timer = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }, 1);
  const walk = await walkTree(root, { maxSegments: 4 });
  clearInterval(timer);
  assert.equal(walk.files.length, 300);
  assert.ok(ticks > 0, 'o relógio andou durante a varredura');
  assert.ok(maxGap < budget(250), `o laço ficou parado ${maxGap} ms`);
});

// ─── planDestination ─────────────────────────────────────────────────────────────────────────────

const LUTS = path.join(os.tmpdir(), 'bds-luts-plan');

test('planDestination: preserva as subpastas e funde o excedente de níveis no último com " - "', () => {
  const plan = (folder, o = {}) => planDestination({ name: 'x.cube', folder }, { lutsDir: LUTS, ...o });
  assert.deepEqual(plan('').folders, []);
  assert.deepEqual(plan('a').folders, ['a']);
  assert.deepEqual(plan('a/b').folders, ['a', 'b']);
  assert.deepEqual(plan('a/b/c').folders, ['a', 'b', 'c']);
  assert.equal(plan('a/b/c').folded, false);
  const four = plan('a/b/c/d');
  assert.deepEqual(four.folders, ['a', 'b', 'c - d']);
  assert.equal(four.relPath, 'a/b/c - d/x.cube');
  assert.equal(four.folded, true);
  assert.deepEqual(plan('a/b/c/d/e/f').folders, ['a', 'b', 'c - d - e - f']);
  // o grupo raiz conta como um nível
  assert.deepEqual(plan('a/b', { rootGroup: 'Pasta' }).folders, ['Pasta', 'a', 'b']);
  assert.deepEqual(plan('a/b/c', { rootGroup: 'Pasta' }).folders, ['Pasta', 'a', 'b - c']);
  // sem keepFolders só o grupo raiz vale
  assert.deepEqual(plan('a/b', { keepFolders: false }).folders, []);
  assert.deepEqual(plan('a/b', { keepFolders: false, rootGroup: 'Pasta' }).folders, ['Pasta']);
  assert.equal(plan('a/b', { keepFolders: false, rootGroup: 'Pasta' }).relPath, 'Pasta/x.cube');
});

test('planDestination: rootGroup é um único segmento válido (nada de separador, "..", ":" nem nome reservado)', () => {
  const plan = (rootGroup) => planDestination({ name: 'x.cube', folder: '' }, { lutsDir: LUTS, rootGroup });
  for (const bad of ['a/b', 'a\\b', '..', '.', 'a:b', 'C:', 'CON', 'nul', 'com1', 'x.', ' x', 'x ', '.oculta', 'a*b', 'a"b', 'y'.repeat(101), 'a\u0000b']) {
    assert.equal(plan(bad).ok, false, `deveria recusar ${JSON.stringify(bad)}`);
  }
  assert.equal(plan('Minhas LUTs 2026').ok, true);
  assert.equal(plan('Ação').ok, true);
});

test('planDestination: nomes de subpastas da origem são limpos, nunca recusados nem perigosos', () => {
  const folders = (folder) => planDestination({ name: 'x.cube', folder }, { lutsDir: LUTS }).folders;
  assert.deepEqual(folders('CON/nul'), ['_CON', '_nul']);
  assert.deepEqual(folders('a|b/c?d'), ['a_b', 'c_d']);
  assert.deepEqual(folders('fim com ponto./ ok'), ['fim com ponto', 'ok']);
  for (const segment of folders('..x/a:b/COM1.txt')) assert.ok(!/^\.|[:\\/]/.test(segment), segment);
});

test('planDestination: nome de arquivo reservado ou com caractere proibido vira motivo, não cópia', () => {
  for (const name of ['CON.cube', 'a:b.cube', '.escondida.cube']) {
    const r = planDestination({ name, folder: '' }, { lutsDir: LUTS });
    assert.equal(r.ok, false, name);
    assert.match(r.reason, /Nome de arquivo não aceito/);
  }
});

test('planDestination: orçamento real de caminho (Windows e celular) com a pasta de LUTs longa ou curta', () => {
  const longDir = path.join(os.tmpdir(), 'x'.repeat(150));
  const room = maxRelPathLength(longDir);
  const fits = planDestination({ name: `${'n'.repeat(room - 5)}.cube`, folder: '' }, { lutsDir: longDir });
  assert.equal(fits.ok, true);
  const tooLong = planDestination({ name: `${'n'.repeat(room - 4)}.cube`, folder: '' }, { lutsDir: longDir });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.reason, /longo demais para o Windows/);
  // pastas fundas somam ao caminho
  const deep = planDestination({ name: 'x.cube', folder: `${'a'.repeat(90)}/${'b'.repeat(90)}` }, { lutsDir: longDir });
  assert.equal(deep.ok, false);
  // limite do celular (255) com uma pasta de LUTs curta
  const short = path.parse(os.tmpdir()).root + 'L';
  const phone = planDestination({ name: `${'p'.repeat(260)}.cube`, folder: '' }, { lutsDir: short });
  assert.equal(phone.ok, false);
});
