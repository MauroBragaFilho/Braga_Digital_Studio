'use strict';

/**
 * GroqTranscriber — transcrição na nuvem pelo Groq (API compatível com a da OpenAI, `/audio/transcriptions`).
 *
 * O Groq limita o tamanho de cada arquivo, então o áudio é cortado em blocos de ~10 minutos; cada bloco é enviado em
 * ordem e os resultados são juntados com os tempos corrigidos. Pede tempo por palavra e por trecho (verbose_json).
 */

const fs = require('node:fs');
const path = require('node:path');
const { RunnerError } = require('../modules/WhisperCppRunner');
const { wordsFromText } = require('./whisperCppOutput');
const { CloudBase, cancelled } = require('./CloudBase');

const CHUNK_SECONDS = 600;
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // abaixo do limite de 25 MB do plano gratuito do Groq
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

class GroqTranscriber extends CloudBase {
  constructor(cfg) {
    super({ ...cfg, provider: 'groq' });
    this.chunkSeconds = cfg.chunkSeconds || CHUNK_SECONDS;
  }

  /**
   * @param {{wav:string, seconds:number, work:string, language:string, signal?:AbortSignal,
   *          onProgress?:(fraction:number)=>void, onEvent?:(e:object)=>void}} job
   */
  async transcribe({ wav, seconds, work, language, signal = null, onProgress = () => {}, onEvent = () => {} }) {
    const key = this._requireKey();
    const model = this.config.getModel('groq');

    const count = Math.max(1, Math.ceil(seconds / this.chunkSeconds));
    const segments = [];
    const words = [];
    let detected = '';
    for (let i = 0; i < count; i++) {
      if (signal && signal.aborted) throw cancelled();
      const start = i * this.chunkSeconds;
      const length = Math.min(this.chunkSeconds, seconds - start);
      if (length <= 0.05) break;
      onEvent({ type: 'status', text: count > 1 ? `Enviando o trecho ${i + 1} de ${count} ao Groq` : 'Enviando o áudio ao Groq' });
      const file = path.join(work, `groq_${i}.m4a`);
      await this.slice(wav, start, length, file, signal);
      let buffer;
      try { buffer = fs.readFileSync(file); } catch (_) { throw new RunnerError('Não foi possível preparar o áudio para envio.', 'DECODE'); }
      fs.rmSync(file, { force: true });
      if (buffer.length > MAX_UPLOAD_BYTES) throw new RunnerError('O trecho de áudio é grande demais para o Groq.', 'CLOUD_TOO_LARGE');

      const json = await this._send({
        path: '/audio/transcriptions', key, signal, timeoutMs: REQUEST_TIMEOUT_MS, onEvent,
        buildForm: () => {
          const form = new FormData();
          form.append('file', new Blob([buffer], { type: 'audio/mp4' }), 'audio.m4a');
          form.append('model', model);
          form.append('response_format', 'verbose_json');
          form.append('temperature', '0');
          form.append('timestamp_granularities[]', 'word');
          form.append('timestamp_granularities[]', 'segment');
          if (language && language !== 'auto') form.append('language', language);
          return form;
        }
      });

      detected = detected || String(json.language || '');
      let produced = 0;
      for (const s of Array.isArray(json.segments) ? json.segments : []) {
        const text = String(s.text || '').trim();
        if (!text) continue;
        const from = start + (Number(s.start) || 0);
        segments.push({ start: from, end: Math.max(from, start + (Number(s.end) || 0)), text });
        produced++;
      }
      const chunkWords = (Array.isArray(json.words) ? json.words : [])
        .map((w) => ({ word: String(w.word || '').trim(), start: start + (Number(w.start) || 0), end: start + (Number(w.end) || 0) }))
        .filter((w) => w.word);
      if (chunkWords.length) {
        for (const w of chunkWords) words.push({ ...w, end: Math.max(w.end, w.start) });
      } else if (produced) {
        // Sem tempo por palavra na resposta: distribui as palavras de cada trecho pela duração dele
        for (const s of segments.slice(-produced)) words.push(...wordsFromText(s.text, s.start, s.end));
      }
      onProgress((i + 1) / count);
    }
    return { language: detected, segments, words, hasTokens: false };
  }
}

module.exports = { GroqTranscriber, CHUNK_SECONDS, MAX_UPLOAD_BYTES };
