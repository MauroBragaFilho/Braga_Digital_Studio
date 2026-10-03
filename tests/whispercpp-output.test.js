'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseWhisperCppJson } = require('../src/core/transcription/whisperCppOutput');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.006, `${msg || ''} esperado ~${b}, veio ${a}`);

/**
 * Monta o conteúdo de um .json do whisper.cpp. Os textos viram bytes UTF-8 (como no programa real); com
 * `binary: true` o texto já é uma "string binária" (1 char = 1 byte), para simular bytes incompletos.
 */
function make(segments) {
  const json = {
    result: { language: 'pt' },
    transcription: segments.map((s) => {
      const enc = (text) => (s.binary ? text : Buffer.from(text, 'utf8').toString('latin1'));
      return {
      offsets: { from: Math.round(s.from * 1000), to: Math.round(s.to * 1000) },
      text: enc(s.text),
      tokens: s.tokens === undefined ? undefined : s.tokens.map((t) => ({
        text: enc(t.text),
        offsets: { from: Math.round((t.from ?? 0) * 1000), to: Math.round((t.to ?? 0) * 1000) },
        t_dtw: t.dtw === undefined ? -1 : Math.round(t.dtw * 100)
      }))
      };
    })
  };
  return Buffer.from(JSON.stringify(json), 'latin1');
}

test('arquivo real do whisper.cpp: trechos, palavras com acento e sem tokens especiais', () => {
  const r = parseWhisperCppJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'whispercpp-sample.json')));
  assert.equal(r.language, 'pt');
  assert.equal(r.segments.length, 3);
  assert.equal(r.segments[0].text, 'Bom dia, pessoal.');
  assert.equal(r.words.length, 34);
  assert.deepEqual(r.words.slice(0, 3).map((w) => w.word), ['Bom', 'dia,', 'pessoal.']);
  const all = r.words.map((w) => w.word);
  for (const acento of ['princípios', 'administração', 'pública,']) assert.ok(all.includes(acento), `faltou ${acento}`);
  assert.ok(all.every((w) => !w.includes('[_') && !w.includes('�')), 'token especial ou caractere quebrado vazou');
  assert.ok(r.words.every((w) => w.end >= w.start && w.start >= 0));
  for (let i = 1; i < r.words.length; i++) assert.ok(r.words[i].start >= r.words[i - 1].start - 0.001, `fora de ordem em ${r.words[i].word}`);
});

test('acento dividido entre dois tokens (bytes UTF-8 incompletos) é recomposto em "ação"', () => {
  const buf = make([{
    binary: true, from: 0, to: 1, text: ' aÃ§Ã£o',
    tokens: [{ text: ' aÃ', from: 0.1, to: 0.3 }, { text: '§Ã£o', from: 0.3, to: 0.6 }]
  }]);
  const r = parseWhisperCppJson(buf);
  assert.equal(r.segments[0].text, 'ação');
  assert.deepEqual(r.words.map((w) => w.word), ['ação']);
  near(r.words[0].start, 0.1); near(r.words[0].end, 0.6);
});

test('tokens especiais são descartados e pontuação gruda na palavra anterior', () => {
  const r = parseWhisperCppJson(make([{
    from: 0, to: 2, text: ' Olá, mundo.',
    tokens: [{ text: '[_BEG_]' }, { text: ' Olá', from: 0.1, to: 0.4 }, { text: ',', from: 0.4, to: 0.5 }, { text: ' mundo', from: 0.6, to: 1.0 }, { text: '.', from: 1.0, to: 1.1 }, { text: '[_TT_1214]' }]
  }]), { preferDtw: false });
  assert.deepEqual(r.words.map((w) => w.word), ['Olá,', 'mundo.']);
  near(r.words[0].end, 0.5);
});

