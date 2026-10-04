'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { getExecutableName, resolveCanonicalToolKey } = require('./ToolManifest');
const { hasSource, resolveDownloadUrl, unavailableReason, ToolUnavailableError } = require('./ToolSources');
const { toolResolver } = require('./ToolResolver');
const logger = require('../../services/logService');
const { downloadFile, sha256File, fetchJson } = require('../../core/modules/FileDownloader');
const { extractZip, assertSafeEntries, captureOutput } = require('../../core/modules/ZipExtractor');
const { toolRunner } = require('./ToolRunner');
const { processRunner } = require('./ProcessRunner');

const BACKUPS_DIRNAME = '.component-backups';
const MANIFEST_DIRNAME = '.component-manifests';

/**
 * Registra eventos específicos do atualizador no logger central (com redação de dados
 * pessoais, rotação diária e poda), em vez de um updater.log solto sem redação nem rotação.
 */
function logUpdater(message, data = null) {
  try {
    logger.info(`[updater] ${message}`, data && typeof data === 'object' ? data : (data ? { data } : undefined));
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
    // RK-073: resíduos de atualizações interrompidas/antigas (sem bloquear a inicialização).
    this.cleanupStaleResidue().catch(() => {});
  }

  /**
   * Remove da pasta de ferramentas os resíduos de atualizações antigas: `.staging_*`, `.preswap_*` e
   * `*.old_*` (binário em uso renomeado pelo Windows). Ignora os recentes (uma atualização pode estar em curso).
   * Nunca toca em `.component-backups` nem em `.component-manifests`.
   * @param {{ maxAgeMs?: number, now?: number }} [opts]
   * @returns {Promise<string[]>} nomes removidos
   */
  async cleanupStaleResidue({ maxAgeMs = 60 * 60 * 1000, now = Date.now() } = {}) {
    const removed = [];
    if (!this._toolsDir) return removed;
    let entries = [];
    try { entries = await fs.promises.readdir(this._toolsDir); } catch (_) { return removed; }
    for (const name of entries) {
      if (name === BACKUPS_DIRNAME || name === MANIFEST_DIRNAME) continue;
      const isResidue = name.startsWith('.staging_') || name.startsWith('.preswap_') || /\.old_\d+$/.test(name);
      if (!isResidue) continue;
      const full = path.join(this._toolsDir, name);
      try {
        const st = await fs.promises.stat(full);
        if (now - st.mtimeMs < maxAgeMs) continue;
        await fs.promises.rm(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        removed.push(name);
      } catch (_) { /* em uso ou sem permissão: tenta na próxima inicialização */ }
    }
    if (removed.length) logUpdater(`Resíduos de atualização removidos: ${removed.length}.`, { removed });
    return removed;
  }

  /**
   * Calcula o hash SHA-256 de um arquivo em fluxo (usado para verificação de integridade e
   * detecção de corrupção após cópia/download). Não carrega o arquivo inteiro na memória.
   * @returns {Promise<string>}
   */
  _computeSha256(filePath) {
    return sha256File(filePath);
  }

  /**
   * Extrai a versão semver de uma string arbitrária (tag do GitHub, saída de `--version`,
   * nome de release etc.). Tolerante a prefixos ("v1.2.3", "n7.1.1", "latest"), sufixos e
   * texto ao redor ("ffmpeg version 7.1.1-essentials_build"). Retorna null se nenhum
   * padrão de versão for encontrado.
   */
  _extractVersion(str) {
    if (!str) return null;
    const m = String(str).match(/(?:^|[^0-9])([0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?)/);
    return m ? m[1].replace(/^v/, '') : null;
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
      toolResolver.invalidate();
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
  async checkAgainstManifest(rawToolKey, manifestEntry) {
    const toolKey = resolveCanonicalToolKey(rawToolKey);
    const exeName = getExecutableName(toolKey);
    const target = path.join(this._toolsDir, exeName);
    const isInstalled = fs.existsSync(target);
    const localManifest = this._readManifest(toolKey);

    const installedSha256 = isInstalled ? await this._computeSha256(target) : null;
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
    const exeName = getExecutableName(toolKey);
    const isInstalled = fs.existsSync(exe);
    const installed = isInstalled ? await this._getVersion(exe, config.versionArgs) : null;
    const localManifest = this._readManifest(toolKey);

    // Sem fonte oficial para este sistema/arquitetura: não consulta a rede nem oferece instalar (RK-075).
    // Se já houver um binário utilizável (ex.: ffmpeg do sistema no macOS), ele continua valendo.
    if (!hasSource(toolKey, process.platform, process.arch)) {
      return {
        tool: toolKey,
        installed,
        latest: null,
        needsUpdate: false,
        canUpdate: false,
        unavailable: true,
        unavailableReason: unavailableReason(toolKey, process.platform, process.arch),
        hasBackup: this._hasPersistedBackup(toolKey, exeName),
        source: isInstalled ? 'system' : 'none',
      };
    }

    // 1. Se o binário está instalado e o manifesto local informa uma versão, podemos usá-lo
    //    como base confiável para a comparação, evitando depender de parsing frágil da saída
    //    do binário e de tags de release não-semver (ex: BtbN/FFmpeg-Builds publica tag_name
    //    "latest", que nunca casa com a versão instalada e causaria needUpdate permanente).
    const installedNorm = this._extractVersion(installed) || (localManifest?.version ? this._extractVersion(localManifest.version) : null);

    const repoInfo = config.repoResolver
      ? config.repoResolver(process.platform)
      : { owner: config.githubOwner, repo: config.githubRepo, useGitTags: false };

    // Falha de rede / limite da API do GitHub não pode virar "tudo atualizado": é sinalizada em
    // checkFailed para a interface mostrar "não foi possível verificar" (RK-069).
    let checkFailed = false;
    let checkError = null;
    const latest = await (repoInfo.useGitTags
      ? this._fetchLatestGitTagOnly(repoInfo.owner, repoInfo.repo)
      : this._fetchLatestTag(repoInfo.owner, repoInfo.repo)
    ).catch((err) => {
      checkFailed = true;
      checkError = (err && err.message) || 'Falha ao consultar o GitHub.';
      logger.warn('toolUpdater:check:remote_failed', { tool: toolKey, error: checkError });
      return null;
    });

    let needsUpdate = false;
    if (!isInstalled) {
      needsUpdate = true;
    } else if (latest && installedNorm) {
      // Comparação normalizada quando conseguimos extrair versão de ambos.
      const latestNorm = this._extractVersion(latest);
      if (latestNorm) {
        needsUpdate = latestNorm !== installedNorm;
      } else {
        // A release remota não expõe versão semver comparável (ex: BtbN/FFmpeg-Builds usa
        // tag_name "latest", que nunca casa com a versão instalada). Nesse caso não é possível
        // determinar uma atualização real de forma confiável — para não re-baixar a cada ciclo
        // (loop infinito de "atualização disponível"), confiamos no manifesto local: se o
        // binário está instalado e foi persistido com sucesso, consideramos atualizado.
        needsUpdate = !localManifest?.version;
      }
    } else {
      // Sem referência remota utilizável, marca como atualizado para não entrar em loop
      // de re-baixar releases que não expõem versão semver (ex: "latest" do BtbN).
      needsUpdate = false;
    }

    return {
      tool: toolKey,
      installed,
      latest,
      needsUpdate,
      canUpdate: true,
      hasBackup: this._hasPersistedBackup(toolKey, exeName),
      source: 'github',
      ...(checkFailed ? { checkFailed: true, error: checkError } : {}),
    };
  }

  /**
   * Executa atualização atômica de um componente interno com staging, smoke-test e rollback,
   * a partir de uma release do GitHub.
   *
   * Se a fonte não publica checksum, NÃO instala: devolve `{ needsConfirmation: true, reason: 'NO_CHECKSUM' }`.
   * Reexecute com `opts.allowUnverified = true` após confirmação explícita do usuário.
   * @param {string} rawToolKey
   * @param {Function} [onProgress]
   * @param {{ allowUnverified?: boolean }} [opts]
   */
  async update(rawToolKey, onProgress, opts = {}) {
    const toolKey = resolveCanonicalToolKey(rawToolKey);

    // Combinação (sistema, arquitetura) sem fonte oficial: erro explícito, nunca um binário errado.
    if (!hasSource(toolKey, process.platform, process.arch)) {
      throw new ToolUnavailableError(unavailableReason(toolKey, process.platform, process.arch), toolKey);
    }

    // O `-U` do yt-dlp só funciona com o binário já instalado. Na primeira instalação cai no fluxo
    // comum (download do release oficial, com staging, checksum e smoke-test).
    if (toolKey === 'ytdlp') {
      const ytPath = toolResolver.resolve('ytdlp', this._toolsDir, { mustExist: false });
      if (ytPath && fs.existsSync(ytPath)) return this._updateYtDlpSelf(onProgress);
    }

    const config = this._getConfig(toolKey);
    const exeName = getExecutableName(toolKey);

    logUpdater(`Iniciando atualização de componente: ${toolKey}`);
    logger.info(`toolUpdater:update:start`, { tool: toolKey });

    if (onProgress) onProgress(5);

    // Alguns componentes usam um repositório/estratégia de versão diferente dependendo da
    // plataforma (ex: exiftool usa releases do ShareX/ExifTool no Windows, mas o repositório
    // oficial exiftool/exiftool no Linux/macOS, que não usa GitHub Releases — só tags).
    const repoInfo = config.repoResolver
      ? config.repoResolver(process.platform)
      : { owner: config.githubOwner, repo: config.githubRepo, useGitTags: false };

    let latestTag, release = null;
    if (repoInfo.useGitTags) {
      latestTag = await this._fetchLatestGitTagOnly(repoInfo.owner, repoInfo.repo);
    } else {
      release = await this._fetchLatestRelease(repoInfo.owner, repoInfo.repo);
      latestTag = release.tag_name || release.name;
    }

    // Já está na versão publicada? Só pula quando as duas versões são comparáveis e iguais (ou quando a release
    // não expõe versão comparável, ex.: "latest" do BtbN, e o manifesto local confirma a instalação).
    // Comparar só com o manifesto local fazia a atualização ser ignorada mesmo havendo versão nova.
    const localManifest = this._readManifest(toolKey);
    const exePath = toolResolver.resolve(toolKey, this._toolsDir, { mustExist: false });
    if (exePath && fs.existsSync(exePath) && localManifest?.version) {
      const latestNorm = this._extractVersion(latestTag);
      const installedVersion = await this._getVersion(exePath, config.versionArgs);
      const installedNorm = this._extractVersion(installedVersion) || this._extractVersion(localManifest.version);
      const manifestNorm = this._extractVersion(localManifest.version);
      const upToDate = latestNorm
        ? installedNorm === latestNorm
        : Boolean(installedNorm && manifestNorm && installedNorm === manifestNorm);
      if (upToDate) {
        logUpdater(`Componente ja esta atualizado, ignorando atualizacao: ${toolKey} (${localManifest.version})`);
        logger.info('toolUpdater:update:skipped', { tool: toolKey, version: localManifest.version });
        if (onProgress) onProgress(100);
        return { tool: toolKey, skipped: true, version: localManifest.version };
      }
    }

    const downloadUrl = config.downloadUrl(latestTag, process.platform);
    const archiveType = this._detectArchiveType(downloadUrl);
    const expectedDigest = release ? this._findAssetDigest(release, downloadUrl) : null;

    if (!expectedDigest) {
      const reason = repoInfo.useGitTags ? 'download de tag/código-fonte do Git' : 'release sem digest';
      logUpdater(`Fonte de ${toolKey} não publica checksum verificável (${reason}).`);
      if (!opts.allowUnverified) {
        // Não instala em silêncio algo cuja integridade não pode ser verificada: devolve um
        // estado que exige confirmação explícita (reexecutar com { allowUnverified: true }).
        logger.warn('toolUpdater:update:needs_confirmation', { tool: toolKey, reason });
        if (onProgress) onProgress(100);
        return {
          tool: toolKey,
          needsConfirmation: true,
          reason: 'NO_CHECKSUM',
          version: latestTag,
          message: 'A fonte deste componente não publica dados de verificação de integridade, então não é possível conferir o download. Confirme se quiser instalar mesmo assim.'
        };
      }
      logUpdater(`Instalação sem checksum de ${toolKey} confirmada explicitamente (allowUnverified).`);
    }

    const result = await this._stagedInstall({
      toolKey, exeName, downloadUrl, archiveType,
      expectedSha256: expectedDigest,
      versionLabel: latestTag,
      versionArgs: config.versionArgs,
      alternateFileNames: config.alternateFileNames,
      copySiblingFiles: config.copySiblingFiles,
      copySiblingDirs: config.copySiblingDirs,
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
      throw new Error('O servidor de atualizações respondeu com dados incompletos para este componente. Tente novamente mais tarde.');
    }

    logUpdater(`Iniciando atualização via Update Server: ${toolKey}`, { version: manifestEntry.version });
    logger.info('toolUpdater:updateFromManifest:start', { tool: toolKey, version: manifestEntry.version });

    const versionArgs = this._getConfig(toolKey, { optional: true })?.versionArgs || this._getManifestOnlyVersionArgs(toolKey);

    const result = await this._stagedInstall({
      toolKey, exeName,
      downloadUrl: manifestEntry.url,
      archiveType: manifestEntry.isZip ? 'zip' : this._detectArchiveType(manifestEntry.url),
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
  async _stagedInstall({ toolKey, exeName, downloadUrl, archiveType = null, expectedSha256, versionLabel, versionArgs, onProgress, source = 'github', alternateFileNames = [], copySiblingFiles = false, copySiblingDirs = [] }) {
    const target = path.join(this._toolsDir, exeName);
    const stagingDir = path.join(this._toolsDir, `.staging_${toolKey}_${Date.now()}`);
    const preSwapBackup = path.join(this._toolsDir, `.preswap_${exeName}_${Date.now()}`);
    fs.mkdirSync(stagingDir, { recursive: true });

    const isArchive = Boolean(archiveType);
    const downloadDest = path.join(stagingDir, isArchive ? `${toolKey}_download.${archiveType === 'zip' ? 'zip' : 'tar'}` : exeName);

    if (onProgress) onProgress(15);

    try {
      // 1. Download para Staging
      const downloaded = await this._downloadFile(downloadUrl, downloadDest, (bytesReceived, totalBytes) => {
        if (onProgress && totalBytes > 0) {
          onProgress(15 + Math.round((bytesReceived / totalBytes) * 55));
        }
      });

      // 2. Verificação de checksum (SHA-256)
      if (expectedSha256) {
        const gotDigest = downloaded.sha256;
        if (gotDigest.toLowerCase() !== expectedSha256.toLowerCase()) {
          throw new Error('O arquivo baixado não passou na verificação de integridade e foi descartado. Tente novamente; se continuar, verifique sua conexão.');
        }
        logUpdater(`Checksum verificado com sucesso para ${toolKey}.`, { sha256: gotDigest, source });
      } else {
        logUpdater(`Aviso: fonte de ${toolKey} (${source}) não publica checksum do asset; integridade do download não verificada por hash.`);
      }

      if (onProgress) onProgress(72);

      let stagedExe = downloadDest;
      let siblingSourceDir = null;
      let pairMember = null;

      // 3. Se for um arquivo compactado (zip ou tar/.tar.xz/.tar.gz), extrair para staging
      //    e localizar o executável dentro do conteúdo extraído.
      if (isArchive) {
        const extractDir = path.join(stagingDir, 'extracted');
        fs.mkdirSync(extractDir, { recursive: true });

        if (archiveType === 'zip') {
          await this._extractZip(downloadDest, extractDir);
        } else {
          await this._extractTar(downloadDest, extractDir);
        }

        let found = this._findFile(extractDir, exeName);
        if (!found) {
          // Tenta nomes alternativos conhecidos (ex: builds upstream que não renomeiam
          // o executável para o nome esperado pelo BDS).
          for (const altName of alternateFileNames) {
            found = this._findFile(extractDir, altName);
            if (found) {
              logUpdater(`Componente ${toolKey} encontrado com nome alternativo '${altName}' no pacote baixado.`);
              break;
            }
          }
        }
        if (!found) {
          throw new Error(`Componente ${exeName} não foi encontrado no arquivo baixado.`);
        }
        stagedExe = found;

        // Se for ffmpeg/ffprobe e contiver ambos, staging também do par
        if (toolKey === 'ffmpeg' || toolKey === 'ffprobe') {
          const otherKey = toolKey === 'ffmpeg' ? 'ffprobe' : 'ffmpeg';
          const otherExe = getExecutableName(otherKey);
          const otherFound = this._findFile(extractDir, otherExe);
          // RK-074: o par vem no mesmo pacote (um único download); só é instalado depois que o
          // principal passar por toda a validação (ver "7b" abaixo).
          if (otherFound) pairMember = { key: otherKey, exe: otherExe, source: otherFound };
        }

        // Componentes cujo executável depende de DLLs/arquivos irmãos na mesma pasta do zip
        // (ex: untrunc.exe + suas DLLs do FFmpeg estático) — copiados apenas depois que o
        // executável principal passar por toda a validação (ver mais abaixo), para não
        // deixar DLLs órfãs na pasta de ferramentas caso o smoke-test falhe.
        if (copySiblingFiles || copySiblingDirs.length > 0) {
          siblingSourceDir = path.dirname(stagedExe);
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
      const stagedSha256 = await this._computeSha256(stagedExe);

      // 5. Backup temporário da versão atual instalada (para rollback imediato em caso de falha na troca)
      const hadPrevious = fs.existsSync(target);
      const persistedBackup = this._backupPathFor(toolKey, exeName);
      const previousManifest = hadPrevious ? this._readManifest(toolKey) : null;
      if (hadPrevious) {
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
        this._restorePreSwap(preSwapBackup, target, persistedBackup);
        throw new Error(`Não foi possível instalar o componente ${exeName}: ${swapErr.message}`);
      }

      if (onProgress) onProgress(92);

      // 6b. Copia DLLs/subpastas irmãs (ex: untrunc.exe + DLLs, exiftool + lib/ do Perl)
      // ANTES da validação pós-swap abaixo — o executável instalado só consegue rodar de
      // verdade se essas dependências já estiverem presentes na pasta de ferramentas nesse
      // momento (senão o smoke-test seguinte falharia incorretamente e causaria um rollback
      // indevido, mesmo com o executável principal correto).
      if (siblingSourceDir) {
        if (copySiblingFiles) this._copySiblingFiles(siblingSourceDir, stagedExe, this._toolsDir, toolKey);
        for (const dirName of copySiblingDirs) {
          this._copySiblingDir(siblingSourceDir, dirName, this._toolsDir, toolKey);
        }
      }

      // 7. Validação pós-instalação: confirma que a cópia final não foi corrompida e que o
      //    executável instalado (não apenas o staged) realmente executa.
      const installedSha256 = await this._computeSha256(target);
      const postSwapVersion = await this._getVersion(target, versionArgs);
      const copyIntact = installedSha256 === stagedSha256;
      const executes = versionArgs.length === 0 || Boolean(postSwapVersion);

      if (!copyIntact || !executes) {
        logUpdater(`Validação pós-instalação falhou para ${toolKey} (copyIntact=${copyIntact}, executes=${executes}). Revertendo...`);
        this._restorePreSwap(preSwapBackup, target, persistedBackup);
        throw new Error(`A instalação de ${exeName} falhou na validação pós-cópia. ${hadPrevious ? 'A versão anterior foi restaurada automaticamente.' : 'O arquivo inválido foi removido; nada ficou instalado.'}`);
      }

      logUpdater(`Componente ${toolKey} atualizado e validado com sucesso para versão ${versionLabel} (fonte: ${source}).`);

      // 7b. O par do pacote (ffmpeg <-> ffprobe) é instalado, validado e registrado aqui (RK-074).
      if (pairMember) {
        await this._installPairMember(pairMember, { versionLabel, versionArgs, source });
      }

      // 8. Só agora, com a nova versão validada e funcionando, o backup de rollback passa a guardar a
      //    versão ANTERIOR (RK-072: antes guardava a nova, o que dobrava o disco e não revertia nada) e
      //    gravamos o manifesto de versão/checksum do componente.
      this._persistPreviousAsBackup(toolKey, exeName, preSwapBackup, previousManifest);
      toolResolver.invalidate();
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

  /**
   * Guarda como backup de rollback a versão que estava instalada ANTES desta atualização (o arquivo
   * preswap é movido, sem cópia extra). Na primeira instalação não há versão anterior e o backup
   * existente, se houver, é preservado.
   */
  _persistPreviousAsBackup(toolKey, exeName, preSwapBackup, previousManifest) {
    try {
      if (!fs.existsSync(preSwapBackup)) return;
      const dir = path.join(this._backupsDir, toolKey);
      fs.mkdirSync(dir, { recursive: true });
      const dest = this._backupPathFor(toolKey, exeName);
      try { fs.rmSync(dest, { force: true }); } catch (_) {}
      try { fs.renameSync(preSwapBackup, dest); } catch (_) { fs.copyFileSync(preSwapBackup, dest); }
      fs.writeFileSync(path.join(dir, '.info.json'), JSON.stringify({
        version: previousManifest?.version || null,
        sha256: previousManifest?.sha256 || null,
        savedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
      logUpdater(`Backup de rollback de ${toolKey} agora guarda a versão anterior (${previousManifest?.version || 'desconhecida'}).`);
    } catch (err) {
      logUpdater(`Aviso: falha ao guardar a versão anterior de ${toolKey} como backup: ${err.message}`);
    }
  }

  /**
   * Instala o segundo executável de um pacote que traz um par (ffmpeg + ffprobe) com a mesma
   * disciplina do principal: smoke-test do arquivo, backup da versão anterior, restauração/remoção se
   * falhar, manifesto de versão. Falha aqui não derruba o principal (já validado); fica no log.
   */
  async _installPairMember({ key, exe, source: sourceExe }, { versionLabel, versionArgs, source }) {
    const target = path.join(this._toolsDir, exe);
    const preSwap = path.join(this._toolsDir, `.preswap_${exe}_${Date.now()}`);
    const hadPrevious = fs.existsSync(target);
    const previousManifest = hadPrevious ? this._readManifest(key) : null;
    try {
      if (process.platform !== 'win32') { try { fs.chmodSync(sourceExe, 0o755); } catch (_) {} }
      const staged = await this._getVersion(sourceExe, versionArgs);
      if (!staged && versionArgs.length > 0) throw new Error('o executável do pacote não respondeu ao teste de versão.');
      const stagedSha = await this._computeSha256(sourceExe);
      if (hadPrevious) { try { fs.copyFileSync(target, preSwap); } catch (_) {} }
      try {
        if (hadPrevious) { try { fs.unlinkSync(target); } catch (_) { fs.renameSync(target, `${target}.old_${Date.now()}`); } }
        fs.copyFileSync(sourceExe, target);
        if (process.platform !== 'win32') { try { fs.chmodSync(target, 0o755); } catch (_) {} }
      } catch (swapErr) {
        this._restorePreSwap(preSwap, target, this._backupPathFor(key, exe));
        throw swapErr;
      }
      const sha = await this._computeSha256(target);
      const runs = versionArgs.length === 0 || Boolean(await this._getVersion(target, versionArgs));
      if (sha !== stagedSha || !runs) {
        this._restorePreSwap(preSwap, target, this._backupPathFor(key, exe));
        throw new Error('validação pós-cópia falhou.');
      }
      this._persistPreviousAsBackup(key, exe, preSwap, previousManifest);
      toolResolver.invalidate();
      this._writeManifest(key, {
        name: key, version: versionLabel, platform: process.platform, architecture: process.arch,
        sha256: sha, source, updatedAt: new Date().toISOString(),
      });
      logUpdater(`Componente ${key} instalado junto de ${exe === getExecutableName('ffmpeg') ? 'ffprobe' : 'ffmpeg'} (mesmo pacote, um único download).`);
    } catch (err) {
      logUpdater(`Falha ao instalar o par do pacote (${key}): ${err.message}`);
    } finally {
      try { if (fs.existsSync(preSwap)) fs.rmSync(preSwap, { force: true }); } catch (_) {}
    }
  }

  /**
   * Desfaz uma troca que falhou. Com backup (temporário ou o de rollback persistido) restaura o binário
   * anterior; SEM backup, remove o destino — um binário inválido/parcial nunca fica instalado (RK-075).
   */
  _restorePreSwap(preSwapBackup, target, fallbackBackup = null) {
    try {
      const source = fs.existsSync(preSwapBackup) ? preSwapBackup
        : (fallbackBackup && fs.existsSync(fallbackBackup) ? fallbackBackup : null);
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      if (source) {
        fs.copyFileSync(source, target);
        if (process.platform !== 'win32') { try { fs.chmodSync(target, 0o755); } catch (_) {} }
        logUpdater(`Rollback imediato concluído para ${path.basename(target)}.`);
      } else {
        logUpdater(`Instalação inválida de ${path.basename(target)} removida (não havia versão anterior).`);
      }
      toolResolver.invalidate();
    } catch (rbErr) {
      logUpdater(`Falha crítica no rollback imediato de ${path.basename(target)}: ${rbErr.message}`);
    }
  }

  /**
   * Copia recursivamente uma subpasta que fica ao lado do executável dentro do pacote
   * baixado (ex: a pasta `lib/` do Perl que o script `exiftool` precisa para funcionar) para
   * dentro da pasta de ferramentas do BDS. Substitui completamente a versão anterior, se
   * existir, para não misturar arquivos de versões diferentes.
   */
  _copySiblingDir(sourceDir, dirName, toolsDir, toolKey) {
    const src = path.join(sourceDir, dirName);
    const dest = path.join(toolsDir, dirName);
    try {
      if (!fs.existsSync(src)) {
        logUpdater(`Aviso: subpasta '${dirName}' não encontrada no pacote de ${toolKey}, ignorando.`);
        return;
      }
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      fs.cpSync(src, dest, { recursive: true });
      logUpdater(`Subpasta '${dirName}' de ${toolKey} copiada para a pasta de ferramentas.`);
    } catch (err) {
      logUpdater(`Aviso: falha ao copiar subpasta '${dirName}' de ${toolKey}: ${err.message}`);
    }
  }

  _copySiblingFiles(sourceDir, stagedExePath, toolsDir, toolKey) {
    try {
      const exeBaseName = path.basename(stagedExePath).toLowerCase();
      const items = fs.readdirSync(sourceDir, { withFileTypes: true });
      let copied = 0;
      for (const item of items) {
        if (!item.isFile()) continue;
        if (item.name.toLowerCase() === exeBaseName) continue; // o .exe principal já foi instalado via swap atômico
        try {
          fs.copyFileSync(path.join(sourceDir, item.name), path.join(toolsDir, item.name));
          copied++;
        } catch (err) {
          logUpdater(`Aviso: falha ao copiar arquivo auxiliar '${item.name}' de ${toolKey}: ${err.message}`);
        }
      }
      logUpdater(`${copied} arquivo(s) auxiliar(es) de ${toolKey} copiado(s) para a pasta de ferramentas.`);
    } catch (err) {
      logUpdater(`Aviso: falha ao copiar arquivos auxiliares de ${toolKey}: ${err.message}`);
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
    const map = {};
    return map[toolKey] || [];
  }

  _getConfig(toolKey, { optional = false } = {}) {
    const configs = {
      ytdlp: {
        githubOwner: 'yt-dlp',
        githubRepo: 'yt-dlp',
        versionArgs: ['--version'],
      },
      ffmpeg: {
        githubOwner: 'BtbN',
        githubRepo: 'FFmpeg-Builds',
        versionArgs: ['-version'],
      },
      ffprobe: {
        githubOwner: 'BtbN',
        githubRepo: 'FFmpeg-Builds',
        versionArgs: ['-version'],
      },
      spotdl: {
        githubOwner: 'spotDL',
        githubRepo: 'spotify-downloader',
        versionArgs: ['--version'],
      },
      deno: {
        githubOwner: 'denoland',
        githubRepo: 'deno',
        versionArgs: ['--version'],
      },
      untrunc: {
        githubOwner: 'anthwlock',
        githubRepo: 'untrunc',
        versionArgs: ['-h'],
        // O untrunc.exe é vinculado dinamicamente a várias DLLs que ficam na mesma pasta
        // dentro do zip (AVFORMAT-57.DLL, AVUTIL-55.DLL, AVCODEC-57.DLL, SWRESAMPLE-2.DLL,
        // LIBGCC_S_SEH-1.DLL, LIBWINPTHREAD-1.DLL, LIBSTDC++-6.DLL) — sem elas o executável
        // não abre. Copiamos todos os arquivos irmãos do .exe dentro do zip para a pasta de
        // ferramentas do BDS, não apenas o .exe isoladamente.
        copySiblingFiles: true,
      },
      exiftool: {
        // Repositório e estratégia de versão dependem da plataforma: no Windows usamos o
        // build pré-compilado do ShareX/ExifTool (via GitHub Releases); no Linux/macOS usamos
        // o código-fonte oficial de exiftool/exiftool (via tags Git — esse repositório não
        // usa GitHub Releases) e o executamos com o Perl do próprio sistema, sem precisar
        // compilar nada.
        repoResolver: (platform) => platform === 'win32'
          ? { owner: 'ShareX', repo: 'ExifTool', useGitTags: false }
          : { owner: 'exiftool', repo: 'exiftool', useGitTags: true },
        versionArgs: ['-ver'],
        // O build do ShareX/ExifTool pode empacotar o binário como "exiftool(-k).exe"
        // (nome padrão upstream) em vez de "exiftool.exe" — tentamos ambos os nomes.
        alternateFileNames: ['exiftool(-k).exe'],
        // No Linux/macOS, o script "exiftool" sozinho não funciona — ele precisa da pasta
        // "lib/" (módulos Perl do Image::ExifTool) ao seu lado. Copiada junto após validação.
        copySiblingDirs: ['lib'],
      },
    };

    const config = configs[toolKey];
    if (!config) {
      if (optional) return null;
      throw new Error(`ToolUpdater: componente desconhecido '${toolKey}'`);
    }
    // A URL vem da tabela (plataforma, arquitetura) -> fonte oficial de ToolSources.js; lança
    // ToolUnavailableError quando o projeto oficial não publica o programa para este sistema.
    return { ...config, downloadUrl: (tag) => resolveDownloadUrl(toolKey, tag, process.platform, process.arch) };
  }

  /**
   * Executa `<exe> <args>` (timeout de 10s; a árvore de processos é encerrada no estouro) e
   * devolve a primeira linha da saída, ou null se falhar/não existir.
   */
  async _getVersion(exe, args) {
    if (!fs.existsSync(exe)) return null;
    try {
      const r = await toolRunner.run(exe, args, { timeout: 10000 });
      const output = `${r.stdout}${r.stderr}`;
      return output.split(/\r?\n/)[0]?.trim() || null;
    } catch (_) {
      return null;
    }
  }

  async _fetchLatestTag(owner, repo) {
    const data = await this._fetchLatestRelease(owner, repo);
    return data.tag_name || data.name;
  }

  async _fetchLatestRelease(owner, repo) {
    return this._requestJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
  }

  /**
   * Para repositórios que não usam GitHub Releases (ex: exiftool/exiftool, que só publica
   * tags Git), busca a tag mais recente via API de tags em vez de releases/latest.
   */
  async _fetchLatestGitTagOnly(owner, repo) {
    const tags = await this._requestJson(`https://api.github.com/repos/${owner}/${repo}/tags`);
    if (!Array.isArray(tags) || tags.length === 0) {
      throw new Error(`Nenhuma tag encontrada em ${owner}/${repo}.`);
    }
    return tags[0].name;
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

  /** GET de JSON da API do GitHub (redirecionamentos limitados; https->http bloqueado). */
  _requestJson(url) {
    return fetchJson(url, {
      timeoutMs: 20000,
      userAgent: 'BragaDigitalStudio/1.0',
      headers: { Accept: 'application/vnd.github+json' }
    });
  }

  /**
   * Baixa um arquivo para dest via FileDownloader (redirecionamentos absolutos/relativos, no
   * máximo 5; https->http bloqueado; tentativas com retomada; SHA-256 calculado durante o
   * download). Rejeita — sem deixar arquivo parcial — em: HTTP != 200, laço de redirecionamento,
   * timeout, conexão encerrada antes do fim e tamanho diferente do Content-Length.
   * @returns {Promise<{path: string, size: number, sha256: string}>}
   */
  async _downloadFile(url, dest, onProgress) {
    try {
      return await downloadFile({
        url,
        dest,
        userAgent: 'BragaDigitalStudio/1.0',
        attempts: 3,
        backoffMs: 400,
        onProgress: onProgress ? (p) => onProgress(p.receivedBytes, p.totalBytes) : null
      });
    } catch (err) {
      // Instalação de componente não retoma entre execuções: descarta o parcial.
      try { fs.rmSync(`${dest}.part`, { force: true }); } catch (_) { /* noop */ }
      try { fs.rmSync(dest, { force: true }); } catch (_) { /* noop */ }
      throw err;
    }
  }

  /**
   * Detecta o tipo de arquivo compactado a partir da URL de download, para decidir qual
   * extrator usar (zip vs tar/.tar.xz/.tar.gz/.tar.bz2). Retorna null se a URL não aponta
   * para um formato compactado reconhecido (ex: binário bruto, sem extração necessária).
   */
  _detectArchiveType(url) {
    const lower = (url || '').toLowerCase().split('?')[0];
    if (lower.endsWith('.zip')) return 'zip';
    if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) return 'tar.xz';
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
    if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) return 'tar.bz2';
    if (lower.endsWith('.tar')) return 'tar';
    return null;
  }

  /**
   * Extrai um arquivo .tar/.tar.xz/.tar.gz/.tar.bz2 usando o `tar` do sistema operacional.
   * Disponível por padrão em praticamente todas as distribuições Linux (GNU tar ou BusyBox
   * tar) e no macOS (BSD tar) — ambos com `-xf` fazendo detecção automática de compressão
   * pelo conteúdo/extensão, sem precisar de flags separadas por formato (-z/-j/-J).
   */
  async _extractTar(tarPath, destination) {
    fs.mkdirSync(destination, { recursive: true });

    // Proteção contra zip-slip: lista as entradas e rejeita qualquer uma fora do destino.
    try {
      const listing = await captureOutput('tar', ['-tf', tarPath]);
      assertSafeEntries(listing.split('\n'), destination);
    } catch (err) {
      if (/inseguro/.test(err.message)) throw err;
      throw new Error(`Comando 'tar' não disponível ou falhou ao validar o arquivo: ${err.message}. Em sistemas Linux mínimos/containers, instale o pacote 'tar' (geralmente já vem por padrão).`);
    }

    return new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xf', tarPath, '-C', destination], { windowsHide: true });
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        processRunner.cancel(child).then(() => {
          if (!settled) { settled = true; reject(new Error('Tempo esgotado ao extrair o arquivo tar.')); }
        });
      }, 15 * 60 * 1000);
      if (timer.unref) timer.unref();
      child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('error', (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(new Error(`Comando 'tar' não disponível ou falhou ao iniciar: ${err.message}. Em sistemas Linux mínimos/containers, instale o pacote 'tar' (geralmente já vem por padrão).`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0) resolve();
        else reject(new Error(`Falha na extração do arquivo tar (código ${code}): ${stderr.slice(0, 300)}`));
      });
    });
  }

  /** Extrai .zip via ZipExtractor (tar.exe/unzip com argumentos em array, anti zip-slip, timeout). */
  async _extractZip(zipPath, destination) {
    fs.mkdirSync(destination, { recursive: true });
    return extractZip(zipPath, destination, { timeoutMs: 15 * 60 * 1000 });
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

