/**
 * Aba Entrega e exportação: o que entregar (situação, prazo, lista de itens), para onde, observações e as exportações.
 * Tudo salva sozinho (sem botão "Salvar"): marcar um item ou trocar a situação grava na hora; textos gravam ao parar
 * de digitar. O indicador "Salvo" fica na barra de abas.
 */
import { ws, $, mk, icon, setAppStatus, friendlyError, debounce, autosave, emitChange } from './state.js';

let draft = null;
let pending = false;
const saveSoon = debounce(() => save(), 700);

/** Liga os eventos aos elementos desta abertura (a tela é recriada a cada projeto aberto). */
export function bindDelivery() {
  draft = null;
  pending = false;
  $('wsDeliveryStatus')?.addEventListener('change', () => change(true));
  $('wsDeliveryDeadline')?.addEventListener('change', () => change(true));
  $('wsDeliveryNotes')?.addEventListener('input', () => change(false));
  $('wsDeliveryNotes')?.addEventListener('blur', () => { if (pending) save(); });
  $('wsDeliveryAddItem')?.addEventListener('click', addItem);
  $('wsDeliveryNewItem')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });

  $('wsExportBinsXml')?.addEventListener('click', () => exportXmeml('bins'));
  $('wsExportMulticamXml')?.addEventListener('click', () => exportXmeml('multicam'));
  $('wsExportBdspro')?.addEventListener('click', exportBdspro);
  $('wsExportInfo')?.addEventListener('click', exportInfo);
}

/** Grava o que estiver pendente (ao sair da tela, por exemplo). */
export function flushDelivery() { if (pending) return save(); return null; }

export async function renderDelivery() {
  try { draft = await window.bds.getProjectDelivery(ws.projectId); }
  catch (e) { console.error('[WORKSPACE] entrega:', e); return; }
  pending = false;
  $('wsDeliveryStatus').value = draft.status;
  $('wsDeliveryDeadline').value = draft.deadline ? String(draft.deadline).slice(0, 10) : '';
  $('wsDeliveryNotes').value = draft.notes || '';
  renderLists();
  renderExportOptions();
}

/** Algo mudou: grava já (escolhas) ou logo depois de parar de digitar (texto). */
function change(now) {
  pending = true;
  if (now) save(); else saveSoon();
}

function renderLists() {
  const items = $('wsDeliveryItems'); const dests = $('wsDeliveryDestinations');
  if (!items || !dests || !draft) return;
  items.textContent = ''; dests.textContent = '';
  if (!draft.items.length) items.append(mk('li', { class: 'ws-empty-line', text: 'Liste o que vai ser entregue: vídeo principal, teaser, fotos…' }));
  draft.items.forEach((it, i) => {
    const cb = mk('input', { type: 'checkbox', checked: it.done, 'aria-label': it.label, onchange: (e) => { draft.items[i].done = e.target.checked; renderProgress(); change(true); } });
    items.append(mk('li', { class: 'ws-check-item' }, [
      mk('label', {}, [cb, mk('span', { text: it.label })]),
      mk('button', { type: 'button', class: 'ws-icon-btn', title: 'Remover item', 'aria-label': `Remover ${it.label}`, onclick: () => { draft.items.splice(i, 1); renderLists(); change(true); } }, [icon('close')])
    ]));
  });
  draft.destinations.forEach((d, i) => {
    const cb = mk('input', { type: 'checkbox', checked: d.checked, 'aria-label': d.label, onchange: (e) => { draft.destinations[i].checked = e.target.checked; change(true); } });
    dests.append(mk('li', { class: 'ws-check-item' }, [mk('label', {}, [cb, mk('span', { text: d.label })])]));
  });
  renderProgress();
}