test('DTW: o tempo informado é o FIM da palavra; o início é o fim da anterior, limitado pelo tamanho da palavra', () => {
  const r = parseWhisperCppJson(make([{
    from: 0.12, to: 1.74, text: ' Bom dia, pessoal.',
    tokens: [
      { text: ' Bom', from: 0.12, to: 0.29, dtw: 0.32 }, { text: ' dia', from: 0.29, to: 0.58, dtw: 0.74 },
      { text: ',', from: 0.58, to: 0.77, dtw: 1.08 }, { text: ' pessoal', from: 0.77, to: 1.36, dtw: 1.74 }, { text: '.', from: 1.46, to: 1.74, dtw: 2.10 }
    ]
  }]));
  const [bom, dia, pessoal] = r.words;
  near(bom.start, 0.12, 'início do trecho'); near(bom.end, 0.32, 'fim de "Bom"');
  near(dia.end, 0.74, 'a vírgula não estica o fim de "dia"'); near(dia.start, 0.335, 'início de "dia" (teto de 0,405 s)');
  near(pessoal.end, 1.74, 'o ponto (2,10 s) não define o fim de "pessoal"'); near(pessoal.start, 1.035, 'início de "pessoal"');
});

test('DTW depois de um silêncio: a palavra não começa colada na anterior nem no início da janela', () => {
  const r = parseWhisperCppJson(make([
    { from: 0.0, to: 0.6, text: ' Olá.', tokens: [{ text: ' Olá', from: 0, to: 0.3, dtw: 0.5 }, { text: '.', dtw: 0.9 }] },
    { from: 1.0, to: 7.0, text: ' Boa noite.', tokens: [{ text: ' Boa', from: 1, to: 1.2, dtw: 6.4 }, { text: ' noite', from: 1.2, to: 1.5, dtw: 6.9 }, { text: '.', dtw: 7.2 }] }
  ]));
  assert.deepEqual(r.words.map((w) => w.word), ['Olá.', 'Boa', 'noite.']);
  near(r.words[1].start, 5.995, 'a fala começa perto de onde foi dita (6,4 s), não em 1,0 s');
  near(r.words[1].end, 6.4);
  near(r.words[2].start, 6.4); near(r.words[2].end, 6.9);
});

test('sem DTW (preferDtw: false ou t_dtw ausente) usa o tempo por token', () => {
  const seg = [{ from: 0, to: 1, text: ' oi mundo', tokens: [{ text: ' oi', from: 0.1, to: 0.3, dtw: 0.4 }, { text: ' mundo', from: 0.35, to: 0.9, dtw: 0.95 }] }];
  const off = parseWhisperCppJson(make(seg), { preferDtw: false }).words;
  near(off[0].start, 0.1); near(off[0].end, 0.3); near(off[1].start, 0.35); near(off[1].end, 0.9);
  const semDtw = make([{ from: 0, to: 1, text: ' oi mundo', tokens: [{ text: ' oi', from: 0.1, to: 0.3 }, { text: ' mundo', from: 0.35, to: 0.9 }] }]);
  const w = parseWhisperCppJson(semDtw).words;
  near(w[0].start, 0.1); near(w[1].end, 0.9);
});

test('trecho sem tokens: as palavras são distribuídas pela duração, proporcionais ao tamanho', () => {
  const r = parseWhisperCppJson(make([{ from: 2, to: 6, text: ' uma frase de teste' }]));
  assert.equal(r.hasTokens, false);
  assert.deepEqual(r.words.map((w) => w.word), ['uma', 'frase', 'de', 'teste']);
  near(r.words[0].start, 2); near(r.words[3].end, 6);
  for (let i = 1; i < r.words.length; i++) near(r.words[i].start, r.words[i - 1].end);
  assert.ok((r.words[1].end - r.words[1].start) > (r.words[2].end - r.words[2].start), '"frase" dura mais que "de"');
});

test('entradas vazias, objeto já lido e JSON inválido', () => {
  assert.deepEqual(parseWhisperCppJson(make([])).words, []);
  assert.deepEqual(parseWhisperCppJson(make([{ from: 0, to: 1, text: '   ', tokens: [] }])).segments, []);
  assert.deepEqual(parseWhisperCppJson({}).segments, []);
  const obj = parseWhisperCppJson({ transcription: [{ offsets: { from: 0, to: 1500 }, text: ' Olá mundo', tokens: [{ text: ' Olá', offsets: { from: 0, to: 500 }, t_dtw: -1 }, { text: ' mundo', offsets: { from: 500, to: 1500 }, t_dtw: -1 }] }] });
  assert.deepEqual(obj.words.map((w) => w.word), ['Olá', 'mundo']);
  assert.throws(() => parseWhisperCppJson('isso não é json'));
});
