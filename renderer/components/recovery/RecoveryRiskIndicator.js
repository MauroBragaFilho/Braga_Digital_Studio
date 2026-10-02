/**
 * RecoveryRiskIndicator — indicador visual de risco, reutilizável.
 *
 * Recebe apenas um valor de RecoveryRisk ('low' | 'medium' | 'high'). Hoje o valor vem do
 * mock; no futuro virá do Recovery Engine (validateRecovery) sem mudar este componente.
 * Valor ausente ou desconhecido é exibido como "Não avaliado".
 *
 * @param {{ risk: string|null, variant?: 'badge'|'full' }} props
 *   badge → etiqueta compacta (listas)    full → bloco com medidor e descrição (detalhes/diálogo)
 */

import { RISK_INFO } from './recoveryTypes.js';
import { h, icon } from './recoveryUtils.js';

const LEVEL = { low: 1, medium: 2, high: 3 };
const ICON = { low: 'shield', medium: 'warning', high: 'dangerous' };

export function RecoveryRiskIndicator({ risk, variant = 'badge' } = {}) {
  const info = RISK_INFO[risk];
  const key = info ? risk : 'unknown';
  const label = info ? info.label : 'Não avaliado';

  if (variant === 'badge') {
    return h('span', { class: `rc-risk rc-risk-${key}`, title: info ? info.description : 'Risco ainda não avaliado.' }, [
      h('span', { class: 'rc-risk-dot', 'aria-hidden': 'true' }),
      `Risco ${label.toLowerCase()}`
    ]);
  }

  const level = LEVEL[risk] || 0;
  const meter = h('span', { class: 'rc-risk-meter', 'aria-hidden': 'true' },
    [1, 2, 3].map((n) => h('span', { class: `rc-risk-seg${n <= level ? ' on' : ''}` })));

  return h('div', { class: `rc-risk-full rc-risk-${key}`, role: 'group', 'aria-label': `Nível de risco: ${label}` }, [
    icon(ICON[risk] || 'help', 'rc-risk-icon'),
    h('div', { class: 'rc-risk-text' }, [
      h('strong', { text: `Risco ${label.toLowerCase()}` }),
      h('span', { text: info ? info.description : 'O risco deste estado ainda não foi avaliado.' })
    ]),
    meter
  ]);
}
