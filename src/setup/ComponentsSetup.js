'use strict';

/**
 * ComponentsSetup — lógica do "modo de componentes" do instalador (`--setup-components=basic|full`).
 *
 * É a parte pura e testável: planeja o que baixar, executa cada etapa com repetição em falha de rede,
 * respeita cancelamento (arquivo) e limite de tempo, informa o progresso (arquivo lido pelo instalador),
 * grava o registro do que foi instalado e devolve um código de saída claro. Tudo que toca o mundo
 * (ferramentas, módulo de transcrição, configurações) entra por `deps`, então os testes usam servidores
 * e objetos falsos. A ligação com o app de verdade está em runSetupMode.js.
 *
 * Componentes:
 *   basic = ferramentas básicas (baixar, converter e ler metadados): `ffmpeg` (traz o `ffprobe` junto) e `ytdlp`.
 *   full  = basic + `whisperEngine` (motor de transcrição) + `whisperModel` (modelo recomendado para CPU)
 *           + `enableTranscription` (liga o módulo nas configurações). A aceleração NVIDIA NUNCA entra aqui
 *           (exige aceite do contrato da NVIDIA): continua opcional em Configurações > Módulos.
 *
 * Códigos de saída: 0 tudo certo | 1 faltou algum componente (a instalação do programa segue) |
 *   2 parâmetros inválidos | 3 cancelado | 4 o app está aberto (trava de instância única) | 5 limite de tempo.
 *
 * Arquivo de progresso (uma linha, só ASCII, trocada de forma atômica):
 *   estado|percentual|fase|indice|total|saida      ex.: run|37|tool|1|2|-     ... end|100|-|0|0|0
 *   fase: tool (ferramentas) | engine (motor) | model (modelo) | settings (finalização)
 */

const fs = require('node:fs');
const path = require('node:path');
const { getModel } = require('../core/modules/WhisperCatalog');

const EXIT = Object.freeze({ OK: 0, PARTIAL: 1, BAD_ARGS: 2, CANCELLED: 3, BUSY: 4, TIMEOUT: 5 });

/** Pesos aproximados (bytes) só para a barra de progresso andar de forma proporcional ao download. */
const WEIGHTS = Object.freeze({ ffmpeg: 200e6, ytdlp: 18e6, whisperEngine: 9e6, enableTranscription: 1e6 });

const PERMANENT_REASONS = new Set(['integrity', 'disk', 'unavailable', 'no-checksum', 'cancelled', 'config']);
const PERMANENT_CODES = new Set(['BAD_ZIP', 'BAD_MODEL', 'LICENSE', 'NO_ENGINE', 'PLATFORM', 'TOOL_UNAVAILABLE', 'UNOFFICIAL_ZIP', 'DISK', 'NO_CHECKSUM', 'CANCELLED']);

/** Passos do plano, na ordem de execução. */
function buildSteps({ mode, modelId }) {
  const steps = [
    { id: 'ffmpeg', kind: 'tool', phase: 'tool', tools: ['ffmpeg', 'ffprobe'], weight: WEIGHTS.ffmpeg },
    { id: 'ytdlp', kind: 'tool', phase: 'tool', tools: ['ytdlp'], weight: WEIGHTS.ytdlp }
  ];
  if (mode === 'full') {
    const model = getModel(modelId);
    steps.push(
      { id: 'whisperEngine', kind: 'engine', phase: 'engine', weight: WEIGHTS.whisperEngine },
      { id: 'whisperModel', kind: 'model', phase: 'model', modelId, weight: (model && model.sizeBytes) || 190e6 },
      { id: 'enableTranscription', kind: 'enable', phase: 'settings', weight: WEIGHTS.enableTranscription }
    );
  }
  return steps;
}

