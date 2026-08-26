'use strict';

const EventEmitter = require('node:events');
const { toolUpdater } = require('../infrastructure/external-tools/ToolUpdater');
const { dependencyManager } = require('../infrastructure/external-tools/DependencyManager');
const logger = require('./logService');

class UpdateService extends EventEmitter {
  constructor({ paths, getSettings } = {}) {
    super();
    this.paths = paths;
    this.getSettings = getSettings;
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
    logger.info('UpdateService:updateAll:start');
    const result = await dependencyManager.updateAllComponents((percent, msg) => {
      this.emit('progress', { percent, message: msg });
      if (onProgress) onProgress(percent, msg);
    });
    this.emit('completed', result);
    return result;
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

