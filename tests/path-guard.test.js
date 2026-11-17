'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { PathGuard } = require('../src/infrastructure/filesystem/PathGuard');

const base = path.join(os.tmpdir(), 'bds-pathguard-base');

test('PathGuard.assertWithin aceita o próprio diretório base e subcaminhos', () => {
  assert.equal(PathGuard.assertWithin(base, base), path.resolve(base));
  assert.equal(PathGuard.assertWithin(base, path.join(base, 'a', 'b.txt')), path.resolve(base, 'a', 'b.txt'));
  // barra final e segmentos "." não enganam
  assert.equal(PathGuard.assertWithin(base + path.sep, path.join(base, '.', 'x')), path.resolve(base, 'x'));
});

test('PathGuard.assertWithin bloqueia ".." que escapa do diretório', () => {
  assert.throws(() => PathGuard.assertWithin(base, path.join(base, '..', 'fora.txt')), /Acesso negado/);
  assert.throws(() => PathGuard.assertWithin(base, path.join(base, 'a', '..', '..', 'fora.txt')), /Acesso negado/);
  // ".." que volta para dentro continua válido
  assert.doesNotThrow(() => PathGuard.assertWithin(base, path.join(base, 'a', '..', 'b')));
});

test('PathGuard.assertWithin bloqueia diretório irmão com o mesmo prefixo (base2 vs base)', () => {
  assert.throws(() => PathGuard.assertWithin(base, base + '2'), /Acesso negado/);
  assert.throws(() => PathGuard.assertWithin(base, path.join(base + '-evil', 'x')), /Acesso negado/);
});

test('PathGuard.assertWithin bloqueia caminhos absolutos de outro lugar e exige os dois argumentos', () => {
  const outro = path.resolve(os.homedir(), 'qualquer.txt');
  assert.throws(() => PathGuard.assertWithin(base, outro), /Acesso negado/);
  assert.throws(() => PathGuard.assertWithin('', outro), /obrigatórios/);
  assert.throws(() => PathGuard.assertWithin(base, ''), /obrigatórios/);
  assert.throws(() => PathGuard.assertWithin(null, null), /obrigatórios/);
});

test('PathGuard.isWithin devolve booleano sem lançar', () => {
  assert.equal(PathGuard.isWithin(base, path.join(base, 'ok.png')), true);
  assert.equal(PathGuard.isWithin(base, path.join(base, '..', 'no.png')), false);
  assert.equal(PathGuard.isWithin(undefined, 'x'), false);
});

test('PathGuard resolve caminho relativo contra o cwd (não contra a base)', () => {
  // um relativo simples resolve no cwd: só passa se o cwd estiver dentro da base
  assert.equal(PathGuard.isWithin(base, 'relativo.txt'), false);
  assert.equal(PathGuard.isWithin(process.cwd(), 'relativo.txt'), true);
});

test('PathGuard: junção dentro da pasta que aponta para fora é bloqueada', (t) => {
  const fs = require('node:fs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-pg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inside = path.join(root, 'base');
  const outside = path.join(root, 'fora');
  fs.mkdirSync(inside); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(inside, 'link'), 'junction');
  assert.throws(() => PathGuard.assertWithin(inside, path.join(inside, 'link', 'x.txt')), /Acesso negado/);
  assert.ok(PathGuard.isWithin(inside, path.join(inside, 'novo', 'y.txt')));
});

test('PathGuard: no Windows a comparação não diferencia maiúsculas', { skip: process.platform !== 'win32' }, () => {
  assert.ok(PathGuard.isWithin(base, path.join(base.toUpperCase(), 'a.txt')));
});