function renderProgress() {
  if (!draft) return;
  const done = draft.items.filter((i) => i.done).length;
  const p = $('wsDeliveryProgress');
  if (p) { p.style.width = `${draft.items.length ? Math.round((done / draft.items.length) * 100) : 0}%`; }
  const t = $('wsDeliveryProgressText');
  if (t) t.textContent = draft.items.length ? `${done} de ${draft.items.length} itens prontos` : 'Sem itens';
}

function addItem() {
  const input = $('wsDeliveryNewItem');
  const label = input.value.trim().slice(0, 80);
  if (!label || !draft) return;
  if (draft.items.length >= 30) { window.bdsModal.alert('Limite de 30 itens na entrega.'); return; }
  draft.items.push({ label, done: false });
  input.value = '';
  renderLists();
  change(true);
}

async function save() {
  if (!draft || !pending) return;
  pending = false;
  const r = await autosave(() => window.bds.setProjectDelivery(ws.projectId, {
    status: $('wsDeliveryStatus').value, deadline: $('wsDeliveryDeadline').value || '',
    items: draft.items, destinations: draft.destinations, notes: $('wsDeliveryNotes').value.trim()
  }));
  if (r === null) { pending = true; return; }
  if (r && Array.isArray(r.items)) { draft = { ...r, notes: draft.notes }; }
  emitChange('delivery');
}

// ------------------------------------------------------------------ exportações

function renderExportOptions() {
  const sel = $('wsExportSyncGroup');
  if (!sel) return;
  sel.textContent = '';
  for (const g of ws.syncGroups) sel.append(mk('option', { value: String(g.id), text: g.name }));
  const has = ws.syncGroups.length > 0;
  sel.disabled = !has;
  const btn = $('wsExportMulticamXml');
  if (btn) btn.disabled = !has;
  const hint = $('wsExportMulticamHint');
  if (hint) hint.textContent = has ? 'Uma camada de vídeo e um par de trilhas de áudio por câmera, com os clipes já encaixados.' : 'Sincronize as câmeras (aba Sincronizar câmeras) para liberar esta exportação.';
}

async function exportXmeml(mode) {
  try {
    const groupId = mode === 'multicam' ? Number($('wsExportSyncGroup')?.value) : undefined;
    setAppStatus('Gerando XML…', 'info');
    const r = await window.bds.exportProjectXmeml(ws.projectId, mode === 'multicam' ? { mode, groupId } : { mode });
    if (!r) { setAppStatus('Exportação cancelada.', 'info'); return; }
    setAppStatus('XML exportado.', 'success');
    window.bdsModal.alert(`XML exportado.\n\n${r.filePath}${mode === 'multicam' ? `\n\n${r.videoTracks} camadas de vídeo, ${r.audioTracks} trilhas de áudio, ${r.clips} clipes.` : `\n\n${r.clips} clipes nas pastas.`}\n\nNo Premiere: Arquivo → Importar e escolha este XML.`);
  } catch (e) { window.bdsModal.alert(`Não foi possível exportar: ${friendlyError(e)}`); }
}

async function exportBdspro() {
  try {
    const folder = await window.bds.selectFolder();
    const dest = Array.isArray(folder) ? folder[0] : folder;
    if (!dest) return;
    setAppStatus('Exportando .bdspro…', 'info');
    const r = await window.bds.exportBdspro(ws.projectId, { folder: dest, name: ws.project.name });
    if (r && r.success) { setAppStatus('Pacote .bdspro exportado.', 'success'); window.bdsModal.alert(`Pacote .bdspro exportado.\n\n${r.filePath}`); }
  } catch (e) { window.bdsModal.alert(`Não foi possível exportar o pacote: ${friendlyError(e)}`); }
}

async function exportInfo() {
  try {
    const r = await window.bds.exportProjectInfo(ws.projectId);
    if (r && r.filePath) setAppStatus('Informações do projeto exportadas.', 'success');
  } catch (e) { window.bdsModal.alert(`Não foi possível exportar as informações: ${friendlyError(e)}`); }
}
