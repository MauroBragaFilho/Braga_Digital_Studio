'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { getExecutableName } = require('./ToolManifest');
const { toolResolver } = require('./ToolResolver');
const logger = require('../../services/logService');

/**
 * ToolUpdater — Gerenciamento genérico e multiplataforma de atualização de ferramentas externas.
 */
class ToolUpdater {
  constructor() {
    this._toolsDir = null;
  }

  init(toolsDir) {
    this._toolsDir = toolsDir;
  }

  async check(toolKey) {
    const config = this._getConfig(toolKey);
    const exe = toolResolver.resolve(toolKey, this._toolsDir, { mustExist: false });
    const isInstalled = fs.existsSync(exe);
    const installed = isInstalled ? await this._getVersion(exe, config.versionArgs) : null;
    const latest = await this._fetchLatestTag(config.githubOwner, config.githubRepo).catch(() => null);
    return {
      tool: toolKey,
      installed,
      latest,
      needsUpdate: !installed || (latest ? !installed.includes(latest.replace(/^v/, '')) : false),
      canUpdate: true,
    };
  }

  async update(toolKey, onProgress) {
    // yt-dlp tem self-update nativo no binário standalone (yt-dlp -U).
    // É mais simples e confiável que baixar/substituir manualmente via GitHub API,
    // então não passa pelo fluxo genérico de download abaixo.
    if (toolKey === 'ytdlp') {
      return this._updateYtDlpSelf(onProgress);
    }

    const config = this._getConfig(toolKey);
    const exeName = getExecutableName(toolKey);
    const target = path.join(this._toolsDir, exeName);

    logger.info(`toolUpdater:update:start`, { tool: toolKey });

    if (onProgress) onProgress(0);

    const latestTag = await this._fetchLatestTag(config.githubOwner, config.githubRepo);
    const downloadUrl = config.downloadUrl(latestTag, process.platform);
    const isZip = downloadUrl.endsWith('.zip');
    const temp = isZip ? path.join(this._toolsDir, `${toolKey}-download.zip`) : `${target}.download`;

    if (onProgress) onProgress(10);

    await this._downloadFile(downloadUrl, temp, (bytesReceived, totalBytes) => {
      if (onProgress && totalBytes > 0) {
        onProgress(10 + Math.round((bytesReceived / totalBytes) * 70));
      }
    });

    if (onProgress) onProgress(80);

    let sourceFile = temp;
    if (isZip) {
      const extractDir = path.join(this._toolsDir, `${toolKey}-update`);
      fs.rmSync(extractDir, { recursive: true, force: true });
      await this._extractZip(temp, extractDir);
      const found = this._findFile(extractDir, exeName);
      if (!found) throw new Error(`${exeName} não encontrado no pacote baixado.`);
      sourceFile = found;

      // Se o pacote for do ffmpeg/ffprobe e contiver ambos os executáveis, aproveita para copiar o outro também
      if (toolKey === 'ffmpeg' || toolKey === 'ffprobe') {
        const otherKey = toolKey === 'ffmpeg' ? 'ffprobe' : 'ffmpeg';
        const otherExe = getExecutableName(otherKey);
        const otherFound = this._findFile(extractDir, otherExe);
        if (otherFound) {
          const otherTarget = path.join(this._toolsDir, otherExe);
          try {
            if (fs.existsSync(otherTarget)) fs.unlinkSync(otherTarget);
          } catch (_) {
            try { fs.renameSync(otherTarget, `${otherTarget}.old`); } catch (_) {}
          }
          try { fs.copyFileSync(otherFound, otherTarget); } catch (_) {}
        }
      }
    }

    if (fs.existsSync(target)) {
      try { fs.unlinkSync(target); } catch (_) { fs.renameSync(target, `${target}.old`); }
    }
    fs.copyFileSync(sourceFile, target);

    // Limpar temporários
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    const extractDir = path.join(this._toolsDir, `${toolKey}-update`);
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });

    if (onProgress) onProgress(100);
    logger.info(`toolUpdater:update:done`, { tool: toolKey });

    return this.check(toolKey);
  }

  async _updateYtDlpSelf(onProgress) {
    const { ytDlpTool } = require('./adapters/YtDlpTool');
    logger.info('toolUpdater:update:start', { tool: 'ytdlp', mode: 'self-update' });
    if (onProgress) onProgress(10);
    await ytDlpTool.selfUpdate('stable');
    if (onProgress) onProgress(100);
    logger.info('toolUpdater:update:done', { tool: 'ytdlp', mode: 'self-update' });
    return this.check('ytdlp');
  }

  _getConfig(toolKey) {
    const configs = {
      ytdlp: {
        githubOwner: 'yt-dlp',
        githubRepo: 'yt-dlp',
        versionArgs: ['--version'],
        downloadUrl: (tag, platform) => {
          if (platform === 'win32') return `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe`;
          return `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp`;
        },
      },
      ffmpeg: {
        githubOwner: 'BtbN',
        githubRepo: 'FFmpeg-Builds',
        versionArgs: ['-version'],
        downloadUrl: (tag, platform) => {
          if (platform === 'win32') return 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';
          return 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz';
        },
      },
      ffprobe: {
        githubOwner: 'BtbN',
        githubRepo: 'FFmpeg-Builds',
        versionArgs: ['-version'],
        downloadUrl: (tag, platform) => {
          if (platform === 'win32') return 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';
          return 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz';
        },
      },
      spotdl: {
        githubOwner: 'spotDL',
        githubRepo: 'spotify-downloader',
        versionArgs: ['--version'],
        downloadUrl: (tag, platform) => {
          const versionNum = (tag || '').replace(/^v/, '');
          if (platform === 'win32') return `https://github.com/spotDL/spotify-downloader/releases/download/${tag}/spotdl-${versionNum}-win32.exe`;
          return `https://github.com/spotDL/spotify-downloader/releases/download/${tag}/spotdl-${versionNum}-linux`;
        },
      },
      deno: {
        githubOwner: 'denoland',
        githubRepo: 'deno',
        versionArgs: ['--version'],
        downloadUrl: (tag, platform) => {
          if (platform === 'win32') return 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip';
          if (platform === 'darwin') return 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-apple-darwin.zip';
          return 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip';
        },
      },
    };

    const config = configs[toolKey];
    if (!config) throw new Error(`ToolUpdater: ferramenta desconhecida '${toolKey}'`);
    return config;
  }

  async _getVersion(exe, args) {
    return new Promise((resolve) => {
      const child = spawn(exe, args, { windowsHide: true });
      let output = '';
      child.stdout.on('data', (c) => { output += c.toString('utf8'); });
      child.stderr.on('data', (c) => { output += c.toString('utf8'); });
      child.on('error', () => resolve(null));
      child.on('close', () => resolve(output.split(/\r?\n/)[0]?.trim() || null));
    });
  }

  async _fetchLatestTag(owner, repo) {
    const data = await this._requestJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
    return data.tag_name || data.name;
  }

  _requestJson(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'BragaDigitalStudio/1.0', 'Accept': 'application/vnd.github+json' }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(this._requestJson(res.headers.location)); return;
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} ao consultar ${url}`)); res.resume(); return; }
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('Timeout ao consultar atualização.')));
    });
  }

  _downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      const req = https.get(url, { headers: { 'User-Agent': 'BragaDigitalStudio/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close(); fs.rmSync(dest, { force: true });
          resolve(this._downloadFile(res.headers.location, dest, onProgress)); return;
        }
        if (res.statusCode !== 200) {
          file.close(); fs.rmSync(dest, { force: true });
          reject(new Error(`HTTP ${res.statusCode} ao baixar ${url}`)); return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        res.on('data', (chunk) => { received += chunk.length; if (onProgress) onProgress(received, total); });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      });
      req.on('error', (err) => { file.close(); fs.rmSync(dest, { force: true }); reject(err); });
    });
  }

  async _extractZip(zipPath, destination) {
    fs.mkdirSync(destination, { recursive: true });
    
    // Tenta primeiro com AdmZip (biblioteca JavaScript pura instalada, multiplataforma)
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(destination, true);
      return;
    } catch (zipErr) {
      logger.warn('toolUpdater:admzip_failed_fallback_system', { error: zipErr.message });
    }

    // Fallback para ferramentas do sistema
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        const child = spawn('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destination}" -Force`
        ], { windowsHide: true });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Expand-Archive erro ${code}`)));
      } else {
        const child = spawn('unzip', ['-o', zipPath, '-d', destination]);
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`unzip erro ${code}`)));
      }
    });
  }

  _findFile(root, fileName) {
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      const current = path.join(root, item.name);
      if (item.isDirectory()) {
        const found = this._findFile(current, fileName);
        if (found) return found;
      } else if (item.name.toLowerCase() === fileName.toLowerCase()) {
        return current;
      }
    }
    return null;
  }
}

const toolUpdater = new ToolUpdater();
module.exports = { ToolUpdater, toolUpdater };
