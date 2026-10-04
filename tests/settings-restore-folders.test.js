'use strict';

// Configurações > Pastas: o botão "Restaurar padrão" dos cartões de Download e do Conversor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mountScreen, settle, SCREENS_DIR } = require('./helpers/renderer-harness');

const DEFAULTS = {
  mp3Folder: path.join(os.homedir(), 'Music'),
  mp4Folder: path.join(os.homedir(), 'Videos'),
  converterFolder: path.join(os.homedir(), 'Videos', 'Convertido')
};

test('SettingsManager.getDefaultFolders devolve só as três pastas padrão (sem dados do usuário)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-restore-'));
  try {
    const SettingsManager = require('../src/core/settings/SettingsManager');
    const mgr = new SettingsManager(dir, dir);
    assert.deepEqual(mgr.getDefaultFolders(), DEFAULTS);
    assert.deepEqual(Object.keys(mgr.getDefaultFolders()).sort(), ['converterFolder', 'mp3Folder', 'mp4Folder']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('o canal settings:getDefaultFolders está na tabela, no handler e no preload', () => {
  const channels = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'channels.js'), 'utf8');
  assert.match(channels, /'settings:getDefaultFolders'.*api: \['getDefaultFolders'\]/);
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'settingsHandlers.js'), 'utf8');
  assert.match(handlers, /handle\('settings:getDefaultFolders'/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /getDefaultFolders/);
});

test('o HTML tem um botão "Restaurar padrão" no cartão de Download e outro no do Conversor', () => {
  const html = fs.readFileSync(path.join(SCREENS_DIR, 'settings.html'), 'utf8');
  for (const id of ['restoreDownloadFoldersButton', 'restoreConverterFolderButton']) {
    const m = html.match(new RegExp(`<button id="${id}"[^>]*>([\\s\\S]*?)</button>`));
    assert.ok(m, `botão ${id}`);
    assert.match(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(), /^restart_alt Restaurar padrão$|^Restaurar padrão$/);
  }
});

test('Restaurar padrão: Download volta áudio e vídeo, Conversor só a pasta convertida e falha mantém os campos', async () => {
  // O app.js é importado uma vez por processo: uma única montagem (com o shell) e variáveis controlam o stub.
  let pedidos = 0;
  let falhar = false;
  const h = await mountScreen('settings', {
    shell: true,
    bds: {
      getSettings: async () => ({ mp3Folder: 'D:/Meus/Audios', mp4Folder: 'D:/Meus/Videos', converterFolder: 'D:/Meus/Saida', obsFolder: 'D:/OBS' }),
      getDefaultFolders: async () => { pedidos++; if (falhar) throw new Error('falhou'); return DEFAULTS; }
    }
  });
  try {
    await settle(80);
    const val = (id) => h.document.getElementById(id).value;
    const status = () => h.document.getElementById('bdsToasts')?.textContent || '';
    assert.equal(val('mp3FolderInput'), 'D:/Meus/Audios');

    h.document.getElementById('restoreConverterFolderButton').click();
    await settle(30);
    assert.equal(val('converterFolderInput'), DEFAULTS.converterFolder);
    assert.equal(val('mp3FolderInput'), 'D:/Meus/Audios', 'o Conversor não mexe nas pastas de download');
    assert.match(status(), /Pasta padrão restaurada/);

    h.document.getElementById('restoreDownloadFoldersButton').click();
    await settle(30);
    assert.equal(val('mp3FolderInput'), DEFAULTS.mp3Folder);
    assert.equal(val('mp4FolderInput'), DEFAULTS.mp4Folder);
    assert.equal(val('obsFolderInput'), 'D:/OBS', 'outras pastas não são tocadas');
    assert.equal(pedidos, 2);

    // falha ao obter as pastas padrão: nada muda e o usuário é avisado
    falhar = true;
    h.document.getElementById('mp4FolderInput').value = 'D:/Outra';
    h.document.getElementById('restoreDownloadFoldersButton').click();
    await settle(30);
    assert.equal(val('mp4FolderInput'), 'D:/Outra');
    assert.match(status(), /Não foi possível restaurar/);
  } finally {
    await h.cleanup();
  }
});
