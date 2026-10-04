// Contraste WCAG para a cor de destaque escolhida pelo usuário: gera variantes legíveis
// (texto em destaque sobre o fundo do tema e fundo de botão com texto branco) sem mudar a identidade da cor.

function parse(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function toHex(rgb) {
  return `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(rgb) {
  const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}

/** Razão de contraste WCAG entre duas cores "#rrggbb" (1 a 21). */
export function contrastRatio(hexA, hexB) {
  const l1 = luminance(parse(hexA));
  const l2 = luminance(parse(hexB));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Aproxima `hex` de branco (toward='#ffffff') ou preto ('#000000') em passos de 4%
 * até atingir `min` de contraste contra `against`. Devolve a própria cor se já passar.
 */
export function toneForContrast(hex, against, min = 4.5, toward = '#000000') {
  const from = parse(hex);
  const to = parse(toward);
  for (let t = 0; t <= 1.0001; t += 0.04) {
    const candidate = toHex(from.map((v, i) => v + (to[i] - v) * t));
    if (contrastRatio(candidate, against) >= min) return candidate;
  }
  return toward;
}
