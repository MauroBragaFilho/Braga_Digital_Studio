'use strict';

/**
 * Paleta FIXA de cores de destaque (a escolha livre foi removida). Os tons por tema ficam em
 * renderer/utils/accent-palette.js; aqui só os valores base, para validar no processo principal.
 * Um teste garante que as duas listas coincidem.
 */

const DEFAULT_ACCENT = '#ff0000';

const ACCENT_PALETTE = [
  { id: 'vermelho', hex: '#ff0000' },
  { id: 'rosa', hex: '#ff2d8a' },
  { id: 'azul', hex: '#1a73e8' },
  { id: 'verde', hex: '#00a651' },
  { id: 'laranja', hex: '#ff6a00' }
];

const HEX6 = /^#[0-9a-f]{6}$/;

function rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** Matiz (0 a 360) e saturação (0 a 1) de um hex. */
function hueSat(hex) {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const l = (max + min) / 2;
  return { h, s: d / (1 - Math.abs(2 * l - 1)) };
}

/**
 * Qualquer valor salvo vira o hex de uma opção da paleta: a de matiz mais próximo (o antigo #e53935 e cores livres);
 * cinzas/neutros e valor inválido (não-texto, formato errado) voltam ao padrão (Vermelho).
 */
function normalizeAccentColor(value) {
  if (typeof value !== 'string') return DEFAULT_ACCENT;
  const v = value.trim().toLowerCase();
  if (!HEX6.test(v)) return DEFAULT_ACCENT;
  const exact = ACCENT_PALETTE.find((o) => o.hex === v);
  if (exact) return exact.hex;
  const { h, s } = hueSat(v);
  if (s < 0.2) return DEFAULT_ACCENT;
  let best = ACCENT_PALETTE[0];
  let bestDist = Infinity;
  for (const opt of ACCENT_PALETTE) {
    const diff = Math.abs(h - hueSat(opt.hex).h);
    const d = Math.min(diff, 360 - diff);
    if (d < bestDist) { bestDist = d; best = opt; }
  }
  return best.hex;
}

module.exports = { DEFAULT_ACCENT, ACCENT_PALETTE, normalizeAccentColor };
