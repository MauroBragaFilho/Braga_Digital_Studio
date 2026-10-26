/**
 * Área interna de um projeto (.docs/BDS_TELA_PROJETOS.md): cabeçalho (capa, nome editável, cliente, entrega, status,
 * "Editar detalhes" e a ação principal "Adicionar arquivos") e quatro áreas — Visão geral (próximos passos,
 * observações, equipamentos, atividade), Arquivos, Sincronizar câmeras e Entrega e exportação. Tudo salva sozinho,
 * com o indicador "Salvo" na barra de abas. Cada área é um módulo em ./workspace/; o estado compartilhado fica em
 * ./workspace/state.js.
 */
import { setContextProvider } from '../utils/assistantContext.js';
import { enhanceModals } from '../utils/modal.js';
import { normalizeStatus } from '../utils/projectStatus.js';
import {
  ws, $, reloadMedia, reloadSyncGroups, reloadMissing, onChange, clearListeners, emitChange,
  toFileUrl, formatLocalDate, setAppStatus, friendlyError, autosave, hideMenu
} from './workspace/state.js';
import { bindOverview, renderOverview, flushOverview } from './workspace/overview.js';
import { bindFiles, renderFiles, openAddMenu, selectAllVisible } from './workspace/files.js';
import { bindMonitor, closeMonitor, monitorKey, monitorOpen } from './workspace/monitor.js';
import { bindAudio, unbindAudio, renderAudio } from './workspace/audio.js';
import { bindDevices } from './workspace/devices.js';
import { bindDelivery, renderDelivery, flushDelivery } from './workspace/delivery.js';

const TABS = ['overview', 'files', 'audio', 'delivery'];
const DEFAULT_COLOR = '#3b82f6';
let unsubChange = null;
let onOutside = null;
let editCover = '';

export async function initScreen() {
  try {
    const app = await import('../app.js');
    ws.projectId = app.state.currentProjectId;
    if (!ws.projectId) return goBack();
    // Assistente de IA: o projeto aberto entra no contexto da tela (só o id); removido em onLeave
    setContextProvider('workspaceProject', () => ws.projectId);
    try { ws.thumbsBase = toFileUrl(await window.bds.getThumbDir()); } catch (_) { ws.thumbsBase = ''; }

    ws.project = await window.bds.getProject(ws.projectId);
    if (!ws.project) return goBack();
    // Estado da abertura anterior (outro projeto) não pode vazar para esta
    ws.tab = 'overview'; ws.currentBin = 'all'; ws.query = ''; ws.typeFilter = 'all'; ws.selected = new Set(); ws.inspected = null;
    await Promise.all([reloadMedia(), reloadSyncGroups(), reloadMissing()]);

    renderHeader();
    bindHeader();
    bindOverview(switchTab, { onAddFiles: (anchor) => addFiles(anchor) });
    bindFiles(switchTab);
    bindMonitor();
    bindAudio(switchTab);
    bindDevices();
    bindDelivery();
    enhanceModals($('project_workspaceView') || document, '.ws-modal-overlay');

    clearListeners();
    unsubChange = onChange((what) => {
      // dados mudaram numa aba: o cabeçalho e os próximos passos acompanham
      if (what === 'media' || what === 'sync') renderHeaderCounts();
      if ((what === 'media' || what === 'sync' || what === 'delivery') && ws.tab === 'overview') renderOverview();
    });
    switchTab('overview');
  } catch (e) {
    console.error('[WORKSPACE] Erro na inicialização:', e);
    setAppStatus('Erro ao abrir o projeto.', 'error');
  }
}

export async function onEnter() {
  if (!ws.projectId) return;
  try {
    ws.project = (await window.bds.getProject(ws.projectId)) || ws.project;
    await Promise.all([reloadMedia(), reloadSyncGroups(), reloadMissing()]);
    renderHeader();
    switchTab(ws.tab);
  } catch (e) { console.error('[WORKSPACE] onEnter:', e); }
}

export function onLeave() {
  // o que estava sendo digitado não se perde ao sair
  try { flushOverview(); flushDelivery(); } catch (_) { /* noop */ }
  closeMonitor();
  hideMenu();
  unbindAudio();
  if (unsubChange) { unsubChange(); unsubChange = null; }
  if (onOutside) { document.removeEventListener('pointerdown', onOutside, true); onOutside = null; }
  setContextProvider('workspaceProject', null);
}

