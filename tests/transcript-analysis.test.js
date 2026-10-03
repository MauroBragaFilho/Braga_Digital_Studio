'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AIService = require('../src/services/ai/AIService');
const tasks = require('../src/services/ai/tasks');
const { analyzeTranscriptFile } = require('../src/services/ai/analyzeFile');
const {
  SYSTEM_PROMPT, MERGE_PROMPT, parseTranscript, chunkTranscript, cleanModelText, analyzeTranscript,
  formatAnalysisDocument, readTranscriptFile
} = require('../src/services/ai/transcriptAnalysis');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bds-analysis-'));

/** Transcrição no formato do BDS com `count` trechos de ~`size` caracteres, um a cada 10 s. */
function makeMd(count, size = 200, title = 'aula 01') {
  let md = `# ${title}\n\nTranscrição automática (Whisper base). Duração: 01:00:00\n\n`;
  for (let i = 0; i < count; i++) {
    const s = i * 10;
    const stamp = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    md += `**[${stamp}]** ${`trecho ${i} `.repeat(Math.ceil(size / 9)).slice(0, size).trim()}\n\n`;
  }
  return md;
}

/** `chat` falso: registra as chamadas e responde com a função `reply(call, n)`. */
function fakeChat(reply = (call, n) => ({ text: `resposta ${n}` })) {
  const calls = [];
  const chat = async (args) => {
    calls.push({ system: args.system, content: args.messages[0].content, signal: args.signal });
    return reply(calls[calls.length - 1], calls.length);
  };
  return { chat, calls };
}

// ------------------------------------------------------------------ leitura

test('parseTranscript: lê o Markdown do BDS (título, tempos e continuação de linha)', () => {
  const md = '# aula 01\n\nTranscrição automática (Whisper base). Duração: 00:10:00\n\n'
    + '**[00:00:03]** Bom dia, pessoal.\n\n**[00:01:05]** Hoje vamos ver\nconstituição federal.\n\n**[01:02:03]** Fim.\n';
  const p = parseTranscript(md);
  assert.equal(p.title, 'aula 01');
  assert.deepEqual(p.segments, [
    { start: 3, text: 'Bom dia, pessoal.' },
    { start: 65, text: 'Hoje vamos ver constituição federal.' },
    { start: 3723, text: 'Fim.' }
  ]);
});

test('parseTranscript: .srt vira trechos de ~20 s, sem etiquetas e com BOM/CRLF', () => {
  const srt = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\n<i>Olá</i> pessoal\r\n\r\n2\r\n00:00:03,500 --> 00:00:05,000\r\nbem-vindos\r\n\r\n'
    + '3\r\n00:00:40,000 --> 00:00:42,000\r\nsegundo trecho\r\n';
  const p = parseTranscript(srt);
  assert.deepEqual(p.segments, [{ start: 1, text: 'Olá pessoal bem-vindos' }, { start: 40, text: 'segundo trecho' }]);
});

test('parseTranscript: texto puro vira parágrafos sem tempo; vazio não gera trechos', () => {
  assert.deepEqual(parseTranscript('primeiro  parágrafo\nainda ele\n\nsegundo').segments,
    [{ start: null, text: 'primeiro parágrafo ainda ele' }, { start: null, text: 'segundo' }]);
  assert.deepEqual(parseTranscript('  \n\n ').segments, []);
  assert.deepEqual(parseTranscript(undefined).segments, []);
});

// ------------------------------------------------------------------ divisão

test('chunkTranscript: respeita o limite, mantém a ordem e não perde texto', () => {
  const segments = parseTranscript(makeMd(60, 300)).segments;
  const chunks = chunkTranscript(segments, 2500);
  assert.ok(chunks.length > 4);
  assert.ok(chunks.every((c) => c.text.length <= 2500), 'parte maior que o limite');
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
  const joined = chunks.map((c) => c.text).join('\n');
  for (const seg of segments) assert.ok(joined.includes(seg.text), `perdeu: ${seg.text.slice(0, 30)}`);
  assert.equal(chunks[0].from, 0);
  assert.equal(chunks[chunks.length - 1].to, 590);
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].from > chunks[i - 1].from);
});

