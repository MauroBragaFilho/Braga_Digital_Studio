'use strict';

// Endurecimento (RK-053, 057, 058, 061, 094, 096, 054): redact, ToolRunner, FfmpegLimiter,
// validação de .bdspro, segredos em settings.json, saveConfig da IA e poda de logs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { budget } = require('./helpers/timing');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `bds-${p}-`));

// ----------------------------------------------------------------------------- redact (RK-057)

const { redact, redactDeep, MAX_INPUT_CHARS } = require('../src/services/redact');

test('redact: entrada de 80.000 caracteres sem "@" termina rápido (regex de e-mail não é mais quadrática)', () => {
  const big = 'a'.repeat(80000);
  const t0 = Date.now();
  const out = redact(big);
  assert.ok(Date.now() - t0 < budget(1500), `demorou ${Date.now() - t0} ms`);
  assert.ok(out.length <= MAX_INPUT_CHARS + 100, 'entrada limitada a ~64 KB');
  assert.match(out, /truncado/);

  const withAt = `${'x.'.repeat(40000)}@`;
  const t1 = Date.now();
  redact(withAt);
  assert.ok(Date.now() - t1 < budget(1500));
});

test('redact: e-mails são mascarados (mantém o do desenvolvedor) e texto comum fica intacto', () => {
  assert.equal(redact('contato: maria.silva+x@exemplo.com.br, ok'), 'contato: [email], ok');
  assert.equal(redact('a@b e @usuario e fim@'), 'a@b e @usuario e fim@'); // sem domínio com ponto: não é e-mail
  assert.equal(redact('sem nada sensível'), 'sem nada sensível');
});

test('redact: mascara por nome de chave (password, token, apiKey, secret...) em objetos', () => {
  const out = redactDeep({
    user: 'ana', password: 'abc', Token: { nested: 1 }, apiKey: 'k', client_secret: 'shh',
    authorization: 'Bearer x', cookie: 'a=b', tokens: 5, hasPassword: true, nome: 'ok'
  });
  assert.equal(out.password, '[redacted]');
  assert.equal(out.Token, '[redacted]');
  assert.equal(out.apiKey, '[redacted]');
  assert.equal(out.client_secret, '[redacted]');
  assert.equal(out.authorization, '[redacted]');
  assert.equal(out.cookie, '[redacted]');
  assert.equal(out.tokens, 5, 'números (contagem de tokens) não são mascarados');
  assert.equal(out.hasPassword, true);
  assert.equal(out.nome, 'ok');
  assert.equal(out.user, 'ana');
});

test('redactDeep: Date, Buffer, Map, Set, URL e ciclos não são corrompidos', () => {
  const d = new Date('2026-01-02T03:04:05.000Z');
  const cyc = { a: 1 }; cyc.self = cyc;
  const out = redactDeep({
    d, buf: Buffer.from('segredo'), map: new Map([['k', 'v'], ['token', 'zzz']]), set: new Set([1, 2]),
    url: new URL('https://exemplo.com/p?token=abc'), big: 10n, cyc, err: Object.assign(new Error('falhou'), { code: 'E1' })
  });
  assert.equal(out.d, '2026-01-02T03:04:05.000Z');
  assert.equal(out.buf, '[Buffer 7 bytes]');
  assert.deepEqual(out.map, { k: 'v', token: '[redacted]' });
  assert.deepEqual(out.set, [1, 2]);
  assert.equal(out.url, 'https://exemplo.com/p?[redacted]');
  assert.equal(out.big, '10');
  assert.equal(out.cyc.self, '[circular]');
  assert.equal(out.err.message, 'falhou');
  assert.equal(out.err.code, 'E1');
  assert.doesNotThrow(() => JSON.stringify(out));
});

// ----------------------------------------------------------------------------- ToolRunner (RK-094)

const { toolRunner } = require('../src/infrastructure/external-tools/ToolRunner');

test('ToolRunner: última linha sem quebra, UTF-8 partido entre chunks e saída grande sem travar', async () => {
  const script = [
    "const b = Buffer.from('ação é ✓', 'utf8');",
    'process.stdout.write(b.subarray(0, 3));',
    'setTimeout(() => { process.stdout.write(b.subarray(3)); }, 30);'
  ].join('\n');
  const lines = [];
  const r = await toolRunner.run(process.execPath, ['-e', script], { onStdout: (l) => lines.push(l) });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'ação é ✓');
  assert.deepEqual(lines, ['ação é ✓'], 'a última linha sem \\n é entregue');

  const t0 = Date.now();
  const big = await toolRunner.run(process.execPath, ['-e', "process.stdout.write('x'.repeat(20 * 1024 * 1024))"]);
  assert.equal(big.stdout.length, 20 * 1024 * 1024);
  assert.ok(Date.now() - t0 < budget(8000));
});

