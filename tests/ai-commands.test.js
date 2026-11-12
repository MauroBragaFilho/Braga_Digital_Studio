'use strict';

// Comandos diretos do assistente (regras, sem modelo de IA): o que entendem, o que deixam para a IA e a execução
// pelo ToolBox (ids do banco/contexto, confirmação e resposta fixa). Também: o chat resolve sozinho, sem servidor de IA.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { matchCommand, runCommand } = require('../src/services/ai/commands');
const AssistantChat = require('../src/services/ai/AssistantChat');
const ChatHistory = require('../src/services/ai/ChatHistory');

test('entende pedidos simples e deixa o resto para a IA', () => {
  const m = (t) => matchCommand(t);
  assert.deepEqual([m('https://youtu.be/x').intent, m('https://youtu.be/x').format], ['download', 'video']);
  assert.equal(m('baixa https://youtu.be/x em 720p').quality, '720p');
  assert.deepEqual([m('baixar como mp3 https://a.com/b').format, m('baixar como mp3 https://a.com/b').quality], ['audio', 'melhor']);
  assert.equal(m('https://a.com/b o que é isso?'), null, 'link com outra pergunta vai para a IA');
  assert.equal(m('baixa e transcreve https://a.com/b').alsoTranscribe, true);
  assert.deepEqual(m('transcreve o selecionado'), { intent: 'transcribe', usesSelection: true, query: '' });
  assert.equal(m('transcrever a aula 14919').query, 'aula 14919');
  assert.deepEqual([m('converte isso para mp3 192k').mp3, m('converte isso para mp3 192k').preset], [true, '192k']);
  assert.equal(m('converte para mp4 720p').preset, '720p');
  assert.equal(m('tira o silêncio disso').usesSelection, true);
  assert.equal(m('reduz o silêncio do vídeo entrevista').mode, 'reduzir_05');
  assert.equal(m('como estão os downloads?').intent, 'status');
  for (const t of ['oi tudo bem', 'quais vídeos eu tenho?', '', 'converte', 'x'.repeat(700)]) assert.equal(m(t), null, t);
});

function fakeToolbox(handlers) {
  const calls = [];
  return {
    calls,
    deps: {},
    definitions: () => [],
    async execute(name, args) {
      calls.push({ name, args });
      const r = handlers[name] ? handlers[name](args) : { erro: 'sem ferramenta' };
      return JSON.stringify(r);
    }
  };
}

test('download: chama add_download e responde em texto fixo; recusa e erro são tratados', async () => {
  const tb = fakeToolbox({ add_download: () => ({ situacao: 'concluído' }) });
  const out = await runCommand({ text: 'baixa https://youtu.be/x', context: null, toolbox: tb });
  assert.deepEqual(tb.calls[0], { name: 'add_download', args: { url: 'https://youtu.be/x', formato: 'video', qualidade: 'melhor' } });
  assert.match(out, /baixei o vídeo/);
  const refused = await runCommand({ text: 'https://youtu.be/x', context: null, toolbox: fakeToolbox({ add_download: () => ({ resultado: 'O usuário recusou. Nada foi feito.' }) }) });
  assert.match(refused, /não fiz nada/);
  const bad = await runCommand({ text: 'https://youtu.be/x', context: null, toolbox: fakeToolbox({ add_download: () => ({ erro: 'Este link já foi baixado.' }) }) });
  assert.match(bad, /já foi baixado/);
});

test('mídia: usa a seleção, acha por nome, pede esclarecimento quando é ambíguo', async () => {
  const tb = fakeToolbox({ transcribe_media: () => ({ situacao: 'concluído' }), library_search: ({ texto }) => ({ midias: texto === 'aula' ? [{ id: 1, nome: 'Aula A.mp4', tipo: 'video' }, { id: 2, nome: 'Aula B.mp4', tipo: 'video' }] : texto === 'fim da rua' ? [{ id: 7, nome: 'Fim da Rua.mp4', tipo: 'video' }] : [] }) });
  await runCommand({ text: 'transcreve o selecionado', context: { selectedIds: [3, 4] }, toolbox: tb });
  assert.deepEqual(tb.calls.at(-1), { name: 'transcribe_media', args: { ids: [3, 4] } });
  assert.match(await runCommand({ text: 'transcreve isso', context: { selectedIds: [] }, toolbox: tb }), /Selecione a mídia/);
  await runCommand({ text: 'transcreve o fim da rua', context: null, toolbox: tb });
  assert.deepEqual(tb.calls.at(-1), { name: 'transcribe_media', args: { ids: [7] } });
  assert.match(await runCommand({ text: 'transcreve aula', context: null, toolbox: tb }), /2 mídias parecidas/);
  assert.match(await runCommand({ text: 'transcreve nada existe', context: null, toolbox: tb }), /Não achei/);
  const conv = fakeToolbox({ convert_media: () => ({ situacao: 'concluído' }) });
  await runCommand({ text: 'converte isso para mp3 192k', context: { selectedIds: [9] }, toolbox: conv });
  assert.deepEqual(conv.calls[0], { name: 'convert_media', args: { ids: [9], formato: 'mp3', predefinicao: '192k' } });
  const sil = fakeToolbox({ remove_silence: () => ({ situacao: 'concluído' }) });
  await runCommand({ text: 'tira o silêncio disso', context: { selectedIds: [9] }, toolbox: sil });
  assert.deepEqual(sil.calls[0], { name: 'remove_silence', args: { ids: [9], modo: 'remover' } });
  const st = fakeToolbox({ downloads_status: () => ({ na_fila: 1, baixando: 1, concluidos: 2, com_erro: 0, pausados: 0 }) });
  assert.match(await runCommand({ text: 'como estão os downloads?', context: null, toolbox: st }), /1 baixando, 1 na fila, 2 concluídos/);
  assert.equal(await runCommand({ text: 'conte uma piada', context: null, toolbox: st }), null);
});

test('o chat resolve o comando sozinho (sem chamar a IA) e guarda no histórico', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-cmd-'));
  const events = [];
  let aiCalled = false;
  const ai = { serverKey: () => 'k', chatStream: async () => { aiCalled = true; return { text: 'x', toolCalls: [] }; } };
  const tb = fakeToolbox({ add_download: () => ({ situacao: 'concluído' }) });
  const chat = new AssistantChat({ ai, history: new ChatHistory({ dir }), emit: (c, p) => events.push([c, p]), toolbox: tb });
  assert.equal(chat.canHandleLocally('baixa https://youtu.be/x'), true);
  assert.equal(chat.canHandleLocally('olá'), false);
  chat.start('baixa https://youtu.be/x');
  for (let i = 0; i < 100 && !events.some(([c]) => c === 'ai:chatDone'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(aiCalled, false);
  assert.match(events.find(([c]) => c === 'ai:chatDone')[1].text, /baixei o vídeo/);
  assert.equal(chat.getHistory().length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
