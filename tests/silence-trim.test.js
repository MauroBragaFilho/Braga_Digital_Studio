'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  detectSpeechRanges, buildTrimmedWav, makeTimeMap, mapToOriginal, remapResult, speechFromSilences
} = require('../src/core/transcription/silenceTrim');

const FFMPEG = process.env.BDS_TEST_FFMPEG || 'C:\\Users\\mauri\\AppData\\Local\\ffmpeg\\bin\\ffmpeg.exe';
const FFPROBE = process.env.BDS_TEST_FFPROBE || 'C:\\Users\\mauri\\AppData\\Local\\ffmpeg\\bin\\ffprobe.exe';
const HAS_FFMPEG = fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE);
const real = { skip: HAS_FFMPEG ? false : 'ffmpeg/ffprobe reais não encontrados' };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-silencetrim-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* noop */ } });

/** Gera um WAV mono 16 kHz com a sequência de blocos: número positivo = tom de N s; negativo = silêncio de |N| s. */
function makeAudio(name, parts) {
  const out = path.join(tmp, name);
  const inputs = [];
  parts.forEach((p) => {
    inputs.push('-f', 'lavfi', '-i', p > 0 ? `sine=frequency=440:sample_rate=16000:duration=${p}` : `anullsrc=r=16000:cl=mono:d=${-p}`);
  });
  const graph = `${parts.map((_, i) => `[${i}:a]`).join('')}concat=n=${parts.length}:v=0:a=1[a]`;
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...inputs, '-filter_complex', graph, '-map', '[a]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return out;
}

function probeDuration(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim());
}

