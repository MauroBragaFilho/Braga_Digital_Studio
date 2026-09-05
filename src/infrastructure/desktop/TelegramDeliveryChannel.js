'use strict';

const logger = require('../../services/logService');

/**
 * TelegramDeliveryChannel
 * ------------------------
 * Canal de entrega de notificações via bot do Telegram (API Bot).
 *
 * Para ativar é preciso que o usuário crie um bot através do @BotFather no
 * Telegram, obtenha o token HTTP e informe o chat_id do destinatário. Enquanto
 * os campos `telegramBotToken`/`telegramChatId` estiverem vazios ou o flag
 * `telegramNotificationsEnabled` for falso, o canal permanece inativo e o app
 * continua usando apenas as notificações nativas do sistema.
 *
 * Este canal é registrado no NotificationCenter como um "delivery channel"
 * adicional — ou seja, quando ativo, cada notificação (incluindo os lembretes
 * de prazo de projetos) também é enviada ao Telegram sem alterar o fluxo nativo.
 */
class TelegramDeliveryChannel {
  constructor() {
    this.name = 'telegram';
    this.enabled = false;
    this.botToken = '';
    this.chatId = '';
  }

  /**
   * Reaplica as configurações vindas do SettingsManager.
   * @param {Object} settings
   */
  updateSettings(settings) {
    if (!settings) return;
    this.botToken = String(settings.telegramBotToken || '').trim();
    this.chatId = String(settings.telegramChatId || '').trim();
    this.enabled =
      settings.telegramNotificationsEnabled !== false &&
      this.botToken.length > 0 &&
      this.chatId.length > 0;
    return this;
  }

  /**
   * Envia a notificação ao chat configurado. Chamado pelo NotificationCenter
   * via `_dispatch()` para cada aviso emitido.
   * @param {{ title: string, body: string, screen?: string, createdAt?: string }} note
   */
  async deliver(note) {
    if (!this.enabled) return;

    // Texto simples e legível no Telegram (sem depender de parse_mode).
    const text = [
      `👁 ${note.title}`,
      note.body,
      '',
      `_Braga Digital Studio_`
    ].join('\n');

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          disable_notification: false
        })
      });

      if (!response.ok) {
        const errBody = await response.text();
        // Erro comum: token inválido (401) ou chat_id incorreto (400)
        logger.warn(
          `[TelegramDeliveryChannel] Falha ao enviar mensagem (HTTP ${response.status})`,
          errBody.slice(0, 300)
        );
      }
    } catch (err) {
      // Sem rede / API indisponível: apenas loga, não derruba o app.
      logger.warn('[TelegramDeliveryChannel] Erro ao conectar com a API do Telegram', err);
    }
  }
}

// Instância única compartilhada por toda a aplicação (main process).
module.exports = new TelegramDeliveryChannel();