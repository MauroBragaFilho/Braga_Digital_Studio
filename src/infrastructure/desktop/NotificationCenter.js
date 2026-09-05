'use strict';

const { Notification } = require('electron');
const logger = require('../../services/logService');

/**
 * NotificationCenter
 * -------------------
 * Ponto único de disparo de notificações nativas do sistema operacional
 * ao concluir as tarefas de: Downloads, Conversor, Cópia de arquivos e
 * Remoção de silêncios.
 *
 * Todo texto exibido ao usuário é em pt-BR. Nomes de ferramentas internas
 * (ffmpeg, yt-dlp, etc.) nunca aparecem nas mensagens.
 */
class NotificationCenter {
  constructor() {
    this.mainWindow = null;

    /**
     * Configurações vindas do SettingsManager (ver Fase 4 do plano).
     * Populado via updateSettings() a cada load/alteração de settings.
     */
    this.settings = {
      notificationsEnabled: true,
      notifyPerModule: {
        downloads: true,
        converter: true,
        copy: true,
        silence: true,
        projects: true
      },

      /**
       * Configuração de lembretes de prazo de projetos.
       * - leadDays: quantos dias antes do prazo disparar o aviso de "prazo próximo"
       * - reminderTime: horário local (HH:mm) de avaliação dos lembretes
       */
      deadline: {
        leadDays: 5,
        reminderTime: '09:00'
      }
    };

    /**
     * Canais de entrega de notificações. Por padrão usamos apenas o canal nativo
     * do sistema operacional. Futuramente podemos registrar um canal Telegram
     * (ex: TelegramDeliveryChannel) sem alterar o fluxo de disparo, apenas
     * adicionando-o a esta lista.
     * @type {Array<{name: string, deliver: (note: Object) => Promise<void>|void}>}
     */
    this.deliveryChannels = [];

    /**
     * Callback opcional para focar uma tela específica do app quando o
     * usuário clicar na notificação. Definido pelo bootstrap.js.
     * @type {(screenName: string) => void | null}
     */
    this.onNavigateRequest = null;
  }

  /**
   * @param {import('electron').BrowserWindow} window
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * Atualiza as preferências de notificação (chamado sempre que as
   * configurações forem carregadas/salvas).
   * @param {Object} settings - objeto retornado por SettingsManager.load()
   */
  updateSettings(settings) {
    if (!settings) return;

    this.settings.notificationsEnabled = settings.notificationsEnabled !== false;

    this.settings.notifyPerModule = {
      downloads: settings.notifyDownloads !== false,
      converter: settings.notifyConverter !== false,
      copy: settings.notifyCopy !== false,
      silence: settings.notifySilence !== false,
      projects: settings.notifyDeadlines !== false
    };

    // Configuração de lembretes de prazo
    this.settings.deadline = {
      leadDays: Number.isFinite(Number(settings.deadlineNotifyLeadDays))
        ? Math.max(0, Number(settings.deadlineNotifyLeadDays))
        : 5,
      reminderTime: /^\d{2}:\d{2}$/.test(settings.deadlineNotifyTime || '')
        ? settings.deadlineNotifyTime
        : '09:00'
    };
  }

  /**
   * Registra um canal de entrega adicional de notificações (ex: Telegram no futuro).
   * O canal recebe um objeto `note` com `{ title, body, screen }` e pode fazer o
   * envio assíncrono. Se o canal falhar, apenas logamos — nunca bloqueia o fluxo.
   * @param {{name: string, deliver: (note: Object) => Promise<void>|void}} channel
   */
  registerDeliveryChannel(channel) {
    if (!channel || typeof channel.deliver !== 'function') return;
    this.deliveryChannels.push(channel);
  }

  /**
   * @param {(screenName: string) => void} callback
   */
  setNavigateHandler(callback) {
    this.onNavigateRequest = callback;
  }

  /**
   * @param {'downloads'|'converter'|'copy'|'silence'} taskKey
   * @param {Object} [payload] - dados extras da tarefa (título, quantidade, etc.)
   */
  notifyTaskCompleted(taskKey, payload = {}) {
    if (!this.settings.notificationsEnabled) return;
    if (!this.settings.notifyPerModule[taskKey]) return;
    if (!Notification.isSupported()) {
      logger.info('[NotificationCenter] Notificações nativas não suportadas neste sistema.');
      return;
    }

    const { title, body, screen } = this._buildMessage(taskKey, payload);

    try {
      const notification = new Notification({
        title,
        body,
        silent: false
      });

      notification.on('click', () => {
        this._focusMainWindow();
        if (screen && typeof this.onNavigateRequest === 'function') {
          this.onNavigateRequest(screen);
        }
      });

      notification.show();
    } catch (err) {
      // Nunca engolir o erro silenciosamente — apenas logar, já que uma
      // notificação que falha não deve travar o fluxo do usuário.
      logger.warn('[NotificationCenter] Falha ao exibir notificação nativa', err);
    }
  }

