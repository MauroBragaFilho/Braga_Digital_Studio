'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LUT_EXT, MAX_FILE_BYTES } = require('./lutConstants');

/**
 * CubeParser — leitura e validação de arquivos de LUT (.cube).
 *
 * Uma única passada linear sobre o conteúdo (Buffer, sem dividir o arquivo inteiro em linhas de uma vez) serve a
 * tudo: a importação, a leitura da prévia e o cabeçalho. Assim, o que a importação aceita é exatamente o que a
 * leitura depois consegue abrir. A tabela precisa ter EXATAMENTE o número de linhas do tamanho declarado, cada valor
 * é um número estrito (ponto como separador decimal) e arquivos com tabelas 1D e 3D juntas são recusados.
 */

const MIN_SIZE = 2;
const MAX_SIZE_3D = 129;
const MAX_SIZE_1D = 65536;
const BINARY_SNIFF_BYTES = 8 * 1024;
/** Cabeçalho rápido (tipo, tamanho e título para a lista): só o começo do arquivo; o painel lê um pouco mais (a prévia de 100 linhas). */
const QUICK_HEADER_BYTES = 8 * 1024;
const HEADER_PREFIX_BYTES = 64 * 1024;
const PREVIEW_ROWS = 100;
const MAX_HEADER_LINES = 200;
const MAX_HEADER_LINE_CHARS = 500;
const MAX_IGNORED_KEYWORDS = 20;
const MAX_TITLE_CHARS = 200;

const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
const NUMBER_RE = new RegExp(`^${NUM}$`);
const DATA_RE = new RegExp(`^(${NUM})\\s+(${NUM})\\s+(${NUM})$`);
/** Palavra-chave do formato: só maiúsculas, dígitos e "_" (NAN/INF são números mal escritos, não palavras-chave). */
const KEYWORD_RE = /^[A-Z][A-Z0-9_]*$/;
const NUMERIC_WORD_RE = /^(NAN|INF|INFINITY)$/;
/** Controles e marcas de direção de texto: nunca entram em título nem em nome mostrado ao usuário. */
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g;

class CubeError extends Error {
  /**
   * @param {string} code - NOT_CUBE, NOT_FILE, UNREADABLE, EMPTY, TOO_BIG, BINARY, NO_SIZE, BAD_SIZE, MIXED, BAD_NUMBER, BAD_COLUMNS, ROWS ou BAD_DOMAIN
   * @param {string} message - texto em português, pronto para a interface
   */
  constructor(code, message) {
    super(message);
    this.name = 'CubeError';
    this.code = code;
  }
}

const REASONS = {
  NOT_CUBE: () => 'Não é um arquivo .cube.',
  NOT_FILE: () => 'Não é um arquivo.',
  UNREADABLE: () => 'Não foi possível ler o arquivo.',
  EMPTY: () => 'O arquivo está vazio.',
  TOO_BIG: () => `Arquivo grande demais (máximo ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB).`,
  BINARY: () => 'O conteúdo não é texto; não parece uma LUT.',
  NO_SIZE: () => 'Falta a linha de tamanho (LUT_3D_SIZE ou LUT_1D_SIZE).',
  BAD_SIZE: (x) => `Tamanho da tabela inválido (${x}).`,
  MIXED: () => 'Esta LUT traz tabelas 1D e 3D no mesmo arquivo, formato que o programa não aceita.',
  BAD_NUMBER: (line) => `Linha ${line}: valor inválido (use ponto, não vírgula, como separador decimal).`,
  BAD_COLUMNS: (line) => `Linha ${line}: são esperados 3 valores por linha.`,
  ROWS: (found, size, expected) => `A tabela tem ${found} ${found === 1 ? 'linha' : 'linhas'}; o esperado para tamanho ${size} é ${expected}.`,
  BAD_DOMAIN: () => 'O domínio da LUT está inválido.'
};

const problem = (code, ...args) => ({ code, reason: REASONS[code](...args) });
const safeText = (s, max) => String(s).replace(UNSAFE_TEXT_RE, '').trim().slice(0, max);
const stripComment = (s) => { const i = s.indexOf('#'); return (i === -1 ? s : s.slice(0, i)).trim(); };

