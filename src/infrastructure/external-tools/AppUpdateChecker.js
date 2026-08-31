'use strict';

const https = require('node:https');
const path = require('node:path');
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
        releaseNotes: release.body || null
      };
    } catch (error) {
      logger.error('AppUpdateChecker:check_failed', { error: error.message });
      return this._noUpdateResult(currentVersion);
    }
  }

  async _fetchLatestIncludingPrereleases(owner, repo) {
    const releases = await this._fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases`);
    return Array.isArray(releases) ? releases[0] : null;
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
    return { hasUpdate: false, currentVersion, latestVersion: null, releaseUrl: null, releaseNotes: null };
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
