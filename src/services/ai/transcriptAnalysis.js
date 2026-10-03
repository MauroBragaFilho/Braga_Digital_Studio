'use strict';

/**
 * transcriptAnalysis.js — Análise de transcrições por IA (resumo, assuntos, pontos importantes, trechos).
 *
 * Fluxo do projeto "Whisper + LM Studio" (mesmo prompt e mesmas seções), agora sobre o AIService do BDS,
 * que fala com qualquer servidor compatível com a OpenAI (LM Studio, Ollama, OpenAI…).
 *
 * Transcrição longa não cabe na janela de contexto de um modelo local. Então:
 *   1. o texto é dividido em partes por tempo (cada parte cabe em `maxChunkChars`);
 *   2. cada parte é analisada de forma concisa;
 *   3. as análises parciais são unidas em grupos, repetidamente, até sobrar uma só análise final.
 * Transcrição curta vai inteira numa única chamada (igual ao script original).
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
  'Responda em português.'
].join('\n');

const DEFAULT_CHUNK_CHARS = 8000;  // ~2,3 mil tokens: cabe numa janela de 4096 com a resposta
const MIN_CHUNK_CHARS = 2000;
const MAX_CHUNK_CHARS = 15000;     // o AIService recusa mensagens maiores que 20000 caracteres
const MERGE_INPUT_LIMIT = 15000;
const TRANSCRIPT_EXTENSIONS = new Set(['.md', '.srt', '.vtt', '.txt']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const cancelled = () => Object.assign(new Error('Análise cancelada.'), { code: 'CANCELLED' });
const throwIfCancelled = (signal) => { if (signal && signal.aborted) throw cancelled(); };

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

const clampChunk = (n) => Math.min(MAX_CHUNK_CHARS, Math.max(MIN_CHUNK_CHARS, Math.round(Number(n)) || DEFAULT_CHUNK_CHARS));

const rangeText = (from, to) => (from !== null && to !== null ? `${formatStamp(from)}–${formatStamp(to)}` : '');

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
 * @param {{chat:Function, maxChunkChars?:number, onProgress?:Function, signal?:AbortSignal}} ctx
 * @returns {Promise<{markdown:string, title:string, chunks:number, calls:number, truncated:boolean,
 *                    model:string, usage:{promptTokens:number, completionTokens:number}}>}
 */
async function analyzeTranscript({ text, title = '' }, { chat, maxChunkChars = DEFAULT_CHUNK_CHARS, onProgress = () => {}, signal = null } = {}) {
  if (typeof chat !== 'function') throw new Error('Nenhum servidor de IA disponível para a análise.');
  const parsed = parseTranscript(text);
  if (!parsed.segments.length) throw new Error('A transcrição está vazia; não há conteúdo para analisar.');

  const budget = clampChunk(maxChunkChars);
  const chunks = chunkTranscript(parsed.segments, budget);
  const planned = chunks.length + (chunks.length > 1 ? estimateMerges(chunks.length) : 0);
  const state = { calls: 0, truncated: false, model: '', promptTokens: 0, completionTokens: 0 };

  const ask = async (system, content, progress) => {
    throwIfCancelled(signal);
    onProgress({ ...progress, percent: Math.min(99, Math.round((state.calls / planned) * 100)) });
    const res = await chat({ system, messages: [{ role: 'user', content }], signal });
    state.calls++;
    if (res && res.finishReason === 'length') state.truncated = true;
    if (res && res.model) state.model = res.model;
    state.promptTokens += Number(res?.usage?.prompt_tokens) || 0;
    state.completionTokens += Number(res?.usage?.completion_tokens) || 0;
    const answer = cleanModelText(res && res.text);
    if (!answer) throw new Error('O modelo não devolveu texto. Confira se há um modelo carregado no servidor de IA.');
    return answer;
  };

  let markdown;
  if (chunks.length === 1) {
    markdown = await ask(SYSTEM_PROMPT, `TRANSCRIÇÃO:\n\n${chunks[0].text}`, { stage: 'analyze', index: 1, total: 1 });
  } else {
    const n = chunks.length;
    let level = [];
    for (const chunk of chunks) {
      const range = rangeText(chunk.from, chunk.to);
      const system = `${SYSTEM_PROMPT}\n\nA transcrição completa é longa e foi dividida em partes. Esta é a parte ${chunk.index + 1} de ${n}`
        + `${range ? ` (de ${range.replace('–', ' a ')})` : ''}. Analise somente esta parte, de forma concisa `
        + '(no máximo 15 linhas no total); as análises das partes serão unidas depois.';
      const answer = await ask(system, `TRANSCRIÇÃO (parte ${chunk.index + 1} de ${n}):\n\n${chunk.text}`,
        { stage: 'part', index: chunk.index + 1, total: n });
      level.push({ first: chunk.index + 1, last: chunk.index + 1, from: chunk.from, to: chunk.to, text: answer });
    }

    while (level.length > 1) {
      const groups = groupForMerge(level, budget);
      const next = [];
      for (const group of groups) {
        if (group.length === 1) { next.push(group[0]); continue; }
        const cap = Math.floor(MERGE_INPUT_LIMIT / group.length) - 80;
        const body = group.map((item) => {
          const label = item.first === item.last ? `Parte ${item.first}` : `Partes ${item.first} a ${item.last}`;
          const range = rangeText(item.from, item.to);
          return `### ${label}${range ? ` (${range})` : ''}\n${item.text.slice(0, cap)}`;
        }).join('\n\n');
        const answer = await ask(MERGE_PROMPT, `ANÁLISES PARCIAIS:\n\n${body}`, { stage: 'merge', index: state.calls - n + 1, total: null });
        next.push({
          first: group[0].first, last: group[group.length - 1].last,
          from: group[0].from, to: group[group.length - 1].to, text: answer
        });
      }
      level = next;
    }
    markdown = level[0].text;
  }

  onProgress({ stage: 'done', percent: 100 });
  return {
    markdown, title: title || parsed.title, chunks: chunks.length, calls: state.calls,
    truncated: state.truncated, model: state.model,
    usage: { promptTokens: state.promptTokens, completionTokens: state.completionTokens }
  };
}

