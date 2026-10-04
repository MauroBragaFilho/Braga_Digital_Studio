'use strict';

// Pareamento com o celular (BDS Mobile): código, aprovação/recusa/expiração, 429, token criptografado e
// reaproveitado, 401 com token inválido, token fora do log e do que vai ao renderer. Usa o celular falso
// (tests/fixtures/fake-bdsm-phone.js), que segue o contrato lido do código Kotlin do app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const logger = require('../src/services/logService');
const { BdsmAuth, MAX_CLIENT_NAME } = require('../src/core/integrations/bdsm/BdsmAuth');
const { BdsmPairing, probeInfo } = require('../src/core/integrations/bdsm/BdsmPairing');
const BdsmClient = require('../src/core/integrations/bdsm/BdsmClient');
const { createFakePhone } = require('./fixtures/fake-bdsm-phone');

/** safeStorage de mentira: "criptografa" de forma reversível, sem deixar o texto original à vista. */
function fakeSafeStorage({ available = true } = {}) {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.concat([Buffer.from('ENC1'), Buffer.from(s, 'utf8').map((b, i) => b ^ key[i % key.length])]),
    decryptString: (buf) => {
      if (buf.subarray(0, 4).toString() !== 'ENC1') throw new Error('formato');
      return Buffer.from(buf.subarray(4).map((b, i) => b ^ key[i % key.length])).toString('utf8');
    }
  };
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bdsm-pair-')); }

