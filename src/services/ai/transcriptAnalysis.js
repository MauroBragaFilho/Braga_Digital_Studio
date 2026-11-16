'use strict';

/**
 * transcriptAnalysis.js — Análise de transcrições por IA (resumo, assuntos, pontos importantes, trechos).
 *
 * Fluxo do projeto "Whisper + LM Studio" (mesmo prompt e mesmas seções), agora sobre o AIService do BDS,
 * que fala com qualquer servidor compatível com a OpenAI (LM Studio, Ollama, OpenAI…).
 *
 * Transcrição longa não cabe na janela de contexto de um modelo local nem no limite por minuto de um servidor gratuito.
 * Então:
 *   1. o texto é dividido em partes por tempo (cada parte cabe em `maxChunkChars`);
 *   2. cada parte é analisada de forma concisa;
 *   3. as análises parciais são unidas em grupos, repetidamente, até sobrar uma só análise final.
 * Transcrição curta vai inteira numa única chamada (igual ao script original).
 *
 * Para um modelo pequeno ou um servidor com limite baixo não estragar o resultado:
 *   - cada etapa pede só o tamanho de resposta de que precisa (STAGE_TOKENS), nunca o limite global do assistente: um modelo
 *     pequeno que entra em laço gasta pouco, e o pedido fica dentro do limite por minuto do servidor;
 *   - servidor local recebe a amostragem recomendada para o modelo (ANALYSIS_SAMPLING; o AIService só a repassa a servidor local);
 *   - repetição em laço é cortada e a chamada é refeita uma vez; se a união ainda sair ruim, o documento traz a análise de cada
 *     parte, em ordem (nunca fica pior do que as partes);
 *   - limite de uso do servidor (429): espera o tempo indicado e continua; pedido grande demais (413, janela de contexto):
 *     a parte é dividida ao meio.
 *
 * Aceita a transcrição em Markdown do BDS (**[hh:mm:ss]** texto), legenda .srt/.vtt ou texto puro.
 * Não depende do Electron: recebe a função `chat` pronta (ctx.chat do AIService).
 */

const fs = require('node:fs');
const path = require('node:path');
const { formatStamp } = require('../../core/transcription/subtitles');

const SYSTEM_PROMPT = [
  'Você é um assistente de análise de transcrições.',
  '',
  'Analise a transcrição fornecida e produza:',
  '',
  '1. Resumo',
  '2. Principais assuntos',
  '3. Pontos importantes',
  '4. Trechos potencialmente relevantes',
  '',
  'Preserve os timestamps quando eles forem relevantes.',
  'Não invente informações que não estejam presentes na transcrição.',
  'Não repita a mesma informação: cada item aparece uma única vez.',
  'Responda em português.'
].join('\n');

const MERGE_PROMPT = [
  'Você recebe análises parciais de partes consecutivas da MESMA transcrição.',
  'Una todas em UMA única análise, com estas seções:',
  '',
  '1. Resumo',
  '2. Principais assuntos',
  '3. Pontos importantes',
  '4. Trechos potencialmente relevantes',
  '',
  'Elimine repetições, mantenha a ordem do conteúdo e preserve os timestamps.',
  'Use somente o que está nas análises recebidas; não invente informações.',
  'Cada item aparece uma única vez.',
  'Seja conciso: o Resumo em um único parágrafo de até 6 linhas e, nas outras seções, no máximo 8 itens cada.',
  'Responda em português.'
].join('\n');

