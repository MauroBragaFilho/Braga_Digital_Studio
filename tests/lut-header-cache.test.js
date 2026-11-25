'use strict';

// Lista de LUTs com tipo, tamanho e título lidos do cabeçalho curto (primeiros 8 KB, em cache), sem interpretar a
// tabela inteira; e o resumo da coleção + "Restaurar LUTs padrão" das Configurações. Tudo em pastas de os.tmpdir().

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LutManager = require('../src/core/luts/LutManager');
const CubeParser = require('../src/core/luts/CubeParser');
const { cube3d, cube1d } = require('./helpers/cube-fixtures');
const { budget } = require('./helpers/timing');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-lut-s6-'));
  const lutsDir = path.join(root, 'luts');
  fs.mkdirSync(lutsDir);
  const mgr = new LutManager(lutsDir);
  t.after(async () => {
    await mgr._hashFill;
    if (mgr._persistTimer) clearTimeout(mgr._persistTimer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, lutsDir, mgr };
}
const put = (dir, name, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};
const byName = (items) => Object.fromEntries(items.map((i) => [i.relPath, i]));

// ─── cabeçalho curto na lista ─────────────────────────────────────────────────────────────────────

test('lista: cada LUT traz kind, lutSize e title do cabeçalho (3D, 1D, sem título, tabela quebrada, sem tamanho)', (t) => {
  const { lutsDir, mgr } = setup(t);
  put(lutsDir, 'tres.cube', cube3d(5, { title: 'Filme' }));
  put(lutsDir, 'um.cube', cube1d(16));
  put(lutsDir, 'sem-titulo.cube', cube3d(2, { title: null }));
  put(lutsDir, 'quebrada.cube', 'TITLE "Q"\nLUT_3D_SIZE 9\n0 0 0\n'); // cabeçalho bom, tabela ruim: a lista não sabe (a tela recusa ao abrir)
  put(lutsDir, 'sem-tamanho.cube', 'TITLE "x"\n0 0 0\n');
  put(lutsDir, 'binaria.cube', Buffer.from([0x4c, 0x55, 0x00, 0x01]));
  const items = byName(mgr.list());
  assert.deepEqual([items['tres.cube'].kind, items['tres.cube'].lutSize, items['tres.cube'].title], ['3D', 5, 'Filme']);
  assert.deepEqual([items['um.cube'].kind, items['um.cube'].lutSize, items['um.cube'].title], ['1D', 16, null]);
  assert.deepEqual([items['sem-titulo.cube'].kind, items['sem-titulo.cube'].lutSize, items['sem-titulo.cube'].title], ['3D', 2, null]);
  assert.deepEqual([items['quebrada.cube'].kind, items['quebrada.cube'].lutSize, items['quebrada.cube'].title], ['3D', 9, 'Q']);
  assert.deepEqual([items['sem-tamanho.cube'].kind, items['sem-tamanho.cube'].lutSize], [null, null]);
  assert.deepEqual([items['binaria.cube'].kind, items['binaria.cube'].lutSize, items['binaria.cube'].title], [null, null, null]);
});

test('lista: filtrar por tipo não interpreta a tabela (a lista nunca chama o parse completo nem lê o arquivo inteiro)', (t) => {
  const { lutsDir, mgr } = setup(t);
  for (let i = 0; i < 6; i++) put(lutsDir, `l${i}.cube`, cube3d(9, { tint: i / 100 }));
  const whole = mock.method(fs, 'readFileSync');
  const parse = mock.method(CubeParser, 'parse');
  try {
    const items = mgr.list();
    assert.equal(items.filter((i) => i.kind === '3D').length, 6);
    assert.equal(parse.mock.calls.length, 0);
    assert.equal(whole.mock.calls.filter((c) => String(c.arguments[0]).endsWith('.cube')).length, 0, 'nenhum .cube lido inteiro');
  } finally { whole.mock.restore(); parse.mock.restore(); }
});

test('cache do cabeçalho: segunda listagem não abre nenhum arquivo; mudou tamanho ou data, lê só esse; sobrevive a reabrir o app', (t) => {
  const { lutsDir, mgr } = setup(t);
  put(lutsDir, 'a.cube', cube3d(5, { title: 'A' }));
  const b = put(lutsDir, 'b.cube', cube3d(5, { title: 'B' }));
  mgr.list();
  const open = mock.method(fs, 'openSync');
  try {
    mgr.list();
    assert.equal(open.mock.calls.filter((c) => String(c.arguments[0]).endsWith('.cube')).length, 0, 'cache quente: nada aberto');

    put(lutsDir, 'b.cube', cube3d(7, { title: 'B2' })); // tamanho diferente
    const again = byName(mgr.list());
    assert.deepEqual([again['b.cube'].kind, again['b.cube'].lutSize, again['b.cube'].title], ['3D', 7, 'B2']);
    assert.equal(open.mock.calls.filter((c) => String(c.arguments[0]).endsWith('.cube')).length, 1, 'só o alterado foi relido');
    assert.ok(b);
  } finally { open.mock.restore(); }

  mgr.flushHashCache();
  const saved = JSON.parse(fs.readFileSync(path.join(lutsDir, '.hash-cache.json'), 'utf-8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(Object.keys(saved.headers).sort(), ['a.cube', 'b.cube']);

  const reopened = new LutManager(lutsDir);
  const spy = mock.method(fs, 'openSync');
  try {
    const items = byName(reopened.list());
    assert.equal(items['a.cube'].title, 'A');
    assert.equal(spy.mock.calls.filter((c) => String(c.arguments[0]).endsWith('.cube')).length, 0, 'reabriu o app: cabeçalhos vêm do disco de cache');
  } finally { spy.mock.restore(); }
});

test('cache do cabeçalho: entradas inválidas do arquivo de cache são descartadas e o que sumiu da pasta sai do cache', (t) => {
  const { lutsDir, mgr } = setup(t);
  put(lutsDir, 'a.cube', cube3d(3, { title: 'A' }));
  fs.writeFileSync(path.join(lutsDir, '.hash-cache.json'), JSON.stringify({
    version: 1,
    entries: {},
    headers: { 'a.cube': { key: 'x:y', kind: '9D', lutSize: -4, title: 42 }, 'fantasma.cube': { key: '1:1', kind: '3D', lutSize: 2, title: 't' }, 'lixo.cube': 7 }
  }));
  const items = byName(mgr.list());
  assert.deepEqual([items['a.cube'].kind, items['a.cube'].lutSize, items['a.cube'].title], ['3D', 3, 'A'], 'chave não bate: relê o arquivo');
  mgr.flushHashCache();
  const saved = JSON.parse(fs.readFileSync(path.join(lutsDir, '.hash-cache.json'), 'utf-8'));
  assert.deepEqual(Object.keys(saved.headers), ['a.cube']);
});

test('cache do cabeçalho: o arquivo de cache antigo (só com hashes) continua válido', (t) => {
  const { lutsDir, mgr } = setup(t);
  put(lutsDir, 'a.cube', cube3d(3));
  fs.writeFileSync(path.join(lutsDir, '.hash-cache.json'), JSON.stringify({ version: 1, entries: {} }));
  assert.equal(mgr.list()[0].kind, '3D');
});

test('desempenho: 365 LUTs na primeira listagem (frio) e com cache quente', (t) => {
  const { lutsDir, mgr } = setup(t);
  for (let i = 0; i < 365; i++) put(lutsDir, `Look ${String(i).padStart(3, '0')}.cube`, cube3d(9, { tint: i / 1000 }));
  const t0 = process.hrtime.bigint();
  const cold = mgr.list();
  const coldMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  mgr.list();
  const hotMs = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.equal(cold.length, 365);
  assert.ok(cold.every((i) => i.kind === '3D' && i.lutSize === 9));
  // Limites absolutos só pegam regressão grosseira (com folga: a leitura dos cabeçalhos fica várias vezes mais lenta
  // com a máquina sob carga); o que prova o cache é a comparação entre as duas listagens, que acompanha a carga.
  assert.ok(coldMs < budget(6000), `frio: ${coldMs} ms`);
  assert.ok(hotMs < budget(1500), `quente: ${hotMs} ms`);
  assert.ok(hotMs < coldMs / 2, `o cache quente (${hotMs.toFixed(1)} ms) deveria ser bem mais rápido que o frio (${coldMs.toFixed(1)} ms)`);
});

// ─── resumo da coleção (luts:getInfo) ────────────────────────────────────────────────────────────

test('getInfo: pasta, contagem, pastas com LUTs (qualquer nível), avisos', (t) => {
  const { lutsDir, mgr } = setup(t);
  put(lutsDir, 'a.cube', cube3d(2));
  put(lutsDir, 'Filmes/b.cube', cube3d(2, { tint: 0.1 }));
  put(lutsDir, 'Filmes/Noite/c.cube', cube3d(2, { tint: 0.2 }));
  put(lutsDir, 'Filmes/Noite/d.cube', cube3d(2, { tint: 0.3 }));
  put(lutsDir, 'A/B/C/D/funda.cube', cube3d(2, { tint: 0.4 })); // fundo demais: vira aviso

  const info = mgr.getInfo();
  assert.equal(info.folder, lutsDir);
  assert.equal(info.count, 4);
  assert.equal(info.groups, 2, 'Filmes e Filmes/Noite');
  assert.equal(info.problemCount, 1);
  assert.equal(info.problems.length, 1);
  assert.match(info.problems[0].reason, /funda demais/);
  assert.equal('bundledAvailable' in info, false);
});

test('getInfo: pasta de LUTs que ainda não existe é uma coleção vazia, sem aviso', (t) => {
  const { root } = setup(t);
  const mgr = new LutManager(path.join(root, 'ainda-nao'));
  assert.deepEqual(mgr.getInfo(), { folder: path.join(root, 'ainda-nao'), count: 0, groups: 0, problems: [], problemCount: 0 });
});
