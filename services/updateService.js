const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const logger = require('./logService');

class UpdateService {
  constructor({ paths }) {
    this.paths = paths;
  }

  async checkAll() {
    const [ytDlp, ffmpeg] = await Promise.allSettled([
      this.checkYtDlp(),
      this.checkFfmpeg(),
      this.checkFfprobe(),
      this.checkSpotifyDlp()
    ]);

    return {
      ytDlp: ytDlp.status === 'fulfilled' ? ytDlp.value : this.errorResult('yt-dlp', ytDlp.reason),
      ffmpeg: ffmpeg.status === 'fulfilled' ? ffmpeg.value : this.errorResult('ffmpeg', ffmpeg.reason)
    };
  }

  async updateTool(tool) {
    if (tool === 'yt-dlp') return this.updateYtDlp();
    if (tool === 'ffmpeg') return this.updateFfmpeg();
    if (tool === 'ffprobe') return this.updateFfprobe();
    if (tool === 'spotdl' || tool === 'spotify-dlp') return this.updateSpotdl();
    throw new Error('Ferramenta inválida.');
  }

  async checkYtDlp() {
    const exe = path.join(this.paths.dataDir, 'yt-dlp.exe');
    const installed = fs.existsSync(exe) ? await this.getProcessOutput(exe, ['--version']) : null;
    const latest = await this.fetchGithubLatestTag('yt-dlp', 'yt-dlp');
    return {
      tool: 'yt-dlp',
      installed: installed?.trim() || null,
      latest,
      needsUpdate: !installed || installed.trim() !== latest,
      canUpdate: true
    };
  }

  async checkSpotifyDlp() {
    const exe = path.join(this.paths.dataDir, 'spotify-dlp.exe');
    const installedOutput = fs.existsSync(exe) ? await this.getProcessOutput(exe, ['--version']).catch(() => null) : null;
    const installed = installedOutput ? 'v' + installedOutput.trim() : null;
    const latest = await this.fetchGithubLatestTag('spotDL', 'spotify-downloader');
    return {
      tool: 'spotify-dlp',
      installed,
      latest,
      needsUpdate: !installed || installed !== latest,
      canUpdate: true
    };
  }

  async updateSpotdl() {
    const target = path.join(this.paths.dataDir, 'spotify-dlp.exe');
    const temp = `${target}.download`;
    
    const latestVersion = await this.fetchGithubLatestTag('spotDL', 'spotify-downloader');
    const versionNum = latestVersion.replace(/^v/, '');
    const downloadUrl = `https://github.com/spotDL/spotify-downloader/releases/download/${latestVersion}/spotdl-${versionNum}-win32.exe`;
    
    await this.downloadFile(downloadUrl, temp);
    if (fs.existsSync(target)) {
        try {
            fs.unlinkSync(target);
        } catch (err) {
            fs.renameSync(target, `${target}.old`);
        }
    }
    fs.renameSync(temp, target);
    logger.info('updates:spotdl_updated');
    return this.checkSpotifyDlp();
  } 

  async checkFfmpeg() {
    const exe = path.join(this.paths.dataDir, 'ffmpeg.exe');
    const installedOutput = fs.existsSync(exe) ? await this.getProcessOutput(exe, ['-version']) : null;
    const installed = installedOutput ? installedOutput.split(/\r?\n/)[0] : null;
    const latest = await this.fetchGithubLatestTag('BtbN', 'FFmpeg-Builds');
    return {
      tool: 'ffmpeg',
      installed,
      latest,
      needsUpdate: !installed || !installed.includes(latest),
      canUpdate: true
    };
  }

    async checkFfprobe() {
    const exe = path.join(this.paths.dataDir, 'ffprobe.exe');
    const installedOutput = fs.existsSync(exe) ? await this.getProcessOutput(exe, ['-version']) : null;
    const installed = installedOutput ? installedOutput.split(/\r?\n/)[0] : null;
    const latest = await this.fetchGithubLatestTag('BtbN', 'FFprobe-Builds');
    return {
      tool: 'ffprobe',
      installed,
      latest,
      needsUpdate: !installed || !installed.includes(latest),
      canUpdate: true
    };
  }

