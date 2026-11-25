'use strict';

// Miniaturas de LUTs (renderer/utils/lutThumb.js): a conta da LUT sobre os pixels (3D trilinear e 1D, mesma ordem de
// eixos do .cube) e o serviço de miniaturas (cache por conteúdo, no máximo duas ao mesmo tempo, nunca lança).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
require('./helpers/renderer-harness'); // silencia o aviso de módulo ESM sem "type"

const MODULE = pathToFileURL(path.join(__dirname, '..', 'renderer', 'utils', 'lutThumb.js')).href;
const load = () => import(MODULE);

/** Tabela 3D de tamanho 2 (R varia mais rápido, depois G, depois B). */
const table2 = (f) => { const rows = []; for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(f(r, g, b)); return rows; };
const pixel = (r, g, b) => new Uint8ClampedArray([r, g, b, 255]);

test('3D: a LUT identidade não muda os pixels', async () => {
  const { applyLutToPixels } = await load();
  const identity = { size: 2, is1D: false, data: table2((r, g, b) => [r, g, b]) };
  const p = new Uint8ClampedArray([255, 0, 128, 255, 10, 200, 30, 255]);
  applyLutToPixels(p, identity);
  assert.deepEqual([...p], [255, 0, 128, 255, 10, 200, 30, 255]);
});

test('3D: a ordem dos eixos é a do .cube (R varia mais rápido) e o canal alfa não muda', async () => {
  const { applyLutToPixels } = await load();
  // saída = (0, 0, r): só o vermelho da ENTRADA vai para o azul da saída
  const redToBlue = { size: 2, data: table2((r) => [0, 0, r]) };
  const p = pixel(255, 7, 9);
  applyLutToPixels(p, redToBlue);
  assert.deepEqual([...p], [0, 0, 255, 255]);
  // saída = (g, 0, 0) e saída = (b, 0, 0): confere G e B
  const g = pixel(0, 255, 0); applyLutToPixels(g, { size: 2, data: table2((r, gg) => [gg, 0, 0]) });
  assert.deepEqual([...g], [255, 0, 0, 255]);
  const b = pixel(0, 0, 255); applyLutToPixels(b, { size: 2, data: table2((r, gg, bb) => [bb, 0, 0]) });
  assert.deepEqual([...b], [255, 0, 0, 255]);
  const none = pixel(255, 255, 0); applyLutToPixels(none, { size: 2, data: table2((r, gg, bb) => [bb, 0, 0]) });
  assert.deepEqual([...none], [0, 0, 0, 255], 'sem azul na entrada, a saída é zero');
});

test('3D: interpolação trilinear no meio do cubo e valores fora de 0..1 são limitados', async () => {
  const { applyLutToPixels } = await load();
  const invert = { size: 2, data: table2((r, g, b) => [1 - r, 1 - g, 1 - b]) };
  const mid = pixel(128, 64, 255);
  applyLutToPixels(mid, invert);
  assert.deepEqual([...mid], [127, 191, 0, 255]);
  const boost = { size: 2, data: table2((r) => [r * 2, -0.5, 1.5]) };
  const clipped = pixel(255, 0, 0);
  applyLutToPixels(clipped, boost);
  assert.deepEqual([...clipped], [255, 0, 255, 255], '2,0 vira 255; -0,5 vira 0; 1,5 vira 255');
});

test('3D: tamanho maior (17) com uma tabela de inversão confere pixel a pixel', async () => {
  const { applyLutToPixels } = await load();
  const n = 17;
  const data = [];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) data.push([1 - r / (n - 1), 1 - g / (n - 1), 1 - b / (n - 1)]);
  const lut = { size: n, data };
  for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [16, 32, 240], [100, 100, 100]]) {
    const p = pixel(r, g, b);
    applyLutToPixels(p, lut);
    assert.deepEqual([...p], [255 - r, 255 - g, 255 - b, 255], `pixel ${r},${g},${b}`);
  }
});

test('1D: curva por canal, identidade e inversão', async () => {
  const { applyLutToPixels } = await load();
  const ident = { size: 2, is1D: true, data: [[0, 0, 0], [1, 1, 1]] };
  const p = pixel(10, 128, 250);
  applyLutToPixels(p, ident);
  assert.deepEqual([...p], [10, 128, 250, 255]);
  const inv = { size: 2, is1D: true, data: [[1, 1, 1], [0, 0, 0]] };
  const q = pixel(0, 255, 128);
  applyLutToPixels(q, inv);
  assert.deepEqual([...q], [255, 0, 127, 255]);
  // cada canal tem a sua curva: só o verde é invertido
  const onlyGreen = { size: 2, is1D: true, data: [[0, 1, 0], [1, 0, 1]] };
  const r = pixel(255, 255, 0);
  applyLutToPixels(r, onlyGreen);
  assert.deepEqual([...r], [255, 0, 0, 255]);
});

test('entrada vazia ou sem tabela não muda nem lança', async () => {
  const { applyLutToPixels } = await load();
  const p = pixel(1, 2, 3);
  assert.doesNotThrow(() => applyLutToPixels(p, { size: 0, data: [] }));
  assert.doesNotThrow(() => applyLutToPixels(null, { size: 2, data: [[0, 0, 0]] }));
  assert.deepEqual([...p], [1, 2, 3, 255]);
});

// ─── Serviço de miniaturas ───────────────────────────────────────────────────────────────────────

