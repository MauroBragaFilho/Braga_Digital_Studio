'use strict';

// A sincronização com o celular e a lista da tela enxergam a MESMA árvore de LUTs (mesma regra: lutTree.walkTree):
// mesmo limite de níveis, só .cube, sem links nem ocultos, e o hash vem do cache do LutManager.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bdsmAuth = require('../src/core/integrations/bdsm/BdsmAuth');
const { BdsmPairing } = require('../src/core/integrations/bdsm/BdsmPairing');
const LutSyncService = require('../src/core/devices/LutSyncService');
const LutManager = require('../src/core/luts/LutManager');
const { createFakePhone } = require('./fixtures/fake-bdsm-phone');
const { cube3d } = require('./helpers/cube-fixtures');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bds-lut-sync-'));

function freshAuth(configDir) {
  return bdsmAuth.init({
    configDir,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`E:${Buffer.from(s).toString('base64')}`),
      decryptString: (b) => Buffer.from(b.toString().slice(2), 'base64').toString()
    },
    hostname: 'TESTE'
  });
}

async function pair(phone) {
  const pairing = new BdsmPairing({ auth: bdsmAuth, pollMs: 15 });
  await new Promise((resolve, reject) => {
    pairing.start('127.0.0.1', phone.port, (e) => { if (e.state === 'APPROVED') resolve(); else if (['DENIED', 'EXPIRED', 'ERROR'].includes(e.state)) reject(new Error(e.state)); })
      .then((r) => { if (r.alreadyPaired) resolve(); }, reject);
  });
}

