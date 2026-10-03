'use strict';

/**
 * analyzeFile.js — Analisa o arquivo de uma transcrição e grava o resultado ao lado dele.
 *
 *   aula.md  (ou aula.srt)  →  aula.analise.md   (com " (2)" se já existir)
 *
 * Usado pelo IPC `ai:analyzeTranscript`; fica separado dele para ser testado sem Electron.
 */

const path = require('node:path');
const { readTranscriptFile } = require('./transcriptAnalysis');
const { writeUnique } = require('../../core/transcription/writeUnique');

/**
 * @param {import('./AIService')} ai
 * @param {{filePath:string, signal?:AbortSignal, onProgress?:Function}} opts
 * @returns {Promise<{path:string, chunks:number, calls:number, truncated:boolean}>}
 */
async function analyzeTranscriptFile(ai, { filePath, signal = null, onProgress = () => {} }) {
  readTranscriptFile(filePath); // valida caminho, formato e tamanho antes de falar com a IA
  const result = await ai.runTask('analyzeTranscript', { filePath }, { signal, onProgress });
  const stem = path.basename(filePath, path.extname(filePath));
  const out = writeUnique(path.join(path.dirname(filePath), `${stem}.analise.md`), result.document);
  return { path: out, chunks: result.chunks, calls: result.calls, truncated: result.truncated };
}

module.exports = { analyzeTranscriptFile, writeUnique };
