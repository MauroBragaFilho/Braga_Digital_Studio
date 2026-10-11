/** Aba Visão geral: resumo, observações editáveis, entrega e atividade recente. */
import { ws, $, mk, icon, formatBytes, relativeWhen, formatLocalDate, setAppStatus, friendlyError } from './state.js';

let notesDirty = false;

/** Liga os eventos aos elementos desta abertura (a tela é recriada a cada projeto aberto). */
export function bindOverview(goTo) {
  notesDirty = false;
  $('wsOvNotes')?.addEventListener('input', () => { notesDirty = true; const b = $('wsOvSaveNotes'); if (b) b.disabled = false; });
  $('wsOvSaveNotes')?.addEventListener('click', saveNotes);
  $('wsOvGoDelivery')?.addEventListener('click', () => goTo('delivery'));
  $('wsOvGoFiles')?.addEventListener('click', () => goTo('files'));
  $('wsOvGoAudio')?.addEventListener('click', () => goTo('audio'));
}

export async function renderOverview() {
  try {
    const s = await window.bds.getProjectSummary(ws.projectId);
    const set = (id, v) => { const n = $(id); if (n) n.textContent = String(v); };
    set('wsOvVideos', s.videos); set('wsOvAudios', s.audios); set('wsOvPhotos', s.photos);
    set('wsOvSize', formatBytes(s.total_size)); set('wsOvTranscripts', s.transcripts); set('wsOvDevices', s.devices);
    const missing = $('wsOvMissing');
    if (missing) {
      missing.classList.toggle('hidden', !s.missing);
      missing.textContent = s.missing ? `${s.missing} ${s.missing === 1 ? 'arquivo não encontrado' : 'arquivos não encontrados'} — use "Localizar pasta" em Arquivos.` : '';
    }
    set('wsOvActivity', `Última atividade: ${relativeWhen(s.last_activity_at)}${s.last_activity ? ` · ${s.last_activity.message}` : ''}`);
    const d = s.delivery || {};
    set('wsOvDeliveryText', `Entrega: ${d.status || 'não iniciada'}${d.items ? ` · ${d.done}/${d.items} itens` : ''}${d.deadline ? ` · prazo ${formatLocalDate(d.deadline)}` : ''}`);
    const synced = ws.syncGroups.length;
    set('wsOvSync', synced ? `${synced} ${synced === 1 ? 'sincronização feita' : 'sincronizações feitas'}` : 'Nenhuma sincronização ainda');
  } catch (e) {
    console.error('[WORKSPACE] resumo:', e);
  }
  const notes = $('wsOvNotes');
  if (notes && !notesDirty) notes.value = ws.project.description || '';
  await renderActivity();
}

const ICONS = { criado: 'add_circle', editado: 'edit', status: 'flag', midia: 'perm_media', pasta: 'folder', dispositivo: 'devices', entrega: 'local_shipping', exportado: 'ios_share', importado: 'archive', sincronizado: 'graphic_eq', transcrito: 'subtitles', duplicado: 'content_copy' };

export async function renderActivity() {
  const list = $('wsActivityList');
  if (!list) return;
  list.textContent = '';
  try {
    const rows = await window.bds.listProjectActivity(ws.projectId, 30);
    if (!rows || !rows.length) { list.append(mk('li', { class: 'ws-empty-line', text: 'Nada registrado ainda.' })); return; }
    for (const a of rows) {
      list.append(mk('li', { class: 'ws-activity-item' }, [icon(ICONS[a.kind] || 'history'), mk('span', { class: 'ws-activity-msg', text: a.message }), mk('time', { class: 'ws-activity-when', text: relativeWhen(a.created_at) })]));
    }
  } catch (_) { list.append(mk('li', { class: 'ws-empty-line', text: 'Não foi possível ler a atividade.' })); }
}

async function saveNotes() {
  const notes = $('wsOvNotes');
  if (!notes) return;
  try {
    await window.bds.updateProject(ws.projectId, { description: notes.value.trim().slice(0, 2000) });
    ws.project.description = notes.value.trim();
    notesDirty = false;
    $('wsOvSaveNotes').disabled = true;
    setAppStatus('Observações salvas.', 'success');
    renderActivity();
  } catch (e) { window.bdsModal.alert(`Não foi possível salvar as observações: ${friendlyError(e)}`); }
}