/** Lê `count` números estritos de um texto; null se faltar, sobrar ou algum não for número finito. */
function parseNumbers(text, count) {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length !== count) return null;
  const out = [];
  for (const p of parts) {
    if (!NUMBER_RE.test(p)) return null;
    const v = Number(p);
    if (!Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

/**
 * Passada única sobre o conteúdo.
 * @param {Buffer} buf
 * @param {{ collect?: 'none'|'preview'|'rows', strict?: boolean, stopAtData?: boolean }} opts
 *   collect: guarda as linhas da tabela (nenhuma, as primeiras 100 ou todas; "todas" vão para um Float32Array
 *   compacto, r g b em sequência, e as 100 primeiras também como listas [r, g, b] para a prévia);
 *   strict: para no primeiro problema (validação). Sem strict (cabeçalho), linhas de dados ruins são puladas;
 *   stopAtData: para na primeira linha da tabela (só interessa o cabeçalho).
 * @returns {{ error: {code,reason}|null, info: object, rows: number[][]|null, table: Float32Array|null }}
 */
function scan(buf, { collect = 'none', strict = true, stopAtData = false } = {}) {
  const info = {
    kind: null, lutSize: null, bytes: buf.length, entries: 0, expected: null, title: null,
    domainMin: null, domainMax: null, inputRange: null, headerLines: [], ignoredKeywords: []
  };
  const rows = collect === 'none' ? null : [];
  let table = null;
  let error = null;
  let hasContent = false;
  // Registra o primeiro problema; devolve true quando a leitura deve parar.
  const fail = (code, ...args) => { if (!error) error = problem(code, ...args); return strict; };
  const pushHeader = (line) => {
    if (info.headerLines.length < MAX_HEADER_LINES) info.headerLines.push(line.slice(0, MAX_HEADER_LINE_CHARS));
  };

  // Linha da tabela (ou lixo que deveria ser uma). Devolve true quando a leitura deve parar.
  const dataLine = (line, lineNo) => {
    if (info.kind === null) return fail('NO_SIZE');
    let match = DATA_RE.exec(line);
    let text = line;
    if (!match) { text = stripComment(line); if (text !== line) match = DATA_RE.exec(text); }
    if (!match) return text.split(/\s+/).filter(Boolean).length !== 3 ? fail('BAD_COLUMNS', lineNo) : fail('BAD_NUMBER', lineNo);
    const r = Number(match[1]);
    const g = Number(match[2]);
    const b = Number(match[3]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return fail('BAD_NUMBER', lineNo);
    info.entries++;
    if (rows) {
      if (info.entries <= PREVIEW_ROWS) rows.push([r, g, b]);
      if (collect === 'rows' && info.entries <= info.expected) {
        if (!table) table = new Float32Array(info.expected * 3);
        const at = (info.entries - 1) * 3;
        table[at] = r;
        table[at + 1] = g;
        table[at + 2] = b;
      }
    }
    return false;
  };

  const sizeLine = (first, rest) => {
    const kind = first === 'LUT_3D_SIZE' ? '3D' : '1D';
    if (info.kind !== null && info.kind !== kind) return fail('MIXED');
    const raw = stripComment(rest);
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!(n >= MIN_SIZE && n <= (kind === '3D' ? MAX_SIZE_3D : MAX_SIZE_1D))) return fail('BAD_SIZE', raw || 'vazio');
    if (info.kind === null) {
      info.kind = kind;
      info.lutSize = n;
      info.expected = kind === '3D' ? n ** 3 : n;
      return false;
    }
    return info.lutSize !== n ? fail('BAD_SIZE', raw) : false; // mesma palavra repetida com o mesmo valor é tolerada
  };

  const keywordLine = (line, first) => {
    pushHeader(line);
    const rest = line.slice(first.length);
    if (first === 'TITLE') {
      const a = line.indexOf('"');
      const b = line.lastIndexOf('"');
      info.title = safeText(a >= 0 && b > a ? line.slice(a + 1, b) : rest.trim().replace(/^"|"$/g, ''), MAX_TITLE_CHARS);
    } else if (first === 'LUT_3D_SIZE' || first === 'LUT_1D_SIZE') {
      return sizeLine(first, rest);
    } else if (first === 'DOMAIN_MIN' || first === 'DOMAIN_MAX') {
      const values = parseNumbers(stripComment(rest), 3);
      if (!values) return fail('BAD_DOMAIN');
      if (first === 'DOMAIN_MIN') info.domainMin = values; else info.domainMax = values;
    } else if (first === 'LUT_1D_INPUT_RANGE' || first === 'LUT_3D_INPUT_RANGE') {
      const values = parseNumbers(stripComment(rest), 2);
      if (!values) return fail('BAD_DOMAIN');
      info.inputRange = values;
    } else if (info.ignoredKeywords.length < MAX_IGNORED_KEYWORDS && !info.ignoredKeywords.includes(first)) {
      info.ignoredKeywords.push(first); // palavra-chave desconhecida: tolerada e contada
    }
    return false;
  };

  let pos = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  let lineNo = 0;
  for (;;) {
    let end = buf.indexOf(10, pos);
    if (end === -1) end = buf.length;
    lineNo++;
    const line = buf.toString('utf8', pos, end).trim();
    const last = end >= buf.length;
    pos = end + 1;

    if (line !== '') {
      if (line.charCodeAt(0) === 35) { // "#": comentário
        pushHeader(line);
      } else {
        hasContent = true;
        const first = line.split(/\s/, 1)[0];
        const isKeyword = KEYWORD_RE.test(first) && !NUMERIC_WORD_RE.test(first);
        if (!isKeyword && stopAtData) break;
        if (isKeyword ? keywordLine(line, first) : dataLine(line, lineNo)) break;
      }
    }
    if (last) break;
  }

  if (!error) {
    if (info.kind === null) {
      error = hasContent ? problem('NO_SIZE') : problem('EMPTY');
    } else if ((info.domainMin && info.domainMax && info.domainMin.some((v, i) => !(v < info.domainMax[i])))
      || (info.inputRange && !(info.inputRange[0] < info.inputRange[1]))) {
      error = problem('BAD_DOMAIN');
    } else if (info.entries !== info.expected) {
      error = problem('ROWS', info.entries, info.lutSize, info.expected);
    }
  }
  return { error, info, rows, table };
}

/** Corta o começo de um arquivo na última quebra de linha (a linha interrompida no meio não vale). null se não há nenhuma. */
function cutAtLastLine(buf) {
  const end = buf.lastIndexOf(10);
  return end === -1 ? null : buf.subarray(0, end + 1);
}

/** Lê só os primeiros `bytes` de um arquivo (o tamanho já foi conferido por quem chama). */
function readPrefix(fd, bytes) {
  const buf = Buffer.allocUnsafe(bytes);
  const read = fs.readSync(fd, buf, 0, bytes, 0);
  return buf.subarray(0, read);
}

/**
 * Lê a origem (caminho ou Buffer) com as checagens baratas antes de abrir: extensão, tipo, tamanho, texto.
 * Com `prefix` e um arquivo maior que isso, lê só o começo (cortado numa quebra de linha) e devolve `partial: true`.
 */
function load(source, { prefix = 0 } = {}) {
  let buffer;
  let partial = false;
  if (Buffer.isBuffer(source)) {
    buffer = source;
  } else {
    if (typeof source !== 'string' || source === '') return { failure: problem('NOT_FILE') };
    if (path.extname(source).toLowerCase() !== LUT_EXT) return { failure: problem('NOT_CUBE') };
    let stats;
    try { stats = fs.statSync(source); } catch { return { failure: problem('NOT_FILE') }; }
    if (!stats.isFile()) return { failure: problem('NOT_FILE') };
    if (stats.size > MAX_FILE_BYTES) return { failure: problem('TOO_BIG') };
    if (stats.size === 0) return { failure: problem('EMPTY') };
    if (prefix && stats.size > prefix) {
      let fd = null;
      try {
        fd = fs.openSync(source, 'r');
        buffer = readPrefix(fd, prefix);
      } catch { return { failure: problem('UNREADABLE') }; } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* já fechado */ } }
      }
      if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { failure: problem('BINARY') };
      buffer = cutAtLastLine(buffer);
      if (!buffer) return { failure: problem('NO_SIZE') }; // nem uma linha inteira no começo do arquivo
      return { buffer, partial: true };
    }
    try { buffer = fs.readFileSync(source); } catch { return { failure: problem('UNREADABLE') }; }
  }
  if (buffer.length > MAX_FILE_BYTES) return { failure: problem('TOO_BIG') };
  if (buffer.length === 0) return { failure: problem('EMPTY') };
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { failure: problem('BINARY') };
  return { buffer, partial };
}

