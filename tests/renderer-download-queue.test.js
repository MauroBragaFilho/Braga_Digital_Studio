'use strict';

// Tela Downloads: cartão imediato ao adicionar, campo limpo, Enter duplo, Múltiplos Links sem travar e com resumo,
// aviso de link repetido, ausência do cartão grande "Download Ativo" e linha da fila com o progresso.
// Monta o shell real (index.html + app.js): o app.js é importado uma única vez por processo, então todos os
// cenários compartilham uma montagem e controlam os dados pelas variáveis abaixo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mountScreen, settle, SCREENS_DIR } = require('./helpers/renderer-harness');

const added = [];
let metadataCalls = 0;
let addImpl = async () => ({ id: 'dl_x' });
let playlistItems = [];
let h;

async function montar() {
  if (h) return h;
  h = await mountScreen('download', {
    shell: true,
    bds: {
      downloads: {
        add: (p) => { added.push(p); return addImpl(p); },
        getQueue: async () => [],
        getWaitState: async () => null,
        getCookiesStatus: async () => ({ valid: false })
      },
      getMetadata: async () => { metadataCalls++; return { title: 'Não deve ser chamado', thumbnail: '', channel: '', duration: 1 }; },
      inspectPlaylist: async (u) => ({ isPlaylist: /playlist[?]list=/.test(u) }),
      expandPlaylist: async () => playlistItems
    }
  });
  await settle(30);
  return h;
}

const input = () => h.document.getElementById('urlInput');
const status = () => h.document.getElementById('statusText').textContent;
const LINK = 'https://www.youtube.com/watch?v=AAA111';
const LINK2 = 'https://vimeo.com/123456';

function enter() {
  const ev = new h.window.Event('keydown', { bubbles: true, cancelable: true });
  ev.key = 'Enter';
  input().dispatchEvent(ev);
}
function clickAdd() {
  h.document.getElementById('metadataButton').dispatchEvent(new h.window.Event('click', { bubbles: true }));
}
function zerar() {
  added.length = 0; metadataCalls = 0;
  addImpl = async () => ({ id: 'dl_x' });
  input().value = '';
}
const cards = () => [...h.document.querySelectorAll('#downloadQueueContainer .download-card')];

test('o cartão grande "Download Ativo" não existe mais (HTML, CSS e JS)', () => {
  const html = fs.readFileSync(path.join(SCREENS_DIR, 'download.html'), 'utf8');
  const css = fs.readFileSync(path.join(SCREENS_DIR, 'download.css'), 'utf8');
  const js = fs.readFileSync(path.join(SCREENS_DIR, 'download.js'), 'utf8');
  for (const [nome, texto] of [['html', html], ['css', css], ['js', js]]) {
    assert.doesNotMatch(texto, /activeDownload|active-download|DOWNLOAD ATIVO/i, `${nome} sem o cartão grande`);
  }
  assert.doesNotMatch(js, /Link com erro/);
  assert.doesNotMatch(js, /setTimeout\([^)]*8000/, 'sem limite de 8 s no renderer');
});

