'use strict';

/**
 * LIBERAÇÃO DO ASSISTENTE DE IA NO APP FINAL (uma única decisão)
 * --------------------------------------------------------------
 * Hoje o assistente só existe em DESENVOLVIMENTO (app não empacotado). Para liberar no app empacotado basta trocar a
 * constante abaixo para `true`: o módulo "Assistente de IA" deixa de ser "só desenvolvimento" (ModuleRegistry), a trava
 * do processo principal (aiHandlers → assistantBlock) deixa de exigir o build de desenvolvimento e a interface passa a
 * mostrar o cartão nas Configurações. O módulo continua desligado por padrão e o interruptor "Ativar assistente"
 * continua valendo. Nenhuma outra mudança é necessária.
 *
 * Antes de liberar, releia .docs/ASSISTENTE_IA_FERRAMENTAS.md (modelo de ameaça) e confirme o aviso de privacidade
 * para servidores que não são locais (o que o assistente lê é enviado ao servidor escolhido).
 */
const ASSISTANT_ALLOWED_IN_PACKAGED_APP = false;

/** O assistente pode rodar neste build? (desenvolvimento, ou liberado na constante acima). */
function isAssistantBuildAllowed(isDev) {
  return isDev === true || ASSISTANT_ALLOWED_IN_PACKAGED_APP === true;
}

module.exports = { ASSISTANT_ALLOWED_IN_PACKAGED_APP, isAssistantBuildAllowed };
