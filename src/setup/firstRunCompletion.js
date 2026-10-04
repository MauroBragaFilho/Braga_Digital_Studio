'use strict';

/**
 * firstRunCompletion — na primeira abertura do app, conclui o que o instalador não conseguiu baixar
 * (sem internet, queda de rede, hash divergente...). Lê o registro gravado pelo modo de componentes
 * (data/setup-components.json):
 *   - ferramentas básicas ausentes: já são baixadas pelo fluxo existente (bootstrap/startup.js, com o aviso de
 *     "preparando"); aqui só cuidamos da TRANSCRIÇÃO (motor + modelo + ligar o módulo), pelo mesmo
 *     ModuleManager da tela de Configurações > Módulos (o progresso aparece lá também);
 *   - um aviso discreto (toast) informa o início e o resultado; nada de tela nova.
 * Só roda para instalação "completa" que terminou parcial/falha/interrompida (não para "cancelada") e no máximo
 * 2 vezes (para não baixar 200 MB a cada abertura de quem está sem internet): depois, é só instalar em
 * Configurações > Módulos.
 */

const { readRecord, writeRecord } = require('./ComponentsSetup');
const { recommendedCpuModelId } = require('./setupArgs');
const { getModel } = require('../core/modules/WhisperCatalog');

const WHISPER_PARTS = ['whisperEngine', 'whisperModel', 'enableTranscription'];
const MAX_APP_ATTEMPTS = 2;

/** Este registro ainda precisa de conclusão da transcrição pelo app? */
function needsCompletion(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.mode !== 'full' || record.completedByApp) return false;
  if ((record.appAttempts || 0) >= MAX_APP_ATTEMPTS) return false;
  if (!['partial', 'failed', 'timeout', 'running'].includes(record.result)) return false; // 'ok' e 'cancelled' não
  if (record.result === 'running' || record.result === 'timeout') return true;
  return Array.isArray(record.pending) && record.pending.some((id) => WHISPER_PARTS.includes(id));
}

/**
 * @param {{recordPath:string, moduleManager:object, enableTranscription:Function,
 *          notify?:(type:'info'|'success'|'error', text:string)=>void, log?:Function}} p
 * @returns {Promise<{ran:boolean, ok?:boolean, reason?:string}>}
 */
async function completePendingSetup({ recordPath, moduleManager, enableTranscription, notify = () => {}, log = () => {} }) {
  const record = readRecord(recordPath);
  if (!needsCompletion(record)) return { ran: false };

  record.appAttempts = (record.appAttempts || 0) + 1;
  writeRecord(recordPath, record);

  try {
    const status = (await moduleManager.getStatus()).whisper;
    if (!status.engine.available) {
      record.completedByApp = true; record.pending = []; record.note = 'transcrição indisponível neste sistema';
      writeRecord(recordPath, record);
      return { ran: false, reason: 'unavailable' };
    }
    const modelId = getModel(record.model) ? record.model : recommendedCpuModelId();
    const modelInstalled = Boolean((status.models.find((m) => m.id === modelId) || {}).installed);

    if (!status.engine.installed || !modelInstalled) {
      notify('info', 'Concluindo a instalação da transcrição… Isso pode levar alguns minutos.');
      if (!status.engine.installed) await moduleManager.installEngine();
      if (!modelInstalled) await moduleManager.installModel(modelId);
    }
    enableTranscription();

    record.pending = (record.pending || []).filter((id) => !WHISPER_PARTS.includes(id));
    record.completedByApp = true;
    record.result = record.pending.length ? 'partial' : 'ok';
    record.completedAt = new Date().toISOString();
    writeRecord(recordPath, record);
    notify('success', 'A transcrição foi instalada e já está pronta para usar.');
    return { ran: true, ok: true };
  } catch (err) {
    log(`conclusão da transcrição falhou: ${err && err.message}`);
    const busy = err && err.code === 'BUSY';
    if (busy) { record.appAttempts = Math.max(0, (record.appAttempts || 1) - 1); writeRecord(recordPath, record); }
    else notify('error', 'Não foi possível concluir a instalação da transcrição agora. Você pode instalá-la depois em Configurações > Módulos.');
    return { ran: true, ok: false, reason: busy ? 'busy' : 'error' };
  }
}

module.exports = { completePendingSetup, needsCompletion, WHISPER_PARTS, MAX_APP_ATTEMPTS };
