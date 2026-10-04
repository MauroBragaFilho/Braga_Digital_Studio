'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const logger = require('../../services/logService');
const { DEVELOPER_EMAIL } = require('../../config/appInfo');
const { sanitizeEnabledModules } = require('../modules/ModuleRegistry');
const { DEFAULT_ACCENT, normalizeAccentColor } = require('./accentPalette');

/** Chaves de segredo guardadas no disco criptografadas (safeStorage) em "<chave>Enc" (base64). Hoje nenhuma: o mecanismo fica pronto para uso futuro. */
const SECRET_SETTING_KEYS = [];
/** Chaves de recursos removidos: apagadas do settings.json existente ao carregar. */
const REMOVED_SETTING_KEYS = ['telegramNotificationsEnabled', 'telegramBotToken', 'telegramBotTokenEnc', 'telegramChatId'];

/** Telas que podem ser a tela inicial (a opção "Assistente IA" foi removida: agora é um botão flutuante). */
const START_SCREENS = ['home', 'download', 'converter', 'silence', 'metadata', 'library', 'projects', 'upload', 'devices', 'luts'];

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

    // [PERF] Cache em memória SEM expiração — o app é o único escritor do settings.json,
    // então load() nunca precisa reler o disco depois da primeira leitura (save() atualiza o cache).
    this._cached = null;
    this._writeTimer = null;
    this._dirty = false;
    this._tmpSeq = 0; // nomes temporários únicos (gravação síncrona e assíncrona não colidem)
    // safeStorage do Electron (DPAPI/Keychain/libsecret). Substituível nos testes; fora do Electron fica null
    // e os segredos permanecem em texto puro (comportamento anterior).
    this.safeStorage = null;
    this.secretKeys = SECRET_SETTING_KEYS; // chaves guardadas criptografadas (substituível nos testes)
    try {
      const electron = require('electron');
      if (electron && typeof electron === 'object' && electron.safeStorage) this.safeStorage = electron.safeStorage;
    } catch (_) { /* fora do Electron */ }

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
      // Pausa aleatória entre os downloads de uma lista (evita bloqueio do YouTube), em segundos
      downloadPauseEnabled: true,
      downloadPauseMinSec: 10,
      downloadPauseMaxSec: 180,
      useYoutubeAccount: false,
      theme: 'dark',
      accentColor: DEFAULT_ACCENT,
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
      enabledModules: {},              // { idDoModulo: boolean } — chave ausente = padrão do módulo (ModuleRegistry: desligados, menos o Assistente de IA)
      modulesMigrated: false,          // true após a migração única dos módulos (ver _migrateModules)
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
  /** Pastas padrão de destino (áudio, vídeo e Conversor): usadas pelo botão "Restaurar padrão" das Configurações. */
  getDefaultFolders() {
    const d = this.defaultSettings;
    return { mp3Folder: d.mp3Folder, mp4Folder: d.mp4Folder, converterFolder: d.converterFolder };
  }

  load() {
    // Cache: devolve a cópia em memória sem tocar no disco
    if (this._cached) return { ...this._cached };

    if (!fs.existsSync(this.settingsPath)) {
      // Instalação nova: módulos pesados desligados (o assistente de IA vem ligado) e nada a migrar depois.
      const fresh = { ...this.defaultSettings, enabledModules: {}, modulesMigrated: true };
      try {
        fs.writeFileSync(this.settingsPath, JSON.stringify(fresh, null, 2), 'utf8');
      } catch (_) {}
      this._setCache(fresh);
      return { ...fresh };
    }

    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      const merged = { ...this.defaultSettings, ...saved };
      const removedLegacy = REMOVED_SETTING_KEYS.filter((k) => k in saved);
      for (const k of removedLegacy) { delete saved[k]; delete merged[k]; }
      const migratedModules = this._migrateModules(saved, merged);
      const migrateSecrets = this._decryptSecrets(saved, merged);
      // Tela inicial que já não existe (ex.: o antigo "Assistente IA", agora botão flutuante) volta para a Home
      if (!START_SCREENS.includes(merged.defaultStartScreen)) merged.defaultStartScreen = 'home';
      // Cor de destaque agora é uma paleta fixa: valor fora dela (inclui o antigo #e53935) vira a opção mais próxima
      const accent = normalizeAccentColor(merged.accentColor);
      const migratedAccent = saved.accentColor !== undefined && saved.accentColor !== accent;
      merged.accentColor = accent;
      if (!merged.mp3Folder) merged.mp3Folder = this.defaultSettings.mp3Folder;
      if (!merged.mp4Folder) merged.mp4Folder = this.defaultSettings.mp4Folder;
      if (!merged.cookiesFile) merged.cookiesFile = this.defaultSettings.cookiesFile;
      // [PERF] Só regrava o arquivo quando o merge realmente adicionou campos novos
      const needsWrite = migrateSecrets || migratedAccent || migratedModules || removedLegacy.length > 0 || Object.keys(this.defaultSettings).some(k => saved[k] === undefined);
      if (needsWrite) {
        this._writeAtomic(merged);
      }
      this._setCache(merged);
      return { ...merged };
    } catch (error) {
      logger.error('settings:failed_to_read', { error: error.message });
      // Preserva o arquivo ilegível (renomeia) antes de recriar com os padrões — nunca sobrescreve sem cópia.
      try { fs.renameSync(this.settingsPath, `${this.settingsPath}.corrupt-${Date.now()}`); } catch (_) {}
      // Havia um settings.json (instalação existente): mantém os recursos que o usuário já tinha.
      const recovered = { ...this.defaultSettings, ...this._legacyModulesPatch() };
      try {
        fs.writeFileSync(this.settingsPath, JSON.stringify(recovered, null, 2), 'utf8');
      } catch (_) {}
      this._setCache(recovered);
      return { ...recovered };
    }
  }

  /** Módulos ligados para quem já usava o app antes do sistema de módulos. */
  _legacyModulesPatch() {
    return {
      // 'ai' fica de fora de propósito: chave ausente = padrão do módulo (ligado)
      enabledModules: { transcription: true, metadata: true, silence: true, recovery: false, montage: false },
      modulesMigrated: true
    };
  }

  /**
   * Migração única do sistema de módulos. Se `enabledModules` não existe nas configurações salvas e a
   * flag `modulesMigrated` ainda não foi gravada, o settings.json é de uma versão anterior: grava
   * Transcrição, Metadados e Remover Silêncios ligados (demais desligados). Depois disso a flag impede
   * nova execução, então a escolha do usuário nunca é sobrescrita. Altera `merged`; true = precisa gravar.
   */
  _migrateModules(saved, merged) {
    let changed = false;
    if (saved.modulesMigrated !== true) {
      const hasChoice = saved.enabledModules && typeof saved.enabledModules === 'object' && !Array.isArray(saved.enabledModules);
      if (!hasChoice) Object.assign(merged, this._legacyModulesPatch());
      else merged.modulesMigrated = true;
      changed = true;
    }
    // O que o usuário já escolheu em enabledModules (inclusive o assistente de IA) tem prioridade e nunca é
    // alterado: só quem NUNCA escolheu (chave ausente) recebe o padrão do módulo.
    return changed;
  }

  /**
   * Salva alterações nas configurações.
   * @param {Object} nextSettings - Propriedades a atualizar
   * @returns {Object} Configurações completas salvas
   */
  save(nextSettings, { defer = false } = {}) {
    const current = this.load();
    const merged = { ...current, ...this._sanitize(nextSettings) };
    this._setCache(merged);
    if (defer) {
      // Gravação adiada e não bloqueante (ex.: posição da janela durante resize/move).
      this._dirty = true;
      clearTimeout(this._writeTimer);
      this._writeTimer = setTimeout(() => this._flushAsync(), 1500);
      if (typeof this._writeTimer.unref === 'function') this._writeTimer.unref();
    } else {
      this._cancelPending();
      this._writeAtomic(merged);
    }
    return merged;
  }

  /** Grava imediatamente qualquer escrita adiada pendente (chamar no encerramento do app). */
  flush() {
    if (!this._dirty || !this._cached) return;
    this._cancelPending();
    this._writeAtomic(this._cached);
  }

  _encryptionAvailable() {
    try { return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable()); }
    catch (_) { return false; }
  }

  /**
   * Preenche em `merged` os segredos decriptados de "<chave>Enc" e remove o campo criptografado
   * do objeto em memória. Devolve true quando há segredo em texto puro no disco que pode ser
   * migrado para a forma criptografada (a gravação seguinte o faz).
   */
  _decryptSecrets(saved, merged) {
    let migrate = false;
    for (const key of this.secretKeys) {
      const encKey = `${key}Enc`;
      const enc = typeof saved[encKey] === 'string' ? saved[encKey] : '';
      delete merged[encKey];
      if (enc) {
        let plain = '';
        if (this._encryptionAvailable()) {
          try { plain = this.safeStorage.decryptString(Buffer.from(enc, 'base64')); }
          catch (err) { logger.warn('settings:secret_decrypt_failed', { key, error: err.message }); }
        }
        merged[key] = plain;
      } else if (typeof saved[key] === 'string' && saved[key] && this._encryptionAvailable()) {
        migrate = true; // texto puro legado: regrava criptografado
      }
    }
    return migrate;
  }

  /** Cópia das configurações para o disco: segredos saem criptografados (quando possível). */
  _toDisk(settings) {
    if (!this._encryptionAvailable()) return settings;
    const out = { ...settings };
    for (const key of this.secretKeys) {
      const value = out[key];
      out[`${key}Enc`] = '';
      if (typeof value === 'string' && value) {
        try {
          out[`${key}Enc`] = this.safeStorage.encryptString(value).toString('base64');
          out[key] = '';
        } catch (err) {
          logger.warn('settings:secret_encrypt_failed', { key, error: err.message });
        }
      }
    }
    return out;
  }

  _tmpName() {
    return `${this.settingsPath}.${process.pid}.${++this._tmpSeq}.tmp`;
  }

  _cancelPending() {
    clearTimeout(this._writeTimer);
    this._writeTimer = null;
    this._dirty = false;
  }

  async _flushAsync() {
    this._writeTimer = null;
    if (!this._dirty || !this._cached) return;
    this._dirty = false;
    const json = JSON.stringify(this._toDisk(this._cached), null, 2);
    const tmp = this._tmpName();
    try {
      await fs.promises.writeFile(tmp, json, 'utf8');
      await fs.promises.rename(tmp, this.settingsPath);
    } catch (err) {
      logger.warn('settings:async_write_failed', { error: err.message });
      this._dirty = true; // tenta de novo no próximo flush()
    }
  }

  /** Gravação síncrona atômica: escreve num temporário e renomeia sobre o arquivo final. */
  _writeAtomic(settings) {
    const json = JSON.stringify(this._toDisk(settings), null, 2);
    const tmp = this._tmpName();
    try {
      fs.writeFileSync(tmp, json, 'utf8');
      fs.renameSync(tmp, this.settingsPath);
    } catch (_) {
      // Rename pode falhar (arquivo travado por antivírus/indexador): cai na gravação direta.
      try { fs.rmSync(tmp, { force: true }); } catch (__) { /* noop */ }
      fs.writeFileSync(this.settingsPath, json, 'utf8');
    }
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

    oneOf('defaultStartScreen', START_SCREENS);
    oneOf('converterDefaultFormat', ['mp4', 'mp3']);
    oneOf('converterDefaultCodec', ['libx264', 'libx265']);
    oneOf('converterDefaultResolution', ['original', '2160', '1440', '1080', '720', '480']);
    oneOf('converterDefaultAudioBitrate', ['128k', '192k', '256k', '320k']);
    // Cor de destaque: só a paleta fixa (inválido volta ao padrão, outro valor vira a opção mais próxima)
    if ('accentColor' in out) out.accentColor = normalizeAccentColor(out.accentColor);
    bool('reduceMotion');
    bool('downloadPauseEnabled');
    for (const key of ['downloadPauseMinSec', 'downloadPauseMaxSec']) {
      if (key in out) {
        const n = Math.round(Number(out[key]));
        if (Number.isFinite(n)) out[key] = Math.min(600, Math.max(0, n)); else delete out[key];
      }
    }
    if ('downloadPauseMinSec' in out && 'downloadPauseMaxSec' in out && out.downloadPauseMaxSec < out.downloadPauseMinSec) {
      out.downloadPauseMaxSec = out.downloadPauseMinSec;
    }
    bool('rememberWindowBounds');

    // Ordem do menu lateral: só ids de tela válidos (a Home é fixa e não entra), sem repetição.
    if ('sidebarOrder' in out) {
      const list = Array.isArray(out.sidebarOrder) ? out.sidebarOrder : [];
      out.sidebarOrder = [...new Set(list.filter(
        (v) => typeof v === 'string' && /^[a-z_]{1,30}$/.test(v) && v !== 'home'
      ))].slice(0, 30);
    }

    // Módulos ligados/desligados: só ids conhecidos com valor booleano.
    if ('enabledModules' in out) out.enabledModules = sanitizeEnabledModules(out.enabledModules);

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
  }
}

module.exports = SettingsManager;
