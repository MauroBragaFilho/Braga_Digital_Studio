'use strict';

/**
 * modelKinds: classificação PURA (sem rede, sem estado) dos modelos que um servidor de IA lista.
 *
 * Entrada de um modelo: { id, meta? }, onde `meta` é o objeto cru que o servidor mandou (dado NÃO confiável: só se lê
 * por campos conhecidos, com checagem de tipo e só propriedades próprias). Saída: { id, caps, source, timing? }
 *  - caps: subconjunto de ['chat','audio','image','video'] (vazio = ignorado: embeddings, moderação, geração de imagem, voz...);
 *  - source: 'metadado' quando alguma capacidade veio dos dados do servidor, 'nome' quando veio só do nome (é "provável");
 *  - timing (só áudio): 'palavras' | 'texto', quando o nome deixa claro.
 *
 * Ordem de decisão: (1) id inválido, modelo inativo ou aposentado -> ignorado; (2) o metadado, quando existe, decide o que sabe;
 * (3) o que o metadado não disse vem de padrões de NOME (exclusões primeiro, depois vídeo, áudio e, por padrão, chat).
 */

const MAX_MODELS = 200;
const MAX_ID_LENGTH = 120;
const MAX_ENTRIES = 5000; // teto de entradas lidas de uma resposta (a lista final já é limitada a MAX_MODELS)
const CAPS = Object.freeze(['chat', 'audio', 'image', 'video']);

// Controles C0/C1, separadores de linha/parágrafo, marcas e controles bidirecionais, invisíveis (largura zero, BOM).
const BAD_ID_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

/** Id aceito no catálogo: texto de 1 a 120 caracteres, sem espaço nas pontas, sem controle/bidi e diferente de __proto__. */
function isValidModelId(id) {
  return typeof id === 'string'
    && id.length >= 1 && id.length <= MAX_ID_LENGTH
    && id === id.trim()
    && id !== '__proto__'
    && !BAD_ID_CHARS.test(id);
}

// ------------------------------------------------------------------ leitura defensiva de metadado

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Propriedade PRÓPRIA de um objeto (nunca herdada). */
const get = (o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const asBool = (v) => (typeof v === 'boolean' ? v : undefined);
const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const lowerList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.trim().toLowerCase()) : []);

/** Inativo (Groq: active false) ou aposentado/descontinuado (lifecycle): não aparece na lista. */
function isRetired(meta) {
  if (!isObj(meta)) return false;
  if (get(meta, 'active') === false) return true;
  const lc = get(meta, 'lifecycle');
  let status = '';
  if (typeof lc === 'string') status = lc;
  else if (isObj(lc)) {
    for (const key of ['status', 'state', 'stage']) {
      if (typeof get(lc, key) === 'string') { status = get(lc, key); break; }
    }
  }
  return /^(retired|deprecated|sunset|disabled)$/i.test(status.trim());
}

/** Visão declarada no metadado: capabilities.vision (booleano) ou capabilities como lista com "vision". Indefinido se não disse. */
function visionOf(meta) {
  const caps = get(meta, 'capabilities');
  if (Array.isArray(caps)) return lowerList(caps).includes('vision') ? true : undefined;
  return asBool(get(caps, 'vision'));
}

/**
 * O que o metadado diz. Devolve null quando não há metadado conhecido. Campos: chat/image/audio/video (booleanos; image
 * indefinido = não disse, o nome completa), ignore (modelo que não serve), nameVeto (o nome ainda pode vetar).
 */
