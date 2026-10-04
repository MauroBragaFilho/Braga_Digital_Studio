'use strict';

// Downloads: link de um item dentro de uma playlist pergunta "só este item" ou "playlist inteira".
// Monta o shell real (index.html + app.js): o app.js é importado uma única vez por processo, então todos os
// cenários compartilham uma montagem e controlam os dados pelas variáveis abaixo.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const added = [];
const inspected = [];
const expanded = [];
let playlistItems = [];
let h;

const VIDEO_COM_LISTA = 'https://www.youtube.com/watch?v=AAA111&list=PLxyz';
const SOMENTE_PLAYLIST = 'https://www.youtube.com/playlist?list=PLxyz';
const VIDEO_SIMPLES = 'https://www.youtube.com/watch?v=AAA111';

async function montar() {
  if (h) return h;
  h = await mountScreen('download', {
    shell: true,
    bds: {
      downloads: {
        add: async (p) => { added.push(p); return { ok: true }; },
        getQueue: async () => [],
        getWaitState: async () => null,
        getCookiesStatus: async () => ({ valid: false })
      },
      getMetadata: async () => ({ title: 'Meu vídeo', thumbnail: '', channel: 'Canal', duration: 60 }),
      inspectPlaylist: async (url) => { inspected.push(url); return { isPlaylist: /playlist\?list=/.test(url) }; },
      expandPlaylist: async (url) => { expanded.push(url); return playlistItems; }
    }
  });
  await settle(30);
  return h;
}

const dialogo = () => h.document.querySelector('dialog.playlist-choice');
const botao = (texto) => [...dialogo().querySelectorAll('button')].find((b) => b.textContent.trim() === texto);

async function adicionar(url) {
  const input = h.document.getElementById('urlInput');
  input.value = url;
  h.document.getElementById('metadataButton').dispatchEvent(new h.window.Event('click', { bubbles: true }));
  await settle(30);
}

function zerar() {
  added.length = 0; inspected.length = 0; expanded.length = 0;
  playlistItems = [
    { url: 'https://www.youtube.com/watch?v=AAA111', title: 'Um', thumbnail: '', channel: 'C', duration: 10 },
    { url: 'https://www.youtube.com/watch?v=BBB222', title: 'Dois', thumbnail: '', channel: 'C', duration: 20 },
    { url: 'https://www.youtube.com/watch?v=CCC333', title: 'Três', thumbnail: '', channel: 'C', duration: 30 }
  ];
}

test('links de músicas e encurtados com lista também perguntam; link de outro site com ?list= não', async () => {
  await montar(); zerar();
  for (const url of ['https://music.youtube.com/watch?v=AAA111&list=RDAMVM', 'https://youtu.be/AAA111?list=PLxyz']) {
    await adicionar(url);
    assert.ok(dialogo(), `deve perguntar para ${url}`);
    botao('Só este item').click();
    await settle(60);
    assert.equal(dialogo(), null);
  }
  assert.equal(added.length, 2);
  zerar();
  await adicionar('https://vimeo.com/123?list=1');
  await settle(50);
  assert.equal(dialogo(), null);
});

test('link comum (sem playlist): não pergunta nada e adiciona o item', async () => {
  await montar(); zerar();
  await adicionar(VIDEO_SIMPLES);
  await settle(50);
  assert.equal(dialogo(), null);
  assert.equal(added.length, 1);
  assert.equal(added[0].url, VIDEO_SIMPLES);
});

test('link só de playlist: segue o fluxo normal, sem pergunta', async () => {
  await montar(); zerar();
  await adicionar(SOMENTE_PLAYLIST);
  await settle(80);
  assert.equal(dialogo(), null);
  assert.equal(expanded.length, 1);
  assert.equal(added.length, 3);
});

test('item dentro de playlist: pergunta e "Só este item" adiciona somente esse link, sem expandir', async () => {
  await montar(); zerar();
  await adicionar(VIDEO_COM_LISTA);
  assert.ok(dialogo(), 'o diálogo abre');
  assert.match(dialogo().textContent, /faz parte de uma playlist/);
  assert.deepEqual([...dialogo().querySelectorAll('button')].map((b) => b.textContent.trim()), ['Playlist inteira', 'Só este item']);
  assert.equal(added.length, 0, 'nada é adicionado antes da escolha');
  botao('Só este item').click();
  await settle(80);
  assert.equal(dialogo(), null, 'o diálogo fecha');
  assert.equal(expanded.length, 0);
  assert.equal(inspected.length, 0, 'a escolha do usuário substitui a análise automática');
  assert.equal(added.length, 1);
  assert.equal(added[0].url, VIDEO_COM_LISTA);
});

test('item dentro de playlist: "Playlist inteira" expande e adiciona todos os itens', async () => {
  await montar(); zerar();
  await adicionar(VIDEO_COM_LISTA);
  botao('Playlist inteira').click();
  await settle(100);
  assert.equal(dialogo(), null);
  assert.deepEqual(expanded, [VIDEO_COM_LISTA]);
  assert.deepEqual(added.map((a) => a.title), ['Um', 'Dois', 'Três']);
});

test('item dentro de playlist: fechar sem escolher (Esc) cancela e não adiciona nada', async () => {
  await montar(); zerar();
  await adicionar(VIDEO_COM_LISTA);
  assert.ok(dialogo());
  dialogo().dispatchEvent(new h.window.Event('cancel', { cancelable: true }));
  await settle(60);
  assert.equal(dialogo(), null);
  assert.equal(added.length, 0);
  assert.equal(expanded.length, 0);
  assert.match(h.document.getElementById('statusText').textContent, /cancelada/i);
});

test('o diálogo usa os estilos do modal do app e textos sem nomes de motores', async () => {
  await montar(); zerar();
  await adicionar(VIDEO_COM_LISTA);
  const d = dialogo();
  assert.ok(d.classList.contains('bds-modal'));
  assert.ok(d.querySelector('.bds-btn-primary') && d.querySelector('.bds-btn-secondary'));
  assert.equal(d.getAttribute('aria-labelledby'), 'playlistChoiceTitle');
  assert.ok(h.document.getElementById('playlistChoiceTitle'));
  assert.doesNotMatch(d.textContent, /yt-dlp|ffmpeg|spotify/i);
  botao('Só este item').click();
  await settle(60);
  await h.cleanup();
});
