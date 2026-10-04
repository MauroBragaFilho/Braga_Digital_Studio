'use strict';

// Cliente do celular com autenticação (Authorization: Bearer) ponta a ponta contra o celular falso:
// listar/baixar/apagar mídia, miniatura, LUTs (listar, enviar, 409, apagar), sincronização de LUTs,
// importação pelo provedor, 401 e a descoberta marcando paired/authRequired sem duplicar cartões.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const bdsmAuth = require('../src/core/integrations/bdsm/BdsmAuth');
const { BdsmPairing } = require('../src/core/integrations/bdsm/BdsmPairing');
const BdsmClient = require('../src/core/integrations/bdsm/BdsmClient');
const BdsmProtocol = require('../src/core/integrations/bdsm/BdsmProtocol');
const { BdsmDeviceProvider } = require('../src/core/integrations/bdsm/BdsmDeviceProvider');
const LutSyncService = require('../src/core/devices/LutSyncService');
const discovery = require('../src/core/devices/DeviceDiscoveryService');
const { createFakePhone, parseRange } = require('./fixtures/fake-bdsm-phone');

const KEY = 'Scorpio|SM-A515F';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bdsm-auth-'));

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`E:${Buffer.from(s).toString('base64')}`),
    decryptString: (b) => Buffer.from(b.toString().slice(2), 'base64').toString()
  };
}

/** Reinicia o singleton do app (como o startup faz) numa pasta nova. */
function freshAuth() {
  return bdsmAuth.init({ configDir: tmpDir(), safeStorage: fakeSafeStorage(), hostname: 'TESTE' });
}

async function pair(phone) {
  const pairing = new BdsmPairing({ auth: bdsmAuth, pollMs: 15 });
  await new Promise((resolve, reject) => {
    pairing.start('127.0.0.1', phone.port, (e) => { if (e.state === 'APPROVED') resolve(); else if (['DENIED', 'EXPIRED', 'ERROR'].includes(e.state)) reject(new Error(e.state)); })
      .then((r) => { if (r.alreadyPaired) resolve(); }, reject);
  });
}

const MEDIA = [
  { id: 'rec-001', filename: 'VID_20261001_120000.mp4', content: Buffer.alloc(5000, 3), duration: 31.2 },
  { id: 'rec-002', filename: 'VID_20261001_121500.mp4', content: Buffer.alloc(2048, 5) }
];
const CUBE = (n) => `TITLE "${n}"\nLUT_3D_SIZE 2\n0 0 0\n1 1 1\n`;

test('protocolo: endpoints reais, caminho de LUT em segmentos e nada de cabeçalhos X-BDSM-*', () => {
  const E = BdsmProtocol.ENDPOINTS;
  assert.equal(E.LUTS_DELETE('Filmes/Sub pasta/a b.cube'), '/luts/Filmes/Sub%20pasta/a%20b.cube');
  assert.equal(E.MEDIA_DOWNLOAD('a/b'), '/media/a%2Fb/download');
  assert.equal(E.DISCOVERY_INFO, '/discovery/info');
  assert.equal('LUTS_DOWNLOAD' in E, false, 'o celular não tem download de LUT');
  assert.deepEqual(BdsmProtocol.buildHeaders(), { Accept: 'application/json' });
  const item = BdsmProtocol.normalizeMediaItem({ id: 'x', filename: 'a.mp4', filesize: 10, duration: 2.5, width: 1920, height: 1080, fps: 30, codec: 'h264', createdAt: '2026-10-01T12:00:00Z' });
  assert.deepEqual({ id: item.id, name: item.name, size: item.size, duration: item.duration }, { id: 'x', name: 'a.mp4', size: 10, duration: 2.5 });
  assert.equal(BdsmProtocol.normalizeMediaItem({ id: 'x' }), null);
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
});

test('sem pareamento: mídia e LUTs respondem 401 -> PAIRING_REQUIRED (nada de "HTTP 401" genérico)', async (t) => {
  const phone = await createFakePhone({ media: MEDIA });
  t.after(() => phone.close());
  freshAuth();
  const client = new BdsmClient('127.0.0.1', phone.port);
  for (const call of [() => client.getMedia(), () => client.getLuts(), () => client.deleteMedia('rec-001'), () => client.openMediaDownload('rec-001'), () => client.getThumbnail('rec-001')]) {
    await assert.rejects(call, (e) => e.code === 'PAIRING_REQUIRED' && e.status === 401 && !/HTTP/.test(e.message));
  }
  assert.equal(phone.media.size, 2, 'nada foi apagado sem autorização');
});

