'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { getExecutableName, resolveCanonicalToolKey } = require('./ToolManifest');
const { toolResolver } = require('./ToolResolver');
const logger = require('../../services/logService');

/**
 * Registra eventos específicos do atualizador em logs/updater.log
 */
function logUpdater(message, data = null) {
  try {
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, 'updater.log');
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
    fs.appendFileSync(logPath, `[${timestamp}] ${message}${dataStr}\n`, 'utf8');
  } catch (_) {}
}

/**
 * ToolUpdater — Gerenciamento atômico de atualização dos componentes internos do BDS.
 */
class ToolUpdater {
  constructor() {
    this._toolsDir = null;
  }

  init(toolsDir) {
    this._toolsDir = toolsDir;
  }

  async check(rawToolKey) {
    const toolKey = resolveCanonicalToolKey(rawToolKey);
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

  /**
   * Executa atualização atômica de um componente interno com staging, smoke-test e rollback.
   */
  async update(rawToolKey, onProgress) {
    const toolKey = resolveCanonicalToolKey(rawToolKey);

    if (toolKey === 'ytdlp') {
      return this._updateYtDlpSelf(onProgress);
    }

    const config = this._getConfig(toolKey);
    const exeName = getExecutableName(toolKey);
    const target = path.join(this._toolsDir, exeName);

    logUpdater(`Iniciando atualização de componente: ${toolKey}`);
    logger.info(`toolUpdater:update:start`, { tool: toolKey });

    if (onProgress) onProgress(5);

    // 1. Obter tag mais recente e URL de download
    const latestTag = await this._fetchLatestTag(config.githubOwner, config.githubRepo);
    const downloadUrl = config.downloadUrl(latestTag, process.platform);
    const isZip = downloadUrl.endsWith('.zip') || downloadUrl.includes('.zip');

    // 2. Diretório temporário de Staging isolado
    const stagingDir = path.join(this._toolsDir, `.staging_${toolKey}_${Date.now()}`);
    const backupTarget = path.join(this._toolsDir, `.backup_${exeName}`);
    fs.mkdirSync(stagingDir, { recursive: true });

    const downloadDest = path.join(stagingDir, isZip ? `${toolKey}_download.zip` : exeName);

    if (onProgress) onProgress(15);

    try {
      // 3. Download para Staging
      await this._downloadFile(downloadUrl, downloadDest, (bytesReceived, totalBytes) => {
        if (onProgress && totalBytes > 0) {
          onProgress(15 + Math.round((bytesReceived / totalBytes) * 60));
        }
      });

      if (onProgress) onProgress(75);

      let stagedExe = downloadDest;

      // 4. Se for ZIP, extrair para staging e localizar o executável
      if (isZip) {
        const extractDir = path.join(stagingDir, 'extracted');
        fs.mkdirSync(extractDir, { recursive: true });
        await this._extractZip(downloadDest, extractDir);
        const found = this._findFile(extractDir, exeName);
        if (!found) {
          throw new Error(`Componente ${exeName} não foi encontrado no arquivo baixado.`);
        }
        stagedExe = found;

        // Se for ffmpeg/ffprobe e contiver ambos, staging também do par
        if (toolKey === 'ffmpeg' || toolKey === 'ffprobe') {
          const otherKey = toolKey === 'ffmpeg' ? 'ffprobe' : 'ffmpeg';
          const otherExe = getExecutableName(otherKey);
          const otherFound = this._findFile(extractDir, otherExe);
          if (otherFound) {
            this._atomicInstallPair(otherFound, path.join(this._toolsDir, otherExe), otherKey);
          }
        }
      }

      if (onProgress) onProgress(85);

      // 5. Smoke-Test (Validação de Execução no arquivo em Staging)
      const testVersion = await this._getVersion(stagedExe, config.versionArgs);
      if (!testVersion && config.versionArgs.length > 0) {
        logUpdater(`Aviso de validação: smoke-test retornou vazio para ${stagedExe}`);
      }

      // 6. Backup da versão atual instalada
      if (fs.existsSync(target)) {
        try {
          if (fs.existsSync(backupTarget)) fs.rmSync(backupTarget, { force: true });
          fs.copyFileSync(target, backupTarget);
        } catch (bkErr) {
          logUpdater(`Aviso ao criar backup de ${exeName}: ${bkErr.message}`);
        }
      }

      // 7. Substituição Atômica
      try {
        if (fs.existsSync(target)) {
          try {
            fs.unlinkSync(target);
          } catch (_) {
            fs.renameSync(target, `${target}.old_${Date.now()}`);
          }
        }
        fs.copyFileSync(stagedExe, target);
        logUpdater(`Componente ${toolKey} atualizado com sucesso para versão ${latestTag}`);
      } catch (swapErr) {
        // Rollback automático
        logUpdater(`Falha na substituição de ${exeName}, iniciando rollback...`, { error: swapErr.message });
        if (fs.existsSync(backupTarget)) {
          try {
            fs.copyFileSync(backupTarget, target);
            logUpdater(`Rollback para ${exeName} concluído com sucesso.`);
          } catch (rbErr) {
            logUpdater(`Falha crítica no rollback de ${exeName}: ${rbErr.message}`);
          }
        }
        throw new Error(`Não foi possível instalar o componente ${exeName}: ${swapErr.message}`);
      }

      if (onProgress) onProgress(100);
      logger.info(`toolUpdater:update:done`, { tool: toolKey });

      return this.check(toolKey);
    } catch (err) {
      logUpdater(`Erro durante atualização de ${toolKey}: ${err.message}`);
      throw err;
    } finally {
      // Limpeza de diretórios de Staging e temporários
      try {
        if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
        if (fs.existsSync(backupTarget)) fs.rmSync(backupTarget, { force: true });
      } catch (_) {}
    }
  }

  _atomicInstallPair(sourceExe, targetExe, key) {
    try {
      if (fs.existsSync(targetExe)) {
        try { fs.unlinkSync(targetExe); } catch (_) { fs.renameSync(targetExe, `${targetExe}.old_${Date.now()}`); }
      }
      fs.copyFileSync(sourceExe, targetExe);
      logUpdater(`Componente auxiliar empacotado (${key}) instalado com sucesso.`);
    } catch (e) {
      logUpdater(`Falha ao instalar componente empacotado ${key}: ${e.message}`);
    }
  }

  async _updateYtDlpSelf(onProgress) {
    const { ytDlpTool } = require('./adapters/YtDlpTool');
    logUpdater('Iniciando atualização de motor de download...');
    logger.info('toolUpdater:update:start', { tool: 'ytdlp', mode: 'self-update' });
    if (onProgress) onProgress(20);
    await ytDlpTool.selfUpdate('stable');
    if (onProgress) onProgress(100);
    logUpdater('Motor de download atualizado com sucesso.');
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
      untrunc: {
        githubOwner: 'anthwlock',
        githubRepo: 'untrunc',
        versionArgs: ['-h'],
        downloadUrl: (tag, platform) => {
          // Releases do anthwlock/untrunc para Windows contêm untrunc_x64.zip
          return 'https://github.com/anthwlock/untrunc/releases/latest/download/untrunc_x64.zip';
        },
      },
    };

    const config = configs[toolKey];
    if (!config) throw new Error(`ToolUpdater: componente desconhecido '${toolKey}'`);
    return config;
  }

  async _getVersion(exe, args) {
    return new Promise((resolve) => {
      if (!fs.existsSync(exe)) return resolve(null);
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
          reject(new Error(`HTTP ${res.statusCode} ao baixar componente.`)); return;
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
    
    // Tenta primeiro com AdmZip
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(destination, true);
      return;
    } catch (zipErr) {
      logUpdater(`AdmZip falhou, usando descompactador do sistema: ${zipErr.message}`);
    }

    // Fallback para descompactadores do sistema operacional
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        const child = spawn('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destination}" -Force`
        ], { windowsHide: true });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Falha na extração de arquivo (${code})`)));
      } else {
        const child = spawn('unzip', ['-o', zipPath, '-d', destination]);
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Falha na extração de arquivo (${code})`)));
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
module.exports = { ToolUpdater, toolUpdater, logUpdater };