export function onKeyDown(e) {
  if (monitorKey(e)) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target && e.target.tagName ? e.target.tagName : '') || (e.target && e.target.isContentEditable);
  const modalOpen = !!document.querySelector('.ws-modal-overlay:not(.hidden)');
  // Ctrl+A em Arquivos: seleciona todos os arquivos visíveis (fora de campos de texto e de janelas)
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 'a' && ws.tab === 'files' && !typing && !modalOpen) {
    e.preventDefault();
    selectAllVisible();
    return;
  }
  if (e.key === 'Escape') {
    if (!$('wsMenu')?.classList.contains('hidden')) { hideMenu(); return; }
    // "Em qual pasta colocar?": Esc é o mesmo que Cancelar (encerra a importação que esperava a resposta)
    if (!$('wsPickBinModal')?.classList.contains('hidden')) { $('wsPickBinCancel')?.click(); return; }
    const open = document.querySelector('.ws-modal-overlay:not(.hidden)');
    if (open) open.classList.add('hidden');
  }
}

function goBack() {
  closeMonitor();
  import('../app.js').then((app) => {
    app.state.currentProjectId = null;
    document.querySelector('.sidebar .tab-button[data-view="projects"]')?.click();
  });
}

// ------------------------------------------------------------------ cabeçalho

const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '');

function renderHeader() {
  const p = ws.project;
  $('wsProjectName').textContent = p.name;
  // A barra superior do app mostra a seção; o nome do projeto já é o título deste cabeçalho (não repete)
  const title = document.getElementById('globalPageTitle');
  if (title) title.textContent = 'Projetos';
  $('wsHeaderClient').textContent = p.client || '';
  $('wsHeaderType').textContent = p.type || '';
  $('wsHeaderDeadline').textContent = p.deadline ? `Entrega ${formatLocalDate(p.deadline)}` : '';
  const sel = $('wsProjectStatus');
  if (sel) { sel.value = normalizeStatus(p.status); sel.dataset.status = sel.value; }
  const cover = $('wsCoverImg');
  if (cover) {
    if (p.cover_path) { cover.style.backgroundImage = `url("${toFileUrl(p.cover_path)}")`; cover.classList.remove('empty'); }
    else { cover.style.backgroundImage = 'none'; cover.classList.add('empty'); }
  }
  const stripe = $('wsHeaderColor');
  if (stripe) stripe.style.background = safeColor(p.color) || 'transparent';
  renderHeaderCounts();
}

function renderHeaderCounts() {
  const n = ws.media.length;
  const c = $('wsHeaderCount');
  if (c) c.textContent = `${n} ${n === 1 ? 'arquivo' : 'arquivos'}${ws.missing.length ? ` · ${ws.missing.length} ${ws.missing.length === 1 ? 'ausente' : 'ausentes'}` : ''}`;
  const t = $('wsTabFilesCount');
  if (t) t.textContent = n ? String(n) : '';
}

/** Liga os eventos do cabeçalho aos elementos desta abertura (a tela é recriada a cada projeto aberto). */
function bindHeader() {
  $('wsBtnBack')?.addEventListener('click', goBack);
  $('wsCoverWrapper')?.addEventListener('click', pickCover);
  $('wsCoverWrapper')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickCover(); } });
  $('wsBtnRename')?.addEventListener('click', rename);
  $('wsBtnEditDetails')?.addEventListener('click', openEdit);
  $('wsBtnAddFiles')?.addEventListener('click', (e) => { e.stopPropagation(); addFiles(e.currentTarget); });
  $('wsProjectStatus')?.addEventListener('change', async (e) => {
    const sel = e.currentTarget; // guardado antes do await (o evento não vale depois)
    const value = sel.value;
    const ok = await autosave(() => window.bds.updateProject(ws.projectId, { status: value }));
    if (ok === null) { sel.value = normalizeStatus(ws.project.status); return; }
    ws.project.status = value;
    sel.dataset.status = value;
    emitChange('project');
  });
  document.querySelectorAll('.ws-proj-tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.projTab)));
  // janela de detalhes
  $('wsEditClose')?.addEventListener('click', closeEdit);
  $('wsEditCancel')?.addEventListener('click', closeEdit);
  $('wsEditSave')?.addEventListener('click', saveEdit);
  $('wsEditName')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveEdit(); });
  $('wsEditCoverPick')?.addEventListener('click', async () => { const fp = await chooseImage(); if (fp) { editCover = fp; renderEditCover(); } });
  $('wsEditCoverClear')?.addEventListener('click', () => { editCover = ''; renderEditCover(); });
  // menu: fecha ao clicar fora
  onOutside = (e) => { const m = $('wsMenu'); if (m && !m.classList.contains('hidden') && !m.contains(e.target)) hideMenu(); };
  document.addEventListener('pointerdown', onOutside, true);
}

