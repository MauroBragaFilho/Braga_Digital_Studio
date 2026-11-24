'use strict';

// Classificação de modelos (função pura): ids reais de vários provedores, payloads de cada formato, metadado que vale mais
// que o nome, ids hostis (nada de poluir protótipo nem aceitar lixo) e escolha do modelo de conversa padrão.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const kinds = require('../src/services/ai/modelKinds');
const { classifyModel, classifyAll, parseModelsPayload, countCaps, pickChatDefault } = kinds;

const caps = (id, meta) => classifyModel({ id, meta }).caps.join(',');

// id -> capacidades esperadas ('' = ignorado)
const BY_NAME = [
  ['gpt-4o-mini', 'chat,image'], ['gpt-4o', 'chat,image'], ['chatgpt-4o-latest', 'chat,image'], ['gpt-4.1', 'chat,image'],
  ['gpt-5-mini', 'chat,image'], ['gpt-5-chat-latest', 'chat,image'], ['gpt-3.5-turbo', 'chat'], ['o3', 'chat'],
  ['gpt-5-pro', ''], ['gpt-5.2-pro', ''], ['gpt-5-codex', ''], ['codex-mini-latest', ''], ['o3-pro', ''], ['o1-pro', ''],
  ['o4-mini-deep-research', ''], ['computer-use-preview', ''], ['gpt-4o-search-preview', ''], ['gpt-4o-mini-search-preview', ''],
  ['gpt-3.5-turbo-instruct', ''], ['davinci-002', ''], ['babbage-002', ''], ['text-davinci-003', ''],
  ['gpt-4o-mini-transcribe', 'audio'], ['gpt-4o-transcribe-diarize', ''], ['gpt-4o-audio-preview', ''], ['gpt-4o-realtime-preview', ''],
  ['gpt-realtime-whisper', ''], ['gpt-4o-mini-tts', ''], ['tts-1', ''], ['tts-1-hd', ''], ['playai-tts', ''],
  ['canopylabs/orpheus-v1-english', ''], ['whisper-1', 'audio'], ['whisper-large-v3-turbo', 'audio'], ['distil-whisper-large-v3-en', 'audio'],
  ['nvidia/parakeet-ctc-1.1b-asr', 'audio'], ['scribe_v1', 'audio'], ['voxtral-mini-latest', 'audio'], ['voxtral-small-latest', 'chat'],
  ['gpt-image-1', ''], ['chatgpt-image-latest', ''], ['dall-e-3', ''], ['black-forest-labs/flux.1-dev', ''], ['stable-diffusion-xl', ''],
  ['gemini-2.5-flash-image-preview', ''], ['grok-2-image-1212', ''], ['imagen-3.0-generate-002', ''],
  ['text-embedding-3-small', ''], ['gemini-embedding-001', ''], ['nomic-embed-text:latest', ''], ['mxbai-embed-large', ''], ['bge-m3', ''],
  ['text-moderation-latest', ''], ['omni-moderation-latest', ''], ['meta-llama/llama-guard-4-12b', ''], ['openai/gpt-oss-safeguard-20b', ''],
  ['llama-prompt-guard-2-86m', ''], ['rerank-v3.5', ''], ['mistral-ocr-latest', ''], ['gemini-2.0-flash-live-001', ''], ['gemini-2.5-flash-preview-tts', ''],
  ['sora-2', 'video'], ['veo-3.0-generate-001', 'video'], ['kling-v1-6', 'video'], ['wan2.1-t2v-plus', 'video'], ['hailuo-02', 'video'],
  ['meta-llama/llama-4-scout-17b-16e-instruct', 'chat,image'], ['llama4:scout', 'chat,image'], ['llama-3.2-11b-vision-preview', 'chat,image'],
  ['llama-3.3-70b-versatile', 'chat'], ['llama-3.1-8b-instant', 'chat'], ['openai/gpt-oss-120b', 'chat'], ['gpt-oss:20b', 'chat'],
  ['gemini-2.5-flash', 'chat,image'], ['gemma-3-27b-it', 'chat,image'], ['gemma3:4b', 'chat,image'],
  ['qwen2.5vl:7b', 'chat,image'], ['qwen-vl-max', 'chat,image'], ['qwen3-vl:8b', 'chat,image'], ['qwen2.5-coder:7b', 'chat'], ['qwen-plus', 'chat'],
  ['llava:13b', 'chat,image'], ['pixtral-large-latest', 'chat,image'], ['moondream:latest', 'chat,image'], ['minicpm-v:8b', 'chat,image'],
  ['claude-sonnet-4', 'chat,image'], ['claude-opus-4', 'chat,image'],
  ['mistral-large-latest', 'chat'], ['deepseek-chat', 'chat'], ['deepseek-r1:8b', 'chat'], ['grok-3', 'chat'],
  // embeddings com algo colado em "embed", ou sem a palavra, e modelos de imagem/vídeo fora da lista principal
  ['embeddinggemma:300m', ''], ['snowflake-arctic-embed2', ''], ['granite-embedding:278m', ''], ['jina-clip-v2', ''], ['paraphrase-multilingual', ''],
  ['ideogram-v3', ''], ['lyria-002', ''], ['gen4_turbo', 'video'],
  ['o4-mini', 'chat,image'], ['gpt-4-turbo', 'chat,image'], ['mistral-small3.1', 'chat,image']
];

