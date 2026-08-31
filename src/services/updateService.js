'use strict';

const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');
const { toolUpdater } = require('../infrastructure/external-tools/ToolUpdater');
const { dependencyManager } = require('../infrastructure/external-tools/DependencyManager');
const { appUpdateChecker } = require('../infrastructure/external-tools/AppUpdateChecker');
const logger = require('./logService');

class UpdateService extends EventEmitter {
  constructor({ paths, getSettings } = {}) {
    super();
    this.paths = paths;
    this.getSettings = getSettings;
    this._updating = false;
    if (paths && (paths.tools || paths.dataDir)) {
      const toolsDir = paths.tools || paths.dataDir;
      dependencyManager.init(toolsDir);
    }
    this.applyUpdateServerSettings();
  }

  /**
   * Lê `updateServerUrl` das configurações atuais e (re)configura o DependencyManager.
   * Chamado na inicialização e sempre que as configurações forem salvas, para que uma
   * mudança na URL do Update Server tenha efeito imediato, sem reiniciar o BDS.
   */
  applyUpdateServerSettings() {
    if (!this.getSettings) return;
    try {
      const settings = this.getSettings();
      dependencyManager.configureUpdateServer(settings?.updateServerUrl || null);
    } catch (err) {
      logger.warn('UpdateService:applyUpdateServerSettings:error', { error: err.message });
    }
  }

  /**
   * Retorna o status unificado dos componentes do sistema.
   */
  async checkSystem() {
    try {
      return await dependencyManager.checkSystemUpdates();
    } catch (err) {
      logger.error('UpdateService:checkSystem:error', { error: err.message });
      return {
        hasUpdates: false,
        totalNeedingUpdate: 0,
        components: [],
        error: err.message
      };
    }
  }

  /**
   * Atualização unificada com notificação de progresso e status amigável.
   * @param {Function} [onProgress] (percent, message)
   */
  async updateAll(onProgress) {
    // Mutex contra chamadas concorrentes (ex: botão clicado duas vezes ou re-disparo
    // automático após um ciclo que ainda está em andamento).
    if (this._updating) {
      logger.warn('UpdateService:updateAll:busy', { message: 'Uma atualização já está em andamento; ignorando chamada duplicada.' });
      return { success: false, skippedDueToBusy: true, updatedCount: 0, errors: ['Atualização já em andamento.'] };
    }
    this._updating = true;
    logger.info('UpdateService:updateAll:start');
    try {
      const result = await dependencyManager.updateAllComponents((percent, msg) => {
        this.emit('progress', { percent, message: msg });
        if (onProgress) onProgress(percent, msg);
      });
      this.emit('completed', result);
      return result;
    } finally {
      this._updating = false;
      logger.info('UpdateService:updateAll:done');
    }
  }

  /**
   * Verificação unificada (app + dependências). Orquestra as duas fontes em paralelo
   * e retorna um único objeto agregado consumido pelo painel de Atualizações.
   * @returns {Promise<Object>}
   */
  async checkEverything() {
    const [appResult, depsResult] = await Promise.allSettled([
      this.checkAppUpdate(),
      dependencyManager.checkSystemUpdates()
    ]);

    const appInfo = appResult.status === 'fulfilled'
      ? appResult.value
      : { hasUpdate: false, currentVersion: this._currentAppVersion(), latestVersion: null, releaseUrl: null, releaseNotes: null, installerUrl: null, error: appResult.reason?.message };

    const depsInfo = depsResult.status === 'fulfilled'
      ? depsResult.value
      : { hasUpdates: false, totalNeedingUpdate: 0, components: [], error: depsResult.reason?.message };

    const hasUpdates = Boolean(appInfo.hasUpdate) || Boolean(depsInfo.hasUpdates);

    return {
      app: appInfo,
      dependencies: depsInfo,
      hasUpdates
    };
  }

  /**
   * Verifica se há nova versão do próprio BDS (usando app.getVersion()).
   */
  async checkAppUpdate() {
    try {
      return await appUpdateChecker.checkForUpdate(this._currentAppVersion());
    } catch (err) {
      logger.error('UpdateService:checkAppUpdate:error', { error: err.message });
      return { hasUpdate: false, currentVersion: this._currentAppVersion(), latestVersion: null, releaseUrl: null, releaseNotes: null, installerUrl: null };
    }
  }

  _currentAppVersion() {
    try { return app.getVersion(); } catch (_) { return '0.0.0'; }
  }

