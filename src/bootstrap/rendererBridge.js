'use strict';

const logger = require('../services/logService');
const KeyedThrottle = require('../infrastructure/desktop/KeyedThrottle');
const taskProgressCenter = require('../infrastructure/desktop/TaskProgressCenter');

/**
 * Ponte main -> renderer. Concentra o envio de eventos (com a guarda de janela destruída) e o
 * throttle dos canais de progresso. Recebe um getter da janela (a janela é trocada por
 * setMainWindow no activate), então sempre usa a janela atual.
 */
class RendererBridge {
  constructor(getMainWindow) {
    this._getMainWindow = getMainWindow;
    this._throttle = new KeyedThrottle(250);
  }

  /**
   * Envia um evento ao renderer somente se a janela existir e não tiver sido destruída
   * (eventos de serviços podem chegar depois do fechamento da janela).
   */
  send(channel, payload) {
    const win = this._getMainWindow();
    try {
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    } catch (err) {
      logger.warn('Bootstrap:send:error', { channel, error: err.message });
    }
  }

  /**
   * [PERF] Envio ao renderer limitado a ~4 Hz por canal (o último valor vence). Usado nos canais
   * de progresso/fila, que podem disparar dezenas de vezes por segundo.
   */
  sendThrottled(channel, payload) {
    this._throttle.push(`ipc:${channel}`, payload, (v) => this.send(channel, v));
  }

  /** Progresso da barra da taskbar limitado a ~4 Hz por tarefa. */
  reportProgressThrottled(task, fraction) {
    this._throttle.push(`tpc:${task}`, fraction, (v) => taskProgressCenter.reportProgress(task, v));
  }

  /**
   * Entrega já os valores pendentes dos canais/tarefas informados. Chamado antes de um evento de
   * mudança de estado (finalizado/erro/cancelado) para preservar a ordem: o último progresso
   * chega antes do evento final, e este nunca é atrasado.
   */
  flushThrottled(...keys) {
    for (const k of keys) this._throttle.flush(k);
  }

  /** Descarta progresso pendente de uma tarefa cujo estado final torna o valor obsoleto. */
  cancelThrottled(...keys) {
    for (const k of keys) this._throttle.cancel(k);
  }
}

module.exports = RendererBridge;
