'use strict';

// Uma tarefa iniciada FORA da tela (ex.: pelo assistente de IA) precisa aparecer nela: arquivos, andamento e fim.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const READY_STATUS = {
  platformSupported: true, busy: null,
  whisper: {
    ready: true, activeModelId: 'small',
    engine: { installed: true }, cuda: { installed: false },
    models: [{ id: 'small', label: 'Small', installed: true, active: true }]
  }
};
const text = (h, sel) => (h.document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();

test('Transcrição: lote iniciado pelo assistente aparece na tela com andamento e resumo final', async () => {
  const h = await mountScreen('transcription', { bds: { modulesGetStatus: async () => ({ ok: true, data: READY_STATUS }) } });
  await settle(20);
  assert.equal(h.document.getElementById('trRoot').dataset.mode, 'empty');

  const files = ['D:/Gravacoes/aula 01.mp4', 'D:/Gravacoes/aula 02.mp4'];
  h.bds.emit('onModulesProgress', { kind: 'transcribe', phase: 'transcribe', message: 'Transcrevendo aula 01.mp4', files, percent: null });
  await settle(5);
  assert.equal(h.document.getElementById('trRoot').dataset.mode, 'running');
  assert.match(text(h, '#trList'), /aula 01\.mp4/);
  assert.match(text(h, '#trList'), /aula 02\.mp4/);
  assert.match(text(h, '#trRunLabel'), /assistente/);

  h.bds.emit('onModulesProgress', { kind: 'transcribe', phase: 'transcribe', files, file: { index: 0, state: 'progress', percent: 40 } });
  assert.match(text(h, '#trList'), /Transcrevendo… 40%/);

  const outputs = files.flatMap((f) => [{ source: f, kind: 'srt', path: f.replace('.mp4', '.srt') }, { source: f, kind: 'md', path: f.replace('.mp4', '.md') }]);
  h.bds.emit('onModulesProgress', { kind: 'transcribe', phase: 'done', percent: 100, files, result: { outputs, errors: [], device: null } });
  await settle(5);
  assert.equal(h.document.getElementById('trRoot').dataset.mode, 'done');
  assert.match(text(h, '#trDoneSub'), /2 arquivos transcritos/);
  await h.cleanup();
});

test('Transcrição: aberta no meio de uma transcrição do assistente, já mostra os arquivos', async () => {
  const busy = { ...READY_STATUS, busy: { kind: 'transcribe', label: 'x', files: ['D:/v/entrevista.mp4'] } };
  const h = await mountScreen('transcription', { bds: { modulesGetStatus: async () => ({ ok: true, data: busy }) } });
  await settle(20);
  assert.equal(h.document.getElementById('trRoot').dataset.mode, 'running');
  assert.match(text(h, '#trList'), /entrevista\.mp4/);
  await h.cleanup();
});

test('Conversor: conversão iniciada pelo assistente mostra os arquivos na lista, com andamento', async () => {
  const queue = [
    { id: 11, file: 'D:/v/clipe A.mov', status: 'Convertendo', progress: 30 },
    { id: 12, file: 'D:/v/clipe B.mov', status: 'Pendente', progress: 0 }
  ];
  const h = await mountScreen('converter', { bds: { converterGetState: async () => ({ running: false, queue: [] }) } });
  await settle(20);
  h.bds.emit('onConverterQueue', queue);
  h.bds.emit('onConverterFileStarted', queue[0]);
  await settle(300);
  const body = text(h, '#converterMainBody');
  assert.match(body, /clipe A\.mov/);
  assert.match(body, /clipe B\.mov/);
  assert.match(body, /Convertendo/);
  assert.match(body, /Aguardando/);
  await h.cleanup();
});

test('Conversor: aberta com uma conversão em andamento, já mostra a fila', async () => {
  const queue = [{ id: 21, file: 'D:/v/aula.mp4', status: 'Convertendo', progress: 10 }];
  const h = await mountScreen('converter', { bds: { converterGetState: async () => ({ running: true, queue }) } });
  await settle(300);
  assert.match(text(h, '#converterMainBody'), /aula\.mp4/);
  await h.cleanup();
});

test('Remover Silêncio: processamento iniciado pelo assistente mostra os arquivos e o andamento', async () => {
  const files = ['D:/v/palestra 1.mp4', 'D:/v/palestra 2.mp4'];
  const h = await mountScreen('silence', { bds: { silenceGetState: async () => ({ running: true, files }) } });
  await settle(300);
  assert.match(text(h, '#silenceMainBody, tbody'), /palestra 1\.mp4/);
  h.bds.emit('onSilenceProgress', { index: 1, total: 2, file: 'palestra 1.mp4', percent: 55, status: 'Processando...' });
  await settle(30);
  const body = text(h, '#silenceMainBody, tbody');
  assert.match(body, /palestra 2\.mp4/);
  assert.match(body, /55%/);
  await h.cleanup();
});
