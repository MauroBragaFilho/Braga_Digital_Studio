'use strict';

/**
 * Limita a frequência de entrega por chave (ex.: canal IPC): no máximo uma entrega a cada
 * `intervalMs` (padrão 250 ms = 4 Hz) por chave; entre entregas, o ÚLTIMO valor vence.
 *
 * - A primeira chamada de uma chave é entregue na hora (borda de subida, sem atraso).
 * - Valores intermediários são descartados; o mais recente é entregue ao fim do intervalo.
 * - flush(key): entrega já o valor pendente (use antes de um evento de mudança de estado, para
 *   preservar a ordem: o último progresso chega antes do "finalizado").
 * - cancel(key): descarta o valor pendente (use quando um estado final torna o progresso obsoleto).
 */
class KeyedThrottle {
  /**
   * @param {number} [intervalMs=250]
   * @param {() => number} [now] relógio injetável (testes)
   */
  constructor(intervalMs = 250, now = Date.now) {
    this.intervalMs = intervalMs;
    this._now = now;
    this._entries = new Map(); // key -> { last: number, timer, pending: {sink, value}|null }
  }

  /**
   * @param {string} key
   * @param {any} value
   * @param {(value:any) => void} sink função que entrega o valor (ex.: win.webContents.send)
   */
  push(key, value, sink) {
    let e = this._entries.get(key);
    if (!e) { e = { last: -Infinity, timer: null, pending: null }; this._entries.set(key, e); }

    const elapsed = this._now() - e.last;
    if (!e.timer && elapsed >= this.intervalMs) {
      e.last = this._now();
      this._safe(sink, value);
      return;
    }

    e.pending = { sink, value };
    if (!e.timer) {
      const wait = Math.max(0, this.intervalMs - elapsed);
      e.timer = setTimeout(() => this._fire(key), wait);
      if (typeof e.timer.unref === 'function') e.timer.unref();
    }
  }

  _fire(key) {
    const e = this._entries.get(key);
    if (!e) return;
    e.timer = null;
    const p = e.pending;
    e.pending = null;
    if (p) {
      e.last = this._now();
      this._safe(p.sink, p.value);
    }
  }

  _safe(sink, value) {
    try { sink(value); } catch (_) { /* a entrega nunca deve derrubar o emissor */ }
  }

  /** Entrega agora o valor pendente da chave (se houver). */
  flush(key) {
    const e = this._entries.get(key);
    if (!e || !e.pending) return;
    clearTimeout(e.timer);
    this._fire(key);
  }

  /** Descarta o valor pendente da chave. */
  cancel(key) {
    const e = this._entries.get(key);
    if (!e) return;
    clearTimeout(e.timer);
    e.timer = null;
    e.pending = null;
  }
}

module.exports = KeyedThrottle;
