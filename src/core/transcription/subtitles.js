'use strict';

/**
 * subtitles.js — Divisão de palavras com tempo em legendas (.srt) e formatação da transcrição (.md).
 *
 * Porta fiel do `legendar.py` do projeto "Whisper + LM Studio" (mesmas regras e mesmos limites):
 *   - quebra a legenda na pontuação final e em pausas maiores que MAX_GAP;
 *   - nunca passa de MAX_DURATION nem do limite de palavras/caracteres escolhido;
 *   - prefere cortar em vírgula/ponto e vírgula e evita terminar em "de", "o", "que"…;
 *   - cada legenda fica ao menos MIN_DURATION na tela e nunca se sobrepõe à seguinte.
 *
 * É código puro (sem Electron nem Node): serve a qualquer motor que entregue palavras com tempo.
 * A paridade com o Python é conferida em tests/subtitles.test.js (arquivo dourado gerado pelo legendar.py).
 */

const MIN_DURATION = 0.5; // segundos que uma legenda fica na tela, no mínimo
const MAX_GAP = 1.0;      // um silêncio maior que isso sempre abre uma nova legenda
const MAX_DURATION = 6.0;
const DEFAULT_MAX_CHARS = 42;
const SENTENCE_END = ['.', '?', '!', '…'];
const SOFT_BREAK = [',', ';', ':'];

// Palavras com que uma legenda não deve terminar: leem melhor no começo da próxima.
const WEAK_ENDINGS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
  'e', 'ou', 'que', 'para', 'por', 'com', 'se', 'ao', 'aos', 'à', 'às', 'pelo', 'pela', 'pelos', 'pelas'
]);

/** Tamanho em caracteres de verdade (pontos de código), como o len() do Python. */
const size = (text) => {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    n++;
    const unit = text.charCodeAt(i);
    if (unit >= 0xD800 && unit <= 0xDBFF) i++; // par substituto (emoji etc.) conta como um só
  }
  return n;
};

/** Arredonda como o round() do Python 3 (metade vai para o par), para os milissegundos baterem. */
function roundHalfEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

const endsWithAny = (text, endings) => endings.some((e) => text.endsWith(e));

/** 83.4 → "00:01:23,400" */
function formatSrtTime(seconds) {
  const ms = roundHalfEven(Math.max(Number(seconds) || 0, 0) * 1000);
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(millis, 3)}`;
}

/** Divide uma legenda em até `lines` linhas equilibradas. */
function wrapLines(words, lines, maxChars) {
  const text = words.join(' ');
  if (lines <= 1 || size(text) <= maxChars || words.length < 2) return text;
  let best = text;
  let bestDiff = null;
  for (let cut = 1; cut < words.length; cut++) {
    const first = words.slice(0, cut).join(' ');
    const second = words.slice(cut).join(' ');
    const diff = Math.abs(size(first) - size(second));
    if (bestDiff === null || diff < bestDiff) { best = `${first}\n${second}`; bestDiff = diff; }
  }
  return best;
}

const overflows = (words, lines, maxChars) => wrapLines(words, lines, maxChars).split('\n').some((line) => size(line) > maxChars);

/** Palavra sem espaços nas pontas (o Whisper entrega " palavra" com espaço na frente). */
const clean = (word) => String(word.word ?? '').trim();

/** Tira vírgula/ponto/etc. das pontas, como str.strip(",.;:?!") do Python. */
const stripPunct = (text) => text.replace(/^[,.;:?!]+/, '').replace(/[,.;:?!]+$/, '');

/**
 * Agrupa palavras com tempo em legendas.
 * @param {Array<{word:string,start:number,end:number}>} words
 * @param {{maxWords?:number, lines?:number, maxChars?:number}} [opts]  maxWords 0 = automático
 * @returns {Array<{start:number,end:number,words:string[]}>}
 */
function buildCues(words, { maxWords = 0, lines = 2, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const cues = [];
  let current = [];

  const emit = (items) => {
    if (items.length) cues.push({ start: items[0].start, end: items[items.length - 1].end, words: items.map(clean) });
  };

  for (const word of words || []) {
    if (!clean(word)) continue;
    if (current.length) {
      const last = current[current.length - 1];
      const gap = word.start - last.end;
      const sentenceEnd = endsWithAny(clean(last), SENTENCE_END) && current.length >= (maxWords ? 1 : 3);
      if (gap > MAX_GAP || sentenceEnd) {
        emit(current);
        current = [];
      } else if (
        (maxWords > 0 && current.length >= maxWords)
        || overflows([...current.map(clean), clean(word)], lines, maxChars)
        || word.end - current[0].start > MAX_DURATION
      ) {
        let splitAt = current.length;
        let broke = false;
        for (let k = current.length; k >= Math.floor(current.length / 2); k--) { // prefere cortar em vírgula/ponto e vírgula
          if (k > 0 && endsWithAny(clean(current[k - 1]), SOFT_BREAK)) { splitAt = k; broke = true; break; }
        }
        if (!broke) {
          while (splitAt > 1 && WEAK_ENDINGS.has(stripPunct(clean(current[splitAt - 1]).toLowerCase()))) splitAt--;
        }
        emit(current.slice(0, splitAt));
        current = current.slice(splitAt);
      }
    }
    current.push(word);
  }
  emit(current);

  // Cada legenda fica legível e nunca se sobrepõe à seguinte.
  cues.forEach((cue, i) => {
    const nextStart = i + 1 < cues.length ? cues[i + 1].start : Infinity;
    cue.end = Math.max(cue.end, cue.start + MIN_DURATION);
    if (nextStart - cue.end < 0.05) cue.end = Math.max(nextStart - 0.05, cue.start + 0.1);
  });
  return cues;
}

/** Texto do arquivo .srt. */
function cuesToSrt(cues, { lines = 2, maxChars = DEFAULT_MAX_CHARS } = {}) {
  return cues.map((cue, i) => (
    `${i + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${wrapLines(cue.words, lines, maxChars)}\n`
  )).join('\n');
}

/** Atalho: palavras com tempo → texto .srt (e as legendas, para quem quiser contá-las). */
function buildSrt(words, opts = {}) {
  const cues = buildCues(words, opts);
  return { cues, text: cuesToSrt(cues, opts) };
}

/** 3725 → "01:02:05" */
function formatStamp(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * Transcrição em Markdown, no mesmo formato do transcrever.py:
 *   # nome
 *
 *   Transcrição automática (Whisper <modelo>). Duração: hh:mm:ss
 *
 *   **[hh:mm:ss]** texto
 *
 * @param {{title:string, model?:string, duration?:number, segments:Array<{start:number,text:string}>}} p
 */
function buildMarkdown({ title, model = 'whisper', duration = 0, segments = [] }) {
  let out = `# ${title}\n\nTranscrição automática (Whisper ${model}). Duração: ${formatStamp(duration)}\n\n`;
  for (const seg of segments) {
    const text = String(seg.text || '').trim();
    if (text) out += `**[${formatStamp(seg.start)}]** ${text}\n\n`;
  }
  return out;
}

module.exports = {
  MIN_DURATION, MAX_GAP, MAX_DURATION, DEFAULT_MAX_CHARS, WEAK_ENDINGS,
  formatSrtTime, formatStamp, wrapLines, buildCues, cuesToSrt, buildSrt, buildMarkdown
};
