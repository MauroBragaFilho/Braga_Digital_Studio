'use strict';

const logger = require('../../services/logService');
const projectService = require('../../core/projects/ProjectService');
const notificationCenter = require('./NotificationCenter');

/**
 * DeadlineNotifier
 * -----------------
 * Serviço em segundo plano (main process) que verifica periodicamente os prazos
 * dos projetos cadastrados e dispara lembretes de notificação quando o prazo de
 * um projeto se aproxima (lead time configurável), quando vence hoje ou quando
 * já está atrasado.
 *
 * A entrega é feita via NotificationCenter.notifyProjectDeadline(), que roteia o
 * aviso para todos os canais registrados (nativo do sistema e, futuramente,
 * Telegram). Para evitar notificações duplicadas, cada projeto só é notificado
 * uma vez por "janela" (dias restantes) por dia.
 */
class DeadlineNotifier {
  constructor() {
    this.timer = null;
    this.checkEveryMs = 60 * 60 * 1000; // 1 hora
    this._lastRemindedByProject = new Map(); // projectId -> { window, dayKey }
  }

  /**
   * Retorna o identificador do dia atual (YYYY-MM-DD no fuso local),
   * usado para evitar repostar o mesmo lembrete dentro do mesmo dia.
   * @private
   */
  _dayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * Número de dias até o prazo, normalizado para meia-noite (mesma lógica do
   * getDeadlinePill no renderer/projects.js). Negativo = atrasado, 0 = hoje.
   * @param {string} deadlineISO
   * @returns {number|null} dias inteiros ou null se data inválida
   * @private
   */
  _daysLeft(deadlineISO) {
    const deadline = new Date(deadlineISO);
    if (Number.isNaN(deadline.getTime())) return null;

    const now = new Date();
    deadline.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);

    return Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));
  }

  /**
   * Calcula a "janela" de notificação a partir do lead time configurado.
   * Notificamos quando os dias restantes forem iguais ao lead time (prazo
   * próximo), 1 (amanhã), 0 (hoje) ou negativos (atrasado). 0 e negativos são
   * sempre disparados; dígitos positivos apenas quando ≤ leadDays.
   * @param {number} daysLeft
   * @private
   */
  _shouldNotify(daysLeft, leadDays) {
    if (daysLeft < 0) return true; // atrasado
    if (daysLeft === 0) return true; // hoje
    if (daysLeft === 1) return true; // amanhã
    return daysLeft <= leadDays; // prazo próximo (dentro do lead time)
  }

  /**
   * Verifica todos os projetos com deadline e dispara lembretes conforme as
   * preferências do usuário. Executado a cada ciclo do timer.
   * @param {Object} [settings] - configurações carregadas (opcional; usa os
   *   defaults do NotificationCenter se omitido)
   * @public
   */
  checkDeadlines(settings) {
    try {
      // Reaplica settings caso fornecidos (mantém config em sincronia)
      if (settings) notificationCenter.updateSettings(settings);

      const { leadDays, reminderTime } = notificationCenter.settings.deadline;
      const dayKey = this._dayKey();

      // Só dispara lembretes a partir do horário configurado (evita avisos de madrugada)
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const [hr, min] = String(reminderTime || '09:00').split(':').map(Number);
      const reminderMinutes = (Number.isFinite(hr) ? hr : 9) * 60 + (Number.isFinite(min) ? min : 0);
      if (nowMinutes < reminderMinutes) return;

      const projects = projectService.getAllProjects();
      const withDeadline = projects.filter((p) => p.deadline);

      for (const project of withDeadline) {
        const daysLeft = this._daysLeft(project.deadline);
        if (daysLeft === null) continue;

        if (!this._shouldNotify(daysLeft, leadDays)) continue;

        // Janela de deduplicação: um projeto só é lembrado uma vez por
        // combinação de janela + dia.
        const window = daysLeft < 0 ? 'late' : String(daysLeft);
        const last = this._lastRemindedByProject.get(project.id);
        if (last && last.window === window && last.dayKey === dayKey) continue;

        notificationCenter.notifyProjectDeadline(project, daysLeft);

        this._lastRemindedByProject.set(project.id, { window, dayKey });
      }

      // Limpa rastros de projetos que não têm mais deadline (evita crescimento)
      const activeIds = new Set(withDeadline.map((p) => p.id));
      for (const id of Array.from(this._lastRemindedByProject.keys())) {
        if (!activeIds.has(id)) this._lastRemindedByProject.delete(id);
      }
    } catch (err) {
      logger.error('[DeadlineNotifier] Falha ao verificar prazos', { error: err.message });
    }
  }

  /**
   * Inicia a verificação periódica. Executa uma checagem imediata e agenda
   * novas checagens a cada `checkEveryMs`.
   * @param {Object} [settings]
   * @public
   */
  start(settings) {
    if (this.timer) return; // já iniciado

    // Checagem imediata ao iniciar (após serviços estarem prontos)
    setTimeout(() => this.checkDeadlines(settings), 1500);
    // Ciclos seguintes usam o estado dinâmico do NotificationCenter (atualizado
    // a cada save de configurações), evitando reaplicar settings antigas capturadas
    // no momento do start.
    this.timer = setInterval(() => this.checkDeadlines(), this.checkEveryMs);
    logger.info('[DeadlineNotifier] Verificação de prazos iniciada.');
  }

  /**
   * Para a verificação periódica (limpeza na saída do app).
   * @public
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// Instância única compartilhada por toda a aplicação (main process).
module.exports = new DeadlineNotifier();
