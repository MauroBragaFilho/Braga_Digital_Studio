'use strict';

// ZipExtractor: validação anti zip-slip (zip e tarball) antes de extrair, extração real e cancelamento.
// A parte "real" usa o tar do sistema (bsdtar no Windows) ou "unzip" (Linux); sem a ferramenta, é pulada.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const { extractZip, extractTarball, assertSafeEntries, walkFiles } = require('../src/core/modules/ZipExtractor');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-zipx-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const fresh = (name) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };

const hasTool = (cmd, args) => { try { return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0; } catch (_) { return false; } };
const CAN_ZIP = process.platform === 'win32' ? hasTool('tar', ['--version']) : hasTool('unzip', ['-v']);
const CAN_TAR = hasTool('tar', ['--version']);
const zipOpts = { skip: !CAN_ZIP && 'tar/unzip indisponível' };
const tarOpts = { skip: !CAN_TAR && 'tar indisponível' };

// ---- assertSafeEntries (puro) ------------------------------------------------

test('assertSafeEntries aceita entradas normais, pastas e linhas com CR/vazias', () => {
  const dest = path.join(root, 'dest');
  assert.doesNotThrow(() => assertSafeEntries(['a.txt', 'dir/', 'dir/b.dll\r', '', 'x/y/../z.txt'.replace('..', 'w')], dest));
});

test('assertSafeEntries bloqueia "..", caminho absoluto, unidade e barra invertida de fuga', () => {
  const dest = path.join(root, 'dest');
  for (const evil of ['../fora.txt', 'a/../../fora.txt', '..\\fora.txt', '/etc/passwd', 'C:/Windows/x.dll', 'c:\\x.dll', '\\\\srv\\share\\x']) {
    assert.throws(() => assertSafeEntries([evil], dest), /inseguro/, evil);
  }
});

// ---- zip real ---------------------------------------------------------------

test('extractZip extrai um zip legítimo (inclusive subpastas)', zipOpts, async () => {
  const zipPath = path.join(root, 'ok.zip');
  const z = new AdmZip();
  z.addFile('bin/a.dll', Buffer.from('dll'));
  z.addFile('bin/leia-me.txt', Buffer.from('txt'));
  z.addFile('raiz.txt', Buffer.from('raiz'));
  z.writeZip(zipPath);

  const dest = fresh('zip-ok');
  await extractZip(zipPath, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'bin', 'a.dll'), 'utf8'), 'dll');
  assert.equal(fs.readFileSync(path.join(dest, 'raiz.txt'), 'utf8'), 'raiz');
  assert.equal(walkFiles(dest).length, 3);
});

test('extractZip recusa zip-slip ANTES de extrair qualquer coisa', zipOpts, async () => {
  const zipPath = path.join(root, 'slip.zip');
  const z = new AdmZip();
  z.addFile('ok.txt', Buffer.from('ok'));
  z.addFile('x', Buffer.from('mal'));
  z.getEntries().find((e) => e.entryName === 'x').entryName = '../escapou.txt';
  z.writeZip(zipPath);

  const dest = fresh('zip-slip');
  await assert.rejects(() => extractZip(zipPath, dest), /inseguro|validar/);
  assert.equal(walkFiles(dest).length, 0, 'nada foi extraído (nem a entrada boa)');
  assert.equal(fs.existsSync(path.join(root, 'escapou.txt')), false);
});

test('extractZip falha com mensagem clara para arquivo que não é zip', zipOpts, async () => {
  const bad = path.join(root, 'lixo.zip');
  fs.writeFileSync(bad, 'isto nao e um zip');
  await assert.rejects(() => extractZip(bad, fresh('zip-lixo')), /validar|Falha/);
});

// ---- tarball ----------------------------------------------------------------

/** Monta um .tar mínimo (formato ustar) com entradas { name, data }. */
function buildTar(entries) {
  const blocks = [];
  for (const { name, data } of entries) {
    const body = Buffer.from(data);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148); // checksum provisório
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test('extractTarball extrai um .tar.gz legítimo', tarOpts, async () => {
  const tgz = path.join(root, 'ok.tar.gz');
  fs.writeFileSync(tgz, zlib.gzipSync(buildTar([{ name: 'motor/bin.txt', data: 'bin' }, { name: 'motor/lib.txt', data: 'lib' }])));
  const dest = fresh('tar-ok');
  await extractTarball(tgz, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'motor', 'bin.txt'), 'utf8'), 'bin');
  assert.equal(walkFiles(dest).length, 2);
});

test('extractTarball recusa entrada com ".." (tar-slip) e não extrai nada', tarOpts, async () => {
  const tgz = path.join(root, 'slip.tar.gz');
  fs.writeFileSync(tgz, zlib.gzipSync(buildTar([{ name: 'bom.txt', data: 'bom' }, { name: '../escapou-tar.txt', data: 'mal' }])));
  const dest = fresh('tar-slip');
  await assert.rejects(() => extractTarball(tgz, dest), /inseguro|validar/);
  assert.equal(walkFiles(dest).length, 0);
  assert.equal(fs.existsSync(path.join(root, 'escapou-tar.txt')), false);
});

test('extractTarball falha com mensagem clara para arquivo corrompido', tarOpts, async () => {
  const bad = path.join(root, 'corrompido.tar.gz');
  fs.writeFileSync(bad, Buffer.from('nao e gzip'));
  await assert.rejects(() => extractTarball(bad, fresh('tar-bad')), /validar|Falha/);
});