  async updateYtDlp() {
    const target = path.join(this.paths.dataDir, 'yt-dlp.exe');
    const temp = `${target}.download`;
    await this.downloadFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', temp);
    if (fs.existsSync(target)) {
        try {
            // Tenta remover o antigo antes de renomear
            fs.unlinkSync(target);
        } catch (err) {
            // Se falhar (arquivo em uso), force o encerramento ou renomeie o antigo para .old
            fs.renameSync(target, `${target}.old`);
        }
    }
    fs.renameSync(temp, target);
    logger.info('updates:yt_dlp_updated');
    return this.checkYtDlp();
  }

  async updateFfmpeg() {
    const zipPath = path.join(this.paths.dataDir, 'ffmpeg-latest.zip');
    const extractDir = path.join(this.paths.dataDir, 'ffmpeg-update');
    const target = path.join(this.paths.dataDir, 'ffmpeg.exe');

    fs.rmSync(extractDir, { recursive: true, force: true });
    await this.downloadFile('https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip', zipPath);
    await this.expandArchive(zipPath, extractDir);

    const ffmpegExe = this.findFile(extractDir, 'ffmpeg.exe');
    if (!ffmpegExe) throw new Error('ffmpeg.exe não encontrado no pacote baixado.');

    fs.copyFileSync(ffmpegExe, target);
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
    logger.info('updates:ffmpeg_updated');
    return this.checkFfmpeg();
  }

   async updateFfprobe() {
    const zipPath = path.join(this.paths.dataDir, 'ffprobe-latest.zip');
    const extractDir = path.join(this.paths.dataDir, 'ffprobe-update');
    const target = path.join(this.paths.dataDir, 'ffprobe.exe');

    fs.rmSync(extractDir, { recursive: true, force: true });
    await this.downloadFile('https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip', zipPath);
    await this.expandArchive(zipPath, extractDir);

    const ffprobeExe = this.findFile(extractDir, 'ffprobe.exe');
    if (!ffprobeExe) throw new Error('ffprobe.exe não encontrado no pacote baixado.');

    fs.copyFileSync(ffprobeExe, target);
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
    logger.info('updates:ffprobe_updated');
    return this.checkFfprobe();
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

  async fetchGithubLatestTag(owner, repo) {
    const json = await this.requestJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
    return json.tag_name || json.name;
  }

  requestJson(url) {
    return new Promise((resolve, reject) => {
      const request = https.get(url, {
        headers: {
          'User-Agent': 'BragaMediaDownloader/2.0',
          'Accept': 'application/vnd.github+json'
        }
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          resolve(this.requestJson(response.headers.location));
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} ao consultar ${url}`));
          response.resume();
          return;
        }
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on('error', reject);
      request.setTimeout(20000, () => request.destroy(new Error('Tempo esgotado ao consultar atualização.')));
    });
  }

  downloadFile(url, target) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(target);
      const request = https.get(url, { headers: { 'User-Agent': 'BragaMediaDownloader/2.0' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.rmSync(target, { force: true });
          resolve(this.downloadFile(response.headers.location, target));
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.rmSync(target, { force: true });
          reject(new Error(`HTTP ${response.statusCode} ao baixar ${url}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(resolve));
      });
      request.on('error', (error) => {
        file.close();
        fs.rmSync(target, { force: true });
        reject(error);
      });
    });
  }

  expandArchive(zipPath, destination) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(destination, { recursive: true });
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destination}" -Force`
      ], { windowsHide: true });
      child.on('error', reject);
      child.on('close', (code) => {
        code === 0 ? resolve() : reject(new Error(`Expand-Archive finalizou com código ${code}`));
      });
    });
  }

  getProcessOutput(exe, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', () => resolve(output));
    });
  }

  findFile(root, fileName) {
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      const current = path.join(root, item.name);
      if (item.isDirectory()) {
        const found = this.findFile(current, fileName);
        if (found) return found;
      } else if (item.name.toLowerCase() === fileName.toLowerCase()) {
        return current;
      }
    }
    return null;
  }
}

module.exports = UpdateService;
