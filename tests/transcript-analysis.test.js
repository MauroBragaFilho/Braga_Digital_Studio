'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AIService = require('../src/services/ai/AIService');
const tasks = require('../src/services/ai/tasks');
const { analyzeTranscriptFile } = require('../src/services/ai/analyzeFile');
const {
  SYSTEM_PROMPT, MERGE_PROMPT, STAGE_TOKENS, ANALYSIS_SAMPLING, RETRY_SAMPLING, parseTranscript, chunkTranscript, splitChunk,
  cleanModelText, dropRepeats, displayModel, analyzeTranscript, formatAnalysisDocument, readTranscriptFile
} = require('../src/services/ai/transcriptAnalysis');

const dirs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-analysis-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // antes cada execução deixava pastas no %TEMP%

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
    calls.push({ system: args.system, content: args.messages[0].content, signal: args.signal, maxTokens: args.maxTokens, sampling: args.sampling });
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

// ------------------------------------------------------------------ modelo pequeno e servidor com limite baixo
// Caso real: a análise de uma transcrição de 18 min, no modelo local de 2B, voltou com a mesma linha 91 vezes (78% do arquivo) e sem
// a seção 4; e, no Groq (8 mil tokens por minuto), cada chamada pedia 8192 tokens de resposta e as chamadas saíam coladas.

/** Uma análise de verdade: as quatro seções, cada item uma vez. */
const GOOD = '**1. Resumo**\nO episódio fala de aniversários.\n\n**2. Principais assuntos**\n- Aniversário e sumiço.\n\n'
  + '**3. Pontos importantes**\n- Quem some planeja o sumiço.\n\n**4. Trechos potencialmente relevantes**\n- [00:01:37] Quem some planeja o sumiço.';
const LOOP_LINE = '- O aniversário é um dia em que a pessoa é considerada "impessoal", e que não pode ser tratada como uma pessoa normal.';
/** O que veio no arquivo corrompido: a mesma linha, dezenas de vezes. */
const LOOP = (n = 40) => `**1. Resumo**\nResumo curto.\n\n**3. Pontos importantes**\n${Array.from({ length: n }, () => LOOP_LINE).join('\n')}`;
const PART = (n) => `**1. Resumo**\nResumo da parte ${n}.`;

test('cada etapa pede só o tamanho de resposta de que precisa e a amostragem recomendada (nunca o limite global)', async () => {
  const short = fakeChat(() => ({ text: GOOD }));
  await analyzeTranscript({ text: makeMd(5) }, { chat: short.chat });
  assert.equal(short.calls[0].maxTokens, STAGE_TOKENS.single);
  assert.deepEqual(short.calls[0].sampling, ANALYSIS_SAMPLING);

  const long = fakeChat(() => ({ text: GOOD }));
  await analyzeTranscript({ text: makeMd(120, 400) }, { chat: long.chat, maxChunkChars: 6000 });
  assert.ok(long.calls.length >= 3);
  for (const c of long.calls) {
    assert.equal(c.maxTokens, c.system === MERGE_PROMPT ? STAGE_TOKENS.merge : STAGE_TOKENS.part);
    assert.deepEqual(c.sampling, ANALYSIS_SAMPLING);
  }
  // tetos pequenos: um laço não enche a janela de contexto nem passa do limite por minuto de um servidor gratuito
  assert.ok(STAGE_TOKENS.part <= 1200 && STAGE_TOKENS.merge <= 2000 && STAGE_TOKENS.single <= 2000);
  // valores do cartão oficial do Qwen3-VL-2B-Instruct
  assert.deepEqual({ ...ANALYSIS_SAMPLING }, { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 });
});

