'use strict';

const fs = require('node:fs');

/**
 * Leitura estrutural de JPEG e extração de JPEGs embutidos (pré-visualizações de RAW).
 * Puro JavaScript, sem binários externos: serve tanto para reparar JPGs cortados quanto para
 * tirar o JPEG de dentro de CR2/CR3/NEF/ARW/DNG/RAF/ORF/RW2 etc., mesmo com o índice (IFD) danificado.
 */

const MAX_PHOTO_BYTES = 512 * 1024 * 1024;
const SOI_SEQ = Buffer.from([0xff, 0xd8, 0xff]);
// Só quadros comuns (baseline/extended/progressive). SOF3 (lossless) é o dado do sensor de CR2/DNG, não uma foto.
const PHOTO_SOF = new Set([0xc0, 0xc1, 0xc2]);
const ANY_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Lê o arquivo inteiro (limite de 512 MB). */
function readPhotoFile(filePath) {
  const st = fs.statSync(filePath);
  if (st.size > MAX_PHOTO_BYTES) throw new Error('O arquivo é grande demais para esta recuperação (limite de 512 MB).');
  return fs.readFileSync(filePath);
}

/**
 * Percorre a estrutura de um JPEG que começa em `start`.
 * @returns {{start:number,end:number,complete:boolean,width:number,height:number,sofType:number|null,
 *            hasDqt:boolean,hasDht:boolean,hasSos:boolean,hasExif:boolean,brokenHeader:boolean}}
 *   `end` é exclusivo. `complete` = chegou ao marcador EOI depois de ao menos um scan.
 */
function scanJpeg(buf, start = 0, limit = buf.length) {
  const r = {
    start, end: start, complete: false, width: 0, height: 0, sofType: null,
    hasDqt: false, hasDht: false, hasSos: false, hasExif: false, brokenHeader: false,
  };
  if (limit - start < 4 || buf[start] !== 0xff || buf[start + 1] !== 0xd8) { r.brokenHeader = true; return r; }

  let i = start + 2;
  while (i < limit) {
    if (buf[i] !== 0xff) { r.brokenHeader = true; r.end = i; return r; } // lixo entre segmentos
    while (i < limit && buf[i] === 0xff) i++; // bytes de preenchimento
    if (i >= limit) break;
    const m = buf[i++];
    if (m === 0x00) { r.brokenHeader = true; r.end = i; return r; }
    if (m === 0xd9) { r.end = i; r.complete = r.hasSos; return r; }
    if (m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) continue; // marcadores sem corpo
    if (i + 2 > limit) { r.end = limit; return r; }
    const len = buf.readUInt16BE(i);
    if (len < 2) { r.brokenHeader = true; r.end = i; return r; }
    const segEnd = i + len;

    if (m === 0xdb) r.hasDqt = true;
    else if (m === 0xc4) r.hasDht = true;
    else if (m === 0xe1 && i + 8 <= limit && buf.toString('latin1', i + 2, i + 6) === 'Exif') r.hasExif = true;
    else if (ANY_SOF.has(m) && i + 7 <= limit && r.sofType === null) {
      r.sofType = m;
      r.height = buf.readUInt16BE(i + 3);
      r.width = buf.readUInt16BE(i + 5);
    }

    if (segEnd > limit) { r.end = limit; return r; } // cabeçalho cortado

    if (m === 0xda) {
      r.hasSos = true;
      let j = segEnd;
      for (;;) {
        j = buf.indexOf(0xff, j);
        if (j < 0 || j + 1 >= limit) { r.end = limit; return r; } // dados cortados
        const n = buf[j + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { j += 2; continue; }
        if (n === 0xff) { j += 1; continue; }
        break; // marcador real (EOI ou próximo scan)
      }
      i = j;
      continue;
    }
    i = segEnd;
  }
  r.end = Math.min(i, limit);
  return r;
}

/** O resultado de scanJpeg tem o necessário para ser decodificado (tabelas + quadro + scan)? */
function hasDecodableHeaders(s) {
  return s.sofType !== null && s.hasSos && s.hasDqt && s.width > 0 && s.height > 0;
}

/** Primeiro "FF D8 FF" a partir de `from`, ou -1. */
function indexOfSoi(buf, from = 0) {
  return buf.indexOf(SOI_SEQ, from);
}

/**
 * Todos os JPEGs de foto dentro do arquivo (inclusive aninhados, como a miniatura do EXIF).
 * @returns {Array<ReturnType<typeof scanJpeg>>}
 */
function findEmbeddedJpegs(buf, { max = 300 } = {}) {
  const out = [];
  let pos = 0;
  while (out.length < max) {
    const k = indexOfSoi(buf, pos);
    if (k < 0) break;
    const s = scanJpeg(buf, k);
    if (s.sofType !== null && PHOTO_SOF.has(s.sofType) && s.hasSos && s.width > 0 && s.height > 0) out.push(s);
    pos = k + 3;
  }
  return out;
}

/** O melhor JPEG embutido: completos primeiro, depois a maior área e o maior tamanho. */
function pickBestJpeg(candidates) {
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;
    const areaDiff = (b.width * b.height) - (a.width * a.height);
    if (areaDiff) return areaDiff;
    return (b.end - b.start) - (a.end - a.start);
  })[0];
}

/** Tamanho útil do JPEG sem zeros no final (cartões costumam deixar o fim zerado). */
function trimTrailingZeros(buf, start, end) {
  let e = end;
  while (e > start && buf[e - 1] === 0x00) e--;
  return e;
}

/** Tipo de contêiner pelo início do arquivo. */
function detectContainer(buf) {
  if (buf.length < 12) return null;
  const head4 = buf.toString('latin1', 0, 4);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if ((head4 === 'II*\0') || (head4 === 'MM\0*')) return 'tiff';
  if (head4 === 'IIRO' || head4 === 'IIRS' || head4 === 'MMOR') return 'orf';
  if (head4 === 'IIU\0') return 'rw2';
  if (buf.toString('latin1', 4, 8) === 'ftyp') return 'isobmff'; // CR3
  if (buf.toString('latin1', 0, 15) === 'FUJIFILMCCD-RAW') return 'raf';
  if (buf.toString('latin1', 0, 4) === 'FOVb') return 'x3f';
  return null;
}

/** Fabricante e modelo gravados no IFD0 de contêineres TIFF (pode devolver null). */
function readTiffMakeModel(buf) {
  try {
    const order = buf.toString('latin1', 0, 2);
    if (order !== 'II' && order !== 'MM') return null;
    const le = order === 'II';
    const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const ifd = u32(4);
    if (ifd < 8 || ifd + 2 > buf.length) return null;
    const count = Math.min(u16(ifd), 200);
    const out = { make: null, model: null };
    for (let n = 0; n < count; n++) {
      const e = ifd + 2 + n * 12;
      if (e + 12 > buf.length) break;
      const tag = u16(e);
      if ((tag !== 0x010f && tag !== 0x0110) || u16(e + 2) !== 2) continue;
      const len = u32(e + 4);
      const off = len <= 4 ? e + 8 : u32(e + 8);
      if (off + len > buf.length || len > 256) continue;
      const text = buf.toString('latin1', off, off + len).replace(/\0.*$/s, '').trim();
      if (tag === 0x010f) out.make = text; else out.model = text;
    }
    return out.make || out.model ? out : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  MAX_PHOTO_BYTES,
  readPhotoFile,
  scanJpeg,
  hasDecodableHeaders,
  indexOfSoi,
  findEmbeddedJpegs,
  pickBestJpeg,
  trimTrailingZeros,
  detectContainer,
  readTiffMakeModel,
};
