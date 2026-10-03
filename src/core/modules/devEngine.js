'use strict';

/**
 * devEngine — motor de transcrição SOMENTE PARA DESENVOLVIMENTO.
 *
 * Em modo desenvolvimento, se existir a pasta do projeto "Whisper + LM Studio" (Python + faster-whisper
 * + CUDA já instalados), o módulo de transcrição passa a usá-la em vez de exigir o motor empacotado:
 *   - motor  : tools/whisper-dev/engine.py rodando no Python (.venv) do projeto
 *   - modelos: os que já estão no cache do Hugging Face (nada é copiado nem baixado de novo)
 *   - GPU    : as DLLs do CUDA do próprio .venv
 *
 * Nunca é ativado no app empacotado. A pasta pode ser trocada com BDS_WHISPER_DEV_DIR.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WHISPER_MODELS } = require('./WhisperCatalog');

const PROJECT_FOLDER_NAME = 'Whisper + LM Studio';

/** Pasta do snapshot de um repositório no cache do Hugging Face (ou null). */
function findHfSnapshot(hubDir, repo) {
  const base = path.join(hubDir, `models--${repo.replace('/', '--')}`, 'snapshots');
  let revisions = [];
  try { revisions = fs.readdirSync(base); } catch (_) { return null; }
  for (const rev of revisions) {
    const dir = path.join(base, rev);
    // existsSync segue os links simbólicos do cache até o arquivo real
    if (['model.bin', 'config.json', 'tokenizer.json'].every((f) => fs.existsSync(path.join(dir, f)))) return dir;
  }
  return null;
}

/**
 * @param {{isPackaged:boolean, appRoot:string, env?:object, hubDir?:string, ffmpegPath?:string|null}} opts
 * @returns {null | {label:string, command:string, baseArgs:string[], env:object, models:Object<string,string>, repoDirs:Object<string,string>, projectDir:string}}
 */
function detectDevEngine({ isPackaged, appRoot, env = process.env, hubDir = null, ffmpegPath = null }) {
  if (isPackaged) return null;
  if (env.BDS_WHISPER_DEV === '0') return null;

  const projectDir = env.BDS_WHISPER_DEV_DIR || path.join(path.dirname(appRoot), PROJECT_FOLDER_NAME);
  const python = path.join(projectDir, '.venv', 'Scripts', 'python.exe');
  const script = path.join(appRoot, 'tools', 'whisper-dev', 'engine.py');
  const hasFasterWhisper = fs.existsSync(path.join(projectDir, '.venv', 'Lib', 'site-packages', 'faster_whisper'));
  if (!fs.existsSync(python) || !fs.existsSync(script) || !hasFasterWhisper || !fs.existsSync(path.join(projectDir, 'legendar.py'))) return null;

  const hub = hubDir || env.HF_HUB_CACHE || path.join(env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), 'hub');
  const models = {};
  const repoDirs = {}; // pasta do repositório no cache (models--org--nome): é o que se apaga para liberar espaço
  for (const m of WHISPER_MODELS) {
    const dir = findHfSnapshot(hub, m.repo);
    if (dir) {
      models[m.id] = dir;
      repoDirs[m.id] = path.dirname(path.dirname(dir)); // <repo>/snapshots/<revisão> → <repo>
    }
  }

  const extraEnv = { WL_DEV_PROJECT: projectDir, PYTHONUTF8: '1' };
  if (ffmpegPath) extraEnv.WL_FFMPEG = ffmpegPath;
  return {
    label: 'Motor de desenvolvimento (Python local)',
    command: python,
    baseArgs: [script],
    env: extraEnv,
    models,
    repoDirs,
    projectDir
  };
}

module.exports = { detectDevEngine, findHfSnapshot, PROJECT_FOLDER_NAME };
