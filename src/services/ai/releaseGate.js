'use strict';

/**
 * LIBERAÇÃO DO ASSISTENTE DE IA NO APP FINAL (uma única decisão)
 * --------------------------------------------------------------
 * LIBERADO: o assistente existe no app empacotado (para todos os usuários). Com `true` o módulo "Assistente de IA"
 * não é "só desenvolvimento" (ModuleRegistry), a trava do processo principal (aiHandlers → assistantBlock) não exige
 * o build de desenvolvimento e a interface mostra o botão flutuante e o cartão nas Configurações. O módulo vem LIGADO
 * por padrão e o interruptor "Ativar assistente" continua valendo. Para voltar a "só desenvolvimento" basta trocar
 * a constante para `false`.
 *
 * O modelo de ameaça de .docs/ASSISTENTE_IA_FERRAMENTAS.md vale para TODOS os usuários: toda ação passa por uma
 * confirmação nativa do processo principal, o modelo só enxerga ids e resumos sem caminhos, e antes da primeira
 * mensagem a um servidor que não é local o chat mostra um aviso de privacidade (o aceite fica em ai.json).
 */
const ASSISTANT_ALLOWED_IN_PACKAGED_APP = true;

/** O assistente pode rodar neste build? (desenvolvimento, ou liberado na constante acima). */
function isAssistantBuildAllowed(isDev) {
  return isDev === true || ASSISTANT_ALLOWED_IN_PACKAGED_APP === true;
}

module.exports = { ASSISTANT_ALLOWED_IN_PACKAGED_APP, isAssistantBuildAllowed };