function captureLogs() {
  const lines = [];
  const orig = {};
  for (const lvl of ['error', 'warn', 'info', 'debug', 'verbose']) {
    orig[lvl] = logger[lvl];
    logger[lvl] = (...args) => { lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  }
  return { lines, restore() { for (const lvl of Object.keys(orig)) logger[lvl] = orig[lvl]; } };
}

/** Inicia o pareamento e espera o estado final (APPROVED/DENIED/EXPIRED/ERROR). */
async function pairAndWait(pairing, phone) {
  const events = [];
  const final = new Promise((resolve) => {
    const emit = (e) => { events.push(e); if (['APPROVED', 'DENIED', 'EXPIRED', 'ERROR'].includes(e.state)) resolve(e); };
    pairing.start('127.0.0.1', phone.port, emit).then((started) => { events.started = started; });
  });
  const last = await final;
  return { events, last };
}

const MEDIA = [{ id: 'rec-1', filename: 'VID_1.mp4', content: Buffer.alloc(1000, 1) }];

test('clientId é gerado uma vez e permanece o mesmo; clientName é amigável e tem no máximo 40 caracteres', () => {
  const dir = tmpDir();
  const a = new BdsmAuth({ configDir: dir, hostname: 'PC-DO-MAURO' });
  const id = a.clientId;
  assert.match(id, /^[0-9a-f-]{36}$/);
  const b = new BdsmAuth({ configDir: dir, hostname: 'outro' });
  assert.equal(b.clientId, id, 'reabrir o arquivo mantém o clientId');
  assert.equal(a.clientName(), 'Braga Digital Studio - PC-DO-MAURO');

  const longName = new BdsmAuth({ hostname: 'Computador-do-escritório-com-um-nome-enorme-demais!!<>' }).clientName();
  assert.ok(longName.length <= MAX_CLIENT_NAME, longName);
  assert.ok(longName.startsWith('Braga Digital Studio'));
  assert.doesNotMatch(longName, /[<>!]/);
});

test('pareamento aprovado: código vai ao renderer, token é guardado criptografado e reaproveitado', async (t) => {
  const phone = await createFakePhone({ media: MEDIA, autoDecision: 'approve', decisionAfterPolls: 2, code: '4821' });
  t.after(() => phone.close());
  const dir = tmpDir();
  const safe = fakeSafeStorage();
  const auth = new BdsmAuth({ configDir: dir, safeStorage: safe, hostname: 'TESTE' });
  const pairing = new BdsmPairing({ auth, pollMs: 20 });

  const before = await pairing.status('127.0.0.1', phone.port);
  assert.deepEqual({ paired: before.paired, authRequired: before.authRequired, deviceName: before.deviceName }, { paired: false, authRequired: true, deviceName: 'Scorpio' });

  const { events, last } = await pairAndWait(pairing, phone);
  assert.equal(events[0].state, 'PENDING');
  assert.equal(events[0].code, '4821');
  assert.ok(events[0].secondsLeft > 80 && events[0].secondsLeft <= 90);
  assert.equal(events.started.state, 'PENDING');
  assert.equal(last.state, 'APPROVED');
  assert.equal(phone.pairRequestCount, 1);

  // o celular recebeu o nome e o clientId deste computador
  const req = [...phone.requests.values()][0];
  assert.equal(req.clientId, auth.clientId);
  assert.equal(req.clientName, 'Braga Digital Studio - TESTE');

  // token guardado: existe para o aparelho, está no arquivo só criptografado
  const key = 'Scorpio|SM-A515F';
  const token = auth.getToken(key);
  assert.match(token, /^[0-9a-f]{64}$/);
  const raw = fs.readFileSync(path.join(dir, 'bdsm-pairing.json'), 'utf8');
  assert.ok(!raw.includes(token), 'o token não pode estar em texto puro no disco');
  assert.ok(JSON.parse(raw).devices[key].tokenEnc.length > 10);

  // reutilizado numa nova execução do app (novo objeto lendo o mesmo arquivo)
  const reopened = new BdsmAuth({ configDir: dir, safeStorage: safe });
  assert.equal(reopened.getToken(key), token);
  assert.equal(reopened.clientId, auth.clientId);

  // e o celular aceita: informações completas
  const after = await pairing.status('127.0.0.1', phone.port);
  assert.equal(after.paired, true);
  const probe = await probeInfo('127.0.0.1', phone.port, { auth: reopened });
  assert.equal(probe.paired, true);
  assert.equal(probe.info.batteryLevel, 87);
  assert.ok(probe.info.totalStorageBytes > 0);
});

test('sem criptografia disponível o token fica só na memória (nunca em texto puro no disco)', async (t) => {
  const phone = await createFakePhone({ autoDecision: 'approve' });
  t.after(() => phone.close());
  const dir = tmpDir();
  const auth = new BdsmAuth({ configDir: dir, safeStorage: fakeSafeStorage({ available: false }) });
  const pairing = new BdsmPairing({ auth, pollMs: 20 });
  const { last } = await pairAndWait(pairing, phone);
  assert.equal(last.state, 'APPROVED');
  const token = auth.getToken('Scorpio|SM-A515F');
  assert.ok(token, 'vale durante a sessão');
  const raw = fs.readFileSync(path.join(dir, 'bdsm-pairing.json'), 'utf8');
  assert.ok(!raw.includes(token));
  assert.equal(JSON.parse(raw).devices['Scorpio|SM-A515F'].tokenEnc, '');
  assert.equal(new BdsmAuth({ configDir: dir, safeStorage: fakeSafeStorage({ available: false }) }).getToken('Scorpio|SM-A515F'), null);
});

test('pareamento negado e expirado não guardam token', async (t) => {
  const denied = await createFakePhone({ autoDecision: 'deny' });
  const expired = await createFakePhone({ autoDecision: 'expire' });
  t.after(() => Promise.all([denied.close(), expired.close()]));
  for (const [phone, state] of [[denied, 'DENIED'], [expired, 'EXPIRED']]) {
    const auth = new BdsmAuth({ configDir: tmpDir(), safeStorage: fakeSafeStorage() });
    const pairing = new BdsmPairing({ auth, pollMs: 20 });
    const { last } = await pairAndWait(pairing, phone);
    assert.equal(last.state, state);
    assert.equal(auth.getToken('Scorpio|SM-A515F'), null);
    assert.equal(pairing.sessions.size, 0);
  }
});

test('429: pedido já aberto no celular e espera após recusa viram DEVICE_BUSY com mensagem clara', async (t) => {
  const phone = await createFakePhone({ autoDecision: 'manual', cooldownMs: 5000 });
  t.after(() => phone.close());
  const first = new BdsmPairing({ auth: new BdsmAuth({ safeStorage: fakeSafeStorage() }), pollMs: 20 });
  await first.start('127.0.0.1', phone.port, () => {});

  // outro acompanhamento (sem como retomar) enquanto o celular ainda mostra o pedido
  const second = new BdsmPairing({ auth: new BdsmAuth({ safeStorage: fakeSafeStorage() }), pollMs: 20 });
  await assert.rejects(() => second.start('127.0.0.1', phone.port, () => {}), (e) => {
    assert.equal(e.code, 'DEVICE_BUSY');
    assert.match(e.message, /pedido de pareamento aberto/);
    return true;
  });
  first.stopAll();

  // recusa no celular -> espera antes de pedir de novo (429 também)
  const [req] = phone.pending();
  phone.deny(req.id);
  const third = new BdsmPairing({ auth: new BdsmAuth({ safeStorage: fakeSafeStorage() }), pollMs: 20 });
  await assert.rejects(() => third.start('127.0.0.1', phone.port, () => {}), (e) => e.code === 'DEVICE_BUSY');
});

test('cancelar para o acompanhamento e um novo início retoma o mesmo pedido (sem pedir outro ao celular)', async (t) => {
  const phone = await createFakePhone({ autoDecision: 'manual', code: '1357' });
  t.after(() => phone.close());
  const auth = new BdsmAuth({ configDir: tmpDir(), safeStorage: fakeSafeStorage() });
  const pairing = new BdsmPairing({ auth, pollMs: 20 });
  const events = [];
  await pairing.start('127.0.0.1', phone.port, (e) => events.push(e));
  assert.equal(pairing.cancel('127.0.0.1', phone.port), true);
  assert.equal(events.at(-1).state, 'CANCELED');
  assert.equal(pairing.sessions.size, 0);

  const again = await pairing.start('127.0.0.1', phone.port, (e) => events.push(e));
  assert.equal(again.code, '1357');
  assert.equal(phone.pairRequestCount, 1, 'não criou outro pedido');

  // o operador aprova agora: o acompanhamento retomado recebe o token
  const done = new Promise((resolve) => pairing.start('127.0.0.1', phone.port, (e) => { if (e.state === 'APPROVED') resolve(e); }));
  phone.approve(phone.pending()[0].id);
  await done;
  assert.ok(auth.getToken('Scorpio|SM-A515F'));
});

test('pareamento de aparelho já pareado devolve alreadyPaired sem novo pedido', async (t) => {
  const phone = await createFakePhone({ autoDecision: 'approve' });
  t.after(() => phone.close());
  const auth = new BdsmAuth({ configDir: tmpDir(), safeStorage: fakeSafeStorage() });
  const pairing = new BdsmPairing({ auth, pollMs: 20 });
  await pairAndWait(pairing, phone);
  const res = await pairing.start('127.0.0.1', phone.port, () => {});
  assert.deepEqual(res, { state: 'APPROVED', alreadyPaired: true });
  assert.equal(phone.pairRequestCount, 1);
});

test('token revogado no celular: a sondagem marca como não pareado e a primeira operação (401) descarta o token', async (t) => {
  const phone = await createFakePhone({ media: MEDIA, autoDecision: 'approve' });
  t.after(() => phone.close());
  const auth = new BdsmAuth({ configDir: tmpDir(), safeStorage: fakeSafeStorage() });
  const pairing = new BdsmPairing({ auth, pollMs: 20 });
  await pairAndWait(pairing, phone);
  assert.equal((await probeInfo('127.0.0.1', phone.port, { auth })).paired, true);

  phone.revokeAll();
  const probe = await probeInfo('127.0.0.1', phone.port, { auth });
  assert.equal(probe.paired, false);
  assert.equal(probe.tokenRejected, true);
  assert.equal(probe.authRequired, true);
  // a sondagem não apaga o token (outro aparelho com o mesmo nome/modelo poderia dividir a chave)
  assert.ok(auth.getToken('Scorpio|SM-A515F'));
  // um 401 numa operação real descarta
  await assert.rejects(() => new BdsmClient('127.0.0.1', phone.port, { auth }).getMedia(), (e) => e.code === 'PAIRING_REQUIRED');
  assert.equal(auth.getToken('Scorpio|SM-A515F'), null, 'token recusado é descartado');
});

test('401 com token inválido em /api/media: PAIRING_REQUIRED e o token salvo é descartado', async (t) => {
  const phone = await createFakePhone({ media: MEDIA });
  t.after(() => phone.close());
  const auth = new BdsmAuth({ configDir: tmpDir(), safeStorage: fakeSafeStorage() });
  auth.saveToken('Scorpio|SM-A515F', 'a'.repeat(64), { name: 'Scorpio' });
  auth.rememberEndpoint('127.0.0.1', phone.port, 'Scorpio|SM-A515F');
  const client = new BdsmClient('127.0.0.1', phone.port, { auth });
  await assert.rejects(() => client.getMedia(), (e) => {
    assert.equal(e.code, 'PAIRING_REQUIRED');
    assert.equal(e.status, 401);
    assert.match(e.message, /pareamento/i);
    return true;
  });
  assert.equal(auth.getToken('Scorpio|SM-A515F'), null);
});

test('USB e Wi-Fi do mesmo aparelho usam a mesma chave e o mesmo token', async (t) => {
  const clients = new Map(); // os dois "celulares" são o mesmo aparelho: o token emitido por um vale no outro
  const usb = await createFakePhone({ autoDecision: 'approve', clients });
  const wifi = await createFakePhone({ autoDecision: 'approve', clients });
  t.after(() => Promise.all([usb.close(), wifi.close()]));
  const auth = new BdsmAuth({ configDir: tmpDir(), safeStorage: fakeSafeStorage() });
  const pairing = new BdsmPairing({ auth, pollMs: 20 });
  await pairAndWait(pairing, usb);
  const viaUsb = await probeInfo('127.0.0.1', usb.port, { auth });
  assert.equal(viaUsb.key, 'Scorpio|SM-A515F');
  const viaWifi = await probeInfo('127.0.0.1', wifi.port, { auth });
  assert.equal(viaWifi.key, viaUsb.key);
  assert.equal(viaWifi.info.batteryLevel, 87);
});

test('esquecer o pareamento descarta o token (arquivo e memória)', async (t) => {
  const phone = await createFakePhone({ autoDecision: 'approve' });
  t.after(() => phone.close());
  const dir = tmpDir();
  const auth = new BdsmAuth({ configDir: dir, safeStorage: fakeSafeStorage() });
  const changes = [];
  const pairing = new BdsmPairing({ auth, pollMs: 20, onChange: (c) => changes.push(c) });
  await pairAndWait(pairing, phone);
  assert.ok(auth.isPaired('Scorpio|SM-A515F'));
  await pairing.forget('127.0.0.1', phone.port);
  assert.equal(auth.isPaired('Scorpio|SM-A515F'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bdsm-pairing.json'), 'utf8')).devices, {});
  assert.deepEqual(changes.map((c) => c.paired), [true, false]);
});

test('o token nunca vai para o log nem para os eventos enviados ao renderer', async (t) => {
  const phone = await createFakePhone({ media: MEDIA, autoDecision: 'approve', decisionAfterPolls: 2 });
  t.after(() => phone.close());
  const cap = captureLogs();
  t.after(() => cap.restore());
  const auth = new BdsmAuth({ configDir: tmpDir(), safeStorage: fakeSafeStorage() });
  const pairing = new BdsmPairing({ auth, pollMs: 20 });
  const { events } = await pairAndWait(pairing, phone);
  const token = auth.getToken('Scorpio|SM-A515F');
  assert.ok(token);

  const client = new BdsmClient('127.0.0.1', phone.port, { auth });
  await client.getMedia();
  phone.revokeAll();
  await client.getMedia().catch(() => {}); // 401 também é registrado em log

  assert.ok(!JSON.stringify(events).includes(token), 'eventos do renderer sem token');
  assert.ok(!cap.lines.join('\n').includes(token), 'log sem token');
  // o que o renderer vê do aparelho (probeInfo) também não carrega token
  assert.ok(!JSON.stringify(await probeInfo('127.0.0.1', phone.port, { auth })).includes(token));
});

test('celular fora do ar: DEVICE_UNREACHABLE com mensagem específica', async () => {
  const pairing = new BdsmPairing({ auth: new BdsmAuth({ safeStorage: fakeSafeStorage() }), pollMs: 20 });
  const phone = await createFakePhone({});
  const { port } = phone;
  await phone.close();
  await assert.rejects(() => pairing.start('127.0.0.1', port, () => {}), (e) => {
    assert.equal(e.code, 'DEVICE_UNREACHABLE');
    assert.match(e.message, /Sem conexão com o celular/);
    return true;
  });
});
