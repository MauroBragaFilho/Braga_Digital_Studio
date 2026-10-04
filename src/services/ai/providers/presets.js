'use strict';

/**
 * Presets de provedores de IA. Todos falam o protocolo de chat da OpenAI (o OpenAIProvider cuida disso); o preset
 * só entrega endereço, modelo sugerido (valor inicial editável: a lista real vem do /models de cada provedor) e se
 * a chave é obrigatória.
 *
 * ATENÇÃO: o endereço "qwen-alt" foi informado pelo usuário e NÃO está confirmado como domínio oficial da Alibaba
 * (os oficiais terminam em aliyuncs.com). A interface mostra um aviso curto ao escolhê-lo.
 */

const PRESETS = Object.freeze([
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyRequired: true, unverified: false, hosts: ['api.groq.com'] },
  { id: 'qwen', label: 'Qwen (Alibaba)', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyRequired: true, unverified: false, hosts: ['dashscope-intl.aliyuncs.com'] },
  {
    id: 'qwen-alt', label: 'Qwen (outro endereço)', baseUrl: 'https://maas.qwencloudapi.com/compatible-mode/v1', model: 'qwen-plus', keyRequired: true, unverified: true, hosts: ['maas.qwencloudapi.com'],
    warning: 'Endereço não confirmado como oficial: use só se você confia nele.'
  },
  { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', model: '', keyRequired: false, unverified: false, hosts: [] },
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: '', keyRequired: false, unverified: false, hosts: [] },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyRequired: true, unverified: false, hosts: ['api.openai.com'] },
  { id: 'custom', label: 'Personalizado', baseUrl: '', model: '', keyRequired: false, unverified: false, hosts: [] }
]);

const byId = (id) => PRESETS.find((p) => p.id === id) || null;

/** Descobre o preset pelo endereço (host conhecido; local nas portas do LM Studio/Ollama); senão "custom". */
function detectPreset(baseUrl) {
  let url;
  try { url = new URL(String(baseUrl || '')); } catch (_) { return 'custom'; }
  const host = url.hostname.toLowerCase();
  const known = PRESETS.find((p) => p.hosts.includes(host));
  if (known) return known.id;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    if (url.port === '1234') return 'lmstudio';
    if (url.port === '11434') return 'ollama';
  }
  return 'custom';
}

/** Versão para a interface (sem campos internos). */
function publicList() {
  return PRESETS.map((p) => ({
    id: p.id, label: p.label, baseUrl: p.baseUrl, model: p.model,
    keyRequired: p.keyRequired, unverified: p.unverified, warning: p.warning || ''
  }));
}

module.exports = { PRESETS, byId, detectPreset, publicList };
