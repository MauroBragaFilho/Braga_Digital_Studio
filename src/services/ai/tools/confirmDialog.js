'use strict';

/**
 * Diálogo NATIVO de confirmação das ações do assistente (processo principal, preso à janela principal).
 * Quem confirma é o usuário, clicando no botão do próprio sistema: nem o modelo nem o renderer conseguem acionar.
 * Só o botão "Confirmar" devolve true; "Cancelar", fechar, Esc, tempo esgotado, cancelamento do chat, janela
 * inexistente ou qualquer falha devolvem false (a ação NÃO é executada).
 */

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @param {{ dialog:{showMessageBox:Function}, getMainWindow:()=>object|null, timeoutMs?:number }} deps
 * @returns {(req:{title:string,message:string,detail:string,signal?:AbortSignal}) => Promise<boolean>}
 */
function createNativeConfirm({ dialog, getMainWindow, timeoutMs = CONFIRM_TIMEOUT_MS }) {
  return async function confirm({ title, message, detail, signal = null }) {
    if (!dialog || typeof dialog.showMessageBox !== 'function') return false;
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
    if (signal && signal.aborted) return false;
    try {
      if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
      if (typeof win.focus === 'function') win.focus();
    } catch (_) { /* só conforto */ }
    const timer = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timer]) : timer;
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Cancelar', 'Confirmar'],
      defaultId: 0,   // Enter e Esc ficam em "Cancelar": confirmar exige clicar de propósito
      cancelId: 0,
      noLink: true,
      title: title || 'Confirmar ação do assistente',
      message,
      detail,
      signal: combined
    });
    return !combined.aborted && result && result.response === 1;
  };
}

module.exports = { createNativeConfirm, CONFIRM_TIMEOUT_MS };
