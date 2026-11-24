'use strict';

/**
 * ChatHistory — histórico da conversa do assistente, guardado LOCALMENTE (ai-chat-history.json no diretório de
 * configuração do app). Só guarda { role, content } (mais a marca `summarized`) e o resumo da conversa: nunca a chave
 * de API, o endereço do servidor nem qualquer outro dado de configuração. Escrita atômica (.tmp + rename).
 * "Limpar" apaga o arquivo.
 *
 * MEMÓRIA (versão 2 do arquivo): em conversas longas o AssistantChat resume as mensagens mais antigas. O resumo fica
 * em `summary` e essas mensagens ganham `summarized: true`: continuam na tela, mas não vão mais ao modelo (o resumo
 * vai no lugar delas). O arquivo da versão 1 (sem resumo) é lido normalmente.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_MESSAGES = 80;          // guardadas e mostradas; ao modelo vão só as não resumidas (no máximo 40, ver AIService)
const MAX_MESSAGE_CHARS = 20000;  // o mesmo limite de AIService
const MAX_SUMMARY_CHARS = 4000;

class ChatHistory {
  /** @param {{ dir:string, maxMessages?:number }} opts */
  constructor({ dir, maxMessages = MAX_MESSAGES }) {
    if (!dir) throw new Error('ChatHistory: dir é obrigatório.');
    this.filePath = path.join(dir, 'ai-chat-history.json');
    this.maxMessages = maxMessages;
    this._messages = null;
    this._summary = '';
  }

  /** Mantém só mensagens válidas, no limite, começando por uma mensagem do usuário. */
  _normalize(list) {
    const out = [];
    for (const m of Array.isArray(list) ? list : []) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
      const content = m.content.slice(0, MAX_MESSAGE_CHARS);
      if (!content.trim()) continue;
      out.push(m.summarized === true ? { role: m.role, content, summarized: true } : { role: m.role, content });
    }
    let trimmed = out.slice(-this.maxMessages);
    while (trimmed.length && trimmed[0].role !== 'user') trimmed = trimmed.slice(1);
    return trimmed;
  }

  _load() {
    if (this._messages) return this._messages;
    let stored = null;
    try { stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (_) { /* sem histórico ou arquivo ilegível */ }
    this._messages = this._normalize(stored && stored.messages);
    this._summary = stored && typeof stored.summary === 'string' ? stored.summary.slice(0, MAX_SUMMARY_CHARS) : '';
    return this._messages;
  }

  /** Cópia das mensagens guardadas (as resumidas vêm com `summarized: true`). */
  get() { return this._load().map((m) => ({ ...m })); }

  /** Mensagens que ainda vão ao modelo (as que não entraram no resumo). */
  unsummarized() {
    let list = this._load().filter((m) => !m.summarized).map((m) => ({ role: m.role, content: m.content }));
    while (list.length && list[0].role !== 'user') list = list.slice(1);
    return list;
  }

  /** Resumo das mensagens antigas ('' se ainda não houve resumo). */
  getSummary() { this._load(); return this._summary; }

  _persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const data = { version: 2, messages: this._messages };
    if (this._summary) data.summary = this._summary;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  /** Substitui o histórico (aplica o limite) e grava. O resumo é mantido. */
  set(messages) {
    this._load();
    this._messages = this._normalize(messages);
    this._persist();
    return this.get();
  }

  /** Acrescenta mensagens ao fim e grava. */
  append(...messages) {
    return this.set([...this._load(), ...messages]);
  }

  /**
   * Grava o novo resumo e marca as `count` primeiras mensagens ainda não resumidas como resumidas.
   * @param {string} summary
   * @param {number} count
   */
  applySummary(summary, count) {
    const list = this._load();
    let left = Math.max(0, Math.floor(Number(count) || 0));
    for (const m of list) {
      if (left <= 0) break;
      if (m.summarized) continue;
      m.summarized = true;
      left--;
    }
    this._summary = String(summary || '').slice(0, MAX_SUMMARY_CHARS);
    this._persist();
  }

  /** Apaga o histórico, o resumo e o arquivo. */
  clear() {
    this._messages = [];
    this._summary = '';
    try { fs.rmSync(this.filePath, { force: true }); } catch (_) { /* já não existe */ }
    try { fs.rmSync(`${this.filePath}.tmp`, { force: true }); } catch (_) { /* idem */ }
  }
}

module.exports = ChatHistory;
module.exports.MAX_MESSAGES = MAX_MESSAGES;
module.exports.MAX_MESSAGE_CHARS = MAX_MESSAGE_CHARS;
module.exports.MAX_SUMMARY_CHARS = MAX_SUMMARY_CHARS;