// Medido com o modelo local (Qwen3-VL 2B): 7,9 mil caracteres de transcrição com tempos = 3,3 mil tokens (~2,6 caracteres por token).
const DEFAULT_CHUNK_CHARS = 6500;  // ~2,5 mil tokens: com o prompt e a resposta cabe numa janela de 4096
const MIN_CHUNK_CHARS = 2000;
const MAX_CHUNK_CHARS = 15000;     // o AIService recusa mensagens maiores que 20000 caracteres
const MERGE_INPUT_LIMIT = 10000;   // ~3,8 mil tokens de análises parciais por união
const TRANSCRIPT_EXTENSIONS = new Set(['.md', '.srt', '.vtt', '.txt']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Tamanho máximo da resposta (tokens) por etapa. A análise de uma parte pede "no máximo 15 linhas" (450 a 720 tokens medidos no
 * modelo local de 2B, que às vezes escreve mais) e a final cabe em ~1,5 mil. Não usa o limite global das configurações de IA (feito para a conversa): com 8192 um modelo em laço
 * gastava minutos, enchia a janela de contexto e o pedido sozinho passava do limite por minuto de servidores gratuitos.
 */
const STAGE_TOKENS = Object.freeze({ single: 2000, part: 1100, merge: 1600 });
const MAX_STAGE_TOKENS = 6000;
const REASONING_BOOST = 3;         // modelo que "pensa" gasta o teto pensando e devolve nada: libera mais espaço e refaz

/**
 * Amostragem recomendada no cartão oficial do Qwen3-VL-2B-Instruct (temperature 0.7, top_p 0.8, top_k 20, presence_penalty 1.5):
 * sem penalidade de repetição o servidor local (temperatura 0.8, top_k 40, repeat_penalty 1) deixa o modelo entrar em laço.
 * Só servidor local recebe estes campos (OpenAIProvider); Groq, OpenAI e similares seguem com os padrões deles.
 */
const ANALYSIS_SAMPLING = Object.freeze({ temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 });
const RETRY_SAMPLING = Object.freeze({ temperature: 0.5, top_p: 0.8, top_k: 20, presence_penalty: 2 });

const MIN_REPEAT_CHARS = 25;       // linha mais curta que isto não conta como repetição (ex.: "- Sim.")
const LOOP_DROPPED = 3;            // tantas repetições cortadas numa resposta = laço (vale refazer a chamada e avisar)
const MIN_REPEAT_SENTENCE = 40;
const MAX_SPLIT_DEPTH = 2;         // pedido grande demais: divide a parte ao meio, no máximo duas vezes seguidas
const DEFAULT_LIMIT_WAIT_S = 30;   // 429 sem Retry-After
const MIN_LIMIT_WAIT_S = 5;
const MAX_LIMIT_WAIT_S = 90;       // Retry-After maior que isto é limite do dia: esperar não adianta
const MAX_LIMIT_RETRIES = 4;

const cancelled = () => Object.assign(new Error('Análise cancelada.'), { code: 'CANCELLED' });
const throwIfCancelled = (signal) => { if (signal && signal.aborted) throw cancelled(); };

/** Espera `ms` (cancelável pelo `signal`). */
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) { reject(cancelled()); return; }
  const onAbort = () => { clearTimeout(timer); reject(cancelled()); };
  const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

// ------------------------------------------------------------------ leitura da transcrição

const TIME = '(?:\\d{1,3}:)?\\d{1,2}:\\d{2}(?:[.,]\\d{1,3})?';
const TIME_RANGE = new RegExp(`(${TIME})\\s*-->\\s*(${TIME})`);
const MD_LINE = /^\*\*\[(\d{1,3}:\d{2}:\d{2})\]\*\*\s*(.*)$/;

/** "01:02:03,500" | "02:03.5" → segundos */
function toSeconds(stamp) {
  const parts = String(stamp).replace(',', '.').split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

const squash = (text) => String(text).replace(/\s+/g, ' ').trim();

/** Legenda .srt/.vtt → trechos de ~20 s (uma linha por legenda gastaria tokens com os tempos). */
function parseSubtitle(text) {
  const segments = [];
  let cur = null;
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const range = TIME_RANGE.exec(lines[at]);
    if (!range) continue;
    const body = squash(lines.slice(at + 1).join(' ').replace(/<[^>]+>/g, ''));
    if (!body) continue;
    const start = toSeconds(range[1]);
    if (cur && start - cur.start < 20 && cur.text.length < 400) {
      cur.text += ` ${body}`;
    } else {
      if (cur) segments.push(cur);
      cur = { start, text: body };
    }
  }
  if (cur) segments.push(cur);
  return { title: '', segments };
}

