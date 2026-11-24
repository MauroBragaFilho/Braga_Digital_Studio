'use strict';

/**
 * AssistantChat — conversa do assistente flutuante (processo principal). Uma conversa ATIVA por vez.
 * O histórico mora aqui (ChatHistory): o renderer só manda o texto novo, então não consegue forjar nem estender o
 * contexto além do limite. Eventos (via `emit`):
 *   ai:chatDelta { id, text }                          pedaço da resposta
 *   ai:chatDone  { id, text, finishReason, cancelled } fim (cancelado: text = o que já tinha chegado)
 *   ai:chatError { id, error, code }                   falha (a mensagem do usuário NÃO entra no histórico)
 *   ai:chatStatus { id, text, kind }                   linha de status discreta: kind 'tool' (consultando/executando),
 *                                                      'confirm' (aguardando confirmação), 'progress', 'notice' (aviso
 *                                                      que fica na conversa), 'clear' (apaga a linha de status),
 *                                                      'provider' (nome do provedor em uso, para o cabeçalho do painel),
 *                                                      'fallback' (linha discreta "Usando Qwen (Groq indisponível)") ou
 *                                                      'reset' (texto = o que deve ficar na tela: o provedor que falhou
 *                                                      no meio da resposta tinha entregue texto parcial, descartado)
 *
 * LAÇO DE FERRAMENTAS (function calling): se há `toolbox`, as definições vão junto da conversa; quando o modelo pede
 * ferramentas, o app as executa (ToolBox, com a confirmação do app nas ações: modal do próprio app, diálogo nativo como reserva), devolve cada resultado como mensagem de
 * papel "tool" e repete até a resposta final. Limites: MAX_ITERATIONS rodadas de ferramentas, MAX_CALLS_PER_TURN
 * chamadas por resposta do modelo e MAX_CALLS_TOTAL por pergunta; depois disso o modelo é obrigado a responder em texto.
 * Servidor/modelo sem suporte a ferramentas: cai para só texto, com um aviso amigável (uma vez por servidor+modelo).
 * O histórico persistido guarda só user/assistant (nunca resultados de ferramentas).
 *
 * FALLBACK ENTRE PROVEDORES: a troca acontece dentro do AIService.chatStream, que reenvia ao próximo provedor a MESMA
 * lista `convo` (inclusive as mensagens de ferramenta do turno): a conversa continua do ponto em que estava e uma
 * ação já executada não se repete (o resultado dela já está em `convo`). Aqui só se traduzem os avisos em status
 * ('provider', 'fallback', 'reset'); o histórico persistido recebe a resposta final uma única vez.
 *
 * CONTEXTO DA TELA: `start(texto, contexto)` recebe o contexto opcional do renderer ({ screen, selectedIds, projectId }),
 * validado em context.js (BAD_CONTEXT se fugir do esquema) e acrescentado ao prompt de sistema como dado NÃO confiável.
 * FERRAMENTAS POR TURNO: a cada rodada só o subconjunto relevante das definições vai ao modelo (tools/toolSelect.js);
 * o ToolBox continua aceitando e validando a lista fixa inteira.
 *
 * MEMÓRIA EM CONVERSAS LONGAS: depois de cada resposta, se a conversa passou de COMPACT_AT do orçamento do provedor
 * principal (AIService.historyBudget), as mensagens mais antigas viram um resumo (AIService.summarizeConversation),
 * guardado no ChatHistory. Ao modelo vão o resumo (no prompt de sistema, como dado) e só as mensagens recentes; na
 * tela a conversa continua inteira. Se o resumo falhar, nada se perde: o AIService encaixa a conversa na janela de
 * cada provedor (contextBudget) e as mais antigas simplesmente ficam de fora. A próxima pergunta espera o resumo
 * em andamento terminar ("Organizando a memória da conversa…").
 *
 * RESUMO EXTRATIVO: o modelo local do app (Qwen2.5 0.5B) inventa e se repete quando resume (visto no teste real:
 * "192kbps" como alvo de loudness). Com ele, e como reserva quando o resumo pela IA falha, a memória guarda as
 * próprias frases do usuário (é nelas que estão os fatos: câmera, perfil de cor, metas), sem chamar o modelo.
 */

const { MAX_MESSAGES, MAX_MESSAGE_CHARS, switchLine } = require('./AIService');
const { validateContext, buildContextBlock } = require('./context');
const { matchCommand, runCommand } = require('./commands');
const { selectToolNames } = require('./tools/toolSelect');
const { estimateTokens, messageTokens, conversationTokens, CHARS_PER_TOKEN } = require('./contextBudget');

