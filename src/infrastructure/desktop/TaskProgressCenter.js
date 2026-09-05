'use strict';

const logger = require('../../services/logService');

/**
 * TaskProgressCenter
 * -------------------
 * Ponto único de agregação de progresso das tarefas de longa duração
 * (Downloads, Conversor, Cópia de arquivos, Remoção de silêncios) para
 * refletir na barra de progresso do ícone da aplicação na barra de
 * tarefas do Windows (ITaskbarList3), no dock do macOS e no Unity
 * Launcher do Linux — via BrowserWindow#setProgressBar do Electron.
 *
 * Não conhece nada sobre yt-dlp/ffmpeg/etc: apenas recebe chamadas de
 * reportProgress/reportIdle/reportError feitas pelo bootstrap.js, que é
 * quem já está inscrito nos eventos de cada serviço.
 *
 * IMPORTANTE: setProgressBar não é suportado em todas as distros Linux
 * (apenas em ambientes com Unity Launcher API, ex: Ubuntu Unity antigo).
 * Em ambientes sem suporte, a chamada é ignorada silenciosamente pelo
 * próprio Electron — não é necessário tratamento especial aqui.
 */
class TaskProgressCenter {
  constructor() {
    this.mainWindow = null;

    /** @type {Record<string, {active: boolean, percent: number}>} */
    this.tasks = {
      downloads: { active: false, percent: 0 },
      converter: { active: false, percent: 0 },
      copy: { active: false, percent: 0 },
      silence: { active: false, percent: 0 }
    };

    this._errorTimeout = null;
  }

  /**
   * @param {import('electron').BrowserWindow} window
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * Reporta progresso (0 a 1) de uma tarefa.
   * @param {'downloads'|'converter'|'copy'|'silence'} taskKey
   * @param {number} percent 0..1
   */
  reportProgress(taskKey, percent) {
    if (!this.tasks[taskKey]) return;

    const clamped = Math.max(0, Math.min(1, Number(percent) || 0));
    this.tasks[taskKey].active = true;
    this.tasks[taskKey].percent = clamped;

    this._render();
  }

  /**
   * Marca uma tarefa como concluída/ociosa (sai do cálculo da barra).
   * @param {'downloads'|'converter'|'copy'|'silence'} taskKey
   */
  reportIdle(taskKey) {
    if (!this.tasks[taskKey]) return;

    this.tasks[taskKey].active = false;
    this.tasks[taskKey].percent = 0;

    this._render();
  }

  /**
   * Mostra brevemente a barra em modo de erro (vermelho no Windows) e
   * depois esconde. Não interrompe outras tarefas que estejam ativas —
   * ao final do timeout, volta a refletir o estado real das tarefas.
   * @param {'downloads'|'converter'|'copy'|'silence'} taskKey
   */
  reportError(taskKey) {
    if (!this.tasks[taskKey]) return;

    this.tasks[taskKey].active = false;
    this.tasks[taskKey].percent = 0;

    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    try {
      clearTimeout(this._errorTimeout);
      this.mainWindow.setProgressBar(1, { mode: 'error' });
      this._errorTimeout = setTimeout(() => this._render(), 2000);
    } catch (err) {
      logger.warn('[TaskProgressCenter] Falha ao exibir estado de erro na taskbar', err);
    }
  }

  /**
   * Recalcula o valor agregado e aplica na janela principal.
   * Estratégia: média simples dos percentuais das tarefas ativas.
   * Se nenhuma tarefa ativa, remove a barra (-1).
   */
  _render() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const activeTasks = Object.values(this.tasks).filter((t) => t.active);

    try {
      if (activeTasks.length === 0) {
        this.mainWindow.setProgressBar(-1);
        return;
      }

      const avg =
        activeTasks.reduce((sum, t) => sum + t.percent, 0) / activeTasks.length;

      // Electron não aceita exatamente 0 como "em progresso" em alguns
      // builds do Windows (barra pode piscar); usamos um mínimo visível.
      const value = Math.max(avg, 0.01);

      this.mainWindow.setProgressBar(value);
    } catch (err) {
      logger.warn('[TaskProgressCenter] Falha ao atualizar barra de progresso', err);
    }
  }
}

// Instância única compartilhada por toda a aplicação (main process).
module.exports = new TaskProgressCenter();