test('ToolRunner: maxBytes mata o processo e devolve truncated', async () => {
  const script = "const t = setInterval(() => process.stdout.write('y'.repeat(100000)), 1); setTimeout(() => clearInterval(t), 20000);";
  const r = await toolRunner.run(process.execPath, ['-e', script], { maxBytes: 500000, timeout: 15000 });
  assert.equal(r.truncated, true);
  assert.equal(r.killed, true);
  assert.ok(r.stdout.length <= 500000 + 200000);
});

// ----------------------------------------------------------------------------- FfmpegLimiter (RK-096)

const { FfmpegLimiter } = require('../src/core/media/FfmpegLimiter');

test('FfmpegLimiter: watchdog libera o slot de uma tarefa travada e avisa o AbortSignal', async () => {
  const lim = new FfmpegLimiter(1, { taskTimeoutMs: 60 });
  let aborted = false;
  const hung = lim.run((signal) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); })).catch((e) => e.code);
  const next = await lim.run(async () => 'ok');
  assert.equal(await hung, 'LIMITER_TIMEOUT');
  assert.equal(next, 'ok');
  assert.equal(aborted, true);
  assert.equal(lim.active, 0);
});

test('FfmpegLimiter: tarefa normal continua funcionando e propaga erro', async () => {
  const lim = new FfmpegLimiter(2, { taskTimeoutMs: 1000 });
  assert.equal(await lim.run(() => 42), 42);
  await assert.rejects(lim.run(() => { throw new Error('x'); }), /x/);
  assert.equal(lim.active, 0);
});

// ----------------------------------------------------------------------------- .bdspro (RK-053)

const BdsproPackageService = require('../src/core/projects/BdsproPackageService');

function writeBdspro(dir, projectJson, extra = {}) {
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(typeof projectJson === 'string' ? projectJson : JSON.stringify(projectJson)));
  for (const [name, content] of Object.entries(extra)) zip.addFile(name, Buffer.from(content));
  const p = path.join(dir, 'p.bdspro');
  zip.writeZip(p);
  return p;
}

test('.bdspro: valida schema (uuid, cor, capa) e recusa estruturas inválidas e UNC', () => {
  const dir = tmp('bdspro');
  const p = writeBdspro(dir, {
    metadata: { name: 'X', color: 'red;background:url(x)', cover_relative_path: '../../evil.jpg' },
    media: [{ uuid: '..\\..\\fora', filename: 'a.mp4' }, { uuid: 'abc-123_OK', filename: 'b.mp4' }]
  });
  const { projectData } = BdsproPackageService.readBdsproPackage(p);
  assert.equal(projectData.metadata.color, '#3b82f6');
  assert.equal(projectData.metadata.cover_relative_path, null);
  assert.equal(projectData.media[0].uuid, null);
  assert.equal(projectData.media[1].uuid, 'abc-123_OK');

  assert.throws(() => BdsproPackageService.readBdsproPackage(writeBdspro(dir, '[1,2]')), /inválido/);
  assert.throws(() => BdsproPackageService.readBdsproPackage(writeBdspro(dir, { media: 'x' })), /lista/);
  assert.throws(() => BdsproPackageService.readBdsproPackage('\\\\servidor\\share\\p.bdspro'), /UNC/);
  assert.equal(BdsproPackageService.isUncPath('\\\\srv\\a'), true);
  assert.equal(BdsproPackageService.isUncPath('//srv/a'), true);
  assert.equal(BdsproPackageService.isUncPath('C:\\a'), false);
});

test('.bdspro: importBdspro recusa mídia com caminho UNC sem relink e inspect não consulta UNC', async () => {
  const dir = tmp('bdspro2');
  const p = writeBdspro(dir, { metadata: { name: 'Rede' }, media: [{ id: 1, uuid: 'u1', filename: 'a.mp4', original_path: '\\\\servidor\\share\\a.mp4' }] });
  const svc = new BdsproPackageService({ db: { exec() { throw new Error('não deveria abrir transação'); } } });
  await assert.rejects(svc.importBdspro(p, {}, path.join(dir, 't'), path.join(dir, 'c')), /UNC/);
  const info = await svc.inspectBdspro(p);
  assert.equal(info.missingMediaCount, 1);
  assert.equal(info.availableMediaCount, 0);
});