const GOOD = { ok: true, size: 2, is1D: false, data: table2((r, g, b) => [r, g, b]) };
function fakes(over = {}) {
  const log = { parse: [], canvases: [], images: [], active: 0, maxActive: 0 };
  const bds = {
    parseLutCube: async (p) => {
      log.parse.push(p);
      log.active++; log.maxActive = Math.max(log.maxActive, log.active);
      await new Promise((r) => setTimeout(r, over.delay ?? 0));
      log.active--;
      return typeof over.parse === 'function' ? over.parse(p) : GOOD;
    },
    getLutReferenceImage: async (f) => `data:image/png;base64,${f.length}`,
    ...(over.bds || {})
  };
  const options = {
    getBds: () => bds,
    getSettings: () => (over.settings ? over.settings() : {}),
    loadImage: async (src) => { log.images.push(src); return { naturalWidth: 640, naturalHeight: 360 }; },
    makeCanvas: () => {
      const c = {
        width: 0, height: 0,
        getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(128) }), putImageData() {} }),
        toDataURL: () => `data:image/jpeg;base64,${log.canvases.length}`
      };
      log.canvases.push(c);
      return c;
    }
  };
  return { log, options };
}

test('miniatura: gera uma vez por conteúdo e reaproveita; o tamanho respeita o maior lado', async () => {
  const { createLutThumbs } = await load();
  const { log, options } = fakes();
  const thumbs = createLutThumbs({ ...options, maxDim: 112 });
  const a = await thumbs.thumb('hash-a', 'C:\\LUTs\\a.cube');
  assert.match(a, /^data:image\/jpeg;base64,/);
  assert.equal(log.canvases[0].width, 112);
  assert.equal(log.canvases[0].height, 63, '640x360 reduzido ao maior lado de 112, na mesma proporção');
  const again = await thumbs.thumb('hash-a', 'C:\\LUTs\\copia-idêntica.cube');
  assert.equal(again, a);
  assert.deepEqual(log.parse, ['C:\\LUTs\\a.cube'], 'a mesma chave (o mesmo conteúdo) não é lida de novo');
  assert.equal(log.images.length, 1, 'a imagem de referência é carregada uma vez');
});

test('miniaturas pedidas juntas: no máximo duas ao mesmo tempo e a mesma chave não duplica o trabalho', async () => {
  const { createLutThumbs } = await load();
  const { log, options } = fakes({ delay: 15 });
  const thumbs = createLutThumbs(options);
  const results = await Promise.all([
    thumbs.thumb('k1', 'p1'), thumbs.thumb('k2', 'p2'), thumbs.thumb('k3', 'p3'), thumbs.thumb('k4', 'p4'), thumbs.thumb('k5', 'p5'), thumbs.thumb('k1', 'p1')
  ]);
  assert.ok(results.every((r) => typeof r === 'string'));
  assert.equal(log.maxActive, 2);
  assert.equal(log.parse.length, 5);
});

test('LUT que não pôde ser lida: devolve null, sem lançar e sem tentar de novo em laço', async () => {
  const { createLutThumbs } = await load();
  const { log, options } = fakes({ parse: () => ({ ok: false, code: 'ROWS', reason: 'linhas' }) });
  const thumbs = createLutThumbs(options);
  assert.equal(await thumbs.thumb('ruim', 'p'), null);
  assert.equal(await thumbs.thumb('ruim', 'p'), null);
  assert.equal(log.parse.length, 1);
  // erro do canal e canvas que falha também viram null
  const boom = fakes({ bds: { parseLutCube: async () => { throw new Error('x'); } } });
  assert.equal(await createLutThumbs(boom.options).thumb('k', 'p'), null);
  const noCanvas = fakes();
  noCanvas.options.makeCanvas = () => { throw new Error('sem canvas'); };
  assert.equal(await createLutThumbs(noCanvas.options).thumb('k', 'p'), null);
  const noCtx = fakes();
  noCtx.options.makeCanvas = () => ({ getContext: () => null });
  assert.equal(await createLutThumbs(noCtx.options).thumb('k', 'p'), null);
});

test('imagem de referência das Configurações: usada quando existe; trocar refaz as miniaturas', async () => {
  const { createLutThumbs, DEFAULT_BASE_IMAGE } = await load();
  let setting = '';
  const { log, options } = fakes({ settings: () => ({ lutPreviewImage: setting }) });
  const thumbs = createLutThumbs(options);
  await thumbs.thumb('k', 'p');
  assert.deepEqual(log.images, [DEFAULT_BASE_IMAGE]);
  setting = 'C:\\img\\ref.jpg';
  await thumbs.thumb('k', 'p');
  assert.equal(log.images.at(-1), `data:image/png;base64,${setting.length}`, 'a imagem escolhida entra pelo canal do main (data URL)');
  assert.equal(log.parse.length, 2, 'com outra imagem de referência a miniatura é refeita');
  // a imagem escolhida não carrega: volta para a padrão
  const failing = fakes({ settings: () => ({ lutPreviewImage: 'C:\\x.jpg' }), bds: { getLutReferenceImage: async () => null } });
  await createLutThumbs(failing.options).thumb('k', 'p');
  assert.deepEqual(failing.log.images, [DEFAULT_BASE_IMAGE]);
});

test('o cache é limitado (as mais antigas saem)', async () => {
  const { createLutThumbs } = await load();
  const { options } = fakes();
  const thumbs = createLutThumbs(options);
  for (let i = 0; i < 130; i++) await thumbs.thumb(`k${i}`, `p${i}`);
  assert.equal(thumbs.size, 100);
  thumbs.clear();
  assert.equal(thumbs.size, 0);
});
