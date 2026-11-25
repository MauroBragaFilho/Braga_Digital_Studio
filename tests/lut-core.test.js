'use strict';

// Núcleo numérico das LUTs no renderer (renderer/utils/lutCore.js), em Node puro: ordem dos eixos, limite 0..255,
// 1D por canal, DOMÍNIO da LUT (DOMAIN_MIN/MAX e faixa de entrada), Float32Array igual ao caminho de listas e o
// cache limitado por bytes.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
require('./helpers/renderer-harness'); // silencia o aviso de módulo ESM sem "type"

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'utils', 'lutCore.js')).href);
const pixel = (r, g, b) => new Uint8ClampedArray([r, g, b, 255]);

/** Tabela 3D de tamanho n em linhas [r, g, b] (R varia mais rápido), a partir de f(r, g, b) em 0..1. */
function rows3d(n, f) {
  const out = [];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) out.push(f(r / (n - 1), g / (n - 1), b / (n - 1)));
  return out;
}
const flat = (rows) => Float32Array.from(rows.flat());
const identity = (n) => rows3d(n, (r, g, b) => [r, g, b]);

test('3D: identidade não muda; a ordem dos eixos é a do .cube (R mais rápido) e o alfa fica', async () => {
  const { applyLutToPixels } = await load();
  const p = new Uint8ClampedArray([255, 0, 128, 255, 10, 200, 30, 7]);
  applyLutToPixels(p, { size: 2, data: flat(identity(2)) });
  assert.deepEqual([...p], [255, 0, 128, 255, 10, 200, 30, 7]);
  const redToBlue = pixel(255, 7, 9); applyLutToPixels(redToBlue, { size: 2, data: flat(rows3d(2, (r) => [0, 0, r])) });
  assert.deepEqual([...redToBlue], [0, 0, 255, 255]);
  const g = pixel(0, 255, 0); applyLutToPixels(g, { size: 2, data: flat(rows3d(2, (r, gg) => [gg, 0, 0])) });
  assert.deepEqual([...g], [255, 0, 0, 255]);
  const b = pixel(0, 0, 255); applyLutToPixels(b, { size: 2, data: flat(rows3d(2, (r, gg, bb) => [bb, 0, 0])) });
  assert.deepEqual([...b], [255, 0, 0, 255]);
});

test('3D: valores fora de 0..1 na saída são limitados (2,0 vira 255; -0,5 vira 0)', async () => {
  const { applyLutToPixels } = await load();
  const p = pixel(255, 0, 0);
  applyLutToPixels(p, { size: 2, data: flat(rows3d(2, (r) => [r * 2, -0.5, 1.5])) });
  assert.deepEqual([...p], [255, 0, 255, 255]);
});

test('3D: a trilinear no meio do cubo e a inversão de 17³ conferem pixel a pixel', async () => {
  const { applyLutToPixels } = await load();
  const mid = pixel(128, 64, 255);
  applyLutToPixels(mid, { size: 2, data: flat(rows3d(2, (r, g, b) => [1 - r, 1 - g, 1 - b])) });
  assert.deepEqual([...mid], [127, 191, 0, 255]);
  const lut = { size: 17, data: flat(rows3d(17, (r, g, b) => [1 - r, 1 - g, 1 - b])) };
  for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [16, 32, 240], [100, 100, 100]]) {
    const p = pixel(r, g, b);
    applyLutToPixels(p, lut);
    assert.deepEqual([...p], [255 - r, 255 - g, 255 - b, 255], `pixel ${r},${g},${b}`);
  }
});

test('1D: curva por canal (identidade, inversão e curva diferente em cada canal)', async () => {
  const { applyLutToPixels } = await load();
  const p = pixel(10, 128, 250);
  applyLutToPixels(p, { size: 2, is1D: true, data: flat([[0, 0, 0], [1, 1, 1]]) });
  assert.deepEqual([...p], [10, 128, 250, 255]);
  const q = pixel(0, 255, 128);
  applyLutToPixels(q, { size: 2, is1D: true, data: flat([[1, 1, 1], [0, 0, 0]]) });
  assert.deepEqual([...q], [255, 0, 127, 255]);
  const r = pixel(255, 255, 0);
  applyLutToPixels(r, { size: 2, is1D: true, data: flat([[0, 1, 0], [1, 0, 1]]) });
  assert.deepEqual([...r], [255, 0, 0, 255], 'só o verde é invertido');
  // 1D com mais pontos: a meia-tinta cai entre dois pontos
  const s = pixel(128, 128, 128);
  applyLutToPixels(s, { size: 5, is1D: true, data: flat([[0, 0, 0], [0.1, 0.1, 0.1], [0.2, 0.2, 0.2], [0.3, 0.3, 0.3], [1, 1, 1]]) });
  assert.ok(s[0] > 50 && s[0] < 80, `valor ${s[0]}`);
});