function decideByMeta(meta) {
  if (!isObj(meta)) return null;
  const caps = get(meta, 'capabilities');

  // Anthropic nativo: tudo é conversa; imagem se capabilities.image_input.supported.
  if (isObj(caps) && Object.hasOwn(caps, 'image_input')) {
    return { chat: true, image: get(get(caps, 'image_input'), 'supported') === true };
  }
  // Mistral: completion_chat (conversa), vision (imagem), audio_transcription (áudio).
  if (isObj(caps) && Object.hasOwn(caps, 'completion_chat')) {
    return { chat: get(caps, 'completion_chat') === true, image: asBool(get(caps, 'vision')), audio: get(caps, 'audio_transcription') === true };
  }
  // LM Studio (llm | vlm | embedding) e Together (chat | language | code | image | embedding | moderation | rerank | transcribe | audio | video).
  switch (lower(get(meta, 'type'))) {
    case 'chat': case 'language': case 'code': case 'llm':
      return { chat: true, image: visionOf(meta) };
    case 'vlm':
      return { chat: true, image: true };
    case 'embedding': case 'embeddings': case 'moderation': case 'rerank': case 'image': case 'tts': case 'speech':
      return { ignore: true };
    case 'transcribe': case 'transcription': case 'stt':
      return { audio: true };
    case 'audio':
      return { audio: true, nameVeto: true }; // o tipo "audio" também cobre voz sintética: o nome ainda pode vetar
    case 'video':
      return { video: true };
    default: break;
  }
  // OpenRouter: architecture.input_modalities / output_modalities (ou o texto "text+image->text"). Tolerante se faltar.
  const arch = get(meta, 'architecture');
  if (isObj(arch)) {
    let ins = lowerList(get(arch, 'input_modalities'));
    let outs = lowerList(get(arch, 'output_modalities'));
    if (!ins.length && !outs.length) {
      const m = lower(get(arch, 'modality'));
      if (m.includes('->')) {
        const [i, o] = m.split('->');
        ins = i.split(/[^a-z]+/).filter(Boolean);
        outs = o.split(/[^a-z]+/).filter(Boolean);
      }
    }
    if (ins.length || outs.length) {
      if (!outs.length) outs = ['text'];
      if (outs.includes('video')) return { video: true };
      if (outs.includes('transcription')) return { audio: true };
      if (outs.includes('embeddings') || outs.includes('rerank')) return { ignore: true };
      if (!outs.includes('text')) return { ignore: true }; // só imagem/voz na saída: geração, não serve para conversa
      return { chat: true, image: ins.includes('image') };
    }
  }
  return null;
}

// ------------------------------------------------------------------ padrões de nome

/** Padrão com fronteira de token (letras e dígitos), tolerando prefixos como "openai/" e "meta-llama/". Tudo em minúsculas. */
const token = (src) => new RegExp(`(?<![a-z0-9])(?:${src})(?![a-z0-9])`);

// Exclusões (têm prioridade): não servem para conversa, transcrição nem visão.
const EXCLUDE = [
  // "embed" vale como começo de palavra (embeddinggemma, arctic-embed2, granite-embedding); o resto, como palavra inteira
  /(?<![a-z0-9])embed/, token('bge|minilm|gte|e5|voyage|colbert|nomic|clip|paraphrase'),
  token('moderation|guard|safeguard|shieldgemma'), /llama-?guard/,
  token('rerank(?:er)?'),
  token('tts|orpheus|playai|kokoro|speech|cosyvoice'),
  token('realtime|live|audio-preview|native-audio|gpt-audio'),
  token('dall-?e|gpt-image|chatgpt-image|imagen|flux|stable-diffusion|stable-image|sdxl|sd3|midjourney|seedream|recraft|nano-banana|ideogram|lyria'),
  /-image(?:-|$)/,
  token('davinci|babbage|curie|turbo-instruct'),
  token('deep-research|o1-pro|o3-pro|gpt-5(?:\\.\\d+)?-pro|codex|computer-use|search-preview'),
  token('diariz(?:e|ation)'),
  token('ocr')
];
const VIDEO = token('sora\\d*|veo\\d*|kling|wanx?\\d*|hailuo|runway|luma|pika|seedance|gen-?4(?:_turbo)?|video');
const AUDIO = token('whisper|transcribe|stt|asr|parakeet|scribe|voxtral-mini');
const TIMING_WORDS = /whisper/;
const TIMING_TEXT = token('transcribe|voxtral');
const IMAGE_BY_NAME = [
  token('vision'), token('vl'), /qwen[\d.]*-?vl/, /llava/, token('pixtral|moondream|molmo'), /minicpm-?v/, /internvl/, token('glm-?[\\d.]+v'),
  token('gpt-4o|chatgpt-4o|gpt-4\\.\\d|gpt-[5-9](?:\\.\\d+)?'),
  token('o4-mini|gpt-4-turbo|mistral-small-?3\\.\\d|step-1v'),
  token('claude'), token('gemini'), token('llama-?4'), token('gemma-?3n?')
];

