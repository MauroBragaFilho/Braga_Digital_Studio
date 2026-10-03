'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const shared = require('../src/core/media/FfmpegLimiter');
const { FfmpegLimiter, PRIORITY, defaultMax } = shared;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('limite padrão = clamp(floor(cpus/2), 2, 6)', () => {
  const expected = Math.min(6, Math.max(2, Math.floor((os.cpus().length || 4) / 2)));
  assert.strictEqual(defaultMax(), expected);
  assert.strictEqual(shared.max, expected);
  assert.ok(shared.max >= 2 && shared.max <= 6);
});

test('API antiga run(fn) continua funcionando e respeita o limite', async () => {
  const limiter = new FfmpegLimiter(2);
  let active = 0;
  let peak = 0;
  const job = () => limiter.run(async () => {
    active++; peak = Math.max(peak, active);
    await delay(15);
    active--;
  });
  await Promise.all(Array.from({ length: 8 }, job));
  assert.strictEqual(peak, 2);
  assert.strictEqual(limiter.active, 0);
});

test('fila de espera atende prioridade alta antes da baixa; FIFO entre iguais', async () => {
  const limiter = new FfmpegLimiter(1);
  const order = [];
  let release;
  const blocker = limiter.run(() => new Promise((r) => { release = r; })); // ocupa o único slot
  await delay(5);

  const mk = (name, prio) => limiter.run(async () => { order.push(name); }, prio);
  const waiting = [
    mk('low1', PRIORITY.LOW),
    mk('low2', PRIORITY.LOW),
    mk('normal', PRIORITY.NORMAL),
    mk('high1', PRIORITY.HIGH),
    mk('high2', PRIORITY.HIGH),
    mk('default') // sem prioridade = NORMAL
  ];
  await delay(5);
  release();
  await blocker;
  await Promise.all(waiting);
  assert.deepStrictEqual(order, ['high1', 'high2', 'normal', 'default', 'low1', 'low2']);
});

test('erro na tarefa libera o slot', async () => {
  const limiter = new FfmpegLimiter(1);
  await assert.rejects(limiter.run(async () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(limiter.active, 0);
  assert.strictEqual(await limiter.run(async () => 'ok'), 'ok');
});
