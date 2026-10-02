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

    // [PERF] Cache em memória — evita leitura + regravação do arquivo
    // a cada chamada de load() (método chamado com frequência por vários
    // handlers IPC e serviços em background).
    this._cached = null;
    this._cacheUpdatedAt = 0;
    this._CACHE_TTL_MS = 1500;

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
      updateServerUrl: '',
      // Aceleração de hardware (GPU) para codificação/decodificação de vídeo via FFmpeg.
      // enabled=false força o uso de CPU (libx264/libx265/libsvtav1).
      // vendor: 'auto' | 'nvidia' | 'amd' | 'intel' — prioridade na escolha do encoder.
      useHardwareAcceleration: true,
      preferredGpuVendor: 'auto',
      // Cache: limite e limpeza automática
      cacheMaxSizeMB: 500,
      cacheAutoClean: false,
      // Interface e janela
      defaultStartScreen: 'home',      // tela aberta ao iniciar o app
      sidebarOrder: [],                // ordem das telas no menu lateral (vazio = padrão; Home é sempre a primeira)
      reduceMotion: false,             // desliga animações e transições
      rememberWindowBounds: false,     // lembra tamanho/posição da janela
      windowBounds: null,              // { x, y, width, height, maximized } — gravado pelo main.js
      // Padrões do Conversor (aplicados ao abrir a tela)
      converterDefaultFormat: 'mp4',
      converterDefaultCodec: 'libx264',
      converterDefaultResolution: 'original',
      converterDefaultVideoBitrate: 10,   // Mbps
      converterDefaultAudioBitrate: '192k',
      // Já usadas pelo código, agora com padrão explícito
      hiddenDevices: [],
      autoUpdateGithub: true
    };
  }

  /**
   * Carrega as configurações existentes mesclando com os padrões.
   * Utiliza cache em memória para evitar I/O de disco em chamadas frequentes.
   * @returns {Object}
   */
  load() {
    // Cache fresco: retorna a cópia em memória sem tocar no disco
    if (this._cached && (Date.now() - this._cacheUpdatedAt) < this._CACHE_TTL_MS) {
      return { ...this._cached };
    }

    // Cache expirado: tenta reler do disco apenas se o arquivo existir
    if (this._cached && fs.existsSync(this.settingsPath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
        // Só faz merge/regrava se o disco divergir do cache (normalização rara)
        if (Object.keys(saved).every(k => this._cached[k] === saved[k])) {
          this._cacheUpdatedAt = Date.now();
          return { ...this._cached };
        }
      } catch (_) { /* arquivo corrompido cai no fluxo completo abaixo */ }
    }

    if (!fs.existsSync(this.settingsPath)) {
      try {
        fs.writeFileSync(this.settingsPath, JSON.stringify(this.defaultSettings, null, 2), 'utf8');
      } catch (_) {}
      this._setCache(this.defaultSettings);
      return { ...this.defaultSettings };
    }

    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      const merged = { ...this.defaultSettings, ...saved };
      if (!merged.mp3Folder) merged.mp3Folder = this.defaultSettings.mp3Folder;
      if (!merged.mp4Folder) merged.mp4Folder = this.defaultSettings.mp4Folder;
      if (!merged.cookiesFile) merged.cookiesFile = this.defaultSettings.cookiesFile;
      // [PERF] Só regrava o arquivo quando o merge realmente adicionou campos novos
      const needsWrite = Object.keys(this.defaultSettings).some(k => saved[k] === undefined);
      if (needsWrite) {
        fs.writeFileSync(this.settingsPath, JSON.stringify(merged, null, 2), 'utf8');
      }
      this._setCache(merged);
      return { ...merged };
    } catch (error) {
      logger.error('settings:failed_to_read', { error: error.message });
      try {
        fs.writeFileSync(this.settingsPath, JSON.stringify(this.defaultSettings, null, 2), 'utf8');
      } catch (_) {}
      this._setCache(this.defaultSettings);
      return { ...this.defaultSettings };
    }
  }

  /**
   * Salva alterações nas configurações.
   * @param {Object} nextSettings - Propriedades a atualizar
   * @returns {Object} Configurações completas salvas
   */
  save(nextSettings) {
    const current = { ...this._cached, ...this.load() };
    const merged = { ...current, ...this._sanitize(nextSettings) };
    fs.writeFileSync(this.settingsPath, JSON.stringify(merged, null, 2), 'utf8');
    this._setCache(merged);
    return merged;
  }

  /**
   * Valida só as chaves de preferências com formato restrito (enums e faixas). Valor inválido
   * é descartado e o atual é mantido. As demais chaves passam sem alteração (comportamento antigo).
   */
  _sanitize(patch) {
    if (!patch || typeof patch !== 'object') return {};
    const out = { ...patch };
    const oneOf = (key, allowed) => { if (key in out && !allowed.includes(out[key])) delete out[key]; };
    const bool = (key) => { if (key in out) out[key] = out[key] === true; };

    oneOf('defaultStartScreen', ['home', 'download', 'converter', 'silence', 'metadata', 'library', 'projects', 'upload', 'devices', 'luts', 'ai']);
    oneOf('converterDefaultFormat', ['mp4', 'mp3']);
    oneOf('converterDefaultCodec', ['libx264', 'libx265']);
    oneOf('converterDefaultResolution', ['original', '2160', '1440', '1080', '720', '480']);
    oneOf('converterDefaultAudioBitrate', ['128k', '192k', '256k', '320k']);
    bool('reduceMotion');
    bool('rememberWindowBounds');

    // Ordem do menu lateral: só ids de tela válidos (a Home é fixa e não entra), sem repetição.
    if ('sidebarOrder' in out) {
      const list = Array.isArray(out.sidebarOrder) ? out.sidebarOrder : [];
      out.sidebarOrder = [...new Set(list.filter(
        (v) => typeof v === 'string' && /^[a-z_]{1,30}$/.test(v) && v !== 'home'
      ))].slice(0, 30);
    }

    if ('converterDefaultVideoBitrate' in out) {
      const n = Math.round(Number(out.converterDefaultVideoBitrate));
      if (Number.isFinite(n) && n >= 1 && n <= 100) out.converterDefaultVideoBitrate = n;
      else delete out.converterDefaultVideoBitrate;
    }
    if ('windowBounds' in out && out.windowBounds !== null) {
      const b = out.windowBounds;
      const ok = b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width >= 400 && b.height >= 300;
      out.windowBounds = ok
        ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height), maximized: b.maximized === true }
        : null;
    }
    return out;
  }

  _setCache(settings) {
    this._cached = { ...settings };
    this._cacheUpdatedAt = Date.now();
  }
}

module.exports = SettingsManager;