test('chunkTranscript: um trecho gigante é cortado em frases, nunca passa do limite', () => {
  const sentence = 'Esta é uma frase de teste com tamanho razoável. ';
  const segments = [{ start: 12, text: sentence.repeat(200).trim() }];
  const chunks = chunkTranscript(segments, 2000);
  assert.ok(chunks.length >= 5);
  assert.ok(chunks.every((c) => c.text.length <= 2000));
  assert.ok(chunks.every((c) => c.text.startsWith('[00:00:12] ')));
  assert.ok(chunks.slice(0, -1).every((c) => /\.$/.test(c.text)), 'deveria cortar no fim de uma frase');
  // sem espaços nem pontos: corte seco, mas o texto inteiro é mantido
  const solid = chunkTranscript([{ start: null, text: 'x'.repeat(5000) }], 2000);
  assert.equal(solid.map((c) => c.text).join('').length, 5000);
});

test('cleanModelText: remove o raciocínio (<think>) dos modelos locais', () => {
  assert.equal(cleanModelText('<think>pensando…</think>\n\n## Resumo\nok'), '## Resumo\nok');
  assert.equal(cleanModelText('pensamento sem abertura</think>Resposta'), 'Resposta');
  assert.equal(cleanModelText('<THINK>a</THINK>Oi<think>b</think>!'), 'Oi!');
  assert.equal(cleanModelText('resposta<think>cortou no meio'), 'resposta');
  assert.equal(cleanModelText(null), '');
});

// ------------------------------------------------------------------ análise

