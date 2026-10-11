/**
 * Área interna de um projeto (.docs/BDS_TELA_PROJETOS.md): cabeçalho (capa, nome, cliente, entrega, status) e
 * cinco áreas — Visão geral, Arquivos, Áudio (sincronização multicâmera), Dispositivos e Entrega (com as
 * exportações). Cada área é um módulo em ./workspace/; o estado compartilhado fica em ./workspace/state.js.
 */
import { setContextProvider } from '../utils/assistantContext.js';
import { enhanceModals } from '../utils/modal.js';
import { normalizeStatus } from '../utils/projectStatus.js';
import {
  ws, $, reloadMedia, reloadSyncGroups, reloadMissing, onChange, clearListeners, emitChange,
  toFileUrl, formatLocalDate, setAppStatus, friendlyError
} from './workspace/state.js';
import { bindOverview, renderOverview } from './workspace/overview.js';
import { bindFiles, renderFiles } from './workspace/files.js';
import { bindMonitor, closeMonitor, monitorKey, monitorOpen } from './workspace/monitor.js';
import { bindAudio, unbindAudio, renderAudio } from './workspace/audio.js';
import { bindDevices, renderDevices } from './workspace/devices.js';
import { bindDelivery, renderDelivery } from './workspace/delivery.js';

let unsubChange = null;

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
    bindOverview(switchTab);
    bindFiles(switchTab);
    bindMonitor();
    bindAudio(switchTab);
    bindDevices();
    bindDelivery();
    enhanceModals($('project_workspaceView') || document, '.ws-modal-overlay');

    clearListeners();
    unsubChange = onChange((what) => {
      // dados mudaram numa aba: as outras se atualizam quando forem abertas (e o cabeçalho agora)
      if (what === 'media' || what === 'sync') renderHeaderCounts();
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
  closeMonitor();
  unbindAudio();
  if (unsubChange) { unsubChange(); unsubChange = null; }
  setContextProvider('workspaceProject', null);
}

export function onKeyDown(e) {
  if (monitorKey(e)) return;
  if (e.key === 'Escape') {
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

// ------------------------------------------------------------------ cabeçalho e abas

function renderHeader() {
  const p = ws.project;
  $('wsProjectName').textContent = p.name;
  const title = document.getElementById('globalPageTitle');
  if (title) title.textContent = p.name;
  $('wsHeaderClient').textContent = p.client ? `Cliente: ${p.client}` : '';
  $('wsHeaderType').textContent = p.type || '';
  $('wsHeaderDeadline').textContent = p.deadline ? `Entrega: ${formatLocalDate(p.deadline)}` : '';
  const sel = $('wsProjectStatus');
  if (sel) sel.value = normalizeStatus(p.status);
  const cover = $('wsCoverImg');
  if (cover) {
    if (p.cover_path) { cover.style.backgroundImage = `url("${toFileUrl(p.cover_path)}")`; cover.classList.remove('empty'); }
    else { cover.style.backgroundImage = 'none'; cover.classList.add('empty'); }
  }
  const stripe = $('wsHeaderColor');
  if (stripe) stripe.style.background = /^#[0-9a-f]{3,8}$/i.test(p.color || '') ? p.color : 'transparent';
  renderHeaderCounts();
}

function renderHeaderCounts() {
  const n = ws.media.length;
  const c = $('wsHeaderCount');
  if (c) c.textContent = `${n} ${n === 1 ? 'arquivo' : 'arquivos'}${ws.missing.length ? ` · ${ws.missing.length} ${ws.missing.length === 1 ? 'ausente' : 'ausentes'}` : ''}`;
}

/** Liga os eventos do cabeçalho aos elementos desta abertura (a tela é recriada a cada projeto aberto). */
function bindHeader() {
  $('wsBtnBack')?.addEventListener('click', goBack);
  $('wsCoverWrapper')?.addEventListener('click', pickCover);
  $('wsProjectStatus')?.addEventListener('change', async (e) => {
    try {
      await window.bds.updateProject(ws.projectId, { status: e.target.value });
      ws.project.status = e.target.value;
      setAppStatus(`Status: ${e.target.value}.`, 'success');
      emitChange('project');
    } catch (err) { window.bdsModal.alert(`Não foi possível alterar o status: ${friendlyError(err)}`); e.target.value = normalizeStatus(ws.project.status); }
  });
  document.querySelectorAll('.ws-proj-tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.projTab)));
}

async function pickCover() {
  try {
    const result = await window.bds.selectFile({ properties: ['openFile'], filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    const fp = Array.isArray(result) ? result[0] : result;
    if (!fp) return;
    await window.bds.updateProject(ws.projectId, { cover_path: fp });
    ws.project.cover_path = fp;
    renderHeader();
    setAppStatus('Capa atualizada.', 'success');
  } catch (e) { window.bdsModal.alert(`Não foi possível trocar a capa: ${friendlyError(e)}`); }
}

function switchTab(tab) {
  ws.tab = tab;
  if (monitorOpen()) closeMonitor();
  document.querySelectorAll('.ws-proj-tab').forEach((b) => { const on = b.dataset.projTab === tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  document.querySelectorAll('[data-proj-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.projPanel !== tab));
  if (tab === 'overview') renderOverview();
  if (tab === 'files') renderFiles();
  if (tab === 'audio') renderAudio();
  if (tab === 'devices') renderDevices();
  if (tab === 'delivery') renderDelivery();
}
