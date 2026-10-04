'use strict';

// Mensagens de erro da interface: humanas, sem nomes de motores nem "Spotify".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'utils', 'friendlyError.js')).href);
const FORBIDDEN = /yt-dlp|ffmpeg|ffprobe|whisper|ggml|spotdl|untrunc|exiftool|sqlite|cuda|spotify|electron|stream copy/i;

test('friendlyError traduz erros comuns com a próxima ação', async () => {
  const { friendlyError } = await load();
  assert.match(friendlyError('ENOSPC: no space left on device'), /espaço livre/);
  assert.match(friendlyError(new Error("Error invoking remote method 'x': Error: spawn ffmpeg ENOENT")), /Não encontrei o arquivo/);
  assert.match(friendlyError('moov atom not found'), /corrompido/);
  assert.match(friendlyError('Erro ao ler os metadados do arquivo'), /Não foi possível ler/);
  assert.match(friendlyError('Nenhum arquivo foi processado. Erro ao ler o arquivo'), /Nenhum arquivo foi processado\. Não foi possível ler/);
  assert.match(friendlyError('getaddrinfo ENOTFOUND www.youtube.com'), /internet/);
  assert.match(friendlyError('EBUSY: resource busy'), /em uso/);
});

test('friendlyError nunca expõe nomes de motores', async () => {
  const { friendlyError, cleanText } = await load();
  for (const raw of ['yt-dlp: boom', 'whisper.cpp falhou com exit code 3', 'ffmpeg exited', 'Falha no Spotify', 'ggml-small.bin inválido', 'exiftool crashed', 'CUDA error 700']) {
    assert.doesNotMatch(friendlyError(raw), FORBIDDEN, raw);
    assert.doesNotMatch(cleanText(raw), FORBIDDEN, raw);
  }
  assert.equal(friendlyError('', 'Padrão'), 'Padrão');
});
