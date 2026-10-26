'use strict';

/**
 * ElevenLabsTranscriber — transcrição na nuvem pela ElevenLabs (Scribe, `POST /v1/speech-to-text`).
 *
 * A API aceita arquivos grandes, então o áudio vai inteiro num único envio (AAC mono, ~0,36 MB por minuto). A resposta traz
 * só as palavras com tempo (e espaços/eventos de áudio, que são descartados); os trechos da transcrição são montados aqui
 * a partir da pontuação e das pausas.
 */

const fs = require('node:fs');
const path = require('node:path');
const { RunnerError } = require('../modules/WhisperCppRunner');
const { CloudBase } = require('./CloudBase');

const MIN_TIMEOUT_MS = 5 * 60 * 1000;
const SENTENCE_END = /[.!?…]["')\]]*$/;
const PAUSE_BREAK_SECONDS = 1.2; // pausa que encerra um trecho
const MAX_SEGMENT_SECONDS = 20;
const MAX_SEGMENT_WORDS = 40;

/** Agrupa as palavras em trechos: fim de frase, pausa longa ou tamanho máximo. */
function segmentsFromWords(words) {
  const segments = [];
  let cur = null;
  const flush = () => { if (cur && cur.parts.length) segments.push({ start: cur.start, end: cur.end, text: cur.parts.join(' ') }); cur = null; };
  for (const w of words) {
    if (cur) {
      const gap = w.start - cur.end;
      if (gap >= PAUSE_BREAK_SECONDS || w.end - cur.start > MAX_SEGMENT_SECONDS || cur.parts.length >= MAX_SEGMENT_WORDS) flush();
    }
    if (!cur) cur = { start: w.start, end: w.end, parts: [] };
    cur.parts.push(w.word);
    cur.end = Math.max(cur.end, w.end);
    if (SENTENCE_END.test(w.word)) flush();
  }
  flush();
  return segments;
}

class ElevenLabsTranscriber extends CloudBase {
  constructor(cfg) { super({ ...cfg, provider: 'elevenlabs' }); }

  /** @param {{wav:string, seconds:number, work:string, language:string, signal?:AbortSignal, onProgress?:Function, onEvent?:Function}} job */
  async transcribe({ wav, seconds, work, language, signal = null, onProgress = () => {}, onEvent = () => {} }) {
    const key = this._requireKey();
    const model = this.config.getModel('elevenlabs');

    onEvent({ type: 'status', text: 'Preparando o áudio para enviar à ElevenLabs' });
    const file = path.join(work, 'elevenlabs.m4a');
    await this.slice(wav, 0, seconds, file, signal);
    let buffer;
    try { buffer = fs.readFileSync(file); } catch (_) { throw new RunnerError('Não foi possível preparar o áudio para envio.', 'DECODE'); }
    fs.rmSync(file, { force: true });
    onProgress(0.1);

    onEvent({ type: 'status', text: 'Enviando o áudio à ElevenLabs' });
    // Uma hora de áudio leva alguns minutos para ser processada: o limite de espera cresce com a duração
    const timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.round(seconds * 1000 * 0.5));
    const json = await this._send({
      path: '/speech-to-text', key, signal, timeoutMs, onEvent,
      buildForm: () => {
        const form = new FormData();
        form.append('file', new Blob([buffer], { type: 'audio/mp4' }), 'audio.m4a');
        form.append('model_id', model);
        form.append('timestamps_granularity', 'word');
        form.append('tag_audio_events', 'false');
        form.append('diarize', 'false');
        if (language && language !== 'auto') form.append('language_code', language);
        return form;
      }
    });

    const words = (Array.isArray(json.words) ? json.words : [])
      .filter((w) => w && (w.type === undefined || w.type === 'word') && typeof w.text === 'string' && w.text.trim())
      .map((w) => {
        const start = Number(w.start);
        const end = Number(w.end);
        return { word: w.text.trim(), start: Number.isFinite(start) ? start : 0, end: Number.isFinite(end) ? end : (Number.isFinite(start) ? start : 0) };
      })
      .map((w) => ({ ...w, end: Math.max(w.end, w.start) }));
    onProgress(1);
    return { language: String(json.language_code || ''), segments: segmentsFromWords(words), words, hasTokens: false };
  }
}

module.exports = { ElevenLabsTranscriber, segmentsFromWords };