class CubeParser {
  /**
   * Valida uma LUT (a mesma regra vale na importação e na leitura).
   * @param {string|Buffer} source - caminho do .cube ou o conteúdo já lido
   * @returns {{ ok: boolean, code: string|null, reason: string|null, info: object|null }}
   *   info: { kind: '1D'|'3D', lutSize, bytes, entries, expected, title, domainMin, domainMax, inputRange, headerLines, ignoredKeywords }
   */
  static validate(source) {
    const loaded = load(source);
    if (loaded.failure) return { ok: false, ...loaded.failure, info: null };
    const { error, info } = scan(loaded.buffer, { collect: 'none', strict: true });
    return error ? { ok: false, ...error, info: null } : { ok: true, code: null, reason: null, info };
  }

  /**
   * Leitura completa. Lança CubeError (com `code`) se a LUT não passar na validação.
   * @param {string|Buffer} source
   * @returns {Object} { size, is1D, data, title, domainMin, domainMax, inputRange, headerLines, totalEntries, preview }
   *   data: Float32Array(linhas × 3), R varia mais rápido; preview: as 100 primeiras linhas como [r, g, b]
   */
  static parse(source) {
    const loaded = load(source);
    if (loaded.failure) throw new CubeError(loaded.failure.code, loaded.failure.reason);
    const { error, info, rows, table } = scan(loaded.buffer, { collect: 'rows', strict: true });
    if (error) throw new CubeError(error.code, error.reason);
    return {
      size: info.lutSize,
      is1D: info.kind === '1D',
      data: table, // Float32Array compacto: r, g, b de cada linha em sequência (3 × linhas valores)
      title: info.title,
      domainMin: info.domainMin,
      domainMax: info.domainMax,
      inputRange: info.inputRange,
      headerLines: info.headerLines,
      totalEntries: info.entries,
      preview: rows
    };
  }

