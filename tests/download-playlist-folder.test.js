'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DownloadManager = require('../src/services/downloadService');
const { folderNameFor, applyCoverIcon } = require('../src/services/playlistFolder');

DownloadManager.prototype.initDatabaseQueue = function initDatabaseQueue() { this.queue = []; };

function makeManager(folder) {
  const m = new DownloadManager({
    paths: { dataDir: os.tmpdir() },
    getSettings: () => ({ mp3Folder: folder, mp4Folder: folder }),
    historyService: null
  });
  m.saveItemToDb = () => {};
  m.queue = [];
  return m;
}

test('folderNameFor limpa caracteres proibidos e nomes reservados', () => {
  assert.equal(folderNameFor('Rock: os "melhores" <2024>?'), 'Rock os melhores 2024');
  assert.equal(folderNameFor('  Fim com ponto...  '), 'Fim com ponto');
  assert.equal(folderNameFor('CON'), 'CON_');
  assert.equal(folderNameFor('???'), '');
  assert.equal(folderNameFor(null), '');
});

test('playlist em MP3 vai para uma subpasta com o nome da playlist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-pl-'));
  try {
    const m = makeManager(root);
    const item = m.add({ url: 'https://www.youtube.com/watch?v=abc123DEF45', format: 'MP3', title: 'Faixa', playlistTitle: 'Minha: Playlist' });
    assert.equal(item.folder, path.join(root, 'Minha Playlist'));
    assert.ok(fs.statSync(item.folder).isDirectory());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MP4 e links sem playlist ignoram o nome da playlist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-pl-'));
  try {
    const m = makeManager(root);
    const mp4 = m.add({ url: 'https://www.youtube.com/watch?v=abc123DEF45', format: 'MP4', title: 'V', playlistTitle: 'Lista' });
    assert.equal(mp4.folder, root);
    const mp3 = m.add({ url: 'https://www.youtube.com/watch?v=zzz123DEF45', format: 'MP3', title: 'M' });
    assert.equal(mp3.folder, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyCoverIcon sem capa válida ou sem ffmpeg não faz nada', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-pl-'));
  try {
    assert.equal(await applyCoverIcon(root, '', 'x'), false);
    assert.equal(await applyCoverIcon(root, 'https://exemplo.invalid/c.jpg', path.join(root, 'nao-existe.exe')), false);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('interruptor desligado (playlistFolders: false) mantém a pasta comum', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-pl-'));
  try {
    const m = makeManager(root);
    m.getSettings = () => ({ mp3Folder: root, mp4Folder: root, playlistFolders: false });
    const item = m.add({ url: 'https://www.youtube.com/watch?v=abc123DEF45', format: 'MP3', title: 'F', playlistTitle: 'Lista' });
    assert.equal(item.folder, root);
    assert.equal(item.playlistFolder, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a subpasta da playlist sobrevive ao reinício (gravada e relida do banco)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-pl-'));
  try {
    const m = makeManager(root);
    const saved = [];
    m.saveItemToDb = (it) => saved.push(it.playlistFolder);
    const item = m.add({ url: 'https://www.youtube.com/watch?v=abc123DEF45', format: 'MP3', title: 'F', playlistTitle: 'Minha Lista' });
    assert.equal(item.playlistFolder, 'Minha Lista');
    assert.ok(saved.includes('Minha Lista'));
    // toggleFormat para MP4 solta a subpasta
    m.toggleFormat(item.id, 'MP4');
    assert.equal(item.playlistFolder, '');
    assert.equal(item.folder, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
