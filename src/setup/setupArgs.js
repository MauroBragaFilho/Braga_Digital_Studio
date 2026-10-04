'use strict';

/**
 * setupArgs — leitura da linha de comando do "modo de componentes" (instalador).
 *
 *   BragaDigitalStudio.exe --setup-components=basic|full
 *       [--model=<id do modelo>]        (oculto, para testes: tiny, base, small...; vale só em "full")
 *       [--progress-file=<caminho>]     arquivo de progresso lido pelo instalador
 *       [--cancel-file=<caminho>]       se este arquivo aparecer, o modo cancela e limpa o que baixou
 *       [--setup-timeout=<segundos>]    (oculto) limite total; padrão 90 minutos
 *
 * Módulo leve (só a tabela de modelos): o main.js o carrega antes de qualquer outra coisa.
 */

const path = require('node:path');
const { getModel, WHISPER_MODELS } = require('../core/modules/WhisperCatalog');

const SETUP_FLAG = '--setup-components';
const MODES = ['basic', 'full'];
const DEFAULT_TIMEOUT_SEC = 90 * 60;
const MAX_TIMEOUT_SEC = 6 * 60 * 60;

/** Modelo recomendado para CPU pelo catálogo (hoje "Small"): o equilíbrio usado na instalação completa. */
function recommendedCpuModelId() {
  const m = WHISPER_MODELS.find((x) => x.recommendedFor === 'cpu');
  return m ? m.id : WHISPER_MODELS[0].id;
}

/** Valor de `--nome=valor` (ou null). O último argumento repetido vence. */
function optionValue(argv, name) {
  let found = null;
  for (const a of argv) {
    if (typeof a === 'string' && a.startsWith(`${name}=`)) found = a.slice(name.length + 1);
  }
  return found;
}

/**
 * @param {string[]} argv  process.argv
 * @returns {null | {ok:true, mode:'basic'|'full', modelId:string, progressFile:string|null, cancelFile:string|null, timeoutSec:number}
 *                | {ok:false, error:string}}
 *   null = não é o modo de componentes (o app abre normalmente).
 */
function parseSetupArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const present = list.some((a) => typeof a === 'string' && (a === SETUP_FLAG || a.startsWith(`${SETUP_FLAG}=`)));
  if (!present) return null;

  const mode = optionValue(list, SETUP_FLAG);
  if (!MODES.includes(mode)) return { ok: false, error: `Modo inválido: use ${SETUP_FLAG}=basic ou ${SETUP_FLAG}=full.` };

  let modelId = recommendedCpuModelId();
  const rawModel = optionValue(list, '--model');
  if (rawModel !== null) {
    if (!getModel(rawModel)) return { ok: false, error: `Modelo desconhecido: ${String(rawModel).slice(0, 40)}.` };
    modelId = rawModel;
  }

  const files = {};
  for (const [key, flag] of [['progressFile', '--progress-file'], ['cancelFile', '--cancel-file']]) {
    const v = optionValue(list, flag);
    if (v === null) { files[key] = null; continue; }
    if (!v || v.includes('\0') || !path.isAbsolute(v)) return { ok: false, error: `${flag} precisa ser um caminho absoluto.` };
    files[key] = v;
  }

  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  const rawTimeout = optionValue(list, '--setup-timeout');
  if (rawTimeout !== null) {
    const n = Number(rawTimeout);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TIMEOUT_SEC) return { ok: false, error: '--setup-timeout precisa ser um número inteiro de segundos (1 a 21600).' };
    timeoutSec = n;
  }

  return { ok: true, mode, modelId, progressFile: files.progressFile, cancelFile: files.cancelFile, timeoutSec };
}

module.exports = { parseSetupArgs, recommendedCpuModelId, SETUP_FLAG, MODES, DEFAULT_TIMEOUT_SEC };
