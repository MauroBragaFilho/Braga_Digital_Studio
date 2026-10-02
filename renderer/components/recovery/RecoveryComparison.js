/**
 * RecoveryComparison — estado atual × estado recuperável.
 * Recebe um RecoveryComparison (ver recoveryTypes.js). Hoje vem do mock; a comparação real
 * do motor usa exatamente a mesma forma, então este componente não muda.
 *
 * @param {{ comparison: import('./recoveryTypes.js').RecoveryComparison|null }} props
 */

import { h, icon } from './recoveryUtils.js';

const DIFF = {
  same: { icon: 'check', label: 'Igual' },
  less: { icon: 'south', label: 'Menos que o atual' },
  more: { icon: 'north', label: 'Mais que o atual' },
  different: { icon: 'swap_horiz', label: 'Diferente do atual' }
};

export function RecoveryComparison({ comparison }) {
  if (!comparison) return h('p', { class: 'rc-muted', text: 'Comparação indisponível.' });

  const rows = comparison.rows.map((row) => {
    const d = DIFF[row.diff] || DIFF.different;
    return h('div', { class: `rc-cmp-row rc-diff-${row.diff}`, role: 'row' }, [
      h('span', { class: 'rc-cmp-cat', role: 'cell', text: row.category }),
      h('span', { class: 'rc-cmp-val', role: 'cell', text: row.current }),
      h('span', { class: 'rc-cmp-val rc-cmp-target', role: 'cell' }, [
        row.recoverable,
        h('span', { class: 'rc-diff-mark', title: d.label, 'aria-label': d.label }, [icon(d.icon)])
      ])
    ]);
  });

  const changed = comparison.rows.filter((r) => r.diff !== 'same').length;
  return h('div', { class: 'rc-compare' }, [
    h('div', { class: 'rc-cmp-grid', role: 'table', 'aria-label': 'Comparação entre estados' }, [
      h('div', { class: 'rc-cmp-row rc-cmp-head', role: 'row' }, [
        h('span', { role: 'columnheader', text: 'Conteúdo' }),
        h('span', { role: 'columnheader', text: comparison.currentLabel.toUpperCase() }),
        h('span', { role: 'columnheader', text: comparison.recoverableLabel.toUpperCase() })
      ]),
      ...rows
    ]),
    h('p', { class: 'rc-muted rc-cmp-summary', text: changed
      ? `${changed} categoria(s) diferem do estado atual. Restaurar substituirá o estado atual por este.`
      : 'Este estado é idêntico ao estado atual.' })
  ]);
}
