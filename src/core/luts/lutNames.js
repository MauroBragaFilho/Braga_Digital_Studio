'use strict';

/**
 * Regras de nome de arquivo da coleção de LUTs (Windows é a regra mais restritiva e vale em todos os sistemas,
 * porque a coleção também é sincronizada com o celular).
 */

/** Nomes de dispositivo reservados no Windows (valem com ou sem extensão: "con.cube" também é reservado). */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Caracteres proibidos em nome de arquivo (inclui controles e os separadores de caminho). */
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/**
 * Confere o nome-base de uma LUT (sem a extensão). Nunca corrige em silêncio: devolve o motivo da recusa.
 * @param {string} base
 * @returns {string|null} mensagem em português, ou null se o nome serve
 */
function checkFileBaseName(base) {
  if (typeof base !== 'string' || base === '') return 'Informe um nome para a LUT.';
  if (INVALID_NAME_CHARS.test(base)) return 'O nome não pode ter os caracteres \\ / : * ? " < > |.';
  if (/^\s|\s$/.test(base) || base.endsWith('.')) return 'O nome não pode começar nem terminar com espaço, nem terminar com ponto.';
  if (base.startsWith('.')) return 'O nome não pode começar com ponto.';
  const stem = base.split('.')[0].trim();
  if (RESERVED.test(stem)) return `"${stem}" é um nome reservado pelo Windows. Escolha outro nome.`;
  return null;
}

/** Tamanho máximo de um nome de pasta da coleção (o orçamento total de caminho também vale). */
const MAX_FOLDER_NAME = 100;

/**
 * Confere o nome de UMA pasta da coleção (um único segmento, sem separadores). Nunca corrige em silêncio.
 * @param {string} name
 * @returns {string|null} mensagem em português, ou null se o nome serve
 */
function checkFolderName(name) {
  if (typeof name !== 'string' || name === '') return 'Informe um nome para a pasta.';
  if (INVALID_NAME_CHARS.test(name)) return 'O nome da pasta não pode ter os caracteres \\ / : * ? " < > |.';
  if (/^\s|\s$/.test(name) || name.endsWith('.')) return 'O nome da pasta não pode começar nem terminar com espaço, nem terminar com ponto.';
  if (name.startsWith('.')) return 'O nome da pasta não pode começar com ponto.';
  if (name.length > MAX_FOLDER_NAME) return `O nome da pasta é longo demais (máximo de ${MAX_FOLDER_NAME} caracteres).`;
  const stem = name.split('.')[0].trim();
  if (RESERVED.test(stem)) return `"${stem}" é um nome reservado pelo Windows. Escolha outro nome.`;
  return null;
}

/**
 * Um segmento de caminho que já existe (ou existiria) na coleção é seguro? Mais frouxo que checkFolderName (aceita
 * o tamanho que o disco aceitar), mas nunca "." ou "..", separadores, caracteres proibidos ou nome reservado.
 */
function isSafeSegment(segment) {
  return typeof segment === 'string' && segment !== '' && segment !== '.' && segment !== '..'
    && !INVALID_NAME_CHARS.test(segment) && !/^\s|\s$/.test(segment) && !segment.endsWith('.') && !segment.startsWith('.')
    && !RESERVED.test(segment.split('.')[0].trim());
}

/**
 * Transforma o nome de uma subpasta da ORIGEM num nome de pasta aceito pela coleção (a origem pode vir de outro
 * sistema): caracteres proibidos viram "_", pontas aparadas, nome reservado ou iniciado por ponto ganha "_" na frente.
 * Sempre devolve um nome válido para checkFolderName.
 * @param {string} name
 * @param {number} [max]
 */
function sanitizeFolderSegment(name, max = MAX_FOLDER_NAME) {
  let out = String(name ?? '').replace(new RegExp(INVALID_NAME_CHARS.source, 'g'), '_').replace(/[\s.]+$/, '').replace(/^\s+/, '');
  if (out.startsWith('.')) out = `_${out.replace(/^\.+/, '')}`;
  if (RESERVED.test(out.split('.')[0].trim())) out = `_${out}`;
  if (out.length > max) out = out.slice(0, max).replace(/[\s.]+$/, '');
  return out || '_';
}

/** Controles C0/C1, separadores de linha/parágrafo, marcas e controles bidirecionais e caracteres invisíveis. */
const UNSAFE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]];
const UNSAFE_TEXT_CHARS = new RegExp(`[${UNSAFE_RANGES.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`, 'g');

/**
 * Texto vindo de fora (pacote .bdspro de terceiros) para exibir ou virar nome: sem controles nem marcas
 * bidirecionais, espaços repetidos recolhidos, aparado e limitado a `max` caracteres. Não é HTML: quem mostra
 * continua usando textContent.
 * @param {unknown} value
 * @param {number} max
 * @returns {string} texto limpo ('' se não era texto)
 */
function cleanExternalText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(UNSAFE_TEXT_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

module.exports = {
  RESERVED, INVALID_NAME_CHARS, MAX_FOLDER_NAME, checkFileBaseName, checkFolderName, isSafeSegment, sanitizeFolderSegment,
  cleanExternalText
};