test('Float32Array e lista de linhas dão exatamente o mesmo resultado (3D e 1D)', async () => {
  const { applyLutToPixels } = await load();
  const rows = rows3d(9, (r, g, b) => [Math.sqrt(r), g * g, (r + g + b) / 3]);
  const pixels = () => { const a = new Uint8ClampedArray(4 * 64); for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256; return a; };
  const a = pixels(); applyLutToPixels(a, { size: 9, data: rows });
  const b = pixels(); applyLutToPixels(b, { size: 9, data: Float32Array.from(rows.flat()) });
  assert.deepEqual([...a], [...b]);
  const curve = Array.from({ length: 16 }, (_, i) => [i / 15, (i / 15) ** 2, 1 - i / 15]);
  const c = pixels(); applyLutToPixels(c, { size: 16, is1D: true, data: curve });
  const d = pixels(); applyLutToPixels(d, { size: 16, is1D: true, data: Float32Array.from(curve.flat()) });
  assert.deepEqual([...c], [...d]);
  // lista de números planos (r, g, b em sequência) também vale
  const e = pixels(); applyLutToPixels(e, { size: 9, data: rows.flat() });
  assert.deepEqual([...a], [...e]);
});

test('tamanhos 17³, 33³ e 65³ sintéticos: identidade devolve o mesmo pixel (até 1 nível) e a conta é rápida', async () => {
  const { applyLutToPixels } = await load();
  for (const n of [17, 33, 65]) {
    const data = flat(identity(n));
    const pixels = new Uint8ClampedArray(4 * 640 * 360);
    for (let i = 0; i < pixels.length; i += 4) { pixels[i] = (i / 4) % 256; pixels[i + 1] = (i / 4 * 7) % 256; pixels[i + 2] = (i / 4 * 13) % 256; pixels[i + 3] = 255; }
    const before = Uint8ClampedArray.from(pixels);
    const started = Date.now();
    applyLutToPixels(pixels, { size: n, data });
    const ms = Date.now() - started;
    let worst = 0;
    for (let i = 0; i < pixels.length; i++) worst = Math.max(worst, Math.abs(pixels[i] - before[i]));
    assert.ok(worst <= 1, `${n}³: diferença ${worst}`);
    assert.ok(ms < 3000, `${n}³ levou ${ms} ms`);
  }
});

test('domínio: DOMAIN_MAX 2 faz o branco da imagem cair no meio da tabela; DOMAIN_MIN negativo desloca a faixa', async () => {
  const { applyLutToPixels } = await load();
  const ident = flat(identity(2));
  const white = pixel(255, 255, 255);
  applyLutToPixels(white, { size: 2, data: ident, domainMin: [0, 0, 0], domainMax: [2, 2, 2] });
  assert.deepEqual([...white], [128, 128, 128, 255], '1,0 dentro de 0..2 é metade da tabela');
  const black = pixel(0, 0, 0);
  applyLutToPixels(black, { size: 2, data: ident, domainMin: [-1, -1, -1], domainMax: [1, 1, 1] });
  assert.deepEqual([...black], [128, 128, 128, 255], '0,0 dentro de -1..1 é metade da tabela');
  // domínio por canal
  const mixed = pixel(255, 255, 255);
  applyLutToPixels(mixed, { size: 2, data: ident, domainMin: [0, 0, 0], domainMax: [1, 2, 4] });
  assert.deepEqual([...mixed], [255, 128, 64, 255]);
  // sem domínio: 0 a 1
  const none = pixel(255, 0, 128);
  applyLutToPixels(none, { size: 2, data: ident });
  assert.deepEqual([...none], [255, 0, 128, 255]);
});