test('item em download: UMA só linha, com "Baixando", barra, porcentagem, bytes, velocidade e tempo restante', async () => {
  await montar(); zerar();
  h.mod.renderDownloadQueue([
    { id: 'dl_1', url: LINK, title: 'Aula 1', status: 'downloading', format: 'MP4', quality: 'best', platform: 'YouTube', progress: 42.4, downloadedBytes: 3 * 1048576, totalBytes: 10 * 1048576, speed: '2.5MiB/s', eta: '00:12' },
    { id: 'dl_2', url: LINK2, title: 'Aula 2', status: 'queued', format: 'MP4', quality: 'best', platform: 'Vimeo', progress: 0 }
  ]);
  assert.equal(h.document.getElementById('activeDownloadSection'), null);
  assert.equal(cards().length, 2, 'cada item aparece uma única vez');
  const linha = cards()[0];
  assert.match(linha.querySelector('.status-badge-downloading').textContent, /Baixando/);
  assert.equal(linha.querySelector('.dl-row-pct').textContent, '42%');
  assert.match(linha.querySelector('.dl-row-bytes').textContent, /3 MB \/ 10 MB/);
  assert.match(linha.querySelector('.speed-info').textContent, /2\.5MiB\/s.*Restante 00:12/);
  assert.ok(linha.querySelector('.dl-row-fill'));
  assert.equal(h.document.getElementById('metricActive').textContent, '1');
  assert.equal(h.document.getElementById('metricTotal').textContent, '2');

  // progresso granular atualiza a própria linha
  h.mod.updateProgressVisuals({ id: 'dl_1', progress: 80, downloadedBytes: 8 * 1048576, totalBytes: 10 * 1048576, speed: '3MiB/s', eta: '00:03' });
  assert.equal(cards()[0].querySelector('.dl-row-pct').textContent, '80%');
  assert.match(cards()[0].querySelector('.dl-row-bytes').textContent, /8 MB/);
});

test('cartão recém-criado mostra o site e "Carregando informações..."; some quando as informações chegam', async () => {
  await montar(); zerar();
  const base = { id: 'dl_9', url: LINK, status: 'queued', format: 'MP4', quality: 'best', platform: 'YouTube', progress: 0 };
  h.mod.renderDownloadQueue([{ ...base, title: 'Vídeo do YouTube', infoLoading: true }]);
  assert.ok(cards()[0].classList.contains('is-loading'));
  assert.match(cards()[0].textContent, /Carregando informações/);
  assert.match(cards()[0].textContent, /YouTube/);
  assert.doesNotMatch(cards()[0].textContent, /Link com erro|Falhou/);
  h.mod.renderDownloadQueue([{ ...base, title: 'Aula completa', channel: 'Canal X', duration: 125, infoLoading: false }]);
  assert.equal(cards()[0].classList.contains('is-loading'), false);
  assert.doesNotMatch(cards()[0].textContent, /Carregando/);
  assert.match(cards()[0].textContent, /Aula completa/);
  assert.match(cards()[0].textContent, /Canal X/);
});

test('Enter: o campo é limpo na hora, o item vai direto ao processo principal (sem análise no renderer, sem status/erro)', async () => {
  await montar(); zerar();
  let liberar;
  addImpl = () => new Promise((r) => { liberar = r; }); // o processo principal "demora"
  input().value = LINK;
  enter();
  await settle(15);
  assert.equal(input().value, '', 'campo limpo antes de a adição terminar');
  assert.equal(added.length, 1);
  assert.equal(added[0].url, LINK);
  assert.equal(metadataCalls, 0, 'nada de getMetadata no renderer');
  assert.ok(!('status' in added[0]) && !('error' in added[0]), 'o renderer não manda status/erro');
  // dá para colar o próximo link logo em seguida, mesmo com a primeira adição pendente
  input().value = LINK2;
  enter();
  await settle(15);
  assert.equal(added.length, 2);
  assert.equal(added[1].url, LINK2);
  liberar({ id: 'dl_1' });
  await settle(20);
});

test('Enter duplo e Enter + clique geram UMA só adição', async () => {
  await montar(); zerar();
  input().value = LINK;
  enter(); enter();
  await settle(30);
  assert.equal(added.length, 1, 'Enter duplo');

  zerar();
  input().value = LINK;
  enter(); clickAdd();
  await settle(30);
  assert.equal(added.length, 1, 'Enter + clique');
  assert.doesNotMatch(status(), /Cole um link/, 'o segundo gesto não apaga o aviso de sucesso');
  assert.match(status(), /adicionado/);
});

