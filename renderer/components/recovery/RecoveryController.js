/**
 * RecoveryController — estado e fluxo da tela Recuperação (o "hook" do plano).
 *
 *   RecoveryScreen → RecoveryController → RecoveryService → motores futuros
 *
 * A tela só lê `getState()`, chama as ações e se inscreve em `subscribe()`. Toda a
 * comunicação com os motores passa pelo RecoveryService; este arquivo não conhece
 * nenhum detalhe de como a recuperação é feita.
 */

import { getRecoveryService } from './RecoveryService.js';

/** As situações visíveis da tela (1–7 do escopo). */
export const ViewState = Object.freeze({
  LOADING: 'loading',
  EMPTY: 'empty',            // 1 — sem recuperação
  AVAILABLE: 'available',    // 2 — recuperação disponível
  SELECTED: 'selected',      // 3 — estado selecionado
  CONFIRMING: 'confirming',  // 4 — confirmação de restauração
  RESTORING: 'restoring',    // 5 — recuperação simulada (progresso)
  DONE: 'done',              // 6 — recuperação concluída
  ERROR: 'error'             // 7 — erro
});

/** Deriva a situação visível a partir do estado do controller. */
export function getViewState(state) {
  const d = state.dialog;
  if (d.kind === 'restore') {
    if (d.phase === 'confirm') return ViewState.CONFIRMING;
    if (d.phase === 'progress') return ViewState.RESTORING;
    if (d.phase === 'done') return ViewState.DONE;
    if (d.phase === 'error') return ViewState.ERROR;
  }
  if (state.phase === 'loading') return ViewState.LOADING;
  if (state.phase === 'error') return ViewState.ERROR;
  if (!state.items.length) return ViewState.EMPTY;
  return state.selectedId ? ViewState.SELECTED : ViewState.AVAILABLE;
}

const CLOSED_DIALOG = { kind: 'none', phase: 'confirm', progress: { percent: 0, step: '' }, result: null, error: null };

function initialState() {
  return {
    phase: 'loading',          // 'loading' | 'ready' | 'error'
    error: null,
    project: null,
    items: [],
    selectedId: null,
    details: null,
    comparison: null,
    validation: null,
    detailsLoading: false,
    tab: 'details',            // 'details' | 'compare'
    createBackup: true,
    dialog: { ...CLOSED_DIALOG },
    notice: null               // { type: 'success'|'error', text }
  };
}

