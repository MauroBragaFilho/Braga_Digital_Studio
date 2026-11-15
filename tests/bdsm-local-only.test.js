'use strict';

// Item F-35 da análise de conformidade: o celular só existe na rede local (ou no cabo, via 127.0.0.1). Um anúncio mDNS pode trazer
// qualquer endereço (IP público, nome de host); o app manda o token de pareamento e o nome deste computador ao endereço que sondar.
// Aqui: o anúncio com endereço fora da rede local é ignorado e o cliente nunca faz um pedido para outro endereço.

const test = require('node:test');
const assert = require('node:assert/strict');

const discovery = require('../src/core/devices/DeviceDiscoveryService');
const BdsmClient = require('../src/core/integrations/bdsm/BdsmClient');
const { BdsmAuth } = require('../src/core/integrations/bdsm/BdsmAuth');
const { probeInfo } = require('../src/core/integrations/bdsm/BdsmPairing');

const { BdsmError } = BdsmClient;

const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });

/** Troca o fetch por um que só anota os pedidos (nada sai do computador). */
function stubFetch(t, reply) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), headers: { ...((init && init.headers) || {}) } }); return reply(url, init); };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const OUTSIDE = ['203.0.113.5', '8.8.8.8', '0.0.0.0', 'evil.example.com', 'phone.local', '[2001:db8::1]'];
const LOCAL = ['192.168.15.4', '10.0.0.7', '172.20.10.2', '127.0.0.1', '169.254.3.4', '[fe80::1]', '[fd00::5]'];

test('mDNS: só serve endereço da rede local (IP público, nome de host e IPv6 global são descartados)', () => {
  const pick = (service) => discovery._extractBestIp(service);
  assert.equal(pick({ addresses: ['203.0.113.5'] }), null, 'IP público');
  assert.equal(pick({ addresses: ['8.8.8.8', '192.168.15.4'] }), '192.168.15.4', 'entre vários, só o da rede local');
  assert.equal(pick({ host: 'evil.example.com' }), null, 'nome de host: a resolução poderia sair da rede local');
  assert.equal(pick({ host: 'Scorpio.local' }), null);
  assert.equal(pick({ addresses: ['2001:db8::1'] }), null, 'IPv6 global');
  assert.equal(pick({ addresses: ['fe80::1'] }), '[fe80::1]', 'IPv6 link-local, entre colchetes para a URL');
  assert.equal(pick({ addresses: ['fd00::5'] }), '[fd00::5]', 'IPv6 ULA');
  assert.equal(pick({ referer: { address: '203.0.113.9' } }), null, 'origem pública');
  assert.equal(pick({ referer: { address: '10.0.0.7' } }), '10.0.0.7');
  assert.equal(pick({ host: '192.168.0.9' }), '192.168.0.9', 'IP literal da rede local no campo host');
  assert.equal(pick({ addresses: ['127.0.0.1'] }), null, 'o cabo (127.0.0.1) não vem do mDNS');
  assert.equal(pick({ addresses: ['::1', '[::1]'] }), null);
  assert.equal(pick(null), null);
});

test('mDNS: anúncio com endereço fora da rede local nunca é sondado', (t) => {
  const probed = [];
  const original = discovery.probeDevice;
  discovery.probeDevice = (...args) => { probed.push(args.slice(0, 3)); return Promise.resolve(); };
  t.after(() => { discovery.probeDevice = original; });

  discovery._onMdnsService({ name: 'Scorpio', port: 8080, addresses: ['203.0.113.5'], host: 'evil.example.com' });
  discovery._onMdnsService({ name: 'Scorpio', port: 8080, addresses: ['192.168.15.4'] });
  assert.deepEqual(probed, [['192.168.15.4', 8080, 'wifi']]);
});

test('cliente do celular: nenhum pedido (nem token, nem nome do computador) sai para endereço fora da rede local', async (t) => {
  const calls = stubFetch(t, async () => json({ deviceName: 'Scorpio', deviceModel: 'X1', authRequired: true }));
  const refused = (e) => e instanceof BdsmError && e.code === 'DEVICE_UNREACHABLE';
  for (const host of OUTSIDE) {
    const client = new BdsmClient(host, 8080, { token: 'segredo' });
    await assert.rejects(client.getInfo(true), refused, `${host}: informações`);
    await assert.rejects(client.getInfo(true, 1000, false), refused, `${host}: informações sem token`);
    await assert.rejects(client.requestPairing({ clientId: 'abc-123', clientName: 'Braga Digital Studio - PC' }), refused, `${host}: pareamento`);
    await assert.rejects(client.getMedia(), refused, `${host}: lista de mídias`);
  }
  assert.equal(calls.length, 0, 'nada saiu do computador');
});

test('cliente do celular: rede local, link-local e o cabo (127.0.0.1) continuam funcionando, com o token', async (t) => {
  const calls = stubFetch(t, async () => json({ deviceName: 'Scorpio', deviceModel: 'X1', authRequired: true }));
  for (const host of LOCAL) {
    const info = await new BdsmClient(host, 8080, { token: 'segredo' }).getInfo(true);
    assert.equal(info.deviceName, 'Scorpio', host);
  }
  assert.equal(calls.length, LOCAL.length);
  assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer segredo'));
});

test('sondagem de endereço fora da rede local: falha sem registrar o endereço e sem usar o token guardado', async (t) => {
  const calls = stubFetch(t, async () => json({ deviceName: 'Scorpio', deviceModel: 'X1', authRequired: true }));
  const auth = new BdsmAuth();
  auth.saveToken('Scorpio|X1', 'segredo');
  for (const host of OUTSIDE) {
    await assert.rejects(probeInfo(host, 8080, { auth }), (e) => e instanceof BdsmError && e.code === 'DEVICE_UNREACHABLE', host);
    assert.equal(auth.keyForEndpoint(host, 8080), null, `${host}: o endereço não vira "o celular pareado"`);
  }
  assert.equal(calls.length, 0);
  assert.equal(auth.getToken('Scorpio|X1'), 'segredo', 'o pareamento guardado continua intacto');
});
