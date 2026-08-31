'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ToolManifest, LogicalComponentAliases, resolveCanonicalToolKey, getExecutableName } = require('./ToolManifest');
const { toolResolver } = require('./ToolResolver');
const { toolUpdater } = require('./ToolUpdater');
const ManifestClient = require('./ManifestClient');
const logger = require('../../services/logService');

/**
 * Componentes lógicos oficiais do BDS e suas descrições amigáveis internas.
 */
const BDS_COMPONENTS = {
  mediaEngine: {
    id: 'mediaEngine',
    title: 'Motor de Mídia',
    description: 'Processamento, conversão e renderização de vídeo e áudio.',
    canonicalTool: 'ffmpeg',
  },
  probeEngine: {
    id: 'probeEngine',
    title: 'Motor de Inspeção',
    description: 'Análise de metadados, codecs e estruturas de arquivos de mídia.',
    canonicalTool: 'ffprobe',
  },
  downloadEngine: {
    id: 'downloadEngine',
    title: 'Motor de Download',
    description: 'Captura e download de mídias de serviços suportados.',
    canonicalTool: 'ytdlp',
  },
  audioEngine: {
    id: 'audioEngine',
    title: 'Motor de Áudio',
    description: 'Recuperação e sincronização de faixas de áudio.',
    canonicalTool: 'spotdl',
  },
  jsRuntime: {
    id: 'jsRuntime',
    title: 'Ambiente de Execução',
    description: 'Runtime interno para execução de scripts e rotinas do sistema.',
    canonicalTool: 'deno',
  },
  recoveryEngine: {
    id: 'recoveryEngine',
    title: 'Motor de Recuperação',
    description: 'Recuperação e reconstrução de vídeos corrompidos ou incompletos.',
    canonicalTool: 'untrunc',
  },
  rawEngine: {
    id: 'rawEngine',
    title: 'Motor de Recuperação RAW',
    description: 'Diagnóstico, decodificação e reparo estrutural de arquivos RAW de câmeras.',
    canonicalTool: 'rawrecoveryengine',
    // Binário próprio do BDS (rawpy/LibRaw empacotado). Sem release pública com download
    // automático ainda — ver README de build em raw_recovery_engine/. Instalação manual do
    // binário na pasta de ferramentas do BDS até que exista um repositório de releases.
    manualInstallOnly: true,
  },
};

/**
 * DependencyManager — Gerenciamento unificado e centralizado dos componentes internos do BDS.
 * Nenhuma parte da interface ou serviços de alto nível deve lidar diretamente com binários.
 */
class DependencyManager {
  constructor() {
    this._toolsDir = null;
    this._manifestClient = null;
  }

  /**
   * Inicializa o gerenciador com o diretório de ferramentas do BDS.
   * @param {string} toolsDir
   */
  init(toolsDir) {
    this._toolsDir = toolsDir;
    toolUpdater.init(toolsDir);
    this._ensureToolsDirectory();
  }

  /**
   * Configura (ou desativa) o Update Server central. Quando configurado, componentes
   * presentes no manifest.json remoto passam a ser verificados/atualizados por lá
   * (com checksum sempre obrigatório), inclusive componentes hoje marcados como
   * `manualInstallOnly` (ex: rawEngine) — assim que o Update Server publicar uma entrada
   * para eles, o BDS passa a atualizá-los automaticamente sem precisar de mudança de código.
   * @param {string|null} updateServerUrl
   */
  configureUpdateServer(updateServerUrl) {
    if (!updateServerUrl) {
      this._manifestClient = null;
      logger.info('DependencyManager:configureUpdateServer:disabled');
      return;
    }
    this._manifestClient = new ManifestClient(updateServerUrl);
    logger.info('DependencyManager:configureUpdateServer:enabled', { updateServerUrl });
  }

  get hasUpdateServer() {
    return Boolean(this._manifestClient);
  }

  _ensureToolsDirectory() {
    if (this._toolsDir && !fs.existsSync(this._toolsDir)) {
      try {
        fs.mkdirSync(this._toolsDir, { recursive: true });
      } catch (err) {
        logger.error('DependencyManager:_ensureToolsDirectory:error', { error: err.message });
      }
    }
  }

