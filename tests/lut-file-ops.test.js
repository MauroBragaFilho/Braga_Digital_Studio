'use strict';

// Cópia segura de LUTs (lutFileOps): sem sobrescrever, sem arquivo pela metade, conferida por hash.

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hashFile, copyFileExclusive, indexByHash, sweepPartials } = require('../src/core/luts/lutFileOps');
const { LUT_EXT, MAX_FILE_BYTES, MAX_SEGMENTS } = require('../src/core/luts/lutConstants');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-lutops-'));
  const src = path.join(root, 'src');
  const dest = path.join(root, 'dest');
  fs.mkdirSync(src);
  fs.mkdirSync(dest);
  const write = (name, content) => { const p = path.join(src, name); fs.writeFileSync(p, content); return p; };
  return { root, src, dest, write };
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const partials = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.part'));

test('constantes: .cube, 64 MiB e 4 segmentos (mesma regra da sincronização com o celular)', () => {
  assert.equal(LUT_EXT, '.cube');
  assert.equal(MAX_FILE_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_SEGMENTS, 4);
});

test('copyFileExclusive: copia byte a byte, devolve o SHA-256 e não deixa .part', () => {
  const { dest, write } = setup();
  const from = write('a.cube', 'LUT_3D_SIZE 2\r\n0 0 0\n');
  const res = copyFileExclusive(from, dest, 'a.cube');
  assert.equal(res.status, 'copied');
  assert.equal(res.name, 'a.cube');
  assert.equal(res.path, path.join(dest, 'a.cube'));
  assert.equal(res.sha256, sha('LUT_3D_SIZE 2\r\n0 0 0\n'));
  assert.deepEqual(fs.readFileSync(res.path), fs.readFileSync(from));
  assert.equal(hashFile(res.path), res.sha256);
  assert.deepEqual(fs.readdirSync(dest), ['a.cube']);
  assert.ok(fs.existsSync(from), 'a origem continua no lugar');
});

test('copyFileExclusive: sem exact, nome ocupado ganha sufixo e nunca sobrescreve', () => {
  const { dest, write } = setup();
  fs.writeFileSync(path.join(dest, 'a.cube'), 'do usuário');
  const from = write('a.cube', 'novo');
  const first = copyFileExclusive(from, dest, 'a.cube');
  const second = copyFileExclusive(from, dest, 'a.cube');
  assert.equal(first.name, 'a (2).cube');
  assert.equal(second.name, 'a (3).cube');
  assert.equal(fs.readFileSync(path.join(dest, 'a.cube'), 'utf-8'), 'do usuário');
  assert.deepEqual(partials(dest), []);
});

test('copyFileExclusive: com exact, nome ocupado devolve exists, sem sufixo e sem sobrescrever', () => {
  const { dest, write } = setup();
  fs.writeFileSync(path.join(dest, 'a.cube'), 'do usuário');
  const res = copyFileExclusive(write('a.cube', 'novo'), dest, 'a.cube', { exact: true });
  assert.equal(res.status, 'exists');
  assert.equal(res.name, null);
  assert.equal(fs.readFileSync(path.join(dest, 'a.cube'), 'utf-8'), 'do usuário');
  assert.deepEqual(fs.readdirSync(dest), ['a.cube']);
});

