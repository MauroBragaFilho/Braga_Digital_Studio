'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ToolManifest, LogicalComponentAliases, resolveCanonicalToolKey, getExecutableName } = require('./ToolManifest');
const { toolResolver } = require('./ToolResolver');
const { toolUpdater } = require('./ToolUpdater');
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
};

/**
 * DependencyManager — Gerenciamento unificado e centralizado dos componentes internos do BDS.
 * Nenhuma parte da interface ou serviços de alto nível deve lidar diretamente com binários.
 */
class DependencyManager {
  constructor() {
    this._toolsDir = null;
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
    const toUpdate = statuses.filter(s => s.needsUpdate || !s.isInstalled);

    if (toUpdate.length === 0) {
      if (onProgress) onProgress(100, 'Todos os componentes já estão atualizados.');
      return { success: true, updatedCount: 0, errors: [] };
    }

    const total = toUpdate.length;
    let current = 0;
    const errors = [];

    for (const comp of toUpdate) {
      current++;
      const basePercent = Math.round(((current - 1) / total) * 100);
      const nextPercent = Math.round((current / total) * 100);

      try {
        if (onProgress) {
          onProgress(basePercent, `Preparando componentes (${current}/${total})...`);
        }

        await toolUpdater.update(comp.canonicalTool, (toolPercent) => {
          if (onProgress) {
            const overall = basePercent + Math.round((toolPercent / 100) * (nextPercent - basePercent));
            onProgress(Math.min(99, Math.max(1, overall)), 'Instalando componentes do BDS...');
          }
        });
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
      updatedCount: total - errors.length,
      errors,
    };
  }

  /**
   * Atualiza um componente específico pelo ID lógico ou chave canônica.
   * @param {string} componentKey
   * @param {Function} [onProgress]
   */
  async updateComponent(componentKey, onProgress) {
    const canonical = resolveCanonicalToolKey(componentKey);
    return toolUpdater.update(canonical, onProgress);
  }
}

const dependencyManager = new DependencyManager();

module.exports = {
  BDS_COMPONENTS,
  DependencyManager,
  dependencyManager,
};
