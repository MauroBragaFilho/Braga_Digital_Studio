/**
 * recoveryTypes.js — Tipos e constantes da tela Recuperação (estados do projeto).
 *
 * O projeto não usa TypeScript, então os tipos são declarados em JSDoc: editores com
 * checagem de tipos passam a validar quem usa estas estruturas. Os motores de recuperação
 * futuros devem devolver exatamente estas formas; a interface não precisa mudar.
 */

/** Validade de um estado recuperável. @readonly @enum {string} */
export const RecoveryStatus = Object.freeze({
  VALID: 'valid',
  PARTIAL: 'partial',
  CORRUPTED: 'corrupted'
});

/** Nível de risco de restaurar um estado. @readonly @enum {string} */
export const RecoveryRisk = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
});

/** De onde o estado veio. @readonly @enum {string} */
export const RecoverySource = Object.freeze({
  AUTOSAVE: 'autosave',
  BACKUP: 'backup',
  PREVIOUS_SESSION: 'previous_session'
});

/** Situação geral exibida no cabeçalho. @readonly @enum {string} */
export const SystemStatus = Object.freeze({
  SAFE: 'safe',
  RECOVERY_AVAILABLE: 'recovery_available',
  ATTENTION: 'attention'
});

/** Rótulos e descrições para a interface (pt-BR). */
export const STATUS_LABEL = {
  [RecoveryStatus.VALID]: 'Válido',
  [RecoveryStatus.PARTIAL]: 'Parcial',
  [RecoveryStatus.CORRUPTED]: 'Corrompido'
};

export const RISK_INFO = {
  [RecoveryRisk.LOW]: { label: 'Baixo', description: 'Estado aparentemente íntegro.' },
  [RecoveryRisk.MEDIUM]: { label: 'Médio', description: 'Existem informações incompletas ou inconsistências.' },
  [RecoveryRisk.HIGH]: { label: 'Alto', description: 'O estado pode conter dados incompletos/corrompidos.' }
};

export const SOURCE_LABEL = {
  [RecoverySource.AUTOSAVE]: 'Auto-save',
  [RecoverySource.BACKUP]: 'Backup',
  [RecoverySource.PREVIOUS_SESSION]: 'Sessão anterior'
};

export const SYSTEM_STATUS_INFO = {
  [SystemStatus.SAFE]: { label: 'Seguro', description: 'Nenhuma recuperação necessária.', icon: 'verified_user' },
  [SystemStatus.RECOVERY_AVAILABLE]: { label: 'Recuperação disponível', description: 'Há estados anteriores que podem ser restaurados.', icon: 'history' },
  [SystemStatus.ATTENTION]: { label: 'Atenção necessária', description: 'Foram encontrados estados com risco elevado.', icon: 'warning' }
};

/**
 * @typedef {Object} RecoveryContentCategory   Conteúdo potencialmente restaurável
 * @property {string} id           ex.: 'library', 'montage', 'settings', 'metadata', 'sidecars', 'project'
 * @property {string} label        ex.: 'Biblioteca'
 * @property {string} icon         nome do ícone Material Symbols
 * @property {number} items        quantidade de itens
 * @property {boolean} restorable  se este conteúdo pode ser restaurado deste estado
 */

/**
 * @typedef {Object} RecoveryItem   Um estado recuperável (linha do histórico)
 * @property {string} id
 * @property {string} timestamp     ISO 8601 (data/hora do estado)
 * @property {RecoverySource} source
 * @property {RecoveryStatus} status
 * @property {RecoveryRisk} risk
 * @property {number} sizeBytes
 * @property {number} fileCount
 */

/**
 * @typedef {RecoveryItem} RecoveryDetails   Detalhes completos de um estado
 * @property {string} project
 * @property {string} session
 * @property {string} lastChange    ISO 8601 da última alteração registrada nesse estado
 * @property {number} integrity     0–100, a ser calculado pelo motor de validação
 * @property {string[]} files       arquivos envolvidos (amostra para exibição)
 * @property {RecoveryContentCategory[]} contents
 */

/**
 * @typedef {Object} ProjectStatus   Estado atual do projeto
 * @property {string} name
 * @property {string} lastSession        ISO 8601
 * @property {string} lastModified       ISO 8601
 * @property {string} currentState       texto exibido (ex.: 'Recuperação disponível')
 * @property {string|null} lastValidState ISO 8601 do último estado válido conhecido
 * @property {number} recoverableCount
 * @property {SystemStatus} systemStatus
 */

/**
 * @typedef {Object} RecoveryComparisonRow
 * @property {string} category
 * @property {string} current        valor no estado atual (texto)
 * @property {string} recoverable    valor no estado recuperável (texto)
 * @property {'same'|'less'|'more'|'different'} diff
 */

/**
 * @typedef {Object} RecoveryComparison
 * @property {string} currentLabel
 * @property {string} recoverableLabel
 * @property {RecoveryComparisonRow[]} rows
 */

/**
 * @typedef {Object} RecoveryValidation
 * @property {RecoveryRisk} risk
 * @property {string[]} issues       problemas encontrados (vazio = íntegro)
 */

/**
 * @typedef {Object} RecoveryResult
 * @property {boolean} ok
 * @property {string} restoredId
 * @property {boolean} backupCreated
 * @property {boolean} simulated     true enquanto o motor for o mock
 * @property {string} message
 */

/**
 * @typedef {Object} RecoveryProgress
 * @property {number} percent        0–100
 * @property {string} step           texto da etapa em andamento
 */

/**
 * @typedef {Object} RestoreOptions
 * @property {boolean} createBackup  criar cópia do estado atual antes de restaurar
 */
