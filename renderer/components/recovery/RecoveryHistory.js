/**
 * RecoveryHistory — lista "Estados disponíveis".
 * @param {{ items: import('./recoveryTypes.js').RecoveryItem[], selectedId: string|null,
 *           onSelect: (id:string)=>void }} props
 */

import { RecoveryItem } from './RecoveryItem.js';
import { h, icon } from './recoveryUtils.js';

export function RecoveryHistory({ items, selectedId, onSelect }) {
  return h('section', { class: 'rc-card rc-history', 'aria-label': 'Estados disponíveis' }, [
    h('div', { class: 'rc-card-head' }, [
      h('span', { class: 'rc-card-title' }, [icon('history'), 'ESTADOS DISPONÍVEIS ', h('strong', { class: 'rc-count', text: String(items.length) })]),
      h('span', { class: 'rc-muted rc-hint', text: 'Do mais recente ao mais antigo' })
    ]),
    h('ul', { class: 'rc-list' }, items.map((item) => RecoveryItem({ item, selected: item.id === selectedId, onSelect })))
  ]);
}
