'use strict';

// Tela Recuperar: aba "Fotos e vídeos" ligada aos serviços reais (window.bds.recovery.*) e aba "Projetos" (mock).

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountScreen, settle } = require('./helpers/renderer-harness');

function fakeRecoveryApi(log) {
  const diag = (kind) => async (file) => {
    log.push([kind, 'diagnose', file]);
    return {
      corrupted: { sizeBytes: 5e6, severity: 'MODERADA (Arquivo cortado antes do fim)', format: 'CR2', manufacturer: 'Canon', camera: 'EOS 5D', previewAvailable: true, previewResolution: '6000x4000', engineAvailable: false, resolution: '640x480', hasMetadata: true, codec: 'h264', durationSec: 30, hasAudio: true },
      reference: null,
      compatibility: { status: 'NENHUMA_REFERENCIA', badge: 'Sem Referência', message: '' },
      suggestedStrategy: 'PREVIEW_RECOVERY', suggestedLevel: 'NIVEL_1_RAPIDO',
    };
  };
  const start = (kind) => async (opts) => {
    log.push([kind, 'start', opts]);
    return { success: true, outputPath: 'C:/fotos/IMG_recuperado.jpg', fileName: 'IMG_recuperado.jpg', sizeBytes: 123456, methodUsed: 'Extração da Pré-visualização Embutida', resultQuality: 'RECUPERAÇÃO PARCIAL', resolution: '6000x4000', warnings: ['Foi recuperada apenas a pré-visualização JPEG.'] };
  };
  const common = (kind) => ({ diagnose: diag(kind), start: start(kind), cancel: async () => ({ success: true }), onProgress: () => () => {} });
  return { ...common('video'), raw: common('raw'), jpg: common('jpg') };
}

async function mount(files = ['C:/fotos/IMG_0001.CR2']) {
  const log = [];
  const opened = [];
  const h = await mountScreen('recovery', { init: false });
  h.window.bds = {
    recovery: fakeRecoveryApi(log),
    selectFiles: async () => files,
    selectFolder: async () => null,
    openLocalPath: async (p) => { opened.push(p); return { success: true }; },
  };
  h.mod.initScreen();
  await settle();
  return { h, log, opened };
}

const text = (h, sel) => h.document.querySelector(sel)?.textContent || '';

test('abre em "Fotos e vídeos" com a área de seleção; a aba Projetos fica escondida', async () => {
  const { h } = await mount();
  assert.match(text(h, '#rcMedia'), /Escolher foto ou vídeo danificado/);
  assert.ok(!h.document.getElementById('rcMedia').classList.contains('hidden'));
  assert.ok(h.document.getElementById('rcProject').classList.contains('hidden'));
  assert.equal(h.document.querySelectorAll('#rcSwitch button').length, 2);
  await h.cleanup();
});

test('trocar de aba mostra o fluxo de Projetos e volta', async () => {
  const { h } = await mount();
  const [, projects] = h.document.querySelectorAll('#rcSwitch button');
  projects.click();
  assert.ok(h.document.getElementById('rcMedia').classList.contains('hidden'));
  assert.ok(!h.document.getElementById('rcProject').classList.contains('hidden'));
  await h.cleanup();
});

test('RAW: escolhe o arquivo, diagnostica sozinho e recupera usando o serviço de RAW', async () => {
  const { h, log, opened } = await mount();
  h.document.querySelector('.rm-drop').click();
  await settle(); await settle();
  assert.deepEqual(log[0], ['raw', 'diagnose', 'C:/fotos/IMG_0001.CR2']);
  assert.match(text(h, '#rcMedia'), /IMG_0001\.CR2/);
  assert.match(text(h, '#rcMedia'), /6000x4000/);
  assert.match(text(h, '#rcMedia'), /pré-visualização JPEG embutida no RAW/);
  assert.match(text(h, '#rcMedia'), /resultado será um JPG/);

  const go = [...h.document.querySelectorAll('#rcMedia .rm-actions button')].find((b) => /Recuperar/.test(b.textContent));
  assert.equal(go.disabled, false);
  go.click();
  await settle(); await settle();
  const startCall = log.find((l) => l[1] === 'start');
  assert.equal(startCall[0], 'raw');
  assert.equal(startCall[2].corruptPath, 'C:/fotos/IMG_0001.CR2');
  assert.equal(startCall[2].preferredLevel, undefined);
  assert.match(text(h, '#rcMedia'), /Recuperação parcial/);
  assert.match(text(h, '#rcMedia'), /apenas a pré-visualização/);

  [...h.document.querySelectorAll('#rcMedia button')].find((b) => /Mostrar na pasta/.test(b.textContent)).click();
  assert.deepEqual(opened, ['C:/fotos']);
  await h.cleanup();
});

test('JPG e vídeo usam o serviço certo; vídeo envia o método escolhido', async () => {
  const jpg = await mount(['C:/f/a.JPG']);
  jpg.h.document.querySelector('.rm-drop').click();
  await settle(); await settle();
  assert.equal(jpg.log[0][0], 'jpg');
  assert.equal(jpg.h.document.querySelector('#rcMedia select'), null, 'JPG não tem escolha de método');
  await jpg.h.cleanup();

  const vid = await mount(['D:/v/clip.mp4']);
  vid.h.document.querySelector('.rm-drop').click();
  await settle(); await settle();
  assert.equal(vid.log[0][0], 'video');
  const go = [...vid.h.document.querySelectorAll('#rcMedia .rm-actions button')].find((b) => /Recuperar/.test(b.textContent));
  go.click();
  await settle(); await settle();
  assert.equal(vid.log.find((l) => l[1] === 'start')[2].preferredLevel, 'AUTO');
  await vid.h.cleanup();
});

test('formato desconhecido e falha do serviço mostram mensagem clara', async () => {
  const bad = await mount(['C:/x/planilha.xlsx']);
  bad.h.document.querySelector('.rm-drop').click();
  await settle(); await settle();
  assert.match(text(bad.h, '#rcMedia'), /Formato não reconhecido/);
  await bad.h.cleanup();

  const { h } = await mount();
  h.window.bds.recovery.raw.start = async () => { throw new Error("Error invoking remote method 'recovery:raw:start': Error: Já existe uma recuperação em andamento."); };
  h.document.querySelector('.rm-drop').click();
  await settle(); await settle();
  [...h.document.querySelectorAll('#rcMedia .rm-actions button')].find((b) => /Recuperar/.test(b.textContent)).click();
  await settle(); await settle();
  assert.match(text(h, '#rcMedia'), /Já existe uma recuperação em andamento/);
  assert.doesNotMatch(text(h, '#rcMedia'), /Error invoking/);
  await h.cleanup();
});