/** Markdown do BDS (e do transcrever.py): "**[hh:mm:ss]** texto", com "# título" no topo. */
function parseMarkdown(text) {
  let title = '';
  const segments = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const hit = MD_LINE.exec(line);
    if (hit) { segments.push({ start: toSeconds(hit[1]), text: squash(hit[2]) }); continue; }
    if (!segments.length) {
      if (!title && /^#\s+/.test(line)) title = line.replace(/^#\s+/, '').trim();
      continue; // cabeçalho (título, "Transcrição automática…")
    }
    segments[segments.length - 1].text += ` ${squash(line)}`; // continuação do trecho anterior
  }
  return { title, segments: segments.filter((s) => s.text) };
}

/**
 * @param {string} raw
 * @returns {{title:string, segments:Array<{start:number|null,text:string}>}}
 */
function parseTranscript(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (TIME_RANGE.test(text)) {
    const sub = parseSubtitle(text);
    if (sub.segments.length) return sub;
  }
  const md = parseMarkdown(text);
  if (md.segments.length) return md;
  const paragraphs = text.split(/\n{2,}/).map(squash).filter(Boolean);
  return { title: '', segments: paragraphs.map((p) => ({ start: null, text: p })) };
}

// ------------------------------------------------------------------ divisão em partes

const renderSegment = (seg) => (seg.start === null ? seg.text : `[${formatStamp(seg.start)}] ${seg.text}`);

