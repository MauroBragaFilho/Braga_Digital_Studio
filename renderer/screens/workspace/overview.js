/**
 * Aba Visão geral: "Próximos passos" (material → pastas por câmera → sincronizar → entregar, cada um com o estado e um
 * botão para o seguinte), resumo do material, observações que salvam sozinhas, equipamentos (devices.js) e atividade.
 */
import { ws, $, mk, icon, formatBytes, relativeWhen, debounce, autosave } from './state.js';
import { renderDevices } from './devices.js';
import { renderLuts } from './luts.js';

let goTo = () => {};
let addFiles = () => {};
let notesDirty = false;
let summary = null;

/** Liga os eventos aos elementos desta abertura (a tela é recriada a cada projeto aberto). */
export function bindOverview(navigate, { onAddFiles } = {}) {
  goTo = navigate;
  addFiles = onAddFiles || (() => navigate('files'));
  notesDirty = false;
  summary = null;
  const save = debounce(saveNotes, 900);
  $('wsOvNotes')?.addEventListener('input', () => { notesDirty = true; save(); });
  $('wsOvNotes')?.addEventListener('blur', () => { if (notesDirty) saveNotes(); });
}

/** Grava as observações pendentes (ao sair da tela, por exemplo). */
export function flushOverview() { if (notesDirty) return saveNotes(); return null; }

export async function renderOverview() {
  try {
    summary = await window.bds.getProjectSummary(ws.projectId);
    const set = (id, v) => { const n = $(id); if (n) n.textContent = String(v); };
    set('wsOvVideos', summary.videos); set('wsOvAudios', summary.audios); set('wsOvPhotos', summary.photos);
    set('wsOvSize', formatBytes(summary.total_size)); set('wsOvTranscripts', summary.transcripts);
    const missing = $('wsOvMissing');
    if (missing) {
      missing.classList.toggle('hidden', !summary.missing);
      missing.textContent = summary.missing ? `${summary.missing} ${summary.missing === 1 ? 'arquivo não foi encontrado' : 'arquivos não foram encontrados'} no disco. Em Arquivos, use "localizar" para reconectar.` : '';
    }
  } catch (e) {
    summary = null;
    console.error('[WORKSPACE] resumo:', e);
  }
  renderSteps();
  const notes = $('wsOvNotes');
  if (notes && !notesDirty) notes.value = ws.project.description || '';
  await Promise.all([renderDevices(), renderLuts(), renderActivity()]);
}

// ------------------------------------------------------------------ próximos passos

/** Pastas de 1º nível que têm vídeo ou áudio (cada uma é uma câmera/gravador para a sincronização). */
function cameraFolders() {
  const top = ws.bins.filter((b) => !b.parent_id);
  const under = (rootId) => { const ids = [rootId]; for (let i = 0; i < ids.length; i++) ids.push(...ws.bins.filter((b) => b.parent_id === ids[i]).map((b) => b.id)); return new Set(ids); };
  return top.filter((b) => { const ids = under(b.id); return ws.media.some((m) => ids.has(m.bin_id) && m.media_type !== 'photo' && m.media_type !== 'raw'); });
}

function steps() {
  const n = ws.media.length;
  const unfiled = ws.media.filter((m) => !m.bin_id).length;
  const cams = cameraFolders().length;
  const syncs = ws.syncGroups.length;
  const d = (summary && summary.delivery) || {};
  const delivered = d.status === 'Entregue';
  return [
    {
      id: 'media', title: 'Adicionar o material', done: n > 0,
      detail: n ? `${n} ${n === 1 ? 'arquivo' : 'arquivos'}` : 'Do computador, da Biblioteca ou arrastando para Arquivos',
      action: n ? null : { label: 'Adicionar arquivos', run: (btn) => addFiles(btn) }
    },
    {
      id: 'folders', title: 'Separar por câmera', done: n > 0 && ws.bins.length > 0 && unfiled === 0,
      detail: !n ? 'Uma pasta para cada câmera ou gravador' : unfiled ? `${unfiled} ${unfiled === 1 ? 'arquivo está' : 'arquivos estão'} sem pasta` : `${ws.bins.length} ${ws.bins.length === 1 ? 'pasta' : 'pastas'}`,
      action: { label: 'Organizar', run: () => goTo('files') }
    },
    {
      id: 'sync', title: 'Sincronizar as câmeras pelo áudio', done: syncs > 0, skip: !syncs && cams < 2,
      detail: syncs ? `${syncs} ${syncs === 1 ? 'sincronização feita' : 'sincronizações feitas'}` : cams < 2 ? 'Só é preciso com duas ou mais câmeras' : `${cams} câmeras prontas para sincronizar`,
      action: { label: syncs ? 'Ver' : 'Começar', run: () => goTo('audio') }
    },
    {
      id: 'delivery', title: 'Exportar e entregar', done: delivered,
      detail: `${d.status || 'Não iniciada'}${d.items ? ` · ${d.done}/${d.items} itens` : ''}`,
      detailId: 'wsOvDeliveryText',
      action: { label: 'Abrir', run: () => goTo('delivery') }
    }
  ];
}

function renderSteps() {
  const host = $('wsSteps');
  if (!host) return;
  host.textContent = '';
  const list = steps();
  const current = list.find((s) => !s.done && !s.skip);
  for (const s of list) {
    const state = s.done ? 'done' : s.skip ? 'skip' : s === current ? 'current' : 'todo';
    const btn = s.action && state !== 'skip'
      ? mk('button', { type: 'button', class: state === 'current' ? 'ws-btn-accent' : 'ws-btn-outline', onclick: (e) => s.action.run(e.currentTarget) }, s.action.label)
      : null;
    host.append(mk('li', { class: `ws-step is-${state}`, 'data-step': s.id }, [
      icon(s.done ? 'check_circle' : s.skip ? 'remove_circle_outline' : 'radio_button_unchecked'),
      mk('div', { class: 'ws-step-text' }, [mk('b', { text: s.title }), mk('span', { id: s.detailId || null, text: s.detail })]),
      state === 'done' && s.id !== 'delivery' ? null : btn
    ]));
  }
}

// ------------------------------------------------------------------ atividade e observações

const ICONS = { criado: 'add_circle', editado: 'edit', status: 'flag', midia: 'perm_media', pasta: 'folder', dispositivo: 'devices', entrega: 'local_shipping', exportado: 'ios_share', importado: 'archive', sincronizado: 'graphic_eq', transcrito: 'subtitles', duplicado: 'content_copy', lut: 'gradient' };

export async function renderActivity() {
  const list = $('wsActivityList');
  if (!list) return;
  list.textContent = '';
  try {
    const rows = await window.bds.listProjectActivity(ws.projectId, 12);
    if (!rows || !rows.length) { list.append(mk('li', { class: 'ws-empty-line', text: 'Nada registrado ainda.' })); return; }
    for (const a of rows) {
      list.append(mk('li', { class: 'ws-activity-item' }, [icon(ICONS[a.kind] || 'history'), mk('span', { class: 'ws-activity-msg', text: a.message }), mk('time', { class: 'ws-activity-when', text: relativeWhen(a.created_at) })]));
    }
  } catch (_) { list.append(mk('li', { class: 'ws-empty-line', text: 'Não foi possível ler a atividade.' })); }
}

async function saveNotes() {
  const notes = $('wsOvNotes');
  if (!notes || !notesDirty) return;
  const text = notes.value.trim().slice(0, 2000);
  notesDirty = false;
  const ok = await autosave(() => window.bds.updateProject(ws.projectId, { description: text }));
  if (ok === null) { notesDirty = true; return; }
  ws.project.description = text;
}