let seq = 0;

const MAX_ITERATIONS = 6;        // rodadas de ferramentas por pergunta
const MAX_CALLS_PER_TURN = 4;    // chamadas atendidas por resposta do modelo
const MAX_CALLS_TOTAL = 10;      // chamadas atendidas por pergunta
const NO_TOOLS_NOTICE = 'Este modelo não permite consultar nem alterar o app. Vou responder só em conversa.';
const EMPTY_AFTER_TOOLS = 'Não consegui concluir o pedido com as ferramentas do app. Tente reformular ou pedir de outro jeito.';
const COMPACT_AT = 0.7;          // resume quando a conversa passa disto do orçamento
const KEEP_RECENT = 0.35;        // depois do resumo, as mensagens recentes ocupam no máximo isto do orçamento
const COMPACT_COOLDOWN = 2;      // resumo pela IA falhou: os próximos (esta quantidade) vão direto pelo extrativo
const SUMMARY_NOTICE = 'A conversa ficou longa: as mensagens mais antigas foram resumidas para continuar.';
const TRIMMED_NOTICE = 'A conversa ficou longa para este modelo: as mensagens mais antigas ficaram de fora.';
const MEMORY_STATUS = 'Organizando a memória da conversa…';
const EXTRACT_LINE_CHARS = 240;  // cada frase do usuário entra no resumo extrativo com no máximo isto
const EXTRACT_MIN_LINE = 60;     // abaixo disto por linha, a mais antiga sai em vez de todas encolherem

const cutLine = (line, max) => (line.length > max ? `${line.slice(0, Math.max(1, max - 1)).trimEnd()}…` : line);

/**
 * Resumo extrativo (sem IA): o resumo anterior mais as frases do usuário das mensagens que saem, uma por linha. Se
 * passar de `maxChars`, primeiro todas as linhas encolhem por igual (o começo de cada frase costuma ter o fato:
 * "Gravei com uma Sony FX3…"); só quando cada uma ficaria com menos de EXTRACT_MIN_LINE, a mais antiga sai.
 */
function extractiveSummary(previous, messages, maxChars) {
  const said = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim())
    .map((m) => cutLine(`- O usuário disse: ${m.content.replace(/\s+/g, ' ').trim()}`, EXTRACT_LINE_CHARS));
  let lines = [...String(previous || '').split(/\r?\n/).filter((l) => l.trim()), ...said];
  for (;;) {
    const fits = (cap) => lines.reduce((sum, l) => sum + Math.min(l.length, cap), 0) + lines.length - 1 <= maxChars;
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    if (fits(longest)) return lines.join('\n');
    // maior limite por linha que ainda cabe (busca binária)
    let lo = 0;
    let hi = longest;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
    if (lo >= EXTRACT_MIN_LINE || lines.length === 1) {
      const text = lines.map((l) => cutLine(l, Math.max(1, lo))).join('\n');
      return text.length > maxChars ? cutLine(text, maxChars) : text;
    }
    lines = lines.slice(1);
  }
}

class AssistantChat {
  /**
   * @param {{ ai: import('./AIService'), history: import('./ChatHistory'), emit: (channel:string, payload:object)=>void,
   *           timeouts?: object, toolbox?: import('./tools').ToolBox }} deps  `timeouts` (teste): { firstChunkTimeoutMs, idleTimeoutMs }
   */
  constructor({ ai, history, emit, timeouts = {}, toolbox = null, localCommands = true }) {
    this.toolbox = toolbox;
    this.localCommands = localCommands !== false; // comandos simples por regras (commands.js); testes do laço do modelo desligam
    this._noTools = new Set();   // servidor+modelo que recusaram ferramentas (avisado uma vez)
    this.ai = ai;
    this.history = history;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.timeouts = timeouts;
    this._active = null;
    this._compacting = null;       // resumo em andamento (Promise) ou null
    this._compactController = null;
    this._compactCooldown = 0;
    this._noticeSummary = false;   // avisar na próxima pergunta que houve resumo
    this._noticedTrim = false;     // aviso de corte já dado nesta conversa
    this._stableTools = [];        // prompt estável (modelo local): ferramentas já oferecidas, na ordem em que entraram
  }

  isBusy() { return this._active !== null; }

  /**
   * O pedido é um comando simples que as regras (commands.js) resolvem sem modelo de IA? Então funciona mesmo sem
   * servidor configurado e nada sai do computador (o aviso de privacidade não se aplica).
   */
  canHandleLocally(text) {
    return this.localCommands && Boolean(this.toolbox) && matchCommand(text) !== null;
  }