const near = (a, b, tol = 0.1, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} esperado ~${b}, veio ${a}`);

test('detecta tom + silêncio + tom (com folga) e o WAV cortado só tem a fala', real, async () => {
  const wav = makeAudio('t_s_t.wav', [3, -4, 3]);
  const ranges = await detectSpeechRanges(wav, { ffmpegPath: FFMPEG });
  assert.equal(ranges.length, 2, JSON.stringify(ranges));
  near(ranges[0].start, 0, 0.05); near(ranges[0].end, 3.3, 0.15);
  near(ranges[1].start, 6.7, 0.15); near(ranges[1].end, 10, 0.05);

  const out = path.join(tmp, 't_s_t_cut.wav');
  const built = await buildTrimmedWav(wav, ranges, out);
  const expected = ranges.reduce((n, r) => n + (r.end - r.start), 0);
  near(probeDuration(out), expected, 0.01, 'duração do WAV cortado');
  near(built.duration, expected, 0.001);
  assert.equal(built.timeMap.length, 2);

  // Uma palavra no 2º trecho (cortado: 3,5 s) volta ao tempo original certo.
  const cutAt = built.timeMap[1].cutStart + 0.5;
  near(mapToOriginal(built.timeMap, cutAt), ranges[1].start + 0.5, 1e-6);
  near(mapToOriginal(built.timeMap, cutAt), 7.2, 0.15);
});

test('o conteúdo do WAV cortado é o do trecho certo (amostra a amostra)', real, async () => {
  const wav = makeAudio('conteudo.wav', [2, -3, 2]);
  const ranges = [{ start: 0.5, end: 1.5 }, { start: 5.25, end: 6 }];
  const out = path.join(tmp, 'conteudo_cut.wav');
  await buildTrimmedWav(wav, ranges, out);
  const a = fs.readFileSync(wav);
  const b = fs.readFileSync(out);
  const sample = (buf, off, t) => buf.readInt16LE(off + Math.round(t * 16000) * 2);
  const off = (buf) => buf.indexOf('data') + 8;
  assert.equal(sample(b, off(b), 0.3), sample(a, off(a), 0.8));
  assert.equal(sample(b, off(b), 1.2), sample(a, off(a), 5.45));
});

test('silêncio até o fim do arquivo (só silence_start) é tratado', real, async () => {
  const wav = makeAudio('final.wav', [3, -5]);
  const ranges = await detectSpeechRanges(wav, { ffmpegPath: FFMPEG });
  assert.equal(ranges.length, 1, JSON.stringify(ranges));
  near(ranges[0].start, 0, 0.05); near(ranges[0].end, 3.3, 0.15);
});

test('silêncio no início: o trecho começa onde a fala começa (menos a folga)', real, async () => {
  const wav = makeAudio('inicio.wav', [-4, 3]);
  const ranges = await detectSpeechRanges(wav, { ffmpegPath: FFMPEG });
  assert.equal(ranges.length, 1, JSON.stringify(ranges));
  near(ranges[0].start, 3.7, 0.15); near(ranges[0].end, 7, 0.05);
});

test('áudio todo silencioso: lista vazia', real, async () => {
  const wav = makeAudio('mudo.wav', [-6]);
  assert.deepEqual(await detectSpeechRanges(wav, { ffmpegPath: FFMPEG }), []);
});

test('pausas curtas (menores que o mínimo) não cortam nada', real, async () => {
  const wav = makeAudio('pausa.wav', [2, -1, 2]);
  const ranges = await detectSpeechRanges(wav, { ffmpegPath: FFMPEG });
  assert.equal(ranges.length, 1);
  near(ranges[0].start, 0, 0.05); near(ranges[0].end, 5, 0.05);
});

test('trechos próximos (silêncio menor que 2x a folga) são mesclados', () => {
  // silêncio de 1,5 s com folga de 0,9 de cada lado: as folgas se sobrepõem e vira um trecho só
  assert.deepEqual(speechFromSilences([{ start: 2, end: 3.5 }], 6, { pad: 0.9 }), [{ start: 0, end: 6 }]);
  assert.deepEqual(speechFromSilences([{ start: 2, end: 8 }], 10, { pad: 0.3 }), [{ start: 0, end: 2.3 }, { start: 7.7, end: 10 }]);
  assert.deepEqual(speechFromSilences([{ start: 0, end: null }], 10), []);
  assert.deepEqual(speechFromSilences([{ start: -0.01, end: 4 }, { start: 8, end: null }], 10, { pad: 0 }), [{ start: 4, end: 8 }]);
});

test('detecção com ffmpeg inexistente ou arquivo inválido rejeita; cancelar rejeita com CANCELLED', real, async () => {
  const wav = makeAudio('x.wav', [2]);
  await assert.rejects(detectSpeechRanges(wav, { ffmpegPath: path.join(tmp, 'nao-existe.exe') }));
  await assert.rejects(detectSpeechRanges(path.join(tmp, 'nao-existe.wav'), { ffmpegPath: FFMPEG }));
  const c = new AbortController();
  c.abort();
  await assert.rejects(detectSpeechRanges(wav, { ffmpegPath: FFMPEG, signal: c.signal }), (e) => e.code === 'CANCELLED');
});

test('mapa de tempo: fronteiras, extremos e monotonia', () => {
  const map = makeTimeMap([{ start: 1, end: 3 }, { start: 10, end: 14 }, { start: 20, end: 21 }]);
  assert.deepEqual(map.map((m) => [m.cutStart, m.cutEnd]), [[0, 2], [2, 6], [6, 7]]);
  assert.equal(mapToOriginal(map, 0), 1);
  assert.equal(mapToOriginal(map, 1), 2);
  assert.equal(mapToOriginal(map, 2), 10); // início de algo na fronteira: trecho seguinte
  assert.equal(mapToOriginal(map, 2, { edge: 'end' }), 3); // fim de algo na fronteira: trecho anterior
  assert.equal(mapToOriginal(map, 4), 12);
  assert.equal(mapToOriginal(map, 6), 20);
  assert.equal(mapToOriginal(map, 6, { edge: 'end' }), 14);
  assert.equal(mapToOriginal(map, 7), 21);
  assert.equal(mapToOriginal(map, 99), 21);
  assert.equal(mapToOriginal(map, -5), 1);
  let last = -Infinity;
  for (let t = -1; t <= 8; t += 0.05) { const v = mapToOriginal(map, t); assert.ok(v >= last); last = v; }
});

test('remapResult: palavras e segmentos voltam ao tempo original', () => {
  const map = makeTimeMap([{ start: 0, end: 10.3 }, { start: 39.7, end: 60 }]);
  const result = {
    language: 'pt', hasTokens: true,
    segments: [{ start: 0.5, end: 4, text: 'a' }, { start: 12, end: 12.4, text: 'b' }],
    words: [{ word: 'a', start: 0.5, end: 1 }, { word: 'b', start: 12, end: 12.4 }, { word: 'cruza', start: 12.45, end: 12.9 }]
  };
  const out = remapResult(result, map);
  assert.deepEqual(out.words[0], { word: 'a', start: 0.5, end: 1 });
  assert.deepEqual([out.words[1].start, out.words[1].end], [41.4, 41.8]);
  assert.deepEqual([out.segments[1].start, out.segments[1].end], [41.4, 41.8]);
  assert.equal(out.language, 'pt');
  assert.equal(remapResult(result, []), result);

  // Palavra que cruza a emenda (começa em 10,0 e termina em 10,6 no áudio cortado) não estica sobre o silêncio cortado.
  const cross = remapResult({ language: 'pt', hasTokens: true, segments: [], words: [{ word: 'x', start: 10, end: 10.6 }] }, map);
  assert.equal(cross.words[0].start, 10);
  assert.ok(cross.words[0].end <= 10.3 + 1e-9, String(cross.words[0].end));
});

test('propriedade: remap nunca gera start>end nem sobreposição (entradas aleatórias)', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let round = 0; round < 300; round++) {
    const ranges = [];
    let at = rnd() * 3;
    const n = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) { const len = 0.2 + rnd() * 20; ranges.push({ start: at, end: at + len }); at += len + 0.5 + rnd() * 30; }
    const map = makeTimeMap(ranges);
    const total = map[map.length - 1].cutEnd;
    const words = [];
    let t = rnd();
    while (t < total + 2 && words.length < 200) {
      const dur = rnd() < 0.1 ? 0 : rnd() * 1.5;
      words.push({ word: 'w', start: t, end: t + dur });
      t += dur * rnd() + (rnd() < 0.3 ? -0.05 : 0.01) + rnd() * 0.5; // às vezes sobrepõe a anterior
    }
    const segments = words.map((w) => ({ start: w.start, end: w.end, text: 'w' }));
    const out = remapResult({ language: 'pt', segments, words, hasTokens: true }, map);
    for (const list of [out.words, out.segments]) {
      let prev = -Infinity;
      list.forEach((x, i) => {
        assert.ok(x.start <= x.end, `start>end em ${i}: ${x.start} > ${x.end}`);
        assert.ok(x.start >= prev - 1e-9, `sobreposição em ${i}: ${x.start} < ${prev}`);
        prev = x.end;
      });
    }
  }
});

test('buildTrimmedWav: recusa lista vazia e arquivo que não é WAV', async () => {
  const bad = path.join(tmp, 'ruim.wav');
  fs.writeFileSync(bad, 'isto nao e um wav, de jeito nenhum, nada mesmo, de verdade');
  await assert.rejects(buildTrimmedWav(bad, [{ start: 0, end: 1 }], path.join(tmp, 'o.wav')), (e) => e.code === 'BAD_WAV');
  assert.ok(!fs.existsSync(path.join(tmp, 'o.wav')));
  await assert.rejects(buildTrimmedWav(bad, [], path.join(tmp, 'o.wav')), (e) => e.code === 'NO_RANGES');
});

test('sanitizeSilenceOptions: padrão quando ausente/inválido e limita às faixas seguras', () => {
  const { sanitizeSilenceOptions, DEFAULTS } = require('../src/core/transcription/silenceTrim');
  assert.deepEqual(sanitizeSilenceOptions(undefined), { noiseDb: DEFAULTS.noiseDb, minSilence: DEFAULTS.minSilence, pad: DEFAULTS.pad });
  assert.deepEqual(sanitizeSilenceOptions({ noiseDb: 'abc', minSilence: null, pad: NaN }), { noiseDb: -35, minSilence: 1.5, pad: 0.3 });
  assert.deepEqual(sanitizeSilenceOptions({ noiseDb: 10, minSilence: 0, pad: 9 }), { noiseDb: -15, minSilence: 0.5, pad: 1 });
  assert.deepEqual(sanitizeSilenceOptions({ noiseDb: -999, minSilence: 99, pad: -2 }), { noiseDb: -60, minSilence: 5, pad: 0 });
  assert.deepEqual(sanitizeSilenceOptions({ noiseDb: '-40', minSilence: 2.26, pad: 0.55 }), { noiseDb: -40, minSilence: 2.3, pad: 0.6 });
});

test('normalizeOptions do runner carrega os limiares já validados', () => {
  const { normalizeOptions } = require('../src/core/modules/WhisperCppRunner');
  const f = path.join(tmp, 'x.wav');
  fs.writeFileSync(f, 'x');
  assert.deepEqual(normalizeOptions({ files: [f], silence: { noiseDb: -50, minSilence: 99 } }).silence, { noiseDb: -50, minSilence: 5, pad: 0.3 });
  assert.deepEqual(normalizeOptions({ files: [f] }).silence, { noiseDb: -35, minSilence: 1.5, pad: 0.3 });
});