export function createRecoveryController(service = getRecoveryService()) {
  let state = initialState();
  const listeners = new Set();
  let selectToken = 0;         // descarta respostas antigas ao trocar de seleção rapidamente
  let destroyed = false;

  const notify = () => { if (!destroyed) listeners.forEach((fn) => fn(state)); };
  const set = (patch) => { state = { ...state, ...patch }; notify(); };
  const setDialog = (patch) => set({ dialog: { ...state.dialog, ...patch } });
  const messageOf = (err) => (err && err.message) || 'Ocorreu um erro inesperado.';

  async function load() {
    set({ phase: 'loading', error: null });
    try {
      const [project, items] = await Promise.all([service.getProjectStatus(), service.getAvailableRecoveries()]);
      const stillThere = items.some((i) => i.id === state.selectedId);
      set({ phase: 'ready', project, items, ...(stillThere ? {} : { selectedId: null, details: null, comparison: null, validation: null }) });
    } catch (err) {
      set({ phase: 'error', error: messageOf(err), project: null, items: [], selectedId: null });
    }
  }

  /** Recarrega sem voltar ao estado "carregando" (usado após restaurar/excluir). */
  async function refresh() {
    try {
      const [project, items] = await Promise.all([service.getProjectStatus(), service.getAvailableRecoveries()]);
      const stillThere = items.some((i) => i.id === state.selectedId);
      set({ project, items, ...(stillThere ? {} : { selectedId: null, details: null, comparison: null, validation: null }) });
    } catch (err) {
      set({ phase: 'error', error: messageOf(err) });
    }
  }

  async function select(id) {
    if (!id || id === state.selectedId) return;
    const token = ++selectToken;
    set({ selectedId: id, details: null, comparison: null, validation: null, detailsLoading: true, tab: 'details', notice: null });
    try {
      const [details, comparison, validation] = await Promise.all([
        service.getRecoveryDetails(id), service.compareRecovery(id), service.validateRecovery(id)
      ]);
      if (token !== selectToken) return;
      set({ details, comparison, validation, detailsLoading: false });
    } catch (err) {
      if (token !== selectToken) return;
      set({ detailsLoading: false, notice: { type: 'error', text: messageOf(err) } });
    }
  }

  function clearSelection() {
    selectToken++;
    set({ selectedId: null, details: null, comparison: null, validation: null, detailsLoading: false });
  }

  // ---- Restauração -------------------------------------------------------------------------

  function openRestore() {
    if (!state.selectedId || !state.details) return;
    set({ dialog: { ...CLOSED_DIALOG, kind: 'restore', phase: 'confirm' } });
  }

  async function confirmRestore() {
    if (state.dialog.kind !== 'restore' || state.dialog.phase === 'progress') return;
    setDialog({ phase: 'progress', progress: { percent: 0, step: 'Iniciando…' }, error: null });
    try {
      const result = await service.restoreRecovery(
        state.selectedId,
        { createBackup: state.createBackup },
        (progress) => setDialog({ progress })
      );
      setDialog({ phase: 'done', result, progress: { percent: 100, step: 'Concluído' } });
      refresh();
    } catch (err) {
      setDialog({ phase: 'error', error: messageOf(err) });
    }
  }

  // ---- Exclusão ----------------------------------------------------------------------------

  function openDelete() {
    if (!state.selectedId) return;
    set({ dialog: { ...CLOSED_DIALOG, kind: 'delete', phase: 'confirm' } });
  }

  async function confirmDelete() {
    if (state.dialog.kind !== 'delete' || state.dialog.phase === 'progress') return;
    const id = state.selectedId;
    setDialog({ phase: 'progress' });
    try {
      await service.deleteRecovery(id);
      set({ dialog: { ...CLOSED_DIALOG }, notice: { type: 'success', text: 'Estado de recuperação excluído.' } });
      clearSelection();
      await refresh();
    } catch (err) {
      setDialog({ phase: 'error', error: messageOf(err) });
    }
  }

  function closeDialog() {
    if (state.dialog.phase === 'progress') return; // não interrompe uma operação em andamento
    set({ dialog: { ...CLOSED_DIALOG } });
  }

  // ---- Interface ---------------------------------------------------------------------------

  const setTab = (tab) => { if (tab === 'details' || tab === 'compare') set({ tab }); };
  const setCreateBackup = (value) => set({ createBackup: !!value });
  const dismissNotice = () => set({ notice: null });

  // ---- Simulação (só existe quando o serviço é o mock) -------------------------------------

  const isSimulation = () => !!service.isMock;

  async function setScenario(name) {
    if (!isSimulation()) return;
    service.setScenario(name);
    state = { ...state, selectedId: null, details: null, comparison: null, validation: null, notice: null, dialog: { ...CLOSED_DIALOG } };
    await load();
  }

  function setFailNextRestore(value) {
    if (isSimulation()) { service.failNextRestore = !!value; notify(); }
  }

  return {
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    destroy() { destroyed = true; listeners.clear(); },
    simulation: () => (isSimulation() ? { scenario: service.scenario, failNextRestore: !!service.failNextRestore } : null),
    actions: {
      load, select, clearSelection, setTab, setCreateBackup, dismissNotice,
      openRestore, confirmRestore, openDelete, confirmDelete, closeDialog,
      retryRestore: confirmRestore, setScenario, setFailNextRestore
    }
  };
}
