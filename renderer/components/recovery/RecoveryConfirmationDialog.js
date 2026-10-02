/**
 * RecoveryConfirmationDialog — modal de restauração e de exclusão, com todas as fases:
 *
 *   restauração:  confirm → progress → done | error
 *   exclusão:     confirm → progress → (fecha) | error
 *
 * IMPORTANTE (versão atual): o progresso e o resultado são SIMULADOS pelo MockRecoveryService.
 * O texto "Simulação" aparece na interface enquanto o serviço em uso for o mock
 * (state.simulation). Com um motor real, o aviso some e este componente continua igual.
 *
 * @param {{ state: object, actions: object, simulated: boolean }} props
 * @returns {HTMLElement|null} null quando não há diálogo aberto
 */

import { SOURCE_LABEL } from './recoveryTypes.js';
import { RecoveryRiskIndicator } from './RecoveryRiskIndicator.js';
import { h, icon, formatDateTime } from './recoveryUtils.js';

const simNote = () => h('p', { class: 'rc-sim-note' }, [icon('science'), 'Simulação: nenhum arquivo será lido, copiado, restaurado ou excluído.']);

function shell(kind, titleIcon, title, content, buttons, tone = '') {
  return h('div', { class: 'rc-modal-overlay', 'data-dialog': kind }, [
    h('div', { class: `rc-modal ${tone}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rcDialogTitle', tabindex: '-1' }, [
      h('div', { class: 'rc-modal-head' }, [icon(titleIcon), h('h3', { id: 'rcDialogTitle', text: title })]),
      h('div', { class: 'rc-modal-body' }, content),
      h('div', { class: 'rc-modal-actions' }, buttons)
    ])
  ]);
}

const btn = (text, cls, onclick, iconName, props = {}) =>
  h('button', { class: `rc-btn ${cls}`, type: 'button', onclick, ...props }, [iconName ? icon(iconName) : null, text]);

function progressView(dialog, simulated, label) {
  const pct = Math.round(dialog.progress.percent || 0);
  return [
    h('div', { class: 'rc-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': label }, [
      h('div', { class: 'rc-progress-fill', style: `width:${pct}%` })
    ]),
    h('div', { class: 'rc-progress-info' }, [h('span', { text: dialog.progress.step || 'Processando…' }), h('strong', { text: `${pct}%` })]),
    simulated ? simNote() : null
  ];
}

function restoreDialog({ state, actions, simulated }) {
  const { dialog, details, project, validation, createBackup } = state;
  const risk = (validation && validation.risk) || details.risk;

  if (dialog.phase === 'progress') {
    return shell('restore', 'sync', 'Restaurando estado…', progressView(dialog, simulated, 'Progresso da restauração'),
      [btn('Aguarde…', 'rc-btn-secondary', null, null, { disabled: true })]);
  }

  if (dialog.phase === 'done') {
    const r = dialog.result || {};
    return shell('restore', 'check_circle', 'Restauração concluída', [
      h('div', { class: 'rc-result rc-result-ok' }, [
        icon('task_alt'),
        h('div', {}, [
          h('strong', { text: r.message || 'Estado restaurado com sucesso.' }),
          h('span', { class: 'rc-muted', text: `Estado de ${formatDateTime(details.timestamp)} (${SOURCE_LABEL[details.source] || details.source}).` }),
          r.backupCreated ? h('span', { class: 'rc-muted', text: 'Uma cópia do estado anterior foi criada.' }) : null
        ])
      ]),
      simulated ? h('p', { class: 'rc-sim-note' }, [icon('science'), 'Simulação: nenhum arquivo foi alterado.']) : null
    ], [btn('Fechar', 'rc-btn-primary', actions.closeDialog, 'check', { 'data-autofocus': '' })], 'rc-modal-ok');
  }

  if (dialog.phase === 'error') {
    return shell('restore', 'error', 'Falha na restauração', [
      h('div', { class: 'rc-result rc-result-error', role: 'alert' }, [
        icon('report'),
        h('div', {}, [h('strong', { text: 'Não foi possível concluir a restauração.' }), h('span', { text: dialog.error || 'Erro desconhecido.' })])
      ])
    ], [
      btn('Fechar', 'rc-btn-secondary', actions.closeDialog),
      btn('Tentar novamente', 'rc-btn-primary', actions.retryRestore, 'refresh', { 'data-autofocus': '' })
    ], 'rc-modal-error');
  }

  // confirm
  const restorable = details.contents.filter((c) => c.restorable);
  const skipped = details.contents.filter((c) => !c.restorable);
  return shell('restore', 'restore', 'Restaurar este estado?', [
    h('p', { class: 'rc-warning', role: 'alert' }, [icon('warning'), 'Restaurar este estado substituirá o estado atual do projeto.']),
    h('div', { class: 'rc-summary' }, [
      h('div', { class: 'rc-summary-col' }, [
        h('span', { class: 'rc-field-label', text: 'Estado atual' }),
        h('strong', { text: project ? project.currentState : '—' }),
        h('span', { class: 'rc-muted', text: project ? formatDateTime(project.lastModified) : '' })
      ]),
      icon('arrow_forward', 'rc-summary-arrow'),
      h('div', { class: 'rc-summary-col' }, [
        h('span', { class: 'rc-field-label', text: 'Estado selecionado' }),
        h('strong', { text: formatDateTime(details.timestamp) }),
        h('span', { class: 'rc-muted', text: SOURCE_LABEL[details.source] || details.source })
      ])
    ]),
    RecoveryRiskIndicator({ risk, variant: 'full' }),
    h('div', { class: 'rc-section-title', text: 'SERÁ RESTAURADO' }),
    h('ul', { class: 'rc-chips' }, restorable.map((c) => h('li', { class: 'rc-chip-item' }, [icon(c.icon), `${c.label} · ${c.items}`]))),
    skipped.length
      ? h('p', { class: 'rc-muted rc-skipped', text: `Não restaurável neste estado: ${skipped.map((c) => c.label).join(', ')}.` })
      : null,
    h('p', { class: 'rc-backup-line' }, [icon(createBackup ? 'shield' : 'shield_question'), createBackup ? 'Uma cópia do estado atual será criada antes de restaurar.' : 'Nenhuma cópia do estado atual será criada.']),
    simulated ? simNote() : null
  ], [
    btn('Cancelar', 'rc-btn-secondary', actions.closeDialog, null, { 'data-autofocus': '' }),
    btn('Confirmar restauração', 'rc-btn-primary', actions.confirmRestore, 'restore')
  ]);
}

function deleteDialog({ state, actions, simulated }) {
  const { dialog, details } = state;
  const when = details ? formatDateTime(details.timestamp) : 'selecionado';

  if (dialog.phase === 'progress') {
    return shell('delete', 'delete', 'Excluindo…', [
      h('div', { class: 'rc-loading-inline', role: 'status' }, [h('span', { class: 'rc-spinner', 'aria-hidden': 'true' }), 'Excluindo estado de recuperação…'])
    ], [btn('Aguarde…', 'rc-btn-secondary', null, null, { disabled: true })]);
  }
  if (dialog.phase === 'error') {
    return shell('delete', 'error', 'Falha ao excluir', [
      h('div', { class: 'rc-result rc-result-error', role: 'alert' }, [icon('report'), h('div', {}, [h('strong', { text: 'Não foi possível excluir.' }), h('span', { text: dialog.error || 'Erro desconhecido.' })])])
    ], [btn('Fechar', 'rc-btn-secondary', actions.closeDialog, null, { 'data-autofocus': '' })], 'rc-modal-error');
  }
  return shell('delete', 'delete_forever', 'Excluir esta recuperação?', [
    h('p', { class: 'rc-warning', role: 'alert' }, [icon('warning'), `O estado de ${when} será removido da lista de recuperação. Esta ação não pode ser desfeita.`]),
    simulated ? simNote() : null
  ], [
    btn('Cancelar', 'rc-btn-secondary', actions.closeDialog, null, { 'data-autofocus': '' }),
    btn('Excluir recuperação', 'rc-btn-danger-solid', actions.confirmDelete, 'delete')
  ]);
}

export function RecoveryConfirmationDialog(props) {
  const { dialog, details } = props.state;
  if (dialog.kind === 'none') return null;
  if (dialog.kind === 'restore' && details) return restoreDialog(props);
  if (dialog.kind === 'delete') return deleteDialog(props);
  return null;
}
