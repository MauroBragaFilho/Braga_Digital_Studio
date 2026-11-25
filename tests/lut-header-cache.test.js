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
const logger = require('../src/services/logService');
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

function bundledWith(root, luts) {
  const dir = path.join(root, 'bundled');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, tint] of Object.entries(luts)) fs.writeFileSync(path.join(dir, name), cube3d(2, { tint }));
  return dir;
}

test('getInfo: pasta, contagem, pastas com LUTs (qualquer nível), avisos e LUTs padrão disponíveis', (t) => {
  const { root, lutsDir, mgr } = setup(t);
  put(lutsDir, 'a.cube', cube3d(2));
  put(lutsDir, 'Filmes/b.cube', cube3d(2, { tint: 0.1 }));
  put(lutsDir, 'Filmes/Noite/c.cube', cube3d(2, { tint: 0.2 }));
  put(lutsDir, 'Filmes/Noite/d.cube', cube3d(2, { tint: 0.3 }));
  put(lutsDir, 'A/B/C/D/funda.cube', cube3d(2, { tint: 0.4 })); // fundo demais: vira aviso
  const bundled = bundledWith(root, { 'x.cube': 0.5 });

  const info = mgr.getInfo(bundled);
  assert.equal(info.folder, lutsDir);
  assert.equal(info.count, 4);
  assert.equal(info.groups, 2, 'Filmes e Filmes/Noite');
  assert.equal(info.problemCount, 1);
  assert.equal(info.problems.length, 1);
  assert.match(info.problems[0].reason, /funda demais/);
  assert.equal(info.bundledAvailable, true);

  assert.equal(mgr.getInfo(path.join(root, 'nao-existe')).bundledAvailable, false);
  assert.equal(mgr.getInfo('').bundledAvailable, false);
  assert.equal(mgr.getInfo(undefined).bundledAvailable, false);
});

test('getInfo: pasta de LUTs que ainda não existe é uma coleção vazia, sem aviso', (t) => {
  const { root } = setup(t);
  const mgr = new LutManager(path.join(root, 'ainda-nao'));
  assert.deepEqual(mgr.getInfo(''), { folder: path.join(root, 'ainda-nao'), count: 0, groups: 0, problems: [], problemCount: 0, bundledAvailable: false });
});

// ─── Restaurar LUTs padrão (luts:restoreBundled) ──────────────────────────────────────────────────

const markerOf = (lutsDir) => JSON.parse(fs.readFileSync(path.join(lutsDir, '.bundled-installed.json'), 'utf-8'));
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.part') || n.endsWith('.tmp'));

test('restoreBundled: devolve a LUT padrão que o usuário excluiu e não toca no resto', async (t) => {
  const { root, lutsDir, mgr } = setup(t);
  const bundled = bundledWith(root, { 'x.cube': 0, 'y.cube': 0.2 });
  mgr.ensureBundledLuts(bundled);
  const mine = put(lutsDir, 'minha.cube', cube3d(2, { tint: 0.9 }));
  fs.unlinkSync(path.join(lutsDir, 'x.cube')); // o usuário excluiu
  mgr.ensureBundledLuts(bundled);
  assert.ok(!fs.existsSync(path.join(lutsDir, 'x.cube')), 'a abertura do app não traz de volta');

  const res = await mgr.restoreBundled(bundled);
  assert.deepEqual(res, { restored: 1, alreadyThere: 1, failed: 0, missingSource: false });
  assert.equal(fs.readFileSync(path.join(lutsDir, 'x.cube'), 'utf-8'), cube3d(2, { tint: 0 }), 'byte a byte');
  assert.ok(fs.existsSync(mine));
  assert.deepEqual(markerOf(lutsDir).sort(), ['x.cube', 'y.cube']);
  assert.deepEqual(leftovers(lutsDir), []);

  const again = await mgr.restoreBundled(bundled);
  assert.deepEqual(again, { restored: 0, alreadyThere: 2, failed: 0, missingSource: false }, 'segunda vez: nada a fazer');
});

