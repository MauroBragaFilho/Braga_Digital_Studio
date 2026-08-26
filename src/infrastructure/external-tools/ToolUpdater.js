'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { getExecutableName, resolveCanonicalToolKey } = require('./ToolManifest');
const { toolResolver } = require('./ToolResolver');
const logger = require('../../services/logService');

const BACKUPS_DIRNAME = '.component-backups';
const MANIFEST_DIRNAME = '.component-manifests';

/**
 * Registra eventos específicos do atualizador em logs/updater.log
 */
function logUpdater(message, data = null) {
  try {
    const logsDir = process.env.BMD_LOGS_DIR || path.join(process.cwd(), 'logs');
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
    this._backupsDir = path.join(toolsDir, BACKUPS_DIRNAME);
    this._manifestDir = path.join(toolsDir, MANIFEST_DIRNAME);
    try { fs.mkdirSync(this._backupsDir, { recursive: true }); } catch (_) {}
    try { fs.mkdirSync(this._manifestDir, { recursive: true }); } catch (_) {}
  }

  /**
   * Calcula o hash SHA-256 de um arquivo (usado para verificação de integridade e detecção
   * de corrupção após cópia/download).
   */
  _computeSha256(filePath) {
    const hash = crypto.createHash('sha256');
    const data = fs.readFileSync(filePath);
    hash.update(data);
    return hash.digest('hex');
  }

  _manifestPath(toolKey) {
    return path.join(this._manifestDir, `${toolKey}.json`);
  }

  _readManifest(toolKey) {
    try {
      const raw = fs.readFileSync(this._manifestPath(toolKey), 'utf8');
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  _writeManifest(toolKey, data) {
    try {
      fs.writeFileSync(this._manifestPath(toolKey), JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      logUpdater(`Aviso: falha ao gravar manifesto de ${toolKey}: ${err.message}`);
    }
  }

  _backupPathFor(toolKey, exeName) {
    return path.join(this._backupsDir, toolKey, exeName);
  }

  /**
   * Persiste a versão instalada atualmente como "última versão estável conhecida",
   * sobrescrevendo o backup anterior. Chamado somente após uma atualização validada com sucesso.
   */
  _persistBackup(toolKey, exeName, sourcePath, version, sha256) {
    try {
      const dir = path.join(this._backupsDir, toolKey);
      fs.mkdirSync(dir, { recursive: true });
      const dest = this._backupPathFor(toolKey, exeName);
      fs.copyFileSync(sourcePath, dest);
      const sidecar = path.join(dir, '.info.json');
      fs.writeFileSync(sidecar, JSON.stringify({ version, sha256, savedAt: new Date().toISOString() }, null, 2), 'utf8');
      logUpdater(`Backup de rollback atualizado para ${toolKey} (versão ${version}).`);
    } catch (err) {
      logUpdater(`Aviso: falha ao persistir backup de rollback de ${toolKey}: ${err.message}`);
    }
  }

  _hasPersistedBackup(toolKey, exeName) {
    return fs.existsSync(this._backupPathFor(toolKey, exeName));
  }

  /**
   * Restaura manualmente a última versão estável conhecida de um componente.
   * Pode ser chamado após uma atualização automática (rollback de falha) ou sob demanda
   * pelo usuário/administrador caso uma versão recém-atualizada apresente problemas.
   */
  async rollback(rawToolKey) {
    const toolKey = resolveCanonicalToolKey(rawToolKey);
    const exeName = getExecutableName(toolKey);
    const backupPath = this._backupPathFor(toolKey, exeName);
    const target = path.join(this._toolsDir, exeName);

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Não há uma versão anterior salva para reverter (${toolKey}).`);
    }

    logUpdater(`Iniciando rollback manual de ${toolKey}...`);
    try {
      if (fs.existsSync(target)) {
        try { fs.unlinkSync(target); } catch (_) { fs.renameSync(target, `${target}.old_${Date.now()}`); }
      }
      fs.copyFileSync(backupPath, target);
      const info = this._readBackupInfo(toolKey);
      logUpdater(`Rollback de ${toolKey} concluído com sucesso.`, info);
      return { success: true, tool: toolKey, restoredVersion: info?.version || null };
    } catch (err) {
      logUpdater(`Falha crítica no rollback manual de ${toolKey}: ${err.message}`);
      throw new Error(`Não foi possível reverter ${toolKey}: ${err.message}`);
    }
  }

  _readBackupInfo(toolKey) {
    try {
      const sidecar = path.join(this._backupsDir, toolKey, '.info.json');
      return JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  /**
   * Verifica um componente contra uma entrada do manifest.json do Update Server, comparando
   * pelo SHA-256 já persistido localmente (mais confiável que comparar apenas strings de
   * versão, e não depende de rodar o executável para extrair versão).
   * @param {string} rawToolKey
   * @param {object} manifestEntry - { version, sha256, url }
   */
  checkAgainstManifest(rawToolKey, manifestEntry) {
    const toolKey = resolveCanonicalToolKey(rawToolKey);
    const exeName = getExecutableName(toolKey);
    const target = path.join(this._toolsDir, exeName);
    const isInstalled = fs.existsSync(target);
    const localManifest = this._readManifest(toolKey);

    const installedSha256 = isInstalled ? this._computeSha256(target) : null;
    const needsUpdate = !isInstalled || !manifestEntry?.sha256 || installedSha256 !== manifestEntry.sha256;

    return {
      tool: toolKey,
      installed: localManifest?.version || (isInstalled ? '(desconhecida)' : null),
      latest: manifestEntry?.version || null,
      needsUpdate,
      canUpdate: true,
      hasBackup: this._hasPersistedBackup(toolKey, exeName),
      source: 'update-server',
    };
  }

  async check(rawToolKey) {
    const toolKey = resolveCanonicalToolKey(rawToolKey);
    const config = this._getConfig(toolKey);
    const exe = toolResolver.resolve(toolKey, this._toolsDir, { mustExist: false });
    const isInstalled = fs.existsSync(exe);
    const installed = isInstalled ? await this._getVersion(exe, config.versionArgs) : null;
    const latest = await this._fetchLatestTag(config.githubOwner, config.githubRepo).catch(() => null);
    const exeName = getExecutableName(toolKey);
    return {
      tool: toolKey,
      installed,
      latest,
      needsUpdate: !installed || (latest ? !installed.includes(latest.replace(/^v/, '')) : false),
      canUpdate: true,
      hasBackup: this._hasPersistedBackup(toolKey, exeName),
    };
  }

  /**
   * Executa atualização atômica de um componente interno com staging, smoke-test e rollback,
   * a partir de uma release do GitHub.
   */
  async update(rawToolKey, onProgress) {
    const toolKey = resolveCanonicalToolKey(rawToolKey);

    if (toolKey === 'ytdlp') {
      return this._updateYtDlpSelf(onProgress);
    }

    if (toolKey === 'rawrecoveryengine') {
      throw new Error('Este componente exige instalação manual: copie o RawRecoveryEngine.exe para a pasta de ferramentas do BDS.');
    }

    const config = this._getConfig(toolKey);
    const exeName = getExecutableName(toolKey);

    logUpdater(`Iniciando atualização de componente: ${toolKey}`);
    logger.info(`toolUpdater:update:start`, { tool: toolKey });

    if (onProgress) onProgress(5);

    // Obter release mais recente (tag + lista de assets, para checksum quando disponível)
    const release = await this._fetchLatestRelease(config.githubOwner, config.githubRepo);
    const latestTag = release.tag_name || release.name;
    const downloadUrl = config.downloadUrl(latestTag, process.platform);
    const isZip = downloadUrl.endsWith('.zip') || downloadUrl.includes('.zip');
    const expectedDigest = this._findAssetDigest(release, downloadUrl);

    const result = await this._stagedInstall({
      toolKey, exeName, downloadUrl, isZip,
      expectedSha256: expectedDigest,
      versionLabel: latestTag,
      versionArgs: config.versionArgs,
      onProgress,
    });

    logger.info(`toolUpdater:update:done`, { tool: toolKey });
    return result;
  }

  /**
   * Atualiza um componente a partir de um Update Server central (manifest.json),
   * reaproveitando o mesmo pipeline de staging/checksum/backup/rollback.
   * @param {string} rawToolKey
   * @param {object} manifestEntry - { version, sha256, url, isZip? }
   * @param {Function} [onProgress]
   */
  async updateFromManifest(rawToolKey, manifestEntry, onProgress) {
    const toolKey = resolveCanonicalToolKey(rawToolKey);
    const exeName = getExecutableName(toolKey);

    if (!manifestEntry || !manifestEntry.url || !manifestEntry.sha256) {
      throw new Error(`Manifesto do Update Server incompleto para o componente '${toolKey}' (faltam url/sha256).`);
    }

    logUpdater(`Iniciando atualização via Update Server: ${toolKey}`, { version: manifestEntry.version });
    logger.info('toolUpdater:updateFromManifest:start', { tool: toolKey, version: manifestEntry.version });

    const versionArgs = this._getConfig(toolKey, { optional: true })?.versionArgs || this._getManifestOnlyVersionArgs(toolKey);

    const result = await this._stagedInstall({
      toolKey, exeName,
      downloadUrl: manifestEntry.url,
      isZip: Boolean(manifestEntry.isZip) || manifestEntry.url.endsWith('.zip'),
      expectedSha256: manifestEntry.sha256,
      versionLabel: manifestEntry.version,
      versionArgs,
      onProgress,
      source: 'update-server',
    });

    logger.info('toolUpdater:updateFromManifest:done', { tool: toolKey });
    return result;
  }

  /**
   * Núcleo compartilhado de instalação atômica: download -> checksum -> staging ->
   * smoke-test -> backup temporário -> swap -> validação pós-cópia -> backup persistente
   * + manifesto. Usado tanto pelo fluxo GitHub (`update`) quanto pelo Update Server
   * (`updateFromManifest`).
   */
  async _stagedInstall({ toolKey, exeName, downloadUrl, isZip, expectedSha256, versionLabel, versionArgs, onProgress, source = 'github' }) {
    const target = path.join(this._toolsDir, exeName);
    const stagingDir = path.join(this._toolsDir, `.staging_${toolKey}_${Date.now()}`);
    const preSwapBackup = path.join(this._toolsDir, `.preswap_${exeName}_${Date.now()}`);
    fs.mkdirSync(stagingDir, { recursive: true });

    const downloadDest = path.join(stagingDir, isZip ? `${toolKey}_download.zip` : exeName);

    if (onProgress) onProgress(15);

    try {
      // 1. Download para Staging
      await this._downloadFile(downloadUrl, downloadDest, (bytesReceived, totalBytes) => {
        if (onProgress && totalBytes > 0) {
          onProgress(15 + Math.round((bytesReceived / totalBytes) * 55));
        }
      });

      // 2. Verificação de checksum (SHA-256)
      if (expectedSha256) {
        const gotDigest = this._computeSha256(downloadDest);
        if (gotDigest.toLowerCase() !== expectedSha256.toLowerCase()) {
          throw new Error(`Falha de integridade: checksum do download não confere para ${exeName} (esperado ${expectedSha256.slice(0, 12)}..., obtido ${gotDigest.slice(0, 12)}...).`);
        }
        logUpdater(`Checksum verificado com sucesso para ${toolKey}.`, { sha256: gotDigest, source });
      } else {
        logUpdater(`Aviso: fonte de ${toolKey} (${source}) não publica checksum do asset; integridade do download não verificada por hash.`);
      }

      if (onProgress) onProgress(72);

      let stagedExe = downloadDest;

      // 3. Se for ZIP, extrair para staging e localizar o executável
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

      if (onProgress) onProgress(82);

      // Garante bit de execução em POSIX antes de qualquer tentativa de rodar o binário staged.
      if (process.platform !== 'win32') {
        try { fs.chmodSync(stagedExe, 0o755); } catch (_) {}
      }

      // 4. Smoke-Test (Validação de Execução no arquivo em Staging, antes de qualquer substituição)
      const testVersion = await this._getVersion(stagedExe, versionArgs);
      if (!testVersion && versionArgs.length > 0) {
        logUpdater(`Aviso de validação: smoke-test retornou vazio para ${stagedExe}`);
      }
      const stagedSha256 = this._computeSha256(stagedExe);

      // 5. Backup temporário da versão atual instalada (para rollback imediato em caso de falha na troca)
      if (fs.existsSync(target)) {
        try {
          fs.copyFileSync(target, preSwapBackup);
        } catch (bkErr) {
          logUpdater(`Aviso ao criar backup temporário de ${exeName}: ${bkErr.message}`);
        }
      }

      // 6. Substituição Atômica
      try {
        if (fs.existsSync(target)) {
          try {
            fs.unlinkSync(target);
          } catch (_) {
            fs.renameSync(target, `${target}.old_${Date.now()}`);
          }
        }
        fs.copyFileSync(stagedExe, target);
        // Em plataformas POSIX (Linux/Mac), o bit de execução não é preservado de forma
        // confiável em todo download/cópia — garantimos explicitamente aqui.
        if (process.platform !== 'win32') {
          try { fs.chmodSync(target, 0o755); } catch (_) {}
        }
      } catch (swapErr) {
        logUpdater(`Falha na substituição de ${exeName}, iniciando rollback...`, { error: swapErr.message });
        this._restorePreSwap(preSwapBackup, target);
        throw new Error(`Não foi possível instalar o componente ${exeName}: ${swapErr.message}`);
      }

      if (onProgress) onProgress(92);

      // 7. Validação pós-instalação: confirma que a cópia final não foi corrompida e que o
      //    executável instalado (não apenas o staged) realmente executa.
      const installedSha256 = this._computeSha256(target);
      const postSwapVersion = await this._getVersion(target, versionArgs);
      const copyIntact = installedSha256 === stagedSha256;
      const executes = versionArgs.length === 0 || Boolean(postSwapVersion);

      if (!copyIntact || !executes) {
        logUpdater(`Validação pós-instalação falhou para ${toolKey} (copyIntact=${copyIntact}, executes=${executes}). Revertendo...`);
        this._restorePreSwap(preSwapBackup, target);
        throw new Error(`A instalação de ${exeName} falhou na validação pós-cópia. A versão anterior foi restaurada automaticamente.`);
      }

      logUpdater(`Componente ${toolKey} atualizado e validado com sucesso para versão ${versionLabel} (fonte: ${source}).`);

      // 8. Só agora, com a nova versão validada e funcionando, persistimos o backup de rollback
      //    de longo prazo (substituindo o anterior) e o manifesto de versão/checksum do componente.
      this._persistBackup(toolKey, exeName, target, versionLabel, installedSha256);
      this._writeManifest(toolKey, {
        name: toolKey,
        version: versionLabel,
        platform: process.platform,
        architecture: process.arch,
        sha256: installedSha256,
        source,
        updatedAt: new Date().toISOString(),
      });

      if (onProgress) onProgress(100);

      return {
        tool: toolKey,
        installed: versionLabel,
        latest: versionLabel,
        needsUpdate: false,
        canUpdate: true,
        hasBackup: this._hasPersistedBackup(toolKey, exeName),
        source,
      };
    } catch (err) {
      logUpdater(`Erro durante atualização de ${toolKey}: ${err.message}`);
      throw err;
    } finally {
      // Limpeza de diretórios de Staging e temporários (o backup PERSISTENTE de rollback,
      // em .component-backups, nunca é apagado aqui — só é sobrescrito por uma futura atualização bem-sucedida)
      try {
        if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
        if (fs.existsSync(preSwapBackup)) fs.rmSync(preSwapBackup, { force: true });
      } catch (_) {}
    }
  }

  _restorePreSwap(preSwapBackup, target) {
    if (!fs.existsSync(preSwapBackup)) return;
    try {
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      fs.copyFileSync(preSwapBackup, target);
      logUpdater(`Rollback imediato concluído para ${path.basename(target)}.`);
    } catch (rbErr) {
      logUpdater(`Falha crítica no rollback imediato de ${path.basename(target)}: ${rbErr.message}`);
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

  /**
   * Argumentos de versão para componentes que não têm configuração de release do GitHub
   * (ex: distribuídos via Update Server / manifest.json), usados apenas para o smoke-test
   * pós-instalação.
   */
  _getManifestOnlyVersionArgs(toolKey) {
    const map = {
      rawrecoveryengine: ['version'],
    };
    return map[toolKey] || [];
  }

  _getConfig(toolKey, { optional = false } = {}) {
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
    if (!config) {
      if (optional) return null;
      throw new Error(`ToolUpdater: componente desconhecido '${toolKey}'`);
    }
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
    const data = await this._fetchLatestRelease(owner, repo);
    return data.tag_name || data.name;
  }

  async _fetchLatestRelease(owner, repo) {
    return this._requestJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
  }

  /**
   * Procura o campo `digest` (formato "sha256:<hex>") de um asset de release do GitHub,
   * quando publicado pelo repositório. Retorna apenas o hex, ou null se indisponível.
   */
  _findAssetDigest(release, downloadUrl) {
    try {
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const targetName = downloadUrl.split('/').pop();
      const asset = assets.find(a =>
        a.browser_download_url === downloadUrl || a.name === targetName
      );
      if (asset && typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
        return asset.digest.slice('sha256:'.length);
      }
      return null;
    } catch (_) {
      return null;
    }
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
      const client = url.startsWith('http://') ? http : https;
      const req = client.get(url, { headers: { 'User-Agent': 'BragaDigitalStudio/1.0' } }, (res) => {
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