test('dropRepeats: a linha repetida em laço fica só uma vez; no mesmo bloco, igual é descartada; entre blocos, volta se for só 2 vezes', () => {
  const r = dropRepeats(LOOP(91));
  assert.equal(r.dropped, 90);
  assert.equal((r.text.match(/impessoal/g) || []).length, 1);
  assert.ok(r.text.includes('**1. Resumo**') && r.text.includes('Resumo curto.') && r.text.includes('**3. Pontos importantes**'));

  const item = '- Item importante que aparece nas duas seções da análise.';
  const across = `**2. Principais assuntos**\n${item}\n- Outro.\n\n**3. Pontos importantes**\n${item}`;
  assert.deepEqual(dropRepeats(across), { text: across, dropped: 0 }, 'o mesmo item em seções diferentes é legítimo');
  const same = `**4. Trechos**\n${item}\n- Outro trecho qualquer.\n${item}`;
  assert.equal(dropRepeats(same).dropped, 1, 'a mesma linha duas vezes na mesma lista é redundância');
  assert.equal((dropRepeats(same).text.match(/nas duas seções/g) || []).length, 1);
  const trio = `**2. A**\n${item}\n**3. B**\n${item}\n**4. C**\n${item}`;
  assert.equal(dropRepeats(trio).dropped, 2, 'três vezes ou mais, mesmo em seções diferentes: só a primeira');
  assert.equal(dropRepeats(Array.from({ length: 10 }, () => '- Sim.').join('\n')).dropped, 0, 'linha curta nunca conta como laço');
  const marks = ['- A mesma frase longa repetida em laço aqui.', '* A mesma frase longa repetida em laço aqui.', '• A mesma frase longa repetida em laço aqui.'];
  assert.equal(dropRepeats(marks.join('\n')).dropped, 2, 'marcadores diferentes são o mesmo item');

  const sentence = 'O narrador conta que o amigo desliga o celular no dia do aniversário.';
  const p = dropRepeats(`Começo do resumo. ${sentence} ${sentence} ${sentence} ${sentence} Fim do resumo.`);
  assert.equal((p.text.match(/desliga o celular/g) || []).length, 1, 'a mesma frase repetida dentro de um parágrafo');
  assert.ok(p.text.includes('Começo do resumo.') && p.text.includes('Fim do resumo.'));
  assert.equal(p.dropped, 3);
  assert.deepEqual(dropRepeats(GOOD), { text: GOOD, dropped: 0 }, 'uma análise normal passa intacta');
});

test('resposta em laço: a repetição é cortada e a chamada é refeita uma vez com amostragem mais rígida', async () => {
  const { chat, calls } = fakeChat((call, n) => ({ text: n === 1 ? LOOP(60) : GOOD }));
  const out = await analyzeTranscript({ text: makeMd(5) }, { chat });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].sampling, ANALYSIS_SAMPLING);
  assert.deepEqual(calls[1].sampling, RETRY_SAMPLING);
  assert.ok(RETRY_SAMPLING.presence_penalty > ANALYSIS_SAMPLING.presence_penalty);
  assert.equal(out.markdown, GOOD);
  assert.equal(out.repeated, false, 'a segunda tentativa saiu boa');

  // laço de novo: segue com o texto sem a repetição e avisa
  const again = fakeChat(() => ({ text: LOOP(60) }));
  const bad = await analyzeTranscript({ text: makeMd(5) }, { chat: again.chat });
  assert.equal(again.calls.length, 2, 'só UMA nova tentativa');
  assert.equal(bad.repeated, true);
  assert.equal((bad.markdown.match(/impessoal/g) || []).length, 1);
  assert.match(formatAnalysisDocument({ title: 't', markdown: bad.markdown, repeated: true }), /repetiu trechos; as repetições foram removidas/);
});

