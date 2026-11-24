'use strict';

/**
 * AnthropicProvider: Claude pela API da Anthropic (host exato api.anthropic.com, https).
 *
 *  - LISTA de modelos e TESTE: pela API NATIVA (GET /v1/models com x-api-key e anthropic-version), via discovery.js. É a única
 *    fonte confiável das capacidades (imagem, por exemplo). Nunca envia Authorization nessa rota.
 *  - CONVERSA (chat e chatStream): HERDADAS do OpenAIProvider, pela camada de compatibilidade com a OpenAI
 *    (POST /v1/chat/completions, Authorization: Bearer). O adaptador nativo (/v1/messages) fica para uma etapa futura.
 *
 * NÃO VERIFICADO COM CHAVE REAL (só com servidor simulado): (1) o Bearer na rota de compatibilidade e (2) o /models pela camada
 * OpenAI. Por isso a lista de modelos NÃO passa por ela. testConnection() faz uma conversa mínima de verdade pela mesma rota
 * do chat: um teste verde prova que a conversa funciona, não só que a chave abre a lista.
 *
 * A camada de compatibilidade recusa (400) alguns parâmetros. O OpenAIProvider só manda temperature/top_p (e afins) a servidor
 * LOCAL, nunca response_format, e tool_choice só como "auto": nada disso chega aqui. Não acrescente esses campos sem rever.
 */

const OpenAIProvider = require('./OpenAIProvider');
const { discoverModels, isAnthropicUrl } = require('./discovery');

const TEST_MAX_TOKENS = 16;

class AnthropicProvider extends OpenAIProvider {
  constructor(opts) {
    super(opts);
    this.id = 'anthropic';
  }

  /** O endereço é a API da Anthropic (host exato, https, sem porta)? Só então vale o formato nativo e o cabeçalho x-api-key. */
  static isAnthropicBase(baseUrl) {
    try { return isAnthropicUrl(new URL(String(baseUrl))); } catch (_) { return false; }
  }

  _discover(signal = null) {
    return discoverModels({ baseUrl: this._base(), apiKey: this._getApiKey(), fetchImpl: this._fetch, signal: signal || undefined });
  }

  /** Modelos pela API nativa, na ordem do servidor (os mais novos primeiro), no formato que o card usa: [{ id, label }]. */
  async listModels() {
    const found = await this._discover();
    return found.models.map((m) => ({ id: m.id, label: m.id }));
  }

  /**
   * Lista nativa + UMA conversa mínima pela camada de compatibilidade (poucos tokens), no modelo escolhido do provedor.
   * Sem modelo escolhido não há como provar a conversa: recusa em vez de devolver um "verde" que não provaria nada.
   * @param {{model?:string}} [opts]
   */
  async testConnection({ model = '' } = {}) {
    if (!String(model || '').trim()) {
      throw Object.assign(new Error('Escolha o modelo de conversa para testar a conexão com a Anthropic.'), { code: 'NO_MODEL' });
    }
    const models = await this.listModels();
    await this.chat({ model, system: 'Responda apenas: ok.', messages: [{ role: 'user', content: 'ok' }], maxTokens: TEST_MAX_TOKENS });
    return { ok: true, message: `Conexão validada (${models.length} modelo(s) disponível(is)) e a conversa respondeu.` };
  }
}

module.exports = AnthropicProvider;
