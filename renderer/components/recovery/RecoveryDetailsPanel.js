/**
 * RecoveryDetailsPanel — detalhes do estado selecionado, comparação e ações.
 *
 * Em telas largas fica ao lado do histórico; em janelas menores vira um painel inferior
 * (comportamento definido no CSS, a partir do atributo data-open).
 *
 * @param {{ state: object, actions: object }} props   state/actions do RecoveryController
 */

import { STATUS_LABEL, SOURCE_LABEL } from './recoveryTypes.js';
import { RecoveryRiskIndicator } from './RecoveryRiskIndicator.js';
import { RecoveryComparison } from './RecoveryComparison.js';
import { h, icon, formatDateTime, formatBytes } from './recoveryUtils.js';

function infoRow(label, value) {
  return h('div', { class: 'rc-info-row' }, [
    h('span', { class: 'rc-field-label', text: label }),
    h('span', { class: 'rc-field-value', text: value })
  ]);
}

function detailsView(details, validation) {
  const risk = (validation && validation.risk) || details.risk;
  const issues = (validation && validation.issues) || [];
  const MAX_FILES = 5;

  return h('div', { class: 'rc-details-body' }, [
    RecoveryRiskIndicator({ risk, variant: 'full' }),
    issues.length
      ? h('ul', { class: 'rc-issues', 'aria-label': 'Problemas encontrados' },
          issues.map((text) => h('li', {}, [icon('error_outline'), text])))
      : null,

    h('div', { class: 'rc-section-title', text: 'INFORMAÇÕES' }),
    h('div', { class: 'rc-info-grid' }, [
      infoRow('Projeto', details.project),
      infoRow('Sessão', details.session),
      infoRow('Data/hora', formatDateTime(details.timestamp)),
      infoRow('Origem', SOURCE_LABEL[details.source] || details.source),
      infoRow('Estado', STATUS_LABEL[details.status] || details.status),
      infoRow('Última alteração', formatDateTime(details.lastChange)),
      infoRow('Tamanho', `${formatBytes(details.sizeBytes)} · ${details.fileCount} arquivos`),
      h('div', { class: 'rc-info-row' }, [
        h('span', { class: 'rc-field-label', text: 'Integridade' }),
        h('span', { class: 'rc-integrity' }, [
          h('span', { class: 'rc-integrity-bar', 'aria-hidden': 'true' }, [h('span', { style: `width:${Math.max(0, Math.min(100, details.integrity))}%` })]),
          h('span', { class: 'rc-field-value', text: `${details.integrity}%` })
        ])
      ])
    ]),

    h('div', { class: 'rc-section-title', text: 'ARQUIVOS ENVOLVIDOS' }),
    h('ul', { class: 'rc-files' }, [
      ...details.files.slice(0, MAX_FILES).map((f) => h('li', {}, [icon('draft'), f])),
      details.files.length > MAX_FILES ? h('li', { class: 'rc-muted', text: `+ ${details.files.length - MAX_FILES} outros arquivos` }) : null
    ]),

    h('div', { class: 'rc-section-title', text: 'CONTEÚDO POTENCIALMENTE RESTAURÁVEL' }),
    h('ul', { class: 'rc-contents' }, details.contents.map((c) =>
      h('li', { class: `rc-content${c.restorable ? '' : ' partial'}` }, [
        icon(c.icon),
        h('div', {}, [h('strong', { text: c.label }), h('span', { class: 'rc-muted', text: `${c.items} ${c.items === 1 ? 'item' : 'itens'}` })]),
        h('span', { class: 'rc-content-tag', text: c.restorable ? 'Restaurável' : 'Parcial' })
      ])))
  ]);
}

export function RecoveryDetailsPanel({ state, actions }) {
  const { selectedId, details, comparison, validation, detailsLoading, tab, createBackup } = state;

  if (!selectedId) {
    return h('aside', { class: 'rc-card rc-details rc-details-empty', 'data-open': 'false', 'aria-label': 'Detalhes do estado' }, [
      icon('touch_app', 'rc-placeholder-icon'),
      h('strong', { text: 'Nenhum estado selecionado' }),
      h('span', { class: 'rc-muted', text: 'Escolha um estado na lista para ver os detalhes, comparar com o estado atual e restaurar.' })
    ]);
  }

  const body = detailsLoading || !details
    ? h('div', { class: 'rc-loading-inline', role: 'status' }, [h('span', { class: 'rc-spinner', 'aria-hidden': 'true' }), 'Carregando detalhes…'])
    : (tab === 'compare' ? RecoveryComparison({ comparison }) : detailsView(details, validation));

  const ready = !!details && !detailsLoading;

  return h('aside', { class: 'rc-card rc-details', 'data-open': 'true', 'aria-label': 'Detalhes do estado selecionado' }, [
    h('div', { class: 'rc-card-head' }, [
      h('span', { class: 'rc-card-title' }, [icon('fact_check'), 'ESTADO SELECIONADO']),
      h('button', { class: 'rc-icon-btn', type: 'button', title: 'Fechar detalhes', 'aria-label': 'Fechar detalhes', onclick: actions.clearSelection }, [icon('close')])
    ]),
    ready ? h('p', { class: 'rc-details-when', text: formatDateTime(details.timestamp) }) : null,

    h('div', { class: 'rc-tabs', role: 'tablist' }, [
      h('button', { class: `rc-tab${tab === 'details' ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(tab === 'details'), onclick: () => actions.setTab('details') }, [icon('visibility'), 'Detalhes']),
      h('button', { class: `rc-tab${tab === 'compare' ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(tab === 'compare'), onclick: () => actions.setTab('compare') }, [icon('compare_arrows'), 'Comparar com estado atual'])
    ]),

    h('div', { class: 'rc-details-scroll' }, [body]),

    h('div', { class: 'rc-actions' }, [
      h('label', { class: 'rc-check' }, [
        h('input', { type: 'checkbox', checked: createBackup, onchange: (e) => actions.setCreateBackup(e.target.checked) }),
        h('span', {}, [h('strong', { text: 'Criar cópia antes de restaurar' }), h('small', { text: 'Guarda o estado atual antes de substituí-lo.' })])
      ]),
      h('div', { class: 'rc-action-row' }, [
        h('button', { class: 'rc-btn rc-btn-primary', type: 'button', disabled: !ready, onclick: actions.openRestore }, [icon('restore'), 'Restaurar estado']),
        h('button', { class: 'rc-btn rc-btn-secondary', type: 'button', disabled: !ready, onclick: () => actions.setTab(tab === 'compare' ? 'details' : 'compare') },
          [icon(tab === 'compare' ? 'visibility' : 'compare_arrows'), tab === 'compare' ? 'Ver detalhes' : 'Comparar']),
        h('button', { class: 'rc-btn rc-btn-danger', type: 'button', disabled: !ready, onclick: actions.openDelete }, [icon('delete'), 'Excluir'])
      ])
    ])
  ]);
}