  /**
   * Resolve o caminho absoluto de um componente pelo nome lógico ou chave canônica.
   * @param {string} componentKey
   * @param {object} [opts]
   * @param {boolean} [opts.mustExist=true]
   * @returns {string}
   */
  resolveComponent(componentKey, { mustExist = true } = {}) {
    const canonical = resolveCanonicalToolKey(componentKey);
    return toolResolver.resolve(canonical, this._toolsDir, { mustExist });
  }

  /**
   * Verifica se um componente está instalado e disponível no disco.
   * @param {string} componentKey
   * @returns {boolean}
   */
  isAvailable(componentKey) {
    const canonical = resolveCanonicalToolKey(componentKey);
    return toolResolver.exists(canonical, this._toolsDir);
  }

  /**
   * Obtém a lista e status de saúde de todos os componentes internos do BDS.
   * @returns {Promise<Array<object>>}
   */
  async getComponentsStatus() {
    const results = [];
    for (const [key, comp] of Object.entries(BDS_COMPONENTS)) {
      // 1. Se há um Update Server configurado, ele tem prioridade: componentes listados no
      //    manifest.json remoto são verificados por lá (checksum sempre obrigatório), mesmo
      //    componentes hoje marcados como manualInstallOnly (ex: rawEngine).
      if (this._manifestClient) {
        try {
          const entry = await this._manifestClient.getComponentEntry(comp.canonicalTool);
          if (entry) {
            const checkResult = toolUpdater.checkAgainstManifest(comp.canonicalTool, entry);
            results.push({
              id: comp.id,
              title: comp.title,
              description: comp.description,
              canonicalTool: comp.canonicalTool,
              isInstalled: Boolean(checkResult.installed),
              installedVersion: checkResult.installed,
              latestVersion: checkResult.latest,
              needsUpdate: Boolean(checkResult.needsUpdate),
              hasBackup: Boolean(checkResult.hasBackup),
              source: 'update-server',
              error: null,
            });
            continue;
          }
        } catch (err) {
          logger.warn('DependencyManager:manifest_check_failed', { tool: comp.canonicalTool, error: err.message });
          // Cai para o fluxo padrão abaixo (GitHub ou manual) se o Update Server falhar.
        }
      }

      // 2. Componentes de instalação manual sem entrada no Update Server: apenas verificamos
      //    presença no disco, sem consultar releases remotas.
      if (comp.manualInstallOnly) {
        const isInstalled = this.isAvailable(comp.canonicalTool);
        results.push({
          id: comp.id,
          title: comp.title,
          description: comp.description,
          canonicalTool: comp.canonicalTool,
          isInstalled,
          installedVersion: null,
          latestVersion: null,
          needsUpdate: false,
          canUpdate: false,
          manualInstallOnly: true,
          error: isInstalled ? null : 'Instalação manual: copie o binário para a pasta de ferramentas do BDS.',
        });
        continue;
      }

      // 3. Fluxo padrão: releases públicas do GitHub.
      try {
        const checkResult = await toolUpdater.check(comp.canonicalTool);
        results.push({
          id: comp.id,
          title: comp.title,
          description: comp.description,
          canonicalTool: comp.canonicalTool,
          isInstalled: Boolean(checkResult.installed),
          installedVersion: checkResult.installed,
          latestVersion: checkResult.latest,
          needsUpdate: Boolean(checkResult.needsUpdate),
          hasBackup: Boolean(checkResult.hasBackup),
          source: 'github',
          error: checkResult.error || null,
        });
      } catch (err) {
        results.push({
          id: comp.id,
          title: comp.title,
          description: comp.description,
          canonicalTool: comp.canonicalTool,
          isInstalled: false,
          installedVersion: null,
          latestVersion: null,
          needsUpdate: true,
          error: err.message,
        });
      }
    }
    return results;
  }