test('classificação por nome: tabela de ids reais', () => {
  assert.ok(BY_NAME.length >= 60, `a tabela tem ${BY_NAME.length} ids`);
  for (const [id, expected] of BY_NAME) assert.equal(caps(id), expected, id);
});

test('classificação por nome: fonte "nome", timing só no áudio e só quando o nome deixa claro', () => {
  assert.deepEqual(classifyModel({ id: 'gpt-4o-mini' }), { id: 'gpt-4o-mini', caps: ['chat', 'image'], source: 'nome' });
  assert.equal(classifyModel({ id: 'whisper-large-v3-turbo' }).timing, 'palavras');
  assert.equal(classifyModel({ id: 'gpt-4o-mini-transcribe' }).timing, 'texto');
  assert.equal(classifyModel({ id: 'voxtral-mini-latest' }).timing, 'texto');
  assert.equal('timing' in classifyModel({ id: 'scribe_v1' }), false);
  assert.equal('timing' in classifyModel({ id: 'gpt-4o' }), false);
});

test('prefixos de organização não atrapalham as fronteiras de token', () => {
  assert.equal(caps('openai/gpt-4o-mini'), 'chat,image');
  assert.equal(caps('openai/whisper-large-v3'), 'audio');
  assert.equal(caps('meta-llama/Llama-Guard-4-12B'), '');
  assert.equal(caps('Qwen/Qwen2.5-VL-72B-Instruct'), 'chat,image');
  // fronteira de token: "exp" dentro de outra palavra, "live" em "olive" etc. não vetam
  assert.equal(caps('olive-7b'), 'chat');
  assert.equal(caps('swan-chat'), 'chat');
});

// ------------------------------------------------------------------ metadado

test('Anthropic nativo: tudo é conversa; imagem só se image_input.supported', () => {
  const entries = parseModelsPayload({
    data: [
      { id: 'claude-sonnet-4-5', type: 'model', display_name: 'Claude Sonnet 4.5', capabilities: { image_input: { supported: true } } },
      { id: 'claude-text-only', type: 'model', display_name: 'Texto', capabilities: { image_input: { supported: false } } },
      { id: 'claude-old', type: 'model', capabilities: { image_input: { supported: true } }, lifecycle: { status: 'retired' } }
    ],
    has_more: false,
    last_id: 'claude-old'
  });
  const all = classifyAll(entries);
  assert.deepEqual(all.map((m) => [m.id, m.caps.join(','), m.source]), [
    ['claude-sonnet-4-5', 'chat,image', 'metadado'],
    ['claude-text-only', 'chat', 'metadado']
  ]);
});

test('Groq: active false é descartado; contexto não muda nada', () => {
  const all = classifyAll(parseModelsPayload({ object: 'list', data: [
    { id: 'llama-3.3-70b-versatile', object: 'model', active: true, context_window: 131072 },
    { id: 'old-model-70b', object: 'model', active: false }
  ] }));
  assert.deepEqual(all.map((m) => m.id), ['llama-3.3-70b-versatile']);
  assert.equal(all[0].source, 'nome');
});