/** Documento Markdown final (.analise.md) com o aviso de que foi gerado por IA. */
function formatAnalysisDocument({ title = '', model = '', markdown, chunks = 1, truncated = false }) {
  const notes = [`Gerada por IA${model ? ` (${model})` : ''}. Confira com a transcrição: a IA pode errar ou omitir detalhes.`];
  if (chunks > 1) notes.push(`A transcrição era longa e foi analisada em ${chunks} partes.`);
  if (truncated) notes.push('Alguma resposta foi cortada pelo limite de tamanho do modelo; aumente esse limite nas configurações de IA para uma análise mais completa.');
  return `# ${title ? `Análise: ${title}` : 'Análise da transcrição'}\n\n${notes.map((n) => `> ${n}`).join('\n>\n')}\n\n${String(markdown).trim()}\n`;
}

/** Lê o arquivo de transcrição (.md/.srt/.vtt/.txt, até 5 MB) para análise. */
function readTranscriptFile(filePath) {
  const file = String(filePath || '');
  if (!path.isAbsolute(file)) throw new Error('Caminho da transcrição inválido.');
  const ext = path.extname(file).toLowerCase();
  if (!TRANSCRIPT_EXTENSIONS.has(ext)) throw new Error('Formato não suportado para análise (use .md, .srt, .vtt ou .txt).');
  let stat;
  try { stat = fs.statSync(file); } catch (_) { throw new Error('Arquivo da transcrição não encontrado.'); }
  if (!stat.isFile()) throw new Error('Arquivo da transcrição não encontrado.');
  if (stat.size > MAX_FILE_BYTES) throw new Error('Transcrição grande demais para analisar (máximo 5 MB).');
  return { text: fs.readFileSync(file, 'utf8'), title: path.basename(file, ext) };
}

/**
 * Tarefa "analyzeTranscript" do registro de tarefas de IA.
 * payload: { text?:string, filePath?:string, title?:string, maxChunkChars?:number }
 * @returns {Promise<{document:string, markdown:string, title:string, chunks:number, calls:number, truncated:boolean}>}
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
    chat: ctx.chat, maxChunkChars: p.maxChunkChars, onProgress: ctx.onProgress, signal: ctx.signal
  });
  const finalTitle = title || result.title;
  const model = result.model || (typeof ctx.model === 'function' ? ctx.model() : '');
  return {
    ...result, title: finalTitle,
    document: formatAnalysisDocument({ title: finalTitle, model, markdown: result.markdown, chunks: result.chunks, truncated: result.truncated })
  };
}

module.exports = {
  SYSTEM_PROMPT, MERGE_PROMPT, DEFAULT_CHUNK_CHARS, MIN_CHUNK_CHARS, MAX_CHUNK_CHARS, TRANSCRIPT_EXTENSIONS,
  parseTranscript, chunkTranscript, cleanModelText, analyzeTranscript, formatAnalysisDocument,
  readTranscriptFile, runAnalyzeTranscript
};
