'use strict';

/**
 * Orçamento de contexto do assistente: quanto da conversa cabe na janela de cada provedor.
 *
 * PROBLEMA: o modelo local do app rodava com janela de 4096 tokens (hoje 8192, ver presets.EMBEDDED_CONTEXT), e
 * Ollama e LM Studio carregam com 4096 por padrão. O prompt de sistema (~900 tokens), as definições das ferramentas
 * (1.500 ou mais) e a reserva da resposta ocupam boa parte disso; antes, o histórico ia inteiro (até 40 mensagens) e
 * o servidor recusava o pedido depois de poucas trocas.
 *
 * Estimativa conferida com o tokenizador real do Qwen2.5 (llama-server): 3,2 caracteres por token em português.
 *
 * DECISÃO: estimativa conservadora (caracteres / 3; os tokenizadores reais ficam entre 3 e 4 caracteres por token em
 * português e JSON) em vez de um tokenizador por modelo, que o app não tem como conhecer para todos os provedores.
 * Antes de cada envio, a conversa é encaixada no orçamento das mensagens mais novas para as mais antigas; o turno
 * atual (pergunta + chamadas e resultados de ferramentas) nunca é partido. A memória de longo prazo vem do resumo
 * (AssistantChat + ChatHistory); isto aqui é a rede de segurança que impede o estouro.
 */

const { EMBEDDED_CONTEXT } = require('./providers/presets');

const CHARS_PER_TOKEN = 3;
const MSG_OVERHEAD = 6;             // marcação do template por mensagem (papel, separadores)
const SAFETY_MIN = 128;
const SAFETY_RATIO = 0.08;          // folga para o erro da estimativa
const MIN_TOOL_CHARS = 400;         // resultado de ferramenta cortado para caber nunca fica menor que isto
const CUT_NOTE = '\n[resultado cortado para caber na memória do modelo]';

/** Janelas conhecidas dos provedores na nuvem (modelos sugeridos pelos presets). */
const KNOWN_WINDOWS = Object.freeze({ groq: 131072, qwencloud: 131072, openai: 128000 });
const LOCAL_UNKNOWN = 4096;         // Ollama e LM Studio carregam com 4096 por padrão
const REMOTE_UNKNOWN = 8192;

const isLocalUrl = (raw) => {
  try {
    const h = new URL(String(raw || '')).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h) || h.endsWith('.localhost');
  } catch (_) { return false; }
};

/** Tokens estimados de um texto (conservador: arredonda para cima). */
function estimateTokens(text) {
  const s = typeof text === 'string' ? text : (text == null ? '' : JSON.stringify(text));
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/** Tokens estimados de uma mensagem (conteúdo + chamadas de ferramenta + marcação). */
function messageTokens(m) {
  if (!m) return 0;
  let n = MSG_OVERHEAD + estimateTokens(typeof m.content === 'string' ? m.content : '');
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) n += estimateTokens(JSON.stringify(m.tool_calls));
  return n;
}

const conversationTokens = (list) => (Array.isArray(list) ? list.reduce((s, m) => s + messageTokens(m), 0) : 0);

/**
 * Janela de contexto (tokens) de um provedor: o modelo local do app tem janela fixa; os da nuvem, a conhecida do
 * preset; local desconhecido (Ollama, LM Studio, personalizado na máquina) assume 4096; remoto desconhecido, 8192.
 * @param {{preset?:string, baseUrl?:string}} p
 */
function contextWindowFor(p) {
  if (!p) return LOCAL_UNKNOWN;
  if (p.preset === 'embedded') return EMBEDDED_CONTEXT;
  if (KNOWN_WINDOWS[p.preset]) return KNOWN_WINDOWS[p.preset];
  if (p.preset === 'lmstudio' || p.preset === 'ollama' || isLocalUrl(p.baseUrl)) return LOCAL_UNKNOWN;
  return REMOTE_UNKNOWN;
}

/** Tokens reservados para a resposta: o configurado, mas no máximo 1/8 da janela (512 numa janela de 4096). */
function replyReserve(window, maxTokens) {
  const cap = Math.max(64, Math.floor(window / 8));
  const want = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 1024;
  return Math.max(64, Math.min(want, cap));
}

