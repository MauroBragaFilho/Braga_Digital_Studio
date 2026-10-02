'use strict';
// Testa o contrato documentado de src/ipc/validate.js (tolerante a reescritas internas).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const v = require('../src/ipc/validate');

test('assertSafeFileName aceita nome simples', () => {
  assert.doesNotThrow(() => v.assertSafeFileName('video final.mp4'));
});

test('assertSafeFileName rejeita separadores, ".." e vazio', () => {
  const backslash = String.fromCharCode(92);
  for (const bad of ['a/b.mp4', `a${backslash}b.mp4`, '..', '../x', `..${backslash}x`, '', null, undefined]) {
    assert.throws(() => v.assertSafeFileName(bad), undefined, `deveria rejeitar ${JSON.stringify(bad)}`);
  }
});

test('assertNonEmpty rejeita vazio/espaços e aceita texto', () => {
  assert.throws(() => v.assertNonEmpty('   ', 'campo'));
  assert.throws(() => v.assertNonEmpty('', 'campo'));
  assert.doesNotThrow(() => v.assertNonEmpty('ok', 'campo'));
});

test('assertSafePath rejeita escape do diretório base', () => {
  const base = path.resolve('base-dir');
  assert.throws(() => v.assertSafePath(base, path.join(base, '..', 'fora.txt')));
  assert.doesNotThrow(() => v.assertSafePath(base, path.join(base, 'dentro.txt')));
});

test('assertPositiveInt', () => {
  assert.doesNotThrow(() => v.assertPositiveInt(3, 'n'));
  assert.throws(() => v.assertPositiveInt(0, 'n'));
  assert.throws(() => v.assertPositiveInt(1.5, 'n'));
});
