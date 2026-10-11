'use strict';

/**
 * FFT radix-2 (iterativa, in-place) e correlação cruzada normalizada via FFT, usadas pela sincronização
 * multicâmera: encontrar ONDE um clipe curto está dentro de uma gravação longa (horas) custa O(N log N) em vez
 * de O(N·M). Trabalha sobre envelopes de energia (poucas dezenas de amostras por segundo), não sobre PCM.
 */

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** FFT in-place sobre (re, im) de tamanho potência de 2. `inverse` = IFFT (já dividida por N). */
function fft(re, im, inverse = false) {
  const n = re.length;
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1; let cIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const a = i + j; const b = a + half;
        const tRe = re[b] * cRe - im[b] * cIm;
        const tIm = re[b] * cIm + im[b] * cRe;
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe; im[a] += tIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/** Reduz um envelope por média de blocos (ex.: 20 ms → 100 ms com factor 5). */
function downsample(env, factor) {
  if (factor <= 1) return Float32Array.from(env);
  const out = new Float32Array(Math.ceil(env.length / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0; let n = 0;
    for (let j = i * factor; j < Math.min(env.length, (i + 1) * factor); j++) { s += env[j]; n++; }
    out[i] = n ? s / n : 0;
  }
  return out;
}

/**
 * Onde `target` (curto) melhor se encaixa dentro de `master` (longo)? Devolve o deslocamento em AMOSTRAS
 * (target[0] corresponde a master[shift]; pode ser negativo quando o clipe começa antes do master) e a
 * correlação normalizada (0 a 1) nesse ponto, calculada com a energia local do master.
 * `minOverlap` = fração mínima do clipe que precisa sobrepor o master para o deslocamento valer.
 */
function fftCrossCorrelate(master, target, { minOverlap = 0.3 } = {}) {
  const M = master.length; const T = target.length;
  if (!M || !T) return { shift: 0, confidence: 0 };
  const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
  const mMean = mean(master); const tMean = mean(target);
  const N = nextPow2(M + T);
  const xr = new Float64Array(N); const xi = new Float64Array(N);
  const yr = new Float64Array(N); const yi = new Float64Array(N);
  for (let i = 0; i < M; i++) xr[i] = master[i] - mMean;
  for (let i = 0; i < T; i++) yr[i] = target[i] - tMean;
  fft(xr, xi); fft(yr, yi);
  // X · conj(Y)
  for (let i = 0; i < N; i++) {
    const a = xr[i]; const b = xi[i]; const c = yr[i]; const d = -yi[i];
    xr[i] = a * c - b * d; xi[i] = a * d + b * c;
  }
  fft(xr, xi, true); // xr[k] = Σ_t x[t+k]·y[t]  (k negativo em N+k)

  // energia do master por prefixo, para normalizar cada janela candidata
  const prefix = new Float64Array(M + 1);
  for (let i = 0; i < M; i++) { const v = master[i] - mMean; prefix[i + 1] = prefix[i] + v * v; }
  let tEnergy = 0;
  for (let i = 0; i < T; i++) { const v = target[i] - tMean; tEnergy += v * v; }
  if (tEnergy < 1e-9) return { shift: 0, confidence: 0 };

  const minOv = Math.max(1, Math.round(T * minOverlap));
  let best = -Infinity; let bestShift = 0;
  for (let k = -(T - minOv); k <= M - minOv; k++) {
    const idx = k >= 0 ? k : N + k;
    const a = Math.max(0, k); const b = Math.min(M, k + T); // trecho do master coberto
    const ov = b - a;
    if (ov < minOv) continue;
    const mEnergy = prefix[b] - prefix[a];
    if (mEnergy < 1e-9) continue;
    // normaliza pela energia das duas partes sobrepostas (aprox.: energia total do target)
    const score = xr[idx] / Math.sqrt(mEnergy * tEnergy) * Math.min(1, T / ov);
    if (score > best) { best = score; bestShift = k; }
  }
  if (best === -Infinity) return { shift: 0, confidence: 0 };
  return { shift: bestShift, confidence: Math.max(0, Math.min(1, best)) };
}

module.exports = { fft, nextPow2, downsample, fftCrossCorrelate };
