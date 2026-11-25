'use strict';

/**
 * Vocabulário fixo da tela Projetos (ver .docs/BDS_TELA_PROJETOS.md): status do projeto, estado da entrega,
 * categorias de dispositivos e tipos de atividade. O renderer repete a lista de status em
 * `renderer/utils/projectStatus.js` (um teste garante que são iguais).
 *
 * Os valores são gravados no banco como texto legível (como já era com 'Ativo'); `tone` é a cor semântica
 * (`--status-*`), nunca um hexadecimal.
 */

const STATUSES = Object.freeze([
  { id: 'Planejamento', tone: 'neutral', icon: 'radio_button_unchecked' },
  { id: 'Em produção', tone: 'info', icon: 'videocam' },
  { id: 'Pós-produção', tone: 'warn', icon: 'movie_edit' },
  { id: 'Aguardando cliente', tone: 'warn', icon: 'hourglass_top' },
  { id: 'Concluído', tone: 'ok', icon: 'check_circle' },
  { id: 'Problema', tone: 'bad', icon: 'error' },
  { id: 'Arquivado', tone: 'muted', icon: 'inventory_2' }
].map((s) => Object.freeze(s)));

const STATUS_IDS = Object.freeze(STATUSES.map((s) => s.id));
const DEFAULT_STATUS = 'Planejamento';

/** Projetos gravados antes dos 7 estados (Ativo, Pausado, Concluído). */
const LEGACY_STATUS = Object.freeze({
  Ativo: 'Em produção',
  Pausado: 'Aguardando cliente',
  Concluído: 'Concluído'
});

/** Estados que contam como "em andamento" nos filtros. */
const ACTIVE_STATUSES = Object.freeze(['Planejamento', 'Em produção', 'Pós-produção', 'Problema']);

/** Status válido ou o padrão (aceita os valores antigos). */
function normalizeStatus(value) {
  if (typeof value !== 'string') return DEFAULT_STATUS;
  const v = value.trim();
  if (STATUS_IDS.includes(v)) return v;
  if (LEGACY_STATUS[v]) return LEGACY_STATUS[v];
  return DEFAULT_STATUS;
}

const DELIVERY_STATUSES = Object.freeze(['Não iniciada', 'Em preparação', 'Pronta', 'Entregue']);
const DEFAULT_DELIVERY_ITEMS = Object.freeze(['Vídeo principal', 'Teaser', 'Fotos tratadas', 'Áudio final']);
const DEFAULT_DELIVERY_DESTINATIONS = Object.freeze(['HD', 'SSD', 'Upload', 'Cliente']);

const DEVICE_CATEGORIES = Object.freeze([
  { id: 'camera', label: 'Câmeras', icon: 'photo_camera' },
  { id: 'audio', label: 'Áudio', icon: 'mic' },
  { id: 'other', label: 'Outros', icon: 'devices_other' }
].map((c) => Object.freeze(c)));
const DEVICE_CATEGORY_IDS = Object.freeze(DEVICE_CATEGORIES.map((c) => c.id));

/** Tipos de atividade registrados no projeto (texto curto; o renderer escolhe o ícone). */
const ACTIVITY_KINDS = Object.freeze([
  'criado', 'editado', 'status', 'midia', 'pasta', 'dispositivo', 'entrega', 'exportado', 'importado', 'sincronizado', 'transcrito', 'duplicado', 'lut'
]);

/** Limites usados pelo serviço e pelos esquemas IPC. */
const LIMITS = Object.freeze({ nameMax: 200, textMax: 2000, deviceNameMax: 80, deviceNoteMax: 200, activityMax: 200, deliveryItemsMax: 30 });

module.exports = {
  STATUSES, STATUS_IDS, DEFAULT_STATUS, LEGACY_STATUS, ACTIVE_STATUSES, normalizeStatus,
  DELIVERY_STATUSES, DEFAULT_DELIVERY_ITEMS, DEFAULT_DELIVERY_DESTINATIONS,
  DEVICE_CATEGORIES, DEVICE_CATEGORY_IDS, ACTIVITY_KINDS, LIMITS
};
