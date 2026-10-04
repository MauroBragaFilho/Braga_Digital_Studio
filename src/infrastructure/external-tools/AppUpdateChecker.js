'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const logger = require('../../services/logService');
const { downloadFile, fetchJson } = require('../../core/modules/FileDownloader');
const { processRunner } = require('./ProcessRunner');

/** Algoritmos de digest aceitos (md5/sha1 são fracos demais para validar um instalador). */
const SUPPORTED_DIGESTS = new Set(['sha256', 'sha384', 'sha512']);

/** URL sem query string/fragmento (a query pode carregar tokens): só para logs. */
function safeUrl(u) {
  try { const p = new URL(u); return `${p.protocol}//${p.host}${p.pathname}`; } catch (_) { return '(url inválida)'; }
}

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

    const { owner, repo } = config.github || {};
    if (!owner || !repo) {
      logger.warn('AppUpdateChecker:missing_github_config');
      return this._noUpdateResult(currentVersion);
    }

    try {
      const release = await this._getLatestRelease();

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
        // Instalação silenciosa só no Windows (.exe do NSIS). Em outros sistemas o instalador NÃO é oferecido:
        // `platformAsset` informa o arquivo certo (deb/AppImage) para o usuário baixar pela página da release.
        installerUrl: process.platform === 'win32' ? (this._findInstallerUrl(release) || null) : null,
        installerDigest: process.platform === 'win32' ? (this._findInstallerDigest(release) || null) : null,
        platformAsset: this._findPlatformAsset(release, process.platform),
        release
      };
    } catch (error) {
      logger.error('AppUpdateChecker:check_failed', { error: error.message });
      // Falha de rede/limite da API: não é "já está atualizado" (RK-069)
      return { ...this._noUpdateResult(currentVersion), checkFailed: true, error: error.message };
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
   * Escolhe o asset da release para o sistema operacional atual, SÓ para informar (RK-076):
   *  - win32: instalador .exe (kind 'installer'; é o único que o app baixa e executa, com digest obrigatório);
   *  - linux: .AppImage (se o app roda como AppImage) ou .deb (kind 'manual': nada é baixado nem instalado em silêncio);
   *  - demais (macOS): nenhum asset (a release não publica pacote para esse sistema).
   * @returns {{kind:'installer'|'manual', name:string, url:string|null, digest:string|null}|null}
   */
  _findPlatformAsset(release, platform = process.platform) {
    const assets = (release && Array.isArray(release.assets)) ? release.assets : [];
    const pick = (re) => assets.find((a) => re.test(a.name || ''));
    let asset = null;
    let kind = 'manual';
    if (platform === 'win32') {
      asset = pick(/^BragaDigitalStudioSetup.exe$/i) || pick(/.exe$/i);
      kind = 'installer';
    } else if (platform === 'linux') {
      const preferAppImage = Boolean(process.env.APPIMAGE);
      const appImage = pick(/.AppImage$/i);
      const deb = pick(/.deb$/i);
      asset = preferAppImage ? (appImage || deb) : (deb || appImage);
    }
    if (!asset) return null;
    return { kind, name: asset.name, url: asset.browser_download_url || asset.url || null, digest: asset.digest || null };
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

  /** Release mais recente conforme appUpdate.config.json (ou null se não configurada). */
  async _getLatestRelease() {
    const { owner, repo, includePrereleases } = this._loadConfig().github || {};
    if (!owner || !repo) return null;
    return includePrereleases
      ? await this._fetchLatestIncludingPrereleases(owner, repo)
      : await this._fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
  }

  /**
   * Retorna o URL do instalador da versão mais recente (se houver).
   * @returns {Promise<string|null>}
   */
  async getLatestInstallerUrl() {
    try {
      return this._findInstallerUrl(await this._getLatestRelease());
    } catch (error) {
      logger.error('AppUpdateChecker:getLatestInstallerUrl:error', { error: error.message });
      return null;
    }
  }

  /**
   * Baixa o instalador da versão mais recente para destPath e confere o SHA-256.
   *
   * O URL e o digest precisam vir da MESMA release. Quem já consultou a release (checkForUpdate)
   * deve passar `installerUrl` e `expectedDigest` — assim, uma release publicada entre a consulta
   * e o download não faz o digest de uma versão ser comparado com o arquivo de outra. Sem
   * `installerUrl`, a release é consultada aqui uma única vez e URL e digest saem dela.
   *
   * @param {string} destPath - Caminho de destino (_setup.exe).
   * @param {(received:number, total:number)=>void} [onProgress] - Callback de progresso em bytes.
   * @param {string|null} [expectedDigest] - Digest "sha256:abcdef..." (opcional; ver acima).
   * @param {string|null} [installerUrl] - URL do instalador da release já consultada (opcional).
   * @returns {Promise<{path: string, size: number, sha256: string}>}
   */
  async downloadLatestInstaller(destPath, onProgress, expectedDigest = null, installerUrl = null) {
    // Nunca baixa um instalador de outro sistema (RK-076): o único empacotado para instalação automática é o .exe.
    if (process.platform !== 'win32') {
      throw new Error('A atualização automática do aplicativo está disponível só no Windows. Baixe o pacote do seu sistema (.deb ou .AppImage) pela página de releases.');
    }
    let url = installerUrl || null;
    let digest = expectedDigest || null;

    if (!url) {
      const release = await this._getLatestRelease();
      url = this._findInstallerUrl(release);
      if (!digest) digest = this._findInstallerDigest(release);
    }
    if (!url) {
      throw new Error('Nenhum instalador (.exe) encontrado na release mais recente.');
    }

    const result = await this._downloadFile(url, destPath, onProgress);

    if (digest) {
      const check = await this._checkDigest(result, digest);
      if (!check.ok) {
        try { fs.rmSync(result.path, { force: true }); } catch (_) { /* noop */ }
        if (check.invalid) {
          throw new Error(
            'Integridade do instalador não pôde ser verificada: o código de verificação publicado na release não é de um tipo compatível. ' +
            'O arquivo foi removido por segurança. Baixe o instalador manualmente pela página da release.'
          );
        }
        throw new Error(
          'A verificação de integridade do instalador falhou: o arquivo baixado é diferente do publicado na release. ' +
          'O arquivo foi removido por segurança. Tente novamente; se persistir, baixe o instalador manualmente pela página da release.'
        );
      }
      result.verified = true;
    } else {
      // Decisão do responsável: enquanto o instalador não tem assinatura (Authenticode), uma release sem digest
      // ainda pode ser instalada. O chamador é avisado via `verified:false` (updateService expõe digestVerified).
      // Quando a release publica o SHA-256, ele continua sendo conferido (bloco acima).
      result.verified = false;
      logger.warn('AppUpdateChecker:download:no_digest', { url: safeUrl(url) });
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
      // Não registra o caminho completo (contém o diretório do usuário) nem os argumentos.
      logger.info('AppUpdateChecker:installSilently:start', { installer: path.basename(String(installerPath)), argCount: args.length });
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
        // Mata a árvore inteira (o instalador NSIS pode ter filhos) e só então resolve.
        processRunner.cancel(child).then(() => {
          logger.warn('AppUpdateChecker:installSilently:timeout');
          resolve({ success: false, exitCode: null, timedOut: true });
        });
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
   * Baixa um arquivo para dest via FileDownloader (redirecionamentos absolutos/relativos, máx. 5,
   * https->http bloqueado, SHA-256 calculado durante o download, tamanho conferido). Rejeita —
   * sem deixar arquivo parcial — em: HTTP != 200, laço de redirecionamento, timeout, conexão
   * encerrada antes do fim e tamanho diferente do Content-Length.
   * Instaladores não retomam parciais de execuções anteriores (poderiam ser de outra versão).
   * @returns {Promise<{path: string, size: number, sha256: string}>}
   */
  async _downloadFile(url, dest, onProgress) {
    try { fs.rmSync(`${dest}.part`, { force: true }); } catch (_) { /* noop */ }
    try {
      return await downloadFile({
        url,
        dest,
        userAgent: 'BDS-AppUpdateChecker',
        attempts: 2,
        backoffMs: 500,
        onProgress: onProgress ? (p) => onProgress(p.receivedBytes, p.totalBytes) : null
      });
    } catch (err) {
      try { fs.rmSync(`${dest}.part`, { force: true }); } catch (_) { /* noop */ }
      try { fs.rmSync(dest, { force: true }); } catch (_) { /* noop */ }
      throw err;
    }
  }

  /**
   * Confere o digest "algoritmo:hex" publicado pela release. Para sha256 usa o hash já
   * calculado durante o download; sha384/sha512 são calculados lendo o arquivo em fluxo.
   *
   * Formato inválido ou algoritmo desconhecido/fraco => ok:false com `invalid:true` (o chamador
   * rejeita o instalador). A ausência total de digest é tratada fora daqui (ver
   * downloadLatestInstaller: `verified:false`).
   * @returns {Promise<{ok: boolean, invalid?: boolean, expected: string, actual: string}>}
   */
  async _checkDigest(result, expectedDigest) {
    const raw = String(expectedDigest || '');
    const sep = raw.indexOf(':');
    const algorithm = sep > 0 ? raw.slice(0, sep).trim().toLowerCase() : '';
    const expectedHash = sep > 0 ? raw.slice(sep + 1).trim() : '';
    if (!algorithm || !/^[0-9a-fA-F]+$/.test(expectedHash) || !SUPPORTED_DIGESTS.has(algorithm)) {
      logger.warn('AppUpdateChecker:verifyDigest:invalid_format', { algorithm: algorithm || null });
      return { ok: false, invalid: true, expected: '', actual: '' };
    }
    let actual;
    try {
      actual = algorithm === 'sha256' ? result.sha256 : await this._hashFile(result.path, algorithm);
    } catch (err) {
      logger.error('AppUpdateChecker:verifyDigest:error', { error: err.message });
      return { ok: false, expected: expectedHash, actual: 'indisponível' };
    }
    const ok = actual.toLowerCase() === expectedHash.toLowerCase();
    if (!ok) logger.error('AppUpdateChecker:verifyDigest:mismatch', { algorithm, expectedHash, actualHash: actual });
    return { ok, expected: expectedHash, actual };
  }

  /** Hash de um arquivo lido em fluxo (não carrega o arquivo inteiro na memória). */
  _hashFile(filePath, algorithm) {
    return new Promise((resolve, reject) => {
      const hash = createHash(algorithm);
      fs.createReadStream(filePath)
        .on('data', (chunk) => hash.update(chunk))
        .on('error', reject)
        .on('end', () => resolve(hash.digest('hex')));
    });
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

  /** GET de JSON (GitHub API) via FileDownloader.fetchJson: redirecionamentos limitados, https->http bloqueado. */
  _fetchJson(urlString) {
    return fetchJson(urlString, { timeoutMs: 8000, userAgent: 'BDS-AppUpdateChecker' });
  }
}

const appUpdateChecker = new AppUpdateChecker();

module.exports = { AppUpdateChecker, appUpdateChecker };
