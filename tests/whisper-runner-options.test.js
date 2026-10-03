'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WhisperEngineRunner, normalizeOptions, parseLogLine } = require('../src/core/modules/WhisperEngineRunner');

test('parseLogLine: eventos por arquivo (n começa em 1, índice sai a partir de 0)', () => {
  assert.deepEqual(parseLogLine('[file] 1 start'), { type: 'file', index: 0, state: 'start' });
  assert.deepEqual(parseLogLine('[file] 3 progress 42.5'), { type: 'file', index: 2, state: 'progress', percent: 42.5 });
  assert.deepEqual(parseLogLine('[file] 2 done'), { type: 'file', index: 1, state: 'done' });
  assert.deepEqual(parseLogLine('[file] 4 error Nenhuma fala foi detectada'), { type: 'file', index: 3, state: 'error', text: 'Nenhuma fala foi detectada' });
  assert.equal(parseLogLine('[file] 2 progress abc'), null);
  // limites do progresso
  assert.equal(parseLogLine('[file] 1 progress 250').percent, 100);
  // os eventos antigos continuam iguais
  assert.deepEqual(parseLogLine('[progress] 12.5'), { type: 'progress', percent: 12.5 });
  assert.deepEqual(parseLogLine('RESULTADO ok=2 falhas=1 [GPU (CUDA)] (9 s)'), { type: 'result', ok: 2, failed: 1, device: 'GPU (CUDA)' });
});

test('normalizeOptions: linhas por legenda é 1 ou 2 (padrão 2)', () => {
  const media = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bds-opt-')), 'a.wav');
  fs.writeFileSync(media, 'x');
  assert.equal(normalizeOptions({ files: [media] }).lines, 2);
  assert.equal(normalizeOptions({ files: [media], lines: 1 }).lines, 1);
  assert.throws(() => normalizeOptions({ files: [media], lines: 3 }), (e) => e.code === 'BAD_OPTION');
  assert.throws(() => normalizeOptions({ files: [media], lines: 0 }), (e) => e.code === 'BAD_OPTION');
  assert.throws(() => normalizeOptions({ files: [media], srt: false, md: false }), (e) => e.code === 'NO_OUTPUT');
});

test('run: repassa --palavras/--linhas, o nome do modelo e emite eventos por arquivo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-run-'));
  const model = path.join(dir, 'modelo');
  fs.mkdirSync(model);
  fs.writeFileSync(path.join(model, 'model.bin'), 'x');
  const media = path.join(dir, 'aula.wav');
  fs.writeFileSync(media, 'x');

  // "Motor" falso em Node: grava os argumentos/ambiente recebidos e responde pelo contrato.
  const fake = path.join(dir, 'fake.js');
  fs.writeFileSync(fake, `
    const fs = require('fs'), path = require('path');
    const args = process.argv.slice(2);
    const file = args[args.length - 1];
    fs.writeFileSync(path.join(path.dirname(file), 'recebido.json'), JSON.stringify({ args, name: process.env.WL_MODEL_NAME }));
    fs.writeFileSync(path.join(path.dirname(file), 'aula.srt'), '1\\n');
    fs.appendFileSync(process.env.WL_LOG, '[file] 1 start\\n[file] 1 progress 50\\n[file] 1 done\\nRESULTADO ok=1 falhas=0 [CPU]\\n');
  `);

  const runner = new WhisperEngineRunner({ engineDir: dir, tempDir: path.join(dir, 'tmp'), command: process.execPath, baseArgs: [fake] });
  const events = [];
  const res = await runner.run(
    { files: [media], srt: true, md: false, maxWords: 5, lines: 1 },
    { modelDir: model, modelName: 'small', onEvent: (e) => events.push(e) }
  );

  assert.equal(res.ok, 1);
  const got = JSON.parse(fs.readFileSync(path.join(dir, 'recebido.json'), 'utf8'));
  assert.equal(got.name, 'small');
  const joined = got.args.join(' ');
  assert.match(joined, /--cli jobs --srt/);
  assert.match(joined, /--palavras 5/);
  assert.match(joined, /--linhas 1/);
  assert.ok(!got.args.includes('--md'));
  assert.deepEqual(events.filter((e) => e.type === 'file').map((e) => e.state), ['start', 'progress', 'done']);
});

test('run: sem SRT não envia --linhas (só vale para a legenda)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-run2-'));
  const model = path.join(dir, 'm');
  fs.mkdirSync(model);
  fs.writeFileSync(path.join(model, 'model.bin'), 'x');
  const media = path.join(dir, 'a.wav');
  fs.writeFileSync(media, 'x');
  const fake = path.join(dir, 'fake.js');
  fs.writeFileSync(fake, `
    const fs = require('fs'), path = require('path');
    fs.writeFileSync(path.join(path.dirname(process.argv[process.argv.length - 1]), 'args.json'), JSON.stringify(process.argv.slice(2)));
    fs.writeFileSync(path.join(path.dirname(process.argv[process.argv.length - 1]), 'a.md'), '#');
    fs.appendFileSync(process.env.WL_LOG, 'RESULTADO ok=1 falhas=0 [CPU]\\n');
  `);
  const runner = new WhisperEngineRunner({ engineDir: dir, tempDir: path.join(dir, 'tmp'), command: process.execPath, baseArgs: [fake] });
  await runner.run({ files: [media], srt: false, md: true, lines: 2 }, { modelDir: model });
  const args = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
  assert.ok(!args.includes('--linhas'));
  assert.ok(args.includes('--md'));
});
