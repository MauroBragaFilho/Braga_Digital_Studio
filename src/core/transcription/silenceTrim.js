'use strict';

/**
 * silenceTrim.js — tira os trechos sem fala do áudio ANTES da transcrição, sem mudar os tempos finais.
 *
 * Por que: o whisper gasta tempo em silêncio longo e costuma "alucinar" frases ali. Aqui:
 *   1. `detectSpeechRanges` roda o `silencedetect` do ffmpeg no WAV e devolve os trechos com fala (com folga);
 *   2. `buildTrimmedWav` junta só esses trechos num WAV menor e devolve o mapa de tempo (cortado -> original);
 *   3. depois da transcrição, `remapResult` leva segmentos e palavras de volta ao tempo do arquivo original.
 *
 * O corte é feito em Node, copiando as amostras PCM do WAV de trabalho (mono 16 kHz, 16 bits, que o próprio BDS
 * gera). É exato (por amostra, então o mapa de tempo não tem erro), não decodifica de novo, não tem limite de
 * tamanho de comando como o filter_complex com centenas de trechos e funciona com qualquer ffmpeg.
 */

const fs = require('node:fs');
const { processRunner } = require('../../infrastructure/external-tools/ProcessRunner');

const DEFAULTS = { noiseDb: -35, minSilence: 1.5, pad: 0.3 };
// Faixas seguras aceitas para os ajustes (a tela e o processo principal usam as mesmas).
const LIMITS = { noiseDb: { min: -60, max: -15 }, minSilence: { min: 0.5, max: 5 }, pad: { min: 0, max: 1 } };

/** Valida os limiares vindos da tela: valor ausente/inválido vira o padrão; fora da faixa é limitado a ela. */
function sanitizeSilenceOptions(input) {
  const o = input && typeof input === 'object' ? input : {};
  const pick = (key, decimals) => {
    const raw = o[key];
    const n = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return DEFAULTS[key];
    const { min, max } = LIMITS[key];
    const f = 10 ** decimals;
    return Math.round(Math.min(max, Math.max(min, n)) * f) / f;
  };
  return { noiseDb: pick('noiseDb', 0), minSilence: pick('minSilence', 1), pad: pick('pad', 1) };
}

const MIN_RANGE_SECONDS = 0.05; // trechos menores que isso somem (ruído)
const MERGE_GAP_SECONDS = 0.05; // trechos separados por menos que isso viram um só
const COPY_CHUNK_BYTES = 1 << 20;
const EPS = 1e-9;

const round3 = (n) => Math.round(n * 1000) / 1000;

class TrimError extends Error {
  constructor(message, code) { super(message); this.name = 'TrimError'; this.code = code; }
}

/** Duração (s) escrita pelo ffmpeg ("Duration: 00:01:02.50") ou null. */
function parseDuration(text) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/**
 * Trechos com fala = o que sobra fora dos silêncios, alargado por `pad` nos dois lados e com os vizinhos mesclados.
 * @param {Array<{start:number,end:number|null}>} silences  end null/ausente: silêncio até o fim do arquivo
 * @returns {Array<{start:number,end:number}>} em ms de precisão, em ordem, sem sobreposição
 */
