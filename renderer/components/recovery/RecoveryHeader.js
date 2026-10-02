/**
 * RecoveryHeader — título, subtítulo e indicador geral do sistema.
 *
 * Quando o serviço é o mock, exibe também a barra "Simulação", que só serve para
 * demonstrar os estados da interface (vazio, atenção, erro). Os motores reais não
 * definem `simulation`, então a barra simplesmente não aparece.
 *
 * @param {{ systemStatus: string|null,
 *           simulation: {scenario:string, failNextRestore:boolean}|null,
 *           onScenarioChange: (name:string)=>void,
 *           onFailToggle: (value:boolean)=>void }} props
 */

import { SYSTEM_STATUS_INFO } from './recoveryTypes.js';
import { h, icon } from './recoveryUtils.js';

const SCENARIOS = [
  ['available', 'Recuperação disponível'],
  ['attention', 'Atenção necessária (risco alto)'],
  ['empty', 'Sem recuperação'],
  ['error', 'Erro ao consultar']
];

export function RecoveryHeader({ systemStatus, simulation, onScenarioChange, onFailToggle }) {
  const info = SYSTEM_STATUS_INFO[systemStatus];

  const indicator = info
    ? h('div', { class: `rc-system rc-system-${systemStatus}`, role: 'status', title: info.description }, [
        icon(info.icon), h('div', {}, [h('strong', { text: info.label }), h('span', { text: info.description })])
      ])
    : null;

  const sim = simulation
    ? h('div', { class: 'rc-sim', title: 'Controles de demonstração: somente dados fictícios.' }, [
        h('span', { class: 'rc-sim-tag', text: 'SIMULAÇÃO' }),
        h('label', { class: 'rc-sim-field' }, [
          h('span', { text: 'Cenário' }),
          h('select', { class: 'rc-select', 'aria-label': 'Cenário simulado', onchange: (e) => onScenarioChange(e.target.value) },
            SCENARIOS.map(([value, text]) => h('option', { value, text, ...(value === simulation.scenario ? { selected: true } : {}) })))
        ]),
        h('label', { class: 'rc-sim-check' }, [
          h('input', { type: 'checkbox', checked: simulation.failNextRestore, onchange: (e) => onFailToggle(e.target.checked) }),
          'Falhar na próxima restauração'
        ])
      ])
    : null;

  return h('header', { class: 'rc-header' }, [
    h('div', { class: 'rc-header-main' }, [
      h('div', { class: 'rc-title-block' }, [
        icon('history', 'rc-title-icon'),
        h('div', {}, [
          h('h1', { class: 'rc-title', text: 'RECUPERAÇÃO' }),
          h('p', { class: 'rc-subtitle', text: 'Verifique e restaure estados anteriores do projeto.' })
        ])
      ]),
      indicator
    ]),
    sim
  ]);
}
