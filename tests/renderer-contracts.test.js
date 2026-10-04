'use strict';

// Testes de CONTRATO das telas do renderer com window.bds simulado (harness leve com linkedom).
// Cada teste monta a tela, conduz a interface como o usuário e confere o que sai para o `bds`
// (payload do IPC) ou o que aparece na tela.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const click = (h, el) => el.dispatchEvent(new h.window.Event('click', { bubbles: true }));
const typeInto = (h, el, value) => {
  el.value = value;
  el.dispatchEvent(new h.window.Event('input', { bubbles: true }));
};

// ---------------------------------------------------------------------------
// Metadados: o save leva SÓ as tags alteradas
// ---------------------------------------------------------------------------

test('Metadados: saveMetadata recebe apenas as tags editadas (seletor .meta-panel input[data-tag])', async () => {
  const filePath = 'C:\\videos\\aula.mp4';
  const h = await mountScreen('metadata', {
    bds: {
      selectFiles: async () => [filePath],
      probeMetadataFile: async () => ({
        format: {
          filename: filePath, format_name: 'mov,mp4', duration: '65.5', size: '1048576', bit_rate: '128000',
          tags: { title: 'Titulo original', artist: 'Autor', album: 'Album' }
        },
        streams: [],
        chapters: []
      }),
      extractMetadataThumb: async () => null,
      saveMetadata: async () => ({ status: 'success' })
    }
  });
  try {
    const inputs = h.document.querySelectorAll('.meta-panel input[data-tag]');
    assert.ok(inputs.length >= 5, 'a tela deve ter campos .meta-panel input[data-tag]');

    click(h, h.document.getElementById('btnSelectMetaFile'));
    await settle(60);
    assert.equal(h.bds.calls.probeMetadataFile?.[0]?.[0], filePath);
    assert.equal(h.document.getElementById('tag-title').value, 'Titulo original');

    // edita só o título
    typeInto(h, h.document.getElementById('tag-title'), 'Titulo novo');
    // abre o diff e confirma a gravação
    click(h, h.document.getElementById('btnExportMeta'));
    click(h, h.document.getElementById('btnConfirmDiff'));
    await settle(60);

    const call = h.bds.calls.saveMetadata?.[0]?.[0];
    assert.ok(call, 'saveMetadata deve ser chamado');
    assert.equal(call.filePath, filePath);
    assert.deepEqual(call.tags, { title: 'Titulo novo' }, 'só a tag alterada vai no payload');
  } finally {
    await h.cleanup();
  }
});

