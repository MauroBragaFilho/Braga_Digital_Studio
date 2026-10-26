'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CloudConfig } = require('../src/core/transcription/CloudConfig');
const { GroqTranscriber } = require('../src/core/transcription/GroqTranscriber');
const { ElevenLabsTranscriber, segmentsFromWords } = require('../src/core/transcription/ElevenLabsTranscriber');
const { WhisperCppRunner, RunnerError } = require('../src/core/modules/WhisperCppRunner');

const FAKE_CLI = path.join(__dirname, 'fixtures', 'fake-whisper-cli.js');
const FAKE_FFMPEG = path.join(__dirname, 'fixtures', 'fake-ffmpeg.js');
const CLI_FILE = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';

const GROQ_KEY = 'gsk_abcdefghijklmnopqrstuvwxyz0123456789';
const ELEVEN_KEY = 'sk_0123456789abcdef0123456789abcdef';

// safeStorage de mentira: "criptografa" em base64 invertido, o suficiente para provar que o disco não guarda a chave pura
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`),
  decryptString: (b) => [...b.toString().slice(4)].reverse().join('')
};

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bds-nuvem-')); }

const json = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  json: async () => body
});

/** Slicer de mentira: grava um arquivo pequeno no lugar do trecho recortado. */
const fakeSlice = async (wav, start, length, out) => { fs.writeFileSync(out, `audio ${start}-${length}`); };

function configWith(dir, keys = {}) {
  const config = new CloudConfig({ configDir: dir, safeStorage });
  for (const [provider, apiKey] of Object.entries(keys)) config.set({ provider, apiKey });
  return config;
}

// ------------------------------------------------------------------ configuração e chaves

test('CloudConfig: guarda a chave criptografada, nunca a devolve e valida o formato', () => {
  const dir = tmpDir();
  const config = configWith(dir);
  assert.deepEqual(config.getPublic().providers.map((p) => [p.id, p.hasKey]), [['groq', false], ['elevenlabs', false]]);

  const pub = config.set({ provider: 'groq', apiKey: GROQ_KEY, model: 'whisper-large-v3' });
  assert.equal(pub.providers.find((p) => p.id === 'groq').hasKey, true);
  assert.equal(pub.providers.find((p) => p.id === 'groq').model, 'whisper-large-v3');
  assert.ok(!JSON.stringify(pub).includes(GROQ_KEY), 'a chave nunca volta para a interface');
  assert.ok(!fs.readFileSync(path.join(dir, 'transcricao-nuvem.json'), 'utf8').includes(GROQ_KEY), 'a chave não fica em texto puro no disco');
  assert.equal(config.readKey('groq'), GROQ_KEY);
  assert.equal(config.readKey('elevenlabs'), '');

  assert.throws(() => config.set({ provider: 'groq', apiKey: 'curta' }), /parece inválida/);
  assert.throws(() => config.set({ provider: 'groq', apiKey: `${GROQ_KEY} com espaço` }), /parece inválida/);
  assert.throws(() => config.set({ provider: 'outro', apiKey: GROQ_KEY }), /desconhecido/);
  assert.throws(() => config.set({ provider: 'groq', model: 'gpt-x' }), /Modelo desconhecido/);

  assert.equal(config.set({ provider: 'groq', clearApiKey: true }).providers.find((p) => p.id === 'groq').hasKey, false);
});

test('CloudConfig: sem armazenamento seguro a chave não é guardada', () => {
  const config = new CloudConfig({ configDir: tmpDir(), safeStorage: { isEncryptionAvailable: () => false } });
  assert.throws(() => config.set({ provider: 'groq', apiKey: GROQ_KEY }), /armazenamento seguro/);
  assert.equal(config.getPublic().encryptionAvailable, false);
});

test('CloudConfig.test: chave boa, recusada, restrita (ElevenLabs) e sem internet', async () => {
  const calls = [];
  const make = (reply) => new CloudConfig({
    configDir: tmpDir(), safeStorage,
    fetchImpl: async (url, init) => { calls.push({ url, headers: init.headers }); return typeof reply === 'function' ? reply() : reply; }
  });

  const ok = make(json(200, {}));
  ok.set({ provider: 'groq', apiKey: GROQ_KEY });
  assert.deepEqual(await ok.test('groq'), { ok: true });
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/models');
  assert.equal(calls[0].headers.Authorization, `Bearer ${GROQ_KEY}`);

  const bad = make(json(401, {}));
  bad.set({ provider: 'groq', apiKey: GROQ_KEY });
  await assert.rejects(() => bad.test('groq'), /recusou a chave/);

  const restricted = make(json(401, { detail: { status: 'missing_permissions' } }));
  restricted.set({ provider: 'elevenlabs', apiKey: ELEVEN_KEY });
  assert.deepEqual(await restricted.test('elevenlabs'), { ok: true, limited: true });
  assert.equal(calls.at(-1).url, 'https://api.elevenlabs.io/v1/models');
  assert.equal(calls.at(-1).headers['xi-api-key'], ELEVEN_KEY);

  const offline = make(() => { throw new Error('ECONNRESET'); });
  offline.set({ provider: 'groq', apiKey: GROQ_KEY });
  await assert.rejects(() => offline.test('groq'), /conexão com a internet/);

  await assert.rejects(() => make(json(200, {})).test('groq'), /Informe a chave/);
});

// ------------------------------------------------------------------ Groq

test('Groq: corta em blocos, soma o início de cada bloco aos tempos e envia o pedido certo', async () => {
  const work = tmpDir();
  const config = configWith(tmpDir(), { groq: GROQ_KEY });
  const sent = [];
  const fetchImpl = async (url, init) => {
    const form = init.body;
    sent.push({ url, auth: init.headers.Authorization, model: form.get('model'), language: form.get('language'), granularities: form.getAll('timestamp_granularities[]'), format: form.get('response_format') });
    return json(200, {
      language: 'Portuguese',
      segments: [{ start: 0, end: 4, text: ' Bom dia.' }],
      words: [{ word: 'Bom', start: 0, end: 1 }, { word: 'dia.', start: 1.2, end: 2 }]
    });
  };
  const groq = new GroqTranscriber({ config, fetchImpl, slice: fakeSlice, chunkSeconds: 10 });
  const events = [];
  const progress = [];
  const out = await groq.transcribe({ wav: 'x.wav', seconds: 25, work, language: 'pt', onEvent: (e) => events.push(e), onProgress: (f) => progress.push(f) });

  assert.equal(sent.length, 3);
  assert.deepEqual(sent[0], { url: 'https://api.groq.com/openai/v1/audio/transcriptions', auth: `Bearer ${GROQ_KEY}`, model: 'whisper-large-v3-turbo', language: 'pt', granularities: ['word', 'segment'], format: 'verbose_json' });
  assert.deepEqual(out.segments.map((s) => [s.start, s.text]), [[0, 'Bom dia.'], [10, 'Bom dia.'], [20, 'Bom dia.']]);
  assert.deepEqual(out.words.map((w) => w.start).filter((_, i) => i % 2 === 0), [0, 10, 20]);
  assert.equal(out.language, 'Portuguese');
  assert.deepEqual(progress.map((p) => Math.round(p * 100)), [33, 67, 100]);
  assert.ok(events.some((e) => /trecho 2 de 3/.test(e.text)));
  assert.deepEqual(fs.readdirSync(work), [], 'os trechos temporários são apagados');
});

test('Groq: idioma automático não manda language; sem tempo por palavra distribui pelo trecho', async () => {
  const config = configWith(tmpDir(), { groq: GROQ_KEY });
  let language = 'inalterado';
  const fetchImpl = async (url, init) => {
    language = init.body.get('language');
    return json(200, { language: 'en', segments: [{ start: 0, end: 4, text: 'one two three four' }] });
  };
  const out = await new GroqTranscriber({ config, fetchImpl, slice: fakeSlice }).transcribe({ wav: 'x.wav', seconds: 4, work: tmpDir(), language: 'auto' });
  assert.equal(language, null);
  assert.deepEqual(out.words.map((w) => w.word), ['one', 'two', 'three', 'four']);
  assert.ok(out.words.every((w) => w.end >= w.start && w.end <= 4));
});

test('Groq: tenta de novo em 429/5xx/rede, respeita retry-after e desiste com mensagem clara', async () => {
  const config = configWith(tmpDir(), { groq: GROQ_KEY });
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const okBody = { language: 'pt', segments: [{ start: 0, end: 1, text: 'oi' }], words: [{ word: 'oi', start: 0, end: 1 }] };
  const run = (replies) => {
    let i = 0;
    const fetchImpl = async () => { const r = replies[Math.min(i++, replies.length - 1)]; if (r instanceof Error) throw r; return r; };
    return new GroqTranscriber({ config, fetchImpl, slice: fakeSlice, sleep }).transcribe({ wav: 'x.wav', seconds: 3, work: tmpDir(), language: 'pt' });
  };

  const out = await run([json(429, {}, { 'retry-after': '3' }), new Error('rede'), json(503, {}), json(200, okBody)]);
  assert.equal(out.segments.length, 1);
  assert.deepEqual(waits, [3000, 5000, 12000]);

  await assert.rejects(() => run([json(429, {}, { 'retry-after': '600' })]), (e) => e.code === 'CLOUD_RATE_LIMIT' && /10 min/.test(e.message));
  await assert.rejects(() => run([json(401, {})]), (e) => e.code === 'CLOUD_AUTH' && /recusou a chave/.test(e.message));
  await assert.rejects(() => run([json(413, {})]), (e) => e.code === 'CLOUD_TOO_LARGE');
  await assert.rejects(() => run([json(400, { error: { message: `modelo inválido ${GROQ_KEY}` } })]), (e) => e.code === 'CLOUD_HTTP' && /modelo inválido \[chave\]/.test(e.message) && !e.message.includes(GROQ_KEY));
  await assert.rejects(() => run([new Error('a')]), (e) => e.code === 'CLOUD_NETWORK');
});

test('Groq: sem chave o erro manda configurar; cancelar interrompe', async () => {
  const noKey = new GroqTranscriber({ config: configWith(tmpDir()), fetchImpl: async () => json(200, {}), slice: fakeSlice });
  await assert.rejects(() => noKey.transcribe({ wav: 'x.wav', seconds: 3, work: tmpDir(), language: 'pt' }), (e) => e.code === 'NO_KEY');

  const controller = new AbortController();
  controller.abort();
  const groq = new GroqTranscriber({ config: configWith(tmpDir(), { groq: GROQ_KEY }), fetchImpl: async () => json(200, {}), slice: fakeSlice });
  await assert.rejects(() => groq.transcribe({ wav: 'x.wav', seconds: 3, work: tmpDir(), language: 'pt', signal: controller.signal }), (e) => e.code === 'CANCELLED');
});

// ------------------------------------------------------------------ ElevenLabs

test('ElevenLabs: um envio só, campos e cabeçalho certos; descarta espaços e eventos de áudio', async () => {
  const config = configWith(tmpDir(), { elevenlabs: ELEVEN_KEY });
  let seen = null;
  const fetchImpl = async (url, init) => {
    const f = init.body;
    seen = { url, key: init.headers['xi-api-key'], model: f.get('model_id'), gran: f.get('timestamps_granularity'), lang: f.get('language_code'), diarize: f.get('diarize'), events: f.get('tag_audio_events') };
    return json(200, {
      language_code: 'por',
      words: [
        { text: 'Bom', type: 'word', start: 0.1, end: 0.4 }, { text: ' ', type: 'spacing', start: 0.4, end: 0.5 },
        { text: 'dia.', type: 'word', start: 0.5, end: 0.9 }, { text: '(risos)', type: 'audio_event', start: 1, end: 1.5 },
        { text: 'Vamos', type: 'word', start: 2, end: 2.4 }, { text: 'começar', type: 'word', start: 2.5, end: 3 }
      ]
    });
  };
  const progress = [];
  const out = await new ElevenLabsTranscriber({ config, fetchImpl, slice: fakeSlice }).transcribe({ wav: 'x.wav', seconds: 3, work: tmpDir(), language: 'pt', onProgress: (f) => progress.push(f) });
  assert.deepEqual(seen, { url: 'https://api.elevenlabs.io/v1/speech-to-text', key: ELEVEN_KEY, model: 'scribe_v2', gran: 'word', lang: 'pt', diarize: 'false', events: 'false' });
  assert.deepEqual(out.words.map((w) => w.word), ['Bom', 'dia.', 'Vamos', 'começar']);
  assert.deepEqual(out.segments.map((s) => s.text), ['Bom dia.', 'Vamos começar']);
  assert.equal(out.language, 'por');
  assert.equal(progress.at(-1), 1);
});

test('ElevenLabs: créditos acabando, chave recusada e erro de validação viram mensagens claras', async () => {
  const config = configWith(tmpDir(), { elevenlabs: ELEVEN_KEY });
  const run = (reply) => new ElevenLabsTranscriber({ config, fetchImpl: async () => reply, slice: fakeSlice, sleep: async () => {} })
    .transcribe({ wav: 'x.wav', seconds: 3, work: tmpDir(), language: 'pt' });
  await assert.rejects(() => run(json(401, { detail: { status: 'quota_exceeded', message: 'x' } })), (e) => e.code === 'CLOUD_QUOTA' && /créditos/.test(e.message));
  await assert.rejects(() => run(json(401, { detail: { status: 'invalid_api_key' } })), (e) => e.code === 'CLOUD_AUTH');
  await assert.rejects(() => run(json(422, { detail: [{ loc: ['body'], msg: 'campo inválido', type: 'x' }] })), (e) => e.code === 'CLOUD_HTTP' && /campo inválido/.test(e.message));
});

test('segmentsFromWords: quebra por fim de frase, pausa longa e tamanho', () => {
  const w = (word, start, end) => ({ word, start, end });
  assert.deepEqual(segmentsFromWords([w('a', 0, 1), w('b.', 1, 2), w('c', 2.1, 3), w('d', 5, 6)]).map((s) => s.text), ['a b.', 'c', 'd']);
  const many = Array.from({ length: 90 }, (_, i) => w(`p${i}`, i * 0.3, i * 0.3 + 0.2));
  assert.ok(segmentsFromWords(many).every((s) => s.text.split(' ').length <= 40));
  assert.deepEqual(segmentsFromWords([]), []);
});

// ------------------------------------------------------------------ runner: escolha de motor e fallback

function runnerSetup(cloudStubs = {}, { withLocal = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-fallback-'));
  const modelDir = path.join(root, 'models', 'm');
  const engineDir = path.join(root, 'engine');
  fs.mkdirSync(engineDir, { recursive: true });
  if (withLocal) {
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'model.bin'), 'modelo');
    fs.writeFileSync(path.join(engineDir, CLI_FILE), 'x');
  }
  const media = path.join(root, 'aula.mp4');
  fs.writeFileSync(media, 'SECONDS=12');
  const runner = new WhisperCppRunner({
    engineDir, tempDir: path.join(root, 'tmp'), workRoot: path.join(root, 'work'),
    ffmpegPath: process.execPath, ffmpegBaseArgs: [FAKE_FFMPEG], cliCommand: process.execPath, cliBaseArgs: [FAKE_CLI], clouds: cloudStubs
  });
  return { root, media, runner, modelDir };
}

const stub = (label, behavior) => ({
  providerLabel: label, label: `${label} modelo`, calls: 0,
  async transcribe() {
    this.calls++;
    return behavior(this);
  }
});
const goodResult = { language: 'pt', segments: [{ start: 0, end: 2, text: 'Texto da nuvem.' }], words: [{ word: 'Texto', start: 0, end: 1 }, { word: 'da', start: 1, end: 1.5 }, { word: 'nuvem.', start: 1.5, end: 2 }], hasTokens: false };

test('runner: com motor de nuvem escolhido, usa só a nuvem e escreve a legenda com o texto dela', async () => {
  const groq = stub('Groq', () => goodResult);
  const s = runnerSetup({ groq }, { withLocal: false });
  const events = [];
  const res = await s.runner.run({ files: [s.media], srt: true, md: true, engine: 'groq' }, { onEvent: (e) => events.push(e) });
  assert.deepEqual([res.ok, res.failed, groq.calls], [1, 0, 1]);
  assert.match(fs.readFileSync(path.join(s.root, 'aula.srt'), 'utf8'), /Texto da nuvem/);
  assert.match(fs.readFileSync(path.join(s.root, 'aula.md'), 'utf8'), /modelo Groq modelo|Groq modelo/);
  assert.ok(events.some((e) => e.type === 'device' && e.text === 'Nuvem (Groq)'));
});

test('runner: se o serviço falha por causa do serviço, cai no próximo da lista (ElevenLabs, depois local)', async () => {
  const groq = stub('Groq', () => { throw new RunnerError('O limite de uso do Groq foi atingido. Tente de novo em instantes.', 'CLOUD_RATE_LIMIT'); });
  const eleven = stub('ElevenLabs', () => { throw new RunnerError('Os créditos do ElevenLabs acabaram.', 'CLOUD_QUOTA'); });
  const s = runnerSetup({ groq, elevenlabs: eleven });
  const events = [];
  const res = await s.runner.run({ files: [s.media], srt: true, engine: 'groq', fallback: ['elevenlabs', 'local'] }, { modelDir: s.modelDir, modelId: 'm', modelName: 'm', onEvent: (e) => events.push(e) });
  assert.deepEqual([res.ok, res.failed, groq.calls, eleven.calls], [1, 0, 1, 1]);
  const lines = events.filter((e) => e.type === 'line').map((e) => e.text);
  assert.ok(lines.some((t) => /O Groq não conseguiu .* Tentando O ElevenLabs/.test(t)), lines.join('\n'));
  assert.ok(lines.some((t) => /O ElevenLabs não conseguiu .* Tentando O motor deste computador/.test(t)), lines.join('\n'));
  assert.ok(fs.existsSync(path.join(s.root, 'aula.srt')));
});

test('runner: com o motor local escolhido não há fallback para a nuvem (o áudio não sai do computador)', async () => {
  const groq = stub('Groq', () => goodResult);
  const s = runnerSetup({ groq });
  fs.rmSync(path.join(s.modelDir, 'model.bin'));
  await assert.rejects(() => s.runner.run({ files: [s.media], srt: true, engine: 'local', fallback: ['groq'] }, { modelDir: s.modelDir }), (e) => e.code === 'NO_MODEL');
  assert.equal(groq.calls, 0);
});

test('runner: cancelamento e erro que não é do serviço não disparam o fallback', async () => {
  const groq = stub('Groq', () => { throw new RunnerError('Transcrição cancelada.', 'CANCELLED'); });
  const eleven = stub('ElevenLabs', () => goodResult);
  const s = runnerSetup({ groq, elevenlabs: eleven });
  await assert.rejects(() => s.runner.run({ files: [s.media], srt: true, engine: 'groq', fallback: ['elevenlabs'] }, { modelDir: s.modelDir }), (e) => e.code === 'CANCELLED');
  assert.equal(eleven.calls, 0);

  const bad = stub('Groq', () => { throw new RunnerError('O arquivo está corrompido.', 'DECODE'); });
  const s2 = runnerSetup({ groq: bad, elevenlabs: eleven });
  const res = await s2.runner.run({ files: [s2.media], srt: true, engine: 'groq', fallback: ['elevenlabs'] }, { modelDir: s2.modelDir });
  assert.deepEqual([res.ok, res.failed, eleven.calls], [0, 1, 0]);
});

test('runner: serviço sem chave (indisponível) e fallback sem chave são ignorados', async () => {
  const s = runnerSetup({}, { withLocal: false });
  await assert.rejects(() => s.runner.run({ files: [s.media], srt: true, engine: 'groq' }, {}), (e) => e.code === 'NO_KEY');
  const eleven = stub('ElevenLabs', () => goodResult);
  const s2 = runnerSetup({ elevenlabs: eleven }, { withLocal: false });
  const res = await s2.runner.run({ files: [s2.media], srt: true, engine: 'elevenlabs', fallback: ['groq', 'local'] }, {});
  assert.deepEqual([res.ok, eleven.calls], [1, 1]);
});

// ------------------------------------------------------------------ ModuleManager: escolha do motor

test('ModuleManager.transcribe: nuvem sem chave pede a chave; com chave transcreve sem o motor local instalado', async () => {
  const { ModuleManager } = require('../src/core/modules/ModuleManager');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-mm-'));
  const media = path.join(root, 'palestra.mp4');
  fs.writeFileSync(media, 'SECONDS=8');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, key: init.headers.Authorization });
    return json(200, { language: 'pt', segments: [{ start: 0, end: 3, text: 'Olá, mundo.' }], words: [{ word: 'Olá,', start: 0, end: 1 }, { word: 'mundo.', start: 1, end: 3 }] });
  };
  const build = (keys) => new ModuleManager({
    rootDir: path.join(root, 'data'), tempDir: path.join(root, 'tmp'),
    config: { platform: 'win32', ffmpegPath: () => process.execPath, ffmpegBaseArgs: [FAKE_FFMPEG], fetchImpl },
    cloudConfig: configWith(path.join(root, 'cfg'), keys)
  });

  await assert.rejects(() => build({}).transcribe({ files: [media], srt: true, engine: 'groq' }), (e) => e.code === 'NO_KEY');
  // motor local escolhido, mas não instalado: continua exigindo o motor (não troca para a nuvem sozinho)
  await assert.rejects(() => build({ groq: GROQ_KEY }).transcribe({ files: [media], srt: true, engine: 'local', fallback: ['groq'] }), (e) => e.code === 'NO_ENGINE' || e.code === 'NO_MODEL' || e.code === 'UNAVAILABLE' || /motor|modelo|Instale|Baixe/i.test(e.message));
  assert.equal(calls.length, 0);

  const res = await build({ groq: GROQ_KEY }).transcribe({ files: [media], srt: true, engine: 'groq' });
  assert.deepEqual([res.ok, res.failed], [1, 0]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, `Bearer ${GROQ_KEY}`);
  assert.match(fs.readFileSync(path.join(root, 'palestra.srt'), 'utf8'), /Olá, mundo\./);
});