  /**
   * Cabeçalho e primeiras linhas, sem exigir que a tabela esteja completa: um arquivo incompleto devolve a
   * contagem real em `totalEntries` (a tela compara com o esperado). Só recusa o que nem dá para ler como texto.
   * Um arquivo em disco maior que 64 KB não é lido inteiro (o cabeçalho e as 100 primeiras linhas cabem folgados
   * nisso): nesse caso `totalEntries` é null (a contagem real só sai da leitura completa, `parse`) e `partial` é true.
   * @param {string|Buffer} source
   * @returns {Object} { title, size, is1D, domainMin, domainMax, inputRange, headerLines, totalEntries, partial, preview }
   */
  static parseHeader(source) {
    const loaded = load(source, { prefix: HEADER_PREFIX_BYTES });
    if (loaded.failure) throw new CubeError(loaded.failure.code, loaded.failure.reason);
    const { info, rows } = scan(loaded.buffer, { collect: 'preview', strict: false });
    return {
      title: info.title,
      size: info.lutSize,
      is1D: info.kind === '1D',
      domainMin: info.domainMin,
      domainMax: info.domainMax,
      inputRange: info.inputRange,
      headerLines: info.headerLines,
      totalEntries: loaded.partial ? null : info.entries,
      partial: !!loaded.partial,
      preview: rows
    };
  }

  /**
   * Tipo, tamanho e título de uma LUT em disco lendo só os primeiros 8 KB (a lista da tela usa isto no lugar de
   * interpretar o arquivo inteiro). Não valida a tabela: um arquivo com cabeçalho bom e tabela quebrada aparece
   * aqui normalmente e só é recusado quando a tela o abre.
   * @param {string} filePath - caminho do .cube
   * @returns {{ kind: '1D'|'3D'|null, lutSize: number|null, title: string|null }|null}
   *   null: não é um arquivo .cube legível; kind null: lido, mas sem linha de tamanho utilizável no começo
   */
  static readHeaderQuick(filePath) {
    if (typeof filePath !== 'string' || filePath === '' || path.extname(filePath).toLowerCase() !== LUT_EXT) return null;
    let fd = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const stats = fs.fstatSync(fd);
      if (!stats.isFile() || stats.size === 0 || stats.size > MAX_FILE_BYTES) return null;
      let buf = readPrefix(fd, Math.min(stats.size, QUICK_HEADER_BYTES));
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: null, lutSize: null, title: null };
      if (stats.size > buf.length) {
        buf = cutAtLastLine(buf);
        if (!buf) return { kind: null, lutSize: null, title: null };
      }
      const { info } = scan(buf, { collect: 'none', strict: false, stopAtData: true });
      return { kind: info.kind, lutSize: info.lutSize, title: info.title };
    } catch {
      return null;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* já fechado */ } }
    }
  }
}

CubeParser.CubeError = CubeError;

module.exports = CubeParser;
