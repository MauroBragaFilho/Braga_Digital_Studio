// Paleta FIXA de cores de destaque (sem escolha livre). Cada opção traz os tons já calculados por tema,
// com contraste WCAG AA conferido nos testes (tests/accent-palette.test.js):
//   accent      cor da marca: anel de foco, indicadores, barras, ícones (>= 3:1 contra o fundo do tema)
//   hover       variação de passagem do mouse para o acento
//   text        texto/link em destaque sobre as superfícies do tema (>= 4,5:1)
//   solid       fundo de botão colorido com texto branco (>= 4,5:1 com #ffffff)
//   solidHover  fundo do botão colorido no hover (mais escuro, mantém o contraste)
//   light       translúcido para realce de item ativo/seleção
// Qualquer valor salvo que não seja da paleta vira o Vermelho (ou a opção mais próxima, ver nearestAccentId).

export const DEFAULT_ACCENT_ID = 'vermelho';

export const ACCENT_PALETTE = [
  {
    id: 'vermelho', name: 'Vermelho', hex: '#ff0000',
    dark: { accent: '#ff0000', hover: '#ff5959', text: '#ff7373', solid: '#eb0000', solidHover: '#c80000', light: 'rgba(255, 0, 0, 0.18)' },
    light: { accent: '#ff0000', hover: '#b80000', text: '#b80000', solid: '#eb0000', solidHover: '#c80000', light: 'rgba(255, 0, 0, 0.12)' }
  },
  {
    id: 'rosa', name: 'Rosa', hex: '#ff2d8a',
    dark: { accent: '#ff2d8a', hover: '#ff75b3', text: '#ff75b3', solid: '#d62674', solidHover: '#b81f62', light: 'rgba(255, 45, 138, 0.18)' },
    light: { accent: '#ff2d8a', hover: '#ae1d5c', text: '#ae1d5c', solid: '#d62674', solidHover: '#b81f62', light: 'rgba(255, 45, 138, 0.12)' }
  },
  {
    id: 'azul', name: 'Azul', hex: '#1a73e8',
    dark: { accent: '#1a73e8', hover: '#70abf2', text: '#70abf2', solid: '#196edf', solidHover: '#1559b8', light: 'rgba(26, 115, 232, 0.2)' },
    light: { accent: '#1a73e8', hover: '#1558b3', text: '#1558b3', solid: '#196edf', solidHover: '#1559b8', light: 'rgba(26, 115, 232, 0.12)' }
  },
  {
    id: 'verde', name: 'Verde', hex: '#00a651',
    dark: { accent: '#00a651', hover: '#3dc27e', text: '#3dc27e', solid: '#008541', solidHover: '#006e36', light: 'rgba(0, 166, 81, 0.2)' },
    light: { accent: '#009f4e', hover: '#006a34', text: '#006a34', solid: '#008541', solidHover: '#006e36', light: 'rgba(0, 166, 81, 0.12)' }
  },
  {
    id: 'laranja', name: 'Laranja', hex: '#ff6a00',
    dark: { accent: '#ff6a00', hover: '#ff8c3a', text: '#ff8c3a', solid: '#c25100', solidHover: '#a34400', light: 'rgba(255, 106, 0, 0.2)' },
    light: { accent: '#e05d00', hover: '#9a4000', text: '#9a4000', solid: '#c25100', solidHover: '#a34400', light: 'rgba(255, 106, 0, 0.12)' }
  }
];

const HEX6 = /^#[0-9a-fA-F]{6}$/;

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
 * Converte qualquer valor salvo (inclui o antigo #e53935 e cores livres) para o id da opção de matiz mais próximo.
 * Cinzas/neutros, valor inválido ou vazio voltam ao padrão (Vermelho). Mesma regra de src/core/settings/accentPalette.js.
 * @param {unknown} value
 * @returns {string}
 */
export function nearestAccentId(value) {
  if (typeof value !== 'string' || !HEX6.test(value.trim())) return DEFAULT_ACCENT_ID;
  const v = value.trim().toLowerCase();
  const exact = ACCENT_PALETTE.find((o) => o.hex === v);
  if (exact) return exact.id;
  const { h, s } = hueSat(v);
  if (s < 0.2) return DEFAULT_ACCENT_ID;
  let best = ACCENT_PALETTE[0];
  let bestDist = Infinity;
  for (const opt of ACCENT_PALETTE) {
    const diff = Math.abs(h - hueSat(opt.hex).h);
    const d = Math.min(diff, 360 - diff);
    if (d < bestDist) { bestDist = d; best = opt; }
  }
  return best.id;
}

/** Normaliza um valor salvo para o hex de uma opção da paleta. */
export function normalizeAccentHex(value) {
  return accentOption(nearestAccentId(value)).hex;
}

/** Opção da paleta pelo id (padrão se inexistente). */
export function accentOption(id) {
  return ACCENT_PALETTE.find((o) => o.id === id) || ACCENT_PALETTE[0];
}

/** Tons de uma opção para o tema ('dark' | 'light'). */
export function accentTokens(value, theme) {
  const opt = accentOption(nearestAccentId(value));
  return theme === 'light' ? opt.light : opt.dark;
}
