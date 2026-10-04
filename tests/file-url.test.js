'use strict';
// toFileUrl (RK-046): caminhos com #, ?, %, espaço, acentos, UNC e POSIX.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mod;
test.before(async () => { mod = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'utils', 'fileUrl.js')).href); });

test('caminho Windows simples e com espaço', () => {
  assert.strictEqual(mod.toFileUrl('C:\\Videos\\clip final.mp4'), 'file:///C:/Videos/clip%20final.mp4');
});

test('# ? % e aspas no nome são escapados', () => {
  assert.strictEqual(mod.toFileUrl('D:\\a\\#1 take?.mp4'), 'file:///D:/a/%231%20take%3F.mp4');
  assert.strictEqual(mod.toFileUrl('D:\\a\\100%.mp4'), 'file:///D:/a/100%25.mp4');
  assert.ok(!/[()']/.test(mod.toFileUrl("D:\\a\\it's (x).png")));
});

test('acentos viram percent-encoding e voltam iguais com decodeURIComponent', () => {
  const u = mod.toFileUrl('C:\\Vídeos\\ação.mp4');
  assert.strictEqual(decodeURIComponent(u), 'file:///C:/Vídeos/ação.mp4');
});

test('UNC e POSIX', () => {
  assert.strictEqual(mod.toFileUrl('\\\\srv\\share\\a b.mp4'), 'file://srv/share/a%20b.mp4');
  assert.strictEqual(mod.toFileUrl('/home/u/a#b.mp4'), 'file:///home/u/a%23b.mp4');
});

test('vazio, null e file: já pronto', () => {
  assert.strictEqual(mod.toFileUrl(''), '');
  assert.strictEqual(mod.toFileUrl(null), '');
  assert.strictEqual(mod.toFileUrl('file:///x/y.png'), 'file:///x/y.png');
});

test('joinFileUrl escapa só o nome', () => {
  assert.strictEqual(mod.joinFileUrl('file:///C:/Thumbs/', 'a#b.jpg'), 'file:///C:/Thumbs/a%23b.jpg');
});
