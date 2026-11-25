'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'utils', 'shiftRange.js')).href);

test('sem Shift o clique só vira a âncora', async () => {
  const { createShiftRange } = await load();
  const r = createShiftRange();
  assert.equal(r.resolve([1, 2, 3, 4], 2), null);
  assert.equal(r.resolve([1, 2, 3, 4], 4), null);
});

test('Shift devolve o intervalo entre a âncora e o clique, nos dois sentidos, e mantém a âncora', async () => {
  const { createShiftRange } = await load();
  const r = createShiftRange();
  const order = ['a', 'b', 'c', 'd', 'e'];
  r.resolve(order, 'b');
  r.noteClick({ shiftKey: true });
  assert.deepEqual(r.resolve(order, 'd'), ['b', 'c', 'd']);
  r.noteClick({ shiftKey: true });
  assert.deepEqual(r.resolve(order, 'a'), ['a', 'b'], 'a âncora continua sendo b');
});

test('o clique sintético do label (sem Shift) não apaga o Shift já visto', async () => {
  const { createShiftRange } = await load();
  const r = createShiftRange();
  const order = [1, 2, 3];
  r.resolve(order, 1);
  r.noteClick({ shiftKey: true });
  r.noteClick({ shiftKey: false });
  assert.deepEqual(r.resolve(order, 3), [1, 2, 3]);
});

test('Shift sem âncora ou com âncora fora da lista vale como clique comum', async () => {
  const { createShiftRange } = await load();
  const r = createShiftRange();
  r.noteClick({ shiftKey: true });
  assert.equal(r.resolve([1, 2], 2), null);
  r.setAnchor(99);
  r.noteClick({ shiftKey: true });
  assert.equal(r.resolve([1, 2], 2), null);
});

test('rangeTo (cartão sem caixa) usa a âncora e reset a esquece', async () => {
  const { createShiftRange } = await load();
  const r = createShiftRange();
  assert.equal(r.rangeTo([1, 2, 3], 3), null);
  r.setAnchor(1);
  assert.deepEqual(r.rangeTo([1, 2, 3], 3), [1, 2, 3]);
  r.reset();
  assert.equal(r.rangeTo([1, 2, 3], 3), null);
});