test('com pareamento: todas as chamadas levam o Bearer e o celular as aceita', async (t) => {
  const phone = await createFakePhone({ media: MEDIA, luts: [{ relativePath: 'Remota/x.cube', content: CUBE('x') }], autoDecision: 'approve' });
  t.after(() => phone.close());
  freshAuth();
  await pair(phone);
  assert.ok(bdsmAuth.getToken(KEY));
  const client = new BdsmClient('127.0.0.1', phone.port);
  assert.equal(client.hasToken, true);
  phone.log.length = 0;

  const media = await client.getMedia();
  assert.deepEqual(media.map((m) => [m.id, m.name, m.size]), [['rec-001', 'VID_20261001_120000.mp4', 5000], ['rec-002', 'VID_20261001_121500.mp4', 2048]]);
  assert.equal(media[0].duration, 31.2);
  assert.equal(media[0].codec, 'h264');

  const luts = await client.getLuts();
  assert.deepEqual(luts, [{ name: 'x.cube', relativePath: 'Remota/x.cube', size: Buffer.byteLength(CUBE('x')), hash: sha256(CUBE('x')) }]);

  const thumb = await client.getThumbnail('rec-001');
  assert.equal(thumb.contentType, 'image/jpeg');
  assert.ok(thumb.buffer.length > 10);

  // download com Content-Length e retomada por Range
  const full = await client.openMediaDownload('rec-001');
  assert.equal(full.status, 200);
  assert.equal(Number(full.headers.get('content-length')), 5000);
  assert.equal((await full.arrayBuffer()).byteLength, 5000);
  const part = await client.openMediaDownload('rec-001', { range: 'bytes=4000-' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 4000-4999/5000');
  assert.equal((await part.arrayBuffer()).byteLength, 1000);

  await client.deleteMedia('rec-002');
  assert.equal(phone.media.has('rec-002'), false);
  await assert.rejects(() => client.deleteMedia('rec-002'), (e) => e.code === 'NOT_FOUND' && e.status === 404);

  assert.equal(phone.log.length, 7);
  assert.ok(phone.log.every((l) => l.authorized), 'toda requisição estava autorizada');
});

test('LUTs: envio multipart, repetição idêntica, conflito 409 e remoção por segmentos', async (t) => {
  const phone = await createFakePhone({ autoDecision: 'approve' });
  t.after(() => phone.close());
  freshAuth();
  await pair(phone);
  const client = new BdsmClient('127.0.0.1', phone.port);
  const dir = tmpDir();
  const local = path.join(dir, 'look.cube');
  fs.writeFileSync(local, CUBE('look'));

  await client.uploadLut(local, 'Cinema/Sub/look.cube');
  assert.equal(phone.luts.get('Cinema/Sub/look.cube').toString(), CUBE('look'));
  await client.uploadLut(local, 'Cinema/Sub/look.cube'); // mesmo conteúdo: ok

  fs.writeFileSync(local, CUBE('look-v2'));
  await assert.rejects(() => client.uploadLut(local, 'Cinema/Sub/look.cube'), (e) => {
    assert.equal(e.code, 'CONFLICT');
    assert.equal(e.status, 409);
    assert.equal(e.details.relativePath, 'Cinema/Sub/look.cube');
    assert.equal(e.details.newHash, sha256(CUBE('look-v2')));
    return true;
  });
  await assert.rejects(() => client.uploadLut(local, '../fora.cube'), (e) => e.code === 'BAD_REQUEST');
  await assert.rejects(() => client.uploadLut(local, 'sem-extensao.txt'), (e) => e.code === 'BAD_REQUEST');

  await client.deleteLut('Cinema/Sub/look.cube');
  assert.equal(phone.luts.size, 0);
  await assert.rejects(() => client.deleteLut('Cinema/Sub/look.cube'), (e) => e.code === 'NOT_FOUND');
});

test('upload de LUT maior que o teto do celular: 413 vira TOO_LARGE', async (t) => {
  const phone = await createFakePhone({ autoDecision: 'approve', lutMaxUploadBytes: 1000 });
  t.after(() => phone.close());
  freshAuth();
  await pair(phone);
  const client = new BdsmClient('127.0.0.1', phone.port);
  const big = path.join(tmpDir(), 'big.cube');
  fs.writeFileSync(big, 'x'.repeat(5000));
  await assert.rejects(() => client.uploadLut(big, 'big.cube'), (e) => e.code === 'TOO_LARGE' && e.status === 413);
});

test('sincronização de LUTs ponta a ponta: envia as novas, lista as só-do-celular e só substitui conflitos se pedido', async (t) => {
  const phone = await createFakePhone({
    autoDecision: 'approve',
    luts: [
      { relativePath: 'Sub/b.cube', content: CUBE('b-celular') },
      { relativePath: 'c.cube', content: CUBE('c') },
      { relativePath: 'so-celular.cube', content: CUBE('so') }
    ]
  });
  t.after(() => phone.close());
  freshAuth();
  const lutsDir = tmpDir();
  fs.mkdirSync(path.join(lutsDir, 'Sub'));
  fs.writeFileSync(path.join(lutsDir, 'a.cube'), CUBE('a'));
  fs.writeFileSync(path.join(lutsDir, 'Sub', 'b.cube'), CUBE('b-pc'));
  fs.writeFileSync(path.join(lutsDir, 'c.cube'), CUBE('c'));
  fs.writeFileSync(path.join(lutsDir, 'film.3dl'), 'ignorado'); // o celular só aceita .cube
  const svc = new LutSyncService(lutsDir);

  // sem pareamento: o motivo real chega (não "Falha ao conectar")
  await assert.rejects(() => svc.analyzeSync('127.0.0.1', phone.port), (e) => e.code === 'PAIRING_REQUIRED');

  await pair(phone);
  const plan = await svc.analyzeSync('127.0.0.1', phone.port);
  assert.deepEqual(plan.upload.map((l) => l.relativePath), ['a.cube']);
  assert.deepEqual(plan.identical.map((l) => l.relativePath), ['c.cube']);
  assert.deepEqual(plan.conflict.map((c) => c.local.relativePath), ['Sub/b.cube']);
  assert.deepEqual(plan.remoteOnly.map((l) => l.relativePath), ['so-celular.cube']);
  assert.deepEqual(plan.download, [], 'o celular não serve LUTs');

  // sem resolução, o conflito fica como está
  const progress = [];
  svc.on('progress', (p) => progress.push(p));
  let result = await svc.executeSync('127.0.0.1', phone.port, plan);
  assert.deepEqual(result, { completed: 1, failed: 0, skipped: 1, total: 1 });
  assert.equal(phone.luts.get('a.cube').toString(), CUBE('a'));
  assert.equal(phone.luts.get('Sub/b.cube').toString(), CUBE('b-celular'));
  assert.ok(progress.some((p) => /Enviando: a\.cube/.test(p.current)));

  // sobrescrever o do celular: apaga e envia de novo (o celular recusa sobrescrever com 409)
  plan.conflict.forEach((c) => { c.resolution = 'overwrite_remote'; });
  plan.upload = [];
  result = await svc.executeSync('127.0.0.1', phone.port, plan);
  assert.deepEqual(result, { completed: 1, failed: 0, skipped: 0, total: 1 });
  assert.equal(phone.luts.get('Sub/b.cube').toString(), CUBE('b-pc'));
  assert.equal(phone.luts.get('so-celular.cube').toString(), CUBE('so'), 'o que só existe no celular não é tocado');
});

test('pareamento revogado no meio da sincronização interrompe com PAIRING_REQUIRED', async (t) => {
  const phone = await createFakePhone({ autoDecision: 'approve' });
  t.after(() => phone.close());
  freshAuth();
  await pair(phone);
  const lutsDir = tmpDir();
  fs.writeFileSync(path.join(lutsDir, 'a.cube'), CUBE('a'));
  fs.writeFileSync(path.join(lutsDir, 'b.cube'), CUBE('b'));
  const svc = new LutSyncService(lutsDir);
  const plan = await svc.analyzeSync('127.0.0.1', phone.port);
  phone.revokeAll();
  await assert.rejects(() => svc.executeSync('127.0.0.1', phone.port, plan), (e) => e.code === 'PAIRING_REQUIRED');
  assert.equal(bdsmAuth.getToken(KEY), null);
});

test('importação de mídia pelo provedor usa o token e entrega o arquivo inteiro', async (t) => {
  const phone = await createFakePhone({ media: MEDIA, autoDecision: 'approve' });
  t.after(() => phone.close());
  freshAuth();
  const device = { id: 'Scorpio_usb', ip: '127.0.0.1', port: phone.port, name: 'Scorpio', connection: 'usb' };
  const provider = new BdsmDeviceProvider({ getDevices: () => [device] });
  const dest = tmpDir();

  assert.equal(await provider.importItems('Scorpio_usb', [], ['rec-001'], dest), false, 'sem pareamento não importa');
  assert.deepEqual(fs.readdirSync(dest), []);

  await pair(phone);
  const list = await provider.listFolder('Scorpio_usb');
  assert.equal(list.success, true);
  assert.deepEqual(list.items.map((i) => [i.id, i.name, i.size]), [['rec-001', 'VID_20261001_120000.mp4', 5000], ['rec-002', 'VID_20261001_121500.mp4', 2048]]);
  assert.ok(list.items.every((i) => !('downloadUrl' in i) && !('thumbnailUrl' in i)), 'nenhuma URL (nem token) sai do provedor');

  const progress = [];
  provider.on('progress', (p) => progress.push(p));
  assert.equal(await provider.importItems('Scorpio_usb', [], ['rec-001', { id: 'rec-002' }], dest), true);
  assert.equal(fs.statSync(path.join(dest, 'VID_20261001_120000.mp4')).size, 5000);
  assert.equal(fs.readFileSync(path.join(dest, 'VID_20261001_121500.mp4')).equals(Buffer.alloc(2048, 5)), true);
  assert.equal(progress.at(-1).percent, 100);
});

test('descoberta: marca authRequired/paired, mostra bateria só depois de parear e não duplica cartões', async (t) => {
  const phone = await createFakePhone({ media: MEDIA, autoDecision: 'approve' });
  t.after(() => phone.close());
  freshAuth();
  process.env.BDS_TEST_BDSM_PORT = String(phone.port);
  t.after(() => { delete process.env.BDS_TEST_BDSM_PORT; discovery.devices.clear(); });
  discovery.devices.clear();
  const events = [];
  const onAdded = (d) => events.push(['added', d.paired]);
  const onUpdated = (d) => events.push(['updated', d.paired]);
  discovery.on('device_added', onAdded);
  discovery.on('device_updated', onUpdated);
  t.after(() => { discovery.off('device_added', onAdded); discovery.off('device_updated', onUpdated); });

  await discovery.pollAllDevices(); // sondagem "USB" aponta para o celular falso
  let [dev] = discovery.getDevices();
  assert.equal(discovery.getDevices().length, 1);
  assert.equal(dev.connection, 'usb');
  assert.equal(dev.port, phone.port);
  assert.equal(dev.paired, false);
  assert.equal(dev.authRequired, true);
  assert.equal(dev.battery, null, 'sem pareamento não há bateria (e não se inventa 100%)');
  assert.equal(dev.physicalId, KEY);
  const firstId = dev.id;
  assert.equal(firstId, 'Scorpio_usb', 'o id do cartão (histórico de importação) não mudou');

  await pair(phone);
  await discovery.refreshEndpoint('127.0.0.1', phone.port);
  [dev] = discovery.getDevices();
  assert.equal(discovery.devices.size, 1, 'continua um único aparelho');
  assert.equal(dev.id, firstId);
  assert.equal(dev.paired, true);
  assert.equal(dev.battery, 87);
  assert.ok(dev.storage_total > 0 && dev.storage_free > 0);
  assert.ok(!JSON.stringify(dev).includes(bdsmAuth.getToken(KEY)), 'o objeto que vai ao renderer não tem token');
  assert.deepEqual(events, [['added', false], ['updated', true]]);

  // o mesmo aparelho por Wi-Fi fica oculto enquanto houver USB (regra "USB tem prioridade")
  discovery.registerDevice({ id: 'Scorpio_wifi', physicalId: KEY, connection: 'wifi', name: 'Scorpio', ip: '192.168.0.9', port: 8080, last_seen: Date.now() });
  assert.deepEqual(discovery.getDevices().map((d) => d.id), ['Scorpio_usb']);
});

test('porta de teste só vale fora do app empacotado e com número válido', () => {
  const { testBdsmPort } = discovery;
  const old = process.env.BDS_TEST_BDSM_PORT;
  try {
    process.env.BDS_TEST_BDSM_PORT = '19999';
    assert.equal(testBdsmPort(), 19999);
    process.env.BDS_TEST_BDSM_PORT = 'abc';
    assert.equal(testBdsmPort(), null);
    process.env.BDS_TEST_BDSM_PORT = '70000';
    assert.equal(testBdsmPort(), null);
    delete process.env.BDS_TEST_BDSM_PORT;
    assert.equal(testBdsmPort(), null);
  } finally {
    if (old === undefined) delete process.env.BDS_TEST_BDSM_PORT; else process.env.BDS_TEST_BDSM_PORT = old;
  }
});
