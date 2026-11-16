'use strict';

// A análise com IA pode terminar "pronta" e mesmo assim sair incompleta (o modelo repetiu texto, a resposta foi cortada ou a união
// das partes falhou). O arquivo sempre disse isso; agora a tela também. E, quando o servidor manda esperar, a linha do arquivo
// mostra o motivo da espera.

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
const FILE = 'D:/Gravacoes/aula 01.mp4';
const MD = 'D:/Gravacoes/aula 01.md';
const ok = (data) => ({ ok: true, data });
const text = (h, sel) => (h.document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();

/** Monta a tela, escolhe o arquivo, liga a análise com IA e começa. `hold` segura a análise até o teste soltar. */
async function begin(analysis, hold = null) {
  const h = await mountScreen('transcription', {
    bds: {
      modulesGetStatus: async () => ok(READY_STATUS),
      aiGetConfig: async () => ok({ ready: true, isLocal: true, model: 'qwen3-vl-2b-instruct' }),
      selectFile: async () => [FILE],
      probeMetadataFile: async () => ({ duration: 60 }),
      modulesTranscribe: async () => ok({ outputs: [{ source: FILE, kind: 'md', path: MD }], errors: [], device: null }),
      aiAnalyzeTranscript: async () => { if (hold) await hold; return ok(analysis); }
    }
  });
  await settle(20);
  h.document.getElementById('btnTrPick').click();
  await settle(10);
  h.document.getElementById('btnFmtAi').click();
  await settle(5);
  h.document.getElementById('btnTrStart').click();
  return h;
}

for (const [nome, flags] of [
  ['o modelo repetiu texto', { repeated: true }],
  ['a resposta foi cortada pelo limite', { truncated: true }],
  ['a união das partes falhou', { fallback: true }]
]) {
  test(`análise pronta mas incompleta (${nome}): a tela avisa, com o nome do arquivo`, async () => {
    const h = await begin({ path: 'D:/Gravacoes/aula 01.analise.md', ...flags });
    await settle(40);
    assert.equal(h.document.getElementById('trRoot').dataset.mode, 'done');
    assert.match(text(h, '#trNoticeText'), /A análise de “aula 01\.mp4” saiu incompleta/);
    assert.match(text(h, '#trNoticeText'), /O aviso está no começo do arquivo/);
    assert.equal(h.document.getElementById('trNotice').classList.contains('hidden'), false);
    await h.cleanup();
  });
}

test('análise pronta e inteira: nenhum aviso na tela', async () => {
  const h = await begin({ path: 'D:/Gravacoes/aula 01.analise.md', truncated: false, repeated: false, fallback: false });
  await settle(40);
  assert.equal(h.document.getElementById('trRoot').dataset.mode, 'done');
  assert.equal(text(h, '#trNoticeText'), '');
  await h.cleanup();
});

test('servidor mandou esperar o limite: a linha do arquivo diz quanto tempo falta, e some quando a análise segue', async () => {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const h = await begin({ path: 'D:/Gravacoes/aula 01.analise.md' }, hold);
  await settle(40);
  assert.equal(h.document.getElementById('trRoot').dataset.mode, 'running');
  h.bds.emit('onAiAnalysisProgress', { path: MD, stage: 'wait', seconds: 30, attempt: 1, percent: 25 });
  assert.match(text(h, '#trList'), /esperando o limite do servidor \(30 s\)/);
  h.bds.emit('onAiAnalysisProgress', { path: MD, stage: 'part', index: 2, total: 3, percent: 40 });
  assert.match(text(h, '#trList'), /parte 2 de 3/);
  assert.doesNotMatch(text(h, '#trList'), /esperando o limite/);
  release();
  await settle(40);
  assert.equal(h.document.getElementById('trRoot').dataset.mode, 'done');
  await h.cleanup();
});