  /** Esquece que o servidor/modelo recusou ferramentas (a configuração mudou: vale tentar de novo). */
  forgetToolSupport() {
    this._noTools.clear();
    if (this.ai && typeof this.ai.forgetToolSupport === 'function') this.ai.forgetToolSupport();
  }

  getHistory() { return this.history.get(); }

  /** Cancela a resposta em andamento (se houver) e apaga o histórico. */
  clear() {
    if (this._active) { this._active.discard = true; this._active.controller.abort(); }
    if (this._compactController) this._compactController.abort();
    this.history.clear();
    this._noticeSummary = false;
    this._noticedTrim = false;
    this._compactCooldown = 0;
    this._stableTools = [];
    return true;
  }

  /**
   * Definições de ferramentas a oferecer nesta rodada. Normalmente, o subconjunto que combina com o pedido
   * (toolSelect). Com o modelo local do app (AIService.prefersStablePrompt), a lista da conversa só CRESCE e cada
   * ferramenta nova entra no fim: o começo do prompt (persona + ferramentas + histórico) fica igual entre as perguntas e
   * o servidor o reaproveita em vez de reler tudo. `peek`: só calcula, sem guardar (estimativa do resumo).
   */
  _offeredTools(hints, { peek = false } = {}) {
    const stable = typeof this.ai.prefersStablePrompt === 'function' && this.ai.prefersStablePrompt()
      && typeof this.toolbox.definitionsInOrder === 'function';
    if (!stable) return this.toolbox.definitions(hints);
    const names = [...this._stableTools];
    for (const name of selectToolNames(hints)) if (!names.includes(name)) names.push(name);
    if (!peek) this._stableTools = names;
    return this.toolbox.definitionsInOrder(names);
  }

  /** Cancela a resposta em andamento. */
  cancel(id) {
    if (!this._active || (id !== undefined && id !== null && id !== this._active.id)) return false;
    this._active.controller.abort();
    return true;
  }

  /** Mensagens que ainda vão ao modelo (as resumidas ficam de fora; histórico sem resumo: todas). */
  _live() {
    return typeof this.history.unsummarized === 'function' ? this.history.unsummarized() : this.history.get();
  }

  _summary() {
    try { return typeof this.history.getSummary === 'function' ? this.history.getSummary() : ''; } catch (_) { return ''; }
  }

  /** Mensagens enviadas ao modelo: o histórico não resumido (limitado) + a nova mensagem do usuário. */
  _context(text) {
    let past = this._live().map((m) => ({ role: m.role, content: m.content })).slice(-(MAX_MESSAGES - 1));
    while (past.length && past[0].role !== 'user') past = past.slice(1);
    return [...past, { role: 'user', content: text }];
  }

  /**
   * Resume as mensagens mais antigas se a conversa passou de COMPACT_AT do orçamento do provedor principal. Mantém as
   * recentes (até KEEP_RECENT do orçamento, no mínimo a última troca) e corta sempre antes de uma mensagem do usuário.
   */
  async _compact() {
    if (typeof this.ai.historyBudget !== 'function' || typeof this.ai.summarizeConversation !== 'function') return;
    if (typeof this.history.applySummary !== 'function') return;
    const live = this._live();
    // As ferramentas que a próxima pergunta deve levar: as das últimas mensagens do usuário (como no envio real)
    let toolsTokens = 0;
    try {
      const texts = live.filter((m) => m.role === 'user').slice(-3).map((m) => m.content);
      if (this.toolbox) toolsTokens = estimateTokens(JSON.stringify(this._offeredTools({ texts }, { peek: true })));
    } catch (_) { toolsTokens = 0; }
    const summary = this._summary();
    const budget = this.ai.historyBudget({ withTools: Boolean(this.toolbox), toolsTokens, memory: summary });
    if (!(budget > 0)) return;
    if (conversationTokens(live) <= budget * COMPACT_AT) return;

    let keep = 0;
    let used = 0;
    for (let i = live.length - 1; i >= 0; i--) {
      const t = messageTokens(live[i]);
      if (keep >= 2 && used + t > budget * KEEP_RECENT) break;
      used += t;
      keep++;
    }
    let cut = live.length - keep;
    while (cut < live.length && live[cut].role !== 'user') cut++;
    if (cut <= 0) return;

    const maxChars = Math.max(400, Math.min(2400, Math.floor(budget * 0.25 * CHARS_PER_TOKEN)));
    const old = live.slice(0, cut);
    const mode = typeof this.ai.summaryMode === 'function' ? this.ai.summaryMode() : 'model';
    const controller = new AbortController();
    this._compactController = controller;
    try {
      let text = '';
      if (mode === 'model' && this._compactCooldown <= 0) {
        try {
          text = await this.ai.summarizeConversation({ previous: summary, messages: old, maxChars, signal: controller.signal });
        } catch (_) {
          if (controller.signal.aborted) return;
          this._compactCooldown = COMPACT_COOLDOWN; // as próximas vão direto pelo extrativo (servidor com problema)
        }
      } else if (this._compactCooldown > 0) {
        this._compactCooldown--;
      }
      if (controller.signal.aborted) return;
      if (!text) text = extractiveSummary(summary, old, maxChars);
      if (!text) return;
      this.history.applySummary(text, cut);
      this._noticeSummary = true;
    } finally {
      if (this._compactController === controller) this._compactController = null;
    }
  }