test('união em laço: o documento traz a análise de cada parte, em ordem, sem a repetição', async () => {
  const { chat, calls } = fakeChat((call, n) => ({ text: call.system === MERGE_PROMPT ? LOOP(80) : PART(n) }));
  const out = await analyzeTranscript({ text: makeMd(120, 400) }, { chat, maxChunkChars: 6000 });
  assert.equal(out.fallback, true);
  assert.equal(out.repeated, true);
  assert.equal(calls.filter((c) => c.system === MERGE_PROMPT).length, 2, 'a união foi tentada duas vezes');
  assert.ok(!out.markdown.includes('impessoal'));
  assert.match(out.markdown, /^### Parte 1 \(00:00:00–/);
  assert.ok(out.markdown.indexOf('Resumo da parte 1.') < out.markdown.indexOf('Resumo da parte 2.'));
  assert.match(formatAnalysisDocument({ title: 't', markdown: out.markdown, chunks: out.chunks, fallback: true }), /A união das partes não ficou boa/);
});

test('a união falha (servidor caiu): o trabalho das partes não se perde; cancelar continua cancelando', async () => {
  const fail = fakeChat((call, n) => { if (call.system === MERGE_PROMPT) throw new Error('servidor caiu'); return { text: PART(n) }; });
  const out = await analyzeTranscript({ text: makeMd(40, 400) }, { chat: fail.chat, maxChunkChars: 4000 });
  assert.equal(out.fallback, true);
  assert.ok(out.markdown.includes('### Parte 1 (') && out.markdown.includes('Resumo da parte 1.'));

  const cancel = fakeChat((call) => { if (call.system === MERGE_PROMPT) throw Object.assign(new Error('c'), { code: 'CANCELLED' }); return { text: 'p' }; });
  await assert.rejects(analyzeTranscript({ text: makeMd(40, 400) }, { chat: cancel.chat, maxChunkChars: 4000 }), (e) => e.code === 'CANCELLED');
});

test('união cortada pelo limite: sem as quatro seções cai nas partes; com as quatro seções vale como veio', async () => {
  const cut = (text) => fakeChat((call) => (call.system === MERGE_PROMPT ? { text, finishReason: 'length' } : { text: PART(1) }));
  const half = await analyzeTranscript({ text: makeMd(40, 400) }, { chat: cut('**1. Resumo**\nsó o começo').chat, maxChunkChars: 4000 });
  assert.equal(half.fallback, true);
  assert.ok(half.markdown.includes('### Parte 1 ('));
  const full = await analyzeTranscript({ text: makeMd(40, 400) }, { chat: cut(GOOD).chat, maxChunkChars: 4000 });
  assert.equal(full.fallback, false);
  assert.equal(full.truncated, true);
  assert.equal(full.markdown, GOOD);
});

test('limite de uso do servidor (429): espera o tempo pedido, avisa o andamento e continua', async () => {
  const waits = [];
  const progress = [];
  let tries = 0;
  const { chat, calls } = fakeChat(() => {
    if (tries++ < 2) throw Object.assign(new Error('limite'), { code: 'AI_ALL_FAILED', rateLimited: true, retryAfter: 7 });
    return { text: GOOD };
  });
  const out = await analyzeTranscript({ text: makeMd(5) }, { chat, sleep: async (ms) => { waits.push(ms); }, onProgress: (p) => progress.push(p) });
  assert.equal(out.markdown, GOOD);
  assert.deepEqual(waits, [7000, 7000]);
  assert.deepEqual(progress.filter((p) => p.stage === 'wait').map((p) => [p.seconds, p.attempt]), [[7, 1], [7, 2]]);
  assert.equal(calls.length, 3);
  assert.equal(out.calls, 1, 'só a chamada que respondeu conta');

  // sem Retry-After: 30 s; um 429 cru (sem as dicas do AIService) também espera
  const raw = [];
  let n = 0;
  const r2 = fakeChat(() => { if (n++ === 0) throw Object.assign(new Error('Servidor (429)'), { status: 429 }); return { text: GOOD }; });
  await analyzeTranscript({ text: makeMd(5) }, { chat: r2.chat, sleep: async (ms) => { raw.push(ms); } });
  assert.deepEqual(raw, [30000]);
});

test('limite do DIA, pedido grande demais e outros erros não ficam esperando à toa; a insistência tem fim', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const day = fakeChat(() => { throw Object.assign(new Error('limite do dia'), { rateLimited: true, retryAfter: 7200 }); });
  await assert.rejects(analyzeTranscript({ text: makeMd(5) }, { chat: day.chat, sleep }), /limite do dia/);
  const big = fakeChat(() => { throw Object.assign(new Error('grande demais'), { status: 429, tooLarge: true, retryAfter: 5 }); });
  await assert.rejects(analyzeTranscript({ text: makeMd(1, 100) }, { chat: big.chat, sleep }), /grande demais/); // uma linha só: não dá para dividir
  const down = fakeChat(() => { throw new Error('servidor caiu'); });
  await assert.rejects(analyzeTranscript({ text: makeMd(5) }, { chat: down.chat, sleep }), /servidor caiu/);
  assert.deepEqual(waits, []);

  const always = fakeChat(() => { throw Object.assign(new Error('sempre limite'), { rateLimited: true, retryAfter: 5 }); });
  await assert.rejects(analyzeTranscript({ text: makeMd(5) }, { chat: always.chat, sleep }), /sempre limite/);
  assert.equal(waits.length, 4);
  assert.equal(always.calls.length, 5);
});

