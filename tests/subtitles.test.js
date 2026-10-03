'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  formatSrtTime, formatStamp, wrapLines, buildCues, cuesToSrt, buildSrt, buildMarkdown, MIN_DURATION
} = require('../src/core/transcription/subtitles');

const w = (word, start, end) => ({ word: ` ${word}`, start, end });

test('paridade com o legendar.py: o .srt sai idêntico em todos os cenários do arquivo dourado', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'subtitles-golden.json'), 'utf8'));
  assert.ok(golden.scenarios.length >= 10);
  let checked = 0;
  for (const scenario of golden.scenarios) {
    for (const variant of scenario.variants) {
      const { cues, text } = buildSrt(scenario.words, variant.opts);
      const label = `${scenario.name} ${JSON.stringify(variant.opts)}`;
      assert.equal(cues.length, variant.cues, `quantidade de legendas: ${label}`);
      assert.equal(text, variant.srt, `texto do .srt: ${label}`);
      checked++;
    }
  }
  assert.ok(checked >= 60);
});

test('formatSrtTime: horas, minutos, milésimos e arredondamento igual ao do Python', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000');
  assert.equal(formatSrtTime(83.4), '00:01:23,400');
  assert.equal(formatSrtTime(3725.0049), '01:02:05,005');
  assert.equal(formatSrtTime(-3), '00:00:00,000');
  assert.equal(formatSrtTime(0.0005), '00:00:00,000'); // metade vai para o par (round() do Python), não para cima
  assert.equal(formatSrtTime(0.0015), '00:00:00,002');
  assert.equal(formatSrtTime(NaN), '00:00:00,000');
});

test('wrapLines: só quebra quando passa do limite e equilibra as duas linhas', () => {
  assert.equal(wrapLines(['curta', 'frase'], 2, 42), 'curta frase');
  const two = wrapLines('esta frase é longa demais para caber numa linha só'.split(' '), 2, 30);
  assert.equal(two.split('\n').length, 2);
  assert.ok(two.split('\n').every((l) => l.length <= 30), two);
  assert.equal(wrapLines('esta frase é longa demais para caber numa linha só'.split(' '), 1, 30).includes('\n'), false);
  assert.equal(wrapLines(['uma'], 2, 1), 'uma');
  // emoji conta como 1 caractere (como o len() do Python), não como 2
  assert.equal(wrapLines(['😀😀😀', '😀😀😀'], 2, 7), '😀😀😀 😀😀😀');
});

test('buildCues: quebra em pontuação final e em pausas longas', () => {
  const cues = buildCues([
    w('Primeira', 0, 0.4), w('frase', 0.4, 0.8), w('completa.', 0.8, 1.3),
    w('Segunda', 1.4, 1.8), w('frase', 1.8, 2.2),
    w('depois', 5, 5.4), w('da', 5.4, 5.5), w('pausa', 5.5, 6)
  ]);
  assert.deepEqual(cues.map((c) => c.words.join(' ')), ['Primeira frase completa.', 'Segunda frase', 'depois da pausa']);
});

test('buildCues: respeita o máximo de palavras e nunca termina numa palavra fraca', () => {
  const text = 'vamos estudar o princípio da legalidade e da impessoalidade na administração pública brasileira hoje'.split(' ');
  const words = text.map((t, i) => w(t, i * 0.4, i * 0.4 + 0.35));
  const cues = buildCues(words, { maxWords: 4 });
  assert.ok(cues.every((c) => c.words.length <= 4), JSON.stringify(cues.map((c) => c.words)));
  // As palavras nunca se perdem nem mudam de ordem.
  assert.deepEqual(cues.flatMap((c) => c.words), text);

  const auto = buildCues(words, { maxWords: 5 });
  const weak = new Set(['o', 'da', 'e', 'na', 'de', 'que']);
  for (const cue of auto.slice(0, -1)) {
    const last = cue.words[cue.words.length - 1].toLowerCase();
    assert.ok(!weak.has(last) || cue.words.length === 1, `legenda termina em "${last}": ${cue.words.join(' ')}`);
  }
});

test('buildCues: prefere cortar na vírgula e respeita o limite de caracteres por linha', () => {
  const words = [
    w('Primeiro,', 0, 0.4), w('vamos', 0.4, 0.7), w('ver', 0.7, 0.9), w('o', 0.9, 1.0), w('conceito;', 1.0, 1.6),
    w('depois', 1.6, 2.0), w('os', 2.0, 2.1), w('exemplos', 2.1, 2.8), w('práticos', 2.8, 3.4), w('da', 3.4, 3.5),
    w('matéria', 3.5, 4.0), w('que', 4.0, 4.2), w('cai', 4.2, 4.5), w('na', 4.5, 4.6), w('prova', 4.6, 5.0)
  ];
  const opts = { maxChars: 30, lines: 2 };
  const cues = buildCues(words, opts);
  assert.ok(cues.length >= 2);
  assert.ok(cues[0].words[cues[0].words.length - 1].endsWith(',') || cues[0].words[cues[0].words.length - 1].endsWith(';'),
    cues[0].words.join(' '));
  const srt = cuesToSrt(cues, opts);
  for (const block of srt.trim().split(/\n\n/)) {
    for (const line of block.split('\n').slice(2)) assert.ok(line.length <= 30, `linha longa: ${line}`);
  }
});

test('buildCues: cada legenda dura ao menos MIN_DURATION e nunca invade a seguinte', () => {
  const words = [w('oi.', 0, 0.1), w('tudo', 0.12, 0.2), w('bem?', 0.2, 0.25), w('sim.', 0.26, 0.3)];
  const cues = buildCues(words);
  cues.forEach((c, i) => {
    if (i + 1 < cues.length) assert.ok(c.end <= cues[i + 1].start, `sobreposição na legenda ${i + 1}`);
    assert.ok(c.end > c.start);
  });
  assert.ok(cues[cues.length - 1].end - cues[cues.length - 1].start >= MIN_DURATION);
});

test('buildCues: ignora palavras vazias e aceita entrada vazia', () => {
  assert.deepEqual(buildCues([]), []);
  assert.deepEqual(buildCues(undefined), []);
  assert.deepEqual(buildCues([w('  ', 0, 1), { word: '', start: 1, end: 2 }]), []);
  assert.equal(buildSrt([]).text, '');
});

test('buildSrt: formato do arquivo (número, tempos, texto e linha em branco entre legendas)', () => {
  const { text } = buildSrt([w('Olá', 0, 0.5), w('mundo.', 0.5, 1), w('Tchau.', 2.5, 3)]);
  assert.equal(text, '1\n00:00:00,000 --> 00:00:01,000\nOlá mundo.\n\n2\n00:00:02,500 --> 00:00:03,000\nTchau.\n');
});

test('formatStamp e buildMarkdown: mesmo formato do transcrever.py', () => {
  assert.equal(formatStamp(0), '00:00:00');
  assert.equal(formatStamp(3725.9), '01:02:05');
  assert.equal(formatStamp(-4), '00:00:00');
  const md = buildMarkdown({
    title: 'aula 01', model: 'large-v3-turbo', duration: 125.4,
    segments: [{ start: 0.2, text: ' Bom dia, pessoal. ' }, { start: 61.7, text: '   ' }, { start: 62, text: 'Vamos começar.' }]
  });
  assert.equal(md,
    '# aula 01\n\nTranscrição automática (Whisper large-v3-turbo). Duração: 00:02:05\n\n'
    + '**[00:00:00]** Bom dia, pessoal.\n\n**[00:01:02]** Vamos começar.\n\n');
});
