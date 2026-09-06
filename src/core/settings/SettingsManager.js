'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const logger = require('../../services/logService');
const { DEVELOPER_EMAIL } = require('../../config/appInfo');

/**
 * SettingsManager — Gerenciamento e persistência das configurações da aplicação.
 */
class SettingsManager {
  /**
   * @param {string} configDir - Diretório de configurações (AppPaths.configDir)
   * @param {string} dataDir - Diretório de dados (AppPaths.dataDir)
   */
  constructor(configDir, dataDir) {
    this.configDir = configDir;
    this.dataDir = dataDir;
    this.settingsPath = path.join(configDir, 'settings.json');

    this.defaultSettings = {
      // UI — estado da sidebar (true = colapsada, apenas ícones)
      sidebarCollapsed: false,
      useDefaultFolder: true,
      mp3Folder: path.join(os.homedir(), 'Music'),
      mp4Folder: path.join(os.homedir(), 'Videos'),
      obsFolder: '',
      shadowplayFolder: '',
      converterFolder: path.join(os.homedir(), 'Videos', 'Convertido'),
      deviceFolder: path.join(os.homedir(), 'Videos', 'BDSM DEVICES'),
      // Pasta monitorada pelo scanner de uploads automáticos para YouTube
      uploadsFolder: path.join(os.homedir(), 'Videos', 'Uploads'),
      autoUpdateDeps: false,
      cookiesFile: path.join(dataDir, 'cookies.txt'),
      useYoutubeAccount: false,
      theme: 'dark',
      accentColor: '#e53935',
      lutPreviewImage: '',
      checkUpdatesOnStart: false,
      errorReportingEnabled: true,
      developerEmail: DEVELOPER_EMAIL,
      errorReportingEndpoint: '',
      // Notificações nativas e barra de progresso na taskbar
      notificationsEnabled: true,
      notifyDownloads: true,
      notifyConverter: true,
      notifyCopy: true,
      notifySilence: true,
      // Notificações de prazos dos projetos
      notifyDeadlines: true,
      // Quantos dias antes do prazo disparar a notificação de "prazo próximo"
      deadlineNotifyLeadDays: 5,
      // Horário local (HH:mm) em que os lembretes de prazo são avaliados
      deadlineNotifyTime: '09:00',
      // Integração Telegram (opcional): bot criado via @BotFather e chat_id do destinatário
      telegramNotificationsEnabled: false,
      telegramBotToken: '',
      telegramChatId: '',
      // URL base do BDS Update Server (ex: https://updates.bragadigital.com). Deixe vazio
      // para usar apenas o fluxo padrão de checagem por componente via GitHub releases.
      updateServerUrl: ''
    };
  }

  /**
   * Carrega as configurações existentes mesclando com os padrões.
   * @returns {Object}
   */
  load() {
    if (!fs.existsSync(this.settingsPath)) {
      try {
        fs.writeFileSync(this.settingsPath, JSON.stringify(this.defaultSettings, null, 2), 'utf8');
      } catch (_) {}
      return { ...this.defaultSettings };
    }

    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      const merged = { ...this.defaultSettings, ...saved };
      if (!merged.mp3Folder) merged.mp3Folder = this.defaultSettings.mp3Folder;
      if (!merged.mp4Folder) merged.mp4Folder = this.defaultSettings.mp4Folder;
      if (!merged.cookiesFile) merged.cookiesFile = this.defaultSettings.cookiesFile;
      fs.writeFileSync(this.settingsPath, JSON.stringify(merged, null, 2), 'utf8');
      return merged;
    } catch (error) {
      logger.error('settings:failed_to_read', { error: error.message });
      try {
        fs.writeFileSync(this.settingsPath, JSON.stringify(this.defaultSettings, null, 2), 'utf8');
      } catch (_) {}
      return { ...this.defaultSettings };
    }
  }

  /**
   * Salva alterações nas configurações.
   * @param {Object} nextSettings - Propriedades a atualizar
   * @returns {Object} Configurações completas salvas
   */
  save(nextSettings) {
    const current = this.load();
    const merged = { ...current, ...nextSettings };
    fs.writeFileSync(this.settingsPath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }
}

module.exports = SettingsManager;
