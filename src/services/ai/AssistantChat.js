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
 * ferramentas, o app as executa (ToolBox, com confirmação nativa nas ações), devolve cada resultado como mensagem de
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
 */

const { MAX_MESSAGES, MAX_MESSAGE_CHARS, switchLine } = require('./AIService');
const { validateContext, buildContextBlock } = require('./context');

let seq = 0;

const MAX_ITERATIONS = 6;        // rodadas de ferramentas por pergunta
const MAX_CALLS_PER_TURN = 4;    // chamadas atendidas por resposta do modelo
const MAX_CALLS_TOTAL = 10;      // chamadas atendidas por pergunta
const NO_TOOLS_NOTICE = 'Este modelo não permite consultar nem alterar o app. Vou responder só em conversa.';
const EMPTY_AFTER_TOOLS = 'Não consegui concluir o pedido com as ferramentas do app. Tente reformular ou pedir de outro jeito.';

class AssistantChat {
  /**
   * @param {{ ai: import('./AIService'), history: import('./ChatHistory'), emit: (channel:string, payload:object)=>void,
   *           timeouts?: object, toolbox?: import('./tools').ToolBox }} deps  `timeouts` (teste): { firstChunkTimeoutMs, idleTimeoutMs }
   */
  constructor({ ai, history, emit, timeouts = {}, toolbox = null }) {
    this.toolbox = toolbox;
    this._noTools = new Set();   // servidor+modelo que recusaram ferramentas (avisado uma vez)
    this.ai = ai;
    this.history = history;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.timeouts = timeouts;
    this._active = null;
  }

  isBusy() { return this._active !== null; }

  /** Esquece que o servidor/modelo recusou ferramentas (a configuração mudou: vale tentar de novo). */
  forgetToolSupport() {
    this._noTools.clear();
    if (this.ai && typeof this.ai.forgetToolSupport === 'function') this.ai.forgetToolSupport();
  }

  getHistory() { return this.history.get(); }

  /** Cancela a resposta em andamento (se houver) e apaga o histórico. */
  clear() {
    if (this._active) { this._active.discard = true; this._active.controller.abort(); }
    this.history.clear();
    return true;
  }

  /** Cancela a resposta em andamento. */
  cancel(id) {
    if (!this._active || (id !== undefined && id !== null && id !== this._active.id)) return false;
    this._active.controller.abort();
    return true;
  }

  /** Mensagens enviadas ao modelo: o histórico (limitado) + a nova mensagem do usuário. */
  _context(text) {
    let past = this.history.get().slice(-(MAX_MESSAGES - 1));
    while (past.length && past[0].role !== 'user') past = past.slice(1);
    return [...past, { role: 'user', content: text }];
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
    const messages = this._context(text);

    const id = `c${Date.now().toString(36)}${(++seq).toString(36)}`;
    const controller = new AbortController();
    this._active = { id, controller };
    this._run(id, controller, text, messages, context);
    return id;
  }

  async _run(id, controller, userText, messages, context = null) {
    let partial = '';
    let needSep = false;
    const active = this._active;
    const signal = controller.signal;
    const status = (text, kind) => this.emit('ai:chatStatus', { id, text: String(text || ''), kind: kind || 'tool' });
    const save = (assistantText) => {
      if (active && active.discard) return; // conversa apagada durante a resposta: nada volta ao histórico
      try {
        this.history.append({ role: 'user', content: userText }, { role: 'assistant', content: assistantText });
      } catch (_) { /* falha ao gravar o histórico não derruba a resposta */ }
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
      } else if (ev.type === 'noTools' && ev.key && !this._noTools.has(ev.key)) {
        this._noTools.add(ev.key);
        status(NO_TOOLS_NOTICE, 'notice');
      }
    };

    try {
      const convo = [...messages];
      const key = typeof this.ai.serverKey === 'function' ? this.ai.serverKey() : 'padrao';
      const hasTools = Boolean(this.toolbox);
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
          const defs = toolsNow ? this.toolbox.definitions({ texts: recentUserTexts(), screen: context ? context.screen : null, used: usedTools }) : null;
          round.len = partial.length;
          round.needSep = needSep;
          result = await this.ai.chatStream({ messages: convo, signal, timeouts: this.timeouts, onDelta, onReset, onProvider, tools: defs, contextBlock });
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
