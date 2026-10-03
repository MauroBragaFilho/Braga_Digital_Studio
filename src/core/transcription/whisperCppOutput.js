'use strict';

/**
 * whisperCppOutput.js — Lê o JSON completo (`whisper-cli -ojf`) do whisper.cpp e entrega:
 *   - segments: trechos com início/fim e texto (para a transcrição .md);
 *   - words:    palavras com tempo (para as legendas .srt, via subtitles.js).
 *
 * O whisper.cpp divide o texto em "tokens" (pedaços de palavra). Um token que começa com espaço abre uma
 * palavra nova; os demais (pedaços e pontuação) são anexados à palavra anterior. Tokens especiais
 * ([_BEG_], [_TT_123]…) são descartados.
 *
 * Como o JSON pode trazer um caractere acentuado dividido entre dois tokens (bytes UTF-8 incompletos em
 * cada um), o arquivo é lido byte a byte e os bytes de cada palavra são juntados ANTES de decodificar.
 */

const SPECIAL_TOKEN = /^\[_[^\]]*\]$/;

/** Chars de uma "string binária" (1 char = 1 byte) → bytes; chars acima de 0xFF (escape \uXXXX) viram UTF-8. */
function toBytes(text) {
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xFF) return Buffer.from(s, 'utf8');
  }
  return Buffer.from(s, 'latin1');
}

/** Interpreta o conteúdo do arquivo (Buffer, texto ou objeto já lido) preservando os bytes de cada token. */
function loadJson(input) {
  if (input && typeof input === 'object' && !Buffer.isBuffer(input)) return { json: input, binary: false };
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return { json: JSON.parse(buffer.toString('latin1')), binary: true };
}

const decode = (bytes, binary) => (binary ? Buffer.concat(bytes).toString('utf8') : bytes.join(''));

/** O token é só pontuação/símbolo (bytes incompletos de uma letra acentuada NÃO contam como pontuação). */
function isPunctuation(bytes, binary) {
  const s = binary ? bytes.toString('utf8') : String(bytes);
  return !s.includes('�') && /^[\s\p{P}\p{S}]+$/u.test(s);
}

/** Maior duração plausível de uma palavra falada, pelo tamanho (usada para não esticar o início após pausas). */
const maxWordSeconds = (word) => Math.min(1.6, 0.18 + 0.075 * (word.match(/[\p{L}\p{N}]/gu) || []).length);
const ms = (v) => (Number.isFinite(Number(v)) ? Number(v) / 1000 : null);

/**
 * @param {Buffer|string|object} input  conteúdo do .json gerado com `-ojf`
 * @param {{preferDtw?:boolean}} [opts] preferDtw: usa o tempo por DTW (`--dtw`) quando o motor o trouxe
 * @returns {{language:string, segments:Array<{start:number,end:number,text:string}>, words:Array<{word:string,start:number,end:number}>, hasTokens:boolean}}
 */
function parseWhisperCppJson(input, { preferDtw = true } = {}) {
  const { json, binary } = loadJson(input);
  const list = Array.isArray(json && json.transcription) ? json.transcription : [];
  const segments = [];
  const words = [];
  let hasTokens = false;

  for (const seg of list) {
    const segStart = ms(seg.offsets && seg.offsets.from) ?? 0;
    const segEnd = ms(seg.offsets && seg.offsets.to) ?? segStart;
    const segBytes = binary ? toBytes(seg.text || '') : String(seg.text || '');
    const text = (binary ? segBytes.toString('utf8') : segBytes).trim();
    if (!text) continue;
    segments.push({ start: segStart, end: Math.max(segEnd, segStart), text });
    const segIdx = segments.length - 1;

    const tokens = Array.isArray(seg.tokens) ? seg.tokens.filter((t) => t && !SPECIAL_TOKEN.test(String(t.text))) : [];
    if (!tokens.length) {
      words.push(...wordsFromText(text, segStart, segEnd).map((w) => ({ ...w, seg: segIdx })));
      continue;
    }
    hasTokens = true;

    let cur = null;
    let first = true; // primeira palavra do trecho
    for (const tok of tokens) {
      const bytes = binary ? toBytes(tok.text) : String(tok.text);
      const startsWord = binary ? bytes[0] === 0x20 : String(bytes).startsWith(' ');
      const hasDtw = preferDtw && Number.isFinite(tok.t_dtw) && tok.t_dtw >= 0;
      if (!cur || startsWord) {
        const start = ms(tok.offsets && tok.offsets.from);
        cur = { parts: [], start: start ?? segStart, end: start ?? segStart, dtw: false, first, seg: segIdx };
        words.push(cur);
        first = false;
      }
      cur.parts.push(bytes);
      if (hasDtw) {
        // O DTW informa o FIM de cada token (centésimos de segundo). O de uma pontuação não é confiável
        // (costuma cair depois da palavra), então só os tokens com letras definem o fim da palavra.
        if (!isPunctuation(bytes, binary) || !cur.dtw) cur.end = tok.t_dtw / 100;
        cur.dtw = true;
      } else {
        const end = ms(tok.offsets && tok.offsets.to);
        if (end !== null && !cur.dtw) cur.end = Math.max(cur.end, end);
      }
    }
  }

  const out = words.map((w) => (w.parts
    ? { word: decode(w.parts, binary).trim(), start: w.start, end: w.end, dtw: w.dtw, first: w.first, seg: w.seg }
    : w)).filter((w) => w.word);

  // Com DTW, cada palavra começa onde a anterior termina (e a primeira do trecho, no início do trecho).
  if (preferDtw) applyDtwStarts(out, segments);
  for (const w of out) { w.end = Math.max(w.end, w.start); delete w.dtw; delete w.first; delete w.seg; }

  return { language: (json && json.result && json.result.language) || '', segments, words: out, hasTokens };
}

/** Sem tokens com tempo: distribui as palavras do trecho pela duração, proporcional ao tamanho de cada uma. */
function wordsFromText(text, start, end) {
  const parts = text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((s, p) => s + p.length + 1, 0) || 1;
  const span = Math.max(end - start, 0.2);
  let at = start;
  return parts.map((word) => {
    const length = ((word.length + 1) / total) * span;
    const w = { word, start: at, end: at + length };
    at += length;
    return w;
  });
}

/**
 * O DTW dá só o FIM de cada palavra. O início é o fim da palavra anterior (e nunca antes do início do trecho),
 * mas limitado pela duração que a palavra pode ter: assim, depois de uma pausa ou de um silêncio a palavra
 * começa perto de onde foi dita, e não junto da anterior. Palavras sem DTW ficam como estão.
 */
function applyDtwStarts(words, segments) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.dtw) continue;
    const prev = words[i - 1];
    const seg = segments[w.seg];
    const lower = Math.max(prev ? prev.end : 0, seg ? seg.start : 0);
    w.start = Math.min(w.end, Math.max(lower, w.end - maxWordSeconds(w.word)));
  }
}

module.exports = { parseWhisperCppJson, wordsFromText, SPECIAL_TOKEN };