async function setup(t, { phoneLuts = [] } = {}) {
  const phone = await createFakePhone({ autoDecision: 'approve', luts: phoneLuts });
  t.after(() => phone.close());
  const root = tmpDir();
  freshAuth(path.join(root, 'config'));
  await pair(phone);
  const lutsDir = path.join(root, 'luts');
  fs.mkdirSync(lutsDir, { recursive: true });
  const manager = new LutManager(lutsDir);
  t.after(async () => {
    await manager._hashFill;
    if (manager._persistTimer) clearTimeout(manager._persistTimer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const put = (rel, content = cube3d(2)) => {
    const p = path.join(lutsDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  return { phone, root, lutsDir, manager, put };
}
const planPaths = (plan) => [...plan.upload, ...plan.identical, ...plan.conflict.map((c) => c.local)].map((l) => l.relativePath).sort();

test('a sincronização lista exatamente os mesmos caminhos que a lista da tela (níveis, .3dl, ocultos, temporários, junção)', async (t) => {
  const { phone, root, lutsDir, manager, put } = await setup(t);
  put('raiz.cube', cube3d(2, { tint: 0.1 }));
  put('Looks/um.cube', cube3d(2, { tint: 0.2 }));
  put('Looks/Rush/dois.cube', cube3d(2, { tint: 0.3 }));
  put('Looks/Rush/Sub/tres.cube', cube3d(2, { tint: 0.4 }));
  put('Looks/Rush/Sub/Fundo/quatro.cube', cube3d(2, { tint: 0.5 })); // 5 segmentos: nem a tela nem o celular
  put('Looks/filme.3dl', 'x');
  put('.escondida.cube', cube3d(2, { tint: 0.6 }));
  put('.oculta/x.cube', cube3d(2, { tint: 0.7 }));
  put('Looks/.Look.cube.abcabcabcabc.part', 'x');
  put('MAIÚSCULA.CUBE', cube3d(2, { tint: 0.8 }));
  const outside = path.join(root, 'fora');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'segredo.cube'), cube3d(2, { tint: 0.9 }));
  try { fs.symlinkSync(outside, path.join(lutsDir, 'juncao'), 'junction'); } catch (err) { /* sem permissão: o resto do teste vale igual */ }

  const expected = manager.list().map((l) => l.relPath).sort();
  assert.deepEqual(expected, ['Looks/Rush/Sub/tres.cube', 'Looks/Rush/dois.cube', 'Looks/um.cube', 'MAIÚSCULA.CUBE', 'raiz.cube']);
  for (const svc of [new LutSyncService(lutsDir, { lutManager: manager }), new LutSyncService(lutsDir)]) {
    const plan = await svc.analyzeSync('127.0.0.1', phone.port);
    assert.deepEqual(planPaths(plan), expected, svc.lutManager ? 'com o LutManager (hash em cache)' : 'sem o LutManager (hash local)');
    assert.equal(plan.upload.length, expected.length);
    assert.ok(plan.upload.every((l) => /^[0-9a-f]{64}$/.test(l.hash) && path.isAbsolute(l.absolutePath)));
  }
});

test('cada LUT local é comparada pelo conteúdo: igual, conflito, só no computador e só no celular', async (t) => {
  const same = cube3d(2, { tint: 0.1 });
  const { phone, lutsDir, manager, put } = await setup(t, {
    phoneLuts: [
      { relativePath: 'Looks/igual.cube', content: same },
      { relativePath: 'Looks/Rush/muda.cube', content: cube3d(2, { tint: 0.7 }) },
      { relativePath: 'so-celular.cube', content: cube3d(2, { tint: 0.8 }) }
    ]
  });
  put('Looks/igual.cube', same);
  put('Looks/Rush/muda.cube', cube3d(2, { tint: 0.3 }));
  put('Looks/nova.cube', cube3d(2, { tint: 0.4 }));
  const plan = await new LutSyncService(lutsDir, { lutManager: manager }).analyzeSync('127.0.0.1', phone.port);
  assert.deepEqual(plan.identical.map((l) => l.relativePath), ['Looks/igual.cube']);
  assert.deepEqual(plan.conflict.map((c) => c.local.relativePath), ['Looks/Rush/muda.cube']);
  assert.deepEqual(plan.upload.map((l) => l.relativePath), ['Looks/nova.cube']);
  assert.deepEqual(plan.remoteOnly.map((l) => l.relativePath), ['so-celular.cube']);
});

test('o hash vem do cache do LutManager: a segunda análise não relê nenhuma LUT', async (t) => {
  const { phone, lutsDir, manager, put } = await setup(t);
  for (let i = 0; i < 6; i++) put(`Look ${i % 2}/l${i}.cube`, cube3d(2, { tint: i / 20 }));
  const svc = new LutSyncService(lutsDir, { lutManager: manager });
  await svc.analyzeSync('127.0.0.1', phone.port);
  await manager._hashFill;
  const reads = [];
  const realStream = fs.createReadStream;
  fs.createReadStream = (...args) => { reads.push(String(args[0])); return realStream(...args); };
  try {
    const plan = await svc.analyzeSync('127.0.0.1', phone.port);
    assert.equal(plan.upload.length, 6);
  } finally { fs.createReadStream = realStream; }
  assert.deepEqual(reads, [], 'tudo veio do cache (caminho + tamanho + data)');
});

test('pasta com arquivos demais interrompe a análise com uma mensagem clara (nunca uma lista incompleta)', async (t) => {
  const { phone, lutsDir, put } = await setup(t);
  for (let i = 0; i < 12; i++) put(`P${i}/l${i}.cube`, cube3d(2, { tint: i / 20 }));
  const svc = new LutSyncService(lutsDir, { maxEntries: 8 });
  await assert.rejects(() => svc.analyzeSync('127.0.0.1', phone.port), { message: 'A pasta de LUTs tem arquivos demais para sincronizar.' });
  const ok = await new LutSyncService(lutsDir, { maxEntries: 1000 }).analyzeSync('127.0.0.1', phone.port);
  assert.equal(ok.upload.length, 12);
});

test('a coleção pode ser um atalho (junção): a sincronização e a lista enxergam o mesmo conteúdo', async (t) => {
  const { phone, root, lutsDir, put } = await setup(t);
  put('Looks/a.cube', cube3d(2, { tint: 0.1 }));
  put('b.cube', cube3d(2, { tint: 0.2 }));
  const link = path.join(root, 'colecao-atalho');
  try { fs.symlinkSync(lutsDir, link, 'junction'); } catch (err) { t.skip('o sistema não permite criar links aqui'); return; }
  const manager = new LutManager(link);
  const svc = new LutSyncService(link, { lutManager: manager });
  const plan = await svc.analyzeSync('127.0.0.1', phone.port);
  assert.deepEqual(planPaths(plan), manager.list().map((l) => l.relPath).sort());
  assert.deepEqual(planPaths(plan), ['Looks/a.cube', 'b.cube']);
  await manager._hashFill;
  if (manager._persistTimer) clearTimeout(manager._persistTimer);
});

test('renomear uma pasta no computador muda o caminho que o celular vê (a antiga fica "só no celular")', async (t) => {
  const content = cube3d(2, { tint: 0.1 });
  const { phone, lutsDir, manager, put } = await setup(t, { phoneLuts: [{ relativePath: 'Antiga/a.cube', content }] });
  put('Antiga/a.cube', content);
  const svc = new LutSyncService(lutsDir, { lutManager: manager });
  assert.deepEqual((await svc.analyzeSync('127.0.0.1', phone.port)).identical.map((l) => l.relativePath), ['Antiga/a.cube']);
  await manager._hashFill;
  await manager.renameFolder('Antiga', 'Nova');
  const plan = await svc.analyzeSync('127.0.0.1', phone.port);
  assert.deepEqual(plan.upload.map((l) => l.relativePath), ['Nova/a.cube']);
  assert.deepEqual(plan.remoteOnly.map((l) => l.relativePath), ['Antiga/a.cube']);
});
