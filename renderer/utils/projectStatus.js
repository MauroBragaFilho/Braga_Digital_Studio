/**
 * Vocabulário da tela Projetos (cópia de src/core/projects/projectStatus.js; um teste garante que são iguais).
 * `tone` vira a classe `.tone-<tone>` (cores em --status-*), nunca um hexadecimal no código.
 */
export const STATUSES = Object.freeze([
  Object.freeze({ id: 'Planejamento', tone: 'neutral', icon: 'radio_button_unchecked' }),
  Object.freeze({ id: 'Em produção', tone: 'info', icon: 'videocam' }),
  Object.freeze({ id: 'Pós-produção', tone: 'warn', icon: 'movie_edit' }),
  Object.freeze({ id: 'Aguardando cliente', tone: 'warn', icon: 'hourglass_top' }),
  Object.freeze({ id: 'Concluído', tone: 'ok', icon: 'check_circle' }),
  Object.freeze({ id: 'Problema', tone: 'bad', icon: 'error' }),
  Object.freeze({ id: 'Arquivado', tone: 'muted', icon: 'inventory_2' })
]);
export const STATUS_IDS = Object.freeze(STATUSES.map((s) => s.id));
export const DEFAULT_STATUS = 'Planejamento';
export const LEGACY_STATUS = Object.freeze({ Ativo: 'Em produção', Pausado: 'Aguardando cliente', Concluído: 'Concluído' });
export const ACTIVE_STATUSES = Object.freeze(['Planejamento', 'Em produção', 'Pós-produção', 'Problema']);
export const DELIVERY_STATUSES = Object.freeze(['Não iniciada', 'Em preparação', 'Pronta', 'Entregue']);
export const DEVICE_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'camera', label: 'Câmeras', icon: 'photo_camera' }),
  Object.freeze({ id: 'audio', label: 'Áudio', icon: 'mic' }),
  Object.freeze({ id: 'other', label: 'Outros', icon: 'devices_other' })
]);

const BY_ID = new Map(STATUSES.map((s) => [s.id, s]));

/** Status válido ou o padrão (aceita os 3 valores antigos). */
export function normalizeStatus(value) {
  if (typeof value !== 'string') return DEFAULT_STATUS;
  const v = value.trim();
  if (BY_ID.has(v)) return v;
  return LEGACY_STATUS[v] || DEFAULT_STATUS;
}

/** { id, tone, icon } do status (normalizado). */
export function statusInfo(value) {
  return BY_ID.get(normalizeStatus(value));
}

/** Filtros da lista: id → status que entram. */
export const STATUS_FILTERS = Object.freeze([
  Object.freeze({ id: 'all', label: 'Todos', statuses: null }),
  Object.freeze({ id: 'active', label: 'Em andamento', statuses: ACTIVE_STATUSES }),
  Object.freeze({ id: 'waiting', label: 'Aguardando cliente', statuses: ['Aguardando cliente'] }),
  Object.freeze({ id: 'done', label: 'Concluídos', statuses: ['Concluído'] }),
  Object.freeze({ id: 'archived', label: 'Arquivados', statuses: ['Arquivado'] })
]);