/** "Adicionar arquivos": vai para Arquivos e abre as opções junto do botão clicado. */
function addFiles(anchor) {
  if (ws.tab !== 'files') switchTab('files');
  openAddMenu(anchor || $('wsBtnAddMenu'));
}

async function chooseImage() {
  const result = await window.bds.selectFile({ properties: ['openFile'], filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
  return Array.isArray(result) ? result[0] : result;
}

async function pickCover() {
  try {
    const fp = await chooseImage();
    if (!fp) return;
    const ok = await autosave(() => window.bds.updateProject(ws.projectId, { cover_path: fp }));
    if (ok === null) return;
    ws.project.cover_path = fp;
    renderHeader();
  } catch (e) { window.bdsModal.alert(`Não foi possível trocar a capa: ${friendlyError(e)}`); }
}

async function rename() {
  const name = await window.bdsModal.prompt('Nome do projeto:', ws.project.name);
  if (name === null || !String(name).trim() || String(name).trim() === ws.project.name) return;
  const value = String(name).trim().slice(0, 200);
  const ok = await autosave(() => window.bds.updateProject(ws.projectId, { name: value }));
  if (ok === null) return;
  ws.project.name = value;
  renderHeader();
  emitChange('project');
}

function openEdit() {
  const p = ws.project;
  $('wsEditName').value = p.name || '';
  $('wsEditClient').value = p.client || '';
  $('wsEditType').value = p.type || '';
  $('wsEditStart').value = p.start_date ? String(p.start_date).slice(0, 10) : '';
  $('wsEditDeadline').value = p.deadline ? String(p.deadline).slice(0, 10) : '';
  $('wsEditColor').value = safeColor(p.color) || DEFAULT_COLOR;
  editCover = p.cover_path || '';
  renderEditCover();
  $('wsEditModal').classList.remove('hidden');
  setTimeout(() => { try { $('wsEditName')?.focus(); } catch (_) { /* tela já fechada */ } }, 50);
}
function closeEdit() { $('wsEditModal')?.classList.add('hidden'); }
function renderEditCover() {
  const pick = $('wsEditCoverPick');
  if (pick) pick.textContent = editCover ? 'Trocar capa' : 'Escolher capa';
  $('wsEditCoverClear')?.classList.toggle('hidden', !editCover);
}

async function saveEdit() {
  const name = $('wsEditName').value.trim();
  if (!name) { window.bdsModal.alert('O nome do projeto é obrigatório.'); $('wsEditName').focus(); return; }
  const data = {
    name: name.slice(0, 200),
    client: $('wsEditClient').value.trim(),
    type: $('wsEditType').value.trim(),
    start_date: $('wsEditStart').value || null,
    deadline: $('wsEditDeadline').value || null,
    color: safeColor($('wsEditColor').value) || DEFAULT_COLOR,
    cover_path: editCover || ''
  };
  const ok = await autosave(() => window.bds.updateProject(ws.projectId, data));
  if (ok === null) return;
  Object.assign(ws.project, data);
  closeEdit();
  renderHeader();
  emitChange('project');
}

// ------------------------------------------------------------------ abas

function switchTab(tab) {
  if (!TABS.includes(tab)) tab = 'overview';
  ws.tab = tab;
  if (monitorOpen()) closeMonitor();
  hideMenu();
  document.querySelectorAll('.ws-proj-tab').forEach((b) => { const on = b.dataset.projTab === tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  document.querySelectorAll('[data-proj-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.projPanel !== tab));
  if (tab === 'overview') renderOverview();
  if (tab === 'files') renderFiles();
  if (tab === 'audio') renderAudio();
  if (tab === 'delivery') renderDelivery();
}