test('restoreBundled: não sobrescreve a LUT padrão que o usuário editou (mesmo nome, conteúdo diferente)', async (t) => {
  const { root, lutsDir, mgr } = setup(t);
  const bundled = bundledWith(root, { 'x.cube': 0 });
  const edited = put(lutsDir, 'x.cube', cube3d(2, { tint: 0.7 }));
  const before = fs.readFileSync(edited);
  const res = await mgr.restoreBundled(bundled);
  assert.equal(res.restored, 0);
  assert.equal(res.alreadyThere, 1);
  assert.deepEqual(fs.readFileSync(edited), before);
  assert.deepEqual(fs.readdirSync(lutsDir).filter((n) => n.endsWith('.cube')), ['x.cube'], 'nenhuma cópia "(2)" nasceu');
});

test('restoreBundled: não recria a LUT cujo conteúdo já existe em subpasta (renomeada ou movida pelo usuário)', async (t) => {
  const { root, lutsDir, mgr } = setup(t);
  const bundled = bundledWith(root, { 'x.cube': 0, 'y.cube': 0.2 });
  put(lutsDir, 'Meus looks/outro nome.cube', cube3d(2, { tint: 0 })); // mesmo conteúdo de x.cube
  const res = await mgr.restoreBundled(bundled);
  assert.deepEqual(res, { restored: 1, alreadyThere: 1, failed: 0, missingSource: false });
  assert.ok(!fs.existsSync(path.join(lutsDir, 'x.cube')));
  assert.ok(fs.existsSync(path.join(lutsDir, 'y.cube')));
});

test('restoreBundled: nunca apaga nada da coleção (pastas, outros arquivos e LUTs de projeto continuam)', async (t) => {
  const { root, lutsDir, mgr } = setup(t);
  const bundled = bundledWith(root, { 'x.cube': 0 });
  put(lutsDir, 'Pasta/a.cube', cube3d(2, { tint: 0.3 }));
  put(lutsDir, 'Pasta/nota.txt', 'anotação');
  put(lutsDir, 'b.3dl', 'x');
  const snapshot = () => fs.readdirSync(lutsDir, { recursive: true }).sort();
  const before = snapshot();
  await mgr.restoreBundled(bundled);
  for (const name of before) assert.ok(snapshot().includes(name), name);
});

test('restoreBundled: origem ausente avisa no log e devolve missingSource sem criar nada; arquivo ruim não impede os outros', async (t) => {
  const { root, lutsDir, mgr } = setup(t);
  const warn = mock.method(logger, 'warn', () => {});
  try {
    assert.deepEqual(await mgr.restoreBundled(path.join(root, 'nao-existe')), { restored: 0, alreadyThere: 0, failed: 0, missingSource: true });
    assert.deepEqual(await mgr.restoreBundled(''), { restored: 0, alreadyThere: 0, failed: 0, missingSource: true });
    assert.ok(warn.mock.calls.some((c) => c.arguments[0] === 'LutManager:restoreBundled:origem_ausente'));
    assert.deepEqual(fs.readdirSync(lutsDir), []);

    const bundled = bundledWith(root, { 'a.cube': 0, 'b.cube': 0.2 });
    const orig = fs.readFileSync;
    const read = mock.method(fs, 'readFileSync', (p, ...rest) => {
      if (String(p).endsWith(`${path.sep}a.cube`) && String(p).startsWith(bundled)) throw new Error('EBUSY simulado');
      return orig.call(fs, p, ...rest);
    });
    try {
      const res = await mgr.restoreBundled(bundled);
      assert.deepEqual(res, { restored: 1, alreadyThere: 0, failed: 1, missingSource: false });
    } finally { read.mock.restore(); }
    assert.deepEqual(markerOf(lutsDir), ['b.cube'], 'o que falhou fica de fora do marcador');
    assert.deepEqual(leftovers(lutsDir), []);
  } finally { warn.mock.restore(); }
});

test('restoreBundled: usa a trava de escrita (outra operação em andamento recusa com mensagem em português)', async (t) => {
  const { root, mgr } = setup(t);
  const bundled = bundledWith(root, { 'x.cube': 0 });
  let release;
  const holding = mgr.withLock(() => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(() => mgr.restoreBundled(bundled), /outra operação em andamento/);
  release();
  await holding;
  assert.equal((await mgr.restoreBundled(bundled)).restored, 1);
});