// ----------------------------------------------------------------------------- segredos (RK-054)

const SettingsManager = require('../src/core/settings/SettingsManager');

test('settings.json: segredo é gravado criptografado (safeStorage) e lido de volta', () => {
  const dir = tmp('settings');
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`ENC:${s}`),
    decryptString: (b) => b.toString().replace(/^ENC:/, '')
  };
  const m = new SettingsManager(dir, dir);
  m.secretKeys = ['testSecret']; // chave de teste: o mecanismo é genérico
  m.safeStorage = fake;
  m.save({ testSecret: '123456:SEGREDO' });
  const raw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.ok(!raw.includes('SEGREDO'), 'texto puro não pode ir para o disco');
  assert.ok(JSON.parse(raw).testSecretEnc);

  const m2 = new SettingsManager(dir, dir);
  m2.secretKeys = ['testSecret'];
  m2.safeStorage = fake;
  const loaded = m2.load();
  assert.equal(loaded.testSecret, '123456:SEGREDO');
  assert.equal('testSecretEnc' in loaded, false);
});

test('settings.json: segredo legado em texto puro é migrado para a forma criptografada no primeiro load', () => {
  const dir = tmp('settings2');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ testSecret: 'LEGADO:TOKEN' }));
  const fake = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`ENC:${s}`), decryptString: (b) => b.toString().replace(/^ENC:/, '') };
  const m = new SettingsManager(dir, dir);
  m.secretKeys = ['testSecret'];
  m.safeStorage = fake;
  assert.equal(m.load().testSecret, 'LEGADO:TOKEN');
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('LEGADO:TOKEN'));
});

test('settings.json: sem criptografia disponível mantém o comportamento anterior', () => {
  const dir = tmp('settings3');
  const m = new SettingsManager(dir, dir);
  m.secretKeys = ['testSecret'];
  m.safeStorage = { isEncryptionAvailable: () => false };
  m.save({ testSecret: 'abc' });
  assert.equal(new SettingsManager(dir, dir).load().testSecret, 'abc');
});

// ----------------------------------------------------------------------------- IA saveConfig (RK-061)

const AIService = require('../src/services/ai/AIService');

test('IA: mudar o host da baseUrl apaga a chave guardada; validação falha sem alterar a configuração', () => {
  const dir = tmp('ai');
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
  const ai = new AIService({ configDir: dir, safeStorage });
  ai.saveConfig({ apiKey: 'sk-test-1234567890' });
  assert.equal(ai.getPublicConfig().hasKey, true);

  // mesma origem: mantém a chave
  ai.saveConfig({ baseUrl: 'https://api.openai.com/v1/', model: 'gpt-x' });
  assert.equal(ai.getPublicConfig().hasKey, true);

  // host diferente: a chave é apagada (não é reenviada a um servidor novo)
  const pub = ai.saveConfig({ baseUrl: 'https://outro.exemplo.com/v1' });
  assert.equal(pub.hasKey, false);

  // patch inválido não altera nada (aplicado sobre cópia)
  ai.saveConfig({ apiKey: 'sk-test-1234567890' });
  const before = ai.getPublicConfig();
  assert.throws(() => ai.saveConfig({ baseUrl: 'https://novo.exemplo.org/v1', maxTokens: 5 }), /tokens/);
  const after = ai.getPublicConfig();
  assert.equal(after.baseUrl, before.baseUrl);
  assert.equal(after.hasKey, true);
});

// ----------------------------------------------------------------------------- poda de logs (RK-058)

test('logService: pruneOldLogs remove só .log com mais de 14 dias', async () => {
  const dir = tmp('logs');
  process.env.BMD_LOGS_DIR = dir;
  const logger = require('../src/services/logService');
  const old = path.join(dir, '2020-01-01.log');
  const recent = path.join(dir, '2999-01-01.log');
  const other = path.join(dir, 'notas.txt');
  for (const f of [old, recent, other]) fs.writeFileSync(f, 'x');
  const past = new Date(Date.now() - 20 * 24 * 3600 * 1000);
  fs.utimesSync(old, past, past);
  fs.utimesSync(other, past, past);
  const removed = await logger.pruneOldLogs(dir, 14);
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(old) && fs.existsSync(recent) && fs.existsSync(other));
});
