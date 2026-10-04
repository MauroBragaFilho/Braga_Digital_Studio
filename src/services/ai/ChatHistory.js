'use strict';

/**
 * ChatHistory — histórico da conversa do assistente, guardado LOCALMENTE (ai-chat-history.json no diretório de
 * configuração do app). Só guarda { role, content }: nunca a chave de API, o endereço do servidor nem qualquer
 * outro dado de configuração. Escrita atômica (.tmp + rename). O limite de mensagens é o mesmo enviado ao modelo.
 * "Limpar" apaga o arquivo.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_MESSAGES = 40;          // o mesmo limite de AIService (nunca se envia mais que isso ao modelo)
const MAX_MESSAGE_CHARS = 20000;  // idem

class ChatHistory {
  /** @param {{ dir:string, maxMessages?:number }} opts */
  constructor({ dir, maxMessages = MAX_MESSAGES }) {
    if (!dir) throw new Error('ChatHistory: dir é obrigatório.');
    this.filePath = path.join(dir, 'ai-chat-history.json');
    this.maxMessages = maxMessages;
    this._messages = null;
  }

  /** Mantém só mensagens válidas, no limite, começando por uma mensagem do usuário. */
  _normalize(list) {
    const out = [];
    for (const m of Array.isArray(list) ? list : []) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
      const content = m.content.slice(0, MAX_MESSAGE_CHARS);
      if (!content.trim()) continue;
      out.push({ role: m.role, content });
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
    return this._messages;
  }

  /** Cópia das mensagens guardadas. */
  get() { return this._load().map((m) => ({ ...m })); }

  _persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, messages: this._messages }, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  /** Substitui o histórico (aplica o limite) e grava. */
  set(messages) {
    this._messages = this._normalize(messages);
    this._persist();
    return this.get();
  }

  /** Acrescenta mensagens ao fim e grava. */
  append(...messages) {
    return this.set([...this._load(), ...messages]);
  }

  /** Apaga o histórico e o arquivo. */
  clear() {
    this._messages = [];
    try { fs.rmSync(this.filePath, { force: true }); } catch (_) { /* já não existe */ }
    try { fs.rmSync(`${this.filePath}.tmp`, { force: true }); } catch (_) { /* idem */ }
  }
}

module.exports = ChatHistory;
module.exports.MAX_MESSAGES = MAX_MESSAGES;
module.exports.MAX_MESSAGE_CHARS = MAX_MESSAGE_CHARS;