  /**
   * Atualização unificada completa: atualiza as dependências e, se houver uma nova versão
   * do app disponível, baixa o instalador e o instala em modo silencioso. Não reinicia o
   * app automaticamente — devolve needsRestart para a UI decidir (chama relaunchApp).
   *
   * @param {Function} [onProgress] (percent, message, phase) phase: 'dependencies' | 'app-download' | 'app-install'
   * @returns {Promise<Object>}
   */
  async updateEverything(onProgress) {
    const bailIfBusy = this._updating;
    if (bailIfBusy) {
      return { success: false, skippedDueToBusy: true, updatedCount: 0, errors: ['Atualização já em andamento.'] };
    }

    const now = Date.now();
    const installerPath = path.join(
      (this.paths && (this.paths.tempDir || this.paths.dataDir)) || app.getPath('temp'),
      `BDS_Setup_${now}.exe`
    );

    let dependenciesResult;
    try {
      dependenciesResult = await this.updateAll((percent, msg) => {
        if (onProgress) onProgress(percent, msg, 'dependencies');
      });
    } catch (err) {
      dependenciesResult = { success: false, updatedCount: 0, errors: [`Falha ao atualizar dependências: ${err.message}`] };
    }

    const emitProgress = (percent, message, phase) => {
      this.emit('progress', { percent, message, phase });
      if (onProgress) onProgress(percent, message, phase);
    };

    // Depois das dependências, verifica o app.
    let appUpdate = { checked: false };
    try {
      const appInfo = await this.checkAppUpdate();
      appUpdate.checked = true;
      appUpdate.appInfo = appInfo;

      if (appInfo.hasUpdate && appInfo.installerUrl) {
        emitProgress(100, 'Baixando nova versão do BDS...', 'app-download');
        const dl = await appUpdateChecker.downloadLatestInstaller(
          installerPath,
          (received, total) => {
            const pct = total > 0 ? Math.round((received / total) * 100) : null;
            if (pct != null) {
              emitProgress(pct, `Baixando nova versão do BDS... (${Math.round(received / 1048576)} MB)`, 'app-download');
            }
          }
        );
        appUpdate.downloaded = true;
        appUpdate.installerPath = dl.path;

        emitProgress(100, 'Instalando nova versão do BDS (silencioso)...', 'app-install');
        const install = await appUpdateChecker.installSilently(dl.path);
        appUpdate.install = install;
        appUpdate.installed = install.success;
        appUpdate.needsRestart = install.success;
      } else {
        appUpdate.noUpdateNeeded = true;
      }
    } catch (err) {
      logger.error('UpdateService:updateEverything:app_update_error', { error: err.message });
      appUpdate.error = err.message;
      appUpdate.installed = false;
    } finally {
      // Limpa o instalador baixado, a menos que ainda esteja em uso (instalação em curso).
      if (appUpdate.installerPath && !appUpdate.installed) {
        try { fs.rmSync(appUpdate.installerPath, { force: true }); } catch (_) { /* noop */ }
      }
    }

    this.emit('completed', { dependencies: dependenciesResult, appUpdate });
    return {
      dependencies: dependenciesResult,
      appUpdate,
      success: dependenciesResult?.success !== false && (appUpdate.error ? false : true),
      needsRestart: Boolean(appUpdate.needsRestart)
    };
  }

  /**
   * Baixa apenas o instalador da nova versão do app (fluxo isolado).
   * @param {(received, total)=>void} [onProgress]
   */
  async downloadAppUpdate(onProgress) {
    const installerPath = path.join(
      (this.paths && (this.paths.tempDir || this.paths.dataDir)) || app.getPath('temp'),
      `BDS_Setup_${Date.now()}.exe`
    );
    await appUpdateChecker.downloadLatestInstaller(installerPath, onProgress);
    return { installerPath };
  }

  /**
   * Instala silenciosamente um instalador já baixado.
   * @param {string} installerPath
   */
  async installAppUpdate(installerPath) {
    if (!installerPath || !fs.existsSync(installerPath)) {
      return { success: false, exitCode: null, error: 'Instalador não encontrado.' };
    }
    return await appUpdateChecker.installSilently(installerPath);
  }

  /**
   * Relança o BDS após uma instalação silenciosa concluída. Fecha o processo atual
   * e abre novamente o executável instalado.
   */
  relaunchApp() {
    logger.info('UpdateService:relaunchApp');
    try {
      app.relaunch();
    } catch (_) { /* some platforms may not support */ }
    app.exit(0);
  }

