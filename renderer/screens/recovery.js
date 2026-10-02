/**
 * RecoveryScreen — tela "Recuperação" (estados do projeto).
 *
 * Esta tela NÃO contém regra de negócio: ela só compõe os componentes de
 * renderer/components/recovery/ e os liga ao RecoveryController. A recuperação em si
 * (ler, validar, comparar, restaurar, excluir) é responsabilidade do RecoveryService; hoje
 * ele é um mock (dados fictícios, nada é alterado no disco). Para conectar os motores reais:
 *   import { setRecoveryService } from '../components/recovery/RecoveryService.js';
 *   setRecoveryService(meuMotor);   // deve cumprir o contrato descrito em RecoveryService.js
 *
 *   RecoveryScreen
 *   ├── RecoveryHeader
 *   ├── CurrentProjectStatus
 *   ├── RecoveryHistory ── RecoveryItem
 *   ├── RecoveryDetailsPanel ── RecoveryRiskIndicator, RecoveryComparison
 *   └── RecoveryConfirmationDialog
 */

import { createRecoveryController, getViewState, ViewState } from '../components/recovery/RecoveryController.js';
import { RecoveryHeader } from '../components/recovery/RecoveryHeader.js';
import { CurrentProjectStatus } from '../components/recovery/CurrentProjectStatus.js';
import { RecoveryHistory } from '../components/recovery/RecoveryHistory.js';
import { RecoveryDetailsPanel } from '../components/recovery/RecoveryDetailsPanel.js';
import { RecoveryConfirmationDialog } from '../components/recovery/RecoveryConfirmationDialog.js';
import { RecoveryLoadingState, RecoveryEmptyState, RecoveryErrorState } from '../components/recovery/RecoveryStates.js';
import { h, icon, clear } from '../components/recovery/recoveryUtils.js';

let controller = null;
let unsubscribe = null;
let onKeyDown = null;
let lastDialogKey = 'none';
let returnFocusTo = null;

const $ = (id) => document.getElementById(id);

function renderNotice(state, actions) {
  const mount = $('rcNotice');
  clear(mount);
  if (!state.notice) return;
  mount.append(h('div', { class: `rc-notice rc-notice-${state.notice.type}`, role: 'status' }, [
    icon(state.notice.type === 'success' ? 'check_circle' : 'error'),
    h('span', { text: state.notice.text }),
    h('button', { class: 'rc-icon-btn', type: 'button', 'aria-label': 'Dispensar aviso', onclick: actions.dismissNotice }, [icon('close')])
  ]));
}

function renderMain(state, actions) {
  const mount = $('rcMain');
  const keepList = mount.querySelector('.rc-list')?.scrollTop || 0;
  const keepDetails = mount.querySelector('.rc-details-scroll')?.scrollTop || 0;
  clear(mount);

  if (state.phase === 'loading' && !state.items.length) { mount.append(RecoveryLoadingState()); return; }
  if (state.phase === 'error') { mount.append(RecoveryErrorState({ message: state.error, onRetry: actions.load })); return; }

  const status = CurrentProjectStatus({ project: state.project });
  if (!state.items.length) {
    mount.append(h('div', { class: 'rc-single' }, [status, RecoveryEmptyState()]));
    return;
  }

  const hasSelection = !!state.selectedId;
  const layout = h('div', { class: `rc-layout${hasSelection ? ' has-selection' : ''}` }, [
    h('div', { class: 'rc-col rc-col-main' }, [
      status,
      RecoveryHistory({ items: state.items, selectedId: state.selectedId, onSelect: actions.select })
    ]),
    h('div', { class: 'rc-col rc-col-side' }, [
      // Em janelas estreitas o painel vira uma folha inferior; o fundo clicável fecha a folha.
      hasSelection ? h('div', { class: 'rc-scrim', onclick: actions.clearSelection }) : null,
      RecoveryDetailsPanel({ state, actions })
    ])
  ]);
  mount.append(layout);

  const list = mount.querySelector('.rc-list');
  if (list) list.scrollTop = keepList;
  const details = mount.querySelector('.rc-details-scroll');
  if (details) details.scrollTop = keepDetails;
}

function renderDialog(state, actions) {
  const mount = $('rcDialog');
  clear(mount);
  const dialog = RecoveryConfirmationDialog({ state, actions, simulated: !!controller.simulation() });
  const key = dialog ? `${state.dialog.kind}:${state.dialog.phase}` : 'none';

  if (dialog) {
    mount.append(dialog);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) actions.closeDialog(); });
    if (key !== lastDialogKey) {
      if (lastDialogKey === 'none') returnFocusTo = document.activeElement;
      (dialog.querySelector('[data-autofocus]') || dialog.querySelector('.rc-modal'))?.focus();
    }
  } else if (lastDialogKey !== 'none' && returnFocusTo && document.contains(returnFocusTo)) {
    returnFocusTo.focus();
    returnFocusTo = null;
  }
  lastDialogKey = key;
}

function render(state) {
  const actions = controller.actions;
  const header = $('rcHeader');
  if (!header) return; // tela já foi descartada

  clear(header).append(RecoveryHeader({
    systemStatus: state.project ? state.project.systemStatus : null,
    simulation: controller.simulation(),
    onScenarioChange: actions.setScenario,
    onFailToggle: actions.setFailNextRestore
  }));
  renderNotice(state, actions);
  renderMain(state, actions);
  renderDialog(state, actions);

  $('rcRoot').dataset.view = getViewState(state);
}

function handleKeys(e) {
  if (!controller) return;
  const state = controller.getState();
  const dialog = document.querySelector('#rcDialog .rc-modal');

  if (e.key === 'Escape') {
    if (dialog) { e.preventDefault(); controller.actions.closeDialog(); }
    else if (state.selectedId && !e.target.closest?.('input, select, textarea')) controller.actions.clearSelection();
    return;
  }
  // Mantém o foco dentro do modal enquanto ele estiver aberto
  if (e.key === 'Tab' && dialog) {
    const focusable = [...dialog.querySelectorAll('button:not(:disabled), input, [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) { e.preventDefault(); dialog.focus(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

export function initScreen() {
  lastDialogKey = 'none';
  returnFocusTo = null;
  controller = createRecoveryController();
  unsubscribe = controller.subscribe(render);
  onKeyDown = handleKeys;
  document.addEventListener('keydown', onKeyDown);
  render(controller.getState());
  controller.actions.load();
}

export function onLeave() {
  if (unsubscribe) unsubscribe();
  if (controller) controller.destroy();
  if (onKeyDown) document.removeEventListener('keydown', onKeyDown);
  controller = null; unsubscribe = null; onKeyDown = null;
}

// Exportado para facilitar testes e uso por outras telas
export { ViewState };