  /** Agenda o resumo depois de uma resposta (a próxima pergunta espera por ele). */
  _scheduleCompact() {
    if (this._compacting) return;
    this._compacting = this._compact().catch(() => {}).finally(() => { this._compacting = null; });
  }

  /**
   * Inicia uma resposta. Devolve o id da conversa; o resto chega pelos eventos.
   * @param {string} rawText
   * @param {object} [rawContext]  contexto da tela (opcional; inválido = erro BAD_CONTEXT, nada é enviado ao modelo)
   * @returns {string}
   */
  start(rawText, rawContext) {
    if (this._active) throw Object.assign(new Error('O assistente já está respondendo. Aguarde ou cancele.'), { code: 'BUSY' });
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) throw new Error('Escreva uma mensagem.');
    if (text.length > MAX_MESSAGE_CHARS) throw new Error(`Mensagem longa demais (máximo ${MAX_MESSAGE_CHARS} caracteres).`);
    const context = validateContext(rawContext);

    const id = `c${Date.now().toString(36)}${(++seq).toString(36)}`;
    const controller = new AbortController();
    this._active = { id, controller };
    this._run(id, controller, text, null, context);
    return id;
  }

  async _run(id, controller, userText, presetMessages = null, context = null) {
    let partial = '';
    let needSep = false;
    const active = this._active;
    const signal = controller.signal;
    const status = (text, kind) => this.emit('ai:chatStatus', { id, text: String(text || ''), kind: kind || 'tool' });
    const save = (assistantText) => {
      if (active && active.discard) return; // conversa apagada durante a resposta: nada volta ao histórico
      try {
        this.history.append({ role: 'user', content: userText }, { role: 'assistant', content: assistantText });
      } catch (_) { return; /* falha ao gravar o histórico não derruba a resposta */ }
      this._scheduleCompact();
    };
    const onDelta = (piece) => {
      if (needSep && partial.trim()) { partial += '\n\n'; this.emit('ai:chatDelta', { id, text: '\n\n' }); }
      needSep = false;
      partial += piece;
      this.emit('ai:chatDelta', { id, text: piece });
    };

    // Texto que o provedor atual já entregou NESTA rodada (para descartar se ele falhar no meio e outro assumir)
    const round = { len: 0, needSep: false };
    const announced = new Set();
    const onReset = () => {
      partial = partial.slice(0, round.len);
      needSep = round.needSep;
      status(partial, 'reset');
    };
    const onProvider = (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'use') {
        status(ev.label, 'provider');
        if (Array.isArray(ev.before) && ev.before.length) {
          const mark = `${ev.id}|${ev.before.map((b) => `${b.id}:${b.reason}`).join(',')}`;
          if (!announced.has(mark)) { announced.add(mark); status(switchLine(ev.label, ev.before), 'fallback'); }
        }
      } else if (ev.type === 'starting') {
        status('Carregando sistema local…', 'tool');
      } else if (ev.type === 'ready') {
        status('', 'clear');
      } else if (ev.type === 'noTools' && ev.key && !this._noTools.has(ev.key)) {
        this._noTools.add(ev.key);
        status(NO_TOOLS_NOTICE, 'notice');
      } else if (ev.type === 'trimmed' && !this._noticedTrim) {
        this._noticedTrim = true;
        status(TRIMMED_NOTICE, 'notice');
      }
    };

    try {
      // Resumo da conversa ainda em andamento (da resposta anterior): espera para a pergunta já ir com a memória nova
      if (this._compacting) {
        status(MEMORY_STATUS, 'tool');
        // parar a resposta não espera o resumo terminar
        await Promise.race([this._compacting, new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))]);
        status('', 'clear');
        if (signal.aborted) throw Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' });
      }
      if (this._noticeSummary) { this._noticeSummary = false; status(SUMMARY_NOTICE, 'notice'); }
      const messages = presetMessages || this._context(userText);
      const memory = this._summary();
      const convo = [...messages];
      const key = typeof this.ai.serverKey === 'function' ? this.ai.serverKey() : 'padrao';
      const hasTools = Boolean(this.toolbox);
      // Comandos simples ("baixa este link", "transcreve o selecionado"): por regras, sem consultar a IA
      if (hasTools && this.localCommands) {
        const local = await runCommand({ text: userText, context, toolbox: this.toolbox, signal, onStatus: status });
        status('', 'clear');
        if (local !== null) {
          this.emit('ai:chatDelta', { id, text: local });
          save(local);
          this.emit('ai:chatDone', { id, text: local, finishReason: 'command', cancelled: false });
          return;
        }
      }
      let useTools = hasTools && !this._noTools.has(key);
      const contextBlock = buildContextBlock(context, this.toolbox ? this.toolbox.deps : {});
      const usedTools = [];
      const recentUserTexts = () => convo.filter((m) => m.role === 'user' && typeof m.content === 'string').slice(-3).map((m) => m.content);
      let rounds = 0;
      let totalCalls = 0;
      let result = null;
      let ranTools = false;

      for (;;) {
        const toolsNow = useTools && rounds < MAX_ITERATIONS;
        try {
          const defs = toolsNow ? this._offeredTools({ texts: recentUserTexts(), screen: context ? context.screen : null, used: usedTools }) : null;
          round.len = partial.length;
          round.needSep = needSep;
          result = await this.ai.chatStream({ messages: convo, signal, timeouts: this.timeouts, onDelta, onReset, onProvider, tools: defs, contextBlock, memory });
        } catch (err) {
          if (err && err.code === 'NO_TOOLS' && toolsNow) {
            // Servidor/modelo sem function calling: continua só como chat de texto e avisa UMA vez
            useTools = false;
            if (!this._noTools.has(key)) { this._noTools.add(key); status(NO_TOOLS_NOTICE, 'notice'); }
            continue;
          }
          throw err;
        }
        const calls = toolsNow ? (result.toolCalls || []) : [];
        if (!calls.length) break;

        rounds++;
        convo.push({
          role: 'assistant',
          content: result.text || null,
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: validJsonOrEmpty(c.arguments) } }))
        });
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i];
          let content;
          if (i >= MAX_CALLS_PER_TURN || totalCalls >= MAX_CALLS_TOTAL) {
            content = this.toolbox.limitReached();
          } else {
            totalCalls++;
            ranTools = true;
            if (!usedTools.includes(call.name)) usedTools.push(call.name);
            content = await this.toolbox.execute(call.name, call.arguments, { signal, onStatus: status });
            status('', 'clear');
          }
          convo.push({ role: 'tool', tool_call_id: call.id, content });
        }
        if (partial.trim()) needSep = true;
        if (signal.aborted) throw Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' });
      }

      let answer = partial.trim();
      if (!answer) {
        if (ranTools) answer = EMPTY_AFTER_TOOLS;
        else throw new Error('O modelo devolveu uma resposta vazia.');
        this.emit('ai:chatDelta', { id, text: answer });
      }
      save(answer);
      this.emit('ai:chatDone', { id, text: answer, finishReason: result.finishReason || null, cancelled: false });
    } catch (err) {
      if (err && err.code === 'CANCELLED') {
        const kept = partial.trim();
        if (kept) save(kept);
        this.emit('ai:chatDone', { id, text: kept, finishReason: null, cancelled: true });
      } else {
        this.emit('ai:chatError', { id, error: (err && err.message) || 'Falha desconhecida.', code: (err && err.code) || null });
      }
    } finally {
      if (this._active && this._active.id === id) this._active = null;
    }
  }
}

/** Argumentos que o modelo mandou, repetidos na mensagem do assistente: só JSON válido (alguns servidores exigem). */
function validJsonOrEmpty(raw) {
  try { JSON.parse(raw); return raw; } catch (_) { return '{}'; }
}

module.exports = AssistantChat;
module.exports.MAX_ITERATIONS = MAX_ITERATIONS;
module.exports.MAX_CALLS_PER_TURN = MAX_CALLS_PER_TURN;
module.exports.MAX_CALLS_TOTAL = MAX_CALLS_TOTAL;
module.exports.NO_TOOLS_NOTICE = NO_TOOLS_NOTICE;
module.exports.SUMMARY_NOTICE = SUMMARY_NOTICE;
module.exports.TRIMMED_NOTICE = TRIMMED_NOTICE;
module.exports.COMPACT_AT = COMPACT_AT;
module.exports.extractiveSummary = extractiveSummary;
