'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { maskEngineNames, ENGINE_NAME_RULES } = require('../src/services/engineNames');

const SAMPLES = [
  ['yt-dlp finalizou com código 1', 'Motor de download finalizou com código 1'],
  ['Falha ao ler JSON do yt-dlp: x', 'Falha ao ler JSON do motor de download: x'],
  ['ERROR: youtube-dl não encontrou', 'ERROR: Motor de download não encontrou'],
  ['SpotDL e spotify-dlp e spot-dlp', 'Motor de download e motor de download e motor de download'],
  ['FFmpeg não gerou o arquivo', 'Motor de mídia não gerou o arquivo'],
  ['Lendo com ffprobe...', 'Lendo com analisador de mídia...'],
  ['Untrunc falhou. RawRecoveryEngine falhou', 'Motor de recuperação falhou. Motor de recuperação falhou'],
  ['usa o Deno para scripts', 'usa o componente de apoio para scripts'],
];

test('troca os nomes dos motores por termos genéricos', () => {
  for (const [input, expected] of SAMPLES) assert.equal(maskEngineNames(input), expected);
});

test('não altera palavras parecidas nem textos sem motor', () => {
  for (const text of ['Spotify Track', 'denominação social', 'Convertendo vídeo...', '']) {
    assert.equal(maskEngineNames(text), text);
  }
});

test('valores que não são texto passam sem alteração', () => {
  assert.equal(maskEngineNames(undefined), undefined);
  assert.equal(maskEngineNames(null), null);
  assert.equal(maskEngineNames(42), 42);
});

test('a versão do renderer tem o mesmo comportamento e a mesma tabela', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'utils', 'engineNames.js')).href);
  for (const [input] of SAMPLES) assert.equal(mod.maskEngineNames(input), maskEngineNames(input));
  assert.equal(ENGINE_NAME_RULES.length, 6);
});