test('cancelar durante a espera do limite interrompe a análise', async () => {
  const controller = new AbortController();
  const { chat, calls } = fakeChat(() => { throw Object.assign(new Error('limite'), { rateLimited: true, retryAfter: 5 }); });
  await assert.rejects(
    analyzeTranscript({ text: makeMd(5) }, { chat, signal: controller.signal, sleep: async () => { controller.abort(); } }),
    (e) => e.code === 'CANCELLED'
  );
  assert.equal(calls.length, 1);
});

test('pedido grande demais (413): a parte é dividida ao meio e cada metade é analisada', async () => {
  const { chat, calls } = fakeChat((call) => {
    if (call.system !== MERGE_PROMPT && call.content.length > 3000) throw Object.assign(new Error('Servidor (413): Request too large'), { status: 413 });
    return { text: call.system === MERGE_PROMPT ? GOOD : PART(1) };
  });
  const out = await analyzeTranscript({ text: makeMd(40, 400) }, { chat, maxChunkChars: 4500 });
  const parts = calls.filter((c) => c.system !== MERGE_PROMPT);
  assert.ok(parts.some((c) => c.content.length > 3000), 'a primeira tentativa de cada parte foi a grande');
  assert.ok(parts.some((c) => c.content.length <= 3000), 'e as metades couberam');
  assert.equal(out.fallback, false);
  assert.equal(out.markdown, GOOD);
  assert.ok(calls.every((c) => c.content.length < 20000));
});

test('transcrição curta que o servidor recusa por tamanho vira duas partes', async () => {
  const { chat, calls } = fakeChat((call) => {
    if (call.system !== MERGE_PROMPT && call.content.length > 2500) throw Object.assign(new Error('x'), { status: 413 });
    return { text: GOOD };
  });
  const out = await analyzeTranscript({ text: makeMd(10, 400) }, { chat }); // ~4 mil caracteres: cabe numa chamada só
  assert.equal(out.chunks, 2);
  assert.equal(calls.length, 4); // a recusada + duas partes + a união
  assert.equal(out.markdown, GOOD);
});

test('janela de contexto estourada (400 do servidor local) também divide a parte', async () => {
  const { chat } = fakeChat((call) => {
    if (call.system !== MERGE_PROMPT && call.content.length > 2500) throw Object.assign(new Error('Servidor (400): request (3300 tokens) exceeds the available context size (2048 tokens)'), { status: 400 });
    return { text: GOOD };
  });
  const out = await analyzeTranscript({ text: makeMd(10, 400) }, { chat });
  assert.equal(out.chunks, 2);
  // um 400 qualquer (conteúdo recusado) continua sendo erro
  const other = fakeChat(() => { throw Object.assign(new Error('Servidor (400): conteúdo recusado'), { status: 400 }); });
  await assert.rejects(analyzeTranscript({ text: makeMd(10, 400) }, { chat: other.chat }), /conteúdo recusado/);
});