test('link repetido: aviso discreto com a mensagem e destaque do cartão que já existe', async () => {
  await montar(); zerar();
  h.mod.renderDownloadQueue([{ id: 'dl_1', url: LINK, title: 'Aula 1', status: 'queued', format: 'MP4', quality: 'best', platform: 'YouTube', progress: 0 }]);
  addImpl = async () => ({ ok: false, duplicate: true, code: 'DUPLICATE_QUEUED', error: 'Este link já está na fila.', existingId: 'dl_1' });
  input().value = LINK;
  enter();
  await settle(30);
  assert.equal(status(), 'Este link já está na fila.');
  assert.ok(cards()[0].classList.contains('dl-highlight'), 'o cartão existente é destacado');
  assert.ok(h.document.querySelector('.bds-toast'), 'aviso discreto (toast)');
});

test('Múltiplos Links: fecha na hora, sem "Analisando", e o resumo conta os repetidos', async () => {
  await montar(); zerar();
  let n = 0;
  addImpl = async () => {
    await settle(25);
    n++;
    return n === 2 || n === 5 ? { ok: false, duplicate: true, error: 'Este link já está na fila.', existingId: null } : { id: `dl_${n}` };
  };
  h.document.getElementById('btnMultipleLinks').dispatchEvent(new h.window.Event('click', { bubbles: true }));
  const overlay = h.document.getElementById('multipleLinksOverlay');
  assert.ok(overlay, 'modal aberto');
  const links = Array.from({ length: 6 }, (_, i) => `https://www.youtube.com/watch?v=VIDEO${i}`);
  h.document.getElementById('multipleLinksInput').value = `anotação sem link\n${links.join('\n')}\n`;
  h.document.getElementById('confirmLinks').dispatchEvent(new h.window.Event('click', { bubbles: true }));
  // fechou de imediato, mesmo com as adições ainda em andamento
  assert.equal(h.document.getElementById('multipleLinksOverlay'), null);
  assert.doesNotMatch(h.document.body.textContent, /Analisando/);
  await settle(400);
  assert.equal(added.length, 6);
  assert.equal(metadataCalls, 0, 'nenhuma análise no renderer');
  assert.ok(added.every((a) => !('status' in a) && !('error' in a) && a.title === ''));
  assert.equal(status(), '4 adicionados, 2 já estavam na fila ou já baixados.');
});

test('playlist: campo limpo na hora, itens já com título e resumo com os repetidos', async () => {
  await montar(); zerar();
  playlistItems = [1, 2, 3].map((i) => ({ url: 'https://www.youtube.com/watch?v=P' + i, title: 'Faixa ' + i, thumbnail: '', channel: 'C', duration: 10 }));
  let n = 0;
  addImpl = async () => { n++; return n === 2 ? { ok: false, duplicate: true, error: 'Este link já está na fila.' } : { id: 'dl_' + n }; };
  input().value = 'https://www.youtube.com/playlist?list=PLabc';
  enter();
  await settle(10);
  assert.equal(input().value, '');
  await settle(60);
  assert.equal(added.length, 3);
  assert.deepEqual(added.map((a) => a.title), ['Faixa 1', 'Faixa 2', 'Faixa 3']);
  assert.equal(status(), '2 adicionados, 1 já estavam na fila ou já baixados.');
});

test('Múltiplos Links: sem nenhum link válido não fecha e orienta', async () => {
  await montar(); zerar();
  h.document.getElementById('btnMultipleLinks').dispatchEvent(new h.window.Event('click', { bubbles: true }));
  h.document.getElementById('multipleLinksInput').value = 'texto solto\noutra linha';
  h.document.getElementById('confirmLinks').dispatchEvent(new h.window.Event('click', { bubbles: true }));
  assert.ok(h.document.getElementById('multipleLinksOverlay'), 'continua aberto');
  assert.match(status(), /Nenhum link válido/);
  h.document.getElementById('cancelLinks').dispatchEvent(new h.window.Event('click', { bubbles: true }));
  assert.equal(h.document.getElementById('multipleLinksOverlay'), null);
  await h.cleanup();
});
