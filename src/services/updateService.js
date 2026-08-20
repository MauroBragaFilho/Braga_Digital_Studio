'use strict';

const { toolUpdater } = require('../infrastructure/external-tools/ToolUpdater');

class UpdateService {
  constructor({ paths }) {
    this.paths = paths;
    if (paths && paths.dataDir) {
      toolUpdater.init(paths.dataDir);
    }
  }

  async checkAll() {
    const [ytDlp, ffmpeg, ffprobe, spotifyDlp, deno] = await Promise.allSettled([
      this.checkYtDlp(),
      this.checkFfmpeg(),
      this.checkFfprobe(),
      this.checkSpotifyDlp(),
      this.checkDeno()
    ]);

    return {
      ytDlp: ytDlp.status === 'fulfilled' ? ytDlp.value : this.errorResult('yt-dlp', ytDlp.reason),
      ffmpeg: ffmpeg.status === 'fulfilled' ? ffmpeg.value : this.errorResult('ffmpeg', ffmpeg.reason),
      ffprobe: ffprobe.status === 'fulfilled' ? ffprobe.value : this.errorResult('ffprobe', ffprobe.reason),
      spotifyDlp: spotifyDlp.status === 'fulfilled' ? spotifyDlp.value : this.errorResult('spotify-dlp', spotifyDlp.reason),
      deno: deno.status === 'fulfilled' ? deno.value : this.errorResult('deno', deno.reason)
    };
  }

  async updateTool(tool) {
    if (tool === 'yt-dlp' || tool === 'ytdlp') return this.updateYtDlp();
    if (tool === 'ffmpeg') return this.updateFfmpeg();
    if (tool === 'ffprobe') return this.updateFfprobe();
    if (tool === 'spotdl' || tool === 'spotify-dlp') return this.updateSpotdl();
    if (tool === 'deno') return this.updateDeno();
    throw new Error('Ferramenta inválida.');
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

  async updateYtDlp() {
    await toolUpdater.update('ytdlp');
    return this.checkYtDlp();
  }

  async updateSpotdl() {
    await toolUpdater.update('spotdl');
    return this.checkSpotifyDlp();
  }

  async updateFfmpeg() {
    await toolUpdater.update('ffmpeg');
    return this.checkFfmpeg();
  }

  async updateFfprobe() {
    await toolUpdater.update('ffprobe');
    return this.checkFfprobe();
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

  async updateDeno() {
    await toolUpdater.update('deno');
    return this.checkDeno();
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