  /**
   * Dispatcha uma notificação através de todos os canais de entrega registrados,
   * incluindo o canal nativo do sistema. Usado sobretudo pelos lembretes de prazo,
   * garantindo que o mesmo aviso chegue ao sistema e (futuramente) ao Telegram.
   * @param {Object} note - `{ title, body, screen }` já montado
   * @private
   */
  _dispatch(note) {
    if (!note) return;

    // Canal nativo do sistema operacional
    if (Notification.isSupported()) {
      try {
        const notification = new Notification({ title: note.title, body: note.body, silent: false });
        notification.on('click', () => {
          this._focusMainWindow();
          if (note.screen && typeof this.onNavigateRequest === 'function') {
            this.onNavigateRequest(note.screen);
          }
        });
        notification.show();
      } catch (err) {
        logger.warn('[NotificationCenter] Falha ao exibir notificação nativa', err);
      }
    }

    // Canais adicionais (ex: Telegram no futuro)
    for (const channel of this.deliveryChannels) {
      Promise.resolve()
        .then(() => channel.deliver({ ...note, createdAt: new Date().toISOString() }))
        .catch((err) => {
          logger.warn(`[NotificationCenter] Falha no canal "${channel.name}"`, err);
        });
    }
  }

  /**
   * Dispara um lembrete de prazo de projeto. O `daysLeft` é calculado pelo
   * DeadlineNotifier e representa a janela (ex: 0 = hoje, 1 = amanhã,
   * 5 = faltam 5 dias). Este método é o ponto único de montagem do texto e da
   * entrega, respeitando as preferências do usuário.
   * @param {Object} project - projeto com `id`, `name` e `deadline` (ISO)
   * @param {number} daysLeft - dias até o prazo (negativo = atrasado, 0 = hoje)
   */
  notifyProjectDeadline(project, daysLeft) {
    if (!project || !project.id) return;
    if (!this.settings.notificationsEnabled) return;
    if (!this.settings.notifyPerModule.projects) return;

    const note = this._buildProjectDeadlineMessage(project, daysLeft);
    if (!note) return;

    this._dispatch(note);
  }

  /**
   * Monta a mensagem de lembrete de prazo de um projeto.
   * @private
   */
  _buildProjectDeadlineMessage(project, daysLeft) {
    const name = project.name || 'Projeto';

    if (daysLeft < 0) {
      return {
        title: 'Prazo atrasado',
        body: `O projeto "${name}" está ${Math.abs(daysLeft)} dia(s) atrasado(s).`,
        screen: 'projects'
      };
    }

    if (daysLeft === 0) {
      return {
        title: 'Prazo vence hoje!',
        body: `O projeto "${name}" tem prazo final hoje.`,
        screen: 'projects'
      };
    }

    if (daysLeft === 1) {
      return {
        title: 'Prazo amanhã',
        body: `O projeto "${name}" vence amanhã.`,
        screen: 'projects'
      };
    }

    return {
      title: 'Prazo próximo',
      body: `O projeto "${name}" vence em ${daysLeft} dia(s).`,
      screen: 'projects'
    };
  }

  /**
   * Monta título/corpo/tela-alvo por tipo de tarefa.
   * @private
   */
  _buildMessage(taskKey, payload) {
    switch (taskKey) {
      case 'downloads':
        return {
          title: 'Download concluído',
          body: payload.title
            ? `"${payload.title}" foi baixado com sucesso.`
            : 'Seu download foi concluído com sucesso.',
          screen: 'downloads'
        };

      case 'converter':
        return {
          title: 'Conversão concluída',
          body:
            payload.count != null
              ? `${payload.count} arquivo(s) convertido(s) com sucesso.`
              : 'A conversão dos arquivos foi concluída.',
          screen: 'converter'
        };

      case 'copy':
        return {
          title: 'Cópia de arquivos concluída',
          body:
            payload.count != null
              ? `${payload.count} arquivo(s) copiado(s) com sucesso.`
              : 'A cópia dos arquivos foi concluída.',
          screen: 'copy'
        };

      case 'silence':
        return {
          title: 'Remoção de silêncios concluída',
          body: payload.file
            ? `Processamento de "${payload.file}" finalizado.`
            : 'A remoção de silêncios foi concluída.',
          screen: 'silence'
        };

      default:
        return {
          title: 'Tarefa concluída',
          body: 'Uma tarefa foi concluída.',
          screen: null
        };
    }
  }

  /** @private */
  _focusMainWindow() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    if (this.mainWindow.isMinimized()) this.mainWindow.restore();
    this.mainWindow.show();
    this.mainWindow.focus();
  }
}

// Instância única compartilhada por toda a aplicação (main process).
module.exports = new NotificationCenter();
