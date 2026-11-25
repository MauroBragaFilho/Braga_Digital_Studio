/**
 * Miniaturas de LUTs: a LUT aplicada de verdade sobre a imagem de referência (a padrão ou a escolhida nas Configurações),
 * pequena, para listas (cartão "LUTs" do projeto e escolha de LUTs). A interpretação do .cube vem do processo
 * principal (`parseLutCube`); aqui só se aplica a tabela (3D trilinear ou 1D por canal) e se guarda o resultado.
 *
 * - cache por conteúdo (a chave que a tela informa, normalmente o hash da LUT): a mesma LUT não é refeita;
 * - no máximo duas miniaturas sendo geradas ao mesmo tempo (a tela continua fluida);
 * - nunca lança: sem miniatura devolve null e a tela mostra o ícone.
 *
 * Mesma conta da prévia da tela de LUTs (renderer/utils/lutCore.js: índice do .cube r + g·n + b·n² e o domínio de
 * entrada da LUT), para a miniatura e a prévia combinarem.
 */

import { applyLutToPixels } from './lutCore.js';

export { applyLutToPixels };
export const DEFAULT_BASE_IMAGE = './assets/lut_preview.jpg';
const CACHE_MAX = 100;
const CONCURRENCY = 2;

function defaultLoadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = src;
  });
}

/**
 * @param {{
 *   getBds?: () => any,                      // window.bds (parseLutCube, getLutReferenceImage)
 *   getSettings?: () => { lutPreviewImage?: string },
 *   makeCanvas?: () => HTMLCanvasElement,
 *   loadImage?: (src: string) => Promise<HTMLImageElement>,
 *   maxDim?: number                          // maior lado da miniatura, em pixels
 * }} [options]
 */
export function createLutThumbs({
  getBds = () => window.bds,
  getSettings = () => ({}),
  makeCanvas = () => document.createElement('canvas'),
  loadImage = defaultLoadImage,
  maxDim = 112
} = {}) {
  const cache = new Map();      // chave → dataURL (ou null: não foi possível)
  const inflight = new Map();   // chave → Promise
  const queue = [];
  let active = 0;
  let baseSetting = null;       // imagem de referência que gerou `baseImage`
  let basePromise = null;

  const remember = (key, value) => {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  };

  const wantedSetting = () => String((getSettings() || {}).lutPreviewImage || '').trim();

  /** A imagem de referência atual (a das Configurações, se houver; senão a padrão). Trocou: as miniaturas são refeitas. */
  async function baseImage() {
    const wanted = wantedSetting();
    if (basePromise && wanted === baseSetting) return basePromise;
    if (baseSetting !== null && wanted !== baseSetting) cache.clear();
    baseSetting = wanted;
    basePromise = (async () => {
      let src = DEFAULT_BASE_IMAGE;
      const bds = getBds();
      if (wanted && bds && typeof bds.getLutReferenceImage === 'function') {
        try { src = (await bds.getLutReferenceImage(wanted)) || DEFAULT_BASE_IMAGE; } catch (_) { src = DEFAULT_BASE_IMAGE; }
      }
      try { return await loadImage(src); } catch (_) { return src === DEFAULT_BASE_IMAGE ? null : loadImage(DEFAULT_BASE_IMAGE); }
    })();
    basePromise.catch(() => { basePromise = null; });
    return basePromise;
  }

  async function render(path) {
    const bds = getBds();
    if (!bds || typeof bds.parseLutCube !== 'function') return null;
    const parsed = await bds.parseLutCube(path);
    if (!parsed || parsed.ok !== true || !parsed.data || !parsed.size) return null;
    const img = await baseImage();
    if (!img) return null;
    let w = img.naturalWidth || img.width || maxDim;
    let h = img.naturalHeight || img.height || Math.round(maxDim * 9 / 16);
    const scale = Math.min(1, maxDim / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const canvas = makeCanvas();
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    applyLutToPixels(frame.data, parsed);
    ctx.putImageData(frame, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      const job = queue.shift();
      active++;
      job().finally(() => { active--; pump(); });
    }
  }

  return {
    /**
     * Miniatura (data URL) da LUT ou null.
     * @param {string} key - identifica o CONTEÚDO (o hash da LUT); a mesma chave não é refeita
     * @param {string} path - caminho da LUT na coleção (o processo principal confere que está lá dentro)
     * @returns {Promise<string|null>}
     */
    thumb(key, path) {
      if (baseSetting !== null && wantedSetting() !== baseSetting) cache.clear(); // outra imagem de referência: nada do que está guardado vale
      if (cache.has(key)) { const hit = cache.get(key); remember(key, hit); return Promise.resolve(hit); }
      if (inflight.has(key)) return inflight.get(key);
      const promise = new Promise((resolve) => {
        queue.push(async () => {
          let url = null;
          try { url = await render(path); } catch (err) { console.warn('[LUT] miniatura não gerada:', err && err.message); }
          remember(key, url);
          inflight.delete(key);
          resolve(url);
        });
      });
      inflight.set(key, promise);
      pump();
      return promise;
    },
    /** Esquece as miniaturas (a imagem de referência mudou). */
    clear() { cache.clear(); },
    /** Quantas miniaturas estão guardadas (para teste). */
    get size() { return cache.size; }
  };
}