test('união grande demais (413): encolhe as análises e tenta de novo; se nunca couber, usa as partes', async () => {
  const sizes = [];
  const { chat } = fakeChat((call) => {
    if (call.system === MERGE_PROMPT) {
      sizes.push(call.content.length);
      if (call.content.length > 4000) throw Object.assign(new Error('grande'), { status: 413 });
      return { text: GOOD };
    }
    return { text: `${'x'.repeat(2500)}\n**1. Resumo**` };
  });
  const out = await analyzeTranscript({ text: makeMd(40, 400) }, { chat, maxChunkChars: 4000 });
  assert.equal(out.fallback, false);
  assert.ok(sizes.length >= 3 && sizes[0] > 4000 && sizes[sizes.length - 1] <= 4000, sizes.join(','));

  const never = fakeChat((call) => { if (call.system === MERGE_PROMPT) throw Object.assign(new Error('grande'), { status: 413 }); return { text: PART(1) }; });
  const out2 = await analyzeTranscript({ text: makeMd(40, 400) }, { chat: never.chat, maxChunkChars: 4000 });
  assert.equal(out2.fallback, true);
  assert.equal(never.calls.filter((c) => c.system === MERGE_PROMPT).length, 3, 'inteiro, metade e um quarto');
});

test('modelo que gasta o teto "pensando" e devolve nada: libera mais espaço e refaz, nesta etapa e nas seguintes', async () => {
  const { chat, calls } = fakeChat((call, n) => (n === 1 ? { text: '', finishReason: 'length' } : { text: GOOD }));
  const out = await analyzeTranscript({ text: makeMd(5) }, { chat });
  assert.equal(out.markdown, GOOD);
  assert.deepEqual(calls.map((c) => c.maxTokens), [STAGE_TOKENS.single, STAGE_TOKENS.single * 3]);
  // vazio sem ser por tamanho continua sendo erro
  await assert.rejects(analyzeTranscript({ text: makeMd(5) }, { chat: fakeChat(() => ({ text: '' })).chat }), /não devolveu texto/);
  // a folga vale para as próximas etapas
  let n = 0;
  const long = fakeChat(() => (n++ === 0 ? { text: '', finishReason: 'length' } : { text: GOOD }));
  await analyzeTranscript({ text: makeMd(120, 400) }, { chat: long.chat, maxChunkChars: 6000 });
  assert.ok(long.calls.slice(1).every((c) => c.maxTokens > (c.system === MERGE_PROMPT ? STAGE_TOKENS.merge : STAGE_TOKENS.part)));
});

test('o nome do modelo nunca é um caminho do computador (o servidor local informa o arquivo como nome)', async () => {
  const file = 'C:\\Users\\mauri\\AppData\\Roaming\\braga-digital-studio\\data\\modules\\llm\\models\\qwen3-vl-2b-instruct\\Qwen3VL-2B-Instruct-Q4_K_M.gguf';
  assert.equal(displayModel(file, 'Modelo local do app'), 'Modelo local do app');
  assert.equal(displayModel('/home/ana/modelos/x.gguf'), 'modelo local');
  assert.equal(displayModel('D:/modelos/x.gguf', 'Local'), 'Local');
  assert.equal(displayModel('qwen3-vl-2b-instruct'), 'qwen3-vl-2b-instruct');
  assert.equal(displayModel('openai/gpt-oss-20b'), 'openai/gpt-oss-20b', 'id de fornecedor com "/" não é caminho');
  assert.equal(displayModel(''), '');

  const { chat } = fakeChat(() => ({ text: GOOD, model: file, provider: { id: 'p', label: 'Modelo local do app' } }));
  const out = await analyzeTranscript({ text: makeMd(5) }, { chat });
  assert.equal(out.model, 'Modelo local do app');
  const doc = formatAnalysisDocument({ title: 't', model: file, markdown: GOOD });
  assert.ok(!doc.includes('mauri') && !doc.includes('C:\\') && !doc.includes('.gguf'), doc.split('\n')[2]);
  assert.ok(doc.includes('> Gerada por IA (modelo local).'));
});