test('Mistral: completion_chat e vision decidem; embedding some', () => {
  const all = classifyAll(parseModelsPayload({ data: [
    { id: 'mistral-small-latest', capabilities: { completion_chat: true, vision: true } },
    { id: 'codestral-latest', capabilities: { completion_chat: true, vision: false } },
    { id: 'mistral-embed', capabilities: { completion_chat: false, vision: false } },
    { id: 'voxtral-mini-latest', capabilities: { completion_chat: true, audio_transcription: true } }
  ] }));
  assert.deepEqual(all.map((m) => [m.id, m.caps.join(',')]), [
    ['mistral-small-latest', 'chat,image'], ['codestral-latest', 'chat'], ['voxtral-mini-latest', 'chat,audio']
  ]);
});

test('LM Studio: llm, vlm e embedding; o metadado vence o nome', () => {
  const all = classifyAll(parseModelsPayload({ models: [
    { key: 'qwen2.5-7b-instruct', type: 'llm', capabilities: { vision: false, trained_for_tool_use: true } },
    { key: 'qwen2-vl-7b', type: 'vlm' },
    { key: 'text-embedding-nomic', type: 'embedding' },
    { key: 'gemma-3-12b', type: 'llm', capabilities: ['vision', 'tool_use'] },
    { key: 'llava-v1.6', type: 'llm', capabilities: { vision: false } }
  ] }));
  assert.deepEqual(all.map((m) => [m.id, m.caps.join(',')]), [
    ['qwen2.5-7b-instruct', 'chat'], ['qwen2-vl-7b', 'chat,image'], ['gemma-3-12b', 'chat,image'], ['llava-v1.6', 'chat']
  ]);
  assert.ok(all.every((m) => m.source === 'metadado'));
});

test('OpenRouter: modalidades de entrada e saída; tolerante quando falta architecture', () => {
  const arch = (i, o) => ({ architecture: { input_modalities: i, output_modalities: o } });
  assert.equal(caps('anthropic/claude-sonnet-4', arch(['text', 'image'], ['text'])), 'chat,image');
  assert.equal(caps('vendor/text-model', arch(['text'], ['text'])), 'chat');
  assert.equal(caps('vendor/img-gen', arch(['text'], ['image'])), '');
  assert.equal(caps('vendor/vid-gen', arch(['text'], ['video'])), 'video');
  assert.equal(caps('vendor/stt-thing', arch(['audio'], ['transcription'])), 'audio');
  assert.equal(caps('vendor/vecs', arch(['text'], ['embeddings'])), '');
  assert.equal(caps('vendor/rr', arch(['text'], ['rerank'])), '');
  assert.equal(caps('vendor/voice', arch(['text'], ['speech'])), '');
  assert.equal(caps('vendor/old', { architecture: { modality: 'text+image->text' } }), 'chat,image');
  // sem architecture (ou vazia): cai para o nome
  assert.equal(caps('openai/gpt-4o', { architecture: {} }), 'chat,image');
  assert.equal(caps('openai/text-embedding-3-small', {}), '');
  assert.equal(classifyModel({ id: 'openai/gpt-4o', meta: { architecture: {} } }).source, 'nome');
});