function classifyByName(n) {
  const ignore = EXCLUDE.some((re) => re.test(n));
  return {
    ignore,
    video: VIDEO.test(n),
    audio: AUDIO.test(n),
    image: IMAGE_BY_NAME.some((re) => re.test(n)),
    timing: TIMING_WORDS.test(n) ? 'palavras' : (TIMING_TEXT.test(n) ? 'texto' : '')
  };
}

// ------------------------------------------------------------------ API

/**
 * Classifica UM modelo. caps vazio = ignorado (id inválido, inativo, retirado, ou tipo que o app não usa).
 * @param {{id:string, meta?:object}} entry
 * @returns {{id:string, caps:string[], source:'metadado'|'nome', timing?:'palavras'|'texto'}}
 */
function classifyModel(entry) {
  const id = isObj(entry) ? entry.id : undefined;
  if (!isValidModelId(id)) return { id: '', caps: [], source: 'nome' };
  const meta = isObj(entry.meta) ? entry.meta : null;
  if (isRetired(meta)) return { id, caps: [], source: 'metadado' };

  const name = classifyByName(id.toLowerCase());
  const byMeta = decideByMeta(meta);
  const has = { chat: false, audio: false, image: false, video: false };
  let source = 'nome';

  if (byMeta) {
    source = 'metadado';
    if (!byMeta.ignore) {
      has.chat = byMeta.chat === true;
      has.audio = byMeta.audio === true && !(byMeta.nameVeto && name.ignore);
      has.video = byMeta.video === true;
      has.image = has.chat && (byMeta.image !== undefined ? byMeta.image : name.image);
    }
  } else if (!name.ignore) {
    if (name.video) has.video = true;
    else if (name.audio) has.audio = true;
    else { has.chat = true; has.image = name.image; }
  }

  const out = { id, caps: CAPS.filter((c) => has[c]), source };
  if (has.audio && name.timing) out.timing = name.timing;
  return out;
}

/**
 * Lê a resposta de GET /models de qualquer formato conhecido e devolve as entradas { id, meta }.
 * Formatos: OpenAI {data:[...]}, array simples (Together), Anthropic nativo {data, has_more, last_id}, Groq, Mistral,
 * LM Studio, OpenRouter e Ollama {models:[{name}]}. Devolve null quando o formato não é reconhecido (lista vazia reconhecida = []).
 */
function parseModelsPayload(payload) {
  let items = null;
  if (Array.isArray(payload)) items = payload;
  else if (isObj(payload)) {
    if (Array.isArray(get(payload, 'data'))) items = get(payload, 'data');
    else if (Array.isArray(get(payload, 'models'))) items = get(payload, 'models');
  }
  if (!items) return null;
  const out = [];
  for (const item of items.slice(0, MAX_ENTRIES)) {
    if (typeof item === 'string') { out.push({ id: item, meta: null }); continue; }
    if (!isObj(item)) continue;
    const id = ['id', 'name', 'model', 'key'].map((k) => get(item, k)).find((v) => typeof v === 'string');
    if (id === undefined) continue;
    out.push({ id, meta: item });
  }
  return out;
}

