/**
 * RecoveryService — contrato entre a tela Recuperação e os motores de recuperação.
 *
 *   RecoveryScreen → RecoveryController → RecoveryService → (motores futuros)
 *
 * Os motores reais devem implementar esta interface e ser instalados com
 * setRecoveryService(). Nada na tela ou no controller precisa mudar.
 *
 * Contrato (todos os métodos são assíncronos):
 *
 *   getProjectStatus()                       → ProjectStatus
 *   getAvailableRecoveries()                 → RecoveryItem[]       (mais recente primeiro)
 *   getRecoveryDetails(id)                   → RecoveryDetails
 *   compareRecovery(id)                      → RecoveryComparison   (estado atual × recuperável)
 *   validateRecovery(id)                     → RecoveryValidation   (risco real vindo do motor)
 *   restoreRecovery(id, options, onProgress) → RecoveryResult       (onProgress({percent, step}))
 *   deleteRecovery(id)                       → void
 *
 * Erros: rejeitar a Promise com Error (message em pt-BR). A tela exibe o estado de erro.
 * Tipos: ver recoveryTypes.js.
 */

import { MockRecoveryService } from './MockRecoveryService.js';

let activeService = new MockRecoveryService();

export const REQUIRED_METHODS = [
  'getProjectStatus',
  'getAvailableRecoveries',
  'getRecoveryDetails',
  'compareRecovery',
  'validateRecovery',
  'restoreRecovery',
  'deleteRecovery'
];

/** Serviço em uso (por padrão, o mock). */
export function getRecoveryService() {
  return activeService;
}

/** Instala outro serviço (ex.: o motor real). Valida que o contrato está completo. */
export function setRecoveryService(service) {
  const missing = REQUIRED_METHODS.filter((m) => typeof service?.[m] !== 'function');
  if (missing.length) throw new Error(`RecoveryService incompleto. Faltam: ${missing.join(', ')}`);
  activeService = service;
}