test('transcrição curta: uma única chamada, com o mesmo prompt do projeto Whisper + LM Studio', async () => {
  const { chat, calls } = fakeChat(() => ({ text: '## Resumo\nAula curta.', model: 'qwen-7b', usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  const progress = [];
  const out = await analyzeTranscript({ text: makeMd(5) }, { chat, onProgress: (p) => progress.push(p) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, SYSTEM_PROMPT);
  assert.ok(calls[0].content.startsWith('TRANSCRIÇÃO:\n\n[00:00:00] trecho 0'));
  for (const trecho of ['Resumo', 'Principais assuntos', 'Pontos importantes', 'Trechos potencialmente relevantes', 'Não invente', 'Responda em português']) {
    assert.ok(SYSTEM_PROMPT.includes(trecho), trecho);
  }
  assert.equal(out.markdown, '## Resumo\nAula curta.');
  assert.equal(out.title, 'aula 01');
  assert.equal(out.chunks, 1);
  assert.equal(out.model, 'qwen-7b');
  assert.deepEqual(out.usage, { promptTokens: 100, completionTokens: 20 });
  assert.equal(progress[progress.length - 1].percent, 100);
});

test('transcrição longa: analisa por partes e junta tudo numa análise final', async () => {
  const { chat, calls } = fakeChat((call, n) => ({ text: call.system === MERGE_PROMPT ? `UNIDA ${n}` : `parcial ${n}` }));
  const progress = [];
  const out = await analyzeTranscript({ text: makeMd(120, 400) }, { chat, maxChunkChars: 6000, onProgress: (p) => progress.push(p) });

  const parts = calls.filter((c) => c.system !== MERGE_PROMPT);
  const merges = calls.filter((c) => c.system === MERGE_PROMPT);
  assert.ok(parts.length >= 6, `partes: ${parts.length}`);
  assert.equal(out.chunks, parts.length);
  assert.ok(merges.length >= 1);
  // as partes vêm primeiro, em ordem, cada uma sabendo qual é
  assert.deepEqual(calls.slice(0, parts.length).map((c) => c.system !== MERGE_PROMPT), parts.map(() => true));
  parts.forEach((c, i) => {
    assert.ok(c.system.startsWith(SYSTEM_PROMPT));
    assert.ok(c.system.includes(`parte ${i + 1} de ${parts.length}`), c.system);
    assert.ok(c.content.startsWith(`TRANSCRIÇÃO (parte ${i + 1} de ${parts.length}):`));
    assert.ok(c.content.length <= 6100);
  });
  // a última chamada é a união final, e o resultado é o texto dela
  assert.equal(calls[calls.length - 1].system, MERGE_PROMPT);
  assert.equal(out.markdown, `UNIDA ${calls.length}`);
  assert.ok(merges[0].content.includes('### Parte 1 (00:00:00–'), merges[0].content.slice(0, 200));
  assert.ok(merges.every((c) => c.content.length < 20000));
  // andamento: nunca volta atrás e termina em 100
  const percents = progress.map((p) => p.percent);
  assert.ok(percents.every((p, i) => i === 0 || p >= percents[i - 1]), percents.join(','));
  assert.equal(percents[percents.length - 1], 100);
  assert.deepEqual(progress.filter((p) => p.stage === 'part').map((p) => p.index), parts.map((_, i) => i + 1));
});

test('união termina mesmo quando cada análise parcial é enorme (não entra em laço infinito)', async () => {
  const huge = 'a'.repeat(30000); // resposta absurda de um modelo com limite alto de tokens
  const { chat, calls } = fakeChat((call) => ({ text: call.system === MERGE_PROMPT ? 'final' : huge }));
  const out = await analyzeTranscript({ text: makeMd(40, 400) }, { chat, maxChunkChars: 4000 });
  assert.equal(out.markdown, 'final');
  assert.ok(calls.length < 60, `chamadas demais: ${calls.length}`);
  assert.ok(calls.every((c) => c.content.length < 20000), 'mensagem acima do limite do AIService');
});

test('cancelar entre as chamadas interrompe a análise sem chamar mais nada', async () => {
  const controller = new AbortController();
  const { chat, calls } = fakeChat((call, n) => { if (n === 2) controller.abort(); return { text: `p${n}` }; });
  await assert.rejects(
    analyzeTranscript({ text: makeMd(100, 400) }, { chat, maxChunkChars: 4000, signal: controller.signal }),
    (e) => e.code === 'CANCELLED'
  );
  assert.equal(calls.length, 2);
});

test('falhas claras: resposta vazia, transcrição vazia, resposta cortada pelo limite', async () => {
  await assert.rejects(analyzeTranscript({ text: makeMd(3) }, { chat: fakeChat(() => ({ text: '  ' })).chat }), /não devolveu texto/);
  await assert.rejects(analyzeTranscript({ text: '  ' }, { chat: fakeChat().chat }), /vazia/);
  await assert.rejects(analyzeTranscript({ text: 'abc' }, {}), /servidor de IA/);
  const cut = await analyzeTranscript({ text: makeMd(3) }, { chat: fakeChat(() => ({ text: 'meio da resposta', finishReason: 'length' })).chat });
  assert.equal(cut.truncated, true);
  assert.match(formatAnalysisDocument({ title: 't', markdown: cut.markdown, truncated: true }), /cortada pelo limite/);
});

test('formatAnalysisDocument: avisa que é IA e quantas partes foram usadas', () => {
  const doc = formatAnalysisDocument({ title: 'aula 01', model: 'qwen-7b', markdown: '\n## Resumo\nok\n', chunks: 5 });
  assert.ok(doc.startsWith('# Análise: aula 01\n\n> Gerada por IA (qwen-7b).'));
  assert.ok(doc.includes('analisada em 5 partes'));
  assert.ok(doc.endsWith('## Resumo\nok\n'));
  assert.ok(formatAnalysisDocument({ markdown: 'x' }).startsWith('# Análise da transcrição'));
});

// ------------------------------------------------------------------ arquivos

test('readTranscriptFile: só caminhos absolutos, formatos de texto e até 5 MB', () => {
  const dir = tmpDir();
  const md = path.join(dir, 'aula.md');
  fs.writeFileSync(md, '# aula\n\n**[00:00:01]** oi\n');
  assert.deepEqual(readTranscriptFile(md), { text: '# aula\n\n**[00:00:01]** oi\n', title: 'aula' });
  assert.throws(() => readTranscriptFile('aula.md'), /inválido/);
  assert.throws(() => readTranscriptFile(path.join(dir, 'nada.md')), /não encontrado/);
  const exe = path.join(dir, 'x.exe');
  fs.writeFileSync(exe, 'MZ');
  assert.throws(() => readTranscriptFile(exe), /Formato não suportado/);
  assert.throws(() => readTranscriptFile(dir), /Formato não suportado|não encontrado/);
  const big = path.join(dir, 'grande.txt');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 6 * 1024 * 1024);
  assert.throws(() => readTranscriptFile(big), /grande demais/);
});

// ------------------------------------------------------------------ AIService de ponta a ponta

/** fetch falso de um servidor OpenAI-compatível (LM Studio). */
function fakeServer(reply) {
  const requests = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body, headers: init.headers });
    const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    if (init.signal) {
      if (init.signal.aborted) return onAbort();
      init.signal.addEventListener('abort', onAbort, { once: true });
    }
    const out = reply(body, requests.length);
    if (out === 'hang') return; // fica pendente até ser cancelado
    resolve({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(out) });
  });
  return { fetchImpl, requests };
}

const completion = (content, extra = {}) => ({
  model: 'qwen2.5-7b-instruct',
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 50, completion_tokens: 30 },
  ...extra
});

function makeService(fetchImpl) {
  const ai = new AIService({ configDir: tmpDir(), fetchImpl });
  ai.saveConfig({ baseUrl: 'http://localhost:1234/v1', model: 'qwen2.5-7b-instruct' });
  return ai;
}

