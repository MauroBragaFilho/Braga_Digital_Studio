/**
 * RecoveryStates — telas de estado: carregando, sem recuperação e erro.
 */

import { h, icon } from './recoveryUtils.js';

export function RecoveryLoadingState() {
  return h('div', { class: 'rc-card rc-state-card', role: 'status' }, [
    h('span', { class: 'rc-spinner rc-spinner-lg', 'aria-hidden': 'true' }),
    h('strong', { text: 'Verificando estados de recuperação…' })
  ]);
}

/** Estado 1 — sem recuperação. */
export function RecoveryEmptyState() {
  return h('div', { class: 'rc-card rc-state-card rc-state-empty' }, [
    icon('inventory_2', 'rc-state-icon'),
    h('strong', { text: 'Nenhum estado de recuperação disponível.' }),
    h('span', { class: 'rc-muted', text: 'Quando o BDS registrar auto-saves, backups ou sessões anteriores do projeto, eles aparecerão aqui.' })
  ]);
}

/** Estado 7 — erro ao consultar os estados. @param {{message:string, onRetry:()=>void}} props */
export function RecoveryErrorState({ message, onRetry }) {
  return h('div', { class: 'rc-card rc-state-card rc-state-error', role: 'alert' }, [
    icon('report', 'rc-state-icon'),
    h('strong', { text: 'Não foi possível carregar a recuperação.' }),
    h('span', { class: 'rc-muted', text: message || 'Erro desconhecido.' }),
    h('button', { class: 'rc-btn rc-btn-primary', type: 'button', onclick: onRetry }, [icon('refresh'), 'Tentar novamente'])
  ]);
}
