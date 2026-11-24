'use strict';

// Configurações > Pastas: o botão "Restaurar padrão" dos cartões de Download e do Conversor (ícone que só aparece quando
// a pasta difere do padrão; se o padrão não carregar, o botão fica visível).

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

test('o HTML tem um botão-ícone "Restaurar padrão" no cartão de Download e outro no do Conversor, escondidos de início', () => {
  const html = fs.readFileSync(path.join(SCREENS_DIR, 'settings.html'), 'utf8');
  for (const id of ['restoreDownloadFoldersButton', 'restoreConverterFolderButton']) {
    const m = html.match(new RegExp(`<button id="${id}"([^>]*)>([\\s\\S]*?)</button>`));
    assert.ok(m, `botão ${id}`);
    assert.match(m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(), /^restart_alt Restaurar padrão$|^Restaurar padrão$/);
    assert.match(m[2], /<span class="st-sr">Restaurar padrão<\/span>/, 'o texto fica num span visualmente oculto');
    assert.match(m[1], /class="st-reset-icon hidden"/, 'ícone, escondido até a pasta diferir do padrão');
    assert.match(m[1], /data-reset-kind="folders"/, 'marcador próprio: o setupFieldDefaults não o apaga');
    assert.match(m[1], /aria-label="Restaurar [^"]+"/);
    assert.match(m[1], /title="Restaurar padrão"/);
    assert.match(html, new RegExp(`<div class="st-restore-row hidden" data-reset-row>\\s*<button id="${id}"`), 'a linha some junto com o botão');
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
    const doc = h.document;
    const val = (id) => doc.getElementById(id).value;
    const status = () => doc.getElementById('bdsToasts')?.textContent || '';
    const escondido = (id) => doc.getElementById(id).classList.contains('hidden');
    const linhaEscondida = (id) => doc.getElementById(id).closest('.st-restore-row').classList.contains('hidden');
    const digitar = (id, valor) => {
      doc.getElementById(id).value = valor;
      doc.getElementById(id).dispatchEvent(new h.window.Event('input', { bubbles: true }));
    };
    const focados = [];
    for (const id of ['mp3FolderInput', 'converterFolderInput']) doc.getElementById(id).focus = () => focados.push(id);
    assert.equal(val('mp3FolderInput'), 'D:/Meus/Audios');

    // pastas diferentes do padrão: os dois botões aparecem (e a linha com eles); o padrão foi pedido uma única vez
    assert.equal(escondido('restoreDownloadFoldersButton'), false);
    assert.equal(escondido('restoreConverterFolderButton'), false);
    assert.equal(linhaEscondida('restoreConverterFolderButton'), false);
    assert.equal(pedidos, 1, 'o padrão é buscado uma vez para decidir a visibilidade (cache em memória)');
    assert.match(doc.getElementById('restoreConverterFolderButton').title, new RegExp(`^Restaurar padrão: .*${path.basename(DEFAULTS.converterFolder)}`));

    doc.getElementById('restoreConverterFolderButton').click();
    await settle(30);
    assert.equal(val('converterFolderInput'), DEFAULTS.converterFolder);
    assert.equal(val('mp3FolderInput'), 'D:/Meus/Audios', 'o Conversor não mexe nas pastas de download');
    assert.match(status(), /Pasta padrão restaurada/);
    assert.equal(escondido('restoreConverterFolderButton'), true, 'no padrão, o botão some');
    assert.equal(linhaEscondida('restoreConverterFolderButton'), true, 'e a linha dele também');
    assert.equal(escondido('restoreDownloadFoldersButton'), false, 'o outro cartão não muda');
    assert.deepEqual(focados, ['converterFolderInput'], 'o foco volta ao campo (o botão focado sumiu)');

    doc.getElementById('restoreDownloadFoldersButton').click();
    await settle(30);
    assert.equal(val('mp3FolderInput'), DEFAULTS.mp3Folder);
    assert.equal(val('mp4FolderInput'), DEFAULTS.mp4Folder);
    assert.equal(val('obsFolderInput'), 'D:/OBS', 'outras pastas não são tocadas');
    assert.equal(escondido('restoreDownloadFoldersButton'), true);
    assert.equal(focados.at(-1), 'mp3FolderInput');
    assert.equal(pedidos, 3, 'uma busca na abertura e uma por clique em Restaurar padrão');

    // a comparação ignora o tipo de barra, maiúsculas e a barra final
    digitar('mp3FolderInput', `${DEFAULTS.mp3Folder.split(path.sep).join('/').toUpperCase()}/`);
    assert.equal(escondido('restoreDownloadFoldersButton'), true, 'mesmo caminho escrito de outro jeito: continua no padrão');
    // qualquer um dos dois campos fora do padrão traz o botão de volta
    digitar('mp4FolderInput', 'D:/Outra');
    assert.equal(escondido('restoreDownloadFoldersButton'), false);
    assert.equal(linhaEscondida('restoreDownloadFoldersButton'), false);
    assert.equal(pedidos, 3, 'digitar não busca o padrão de novo');

    // falha ao obter as pastas padrão: nada muda e o usuário é avisado
    falhar = true;
    doc.getElementById('restoreDownloadFoldersButton').click();
    await settle(30);
    assert.equal(val('mp4FolderInput'), 'D:/Outra');
    assert.match(status(), /Não foi possível restaurar/);
    assert.equal(escondido('restoreDownloadFoldersButton'), false, 'o botão continua para tentar de novo');
  } finally {
    await h.cleanup();
  }
});

test('se o padrão das pastas não carregar, os botões Restaurar padrão ficam visíveis (e a exceção não escapa)', async () => {
  // Segunda montagem do processo, sem o shell (o app.js já foi importado pelo teste anterior).
  const h = await mountScreen('settings', {
    bds: { getDefaultFolders: async () => { throw new Error('falhou'); } }
  });
  try {
    await settle(60);
    const doc = h.document;
    for (const id of ['restoreDownloadFoldersButton', 'restoreConverterFolderButton']) {
      const btn = doc.getElementById(id);
      assert.equal(btn.classList.contains('hidden'), false, `${id} visível sem o padrão para comparar`);
      assert.equal(btn.closest('.st-restore-row').classList.contains('hidden'), false);
    }
    assert.deepEqual(h.errors, [], 'a falha da busca não vira erro não tratado');
  } finally {
    await h.cleanup();
  }
});
