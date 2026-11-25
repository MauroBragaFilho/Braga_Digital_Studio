/**
 * Núcleo numérico das LUTs no renderer (sem DOM, testável em Node): a LUT aplicada sobre pixels RGBA e um cache LRU
 * limitado por bytes.
 *
 * A tabela chega do processo principal como Float32Array compacto (`luts:parse`): R, G, B de cada linha em sequência,
 * com R variando mais rápido (índice do .cube: r + g·n + b·n²). Também se aceita a tabela como lista de linhas
 * [r, g, b] (convertida uma vez e guardada). O DOMÍNIO da LUT (DOMAIN_MIN/DOMAIN_MAX ou LUT_*_INPUT_RANGE) decide que
 * faixa de entrada a tabela cobre: o que está fora dela é limitado às pontas; sem domínio vale 0 a 1.
 */

/** Teto de memória das LUTs interpretadas guardadas na tela (uma 33³ ocupa ~0,4 MB; uma 65³, ~3,3 MB). */
export const PARSED_CACHE_MAX_BYTES = 96 * 1024 * 1024;

const clamp255 = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
const isTriple = (a) => Array.isArray(a) && a.length === 3 && a.every((v) => typeof v === 'number' && Number.isFinite(v));

const flatCache = new WeakMap(); // lista de linhas -> Float32Array já convertido

/** A tabela como Float32Array (r, g, b em sequência), ou null se não houver tabela. */
export function toFlat(data) {
  if (!data) return null;
  if (data instanceof Float32Array) return data;
  if (!Array.isArray(data) && !ArrayBuffer.isView(data)) return null;
  if (!Array.isArray(data)) return Float32Array.from(data);
  if (!data.length) return null;
  const cached = flatCache.get(data);
  if (cached) return cached;
  let flat;
  if (Array.isArray(data[0])) {
    flat = new Float32Array(data.length * 3);
    for (let i = 0; i < data.length; i++) {
      const row = data[i] || data[0];
      flat[i * 3] = row[0];
      flat[i * 3 + 1] = row[1];
      flat[i * 3 + 2] = row[2];
    }
  } else {
    flat = Float32Array.from(data);
  }
  flatCache.set(data, flat);
  return flat;
}

/**
 * Faixa de entrada coberta pela tabela, por canal: { min: [r, g, b], max: [r, g, b] }.
 * DOMAIN_MIN/DOMAIN_MAX valem primeiro (cada um pode vir sozinho; o que faltar é 0 e 1); sem eles, vale a faixa de
 * LUT_1D_INPUT_RANGE/LUT_3D_INPUT_RANGE nos três canais. Canal com faixa inválida (máximo não maior que o mínimo) volta a 0..1.
 */
export function resolveDomain({ domainMin = null, domainMax = null, inputRange = null } = {}) {
  const valid = Array.isArray(inputRange) && inputRange.length === 2 && inputRange.every((v) => typeof v === 'number' && Number.isFinite(v));
  const base = valid ? inputRange : [0, 1]; // o que o DOMAIN_* não disser vem da faixa de entrada, senão 0..1
  const min = isTriple(domainMin) ? domainMin : [base[0], base[0], base[0]];
  const max = isTriple(domainMax) ? domainMax : [base[1], base[1], base[1]];
  const lo = [0, 0, 0];
  const hi = [1, 1, 1];
  for (let c = 0; c < 3; c++) {
    if (max[c] > min[c]) { lo[c] = min[c]; hi[c] = max[c]; }
  }
  return { min: lo, max: hi };
}

/**
 * Aplica a LUT nos pixels RGBA (muda o próprio array e o devolve). 3D: interpolação trilinear; 1D: curva por canal.
 * Sem tabela, com tamanho inválido ou com a tabela menor que o declarado, não muda nada.
 * @param {Uint8ClampedArray|Uint8Array|null} pixels
 * @param {{ data: Float32Array|number[][]|number[], size: number, is1D?: boolean, domainMin?: number[]|null, domainMax?: number[]|null, inputRange?: number[]|null }} lut
 */
