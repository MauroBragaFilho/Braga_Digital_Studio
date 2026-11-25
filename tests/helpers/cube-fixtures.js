'use strict';

// Arquivos .cube sintéticos (bons e ruins) para os testes do leitor, do gerenciador e dos handlers de LUTs.

/** Linhas de uma tabela 3D (R varia mais rápido, depois G, depois B). `f(r, g, b)` devolve o texto da linha. */
function rows3d(size, f = (r, g, b) => `${r / (size - 1)} ${g / (size - 1)} ${b / (size - 1)}`) {
  const out = [];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) out.push(f(r, g, b));
  return out;
}

/** LUT 3D válida. `tint` muda o conteúdo (e o hash); `eol`, `bom` e `title` variam a forma. */
function cube3d(size = 2, { tint = 0, title = 'Teste', eol = '\n', bom = false, header = [] } = {}) {
  const lines = [...(title === null ? [] : [`TITLE "${title}"`]), ...header, `LUT_3D_SIZE ${size}`, ...rows3d(size, (r, g, b) => `${(r / (size - 1) * 0.9 + tint).toFixed(4)} ${(g / (size - 1)).toFixed(4)} ${(b / (size - 1)).toFixed(4)}`)];
  return (bom ? '﻿' : '') + lines.join(eol) + eol;
}

/** LUT 1D válida com `size` pontos (uma curva simples). */
function cube1d(size = 4, { tint = 0 } = {}) {
  const rows = [];
  for (let i = 0; i < size; i++) { const v = (i / (size - 1) + tint).toFixed(4); rows.push(`${v} ${v} ${v}`); }
  return `LUT_1D_SIZE ${size}\n${rows.join('\n')}\n`;
}

/** Arquivos que NÃO são LUTs utilizáveis, com o código de recusa esperado. */
function badCubes() {
  const two = rows3d(2);
  return [
    { name: 'virgula-decimal', code: 'BAD_NUMBER', content: `LUT_3D_SIZE 2\n${rows3d(2, () => '0,5 1 0').join('\n')}\n` },
    { name: 'sufixo-no-numero', code: 'BAD_NUMBER', content: `LUT_3D_SIZE 2\n${rows3d(2, () => '0.5abc 1 0').join('\n')}\n` },
    { name: 'infinity', code: 'BAD_NUMBER', content: `LUT_3D_SIZE 2\n${rows3d(2, () => 'Infinity 1 0').join('\n')}\n` },
    { name: 'nan', code: 'BAD_NUMBER', content: `LUT_3D_SIZE 2\n${rows3d(2, () => 'nan 1 0').join('\n')}\n` },
    { name: 'estoura-o-numero', code: 'BAD_NUMBER', content: `LUT_3D_SIZE 2\n${rows3d(2, () => '1e999 1 0').join('\n')}\n` },
    { name: 'linhas-a-mais', code: 'ROWS', content: `LUT_3D_SIZE 2\n${two.join('\n')}\n0 0 0\n` },
    { name: 'linhas-a-menos', code: 'ROWS', content: `LUT_3D_SIZE 2\n${two.slice(0, 5).join('\n')}\n` },
    { name: 'so-cabecalho', code: 'ROWS', content: 'LUT_3D_SIZE 2\n' },
    { name: '1d-e-3d-juntos', code: 'MIXED', content: `LUT_1D_SIZE 3\n0 0 0\n0.5 0.5 0.5\n1 1 1\nLUT_3D_SIZE 2\n${two.join('\n')}\n` },
    { name: '3d-e-1d-juntos', code: 'MIXED', content: `LUT_3D_SIZE 2\nLUT_1D_SIZE 3\n${two.join('\n')}\n` },
    { name: 'tamanho-1', code: 'BAD_SIZE', content: 'LUT_3D_SIZE 1\n0 0 0\n' },
    { name: 'tamanho-17x', code: 'BAD_SIZE', content: 'LUT_3D_SIZE 17x\n' },
    { name: 'tamanho-17-ponto-0', code: 'BAD_SIZE', content: 'LUT_3D_SIZE 17.0\n' },
    { name: 'tamanho-negativo', code: 'BAD_SIZE', content: 'LUT_3D_SIZE -3\n' },
    { name: 'tamanho-gigante', code: 'BAD_SIZE', content: 'LUT_3D_SIZE 1000000000000000000\n' },
    { name: 'tamanho-130', code: 'BAD_SIZE', content: 'LUT_3D_SIZE 130\n' },
    { name: 'tamanho-1d-65537', code: 'BAD_SIZE', content: 'LUT_1D_SIZE 65537\n' },
    { name: 'sem-tamanho', code: 'NO_SIZE', content: `TITLE "x"\n${two.join('\n')}\n` },
    { name: 'dados-antes-do-tamanho', code: 'NO_SIZE', content: `0 0 0\nLUT_3D_SIZE 2\n${two.join('\n')}\n` },
    { name: 'palavra-chave-minuscula', code: 'NO_SIZE', content: `lut_3d_size 2\n${two.join('\n')}\n` },
    { name: 'so-titulo', code: 'NO_SIZE', content: 'TITLE "x"\n' },
    { name: 'quatro-colunas', code: 'BAD_COLUMNS', content: `LUT_3D_SIZE 2\n${rows3d(2, () => '0 0 0 1').join('\n')}\n` },
    { name: 'duas-colunas', code: 'BAD_COLUMNS', content: `LUT_3D_SIZE 2\n${rows3d(2, () => '0 0').join('\n')}\n` },
    { name: 'dominio-invertido', code: 'BAD_DOMAIN', content: `DOMAIN_MIN 1 1 1\nDOMAIN_MAX 0 0 0\nLUT_3D_SIZE 2\n${two.join('\n')}\n` },
    { name: 'dominio-com-2-numeros', code: 'BAD_DOMAIN', content: `DOMAIN_MIN 0 0\nLUT_3D_SIZE 2\n${two.join('\n')}\n` },
    { name: 'faixa-de-entrada-invalida', code: 'BAD_DOMAIN', content: `LUT_3D_INPUT_RANGE 1 0\nLUT_3D_SIZE 2\n${two.join('\n')}\n` },
    { name: 'binario', code: 'BINARY', content: Buffer.from([0x4c, 0x55, 0x54, 0x00, 0x01, 0x02, 0x03]) },
    { name: 'vazio', code: 'EMPTY', content: '' },
    { name: 'so-comentarios', code: 'EMPTY', content: '# nada\n\n# aqui\n' }
  ];
}

module.exports = { rows3d, cube3d, cube1d, badCubes };
