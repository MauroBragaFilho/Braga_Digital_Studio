'use strict';

// bds-thumb://: só imagens dentro dos diretórios permitidos; sem UNC, traversal, symlink de fuga ou extensão estranha.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveThumbRequest } = require('../src/ipc/thumbProtocol');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-thumbproto-'));
const allowed = path.join(root, 'thumbs');
const secret = path.join(root, 'segredo');
fs.mkdirSync(allowed, { recursive: true });
fs.mkdirSync(secret, { recursive: true });
fs.writeFileSync(path.join(allowed, 'a.jpg'), 'x');
fs.writeFileSync(path.join(allowed, 'b c.png'), 'x');
fs.writeFileSync(path.join(allowed, 'dados.txt'), 'x');
fs.writeFileSync(path.join(secret, 'senha.png'), 'x');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const url = (p) => 'bds-thumb://' + p.replace(/\\/g, '/');

test('serve imagem dentro do diretório permitido (com espaço codificado e query de cache)', () => {
  const ok = resolveThumbRequest(url(path.join(allowed, 'a.jpg')), [allowed]);
  assert.equal(ok.ok, true);
  assert.equal(ok.filePath, path.join(allowed, 'a.jpg'));
  const q = resolveThumbRequest(url(path.join(allowed, 'a.jpg')) + '?t=123', [allowed]);
  assert.equal(q.ok, true);
  const esp = resolveThumbRequest(encodeURI(url(path.join(allowed, 'b c.png'))), [allowed]);
  assert.equal(esp.ok, true);
});

test('bloqueia travessia por ".." (literal e codificada)', () => {
  const literal = resolveThumbRequest(url(path.join(allowed, '..', 'segredo', 'senha.png')), [allowed]);
  assert.equal(literal.ok, false);
  assert.equal(literal.status, 403);
  const enc = resolveThumbRequest('bds-thumb://' + encodeURIComponent(path.join(allowed, '..', 'segredo', 'senha.png')), [allowed]);
  assert.equal(enc.ok, false);
  assert.equal(enc.status, 403);
  const dupla = resolveThumbRequest(url(allowed) + '/%2e%2e/segredo/senha.png', [allowed]);
  assert.equal(dupla.ok, false);
});

test('bloqueia diretório irmão com prefixo parecido e arquivo fora da lista', () => {
  const irmao = allowed + '-evil';
  fs.mkdirSync(irmao, { recursive: true });
  fs.writeFileSync(path.join(irmao, 'x.png'), 'x');
  assert.equal(resolveThumbRequest(url(path.join(irmao, 'x.png')), [allowed]).ok, false);
  assert.equal(resolveThumbRequest(url(path.join(secret, 'senha.png')), [allowed]).ok, false);
  assert.equal(resolveThumbRequest(url(path.join(allowed, 'a.jpg')), []).ok, false);
});

test('bloqueia UNC, caminho relativo, extensão que não é imagem, NUL e esquema errado', () => {
  assert.equal(resolveThumbRequest('bds-thumb://\\\\servidor\\share\\a.png', [allowed]).status, 403);
  assert.equal(resolveThumbRequest('bds-thumb:////servidor/share/a.png', [allowed]).status, 403);
  assert.equal(resolveThumbRequest('bds-thumb://a.png', [allowed]).status, 403);
  const txt = resolveThumbRequest(url(path.join(allowed, 'dados.txt')), [allowed]);
  assert.equal(txt.ok, false);
  assert.equal(txt.status, 403);
  assert.equal(resolveThumbRequest(url(path.join(allowed, 'a.jpg')) + '%00.png', [allowed]).status, 400);
  assert.equal(resolveThumbRequest('file:///etc/passwd', [allowed]).status, 400);
  assert.equal(resolveThumbRequest(null, [allowed]).status, 400);
  assert.equal(resolveThumbRequest('bds-thumb://%E0%A4%A', [allowed]).status, 400);
});

test('bloqueia symlink dentro do diretório permitido que aponta para fora', (t) => {
  const link = path.join(allowed, 'fuga.png');
  try {
    fs.symlinkSync(path.join(secret, 'senha.png'), link);
  } catch (e) {
    t.skip(`sem permissão para criar symlink (${e.code})`);
    return;
  }
  const r = resolveThumbRequest(url(link), [allowed]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});