test('domínio 1D: LUT_1D_INPUT_RANGE vale; DOMAIN_* tem prioridade; faixa inválida volta a 0..1', async () => {
  const { applyLutToPixels, resolveDomain } = await load();
  const ident1d = { size: 2, is1D: true, data: flat([[0, 0, 0], [1, 1, 1]]) };
  const a = pixel(255, 255, 255);
  applyLutToPixels(a, { ...ident1d, inputRange: [0, 2] });
  assert.deepEqual([...a], [128, 128, 128, 255]);
  const b = pixel(255, 255, 255);
  applyLutToPixels(b, { ...ident1d, inputRange: [0, 2], domainMin: [0, 0, 0], domainMax: [4, 4, 4] });
  assert.deepEqual([...b], [64, 64, 64, 255], 'DOMAIN_* vence a faixa de entrada');
  assert.deepEqual(resolveDomain({ domainMin: [1, 1, 1], domainMax: [0, 0, 0] }), { min: [0, 0, 0], max: [1, 1, 1] });
  assert.deepEqual(resolveDomain({ domainMin: [0, 2, 0], domainMax: [3, 1, 4] }), { min: [0, 0, 0], max: [3, 1, 4] }, 'só o canal inválido (G) volta ao padrão 0..1');
  assert.deepEqual(resolveDomain({ inputRange: [0, 'x'] }), { min: [0, 0, 0], max: [1, 1, 1] });
  assert.deepEqual(resolveDomain(), { min: [0, 0, 0], max: [1, 1, 1] });
  assert.deepEqual(resolveDomain({ domainMax: [3, 3, 3] }), { min: [0, 0, 0], max: [3, 3, 3] }, 'DOMAIN_MAX sozinho');
});

test('entradas vazias, tabela menor que o declarado ou tamanho inválido não mudam nem lançam', async () => {
  const { applyLutToPixels } = await load();
  const p = pixel(1, 2, 3);
  assert.doesNotThrow(() => applyLutToPixels(p, { size: 0, data: [] }));
  assert.doesNotThrow(() => applyLutToPixels(null, { size: 2, data: [[0, 0, 0]] }));
  assert.doesNotThrow(() => applyLutToPixels(p, null));
  assert.doesNotThrow(() => applyLutToPixels(p, { size: 3, data: flat(identity(2)) }));
  assert.doesNotThrow(() => applyLutToPixels(p, { size: 2.5, data: flat(identity(2)) }));
  assert.doesNotThrow(() => applyLutToPixels(p, { size: 2, data: 'texto' }));
  assert.deepEqual([...p], [1, 2, 3, 255]);
});

test('toFlat: Float32Array passa direto; lista de linhas é convertida uma vez (cache)', async () => {
  const { toFlat } = await load();
  const f = new Float32Array([0, 1, 2]);
  assert.equal(toFlat(f), f);
  const rows = [[0, 0.5, 1], [1, 0.5, 0]];
  const a = toFlat(rows);
  assert.ok(a instanceof Float32Array);
  assert.deepEqual([...a], [0, 0.5, 1, 1, 0.5, 0]);
  assert.equal(toFlat(rows), a, 'mesma lista, mesma conversão');
  assert.equal(toFlat(null), null);
  assert.equal(toFlat([]), null);
});

test('cache por bytes: sai o menos usado ao passar do teto, a entrada nova nunca sai e get renova o uso', async () => {
  const { createByteLru } = await load();
  const lru = createByteLru(100);
  lru.set('a', 'A', 40);
  lru.set('b', 'B', 40);
  assert.equal(lru.bytes, 80);
  assert.equal(lru.get('a'), 'A'); // a fica como o mais recente
  lru.set('c', 'C', 40);
  assert.equal(lru.has('b'), false, 'b era o menos usado');
  assert.deepEqual([lru.has('a'), lru.has('c')], [true, true]);
  assert.equal(lru.bytes, 80);
  lru.set('enorme', 'E', 500); // maior que o teto: continua utilizável, mas tira o resto
  assert.deepEqual([lru.has('enorme'), lru.has('a'), lru.has('c'), lru.size], [true, false, false, 1]);
  lru.set('enorme', 'E2', 10); // substituir acerta a conta
  assert.equal(lru.bytes, 10);
  assert.equal(lru.get('nada'), undefined);
});

test('cache por bytes: tamanho corrigido depois (setBytes, para promessas), delete e clear mantêm a soma certa', async () => {
  const { createByteLru, lutBytes } = await load();
  const lru = createByteLru(100);
  lru.set('p', Promise.resolve(1), 0);
  lru.set('q', Promise.resolve(2), 0);
  lru.setBytes('p', 70);
  lru.setBytes('q', 70); // estoura: p (mais antigo) sai
  assert.equal(lru.has('p'), false);
  assert.equal(lru.bytes, 70);
  lru.setBytes('inexistente', 5);
  assert.equal(lru.bytes, 70);
  assert.equal(lru.delete('q'), true);
  assert.equal(lru.bytes, 0);
  lru.set('r', 1, 10);
  lru.clear();
  assert.deepEqual([lru.size, lru.bytes], [0, 0]);
  assert.equal(lutBytes({ data: new Float32Array(300) }), 1200);
  assert.equal(lutBytes({ data: [[0, 0, 0], [1, 1, 1]] }), 48);
  assert.equal(lutBytes({}), 0);
  assert.equal(lutBytes(null), 0);
});
