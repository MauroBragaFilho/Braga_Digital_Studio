'use strict';

/**
 * Liga o módulo "Transcrição" nas configurações (enabledModules.transcription = true), do mesmo jeito que
 * o botão de Configurações > Módulos faz (modules:setEnabled). Usado pelo modo de componentes do instalador
 * e pela conclusão na primeira abertura. Passar SEMPRE o SettingsManager do processo que está rodando
 * (no app, o do bootstrap), para o cache em memória e o arquivo não divergirem.
 *
 * Num settings.json ainda inexistente, load() cria a configuração de instalação nova (modulesMigrated: true).
 * Num settings.json antigo (sem enabledModules), load() faz antes a migração única dos módulos, então quem já
 * usava o app mantém Metadados e Remover Silêncios ligados.
 *
 * @param {{load:Function, save:Function, flush?:Function}} settingsManager
 * @returns {Record<string, boolean>} enabledModules gravado
 */
const { sanitizeEnabledModules } = require('../core/modules/ModuleRegistry');

function enableTranscriptionModule(settingsManager) {
  const current = sanitizeEnabledModules(settingsManager.load().enabledModules);
  const next = { ...current, transcription: true };
  settingsManager.save({ enabledModules: next });
  if (typeof settingsManager.flush === 'function') settingsManager.flush();
  return next;
}

module.exports = { enableTranscriptionModule };
