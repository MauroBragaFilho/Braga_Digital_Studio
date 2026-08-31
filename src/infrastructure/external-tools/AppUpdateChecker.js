'use strict';

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const logger = require('../../services/logService');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'appUpdate.config.json');

/**
 * AppUpdateChecker — Verifica se existe uma versão mais nova do PRÓPRIO Braga Digital Studio
 * publicada nas GitHub Releases do repositório, comparando com a versão instalada
 * (app.getVersion(), lida do package.json).
 *
 * Não baixa nem instala nada — apenas informa se há uma versão nova e o link da release,
 * para o usuário baixar manualmente (ou, futuramente, plugar um instalador automático).
 *
 * Configuração em src/config/appUpdate.config.json (owner/repo do GitHub, etc.).
 * Isso é separado do "BDS Update Server" (src/infrastructure/external-tools/ManifestClient.js),
 * que atualiza as ferramentas internas (yt-dlp/FFmpeg/...), não o app em si.
 */
class AppUpdateChecker {
  constructor() {
    this._config = null;
  }

  _loadConfig() {
    if (this._config) return this._config;
    // require() cacheia o JSON automaticamente; delete do cache se precisar recarregar em runtime.
    this._config = require(CONFIG_PATH);
    return this._config;
  }

  /**
   * @param {string} currentVersion - Versão instalada atualmente (ex: app.getVersion()).
   * @returns {Promise<{hasUpdate: boolean, currentVersion: string, latestVersion: string|null,
   *                     releaseUrl: string|null, releaseNotes: string|null}>}
   */
  async checkForUpdate(currentVersion) {
    const config = this._loadConfig();

    if (config.provider !== 'github-releases') {
      logger.warn('AppUpdateChecker:provider_not_supported', { provider: config.provider });
      return this._noUpdateResult(currentVersion);
    }

    const { owner, repo, includePrereleases } = config.github || {};
    if (!owner || !repo) {
      logger.warn('AppUpdateChecker:missing_github_config');
      return this._noUpdateResult(currentVersion);
    }

    try {
      const release = includePrereleases
        ? await this._fetchLatestIncludingPrereleases(owner, repo)
        : await this._fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);

      if (!release || !release.tag_name) {
        return this._noUpdateResult(currentVersion);
      }

      const latestVersion = release.tag_name.replace(/^v/i, '');
      const hasUpdate = this._isNewer(latestVersion, currentVersion);

      return {
        hasUpdate,
        currentVersion,
        latestVersion,
        releaseUrl: release.html_url || null,
        releaseNotes: release.body || null,
        installerUrl: this._findInstallerUrl(release) || null,
        installerDigest: this._findInstallerDigest(release) || null,
        release
      };
    } catch (error) {
      logger.error('AppUpdateChecker:check_failed', { error: error.message });
      return this._noUpdateResult(currentVersion);
    }
  }

  /**
   * Localiza o URL de download do instalador (.exe do NSIS) nos assets da release.
   * Prioriza exatamente o nome definido em package.json (artifactName), com fallback
   * para o primeiro asset .exe encontrado.
   * @param {object} release - Objeto de release retornado pela GitHub API.
   * @returns {string|null}
   */
  _findInstallerUrl(release) {
    const assets = (release && Array.isArray(release.assets)) ? release.assets : [];
    if (assets.length === 0) return null;

    const exeAssets = assets.filter((a) => (a.name || '').toLowerCase().endsWith('.exe'));
    if (exeAssets.length === 0) return null;

    // Preferencia exata pelo artifactName do electron-builder.
    const setup = exeAssets.find((a) => /^BragaDigitalStudioSetup\.exe$/i.test(a.name || ''));
    const chosen = setup || exeAssets[0];
    return chosen.browser_download_url || chosen.url || null;
  }

  /**
   * Localiza o digest (SHA-256) do asset do instalador na release.
   * A GitHub API expõe o campo `digest` no formato "sha256:abcdef..." para assets.
   * @param {object} release - Objeto de release retornado pela GitHub API.
   * @returns {string|null} O digest no formato "sha256:..." ou null se não disponível.
   */
  _findInstallerDigest(release) {
    const assets = (release && Array.isArray(release.assets)) ? release.assets : [];
    if (assets.length === 0) return null;

    const exeAssets = assets.filter((a) => (a.name || '').toLowerCase().endsWith('.exe'));
    if (exeAssets.length === 0) return null;

    const setup = exeAssets.find((a) => /^BragaDigitalStudioSetup\.exe$/i.test(a.name || ''));
    const chosen = setup || exeAssets[0];
    return chosen.digest || null;
  }

  /**
   * Retorna o URL do instalador da versão mais recente (se houver).
   * @returns {Promise<string|null>}
   */
  async getLatestInstallerUrl() {
    const config = this._loadConfig();
    const { owner, repo, includePrereleases } = config.github || {};
    if (!owner || !repo) return null;
    try {
      const release = includePrereleases
        ? await this._fetchLatestIncludingPrereleases(owner, repo)
        : await this._fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
      return this._findInstallerUrl(release);
    } catch (error) {
      logger.error('AppUpdateChecker:getLatestInstallerUrl:error', { error: error.message });
      return null;
    }
  }

  /**
   * Baixa o instalador da versão mais recente para destPath.
   * Se expectedDigest for fornecido (ex: "sha256:abcdef..."), verifica a integridade
   * do arquivo após o download; lança erro se não corresponder.
   * @param {string} destPath - Caminho de destino (_setup.exe).
   * @param {(received:number, total:number)=>void} [onProgress] - Callback de progresso em bytes.
   * @param {string} [expectedDigest] - Digest esperado no formato "sha256:abcdef..." (opcional).
   * @returns {Promise<{path: string, size: number}>}
   */
  async downloadLatestInstaller(destPath, onProgress, expectedDigest) {
    const url = await this.getLatestInstallerUrl();
    if (!url) {
      throw new Error('Nenhum instalador (.exe) encontrado na release mais recente.');
    }
    const result = await this._downloadFile(url, destPath, onProgress);

    // Verificação de integridade SHA-256 (quando digest disponível).
    if (expectedDigest) {
      const valid = this._verifyFileDigest(result.path, expectedDigest);
      if (!valid) {
        try { fs.rmSync(result.path, { force: true }); } catch (_) { /* noop */ }
        throw new Error('Integridade do instalador verificada com falha (SHA-256 não corresponde). O arquivo foi removido por segurança.');
      }
    }

    return result;
  }

  /**
   * Executa o instalador NSIS em modo silencioso (/S). Se o destino exigir elevação
   * (ex: Program Files), o Windows exibirá um único prompt UAC — a UI do instalador
   * não é mostrada.
   * @param {string} installerPath - Caminho do instalador .exe baixado.
   * @param {object} [opts={}] { args?: string[], timeoutMs?: number }
   * @returns {Promise<{success: boolean, exitCode: number|null, timedOut: boolean}>}
   */
  installSilently(installerPath, opts = {}) {
    const args = opts.args || ['/S'];
    const timeoutMs = opts.timeoutMs || 180000;

    return new Promise((resolve) => {
      logger.info('AppUpdateChecker:installSilently:start', { installerPath, args });
      let child;
      try {
        child = spawn(installerPath, args, { windowsHide: true, detached: false });
      } catch (err) {
        logger.error('AppUpdateChecker:installSilently:spawn_error', { error: err.message });
        return resolve({ success: false, exitCode: null, timedOut: false });
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch (_) { /* noop */ }
        logger.warn('AppUpdateChecker:installSilently:timeout');
        resolve({ success: false, exitCode: null, timedOut: true });
      }, timeoutMs);

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logger.error('AppUpdateChecker:installSilently:process_error', { error: err.message });
        resolve({ success: false, exitCode: null, timedOut: false });
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const success = code === 0;
        logger.info('AppUpdateChecker:installSilently:close', { exitCode: code, success });
        resolve({ success, exitCode: code, timedOut: false });
      });
    });
  }

  async _fetchLatestIncludingPrereleases(owner, repo) {
    const releases = await this._fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases`);
    return Array.isArray(releases) ? releases[0] : null;
  }

  /**
   * Baixa um arquivo da internet para dest, seguindo redirects e reportando progresso.
   * @returns {Promise<{path: string, size: number}>}
   */
  _downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      let received = 0;
      let total = 0;

      const cleanup = () => {
        try { file.close(); } catch (_) { /* noop */ }
        try { fs.rmSync(dest, { force: true }); } catch (_) { /* noop */ }
      };

      const doGet = (targetUrl) => {
        const client = targetUrl.startsWith('http://') ? http : https;
        const req = client.get(targetUrl, { headers: { 'User-Agent': 'BDS-AppUpdateChecker' }, timeout: 30000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            file.close();
            fs.rmSync(dest, { force: true });
            return doGet(res.headers.location);
          }
          if (res.statusCode !== 200) {
            res.resume();
            cleanup();
            return reject(new Error(`HTTP ${res.statusCode} ao baixar instalador.`));
          }
          total = parseInt(res.headers['content-length'] || '0', 10);
          received = 0;
          res.on('data', (chunk) => {
            received += chunk.length;
            if (onProgress) onProgress(received, total);
          });
          res.pipe(file);
        });

        req.on('timeout', () => req.destroy(new Error('Timeout ao baixar instalador.')));
        req.on('error', (err) => { cleanup(); reject(err); });
      };

      file.on('finish', () => {
        file.close(() => resolve({ path: dest, size: received }));
      });
      file.on('error', (err) => { cleanup(); reject(err); });

      doGet(url);
    });
  }

  /**
   * Verifica a integridade de um arquivo calculando seu SHA-256 e comparando com o digest
   * esperado. Formato do digest: "sha256:abcdef..." (conforme GitHub API).
   * @param {string} filePath - Caminho do arquivo a verificar.
   * @param {string} expectedDigest - Digest esperado (ex: "sha256:e3b0c44298fc...").
   * @returns {boolean} true se o digest corresponder, false caso contrário.
   */
  _verifyFileDigest(filePath, expectedDigest) {
    try {
      const [algorithm, expectedHash] = expectedDigest.split(':');
      if (!algorithm || !expectedHash) {
        logger.warn('AppUpdateChecker:verifyDigest:invalid_format', { expectedDigest });
        return false;
      }
      const data = fs.readFileSync(filePath);
      const actualHash = createHash(algorithm).update(data).digest('hex');
      const match = actualHash.toLowerCase() === expectedHash.toLowerCase();
      if (!match) {
        logger.error('AppUpdateChecker:verifyDigest:mismatch', { algorithm, expectedHash, actualHash });
      }
      return match;
    } catch (err) {
      logger.error('AppUpdateChecker:verifyDigest:error', { error: err.message });
      return false;
    }
  }

  /** Comparação simples de versionamento semântico (major.minor.patch). */
  _isNewer(latest, current) {
    const a = String(latest).split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(current).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const diff = (a[i] || 0) - (b[i] || 0);
      if (diff > 0) return true;
      if (diff < 0) return false;
    }
    return false;
  }

  _noUpdateResult(currentVersion) {
    return { hasUpdate: false, currentVersion, latestVersion: null, releaseUrl: null, releaseNotes: null, installerUrl: null, installerDigest: null };
  }

  _fetchJson(urlString) {
    return new Promise((resolve, reject) => {
      const req = https.get(
        urlString,
        { headers: { 'User-Agent': 'BDS-AppUpdateChecker' }, timeout: 8000 },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return this._fetchJson(res.headers.location).then(resolve, reject);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`GitHub API respondeu com status ${res.statusCode} para ${urlString}`));
          }

          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(raw));
            } catch (err) {
              reject(new Error(`Resposta inválida (não é JSON) da GitHub API: ${err.message}`));
            }
          });
        }
      );

      req.on('timeout', () => req.destroy(new Error(`Timeout ao consultar GitHub API (${urlString})`)));
      req.on('error', reject);
    });
  }
}

const appUpdateChecker = new AppUpdateChecker();

module.exports = { AppUpdateChecker, appUpdateChecker };