  /**
   * Verifica se há qualquer atualização disponível nos componentes do sistema.
   * @returns {Promise<{ hasUpdates: boolean, totalNeedingUpdate: number, components: Array<object> }>}
   */
  async checkSystemUpdates() {
    const statuses = await this.getComponentsStatus();
    const needingUpdate = statuses.filter(s => s.needsUpdate || !s.isInstalled);
    return {
      hasUpdates: needingUpdate.length > 0,
      totalNeedingUpdate: needingUpdate.length,
      components: statuses,
    };
  }

  /**
   * Atualiza atomicamente todos os componentes do sistema com progresso unificado de 0 a 100%.
   * @param {Function} [onProgress] (percent, message)
   * @returns {Promise<{ success: boolean, updatedCount: number, errors: Array<string> }>}
   */
  async updateAllComponents(onProgress) {
    const statuses = await this.getComponentsStatus();
    // Um componente entra na fila de atualização se: (a) não é estritamente manual (ou seja,
    // tem uma fonte real de atualização — GitHub ou Update Server) e (b) precisa atualizar.
    const toUpdate = statuses.filter(s => (s.source || !s.manualInstallOnly) && (s.needsUpdate || !s.isInstalled));

    if (toUpdate.length === 0) {
      if (onProgress) onProgress(100, 'Todos os componentes já estão atualizados.');
      return { success: true, updatedCount: 0, errors: [] };
    }

    const total = toUpdate.length;
    let current = 0;
    let updatedCount = 0;
    const errors = [];

    for (const comp of toUpdate) {
      current++;
      const basePercent = Math.round(((current - 1) / total) * 100);
      const nextPercent = Math.round((current / total) * 100);

      try {
        if (onProgress) {
          onProgress(basePercent, `Preparando componentes (${current}/${total})...`);
        }

        const stepProgress = (toolPercent) => {
          if (onProgress) {
            const overall = basePercent + Math.round((toolPercent / 100) * (nextPercent - basePercent));
            onProgress(Math.min(99, Math.max(1, overall)), 'Instalando componentes do BDS...');
          }
        };

        const result = await this.updateComponent(comp.canonicalTool, stepProgress);
        // So conta como atualizacao efetiva se o short-circuit nao tiver pulado o componente
        // (ex: release remota sem versao compravel, como "latest" do BtbN).
        if (!(result && result.skipped)) {
          updatedCount++;
        }
      } catch (err) {
        logger.error(`DependencyManager:update_failed:${comp.id}`, { error: err.message });
        errors.push(`Falha ao atualizar motor interno: ${err.message}`);
      }
    }

    if (onProgress) {
      onProgress(100, errors.length === 0 ? 'Componentes atualizados com sucesso.' : 'Atualização concluída com avisos.');
    }

    return {
      success: errors.length === 0,
      updatedCount,
      skippedCount: Math.max(0, total - updatedCount - errors.length),
      total,
      errors,
    };
  }

  /**
   * Atualiza um componente específico pelo ID lógico ou chave canônica. Se o Update Server
   * central estiver configurado e publicar uma entrada para este componente, ela tem
   * prioridade sobre o fluxo padrão do GitHub (e funciona mesmo para componentes hoje
   * marcados como manualInstallOnly).
   * @param {string} componentKey
   * @param {Function} [onProgress]
   */
  async updateComponent(componentKey, onProgress) {
    const canonical = resolveCanonicalToolKey(componentKey);

    if (this._manifestClient) {
      const entry = await this._manifestClient.getComponentEntry(canonical).catch(() => null);
      if (entry) {
        return toolUpdater.updateFromManifest(canonical, entry, onProgress);
      }
    }

    return toolUpdater.update(canonical, onProgress);
  }

  /**
   * Reverte um componente para a última versão estável conhecida (backup persistido
   * após a última atualização validada com sucesso).
   * @param {string} componentKey
   */
  async rollbackComponent(componentKey) {
    const canonical = resolveCanonicalToolKey(componentKey);
    return toolUpdater.rollback(canonical);
  }
}

const dependencyManager = new DependencyManager();

module.exports = {
  BDS_COMPONENTS,
  DependencyManager,
  dependencyManager,
};