/** Motivo (estável) de uma falha, para o registro e para decidir se vale repetir. */
function classifyError(err) {
  const code = String((err && err.code) || '');
  const msg = String((err && err.message) || err || '');
  if (code === 'CANCELLED') return 'cancelled';
  if (code === 'NO_CHECKSUM') return 'no-checksum';
  if (code === 'CHECKSUM' || /integridade|checksum|sha-?256|hash/i.test(msg)) return 'integrity';
  if (code === 'DISK' || /espa[cç]o em disco/i.test(msg)) return 'disk';
  if (code === 'NO_CHECKSUM') return 'no-checksum';
  if (code === 'PLATFORM' || code === 'TOOL_UNAVAILABLE') return 'unavailable';
  if (code === 'BAD_MODEL' || code === 'BAD_ZIP' || code === 'LICENSE' || code === 'NO_ENGINE' || code === 'UNOFFICIAL_ZIP') return 'config';
  if (/^(TIMEOUT|NETWORK|ECONN\w*|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|INCOMPLETE|RANGE_RESET|ENETUNREACH|EHOSTUNREACH|HTTP_\d+)$/.test(code)
    || /tempo esgotado|timeout|network|conex|internet|getaddrinfo|ENOTFOUND|ECONN|socket|HTTP \d{3}|status \d{3}/i.test(msg) || (err && err.status >= 500)) return 'network';
  return 'other';
}

const isPermanent = (err) => PERMANENT_REASONS.has(classifyError(err)) || PERMANENT_CODES.has(String((err && err.code) || ''));

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const shortMessage = (err) => String((err && err.message) || err || 'Falha desconhecida').replace(/\s+/g, ' ').slice(0, 300);

/** Grava a linha de progresso para o instalador (atômico; sem arquivo configurado, não faz nada). */
class ProgressFile {
  constructor(file) { this.file = file || null; this.last = ''; }

  write({ state = 'run', percent = 0, phase = '-', index = 0, total = 0, exit = '-' }) {
    const line = `${state}|${clamp(Math.round(percent), 0, 100)}|${phase}|${index}|${total}|${exit}\n`;
    if (line === this.last || !this.file) { this.last = line; return; }
    this.last = line;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, line, 'ascii');
      fs.renameSync(tmp, this.file);
    } catch (_) {
      // o instalador pode estar com o arquivo aberto: tenta a gravação direta (o progresso é só informativo)
      try { fs.writeFileSync(this.file, line, 'ascii'); } catch (_e) { /* sem progresso */ }
    }
  }
}

function readRecord(recordPath) {
  try { return JSON.parse(fs.readFileSync(recordPath, 'utf8')); } catch (_) { return null; }
}

