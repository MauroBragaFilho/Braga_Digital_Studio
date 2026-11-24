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
  // nome que não existe: não é beco sem saída, a IA assume (null)
  assert.equal(await runCommand({ text: 'transcreve nada existe', context: null, toolbox: tb }), null);
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

test('"o último / o que acabei de baixar" é referência à Biblioteca, não nome de arquivo', () => {
  const m = (t) => matchCommand(t);
  assert.deepEqual(m('pode transcrever o áudio que acabou de baixar').recent, { kind: 'audio', by: 'importacao', downloaded: true });
  assert.deepEqual(m('transcreve o último vídeo baixado').recent, { kind: 'video', by: 'importacao', downloaded: true });
  assert.deepEqual(m('converte o último vídeo para mp3').recent, { kind: 'video', by: 'importacao', downloaded: false });
  assert.equal(m('tira o silêncio do último vídeo gravado').recent.by, 'gravacao');
  assert.equal(m('transcreve o fim da rua').recent, undefined, 'nome comum continua sendo nome');
});

test('último baixado: busca por ordem de importação nas baixadas e age sobre o id achado', async () => {
  const tb = fakeToolbox({
    library_search: () => ({ midias: [{ id: 41, nome: 'Entrevista.mp3', tipo: 'audio' }, { id: 40, nome: 'Outro.mp3', tipo: 'audio' }] }),
    transcribe_media: () => ({ situacao: 'concluído' })
  });
  await runCommand({ text: 'pode transcrever o áudio que acabou de baixar', context: null, toolbox: tb });
  assert.deepEqual(tb.calls[0], { name: 'library_search', args: { ordenar: 'importacao', limite: 6, baixadas: true, tipo: 'audio' } });
  assert.deepEqual(tb.calls.at(-1), { name: 'transcribe_media', args: { ids: [41] } });
  const vazio = fakeToolbox({ library_search: () => ({ midias: [] }) });
  assert.equal(await runCommand({ text: 'transcreve o último vídeo baixado', context: null, toolbox: vazio }), null, 'sem resultado: a IA assume');
});

test('baixa e transcreve: espera o arquivo entrar na Biblioteca e transcreve o novo', async () => {
  let polls = 0;
  const tb = fakeToolbox({
    add_download: () => ({ situacao: 'concluído' }),
    library_search: () => ({ midias: ++polls < 3 ? [{ id: 10, nome: 'Antigo.mp3', tipo: 'audio' }] : [{ id: 11, nome: 'Novo.mp3', tipo: 'audio' }, { id: 10, nome: 'Antigo.mp3', tipo: 'audio' }] }),
    transcribe_media: () => ({ situacao: 'concluído' })
  });
  const out = await runCommand({ text: 'pode baixar o audio e transcrever ele? https://youtu.be/x', context: null, toolbox: tb });
  assert.deepEqual(tb.calls.at(-1), { name: 'transcribe_media', args: { ids: [11] } });
  assert.match(out, /baixei o áudio/);
  assert.match(out, /Transcrevi o áudio/);
});

test('link só para transcrever baixa em MP3; vídeo só se o usuário pedir', () => {
  const m = (t) => matchCommand(t);
  assert.deepEqual([m('transcreve https://youtu.be/x').format, m('transcreve https://youtu.be/x').alsoTranscribe], ['audio', true]);
  assert.equal(m('baixa e transcreve https://a.com/b').format, 'audio');
  assert.equal(m('transcreve o vídeo https://a.com/b em mp4').format, 'video');
  assert.equal(m('baixa https://a.com/b').format, 'video', 'só baixar continua em vídeo');
  assert.equal(m('https://a.com/b o que é isso?'), null);
});