/** Tokens que sobram para a conversa depois do prompt de sistema, das ferramentas, da resposta e da folga. */
function historyBudget({ window, reserve, systemTokens = 0, toolsTokens = 0 }) {
  const safety = Math.max(SAFETY_MIN, Math.floor(window * SAFETY_RATIO));
  return Math.max(0, window - reserve - systemTokens - toolsTokens - safety);
}

/** Corta os resultados de ferramenta do turno (os maiores primeiro) até o turno caber em `budget`. */
function shrinkToolResults(turn, budget) {
  const out = turn.map((m) => ({ ...m }));
  let over = conversationTokens(out) - budget;
  if (over <= 0) return out;
  const tools = out.map((m, i) => ({ m, i })).filter((x) => x.m.role === 'tool' && typeof x.m.content === 'string')
    .sort((a, b) => b.m.content.length - a.m.content.length);
  for (const { m } of tools) {
    if (over <= 0) break;
    const room = m.content.length - MIN_TOOL_CHARS;
    if (room <= 0) continue;
    const cutChars = Math.min(room, over * CHARS_PER_TOKEN + CUT_NOTE.length);
    const before = messageTokens(m);
    m.content = m.content.slice(0, m.content.length - cutChars) + CUT_NOTE;
    over -= before - messageTokens(m);
  }
  return out;
}

/**
 * Encaixa a conversa no orçamento. O turno atual (da última mensagem do usuário em diante) vai inteiro. Do histórico
 * anterior entram as mensagens mais novas que couberem, começando sempre por uma mensagem do usuário.
 * `shrinkTools`: se nem o turno cabe, encurta os resultados de ferramenta dele. Só depois de o servidor recusar o
 * tamanho (a estimativa é conservadora; cortar antes estragaria resultados que caberiam).
 * @param {Array<object>} messages
 * @param {number} budget  tokens disponíveis para as mensagens
 * @param {{shrinkTools?:boolean}} [opts]
 * @returns {{messages:Array<object>, dropped:number, fits:boolean}}
 */
function fitConversation(messages, budget, { shrinkTools = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let start = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === 'user') { start = i; break; }
  }
  if (start < 0) return { messages: list, dropped: 0, fits: conversationTokens(list) <= budget };
  const past = list.slice(0, start);
  let turn = list.slice(start);
  if (shrinkTools && conversationTokens(turn) > budget) turn = shrinkToolResults(turn, budget);
  const turnTokens = conversationTokens(turn);
  let room = budget - turnTokens;
  let keepFrom = past.length;
  for (let i = past.length - 1; i >= 0; i--) {
    const t = messageTokens(past[i]);
    if (t > room) break;
    room -= t;
    keepFrom = i;
  }
  while (keepFrom < past.length && past[keepFrom].role !== 'user') keepFrom++;
  const kept = past.slice(keepFrom);
  return { messages: [...kept, ...turn], dropped: past.length - kept.length, fits: turnTokens <= budget };
}

/** O servidor recusou o pedido por excesso de contexto? (llama.cpp, LM Studio, Ollama, OpenAI, Groq...) */
function isContextOverflow(err) {
  if (!err) return false;
  if (err.code === 'CONTEXT_OVERFLOW') return true;
  const text = `${err.message || ''} ${err.body || ''}`;
  const statusOk = err.status === undefined || [400, 413, 422, 500].includes(err.status) || err.code === 'STREAM_ERROR';
  return statusOk && /exceeds? (the )?(available )?context|context[ _-]?(length|size|window)|maximum context|too many tokens|reduce the length|prompt is too long|input is too long|n_ctx/i.test(text);
}

/**
 * Insere `message` logo antes do turno atual (a última mensagem do usuário). Usado para o bloco que muda (resumo e
 * contexto da tela) ficar depois do histórico, que assim continua em cache no servidor local. Não altera a lista.
 */
function insertBeforeTurn(messages, message) {
  const list = Array.isArray(messages) ? messages : [];
  let at = list.length;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === 'user') { at = i; break; }
  }
  return [...list.slice(0, at), message, ...list.slice(at)];
}

module.exports = {
  estimateTokens, messageTokens, conversationTokens, contextWindowFor, replyReserve, historyBudget,
  fitConversation, insertBeforeTurn, isContextOverflow, CHARS_PER_TOKEN, KNOWN_WINDOWS, LOCAL_UNKNOWN, REMOTE_UNKNOWN
};