test('a tarefa analyzeTranscript está registrada e ativa', () => {
  const t = tasks.list().find((x) => x.id === 'analyzeTranscript');
  assert.ok(t && t.implemented === true);
  assert.equal(new AIService({ configDir: tmpDir() }).getPublicConfig().tasks.find((x) => x.id === 'analyzeTranscript').implemented, true);
});

test('AIService + servidor local: o texto vai ao /chat/completions e a análise volta formatada', async () => {
  const server = fakeServer(() => completion('## Resumo\nAula sobre direito.'));
  const ai = makeService(server.fetchImpl);
  const out = await ai.runTask('analyzeTranscript', { text: makeMd(4), title: 'Aula 7' });

  assert.equal(server.requests.length, 1);
  const req = server.requests[0];
  assert.equal(req.url, 'http://localhost:1234/v1/chat/completions');
  assert.equal(req.body.model, 'qwen2.5-7b-instruct');
  assert.equal(req.body.messages[0].role, 'system');
  assert.equal(req.body.messages[0].content, SYSTEM_PROMPT);
  assert.ok(req.body.messages[1].content.startsWith('TRANSCRIÇÃO:\n\n[00:00:00]'));
  assert.equal(req.headers.authorization, undefined, 'servidor local não exige chave');
  assert.ok(out.document.startsWith('# Análise: Aula 7'));
  assert.ok(out.document.includes('(qwen2.5-7b-instruct)'));
  assert.ok(out.document.includes('## Resumo\nAula sobre direito.'));
  assert.equal(ai.getPublicConfig().isLocal, true);
});

test('cancelar com o servidor ainda pensando aborta a requisição (code CANCELLED, não "tempo esgotado")', async () => {
  const server = fakeServer(() => 'hang');
  const ai = makeService(server.fetchImpl);
  const controller = new AbortController();
  const pending = ai.runTask('analyzeTranscript', { text: makeMd(4) }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (e) => e.code === 'CANCELLED' && /cancelad/i.test(e.message));
  assert.equal(server.requests.length, 1);
});

test('erro do servidor aparece com mensagem clara', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, statusText: 'Bad Request', text: async () => JSON.stringify({ error: { message: 'No models loaded.' } }) });
  const ai = makeService(fetchImpl);
  await assert.rejects(ai.runTask('analyzeTranscript', { text: makeMd(2) }), /No models loaded/);
});

test('analyzeTranscriptFile: grava <nome>.analise.md ao lado e nunca sobrescreve', async () => {
  const dir = tmpDir();
  const md = path.join(dir, 'aula 01.md');
  fs.writeFileSync(md, makeMd(6, 200, 'aula 01'));
  const server = fakeServer(() => completion('## Resumo\nok'));
  const ai = makeService(server.fetchImpl);

  const first = await analyzeTranscriptFile(ai, { filePath: md });
  assert.equal(first.path, path.join(dir, 'aula 01.analise.md'));
  assert.ok(fs.readFileSync(first.path, 'utf8').includes('## Resumo\nok'));
  assert.equal(first.chunks, 1);

  const second = await analyzeTranscriptFile(ai, { filePath: md });
  assert.equal(second.path, path.join(dir, 'aula 01.analise (2).md'));
  assert.ok(fs.existsSync(first.path), 'a primeira análise foi mantida');

  // a transcrição original não é tocada
  assert.ok(fs.readFileSync(md, 'utf8').startsWith('# aula 01'));
});

test('analyzeTranscriptFile: .srt também serve e arquivo inválido nem chega ao servidor', async () => {
  const dir = tmpDir();
  const srt = path.join(dir, 'video.srt');
  fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:04,000\nOlá pessoal\n\n2\n00:00:05,000 --> 00:00:08,000\nvamos começar\n');
  const server = fakeServer(() => completion('ok'));
  const ai = makeService(server.fetchImpl);
  const out = await analyzeTranscriptFile(ai, { filePath: srt });
  assert.equal(path.basename(out.path), 'video.analise.md');
  assert.ok(server.requests[0].body.messages[1].content.includes('[00:00:01] Olá pessoal vamos começar'));

  const before = server.requests.length;
  await assert.rejects(analyzeTranscriptFile(ai, { filePath: path.join(dir, 'x.exe') }), /Formato não suportado|não encontrado/);
  await assert.rejects(analyzeTranscriptFile(ai, { filePath: 'relativo.md' }), /inválido/);
  assert.equal(server.requests.length, before);
});
