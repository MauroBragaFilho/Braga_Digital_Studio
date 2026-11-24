'use strict';

/**
 * Presets de provedores de IA. Todos falam o protocolo de chat da OpenAI (o OpenAIProvider cuida disso); o preset
 * só entrega endereço, modelo sugerido (valor inicial editável: a lista real vem do /models de cada provedor) e se
 * a chave é obrigatória.
 *
 * Qwen: um único preset, a QwenCloud (marca da Alibaba fora da China) no plano Pay-As-You-Go, endereço oficial publicado em
 * docs.qwencloud.com. O antigo preset do Model Studio (dashscope-intl.aliyuncs.com) foi removido; um provedor salvo com ele
 * continua funcionando como "Personalizado" (AIService recai em detectPreset, que preserva endereço, chave e modelo).
 * `unverified`/`warning` continuam existindo para um preset futuro de origem não confirmada.
 */

/** Porta fixa do modelo local do app (llama-server em 127.0.0.1): faz parte do endereço do provedor "embedded". */
const EMBEDDED_PORT = 18741;

/**
 * Janela de contexto (tokens) do modelo local do app: o llama-server sobe com `-c` igual a isto (LocalLlm).
 * DECISÃO (medido em 13/11/2026, Qwen2.5 0.5B na CPU): 8192 custa ~48 MB a mais que 4096 e o mesmo tempo para a
 * mesma conversa (primeira pergunta ~15 s com 3,2 mil tokens; as seguintes < 1 s, o servidor reaproveita o prefixo).
 * Com 4096, o prompt e as ferramentas deixavam só ~800 tokens para a conversa.
 */
const EMBEDDED_CONTEXT = 8192;

const PRESETS = Object.freeze([
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyRequired: true, unverified: false, hosts: ['api.groq.com'] },
  { id: 'qwencloud', label: 'Qwen', baseUrl: 'https://maas.qwencloudapi.com/compatible-mode/v1', model: 'qwen-plus', keyRequired: true, unverified: false, hosts: ['maas.qwencloudapi.com'] },
  { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', model: '', keyRequired: false, unverified: false, hosts: [] },
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: '', keyRequired: false, unverified: false, hosts: [] },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyRequired: true, unverified: false, hosts: ['api.openai.com'] },
  { id: 'embedded', label: 'Modelo local do app', baseUrl: `http://127.0.0.1:${EMBEDDED_PORT}/v1`, model: 'qwen2.5-0.5b-instruct', keyRequired: false, unverified: false, hosts: [], internal: true },
  // Anthropic: só nasce pela descoberta de modelos (atalho "Adicionar provedor"); não entra no menu antigo (publicList).
  // O modelo sugerido fica vazio: o catálogo da própria Anthropic traz os modelos atuais.
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: '', keyRequired: true, unverified: false, hosts: ['api.anthropic.com'], discoveryOnly: true },
  { id: 'custom', label: 'Personalizado', baseUrl: '', model: '', keyRequired: false, unverified: false, hosts: [] }
]);

/** Atalhos do "Adicionar provedor" (só preenchem o endereço), na ordem em que aparecem. */
const SHORTCUT_IDS = Object.freeze(['groq', 'qwencloud', 'openai', 'anthropic', 'lmstudio', 'ollama']);

const byId = (id) => PRESETS.find((p) => p.id === id) || null;

/** Descobre o preset pelo endereço (host conhecido; local nas portas do LM Studio/Ollama); senão "custom". */
function detectPreset(baseUrl) {
  let url;
  try { url = new URL(String(baseUrl || '')); } catch (_) { return 'custom'; }
  const host = url.hostname.toLowerCase();
  const known = PRESETS.find((p) => p.hosts.includes(host));
  if (known) return known.id;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    if (url.port === String(EMBEDDED_PORT)) return 'embedded';
    if (url.port === '1234') return 'lmstudio';
    if (url.port === '11434') return 'ollama';
  }
  return 'custom';
}

/** Versão para a interface (sem campos internos). */
function publicList() {
  return PRESETS.filter((p) => !p.internal && !p.discoveryOnly).map((p) => ({
    id: p.id, label: p.label, baseUrl: p.baseUrl, model: p.model,
    keyRequired: p.keyRequired, unverified: p.unverified, warning: p.warning || ''
  }));
}

/** Atalhos de endereço do "Adicionar provedor": { id, label, baseUrl, keyRequired }. Só preenchem o campo; não criam nada. */
function shortcuts() {
  return SHORTCUT_IDS.map((id) => byId(id)).filter(Boolean).map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl, keyRequired: p.keyRequired }));
}

module.exports = { PRESETS, EMBEDDED_PORT, EMBEDDED_CONTEXT, byId, detectPreset, publicList, shortcuts };