  /**
   * Verificação legado mantida para compatibilidade interna.
   */
  async checkAll() {
    const [ytDlp, ffmpeg, ffprobe, spotifyDlp, deno, untrunc] = await Promise.allSettled([
      this.checkYtDlp(),
      this.checkFfmpeg(),
      this.checkFfprobe(),
      this.checkSpotifyDlp(),
      this.checkDeno(),
      this.checkUntrunc()
    ]);

    return {
      ytDlp: ytDlp.status === 'fulfilled' ? ytDlp.value : this.errorResult('yt-dlp', ytDlp.reason),
      ffmpeg: ffmpeg.status === 'fulfilled' ? ffmpeg.value : this.errorResult('ffmpeg', ffmpeg.reason),
      ffprobe: ffprobe.status === 'fulfilled' ? ffprobe.value : this.errorResult('ffprobe', ffprobe.reason),
      spotifyDlp: spotifyDlp.status === 'fulfilled' ? spotifyDlp.value : this.errorResult('spotify-dlp', spotifyDlp.reason),
      deno: deno.status === 'fulfilled' ? deno.value : this.errorResult('deno', deno.reason),
      untrunc: untrunc.status === 'fulfilled' ? untrunc.value : this.errorResult('untrunc', untrunc.reason),
    };
  }

  async updateTool(tool, onProgress) {
    return dependencyManager.updateComponent(tool, onProgress);
  }

  /**
   * Reverte um componente para a última versão estável conhecida (rollback manual).
   */
  async rollbackTool(tool) {
    logger.info('UpdateService:rollbackTool', { tool });
    return dependencyManager.rollbackComponent(tool);
  }

  async checkYtDlp() {
    const result = await toolUpdater.check('ytdlp');
    return {
      tool: 'yt-dlp',
      installed: result.installed,
      latest: result.latest,
      needsUpdate: result.needsUpdate,
      canUpdate: true
    };
  }

  async checkSpotifyDlp() {
    const result = await toolUpdater.check('spotdl');
    return {
      tool: 'spotify-dlp',
      installed: result.installed ? (result.installed.startsWith('v') ? result.installed : 'v' + result.installed) : null,
      latest: result.latest,
      needsUpdate: result.needsUpdate,
      canUpdate: true
    };
  }

  async checkFfmpeg() {
    const result = await toolUpdater.check('ffmpeg');
    return {
      tool: 'ffmpeg',
      installed: result.installed,
      latest: result.latest,
      needsUpdate: result.needsUpdate,
      canUpdate: true
    };
  }

  async checkFfprobe() {
    const result = await toolUpdater.check('ffprobe');
    return {
      tool: 'ffprobe',
      installed: result.installed,
      latest: result.latest,
      needsUpdate: result.needsUpdate,
      canUpdate: true
    };
  }

  async checkDeno() {
    const result = await toolUpdater.check('deno');
    return {
      tool: 'deno',
      installed: result.installed,
      latest: result.latest,
      needsUpdate: result.needsUpdate,
      canUpdate: true
    };
  }

  async checkUntrunc() {
    const result = await toolUpdater.check('untrunc');
    return {
      tool: 'untrunc',
      installed: result.installed,
      latest: result.latest,
      needsUpdate: result.needsUpdate,
      canUpdate: true
    };
  }

  async updateYtDlp(onProgress) {
    await toolUpdater.update('ytdlp', onProgress);
    return this.checkYtDlp();
  }

  async updateSpotdl(onProgress) {
    await toolUpdater.update('spotdl', onProgress);
    return this.checkSpotifyDlp();
  }

  async updateFfmpeg(onProgress) {
    await toolUpdater.update('ffmpeg', onProgress);
    return this.checkFfmpeg();
  }

  async updateFfprobe(onProgress) {
    await toolUpdater.update('ffprobe', onProgress);
    return this.checkFfprobe();
  }

  async updateDeno(onProgress) {
    await toolUpdater.update('deno', onProgress);
    return this.checkDeno();
  }

  async updateUntrunc(onProgress) {
    await toolUpdater.update('untrunc', onProgress);
    return this.checkUntrunc();
  }

  errorResult(tool, error) {
    return {
      tool,
      installed: null,
      latest: null,
      needsUpdate: false,
      canUpdate: false,
      error: error?.message || String(error)
    };
  }
}

module.exports = UpdateService;