export function applyLutToPixels(pixels, lut) {
  if (!pixels || !lut || !lut.size) return pixels;
  const size = lut.size;
  const is1D = !!lut.is1D;
  const table = toFlat(lut.data);
  const entries = is1D ? size : size * size * size;
  if (!table || !Number.isInteger(size) || size < 2 || table.length < entries * 3) return pixels;

  const { min, max } = resolveDomain(lut);
  const top = size - 1;
  const scale = [top / (max[0] - min[0]), top / (max[1] - min[1]), top / (max[2] - min[2])];
  const at = (v, c) => { // posição do valor (0..255) dentro da tabela, de 0 a size-1
    const t = (v / 255 - min[c]) * scale[c];
    return t <= 0 ? 0 : t >= top ? top : t;
  };

  if (is1D) {
    for (let p = 0; p < pixels.length; p += 4) {
      for (let c = 0; c < 3; c++) {
        const t = at(pixels[p + c], c);
        const i0 = Math.floor(t);
        const i1 = Math.min(i0 + 1, top);
        const f = t - i0;
        pixels[p + c] = clamp255(table[i0 * 3 + c] * (1 - f) + table[i1 * 3 + c] * f);
      }
    }
    return pixels;
  }

  const plane = size * size;
  for (let p = 0; p < pixels.length; p += 4) {
    const rn = at(pixels[p], 0);
    const gn = at(pixels[p + 1], 1);
    const bn = at(pixels[p + 2], 2);
    const r0 = Math.floor(rn); const g0 = Math.floor(gn); const b0 = Math.floor(bn);
    const r1 = Math.min(r0 + 1, top); const g1 = Math.min(g0 + 1, top); const b1 = Math.min(b0 + 1, top);
    const rf = rn - r0; const gf = gn - g0; const bf = bn - b0;
    const o000 = (r0 + g0 * size + b0 * plane) * 3; const o100 = (r1 + g0 * size + b0 * plane) * 3;
    const o010 = (r0 + g1 * size + b0 * plane) * 3; const o110 = (r1 + g1 * size + b0 * plane) * 3;
    const o001 = (r0 + g0 * size + b1 * plane) * 3; const o101 = (r1 + g0 * size + b1 * plane) * 3;
    const o011 = (r0 + g1 * size + b1 * plane) * 3; const o111 = (r1 + g1 * size + b1 * plane) * 3;
    for (let c = 0; c < 3; c++) {
      const x00 = table[o000 + c] * (1 - rf) + table[o100 + c] * rf;
      const x01 = table[o001 + c] * (1 - rf) + table[o101 + c] * rf;
      const x10 = table[o010 + c] * (1 - rf) + table[o110 + c] * rf;
      const x11 = table[o011 + c] * (1 - rf) + table[o111 + c] * rf;
      const y0 = x00 * (1 - gf) + x10 * gf;
      const y1 = x01 * (1 - gf) + x11 * gf;
      pixels[p + c] = clamp255(y0 * (1 - bf) + y1 * bf);
    }
  }
  return pixels;
}

/** Quantos bytes uma LUT interpretada ocupa na memória (a tabela; o resto é desprezível). */
export function lutBytes(parsed) {
  const data = parsed && parsed.data;
  if (!data) return 0;
  if (typeof data.byteLength === 'number') return data.byteLength;
  return (data.length || 0) * 24; // lista de linhas [r, g, b]: estimativa
}

/**
 * Cache LRU limitado por BYTES (não por quantidade): ao passar do teto sai o menos usado, nunca a entrada que acabou de
 * entrar (uma só LUT enorme continua utilizável). `set` aceita o tamanho já conhecido ou 0 e corrigido depois com `setBytes`
 * (útil para promessas que só têm tamanho quando resolvem).
 * @param {number} maxBytes
 */
export function createByteLru(maxBytes) {
  const map = new Map(); // chave -> { value, bytes }; a ordem de inserção é a do uso (o mais antigo vem primeiro)
  let total = 0;
  const evict = (keep) => {
    for (const [key, entry] of map) {
      if (total <= maxBytes) break;
      if (key === keep) continue;
      map.delete(key);
      total -= entry.bytes;
    }
  };
  return {
    has: (key) => map.has(key),
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      map.delete(key);
      map.set(key, entry); // marca como recém-usado
      return entry.value;
    },
    set(key, value, bytes = 0) {
      const old = map.get(key);
      if (old) { total -= old.bytes; map.delete(key); }
      map.set(key, { value, bytes });
      total += bytes;
      evict(key);
    },
    setBytes(key, bytes) {
      const entry = map.get(key);
      if (!entry) return;
      total += bytes - entry.bytes;
      entry.bytes = bytes;
      evict(key);
    },
    delete(key) {
      const entry = map.get(key);
      if (!entry) return false;
      total -= entry.bytes;
      return map.delete(key);
    },
    clear() { map.clear(); total = 0; },
    get size() { return map.size; },
    get bytes() { return total; }
  };
}
