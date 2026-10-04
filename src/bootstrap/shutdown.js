'use strict';

const logger = require('../services/logService');
const deadlineNotifier = require('../infrastructure/desktop/DeadlineNotifier');
const deviceDiscoveryService = require('../core/devices/DeviceDiscoveryService');
const sonyCameraService = require('../core/devices/SonyCameraService');
const dbManager = require('../core/database/database');

/**
 * Encerramento ordenado: cancela/pausa serviços em andamento, para watchers e descoberta de
 * dispositivos e, por fim, grava o banco de forma síncrona. (A idempotência fica no Bootstrap.)
 *
 * Cada etapa é isolada (uma falha não impede as demais) e o conjunto de cancelamentos tem um
 * prazo total (`timeoutMs`); a gravação do banco sempre roda por último, mesmo após timeout.
 *
 * `ctx` = { services, getModuleManager, settingsManager }.
 */
async function runShutdown(ctx, { timeoutMs = 5000 } = {}) {
  const s = ctx.services || {};
  const step = async (name, fn) => {
    try { await fn(); }
    catch (err) { logger.warn('Bootstrap:shutdown:step_error', { step: name, error: err && err.message }); }
  };

  const cancellations = [
    // Fila de downloads: pausa (mantém itens pendentes para a próxima sessão)
    step('download', () => s.downloadService?.pause?.()),
    step('converter', async () => { if (s.converterService?.isRunning?.()) await s.converterService.cancelCurrent(); }),
    step('montage', () => s.montageService?.cancelMontage?.()),
    step('silence', () => s.silenceService?.cancel?.()),
    step('metadata', () => s.metadataService?.cancel?.()),
    step('videoRecovery', () => s.videoRecoveryService?.cancel?.()),
    step('rawRecovery', () => s.rawRecoveryService?.cancel?.()),
    // AudioSyncService/WaveformService não expõem cancelamento: seus ffmpeg têm timeout próprio.
    step('audioSync', () => s.audioSyncService?.cancel?.()),
    step('waveform', () => s.waveformService?.cancel?.()),
    step('jobManager', () => require('../core/jobs/JobManager').jobManager?.cancelAll?.()),
    step('modules', () => ctx.getModuleManager()?.cancel?.())
  ];

  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  const outcome = await Promise.race([Promise.allSettled(cancellations).then(() => 'done'), deadline]);
  clearTimeout(timer);
  if (outcome === 'timeout') logger.warn('Bootstrap:shutdown:timeout', { timeoutMs });

  // Watchers, descoberta de dispositivos, câmeras Sony e lembretes de prazo
  await step('watchers', () => s.watcherService?.stopAll?.());
  await step('deadline', () => deadlineNotifier.stop());
  await step('discovery', () => deviceDiscoveryService?.stop?.());
  await step('bdsm-pairing', () => require('../core/integrations/bdsm/BdsmPairing').getPairing().stopAll());
  await step('sony', () => sonyCameraService?.stop?.());

  // Grava configurações com escrita adiada pendente (ex.: posição da janela)
  await step('settings', () => ctx.settingsManager.flush());

  // Para de iniciar novas importações da biblioteca durante o encerramento
  await step('importQueue', () => s.importQueue?.pause?.());

  // Históricos de downloads/conversões (gravação em lote pendente)
  await step('history', () => s.historyService?.flush?.());

  // Gravação final do banco: síncrona, para não perder dados ao sair
  await step('database', () => {
    if (typeof dbManager.persistSync === 'function') dbManager.persistSync();
    else if (typeof dbManager.persist === 'function') dbManager.persist();
  });
}

module.exports = { runShutdown };
