'use strict';

/**
 * Confirmação no MODAL DO PRÓPRIO APP (mesmo visual dos outros avisos), decidida pelo processo principal.
 * Usada pelas ações do assistente e pelas confirmações que apagam/substituem coisas (remover fonte, limpar banco…).
 *
 * Como continua seguro (o renderer sozinho não consegue se autoconfirmar):
 *   - o main gera um id aleatório de uso único por pedido e só aceita UMA resposta, vinda do MESMO webContents
 *     para o qual o pedido foi enviado;
 *   - o modal só devolve "Confirmar" para um clique/tecla REAL do usuário (event.isTrusted, checado no renderer)
 *     e abre com o foco em "Cancelar";
 *   - fechar, Esc, tempo esgotado, parar o chat ou qualquer falha = recusa;
 *   - se o renderer não confirmar a exibição (ack) a tempo — modal ocupado, tela recarregando, sem janela —
 *     cai no diálogo NATIVO (`fallback`), como era antes.
 */

const crypto = require('node:crypto');

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const ACK_TIMEOUT_MS = 2500;

const pending = new Map(); // id -> { webContents, acked, settle(valor) } (compartilhado: há um só par de canais de resposta)

const isLive = (wc) => Boolean(wc && typeof wc.send === 'function' && !(typeof wc.isDestroyed === 'function' && wc.isDestroyed()));

/**
 * @param {{ fallback:(req:object)=>Promise<boolean>, timeoutMs?:number, ackMs?:number }} deps
 * @returns {(req:{ webContents?:object, title?:string, message:string, detail?:string, confirmLabel?:string,
 *            cancelLabel?:string, signal?:AbortSignal }) => Promise<boolean>}
 */
function createAppConfirm({ fallback, timeoutMs = CONFIRM_TIMEOUT_MS, ackMs = ACK_TIMEOUT_MS }) {
  return async function confirm(req) {
    const { webContents = null, title = '', message = '', detail = '', confirmLabel = '', cancelLabel = '', signal = null } = req || {};
    if (!isLive(webContents) || (signal && signal.aborted)) return fallback(req);

    const id = crypto.randomUUID();
    const send = (channel, payload) => { try { webContents.send(channel, payload); } catch (_) { /* janela fechando */ } };

    const outcome = await new Promise((resolve) => {
      const timers = [];
      let done = false;
      const settle = (value) => {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout);
        if (signal) signal.removeEventListener('abort', onAbort);
        pending.delete(id);
        resolve(value);
      };
      const onAbort = () => { send('ui:confirmCancel', { id }); settle(false); };
      pending.set(id, { webContents, acked: false, settle });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      timers.push(setTimeout(() => { send('ui:confirmCancel', { id }); settle(false); }, timeoutMs));
      timers.push(setTimeout(() => {
        const entry = pending.get(id);
        if (entry && !entry.acked) settle('fallback'); // o modal não abriu: usa o diálogo nativo
      }, ackMs));
      send('ui:confirmRequest', {
        id, title: String(title), message: String(message), detail: String(detail),
        confirmLabel: String(confirmLabel), cancelLabel: String(cancelLabel)
      });
    });

    if (outcome === 'fallback') {
      send('ui:confirmCancel', { id });
      return fallback(req);
    }
    return outcome === true;
  };
}

/** O renderer mostrou o modal do pedido `id`. */
function ackConfirm(sender, id) {
  const entry = pending.get(String(id));
  if (!entry || sender !== entry.webContents) return false;
  entry.acked = true;
  return true;
}

/** Resposta do usuário. Vale uma vez, só do webContents que recebeu o pedido; diferente de `true` é recusa. */
function respondConfirm(sender, id, accepted) {
  const entry = pending.get(String(id));
  if (!entry || sender !== entry.webContents) return false;
  entry.settle(accepted === true);
  return true;
}

/**
 * Confirmação padrão do app: modal no webContents informado e, sem ele, o diálogo nativo do Electron.
 * Devolve true só se o usuário confirmou.
 */
function createDefaultAppConfirm() {
  const nativeFallback = async ({ webContents, title, message, detail, confirmLabel, cancelLabel, signal }) => {
    const { BrowserWindow, dialog } = require('electron');
    const win = (webContents && BrowserWindow.fromWebContents(webContents)) || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const options = {
      type: 'warning',
      buttons: [cancelLabel || 'Cancelar', confirmLabel || 'Confirmar'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: title || 'Braga Digital Studio',
      message,
      detail,
      ...(signal ? { signal } : {})
    };
    const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return r.response === 1;
  };
  return createAppConfirm({ fallback: nativeFallback });
}

let shared = null;
/** Instância única do app (criada na primeira vez, porque depende do Electron). */
function appConfirm(req) {
  if (!shared) shared = createDefaultAppConfirm();
  return shared(req);
}

module.exports = { createAppConfirm, ackConfirm, respondConfirm, appConfirm, CONFIRM_TIMEOUT_MS, ACK_TIMEOUT_MS };