test('splitChunk: divide ao meio em limite de linha e mantém os tempos; uma linha só não divide', () => {
  const chunk = chunkTranscript(parseTranscript(makeMd(10, 100)).segments, 100000)[0];
  const [a, b] = splitChunk(chunk);
  assert.equal(`${a.text}\n${b.text}`, chunk.text);
  assert.ok(Math.abs(a.text.length - b.text.length) < 150);
  assert.equal(a.from, chunk.from);
  assert.equal(b.to, chunk.to);
  assert.ok(a.to < b.from, 'a segunda metade começa depois da primeira');
  assert.equal(splitChunk({ index: 0, text: 'uma linha só', from: 0, to: 0 }), null);
});

test('formatAnalysisDocument: cada aviso diz o que aconteceu, sem mandar aumentar o limite', () => {
  const doc = formatAnalysisDocument({ title: 't', markdown: 'x', chunks: 3, repeated: true, fallback: true, truncated: true });
  for (const re of [/analisada em 3 partes/, /união das partes não ficou boa/, /repetiu trechos/, /cortada pelo limite de tamanho/]) assert.match(doc, re);
  assert.doesNotMatch(doc, /aumente/);
  assert.doesNotMatch(formatAnalysisDocument({ title: 't', markdown: 'x' }), /repetiu|cortada|união das partes/);
});

test('parte comprida demais (cortada no teto) só vira aviso se o documento traz as partes; com a união boa, não', async () => {
  const withPartsCut = (merge) => fakeChat((call, n) => (call.system === MERGE_PROMPT ? merge : { text: PART(n), finishReason: 'length' }));
  const fine = await analyzeTranscript({ text: makeMd(40, 400) }, { chat: withPartsCut({ text: GOOD }).chat, maxChunkChars: 4000 });
  assert.equal(fine.truncated, false);
  assert.equal(fine.fallback, false);
  const bad = await analyzeTranscript({ text: makeMd(40, 400) }, { chat: withPartsCut({ text: LOOP(80) }).chat, maxChunkChars: 4000 });
  assert.equal(bad.fallback, true);
  assert.equal(bad.truncated, true);
});

test('duas linhas iguais na mesma lista são limpas em silêncio: não é laço, então não refaz a chamada nem avisa', async () => {
  const dup = `${GOOD}\n- [00:01:37] Quem some planeja o sumiço.`;
  const { chat, calls } = fakeChat(() => ({ text: dup }));
  const out = await analyzeTranscript({ text: makeMd(5) }, { chat });
  assert.equal(calls.length, 1);
  assert.equal(out.repeated, false);
  assert.equal((out.markdown.match(/\[00:01:37\] Quem some/g) || []).length, 1);
});

test('união que só cola as análises parciais uma atrás da outra (o "Resumo" volta) não vale: o documento traz as partes completas', async () => {
  const { chat } = fakeChat((call, n) => ({ text: call.system === MERGE_PROMPT ? `${PART(1)}\n\n${PART(2)}\n\n${PART(3)}`.replace(/Resumo da parte/g, 'Colado da parte') : PART(n) }));
  const out = await analyzeTranscript({ text: makeMd(40, 400) }, { chat, maxChunkChars: 4000 });
  assert.equal(out.fallback, true);
  assert.equal(out.repeated, false, 'não é laço');
  assert.equal(out.truncated, false, 'nada foi cortado: as partes vieram inteiras');
  assert.ok(out.markdown.includes('### Parte 1 (') && out.markdown.includes('### Parte 2 ('));
  assert.ok(!out.markdown.includes('Colado da parte'));
  // uma união de verdade tem um "Resumo" só (com ou sem número e negrito)
  for (const ok of [GOOD, '## Resumo\ntexto', '1. Resumo\n- a', '**Resumo:**\ntexto\nO resumo da parte 2 continua aqui.']) {
    const merged = fakeChat((call, n) => ({ text: call.system === MERGE_PROMPT ? ok : PART(n) }));
    const r = await analyzeTranscript({ text: makeMd(40, 400) }, { chat: merged.chat, maxChunkChars: 4000 });
    assert.equal(r.fallback, false, ok.slice(0, 20));
    assert.equal(r.markdown, ok);
  }
});