/** Corta um texto longo em pedaços de até `max`, preferindo o fim de uma frase. */
function splitLong(text, max) {
  const pieces = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    const sentence = /[.!?…]\s/g;
    for (let m = sentence.exec(window); m; m = sentence.exec(window)) if (m.index + 1 >= max * 0.5) cut = m.index + 1;
    if (cut < 0) cut = window.lastIndexOf(' ');
    if (cut < max * 0.3) cut = max; // sem ponto bom para cortar: corte seco
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * @returns {Array<{index:number, text:string, from:number|null, to:number|null}>}  partes de até `maxChars`
 */
function chunkTranscript(segments, maxChars = DEFAULT_CHUNK_CHARS) {
  const chunks = [];
  let lines = [];
  let length = 0;
  let from = null;
  let to = null;

  const flush = () => {
    if (lines.length) chunks.push({ index: chunks.length, text: lines.join('\n'), from, to });
    lines = []; length = 0; from = null; to = null;
  };

  for (const seg of segments) {
    const pieces = renderSegment(seg).length > maxChars
      ? splitLong(seg.text, maxChars - 12).map((t) => ({ start: seg.start, text: t }))
      : [seg];
    for (const piece of pieces) {
      const line = renderSegment(piece);
      if (lines.length && length + line.length + 1 > maxChars) flush();
      if (!lines.length) from = piece.start;
      lines.push(line);
      length += line.length + 1;
      to = piece.start;
    }
  }
  flush();
  return chunks;
}

/** Tempo (segundos) no começo de uma linha "[hh:mm:ss] texto"; `fallback` se a linha não tiver. */
function stampOf(line, fallback) {
  const hit = /^\[(\d{1,3}:\d{2}:\d{2})\]/.exec(String(line));
  return hit ? toSeconds(hit[1]) : fallback;
}

/**
 * Divide uma parte ao meio, no limite de uma linha (o servidor recusou o pedido por ser grande demais).
 * @returns {Array<{index:number, text:string, from:number|null, to:number|null}>|null}  null se não dá para dividir
 */
function splitChunk(chunk) {
  const lines = String(chunk.text).split('\n');
  if (lines.length < 2) return null;
  const half = chunk.text.length / 2;
  let used = 0;
  let at = 1;
  for (let i = 0; i < lines.length - 1; i++) {
    used += lines[i].length + 1;
    at = i + 1;
    if (used >= half) break;
  }
  const make = (ls) => ({ index: chunk.index, text: ls.join('\n'), from: stampOf(ls[0], chunk.from), to: stampOf(ls[ls.length - 1], chunk.to) });
  return [make(lines.slice(0, at)), make(lines.slice(at))];
}

// ------------------------------------------------------------------ chamadas ao modelo

/** Remove o "raciocínio" (<think>…</think>) que alguns modelos locais devolvem junto da resposta. */
function cleanModelText(text) {
  let t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const close = t.toLowerCase().lastIndexOf('</think>');
  if (close >= 0) t = t.slice(close + '</think>'.length);
  const open = t.toLowerCase().indexOf('<think>');
  if (open >= 0) t = t.slice(0, open); // raciocínio que nunca terminou (resposta cortada)
  return t.trim();
}

const normalizeItem = (line) => String(line).toLowerCase().replace(/^[\s>*\-•\d.)]+/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();

const isHeading = (line) => /^\s*(#{1,6}\s|\*\*[^*]{1,80}\*\*\s*$)/.test(line);

/**
 * Modelo pequeno às vezes entra em laço e repete a mesma linha (ou a mesma frase, dentro de um parágrafo) até esgotar o limite
 * de resposta. Dentro do mesmo bloco (entre dois títulos) uma linha igual a outra já escrita é descartada; entre blocos o mesmo
 * item pode voltar (um assunto também é ponto importante), a não ser que apareça 3 vezes ou mais: aí fica só a primeira.
 * @returns {{text:string, dropped:number}}  dropped = quantas repetições foram descartadas
 */
function dropRepeats(text) {
  const lines = String(text).split('\n');
  const count = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const lineCount = new Map();
  const sentenceCount = new Map();
  const sentencesOf = (line) => (line.length > 160 ? line.split(/(?<=[.!?…])\s+/) : [line]);
  for (const line of lines) {
    const key = normalizeItem(line);
    if (key.length >= MIN_REPEAT_CHARS) count(lineCount, key);
    const parts = sentencesOf(line);
    if (parts.length > 2) for (const s of parts) { const k = normalizeItem(s); if (k.length >= MIN_REPEAT_SENTENCE) count(sentenceCount, k); }
  }
  const seenLines = new Set();
  const seenSentences = new Set();
  let block = new Set();
  let dropped = 0;
  const out = [];
  for (const line of lines) {
    if (isHeading(line)) block = new Set();
    const key = normalizeItem(line);
    if (key.length >= MIN_REPEAT_CHARS) {
      if (block.has(key) || (lineCount.get(key) >= 3 && seenLines.has(key))) { dropped++; continue; }
      block.add(key);
      seenLines.add(key);
    }
    const parts = sentencesOf(line);
    if (parts.length > 2) {
      const keep = [];
      for (const s of parts) {
        const k = normalizeItem(s);
        if (k.length >= MIN_REPEAT_SENTENCE && sentenceCount.get(k) >= 3) {
          if (seenSentences.has(k)) { dropped++; continue; }
          seenSentences.add(k);
        }
        keep.push(s);
      }
      out.push(keep.join(' '));
    } else {
      out.push(line);
    }
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped };
}

const SECTION_TITLES = [/resumo/i, /principais assuntos/i, /pontos importantes/i, /trechos/i];
const hasAllSections = (text) => SECTION_TITLES.every((re) => re.test(text));
/** A união é UMA análise? Modelo pequeno às vezes só devolve as análises parciais uma depois da outra: o título "Resumo" volta. */
const mergedOnce = (text) => (String(text).match(/^[\s#>*_-]*(?:\d+\s*[.)]\s*)?\**\s*resumo\b/gim) || []).length <= 1;

/** Caminho de arquivo do computador (o servidor local informa o arquivo do modelo como se fosse o nome dele)? */
const looksLikePath = (s) => /^[A-Za-z]:[\\/]|^\\\\|^\/|\\/.test(s) || /\.gguf\b/i.test(s);

/** Nome do modelo para o documento: nunca um caminho do computador (revelaria a pasta e o nome de usuário do Windows). */
function displayModel(model, providerLabel = '') {
  const raw = String(model || '').trim();
  if (!raw) return '';
  if (looksLikePath(raw)) return String(providerLabel || '').trim().slice(0, 60) || 'modelo local';
  return raw.slice(0, 80);
}

/** Pedido grande demais para o servidor (413, limite de tokens por pedido ou janela de contexto estourada)? */
function tooLarge(err) {
  if (!err) return false;
  if (err.status === 413 || err.tooLarge === true || err.code === 'CONTEXT_OVERFLOW') return true;
  return err.status === 400 && /context (size|length|window)|too many tokens|maximum context/i.test(String(err.message || ''));
}

/** Segundos a esperar quando o servidor mandou esperar (limite por minuto); 0 = esperar não adianta (limite do dia, outro erro). */
function limitWaitSeconds(err) {
  if (!err || tooLarge(err) || !(err.rateLimited === true || err.status === 429)) return 0;
  const hinted = Number(err.retryAfter);
  const seconds = Number.isFinite(hinted) && hinted > 0 ? Math.ceil(hinted) : DEFAULT_LIMIT_WAIT_S;
  return seconds <= MAX_LIMIT_WAIT_S ? Math.max(MIN_LIMIT_WAIT_S, seconds) : 0;
}

const clampChunk = (n) => Math.min(MAX_CHUNK_CHARS, Math.max(MIN_CHUNK_CHARS, Math.round(Number(n)) || DEFAULT_CHUNK_CHARS));

const rangeText = (from, to) => (from !== null && to !== null ? `${formatStamp(from)}–${formatStamp(to)}` : '');

const labelOf = (item) => (item.first === item.last ? `Parte ${item.first}` : `Partes ${item.first} a ${item.last}`);

/** As análises parciais, uma atrás da outra com o título da parte (união por texto, sem o modelo). */
function assembleParts(group, cap = Infinity) {
  return group.map((item) => {
    const range = rangeText(item.from, item.to);
    return `### ${labelOf(item)}${range ? ` (${range})` : ''}\n${item.text.slice(0, cap)}`;
  }).join('\n\n');
}

/** Quantas chamadas de "união" são esperadas (estimativa, para a barra de andamento). */
function estimateMerges(parts, perGroup = 4) {
  let merges = 0;
  for (let level = parts; level > 1;) { level = Math.ceil(level / perGroup); merges += level; }
  return merges;
}

/** Agrupa análises parciais em grupos cujo texto cabe em `budget`; sempre reduz a quantidade. */
function groupForMerge(items, budget) {
  const groups = [];
  let group = [];
  let length = 0;
  for (const item of items) {
    const size = item.text.length + 40;
    if (group.length && length + size > budget) { groups.push(group); group = []; length = 0; }
    group.push(item);
    length += size;
  }
  if (group.length) groups.push(group);
  if (groups.length < items.length) return groups;
  // Cada análise já enche o orçamento sozinha: junta de duas em duas para garantir progresso.
  const pairs = [];
  for (let i = 0; i < items.length; i += 2) pairs.push(items.slice(i, i + 2));
  return pairs;
}

/**
 * @param {{text:string, title?:string}} input
 * @param {{chat:Function, maxChunkChars?:number, onProgress?:Function, signal?:AbortSignal, sleep?:Function}} ctx
 *   chat({ system, messages, signal, maxTokens, sampling }) → { text, usage, finishReason, model, provider }
 *   sleep(ms, signal): espera entre tentativas depois de um limite de uso (os testes trocam por uma espera instantânea)
 * @returns {Promise<{markdown:string, title:string, chunks:number, calls:number, truncated:boolean, repeated:boolean,
 *                    fallback:boolean, model:string, usage:{promptTokens:number, completionTokens:number}}>}
 */
async function analyzeTranscript({ text, title = '' }, { chat, maxChunkChars = DEFAULT_CHUNK_CHARS, onProgress = () => {}, signal = null, sleep = pause } = {}) {
  if (typeof chat !== 'function') throw new Error('Nenhum servidor de IA disponível para a análise.');
  const parsed = parseTranscript(text);
  if (!parsed.segments.length) throw new Error('A transcrição está vazia; não há conteúdo para analisar.');

  const budget = clampChunk(maxChunkChars);
  let chunks = chunkTranscript(parsed.segments, budget);
  let planned = chunks.length + (chunks.length > 1 ? estimateMerges(chunks.length) : 0);
  const state = {
    calls: 0, truncated: false, partCut: false, repeated: false, fallback: false, model: '', providerLabel: '',
    promptTokens: 0, completionTokens: 0, boost: 1, merges: 0
  };
  const percent = () => Math.min(99, Math.round((state.calls / planned) * 100));

  /**
   * Uma etapa da análise = uma chamada ao modelo (com as tentativas que valem a pena):
   *  - limite de uso do servidor: espera e tenta de novo (até MAX_LIMIT_RETRIES vezes);
   *  - resposta em laço: corta a repetição e refaz UMA vez com amostragem mais rígida;
   *  - resposta vazia porque o modelo gastou o teto "pensando": libera mais espaço para o resto da análise.
   */
  const ask = async (system, content, progress, stage) => {
    throwIfCancelled(signal);
    onProgress({ ...progress, percent: percent() });
    let waits = 0;
    let loopRetries = 0;
    for (;;) {
      let res;
      try {
        res = await chat({
          system, messages: [{ role: 'user', content }], signal,
          maxTokens: Math.min(MAX_STAGE_TOKENS, STAGE_TOKENS[stage] * state.boost),
          sampling: loopRetries ? RETRY_SAMPLING : ANALYSIS_SAMPLING
        });
      } catch (err) {
        const wait = waits < MAX_LIMIT_RETRIES ? limitWaitSeconds(err) : 0;
        if (!wait) throw err;
        waits++;
        onProgress({ stage: 'wait', seconds: wait, attempt: waits, percent: percent() });
        await sleep(wait * 1000, signal);
        throwIfCancelled(signal);
        continue;
      }
      state.calls++;
      if (res && res.model) { state.model = res.model; state.providerLabel = (res.provider && res.provider.label) || ''; }
      state.promptTokens += Number(res?.usage?.prompt_tokens) || 0;
      state.completionTokens += Number(res?.usage?.completion_tokens) || 0;
      const length = Boolean(res && res.finishReason === 'length');
      const cleaned = cleanModelText(res && res.text);
      if (!cleaned) {
        if (length && state.boost < REASONING_BOOST) { state.boost = REASONING_BOOST; continue; }
        throw new Error('O modelo não devolveu texto. Confira se há um modelo carregado no servidor de IA.');
      }
      const { text: answer, dropped } = dropRepeats(cleaned);
      const looped = dropped >= LOOP_DROPPED;
      if (looped && loopRetries < 1) { loopRetries++; continue; }
      if (looped) state.repeated = true;
      return { text: answer, looped, truncated: length };
    }
  };

  const item = (first, last, from, to, answerText) => ({ first, last, from, to, text: answerText });

  /** Analisa uma parte; se o servidor recusar por ser grande demais, divide a parte ao meio e analisa cada metade. */
  const analyzePart = async (chunk, n, depth) => {
    const range = rangeText(chunk.from, chunk.to);
    const system = `${SYSTEM_PROMPT}\n\nA transcrição completa é longa e foi dividida em partes. Esta é a parte ${chunk.index + 1} de ${n}`
      + `${range ? ` (de ${range.replace('–', ' a ')})` : ''}. Analise somente esta parte, de forma concisa `
      + '(no máximo 15 linhas no total); as análises das partes serão unidas depois.';
    try {
      const answer = await ask(system, `TRANSCRIÇÃO (parte ${chunk.index + 1} de ${n}):\n\n${chunk.text}`,
        { stage: 'part', index: chunk.index + 1, total: n }, 'part');
      if (answer.truncated) state.partCut = true; // só vira aviso se a união falhar e o documento trouxer as partes
      return [item(chunk.index + 1, chunk.index + 1, chunk.from, chunk.to, answer.text)];
    } catch (err) {
      const halves = tooLarge(err) && depth < MAX_SPLIT_DEPTH ? splitChunk(chunk) : null;
      if (!halves) throw err;
      planned += 1;
      const out = [];
      for (const half of halves) out.push(...await analyzePart(half, n, depth + 1));
      return out;
    }
  };

  /** Une um grupo de análises parciais numa só. Se a união falhar ou sair ruim, devolve as análises uma atrás da outra. */
  const mergeGroup = async (group, shrink = 1) => {
    const cap = Math.max(300, Math.floor((MERGE_INPUT_LIMIT * shrink) / group.length) - 80);
    const first = group[0];
    const last = group[group.length - 1];
    const whole = (answerText) => item(first.first, last.last, first.from, last.to, answerText);
    state.merges++;
    try {
      const answer = await ask(MERGE_PROMPT, `ANÁLISES PARCIAIS:\n\n${assembleParts(group, cap)}`,
        { stage: 'merge', index: state.merges, total: null }, 'merge');
      // laço que sobrou, análises só coladas uma atrás da outra ou resposta cortada sem as quatro seções: a união não presta
      // e as partes (completas, com o trecho de tempo de cada uma) valem mais
      if (!answer.looped && mergedOnce(answer.text) && !(answer.truncated && !hasAllSections(answer.text))) {
        if (answer.truncated) state.truncated = true;
        return whole(answer.text);
      }
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw err;
      if (tooLarge(err) && shrink > 0.3) return mergeGroup(group, shrink / 2);
    }
    state.fallback = true;
    return whole(assembleParts(group));
  };

  let markdown;
  if (chunks.length === 1) {
    try {
      const answer = await ask(SYSTEM_PROMPT, `TRANSCRIÇÃO:\n\n${chunks[0].text}`, { stage: 'analyze', index: 1, total: 1 }, 'single');
      if (answer.truncated) state.truncated = true;
      markdown = answer.text;
    } catch (err) {
      const halves = tooLarge(err) ? splitChunk(chunks[0]) : null;
      if (!halves) throw err;
      chunks = halves.map((c, i) => ({ ...c, index: i }));
      planned = chunks.length + estimateMerges(chunks.length);
    }
  }
  if (markdown === undefined) {
    const n = chunks.length;
    let level = [];
    for (const chunk of chunks) level.push(...await analyzePart(chunk, n, 0));

    while (level.length > 1) {
      const groups = groupForMerge(level, MERGE_INPUT_LIMIT);
      const next = [];
      for (const group of groups) next.push(group.length === 1 ? group[0] : await mergeGroup(group));
      level = next;
    }
    markdown = level[0].text;
  }

  onProgress({ stage: 'done', percent: 100 });
  return {
    markdown, title: title || parsed.title, chunks: chunks.length, calls: state.calls,
    truncated: state.truncated || (state.fallback && state.partCut), repeated: state.repeated, fallback: state.fallback,
    model: displayModel(state.model, state.providerLabel),
    usage: { promptTokens: state.promptTokens, completionTokens: state.completionTokens }
  };
}

/** Documento Markdown final (.analise.md) com o aviso de que foi gerado por IA e o que aconteceu de diferente no caminho. */
function formatAnalysisDocument({ title = '', model = '', markdown, chunks = 1, truncated = false, repeated = false, fallback = false }) {
  const name = displayModel(model);
  const notes = [`Gerada por IA${name ? ` (${name})` : ''}. Confira com a transcrição: a IA pode errar ou omitir detalhes.`];
  if (chunks > 1) notes.push(`A transcrição era longa e foi analisada em ${chunks} partes.`);
  if (fallback) notes.push('A união das partes não ficou boa; o documento traz a análise de cada parte, em ordem.');
  if (repeated) notes.push('O modelo repetiu trechos; as repetições foram removidas e a análise pode estar incompleta.');
  if (truncated) notes.push('Uma resposta do modelo foi cortada pelo limite de tamanho; a análise pode estar incompleta.');
  return `# ${title ? `Análise: ${title}` : 'Análise da transcrição'}\n\n${notes.map((n) => `> ${n}`).join('\n>\n')}\n\n${String(markdown).trim()}\n`;
}

/** Lê o arquivo de transcrição (.md/.srt/.vtt/.txt, até 5 MB) para análise. */
function readTranscriptFile(filePath) {
  const file = String(filePath || '');
  if (!path.isAbsolute(file)) throw new Error('Caminho da transcrição inválido.');
  const ext = path.extname(file).toLowerCase();
  if (!TRANSCRIPT_EXTENSIONS.has(ext)) throw new Error('Formato não suportado para análise (use .md, .srt, .vtt ou .txt).');
  let stat;
  // lstat: um link simbólico (que poderia apontar para fora das pastas de transcrição) é recusado
  try { stat = fs.lstatSync(file); } catch (_) { throw new Error('Arquivo da transcrição não encontrado.'); }
  if (stat.isSymbolicLink()) throw new Error('Link simbólico não é aceito como transcrição.');
  if (!stat.isFile()) throw new Error('Arquivo da transcrição não encontrado.');
  if (stat.size > MAX_FILE_BYTES) throw new Error('Transcrição grande demais para analisar (máximo 5 MB).');
  return { text: fs.readFileSync(file, 'utf8'), title: path.basename(file, ext) };
}

/**
 * Tarefa "analyzeTranscript" do registro de tarefas de IA.
 * payload: { text?:string, filePath?:string, title?:string, maxChunkChars?:number }
 * @returns {Promise<{document:string, markdown:string, title:string, chunks:number, calls:number, truncated:boolean,
 *                    repeated:boolean, fallback:boolean}>}
 */
async function runAnalyzeTranscript(payload, ctx = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  let text = typeof p.text === 'string' ? p.text : '';
  let title = String(p.title || '').slice(0, 200);
  if (!text.trim() && p.filePath) {
    const file = readTranscriptFile(p.filePath);
    text = file.text;
    title = title || file.title;
  }
  const result = await analyzeTranscript({ text, title }, {
    chat: ctx.chat, maxChunkChars: p.maxChunkChars, onProgress: ctx.onProgress, signal: ctx.signal, sleep: ctx.sleep
  });
  const finalTitle = title || result.title;
  const model = result.model || displayModel(typeof ctx.model === 'function' ? ctx.model() : '');
  return {
    ...result, title: finalTitle,
    document: formatAnalysisDocument({
      title: finalTitle, model, markdown: result.markdown, chunks: result.chunks,
      truncated: result.truncated, repeated: result.repeated, fallback: result.fallback
    })
  };
}

module.exports = {
  SYSTEM_PROMPT, MERGE_PROMPT, DEFAULT_CHUNK_CHARS, MIN_CHUNK_CHARS, MAX_CHUNK_CHARS, MERGE_INPUT_LIMIT, TRANSCRIPT_EXTENSIONS,
  STAGE_TOKENS, ANALYSIS_SAMPLING, RETRY_SAMPLING,
  parseTranscript, chunkTranscript, splitChunk, cleanModelText, dropRepeats, displayModel, analyzeTranscript,
  formatAnalysisDocument, readTranscriptFile, runAnalyzeTranscript
};
