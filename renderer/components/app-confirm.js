/**
 * Confirmações pedidas pelo processo principal (assistente de IA, remover fonte, limpar banco…), no MODAL do app.
 *
 * O main decide o que vale: aqui só se mostra o texto EXATO que ele montou, se avisa que o modal abriu (ack) e se
 * devolve o gesto do usuário. O modal só aceita "Confirmar" por clique/tecla real (isTrusted) e abre com o foco em
 * "Cancelar". Sem modal disponível ou já ocupado, não há ack e o main usa o diálogo nativo.
 */

const bds = () => window.bds || {};

let currentId = null; // pedido que está na tela
let unsubscribers = [];

export async function onConfirmRequest(payload) {
  const id = payload && typeof payload.id === 'string' ? payload.id : '';
  const modal = window.bdsModal;
  if (!id || !modal || typeof modal.show !== 'function' || (typeof modal.isOpen === 'function' && modal.isOpen())) return false;
  const text = [payload.message, payload.detail].filter((s) => typeof s === 'string' && s).join('\n\n');
  currentId = id;
  const decision = modal.show({
    title: typeof payload.title === 'string' && payload.title ? payload.title : 'Confirmação',
    message: text,
    isConfirm: true,
    trusted: true,
    focusCancel: true,
    confirmLabel: typeof payload.confirmLabel === 'string' ? payload.confirmLabel : '',
    cancelLabel: typeof payload.cancelLabel === 'string' ? payload.cancelLabel : ''
  });
  try { await bds().uiConfirmAck?.(id); } catch (_) { /* sem ack o main usa o diálogo nativo */ }
  const accepted = (await decision) === true;
  if (currentId === id) currentId = null;
  try { await bds().uiConfirmRespond?.(id, accepted); } catch (_) { /* o main trata como recusa por tempo */ }
  return accepted;
}

/** O pedido acabou no main (chat parado, tempo esgotado): fecha o modal dele. */
export function onConfirmCancel(payload) {
  if (!payload || payload.id !== currentId) return;
  currentId = null;
  window.bdsModal?.dismiss?.();
}

/** Liga os eventos do main (idempotente). */
export function mountAppConfirm() {
  unmountAppConfirm();
  const api = bds();
  if (typeof api.onUiConfirmRequest === 'function') unsubscribers.push(api.onUiConfirmRequest(onConfirmRequest));
  if (typeof api.onUiConfirmCancel === 'function') unsubscribers.push(api.onUiConfirmCancel(onConfirmCancel));
}

export function unmountAppConfirm() {
  unsubscribers.forEach((off) => { try { if (typeof off === 'function') off(); } catch (_) { /* já solto */ } });
  unsubscribers = [];
}