test('Metadados: sem edição nenhuma, o payload não leva tags', async () => {
  const filePath = '/tmp/a.mp3';
  const h = await mountScreen('metadata', {
    bds: {
      selectFiles: async () => [filePath],
      probeMetadataFile: async () => ({ format: { filename: filePath, duration: '3', size: '10', tags: { title: 'X' } }, streams: [], chapters: [] }),
      saveMetadata: async () => ({ status: 'success' })
    }
  });
  try {
    click(h, h.document.getElementById('btnSelectMetaFile'));
    await settle(60);
    // direto na confirmação (o botão pode estar oculto, mas o handler é o mesmo)
    click(h, h.document.getElementById('btnConfirmDiff'));
    await settle(40);
    const call = h.bds.calls.saveMetadata?.[0]?.[0];
    assert.ok(call);
    assert.deepEqual(call.tags, {});
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Conversor: finished com falhas não anuncia "Sucesso"
// ---------------------------------------------------------------------------

test('Conversor: evento finished com failed>0 mostra aviso de erro e NÃO "Sucesso"', async () => {
  const h = await mountScreen('converter', { bds: { checkEncoders: async () => ['libx264'] } });
  try {
    assert.ok(h.bds.handlers.onConverterFinished?.length, 'a tela deve registrar onConverterFinished');
    h.bds.emit('onConverterFinished', {
      status: 'completed', total: 3, failed: 1,
      errors: [{ file: 'C:\\x\\ruim.mov', error: 'codec nao suportado' }]
    });
    await settle(30);
    assert.equal(h.dialogs.alerts.length, 1);
    const msg = h.dialogs.alerts[0];
    assert.doesNotMatch(msg, /Sucesso/i);
    assert.match(msg, /erro/i);
    assert.match(msg, /ruim\.mov/);
  } finally {
    await h.cleanup();
  }
});

test('Conversor: finished sem falhas continua anunciando sucesso; cancelado não', async () => {
  const h = await mountScreen('converter', { bds: { checkEncoders: async () => ['libx264'] } });
  try {
    h.bds.emit('onConverterFinished', { status: 'completed', failed: 0 });
    h.bds.emit('onConverterFinished', { status: 'cancelled' });
    await settle(30);
    assert.match(h.dialogs.alerts[0], /Sucesso/);
    assert.doesNotMatch(h.dialogs.alerts[1], /Sucesso/);
    assert.match(h.dialogs.alerts[1], /cancelad/i);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Projetos: diálogos devolvem string, array ou { filePaths } (firstDialogPath)
// ---------------------------------------------------------------------------

for (const [nome, retorno, esperado] of [
  ['string', 'C:\\pacotes\\a.bdspro', 'C:\\pacotes\\a.bdspro'],
  ['array', ['C:\\pacotes\\b.bdspro', 'C:\\outro.bdspro'], 'C:\\pacotes\\b.bdspro'],
  ['{ filePaths }', { canceled: false, filePaths: ['C:\\pacotes\\c.bdspro'] }, 'C:\\pacotes\\c.bdspro']
]) {
  test(`Projetos: importar .bdspro aceita o diálogo devolvendo ${nome}`, async () => {
    const h = await mountScreen('projects', {
      bds: {
        selectFile: async () => retorno,
        inspectBdspro: async () => ({ project: { name: 'P' }, missing: [], media: [] })
      }
    });
    try {
      await settle(30);
      click(h, h.document.getElementById('btnImportBdspro'));
      await settle(40);
      assert.equal(h.bds.calls.inspectBdspro?.[0]?.[0], esperado);
    } finally {
      await h.cleanup();
    }
  });
}

test('Projetos: diálogo cancelado ({ canceled: true } / null / []) não inspeciona nada', async () => {
  for (const retorno of [{ canceled: true, filePaths: [] }, null, []]) {
    const h = await mountScreen('projects', { bds: { selectFile: async () => retorno } });
    try {
      await settle(30);
      click(h, h.document.getElementById('btnImportBdspro'));
      await settle(30);
      assert.equal(h.bds.calls.inspectBdspro, undefined);
    } finally {
      await h.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// Home: searchLibrary devolve array (legado) ou { items }
// ---------------------------------------------------------------------------

for (const [nome, build] of [
  ['array', (items) => items],
  ['{ items }', (items) => ({ items, total: items.length })]
]) {
  test(`Home: aba "Downloads" lista os itens quando searchLibrary devolve ${nome}`, async () => {
    const itens = [{ id: 1, filename: 'video-do-youtube.mp4', media_type: 'video', imported_at: '2026-01-02 03:04:05', width: 1920, height: 1080 }];
    const h = await mountScreen('home', {
      bds: {
        getLibraryStats: { totalMedia: 1, videosCount: 1, totalSizeBytes: 10 },
        getRecentMedia: [],
        listHistory: [],
        searchLibrary: async () => build(itens)
      }
    });
    try {
      await settle(30);
      const tab = [...h.document.querySelectorAll('.job-tab')].find((b) => b.textContent.trim() === 'Downloads');
      assert.ok(tab, 'aba Downloads existe');
      click(h, tab);
      await settle(40);
      assert.match(h.document.getElementById('recentJobsTable').textContent, /video-do-youtube\.mp4/);
    } finally {
      await h.cleanup();
    }
  });
}