/** Classifica a lista inteira: sem duplicados, sem ignorados/retirados/inativos, no máximo 200 (na ordem do servidor). */
function classifyAll(entries) {
  const out = [];
  if (!Array.isArray(entries)) return out;
  const seen = new Set();
  for (let i = 0; i < entries.length && i < MAX_ENTRIES && out.length < MAX_MODELS; i++) {
    const model = classifyModel(entries[i]);
    if (!model.caps.length || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

/** Quantos modelos têm cada capacidade: { chat, audio, image, video }. */
function countCaps(models) {
  const counts = { chat: 0, audio: 0, image: 0, video: 0 };
  if (!Array.isArray(models)) return counts;
  for (const m of models) {
    const caps = isObj(m) && Array.isArray(m.caps) ? m.caps : [];
    for (const c of CAPS) if (caps.includes(c)) counts[c] += 1;
  }
  return counts;
}

const UNSTABLE = token('preview|beta|exp|experimental');
// Para os modelos Claude: sonnet, depois haiku, por último opus (a ordem do servidor já traz o mais novo primeiro).
const CLAUDE_TIER = [[/sonnet/, 0], [/haiku/, 1], [/opus/, 2]];

/**
 * Modelo de conversa padrão: a escolha atual (se ainda existe), depois o sugerido do preset (se existe na lista), depois o
 * primeiro por ordem alfabética evitando preview/beta/exp. Se a lista é de Claude, prefere sonnet/haiku a opus.
 * @returns {string|null} id do modelo, ou null se não há modelo de conversa
 */
function pickChatDefault(models, { current, suggested } = {}) {
  const chat = (Array.isArray(models) ? models : []).filter((m) => isObj(m) && typeof m.id === 'string' && Array.isArray(m.caps) && m.caps.includes('chat'));
  if (!chat.length) return null;
  const ids = chat.map((m) => m.id);
  if (typeof current === 'string' && ids.includes(current)) return current;
  if (typeof suggested === 'string' && suggested && ids.includes(suggested)) return suggested;

  if (ids.some((id) => /(^|[^a-z0-9])claude/i.test(id))) {
    const tier = (id) => { const hit = CLAUDE_TIER.find(([re]) => re.test(id.toLowerCase())); return hit ? hit[1] : 3; };
    return ids.map((id, i) => ({ id, i, t: tier(id) })).sort((a, b) => (a.t - b.t) || (a.i - b.i))[0].id;
  }
  const rank = (id) => (UNSTABLE.test(id.toLowerCase()) ? 1 : 0);
  return [...ids].sort((a, b) => (rank(a) - rank(b)) || (a < b ? -1 : (a > b ? 1 : 0)))[0];
}

/**
 * Catálogo guardado em ai.json -> catálogo limpo. Leitura TOLERANTE (um arquivo editado à mão ou de outra versão nunca derruba o
 * app): descarta o que não é objeto, ids inválidos, duplicados e modelos sem capacidade; limita a 200; só lê propriedades
 * próprias; devolve objetos novos { id, caps, source, timing? } (nada do objeto original é reaproveitado).
 */
function normalizeCatalog(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set();
  for (let i = 0; i < raw.length && i < MAX_ENTRIES && out.length < MAX_MODELS; i++) {
    const m = raw[i];
    const id = get(m, 'id');
    if (!isValidModelId(id) || seen.has(id)) continue;
    const given = get(m, 'caps');
    const caps = CAPS.filter((c) => Array.isArray(given) && given.includes(c));
    if (!caps.length) continue;
    seen.add(id);
    const entry = { id, caps, source: get(m, 'source') === 'metadado' ? 'metadado' : 'nome' };
    const timing = get(m, 'timing');
    if (caps.includes('audio') && (timing === 'palavras' || timing === 'texto')) entry.timing = timing;
    out.push(entry);
  }
  return out;
}

module.exports = { classifyModel, classifyAll, parseModelsPayload, countCaps, pickChatDefault, normalizeCatalog, isValidModelId, MAX_MODELS, MAX_ID_LENGTH, CAPS };
