'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { backoffDelay, deviceChanged } = require('../src/core/devices/backoff');
const { cachedAsync } = require('../src/infrastructure/hardware/cachedAsync');

test('backoff do adb: 30 s, 60 s, 5 min e depois estável', () => {
  assert.equal(backoffDelay(0), 0);
  assert.equal(backoffDelay(1), 30000);
  assert.equal(backoffDelay(2), 60000);
  assert.equal(backoffDelay(3), 300000);
  assert.equal(backoffDelay(10), 300000);
});

test('deviceChanged ignora last_seen', () => {
  const a = { id: 'x', name: 'Tel', battery: 90, last_seen: 1 };
  assert.equal(deviceChanged(a, { ...a, last_seen: 2 }), false);
  assert.equal(deviceChanged(a, { ...a, battery: 80 }), true);
  assert.equal(deviceChanged(undefined, a), true);
});

test('cachedAsync: TTL, deduplicação e force', async () => {
  let t = 0;
  let calls = 0;
  const c = cachedAsync(async () => { calls++; await new Promise((r) => setImmediate(r)); return calls; }, 1000, () => t);

  // Chamadas concorrentes compartilham a mesma execução
  const [a, b] = await Promise.all([c.get(), c.get()]);
  assert.equal(calls, 1);
  assert.equal(a, 1);
  assert.equal(b, 1);

  // Dentro do TTL: cache
  t = 500;
  assert.equal(await c.get(), 1);
  assert.equal(calls, 1);

  // Expirou
  t = 1500;
  assert.equal(await c.get(), 2);

  // force ignora o cache
  assert.equal(await c.get({ force: true }), 3);

  // invalidate
  c.invalidate();
  assert.equal(await c.get(), 4);
});

test('cachedAsync: rejeição não é guardada em cache', async () => {
  let calls = 0;
  const c = cachedAsync(async () => { calls++; if (calls === 1) throw new Error('falha'); return 'ok'; }, 1000, () => 0);
  await assert.rejects(c.get(), /falha/);
  assert.equal(await c.get(), 'ok');
  assert.equal(calls, 2);
});