function speechFromSilences(silences, duration, { pad = DEFAULTS.pad } = {}) {
  const total = Number(duration);
  if (!(total > 0)) return [];
  const sil = silences
    .map((s) => ({ start: Math.max(0, Number(s.start) || 0), end: s.end === null || s.end === undefined || !Number.isFinite(Number(s.end)) ? total : Math.min(total, Number(s.end)) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const speech = [];
  let at = 0;
  for (const s of sil) {
    if (s.start > at) speech.push({ start: at, end: s.start });
    at = Math.max(at, s.end);
  }
  if (at < total) speech.push({ start: at, end: total });

  const merged = [];
  for (const r of speech) {
    const start = Math.max(0, r.start - pad);
    const end = Math.min(total, r.end + pad);
    const last = merged[merged.length - 1];
    if (last && start - last.end <= MERGE_GAP_SECONDS) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  return merged
    .map((r) => ({ start: round3(r.start), end: round3(r.end) }))
    .filter((r) => r.end - r.start >= MIN_RANGE_SECONDS);
}

/**
 * Roda `ffmpeg -af silencedetect` no WAV e devolve os trechos com fala.
 * @param {string} wavPath
 * @param {{ffmpegPath:string, ffmpegBaseArgs?:string[], noiseDb?:number, minSilence?:number, pad?:number, duration?:number, signal?:AbortSignal}} opts
 *   duration: duração do WAV, se já conhecida (senão vem do ffmpeg ou do tamanho do arquivo)
 * @returns {Promise<Array<{start:number,end:number}>>} lista vazia = áudio inteiro silencioso
 */
function detectSpeechRanges(wavPath, opts = {}) {
  const { ffmpegPath, ffmpegBaseArgs = [], noiseDb = DEFAULTS.noiseDb, minSilence = DEFAULTS.minSilence, pad = DEFAULTS.pad, signal = null } = opts;
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new TrimError('Componente de mídia não informado.', 'NO_FFMPEG'));
    if (!Number.isFinite(noiseDb) || noiseDb > 0 || noiseDb < -120) return reject(new TrimError('Limiar de silêncio inválido.', 'BAD_OPTION'));
    if (!Number.isFinite(minSilence) || minSilence < 0.01) return reject(new TrimError('Duração mínima de silêncio inválida.', 'BAD_OPTION'));
    if (signal && signal.aborted) return reject(new TrimError('Cancelado.', 'CANCELLED'));

    let child;
    try {
      child = processRunner.spawn(ffmpegPath, [...ffmpegBaseArgs, '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
        '-i', wavPath, '-vn', '-sn', '-dn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, '-f', 'null', '-'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      return reject(new TrimError('Não foi possível iniciar o processamento de mídia. Tente novamente.', 'SPAWN'));
    }

    const silences = [];
    let openStart = null;
    let duration = Number(opts.duration) > 0 ? Number(opts.duration) : null;
    let carry = '';
    let tail = '';
    let cancelled = false;

    const parseLine = (line) => {
      if (duration === null) { const d = parseDuration(line); if (d) duration = d; }
      if (line.indexOf('silence_') === -1) return;
      const a = /silence_start:\s*(-?[\d.]+)/.exec(line);
      if (a && Number.isFinite(parseFloat(a[1]))) openStart = parseFloat(a[1]);
      const b = /silence_end:\s*(-?[\d.]+)/.exec(line);
      if (b && openStart !== null && Number.isFinite(parseFloat(b[1]))) {
        silences.push({ start: Math.max(0, openStart), end: parseFloat(b[1]) });
        openStart = null;
      }
    };
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-2000);
      const parts = (carry + text).split(/\r\n|\n|\r/);
      carry = parts.pop();
      for (const line of parts) parseLine(line);
    });

    const onAbort = () => { cancelled = true; try { processRunner.cancel(child).catch(() => {}); } catch (_) { /* noop */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const done = () => { if (signal) signal.removeEventListener('abort', onAbort); };

    child.on('error', (err) => { done(); reject(new TrimError('O processamento de mídia falhou. Tente novamente.', 'SPAWN')); });
    child.on('close', (code) => {
      done();
      if (cancelled) return reject(new TrimError('Cancelado.', 'CANCELLED'));
      if (carry) parseLine(carry);
      if (code !== 0) return reject(new TrimError(`A detecção de silêncio falhou: ${tail.trim().split('\n').pop() || `código ${code}`}`, 'DETECT'));
      if (duration === null) {
        try { duration = Math.max(0, (fs.statSync(wavPath).size - 44) / 32000); } catch (_) { duration = 0; }
      }
      // Silêncio que vai até o fim: o silencedetect só emite silence_start (sem silence_end).
      if (openStart !== null) silences.push({ start: Math.max(0, openStart), end: null });
      resolve(speechFromSilences(silences, duration, { pad }));
    });
  });
}

/** Lê o cabeçalho do WAV: onde ficam os dados e o formato. */
function readWavInfo(fd, fileSize) {
  const head = Buffer.alloc(Math.min(4096, fileSize));
  fs.readSync(fd, head, 0, head.length, 0);
  if (head.length < 12 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
    throw new TrimError('O áudio de trabalho não é um WAV.', 'BAD_WAV');
  }
  let fmt = null;
  let pos = 12;
  while (pos + 8 <= head.length) {
    const id = head.toString('latin1', pos, pos + 4);
    const size = head.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 8 + 16 <= head.length) {
      fmt = { format: head.readUInt16LE(pos + 8), channels: head.readUInt16LE(pos + 10), rate: head.readUInt32LE(pos + 12), bits: head.readUInt16LE(pos + 22) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || !fmt.channels || !fmt.rate) throw new TrimError('Formato de WAV não suportado para o corte.', 'BAD_WAV');
      const offset = pos + 8;
      const bytes = Math.min(size, fileSize - offset); // dado de tamanho "desconhecido" (0xFFFFFFFF) vai até o fim
      return { ...fmt, offset, blockAlign: fmt.channels * 2, samples: Math.floor(bytes / (fmt.channels * 2)) };
    }
    pos += 8 + size + (size % 2);
  }
  throw new TrimError('WAV sem dados de áudio.', 'BAD_WAV');
}

/**
 * Mapa de tempo (cortado -> original) de uma lista de trechos mantidos.
 * @returns {Array<{cutStart:number,cutEnd:number,origStart:number,origEnd:number}>}
 */
function makeTimeMap(ranges) {
  const map = [];
  let cut = 0;
  for (const r of ranges) {
    const len = r.end - r.start;
    if (!(len > 0)) continue;
    map.push({ cutStart: cut, cutEnd: cut + len, origStart: r.start, origEnd: r.end });
    cut += len;
  }
  return map;
}

/**
 * Tempo do áudio cortado -> tempo no original (monotônico não decrescente).
 * Numa fronteira entre trechos, `edge:'start'` (padrão) vale para o início de algo e fica no trecho seguinte;
 * `edge:'end'` vale para o fim de algo e fica no trecho anterior. Fora do intervalo, trava nas pontas.
 */
function mapToOriginal(timeMap, t, { edge = 'start' } = {}) {
  if (!timeMap.length) return Number(t) || 0;
  const time = Number(t);
  const first = timeMap[0];
  const last = timeMap[timeMap.length - 1];
  if (!(time > first.cutStart)) return first.origStart;
  if (time >= last.cutEnd) return last.origEnd;
  let lo = 0;
  let hi = timeMap.length - 1;
  while (lo < hi) { // primeiro trecho cujo fim passa de t (ou alcança, para fins)
    const mid = (lo + hi) >> 1;
    const after = edge === 'end' ? timeMap[mid].cutEnd >= time - EPS : timeMap[mid].cutEnd > time + EPS;
    if (after) hi = mid; else lo = mid + 1;
  }
  const seg = timeMap[lo];
  return Math.min(seg.origEnd, Math.max(seg.origStart, seg.origStart + (time - seg.cutStart)));
}

/**
 * Junta só os trechos de fala do WAV (mono/16 bits) num novo WAV.
 * @param {string} wavPath
 * @param {Array<{start:number,end:number}>} ranges  em segundos, em ordem
 * @param {string} outPath
 * @param {{signal?:AbortSignal}} [opts]
 * @returns {Promise<{timeMap:Array, duration:number, kept:number}>} duration/kept: segundos do WAV cortado
 */
async function buildTrimmedWav(wavPath, ranges, outPath, { signal = null } = {}) {
  if (!Array.isArray(ranges) || !ranges.length) throw new TrimError('Nenhum trecho com fala para montar o áudio.', 'NO_RANGES');
  const inFd = fs.openSync(wavPath, 'r');
  let outFd = null;
  try {
    const info = readWavInfo(inFd, fs.fstatSync(inFd).size);
    // Trechos em amostras inteiras: o mapa de tempo sai do que foi realmente copiado.
    const snapped = [];
    for (const r of ranges) {
      const s = Math.min(info.samples, Math.max(0, Math.round(r.start * info.rate)));
      const e = Math.min(info.samples, Math.max(0, Math.round(r.end * info.rate)));
      if (e > s) snapped.push({ s, e });
    }
    if (!snapped.length) throw new TrimError('Nenhum trecho com fala dentro do áudio.', 'NO_RANGES');

    const totalSamples = snapped.reduce((n, r) => n + (r.e - r.s), 0);
    const dataBytes = totalSamples * info.blockAlign;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8, 'latin1');
    header.write('fmt ', 12, 'latin1'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(info.channels, 22);
    header.writeUInt32LE(info.rate, 24); header.writeUInt32LE(info.rate * info.blockAlign, 28); header.writeUInt16LE(info.blockAlign, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36, 'latin1'); header.writeUInt32LE(dataBytes, 40);

    outFd = fs.openSync(outPath, 'w');
    fs.writeSync(outFd, header);
    const buf = Buffer.alloc(COPY_CHUNK_BYTES - (COPY_CHUNK_BYTES % info.blockAlign));
    for (const r of snapped) {
      let pos = info.offset + r.s * info.blockAlign;
      let left = (r.e - r.s) * info.blockAlign;
      while (left > 0) {
        if (signal && signal.aborted) throw new TrimError('Cancelado.', 'CANCELLED');
        const want = Math.min(left, buf.length);
        const got = fs.readSync(inFd, buf, 0, want, pos);
        if (got <= 0) throw new TrimError('O WAV terminou antes do esperado.', 'BAD_WAV');
        fs.writeSync(outFd, buf, 0, got);
        pos += got;
        left -= got;
      }
    }
    const timeMap = makeTimeMap(snapped.map((r) => ({ start: r.s / info.rate, end: r.e / info.rate })));
    return { timeMap, duration: totalSamples / info.rate, kept: totalSamples / info.rate };
  } catch (err) {
    if (outFd !== null) { try { fs.closeSync(outFd); } catch (_) { /* noop */ } outFd = null; }
    try { fs.rmSync(outPath, { force: true }); } catch (_) { /* noop */ }
    throw err;
  } finally {
    try { fs.closeSync(inFd); } catch (_) { /* noop */ }
    if (outFd !== null) { try { fs.closeSync(outFd); } catch (_) { /* noop */ } }
  }
}

/** Leva uma lista de itens {start,end,...} ao tempo original, sem start>end e sem sobreposição. */
function remapItems(items, timeMap, { clampAcross = false } = {}) {
  const out = [];
  let prevEnd = 0;
  for (const it of items) {
    let start = mapToOriginal(timeMap, it.start, { edge: 'start' });
    let end = mapToOriginal(timeMap, it.end, { edge: 'end' });
    if (clampAcross) {
      // Palavra que cruza a emenda entre dois trechos não pode "esticar" por cima do silêncio cortado.
      const seg = timeMap.find((m) => m.origEnd >= start - EPS && m.origStart <= start + EPS && m.origEnd - start > EPS) || null;
      if (seg && end > seg.origEnd) end = seg.origEnd;
    }
    if (start < prevEnd) start = prevEnd;
    if (end < start) end = start;
    out.push({ ...it, start: round3(start), end: round3(Math.max(end, start)) });
    prevEnd = out[out.length - 1].end;
  }
  return out;
}

/**
 * Aplica o mapa de tempo ao resultado de parseWhisperCppJson ({language, segments, words, hasTokens}).
 * Segmentos e palavras mantêm a ordem e ficam com start <= end e sem sobreposição.
 */
function remapResult(result, timeMap) {
  if (!timeMap || !timeMap.length) return result;
  return {
    ...result,
    segments: remapItems(result.segments || [], timeMap),
    words: remapItems(result.words || [], timeMap, { clampAcross: true })
  };
}

module.exports = {
  detectSpeechRanges, buildTrimmedWav, makeTimeMap, mapToOriginal, remapResult, speechFromSilences, TrimError, DEFAULTS, LIMITS, sanitizeSilenceOptions
};
