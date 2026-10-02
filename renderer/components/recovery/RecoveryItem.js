/**
 * RecoveryItem — uma linha do histórico de estados recuperáveis.
 * @param {{ item: import('./recoveryTypes.js').RecoveryItem, selected: boolean,
 *           onSelect: (id:string)=>void }} props
 */

import { STATUS_LABEL, SOURCE_LABEL } from './recoveryTypes.js';
import { RecoveryRiskIndicator } from './RecoveryRiskIndicator.js';
import { h, icon, formatDateTimeShort, formatBytes } from './recoveryUtils.js';

export function RecoveryItem({ item, selected, onSelect }) {
  const select = () => onSelect(item.id);
  return h('li', { class: 'rc-item-wrap' }, [
    h('div', {
      class: `rc-item rc-status-${item.status}${selected ? ' selected' : ''}`,
      role: 'button', tabindex: '0', 'aria-pressed': selected ? 'true' : 'false',
      'aria-label': `Estado de ${formatDateTimeShort(item.timestamp)}, ${STATUS_LABEL[item.status] || item.status}`,
      dataset: { id: item.id },
      onclick: select,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } }
    }, [
      h('div', { class: 'rc-item-when' }, [
        h('strong', { text: formatDateTimeShort(item.timestamp) }),
        h('span', { class: 'rc-muted', text: SOURCE_LABEL[item.source] || item.source })
      ]),
      h('span', { class: `rc-state-pill rc-state-${item.status}`, text: STATUS_LABEL[item.status] || item.status }),
      RecoveryRiskIndicator({ risk: item.risk, variant: 'badge' }),
      h('span', { class: 'rc-item-size rc-muted', text: `${formatBytes(item.sizeBytes)} · ${item.fileCount} arquivos` }),
      h('button', {
        class: 'rc-btn rc-btn-ghost rc-btn-sm', type: 'button',
        onclick: (e) => { e.stopPropagation(); select(); }
      }, [icon('visibility'), 'Visualizar'])
    ])
  ]);
}
