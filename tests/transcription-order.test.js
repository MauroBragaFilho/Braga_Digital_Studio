'use strict';

// Ordem dos motores de transcrição (Provedores → Áudio), modo Automático e chave compartilhada com o provedor de chat.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const order = require('../src/core/transcription/order');
const { CloudConfig } = require('../src/core/transcription/CloudConfig');
const { OpenAITranscriber, GroqTranscriber } = require('../src/core/transcription/GroqTranscriber');
const { WhisperCppRunner, RunnerError } = require('../src/core/modules/WhisperCppRunner');
const SettingsManager = require('../src/core/settings/SettingsManager');
const AIService = require('../src/services/ai/AIService');

const FAKE_CLI = path.join(__dirname, 'fixtures', 'fake-whisper-cli.js');
const FAKE_FFMPEG = path.join(__dirname, 'fixtures', 'fake-ffmpeg.js');
const CLI_FILE = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const GROQ_KEY = 'gsk_abcdefghijklmnopqrstuvwxyz0123456789';

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`),
  decryptString: (b) => [...b.toString().slice(4)].reverse().join('')
};
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-order-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// ------------------------------------------------------------------ order.js e configurações

test('ordem: ids desconhecidos e repetidos saem; a ordem recebida é mantida; o que faltar entra no fim', () => {
  assert.deepEqual(order.sanitizeEngines(['groq', 'x', 'groq', 'local']), ['groq', 'local']);
  assert.deepEqual(order.completeOrder(['elevenlabs']).slice(0, 1), ['elevenlabs']);
  assert.deepEqual([...order.completeOrder(['elevenlabs'])].sort(), [...order.ENGINE_IDS].sort());
  assert.deepEqual(order.completeOrder('lixo'), [...order.ENGINE_IDS]);
});

test('Automático: só os ligados, na ordem escolhida; sem nenhum ligado, só este computador', () => {
  assert.deepEqual(order.autoEngines({}), ['local'], 'de fábrica: só o computador');
  assert.deepEqual(order.autoEngines({ transcriptionOrder: ['elevenlabs', 'groq', 'local'], transcriptionFallback: ['groq', 'elevenlabs'] }), ['elevenlabs', 'groq']);
  assert.deepEqual(order.autoEngines({ transcriptionOrder: ['groq', 'local'], transcriptionFallback: ['local', 'groq'] }), ['groq', 'local']);
  assert.deepEqual(order.autoEngines({ transcriptionOrder: ['groq'], transcriptionFallback: [] }), ['local']);
  assert.deepEqual(order.autoEngines({ transcriptionFallback: ['lixo'] }), ['local']);
});

test('SettingsManager: a ordem e os ligados são gravados e relidos; o padrão deixa só o computador ligado', () => {
  const dir = tmp();
  const manager = new SettingsManager(dir, dir);
  const first = manager.load();
  assert.deepEqual(first.transcriptionFallback, ['local']);
  assert.deepEqual([...first.transcriptionOrder].sort(), [...order.ENGINE_IDS].sort());
  manager.save({ transcriptionOrder: ['groq', 'local'], transcriptionFallback: ['groq', 'local'] });
  const again = new SettingsManager(dir, dir).load();
  assert.deepEqual(again.transcriptionOrder.slice(0, 2), ['groq', 'local']);
  assert.deepEqual(again.transcriptionFallback, ['groq', 'local']);
  // salvar outra coisa não mexe na ordem
  manager.save({ theme: 'light' });
  assert.deepEqual(new SettingsManager(dir, dir).load().transcriptionFallback, ['groq', 'local']);
});

// ------------------------------------------------------------------ runner: cadeia

function runnerSetup(clouds, { withLocal = true } = {}) {
  const root = tmp();
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
    ffmpegPath: process.execPath, ffmpegBaseArgs: [FAKE_FFMPEG], cliCommand: process.execPath, cliBaseArgs: [FAKE_CLI], clouds
  });
  return { root, media, runner, modelDir };
}
const good = { language: 'pt', segments: [{ start: 0, end: 2, text: 'Texto da nuvem.' }], words: [{ word: 'Texto', start: 0, end: 1 }, { word: 'nuvem.', start: 1, end: 2 }], hasTokens: false };
const stub = (label, behavior) => ({ providerLabel: label, label: `${label} modelo`, calls: 0, async transcribe() { this.calls++; return behavior(this); } });
const quota = (who) => () => { throw new RunnerError(`Os créditos do ${who} acabaram.`, 'CLOUD_QUOTA'); };

test('cadeia: a ordem escolhida manda (ElevenLabs primeiro, depois Groq)', async () => {
  const seen = [];
  const eleven = stub('ElevenLabs', () => { seen.push('eleven'); return good; });
  const groq = stub('Groq', () => { seen.push('groq'); return good; });
  const s = runnerSetup({ groq, elevenlabs: eleven }, { withLocal: false });
  const res = await s.runner.run({ files: [s.media], srt: true, chain: ['elevenlabs', 'groq'] }, {});
  assert.deepEqual([res.ok, seen], [1, ['eleven']], 'o primeiro pronto transcreve e os outros nem são chamados');
  assert.equal(groq.calls, 0);
});

test('cadeia: se o primeiro falha por causa do serviço, o próximo da ordem continua (inclusive o local)', async () => {
  const groq = stub('Groq', quota('Groq'));
  const eleven = stub('ElevenLabs', quota('ElevenLabs'));
  const s = runnerSetup({ groq, elevenlabs: eleven });
  const res = await s.runner.run({ files: [s.media], srt: true, chain: ['groq', 'elevenlabs', 'local'] }, { modelDir: s.modelDir, modelId: 'm', modelName: 'm' });
  assert.deepEqual([res.ok, res.failed, groq.calls, eleven.calls], [1, 0, 1, 1]);
  assert.ok(fs.existsSync(path.join(s.root, 'aula.srt')));
});

test('cadeia: motor sem chave é pulado; sem nenhum pronto, o erro manda para as configurações', async () => {
  const eleven = stub('ElevenLabs', () => good);
  const s = runnerSetup({ elevenlabs: eleven }, { withLocal: false });
  const res = await s.runner.run({ files: [s.media], srt: true, chain: ['groq', 'elevenlabs'] }, {});
  assert.deepEqual([res.ok, eleven.calls], [1, 1], 'o Groq não tem chave: pulado');
  const none = runnerSetup({}, { withLocal: false });
  await assert.rejects(() => none.runner.run({ files: [none.media], srt: true, chain: ['groq', 'local'] }, {}), (e) => e.code === 'NO_ENGINE' && /Inteligência Artificial/.test(e.message));
});

test('PRIVACIDADE: motor local escolhido continua sem cair na nuvem, com ou sem lista de reserva', async () => {
  const groq = stub('Groq', () => good);
  const s = runnerSetup({ groq });
  fs.rmSync(path.join(s.modelDir, 'model.bin'));
  await assert.rejects(() => s.runner.run({ files: [s.media], srt: true, engine: 'local', fallback: ['groq'] }, { modelDir: s.modelDir }), (e) => e.code === 'NO_MODEL');
  assert.equal(groq.calls, 0);
});

// ------------------------------------------------------------------ chave compartilhada com o chat

test('CloudConfig: sem chave própria usa a do chat do MESMO endereço; a própria tem prioridade; nunca vai a outro endereço', () => {
  const asked = [];
  const sharedKey = (host) => { asked.push(host); return host === 'api.groq.com' ? GROQ_KEY : ''; };
  const config = new CloudConfig({ configDir: tmp(), safeStorage, sharedKey });
  const groq = () => config.getPublic().providers.find((p) => p.id === 'groq');
  const eleven = () => config.getPublic().providers.find((p) => p.id === 'elevenlabs');
  assert.deepEqual([groq().hasKey, groq().keySource], [true, 'chat']);
  assert.deepEqual([eleven().hasKey, eleven().keySource], [false, null], 'a ElevenLabs tem outro endereço: nada compartilhado');
  assert.equal(config.readKey('groq'), GROQ_KEY);
  assert.equal(config.readKey('elevenlabs'), '');
  assert.ok(asked.every((h) => /^api\.(groq\.com|openai\.com|elevenlabs\.io)$/.test(h)), 'só os endereços fixos dos serviços são consultados');
  assert.ok(!JSON.stringify(config.getPublic()).includes(GROQ_KEY), 'a chave nunca volta para a interface');

  const own = 'gsk_propria0123456789abcdefghijklmnopqrst';
  config.set({ provider: 'groq', apiKey: own });
  assert.deepEqual([groq().keySource, config.readKey('groq')], ['own', own]);
  config.set({ provider: 'groq', clearApiKey: true });
  assert.equal(groq().keySource, 'chat', 'sem a própria, volta a valer a do chat');
});

test('AIService.keyForHost: só provedor ligado, com chave, aviso aceito e o host exato', () => {
  const ai = new AIService({ configDir: tmp(), safeStorage });
  ai.saveConfig({ addProvider: { preset: 'groq' } });
  const id = ai.getPublicConfig().providers[0].id;
  assert.equal(ai.keyForHost('api.groq.com'), '', 'sem chave');
  ai.saveConfig({ provider: { id, apiKey: GROQ_KEY } });
  assert.equal(ai.keyForHost('api.groq.com'), '', 'aviso de servidor externo ainda pendente');
  ai.saveConfig({ provider: { id, acceptRemote: true } });
  assert.equal(ai.keyForHost('api.groq.com'), GROQ_KEY);
  assert.equal(ai.keyForHost('API.GROQ.COM'), GROQ_KEY, 'maiúsculas não importam');
  assert.equal(ai.keyForHost('api.groq.com.outro.site'), '', 'host parecido não vale');
  assert.equal(ai.keyForHost('api.elevenlabs.io'), '');
  assert.equal(ai.keyForHost(''), '');
  ai.saveConfig({ provider: { id, enabled: false } });
  assert.equal(ai.keyForHost('api.groq.com'), '', 'provedor desligado');
});

// ------------------------------------------------------------------ OpenAI como motor de áudio

const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
const json = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body });
const fakeSlice = async (wav, start, length, out) => { fs.writeFileSync(out, `audio ${start}-${length}`); };

test('OpenAI: lista de serviços ganha a OpenAI entre o Groq e a ElevenLabs; a chave tem o formato validado', () => {
  const config = new CloudConfig({ configDir: tmp(), safeStorage });
  assert.deepEqual(config.getPublic().providers.map((p) => p.id), ['groq', 'openai', 'elevenlabs']);
  assert.deepEqual(order.ENGINE_IDS, ['local', 'groq', 'openai', 'elevenlabs']);
  assert.throws(() => config.set({ provider: 'openai', apiKey: 'gsk_naoeachavedaopenai0123456789' }), /parece inválida/);
  assert.equal(config.set({ provider: 'openai', apiKey: OPENAI_KEY }).providers.find((p) => p.id === 'openai').hasKey, true);
  assert.equal(config.readKey('openai'), OPENAI_KEY);
  assert.ok(!JSON.stringify(config.getPublic()).includes(OPENAI_KEY));
});

test('OpenAI: envia ao endereço e ao modelo certos, com a chave só dela, e junta os tempos', async () => {
  const config = new CloudConfig({ configDir: tmp(), safeStorage });
  config.set({ provider: 'openai', apiKey: OPENAI_KEY });
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, auth: init.headers.Authorization, model: init.body.get('model'), format: init.body.get('response_format') });
    return json(200, { language: 'portuguese', segments: [{ start: 0, end: 3, text: ' Olá.' }], words: [{ word: 'Olá.', start: 0, end: 1 }] });
  };
  const events = [];
  const out = await new OpenAITranscriber({ config, fetchImpl, slice: fakeSlice, chunkSeconds: 10 })
    .transcribe({ wav: 'x.wav', seconds: 15, work: tmp(), language: 'pt', onEvent: (e) => events.push(e) });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], { url: 'https://api.openai.com/v1/audio/transcriptions', auth: `Bearer ${OPENAI_KEY}`, model: 'whisper-1', format: 'verbose_json' });
  assert.deepEqual(out.segments.map((s) => [s.start, s.text]), [[0, 'Olá.'], [10, 'Olá.']]);
  assert.ok(events.some((e) => /trecho 2 de 2 à OpenAI/.test(e.text)), events.map((e) => e.text).join('|'));
});

test('OpenAI: sem chave manda configurar; o Groq continua falando com o endereço dele', async () => {
  const config = new CloudConfig({ configDir: tmp(), safeStorage });
  await assert.rejects(() => new OpenAITranscriber({ config, fetchImpl: async () => json(200, {}), slice: fakeSlice }).transcribe({ wav: 'x.wav', seconds: 2, work: tmp(), language: 'pt' }), (e) => e.code === 'NO_KEY' && /OpenAI/.test(e.message));
  config.set({ provider: 'groq', apiKey: GROQ_KEY });
  const urls = [];
  await new GroqTranscriber({ config, fetchImpl: async (url) => { urls.push(String(url)); return json(200, { segments: [], words: [] }); }, slice: fakeSlice }).transcribe({ wav: 'x.wav', seconds: 2, work: tmp(), language: 'pt' });
  assert.deepEqual(urls, ['https://api.groq.com/openai/v1/audio/transcriptions']);
});

test('OpenAI: a chave do provedor de chat OpenAI vale também para a transcrição (mesmo endereço)', () => {
  const ai = new AIService({ configDir: tmp(), safeStorage });
  ai.saveConfig({ addProvider: { preset: 'openai' } });
  const id = ai.getPublicConfig().providers[0].id;
  ai.saveConfig({ provider: { id, apiKey: OPENAI_KEY, acceptRemote: true } });
  const config = new CloudConfig({ configDir: tmp(), safeStorage, sharedKey: (host) => ai.keyForHost(host) });
  const openai = config.getPublic().providers.find((p) => p.id === 'openai');
  assert.deepEqual([openai.hasKey, openai.keySource], [true, 'chat']);
  assert.equal(config.readKey('openai'), OPENAI_KEY);
  assert.equal(config.readKey('groq'), '', 'a chave da OpenAI não vai para o Groq');
});