function writeRecord(recordPath, record) {
  try {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    const tmp = `${recordPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, recordPath);
    return true;
  } catch (_) { return false; }
}

/** Componentes que ainda faltam (não instalados e que existem para este sistema). */
function pendingOf(components) {
  return Object.entries(components)
    .filter(([, c]) => c.status === 'failed' || c.status === 'skipped')
    .map(([id]) => id);
}

/**
 * Executa o plano.
 * @param {object} opts
 * @param {'basic'|'full'} opts.mode
 * @param {string} opts.modelId                 modelo da instalação completa (validado antes)
 * @param {object} opts.deps
 *   isToolInstalled(tool)->bool, isToolSupported(tool)->bool, installTool(tool,onPercent)->result,
 *   modules { getStatus(), installEngine(), installModel(id), cancel(), on/off('progress') },
 *   enableTranscription()->void, cleanup()->void (apaga parciais; opcional)
 * @param {string|null} opts.progressFile  @param {string|null} opts.cancelFile  @param {string} opts.recordPath
 * @param {number} [opts.timeoutMs=5400000]  @param {number} [opts.attempts=3]  @param {number[]} [opts.retryDelaysMs]
 * @returns {Promise<{exitCode:number, record:object}>}
 */
async function runComponentsSetup(opts) {
  const {
    mode, modelId, deps, progressFile = null, cancelFile = null, recordPath, appVersion = null,
    timeoutMs = 90 * 60 * 1000, attempts = 3, retryDelaysMs = [2000, 6000], pollMs = 400,
    log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = opts;

  const steps = buildSteps({ mode, modelId });
  const totalWeight = steps.reduce((s, x) => s + x.weight, 0);
  const progress = new ProgressFile(progressFile);
  const record = {
    version: 1, mode, model: mode === 'full' ? modelId : null, appVersion,
    startedAt: new Date().toISOString(), finishedAt: null, result: 'running', exitCode: null,
    components: {}, pending: []
  };

  // --- cancelamento (arquivo) e limite de tempo: ambos interrompem a etapa em andamento
  let stop = null; // 'cancelled' | 'timeout'
  let rejectStop;
  const stopPromise = new Promise((_, rej) => { rejectStop = rej; });
  stopPromise.catch(() => {});
  const triggerStop = (reason) => {
    if (stop) return;
    stop = reason;
    try { if (deps.modules && typeof deps.modules.cancel === 'function') deps.modules.cancel(); } catch (_) { /* noop */ }
    const e = new Error(reason === 'timeout' ? 'Tempo limite da instalação dos componentes atingido.' : 'Instalação dos componentes cancelada.');
    e.code = 'CANCELLED';
    rejectStop(e);
  };
  // Cancelar = arquivo de cancelamento OU o instalador ter ido embora (a pasta temporária dele, onde fica o arquivo
  // de progresso, some quando o instalador fecha ou é encerrado): nada de download órfão em segundo plano.
  const watchDir = progressFile && fs.existsSync(path.dirname(progressFile)) ? path.dirname(progressFile) : null;
  const poller = (cancelFile || watchDir)
    ? setInterval(() => {
      if ((cancelFile && fs.existsSync(cancelFile)) || (watchDir && !fs.existsSync(watchDir))) triggerStop('cancelled');
    }, pollMs)
    : null;
  const timer = setTimeout(() => triggerStop('timeout'), timeoutMs);
  if (poller && poller.unref) poller.unref();
  if (timer.unref) timer.unref();

  let doneWeight = 0;
  let current = { index: 0, step: null };
  const report = (frac = 0) => {
    const step = current.step;
    const pct = ((doneWeight + (step ? step.weight * clamp(frac, 0, 1) : 0)) / totalWeight) * 100;
    progress.write({ percent: Math.min(pct, 99), phase: step ? step.phase : 'tool', index: current.index, total: steps.length });
  };

  // progresso dos módulos (motor e modelo) -> fração da etapa atual
  const onModuleProgress = (p) => {
    if (!p || !current.step) return;
    const kindOk = (current.step.kind === 'engine' && p.kind === 'engine') || (current.step.kind === 'model' && p.kind === 'model');
    if (!kindOk) return;
    if (typeof p.percent === 'number') report(p.percent / 100);
    else if (p.totalBytes) report(p.receivedBytes / p.totalBytes);
  };
  if (deps.modules && typeof deps.modules.on === 'function') deps.modules.on('progress', onModuleProgress);

  const attempt = async (fn) => {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await Promise.race([fn(), stopPromise]);
      } catch (err) {
        if (stop) throw err;
        lastErr = err;
        log(`tentativa ${i}/${attempts} falhou: ${shortMessage(err)}`);
        if (i === attempts || isPermanent(err)) break;
        await Promise.race([sleep(retryDelaysMs[Math.min(i - 1, retryDelaysMs.length - 1)] || 0), stopPromise]);
      }
    }
    throw lastErr;
  };

  const setComponent = (id, data) => { record.components[id] = data; };
  writeRecord(recordPath, record);
  report(0);

  let engineOk = mode !== 'full';
  let modelOk = mode !== 'full';
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      current = { index: i + 1, step };
      if (stop) { setComponent(step.id, { status: 'skipped', reason: stop }); doneWeight += step.weight; continue; }
      report(0);
      try {
        if (step.kind === 'tool') {
          const allThere = step.tools.every((t) => deps.isToolInstalled(t));
          if (allThere) { setComponent(step.id, { status: 'already' }); }
          else if (!deps.isToolSupported(step.tools[0])) { setComponent(step.id, { status: 'unavailable', reason: 'unavailable' }); }
          else {
            const result = await attempt(async () => {
              const r = await deps.installTool(step.tools[0], (pct) => report((Number(pct) || 0) / 100));
              if (r && r.needsConfirmation) { const e = new Error('A fonte não publica a verificação de integridade; a instalação foi recusada por segurança.'); e.code = 'NO_CHECKSUM'; throw e; }
              if (!step.tools.every((t) => deps.isToolInstalled(t))) throw new Error('A ferramenta foi baixada, mas não foi encontrada depois da instalação.');
              return r;
            });
            setComponent(step.id, { status: 'ok', version: (versionOf(result)) });
          }
        } else if (step.kind === 'engine') {
          const st = (await deps.modules.getStatus()).whisper;
          if (!st.engine.available) { setComponent(step.id, { status: 'unavailable', reason: 'unavailable' }); engineOk = false; modelOk = false; }
          else if (st.engine.installed) { setComponent(step.id, { status: 'already' }); engineOk = true; }
          else {
            await attempt(() => deps.modules.installEngine());
            setComponent(step.id, { status: 'ok' }); engineOk = true;
          }
        } else if (step.kind === 'model') {
          const st = (await deps.modules.getStatus()).whisper;
          if (!st.engine.available) { setComponent(step.id, { status: 'unavailable', reason: 'unavailable', model: step.modelId }); modelOk = false; }
          else if (!engineOk) { setComponent(step.id, { status: 'skipped', reason: 'engine', model: step.modelId }); }
          else if ((st.models.find((m) => m.id === step.modelId) || {}).installed) { setComponent(step.id, { status: 'already', model: step.modelId }); modelOk = true; }
          else {
            await attempt(() => deps.modules.installModel(step.modelId));
            setComponent(step.id, { status: 'ok', model: step.modelId }); modelOk = true;
          }
        } else if (step.kind === 'enable') {
          const engineStatus = record.components.whisperEngine && record.components.whisperEngine.status;
          if (engineStatus === 'unavailable') setComponent(step.id, { status: 'unavailable', reason: 'unavailable' });
          else if (!engineOk || !modelOk) setComponent(step.id, { status: 'skipped', reason: 'dependency' });
          else { await deps.enableTranscription(); setComponent(step.id, { status: 'ok' }); }
        }
      } catch (err) {
        if (stop) { setComponent(step.id, { status: 'skipped', reason: stop }); }
        else {
          const reason = classifyError(err);
          setComponent(step.id, { status: 'failed', reason, error: shortMessage(err) });
          if (step.kind === 'engine') engineOk = false;
          if (step.kind === 'model') modelOk = false;
          log(`etapa ${step.id} falhou (${reason}): ${shortMessage(err)}`);
        }
      }
      doneWeight += step.weight;
      report(0);
    }
  } finally {
    clearInterval(poller);
    clearTimeout(timer);
    if (deps.modules && typeof deps.modules.off === 'function') deps.modules.off('progress', onModuleProgress);
  }

  record.pending = pendingOf(record.components);
  let exitCode = EXIT.OK;
  if (stop === 'cancelled') { exitCode = EXIT.CANCELLED; record.result = 'cancelled'; }
  else if (stop === 'timeout') { exitCode = EXIT.TIMEOUT; record.result = 'timeout'; }
  else if (record.pending.length > 0) {
    exitCode = EXIT.PARTIAL;
    record.result = Object.values(record.components).some((c) => c.status === 'ok' || c.status === 'already') ? 'partial' : 'failed';
  } else record.result = 'ok';
  record.exitCode = exitCode;
  record.finishedAt = new Date().toISOString();

  // Nunca deixa arquivos parciais quando algo falhou, foi cancelado ou estourou o tempo.
  if (exitCode !== EXIT.OK && typeof deps.cleanup === 'function') { try { await deps.cleanup(); } catch (_) { /* noop */ } }
  writeRecord(recordPath, record);
  progress.write({ state: 'end', percent: exitCode === EXIT.OK ? 100 : Math.round((doneWeight / totalWeight) * 100), exit: exitCode });
  return { exitCode, record };
}

/** Versão informada pelo instalador de ferramenta (quando houver). */
function versionOf(result) {
  if (!result || typeof result !== 'object') return null;
  return result.installed || result.version || null;
}

module.exports = {
  EXIT, WEIGHTS, buildSteps, classifyError, isPermanent, pendingOf,
  readRecord, writeRecord, runComponentsSetup, ProgressFile
};