test('Together: array simples com type', () => {
  const all = classifyAll(parseModelsPayload([
    { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', object: 'model', type: 'chat' },
    { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', type: 'code' },
    { id: 'black-forest-labs/FLUX.1-schnell', type: 'image' },
    { id: 'BAAI/bge-base-en-v1.5', type: 'embedding' },
    { id: 'Salesforce/Llama-Rank-V1', type: 'rerank' },
    { id: 'meta-llama/Llama-Guard-4-12B', type: 'moderation' },
    { id: 'openai/whisper-large-v3', type: 'transcribe' },
    { id: 'cartesia/sonic-tts', type: 'audio' },
    { id: 'minimax/video-01-director', type: 'video' }
  ]));
  assert.deepEqual(all.map((m) => [m.id, m.caps.join(',')]), [
    ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'chat'], ['Qwen/Qwen2.5-Coder-32B-Instruct', 'chat'],
    ['openai/whisper-large-v3', 'audio'], ['minimax/video-01-director', 'video']
  ]);
  assert.equal(all[2].timing, 'palavras');
});

test('Ollama: {models:[{name}]} só por nome; OpenAI {data:[{id}]}; lista de textos', () => {
  const ollama = classifyAll(parseModelsPayload({ models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest' }, { name: 'nomic-embed-text:latest' }, { name: 'llava:7b' }] }));
  assert.deepEqual(ollama.map((m) => [m.id, m.caps.join(',')]), [['llama3.2:latest', 'chat'], ['llava:7b', 'chat,image']]);
  const openai = classifyAll(parseModelsPayload({ object: 'list', data: [{ id: 'gpt-4o', object: 'model', owned_by: 'system' }, { id: 'whisper-1' }] }));
  assert.deepEqual(openai.map((m) => m.id), ['gpt-4o', 'whisper-1']);
  assert.deepEqual(parseModelsPayload(['a', 'b']).map((e) => e.id), ['a', 'b']);
});

test('payload irreconhecível devolve null; lista vazia reconhecida devolve []', () => {
  for (const bad of [null, undefined, 42, 'texto', true, {}, { data: 'x' }, { error: { message: 'x' } }, { models: {} }]) {
    assert.equal(parseModelsPayload(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseModelsPayload({ data: [] }), []);
  assert.deepEqual(parseModelsPayload([]), []);
  assert.deepEqual(classifyAll(null), []);
  // itens sem id ou de tipo errado são pulados
  assert.deepEqual(parseModelsPayload({ data: [null, 7, {}, { id: 5 }, { id: 'ok' }] }).map((e) => e.id), ['ok']);
});

test('metadado hostil é lido só por propriedades próprias e com checagem de tipo', () => {
  const hostile = JSON.parse('{"id":"gpt-4o","__proto__":{"active":false},"lifecycle":{"__proto__":{"status":"retired"}}}');
  assert.equal(caps('gpt-4o', hostile), 'chat,image');
  for (const meta of ['texto', 7, [], { capabilities: 'x' }, { capabilities: { image_input: 5 } }, { type: {} }, { architecture: 'x' }, { lifecycle: 9 }, { active: 'false' }]) {
    assert.doesNotThrow(() => classifyModel({ id: 'gpt-4o', meta }));
  }
  assert.equal(caps('gpt-4o', { capabilities: { image_input: 5 } }), 'chat'); // image_input presente mas sem supported:true
  assert.equal(caps('gpt-4o', { active: 'false' }), 'chat,image');
  assert.equal(caps('x-model', { lifecycle: 'Retired' }), '');
  assert.equal(caps('x-model', { lifecycle: { state: 'deprecated' } }), '');
});

// ------------------------------------------------------------------ ids hostis e limites

test('ids hostis: __proto__, vazio, longo, controle e bidi são recusados; constructor e toString são ids comuns', () => {
  const bad = ['__proto__', '', ' ', ' gpt-4o', 'gpt-4o ', 'x'.repeat(121), 'a\u0000b', 'a\nb', 'a\u202eb', 'a\u2066b', 'a\u200bb', 'a\u007fb', 'a\u0085b', 123, null, undefined, {}, []];
  for (const id of bad) {
    assert.equal(kinds.isValidModelId(id), false, JSON.stringify(id));
    assert.deepEqual(classifyModel({ id }).caps, [], JSON.stringify(id));
  }
  assert.equal(kinds.isValidModelId('x'.repeat(120)), true);
  const all = classifyAll(parseModelsPayload(JSON.parse('{"data":[{"id":"__proto__"},{"id":"constructor"},{"id":"toString"},{"id":"hasOwnProperty"},{"id":"valueOf"},{"id":"ok-model"}]}')));
  assert.deepEqual(all.map((m) => m.id), ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'ok-model']);
  assert.equal(({}).caps, undefined);
  assert.equal(Object.getPrototypeOf(all[0]), Object.prototype);
  assert.deepEqual(classifyModel(null), { id: '', caps: [], source: 'nome' });
  assert.deepEqual(classifyModel('gpt-4o').caps, []);
});

test('classifyAll: sem duplicados, ignora caps vazio e respeita o limite de 200', () => {
  const dup = classifyAll([{ id: 'a-model' }, { id: 'a-model' }, { id: 'text-embedding-3-small' }, { id: 'b-model' }]);
  assert.deepEqual(dup.map((m) => m.id), ['a-model', 'b-model']);
  const many = Array.from({ length: 450 }, (_, i) => ({ id: `chat-model-${i}` }));
  const limited = classifyAll(many);
  assert.equal(limited.length, kinds.MAX_MODELS);
  assert.equal(limited[0].id, 'chat-model-0');
  assert.equal(limited[199].id, 'chat-model-199');
  // ignorados não consomem a cota
  const mixed = classifyAll([...Array.from({ length: 300 }, (_, i) => ({ id: `text-embedding-${i}` })), { id: 'late-chat' }]);
  assert.deepEqual(mixed.map((m) => m.id), ['late-chat']);
});

test('countCaps conta cada capacidade', () => {
  const models = classifyAll(parseModelsPayload({ data: ['gpt-4o', 'gpt-3.5-turbo', 'whisper-1', 'sora-2', 'text-embedding-3-small'].map((id) => ({ id })) }));
  assert.deepEqual(countCaps(models), { chat: 2, audio: 1, image: 1, video: 1 });
  assert.deepEqual(countCaps([]), { chat: 0, audio: 0, image: 0, video: 0 });
  assert.deepEqual(countCaps(null), { chat: 0, audio: 0, image: 0, video: 0 });
  assert.deepEqual(countCaps([null, { caps: 'chat' }, { caps: ['chat', 'image'] }]), { chat: 1, audio: 0, image: 1, video: 0 });
});

// ------------------------------------------------------------------ pickChatDefault

const M = (...ids) => classifyAll(ids.map((id) => ({ id })));

test('pickChatDefault: escolha atual, depois o sugerido do preset, depois alfabética evitando preview/beta/exp', () => {
  const models = M('zeta-chat', 'alpha-preview', 'bravo-chat', 'whisper-1', 'gpt-4o-mini');
  assert.equal(pickChatDefault(models, { current: 'zeta-chat', suggested: 'gpt-4o-mini' }), 'zeta-chat');
  assert.equal(pickChatDefault(models, { current: 'sumiu', suggested: 'gpt-4o-mini' }), 'gpt-4o-mini');
  assert.equal(pickChatDefault(models, { suggested: 'nao-existe' }), 'bravo-chat');
  assert.equal(pickChatDefault(models), 'bravo-chat');
  assert.equal(pickChatDefault(M('x-beta', 'y-exp', 'z-experimental'), {}), 'x-beta'); // só instáveis: alfabética mesmo
  // o modelo atual/sugerido precisa ser de conversa
  assert.equal(pickChatDefault(models, { current: 'whisper-1' }), 'bravo-chat');
  assert.equal(pickChatDefault(M('whisper-1', 'sora-2')), null);
  assert.equal(pickChatDefault([]), null);
  assert.equal(pickChatDefault(null), null);
});

test('pickChatDefault: um modelo de embedding nunca vira a Conversa padrão (Ollama com embeddinggemma)', () => {
  const ollama = M('llama3.1:8b', 'embeddinggemma:300m', 'qwen3:8b', 'snowflake-arctic-embed2');
  assert.deepEqual(ollama.map((m) => m.id), ['llama3.1:8b', 'qwen3:8b']);
  assert.equal(pickChatDefault(ollama), 'llama3.1:8b');
});

test('pickChatDefault: para Claude prefere sonnet/haiku a opus, na ordem do servidor', () => {
  const list = M('claude-opus-4-1', 'claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4');
  assert.equal(pickChatDefault(list), 'claude-sonnet-4-5');
  assert.equal(pickChatDefault(M('claude-opus-4-1', 'claude-haiku-4-5')), 'claude-haiku-4-5');
  assert.equal(pickChatDefault(M('claude-opus-4-1')), 'claude-opus-4-1');
  assert.equal(pickChatDefault(list, { current: 'claude-opus-4-1' }), 'claude-opus-4-1');
});
