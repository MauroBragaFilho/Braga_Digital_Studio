'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProbeCache } = require('../src/core/ffmpeg/ProbeCache');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-probecache-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeFile(name, content = 'abc') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

test('segunda chamada vem do cache (loader roda uma vez)', async () => {
  const cache = new ProbeCache();
  const f = makeFile('a.bin');
  let calls = 0;
  const loader = async () => { calls++; return { duration: 12 }; };
  assert.deepStrictEqual(await cache.getOrLoad(f, loader), { duration: 12 });
  assert.deepStrictEqual(await cache.getOrLoad(f, loader), { duration: 12 });
  assert.strictEqual(calls, 1);
  assert.strictEqual(cache.hits, 1);
});

test('chamadas concorrentes são deduplicadas', async () => {
  const cache = new ProbeCache();
  const f = makeFile('b.bin');
  let calls = 0;
  const loader = () => new Promise((r) => { calls++; setTimeout(() => r({ ok: true }), 30); });
  const results = await Promise.all([1, 2, 3, 4].map(() => cache.getOrLoad(f, loader)));
  assert.strictEqual(calls, 1);
  assert.ok(results.every((r) => r.ok));
});

test('alterar tamanho ou mtime invalida a entrada', async () => {
  const cache = new ProbeCache();
  const f = makeFile('c.bin', 'abc');
  let calls = 0;
  const loader = async () => ({ n: ++calls });
  assert.strictEqual((await cache.getOrLoad(f, loader)).n, 1);
  fs.writeFileSync(f, 'abcdef'); // tamanho diferente
  assert.strictEqual((await cache.getOrLoad(f, loader)).n, 2);
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(f, future, future); // mesmo tamanho, mtime diferente
  assert.strictEqual((await cache.getOrLoad(f, loader)).n, 3);
});

test('variantes diferentes não compartilham resultado', async () => {
  const cache = new ProbeCache();
  const f = makeFile('d.bin');
  assert.strictEqual(await cache.getOrLoad(f, async () => 'A', 'v1'), 'A');
  assert.strictEqual(await cache.getOrLoad(f, async () => 'B', 'v2'), 'B');
  assert.strictEqual(await cache.getOrLoad(f, async () => 'X', 'v1'), 'A');
});

test('falhas não ficam em cache', async () => {
  const cache = new ProbeCache();
  const f = makeFile('e.bin');
  let calls = 0;
  await assert.rejects(cache.getOrLoad(f, async () => { calls++; throw new Error('ffprobe falhou'); }), /ffprobe falhou/);
  assert.strictEqual(await cache.getOrLoad(f, async () => { calls++; return 'ok'; }), 'ok');
  assert.strictEqual(calls, 2);
  assert.strictEqual(cache.size, 1);
});

test('LRU descarta o menos recente acima do limite', async () => {
  const cache = new ProbeCache({ max: 3 });
  const files = ['1', '2', '3', '4'].map((n) => makeFile(`lru${n}.bin`));
  const loads = {};
  const loaderFor = (f) => async () => { loads[f] = (loads[f] || 0) + 1; return f; };
  for (const f of files.slice(0, 3)) await cache.getOrLoad(f, loaderFor(f));
  await cache.getOrLoad(files[0], loaderFor(files[0])); // 1 vira o mais recente
  await cache.getOrLoad(files[3], loaderFor(files[3])); // entra o 4 => expulsa o 2
  assert.strictEqual(cache.size, 3);
  await cache.getOrLoad(files[0], loaderFor(files[0]));
  await cache.getOrLoad(files[1], loaderFor(files[1]));
  assert.strictEqual(loads[files[0]], 1, 'arquivo 1 deveria continuar em cache');
  assert.strictEqual(loads[files[1]], 2, 'arquivo 2 deveria ter sido expulso');
});

test('o resultado devolvido é uma cópia (mutar não contamina o cache)', async () => {
  const cache = new ProbeCache();
  const f = makeFile('g.bin');
  const first = await cache.getOrLoad(f, async () => ({ streams: [1, 2] }));
  first.streams.push(99);
  const second = await cache.getOrLoad(f, async () => ({ streams: ['novo'] }));
  assert.deepStrictEqual(second.streams, [1, 2]);
});

test('arquivo inexistente: sem cache, o loader decide o erro', async () => {
  const cache = new ProbeCache();
  await assert.rejects(cache.getOrLoad(path.join(dir, 'nao-existe.bin'), async () => { throw new Error('sem arquivo'); }), /sem arquivo/);
  assert.strictEqual(cache.size, 0);
});
