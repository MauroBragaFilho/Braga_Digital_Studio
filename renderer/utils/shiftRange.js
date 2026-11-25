// Shift+clique em listas de caixas de seleção: marca o intervalo entre o último item clicado e o atual.
// Uso: chame noteClick(e) em todo clique da lista (capture ou na linha), e, no "change" da caixa,
// resolve(ordem, id) devolve os ids do intervalo (ou null, quando vale um clique comum).
import { rangeBetween } from './virtualWindow.js';

export function createShiftRange() {
  let anchor = null;
  let shift = false;
  return {
    /** Guarda se o Shift estava apertado. Nunca volta a false aqui: o clique sintético do <label> vem sem modificadores. */
    noteClick(e) { if (e && e.shiftKey) shift = true; },
    /**
     * Chamar quando a caixa de `id` mudou. `order` = ids na ordem da tela (só os que a pessoa vê).
     * Com Shift e uma âncora na lista devolve os ids do intervalo (a âncora não muda); senão null e `id` vira a âncora.
     */
    resolve(order, id) {
      const wanted = shift && anchor !== null;
      shift = false;
      const range = wanted ? rangeBetween(order, anchor, id) : null;
      if (!range) { anchor = id; return null; }
      return order.slice(range[0], range[1] + 1);
    },
    /** Clique que não passa por caixa (cartão, linha): vira a âncora do próximo Shift+clique. */
    setAnchor(id) { anchor = id; shift = false; },
    /** Intervalo direto para cliques em cartão/linha (sem caixa): null se não há âncora na lista. */
    rangeTo(order, id) {
      const range = anchor === null ? null : rangeBetween(order, anchor, id);
      shift = false;
      return range ? order.slice(range[0], range[1] + 1) : null;
    },
    reset() { anchor = null; shift = false; }
  };
}

/** Shift+clique não deve pintar o texto da lista de azul: tira a seleção de texto que o navegador começaria. */
export function noTextSelectOnShift(container) {
  container?.addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); });
}