test('copyFileExclusive: nome com pasta, separador ou caractere proibido é recusado', () => {
  const { dest, write } = setup();
  const from = write('a.cube', 'x');
  for (const bad of ['', '.', '..', '../fora.cube', 'sub/a.cube', 'sub\\a.cube', 'a:b.cube', 'a*.cube', 'a\u0000.cube', null, 42]) {
    assert.throws(() => copyFileExclusive(from, dest, bad), /Nome de arquivo inválido/, `deveria recusar ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(fs.readdirSync(dest), []);
});

test('copyFileExclusive: origem que é pasta ou não existe falha sem deixar nada no destino', () => {
  const { src, dest } = setup();
  fs.mkdirSync(path.join(src, 'pasta.cube'));
  assert.throws(() => copyFileExclusive(path.join(src, 'pasta.cube'), dest, 'p.cube'), /não é um arquivo comum/);
  assert.throws(() => copyFileExclusive(path.join(src, 'nao-existe.cube'), dest, 'n.cube'));
  assert.deepEqual(fs.readdirSync(dest), []);
});

test('copyFileExclusive: link simbólico na origem é recusado (quando o sistema permite criá-lo)', (t) => {
  const { src, dest, write } = setup();
  const real = write('real.cube', 'x');
  const link = path.join(src, 'link.cube');
  try { fs.symlinkSync(real, link); } catch { t.skip('sem permissão para criar link simbólico neste ambiente'); return; }
  assert.throws(() => copyFileExclusive(link, dest, 'link.cube'), /não é um arquivo comum/);
  assert.deepEqual(fs.readdirSync(dest), []);
});

test('copyFileExclusive: arquivo acima do limite é recusado', () => {
  const { dest, write } = setup();
  const from = write('grande.cube', 'x');
  const real = fs.lstatSync;
  const stat = mock.method(fs, 'lstatSync', (p, ...rest) => {
    const info = real(p, ...rest);
    return String(p) === from ? Object.assign(Object.create(Object.getPrototypeOf(info)), info, { size: MAX_FILE_BYTES + 1 }) : info;
  });
  try {
    assert.throws(() => copyFileExclusive(from, dest, 'grande.cube'), /maior que o limite/);
  } finally { stat.mock.restore(); }
  assert.deepEqual(fs.readdirSync(dest), []);
});

test('copyFileExclusive: sem suporte a vínculo físico (FAT/rede) cai para a cópia exclusiva, sem sobrescrever', () => {
  const { dest, write } = setup();
  const link = mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('sem link'), { code: 'EPERM' }); });
  try {
    const ok = copyFileExclusive(write('a.cube', 'conteúdo'), dest, 'a.cube', { exact: true });
    assert.equal(ok.status, 'copied');
    assert.equal(fs.readFileSync(path.join(dest, 'a.cube'), 'utf-8'), 'conteúdo');
    const again = copyFileExclusive(write('b.cube', 'outro'), dest, 'a.cube', { exact: true });
    assert.equal(again.status, 'exists');
    assert.equal(fs.readFileSync(path.join(dest, 'a.cube'), 'utf-8'), 'conteúdo');
    const suffixed = copyFileExclusive(write('c.cube', 'terceiro'), dest, 'a.cube');
    assert.equal(suffixed.name, 'a (2).cube');
    assert.ok(link.mock.callCount() >= 3);
  } finally { link.mock.restore(); }
  assert.deepEqual(partials(dest), []);
});

test('copyFileExclusive: cópia que sai diferente do original no volume sem vínculo é apagada e vira erro', () => {
  const { dest, write } = setup();
  const from = write('a.cube', 'conteúdo íntegro');
  const link = mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('sem link'), { code: 'ENOTSUP' }); });
  const realCopy = fs.copyFileSync;
  const copy = mock.method(fs, 'copyFileSync', (s, d, flags) => { realCopy(s, d, flags); fs.writeFileSync(d, 'corrompido'); });
  try {
    assert.throws(() => copyFileExclusive(from, dest, 'a.cube'), /diferente do original/);
  } finally { copy.mock.restore(); link.mock.restore(); }
  assert.deepEqual(fs.readdirSync(dest), [], 'nem a LUT corrompida nem o .part ficam');
});

test('copyFileExclusive: falha ao gravar o temporário não deixa .part nem destino', () => {
  const { dest, write } = setup();
  const from = write('a.cube', 'conteúdo');
  const realWrite = fs.writeFileSync;
  const w = mock.method(fs, 'writeFileSync', (p, data, opts) => {
    realWrite(p, 'truncado', opts); // simula disco que grava só parte
  });
  try {
    assert.throws(() => copyFileExclusive(from, dest, 'a.cube'), /gravação ficou diferente/);
  } finally { w.mock.restore(); }
  assert.deepEqual(fs.readdirSync(dest), []);
});

test('indexByHash: acha conteúdo em qualquer subpasta, só hasheia os tamanhos pedidos e ignora o que não é LUT', () => {
  const { root } = setup();
  const lut = path.join(root, 'colecao');
  fs.mkdirSync(path.join(lut, 'A', 'B'), { recursive: true });
  fs.writeFileSync(path.join(lut, 'raiz.cube'), 'conteudo-1');
  fs.writeFileSync(path.join(lut, 'A', 'B', 'fundo.CUBE'), 'conteudo-22');
  fs.writeFileSync(path.join(lut, 'A', 'outro-tamanho.cube'), 'xx');
  fs.writeFileSync(path.join(lut, 'A', 'nota.txt'), 'conteudo-1');
  fs.writeFileSync(path.join(lut, '.oculta.cube'), 'conteudo-1');
  fs.mkdirSync(path.join(lut, '.pasta-oculta'));
  fs.writeFileSync(path.join(lut, '.pasta-oculta', 'x.cube'), 'conteudo-1');
  fs.mkdirSync(path.join(lut, 'pasta.cube'));

  const index = indexByHash(lut, new Set([Buffer.byteLength('conteudo-1'), Buffer.byteLength('conteudo-22')]));
  assert.deepEqual([...index.entries()].sort(), [
    [sha('conteudo-1'), 'raiz.cube'],
    [sha('conteudo-22'), path.join('A', 'B', 'fundo.CUBE')]
  ].sort());
  assert.equal(index.has(sha('xx')), false, 'tamanho que não foi pedido não é lido');
});

test('indexByHash: respeita o limite de 4 segmentos e tolera pasta inexistente', () => {
  const { root } = setup();
  const lut = path.join(root, 'colecao');
  const ok = path.join(lut, 'a', 'b', 'c'); // a/b/c/ok.cube = 4 segmentos
  const tooDeep = path.join(ok, 'd'); // a/b/c/d/fundo.cube = 5 segmentos
  fs.mkdirSync(tooDeep, { recursive: true });
  fs.writeFileSync(path.join(ok, 'ok.cube'), 'dentro');
  fs.writeFileSync(path.join(tooDeep, 'fundo.cube'), 'fundo!');
  const index = indexByHash(lut, new Set([6]));
  assert.deepEqual([...index.values()], [path.join('a', 'b', 'c', 'ok.cube')]);
  assert.equal(indexByHash(path.join(root, 'nao-existe'), new Set([6])).size, 0);
});

test('copyFileExclusive: aceita o conteúdo já lido (Buffer) e grava exatamente esse conteúdo, sem ler a origem de novo', () => {
  const { dest } = setup();
  const data = Buffer.from('LUT_3D_SIZE 2\nconteudo\n');
  const res = copyFileExclusive(data, dest, 'b.cube');
  assert.equal(res.status, 'copied');
  assert.equal(res.sha256, sha(data));
  assert.equal(fs.readFileSync(path.join(dest, 'b.cube'), 'utf8'), data.toString());
  assert.deepEqual(partials(dest), []);
  // nome ocupado: sufixo, e o que já estava lá fica intacto
  const second = copyFileExclusive(Buffer.from('outro'), dest, 'b.cube');
  assert.equal(second.name, 'b (2).cube');
  assert.equal(fs.readFileSync(path.join(dest, 'b.cube'), 'utf8'), data.toString());
  assert.throws(() => copyFileExclusive(Buffer.alloc(MAX_FILE_BYTES + 1), dest, 'grande.cube'), /maior que o limite/);
  assert.throws(() => copyFileExclusive(Buffer.from('x'), dest, '../fora.cube'), /Nome de arquivo inválido/);
  assert.deepEqual(partials(dest), []);
});

test('sweepPartials: apaga só ".part" antigos, em subpastas, sem tocar em LUTs nem em temporários recentes', async () => {
  const { root } = setup();
  const lutsDir = path.join(root, 'luts');
  fs.mkdirSync(path.join(lutsDir, 'A', 'B'), { recursive: true });
  const old = [path.join(lutsDir, '.a.cube.aaaaaaaaaaaa.part'), path.join(lutsDir, 'A', 'B', '.b.cube.bbbbbbbbbbbb.part')];
  const fresh = path.join(lutsDir, 'A', '.novo.cube.cccccccccccc.part');
  const keep = [path.join(lutsDir, 'a.cube'), path.join(lutsDir, 'A', 'nota.part'), path.join(lutsDir, '.hash-cache.json')];
  for (const p of [...old, fresh, ...keep]) fs.writeFileSync(p, 'x');
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const p of old) fs.utimesSync(p, past, past);
  assert.equal(await sweepPartials(lutsDir), 2);
  for (const p of old) assert.ok(!fs.existsSync(p), p);
  for (const p of [fresh, ...keep]) assert.ok(fs.existsSync(p), p);
  assert.equal(await sweepPartials(path.join(root, 'nao-existe')), 0);
});

test('sweepPartials: não segue junção/link para fora da coleção', async (t) => {
  const { root } = setup();
  const lutsDir = path.join(root, 'luts');
  const outside = path.join(root, 'fora');
  fs.mkdirSync(lutsDir);
  fs.mkdirSync(outside);
  const victim = path.join(outside, '.v.cube.dddddddddddd.part');
  fs.writeFileSync(victim, 'x');
  const past = new Date(Date.now() - 5 * 60 * 60 * 1000);
  fs.utimesSync(victim, past, past);
  try { fs.symlinkSync(outside, path.join(lutsDir, 'atalho'), 'junction'); } catch (err) { t.skip('o sistema não permite criar links aqui'); return; }
  assert.equal(await sweepPartials(lutsDir), 0);
  assert.ok(fs.existsSync(victim));
});
