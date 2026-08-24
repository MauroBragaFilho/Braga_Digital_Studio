// --- INJEÇÃO FORÇADA DE CSS (EVITA ERROS DE RESOLUÇÃO) ---
(function () {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  // Caminho relativo AO index.html (não ao .js!)
  // Se seu index.html está em /renderer/, então:
  link.href = './screens/project_workspace.css';
  document.head.appendChild(link);
})();

// Agora sim, importa as dependências
import { setAppStatus, escapeHtml } from '../app.js';

let projectId = null;
let project = null;
let libraryMedia = [];
let bins = [];
let projectMedia = [];

let draggedItem = null;
let selectedItem = null;

// --- FASE 4: SOURCE MONITOR (Decupagem) ---
let monitorMedia = null;     // registro de project_media atualmente carregado no monitor
let monitorEl = null;        // <video> ou <audio> ativo
let monitorIsAudio = false;
let markIn = 0;
let markOut = 0;
let hasOut = false;
let inspectorTab = 'info';
let centerTab = 'bins';
let syncSelection = new Set(); // pm_ids selecionados para Sincronização por Áudio

// --- FASE B: Cabeçalho, Capa e Resumo do Projeto ---
let headerDirty = {}; // campos pendentes de salvar (status, cover_path)
let syncGroupsCache = []; // cache de sync groups do projeto, para o resumo

// --- FASE C/D: Filtro de mídia e Sync Groups ---
let mediaTypeFilter = 'all'; // 'all' | 'video' | 'audio'
let selectedSyncGroupId = null;

// --- FASE H: Relink de mídia ausente ---
let missingMediaCache = [];
let relinkResults = [];

export async function initScreen() {
  try {
    const app = await import('../app.js');
    projectId = app.state.currentProjectId;
    if (!projectId) return goBack();

    await loadInitialData();
    setupEventListeners();
    setupMonitorKeyboardShortcuts();
  } catch (e) {
    console.error('[WORKSPACE] Erro na inicialização:', e);
    setAppStatus('Erro ao carregar workspace', 'error');
  }
}

function getActiveBinId() {
  return selectedItem?.type === 'bin' ? selectedItem.id : null;
}

async function importFilesViaDialog() {
  try {
    const binId = getActiveBinId();
    setAppStatus('Selecione os arquivos para importar...', 'info');
    const result = await window.bds.importFilesToProjectBin(projectId, binId);
    await handleImportResult(result);
  } catch (e) {
    console.error('[WORKSPACE] Erro ao importar arquivos:', e);
    window.bdsModal.alert(`Erro ao importar arquivos: ${e.message || e}`);
  }
}

async function importDroppedFiles(fileList) {
  try {
    const paths = [];
    for (const file of fileList) {
      try {
        const p = window.bds.getPathForFile(file);
        if (p) paths.push(p);
      } catch (e) {
        console.warn('[WORKSPACE] Não foi possível resolver caminho do arquivo solto:', file.name, e);
      }
    }
    if (paths.length === 0) return;

    const binId = getActiveBinId();
    setAppStatus(`Importando ${paths.length} arquivo(s)...`, 'info');
    const result = await window.bds.importDroppedFilesToProjectBin(projectId, binId, paths);
    await handleImportResult(result);
  } catch (e) {
    console.error('[WORKSPACE] Erro ao importar arquivos soltos:', e);
    window.bdsModal.alert(`Erro ao importar arquivos: ${e.message || e}`);
  }
}

async function handleImportResult(result) {
  if (!result) return;
  const { imported = 0, skipped = 0, failed = 0, total = 0 } = result;
  if (imported > 0) {
    setAppStatus(`${imported} arquivo(s) importado(s) com sucesso.`, 'success');
  } else {
    setAppStatus('Nenhum arquivo novo foi importado.', 'info');
  }
  if (skipped > 0 || failed > 0) {
    const parts = [];
    if (skipped > 0) parts.push(`${skipped} ignorado(s) (já existentes ou não suportados)`);
    if (failed > 0) parts.push(`${failed} com erro`);
    window.bdsModal.alert(`Importação concluída: ${imported}/${total} arquivo(s) importado(s).\n${parts.join(' • ')}`);
  }
  await reloadTree();
}

function setupImportDropzone() {
  const pane = document.querySelector('.ws-bins-pane');
  const overlay = document.getElementById('wsDropOverlay');
  if (!pane || !overlay) return;

  let dragCounter = 0;

  pane.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragCounter++;
    overlay.classList.remove('hidden');
  });
  pane.addEventListener('dragover', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
  });
  pane.addEventListener('dragleave', () => {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) overlay.classList.add('hidden');
  });
  pane.addEventListener('drop', async e => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    overlay.classList.add('hidden');
    await importDroppedFiles(e.dataTransfer.files);
  });
}

// ==========================================================================
// IMPORTAÇÃO — MODAL "DA BIBLIOTECA" (adicionar mídia já existente no banco)
// ==========================================================================

let importModalSelection = new Set();

function openImportLibraryModal() {
  importModalSelection.clear();
  renderImportModalList();
  document.getElementById('wsImportLibraryModal')?.classList.remove('hidden');
}

function closeImportLibraryModal() {
  document.getElementById('wsImportLibraryModal')?.classList.add('hidden');
}

function renderImportModalList() {
  const list = document.getElementById('wsImportModalList');
  const search = document.getElementById('wsImportModalSearch')?.value.toLowerCase() || '';
  if (!list) return;

  // Exclui mídias já adicionadas ao projeto
  const alreadyInProject = new Set(projectMedia.map(pm => pm.id));
  const available = libraryMedia.filter(m =>
    !alreadyInProject.has(m.id) && m.filename.toLowerCase().includes(search)
  );

  list.innerHTML = '';
  if (available.length === 0) {
    list.innerHTML = `<div style="padding: 16px; text-align:center; color: var(--muted); font-size: 12px;">Nenhuma mídia encontrada${search ? ' para essa busca' : ' (todas já estão no projeto)'}.</div>`;
    updateImportModalCount();
    return;
  }

  available.forEach(m => {
    const el = document.createElement('div');
    el.className = `ws-import-modal-item ${importModalSelection.has(m.id) ? 'checked' : ''}`;
    const thumbUrl = m.thumbnail_path ? `url('file:///${m.thumbnail_path.replace(/\\/g, '/')}')` : 'none';
    el.innerHTML = `
      <input type="checkbox" ${importModalSelection.has(m.id) ? 'checked' : ''} />
      <div class="ws-import-thumb" style="background-image:${thumbUrl};"></div>
      <span class="ws-import-name">${escapeHtml(m.filename)}</span>
      <span style="font-size:11px; color:var(--muted);">${formatBytes(m.filesize)}</span>
    `;
    el.addEventListener('click', () => {
      if (importModalSelection.has(m.id)) importModalSelection.delete(m.id);
      else importModalSelection.add(m.id);
      renderImportModalList();
    });
    list.appendChild(el);
  });

  updateImportModalCount();
}

function updateImportModalCount() {
  const countEl = document.getElementById('wsImportModalCount');
  if (countEl) countEl.textContent = `${importModalSelection.size} selecionado(s)`;
}

async function confirmImportFromLibrary() {
  if (importModalSelection.size === 0) return;
  try {
    const binId = getActiveBinId();
    await window.bds.addProjectMediaBulk(projectId, binId, [...importModalSelection]);
    setAppStatus(`${importModalSelection.size} mídia(s) adicionada(s) ao projeto.`, 'success');
    closeImportLibraryModal();
    await reloadTree();
  } catch (e) {
    console.error('[WORKSPACE] Erro ao importar da biblioteca:', e);
    window.bdsModal.alert('Erro ao adicionar mídias da biblioteca.');
  }
}

function goBack() {
  if (monitorEl) { try { monitorEl.pause(); } catch (e) {} }
  import('../app.js').then(app => {
    app.state.currentProjectId = null;
    document.querySelector('.sidebar .tab-button[data-view="projects"]')?.click();
  });
}

async function loadInitialData() {
  try {
    project = await window.bds.getProject(projectId);
    if (!project) return goBack();

    renderProjectHeader();
    await reloadLibrary();
    await reloadTree();
    await reloadSyncGroups();
    await checkMissingMedia();
  } catch (e) {
    console.error(e);
    setAppStatus('Erro ao carregar workspace', 'error');
  }
}

async function reloadLibrary() {
  try {
    libraryMedia = await window.bds.searchLibrary({});
    renderLibrary();
  } catch (e) {
    console.error(e);
  }
}

async function reloadTree() {
  try {
    bins = await window.bds.getProjectBins(projectId);
    projectMedia = await window.bds.getProjectMedia(projectId);
    renderTree();
    renderProjectSummary();

    if (selectedItem) {
      let exists = false;
      if (selectedItem.type === 'bin') exists = bins.some(b => b.id === selectedItem.id);
      if (selectedItem.type === 'project_media') exists = projectMedia.some(pm => pm.pm_id === selectedItem.id);
      if (!exists) {
        selectedItem = null;
        updateInspector();
      } else {
        updateInspector();
      }
    }
  } catch (e) {
    console.error(e);
  }
}

// ==========================================================================
// FASE B — CABEÇALHO, CAPA E RESUMO DO PROJETO
// ==========================================================================

function renderProjectHeader() {
  const nameEl = document.getElementById('wsProjectName');
  if (nameEl) nameEl.textContent = project.name;

  const statusSel = document.getElementById('wsProjectStatus');
  if (statusSel) statusSel.value = project.status || 'Ativo';

  renderCoverImage(project.cover_path);
}

function renderCoverImage(coverPath) {
  const el = document.getElementById('wsCoverImg');
  if (!el) return;
  if (coverPath) {
    el.style.backgroundImage = `url("file:///${coverPath.replace(/\\/g, '/')}")`;
    el.classList.remove('empty');
  } else {
    el.style.backgroundImage = 'none';
    el.classList.add('empty');
  }
}

function markHeaderDirty(key, value) {
  headerDirty[key] = value;
  document.getElementById('wsBtnSaveProject')?.classList.add('ws-btn-dirty');
}

async function pickProjectCover() {
  try {
    const result = await window.bds.selectFile({
      properties: ['openFile'],
      filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    });
    const filePath = Array.isArray(result) ? result[0] : result;
    if (!filePath) return;
    markHeaderDirty('cover_path', filePath);
    renderCoverImage(filePath);
    setAppStatus('Capa selecionada — clique em Salvar para aplicar.', 'info');
  } catch (e) {
    console.error('[WORKSPACE] Erro ao selecionar capa:', e);
  }
}

async function saveProjectHeader() {
  if (Object.keys(headerDirty).length === 0) {
    setAppStatus('Nenhuma alteração pendente.', 'info');
    return;
  }
  try {
    await window.bds.updateProject(projectId, headerDirty);
    Object.assign(project, headerDirty);
    headerDirty = {};
    document.getElementById('wsBtnSaveProject')?.classList.remove('ws-btn-dirty');
    setAppStatus('Projeto salvo.', 'success');
  } catch (e) {
    console.error('[WORKSPACE] Erro ao salvar projeto:', e);
    setAppStatus('Erro ao salvar projeto.', 'error');
  }
}

async function reloadSyncGroups() {
  try {
    syncGroupsCache = await window.bds.getProjectSyncGroups(projectId);
    renderProjectSummary();
    if (centerTab === 'sync') renderSyncGroupsList();
    if (centerTab === 'bins') renderTree();
  } catch (e) {
    console.error('[WORKSPACE] Erro ao carregar sync groups:', e);
  }
}

function renderProjectSummary() {
  const videos = projectMedia.filter(pm => !isMediaAudioOnly(pm));
  const audios = projectMedia.filter(pm => isMediaAudioOnly(pm));

  const syncedMediaIds = new Set();
  syncGroupsCache.forEach(g => (g.items || []).forEach(it => syncedMediaIds.add(it.media_id)));
  const syncedCount = projectMedia.filter(pm => syncedMediaIds.has(pm.id)).length;
  const pendingCount = Math.max(0, projectMedia.length - syncedCount);

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
  set('wsSummaryVideos', videos.length);
  set('wsSummaryAudios', audios.length);
  set('wsSummarySynced', syncedCount);
  set('wsSummaryPending', pendingCount);
}

async function exportProjectBdspro() {
  try {
    const folder = await window.bds.selectFolder();
    if (!folder) return;
    const safeName = (project.name || 'Projeto').replace(/[\\/:*?"<>|]/g, '_');
    const outputPath = `${folder}\\${safeName}.bdspro`;
    setAppStatus('Exportando .bdspro...', 'info');
    await window.bds.exportBdspro(projectId, outputPath);
    setAppStatus('Pacote .bdspro exportado com sucesso!', 'success');
    await window.bds.openLocalPath(folder);
  } catch (e) {
    console.error('[WORKSPACE] Erro ao exportar .bdspro:', e);
    window.bdsModal.alert('Erro ao exportar pacote .bdspro.');
  }
}

// ==========================================================================
// FASE D — SYNC GROUPS (listagem, renomear, trocar master, remover item)
// ==========================================================================

function formatOffset(offsetSeconds) {
  const ms = Math.round((offsetSeconds || 0) * 1000);
  const sign = ms >= 0 ? '+' : '';
  return `${sign}${ms}ms`;
}

function renderSyncGroupsList() {
  const list = document.getElementById('wsSyncGroupsList');
  if (!list) return;
  list.innerHTML = '';

  if (syncGroupsCache.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ws-empty-state';
    empty.textContent = 'Nenhum Sync Group ainda. Selecione mídias (Ctrl+clique) na aba Pastas e clique em "Sincronizar por Áudio".';
    list.appendChild(empty);
  } else {
    syncGroupsCache.forEach(group => {
      const item = document.createElement('div');
      item.className = `ws-sync-group-item ${selectedSyncGroupId === group.id ? 'selected' : ''}`;
      item.innerHTML = `
        <span class="ws-sync-group-item-name">${escapeHtml(group.name)}</span>
        <span class="ws-sync-group-item-meta">${(group.items || []).length} mídia${(group.items || []).length !== 1 ? 's' : ''}</span>
      `;
      item.addEventListener('click', () => selectSyncGroup(group.id));
      list.appendChild(item);
    });
  }

  // Mantém a seleção/detalhe atual em sincronia após reload
  if (selectedSyncGroupId && syncGroupsCache.some(g => g.id === selectedSyncGroupId)) {
    renderSyncGroupDetail(selectedSyncGroupId);
  } else if (syncGroupsCache.length > 0) {
    selectSyncGroup(syncGroupsCache[0].id);
  } else {
    selectedSyncGroupId = null;
    const detail = document.getElementById('wsSyncGroupDetail');
    if (detail) detail.innerHTML = '<div class="ws-empty-state">Selecione um Sync Group à esquerda, ou crie um pelo botão "Sincronizar por Áudio".</div>';
  }
}

function selectSyncGroup(groupId) {
  selectedSyncGroupId = groupId;
  renderSyncGroupsList();
}

function renderSyncGroupDetail(groupId) {
  const detail = document.getElementById('wsSyncGroupDetail');
  if (!detail) return;
  const group = syncGroupsCache.find(g => g.id === groupId);
  if (!group) {
    detail.innerHTML = '<div class="ws-empty-state">Sync Group não encontrado.</div>';
    return;
  }

  const rows = (group.items || []).map(item => {
    const isMaster = group.master_media_id === item.media_id;
    const lowConfidence = item.confidence !== undefined && item.confidence !== null && item.confidence < 0.5;
    return `
      <tr data-item-id="${item.id}" data-media-id="${item.media_id}">
        <td>
          <button class="ws-sync-master-btn ${isMaster ? 'is-master' : ''} material-symbols-rounded" data-action="set-master" title="${isMaster ? 'Master do grupo' : 'Definir como master'}">
            ${isMaster ? 'star' : 'star_outline'}
          </button>
        </td>
        <td><span class="ws-sync-item-name" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</span></td>
        <td class="${lowConfidence ? 'ws-sync-confidence-low' : ''}">${formatOffset(item.offset_seconds)}</td>
        <td>${item.confidence !== undefined && item.confidence !== null ? Math.round(item.confidence * 100) + '%' : '—'}</td>
        <td>
          <button class="ws-sync-item-remove-btn material-symbols-rounded" data-action="remove-item" title="Remover do grupo">close</button>
        </td>
      </tr>
    `;
  }).join('');

  detail.innerHTML = `
    <div class="ws-sync-detail-header">
      <input type="text" id="wsSyncGroupNameInput" class="ws-sync-detail-name-input" value="${escapeHtml(group.name)}" />
      <div class="ws-sync-detail-actions">
        <button id="wsBtnDeleteSyncGroup" class="ws-btn-delete-outline" type="button">
          <span class="material-symbols-rounded">delete</span> Excluir Grupo
        </button>
      </div>
    </div>

    <table class="ws-sync-items-table">
      <thead>
        <tr>
          <th></th>
          <th>Arquivo</th>
          <th>Offset</th>
          <th>Confiança</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div id="wsSyncVizWrapper"></div>
  `;

  const nameInput = document.getElementById('wsSyncGroupNameInput');
  nameInput?.addEventListener('change', async (e) => {
    const newName = e.target.value.trim();
    if (!newName || newName === group.name) return;
    try {
      await window.bds.updateProjectSyncGroup(group.id, { name: newName });
      group.name = newName;
      setAppStatus('Sync Group renomeado.', 'success');
      renderSyncGroupsList();
    } catch (err) {
      console.error(err);
      setAppStatus('Erro ao renomear Sync Group.', 'error');
    }
  });

  document.getElementById('wsBtnDeleteSyncGroup')?.addEventListener('click', () => deleteSyncGroupAction(group.id));

  detail.querySelectorAll('[data-action="set-master"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const row = e.target.closest('tr');
      const mediaId = Number(row.dataset.mediaId);
      setSyncGroupMaster(group.id, mediaId);
    });
  });

  detail.querySelectorAll('[data-action="remove-item"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const row = e.target.closest('tr');
      const itemId = Number(row.dataset.itemId);
      removeSyncGroupItemAction(group.id, itemId);
    });
  });

  renderSyncVisualization(group);
}

async function setSyncGroupMaster(groupId, mediaId) {
  try {
    await window.bds.updateProjectSyncGroup(groupId, { master_media_id: mediaId });
    const group = syncGroupsCache.find(g => g.id === groupId);
    if (group) group.master_media_id = mediaId;
    renderSyncGroupDetail(groupId);
    setAppStatus('Master do Sync Group atualizado.', 'success');
  } catch (e) {
    console.error(e);
    setAppStatus('Erro ao definir master.', 'error');
  }
}

async function removeSyncGroupItemAction(groupId, itemId) {
  const confirmed = await window.bdsModal.confirm('Remover esta mídia do Sync Group?');
  if (!confirmed) return;
  try {
    await window.bds.removeProjectSyncGroupItem(itemId);
    await reloadSyncGroups();
    setAppStatus('Mídia removida do Sync Group.', 'success');
  } catch (e) {
    console.error(e);
    setAppStatus('Erro ao remover mídia do grupo.', 'error');
  }
}

async function deleteSyncGroupAction(groupId) {
  const confirmed = await window.bdsModal.confirm('Excluir este Sync Group inteiro? Isso não afeta os arquivos originais.');
  if (!confirmed) return;
  try {
    await window.bds.deleteProjectSyncGroup(groupId);
    if (selectedSyncGroupId === groupId) selectedSyncGroupId = null;
    await reloadSyncGroups();
    setAppStatus('Sync Group excluído.', 'success');
  } catch (e) {
    console.error(e);
    setAppStatus('Erro ao excluir Sync Group.', 'error');
  }
}

// ==========================================================================
// FASE E — VISUALIZAÇÃO GRÁFICA DA SINCRONIZAÇÃO (estática, sem edição)
// ==========================================================================

// --- FASE 4: Visualização estilo PluralEyes — faixas de waveform empilhadas,
//     deslocadas horizontalmente pelo offset calculado, com hachura no
//     trecho "vazio" e badge de confiança por clipe. ---
function renderSyncVisualization(group) {
  const wrapper = document.getElementById('wsSyncVizWrapper');
  if (!wrapper) return;

  const items = group.items || [];
  if (items.length === 0) {
    wrapper.innerHTML = '';
    return;
  }

  const avgConfidence = items.reduce((sum, it) => sum + (it.confidence || 0), 0) / items.length;
  const confidenceLabel = avgConfidence >= 0.75 ? 'Confiança alta' : avgConfidence >= 0.4 ? 'Confiança média' : 'Confiança baixa';
  const confidenceClass = avgConfidence >= 0.75 ? 'high' : avgConfidence >= 0.4 ? 'medium' : 'low';

  // Escala de tempo: do menor offset até o maior (offset + duração)
  const maxEnd = items.reduce((max, it) => Math.max(max, (it.offset_seconds || 0) + (it.duration || 0)), 0.001);
  const minStart = Math.min(0, ...items.map(it => it.offset_seconds || 0));
  const timeRange = Math.max(0.001, maxEnd - minStart);

  const trackRows = items.map((it, i) => {
    const isMaster = it.media_id === group.master_media_id;
    const conf = it.confidence !== undefined && it.confidence !== null ? it.confidence : null;
    const confPct = conf !== null ? Math.round(conf * 100) : null;
    const confClass = conf === null ? '' : conf >= 0.75 ? 'high' : conf >= 0.4 ? 'medium' : 'low';
    const confDotLabel = conf === null ? '—' : conf >= 0.75 ? 'alta' : conf >= 0.4 ? 'média' : 'baixa';

    const startPct = ((((it.offset_seconds || 0) - minStart) / timeRange) * 100).toFixed(3);
    const widthPct = (((it.duration || 0) / timeRange) * 100).toFixed(3);
    const driftBadge = it.drift_rate_ppm && Math.abs(it.drift_rate_ppm) >= 5
      ? `<span class="ws-sync-drift-badge" title="Deriva de clock detectada e corrigida">drift ${it.drift_rate_ppm > 0 ? '+' : ''}${Math.round(it.drift_rate_ppm)}ppm</span>`
      : '';

    return `
      <div class="ws-sync-track-row ${confClass ? 'conf-' + confClass : ''}" data-media-id="${it.media_id}">
        <div class="ws-sync-track-label">
          <span class="ws-sync-track-name" title="${escapeHtml(it.filename)}">
            ${isMaster ? '<span class="material-symbols-rounded ws-sync-master-icon" title="Mestre">star</span>' : ''}
            ${escapeHtml(it.filename.length > 18 ? it.filename.slice(0, 16) + '…' : it.filename)}
          </span>
          <span class="ws-sync-track-offset">${isMaster ? 'mestre' : formatOffset(it.offset_seconds)}</span>
        </div>
        <div class="ws-sync-track-lane">
          <div class="ws-sync-track-bar" style="left:${startPct}%; width:${widthPct}%;">
            <canvas class="ws-sync-track-canvas" data-media-id="${it.media_id}" data-stream-index="0"></canvas>
          </div>
        </div>
        <div class="ws-sync-track-conf ${confClass}" title="Confiança da correlação: ${confPct !== null ? confPct + '%' : 'indisponível'}">
          ${confPct !== null ? confPct + '%' : '—'} <span class="ws-sync-conf-word">${confDotLabel}</span>
          ${driftBadge}
        </div>
      </div>
    `;
  }).join('');

  wrapper.innerHTML = `
    <div class="ws-sync-viz-wrapper ws-sync-viz-pluraleyes">
      <div class="ws-sync-viz-header">
        <span class="ws-sync-viz-title">Visualização da Sincronização</span>
        <span class="ws-sync-viz-confidence-badge ${confidenceClass}">${confidenceLabel} · ${Math.round(avgConfidence * 100)}%</span>
      </div>
      <div class="ws-sync-tracks">${trackRows}</div>
    </div>
  `;

  // Desenha as waveforms reais dentro de cada faixa (assíncrono, cacheado)
  wrapper.querySelectorAll('.ws-sync-track-canvas').forEach(canvas => {
    const mediaId = Number(canvas.dataset.mediaId);
    const item = items.find(it => it.media_id === mediaId);
    if (!item || !item.filepath) return;

    canvas.height = 30;
    window.bds.getMediaWaveform({
      uuid: item.uuid || String(item.media_id),
      filePath: item.filepath,
      duration: item.duration || 0,
      peaksPerSecond: 60,
      streamIndex: 0
    }).then(wf => {
      if (wf && wf.peaks) drawWaveformOnCanvas(canvas, wf.peaks);
    }).catch(() => { /* sem waveform cacheada ainda, faixa fica só com a cor de fundo */ });
  });
}

// ==========================================================================
// FASE H — RELINK DE MÍDIA AUSENTE ("Arquivos não encontrados")
// ==========================================================================

async function checkMissingMedia() {
  try {
    missingMediaCache = await window.bds.getMissingProjectMedia(projectId);
  } catch (e) {
    console.error('[WORKSPACE] Erro ao verificar mídia ausente:', e);
    missingMediaCache = [];
  }

  const banner = document.getElementById('wsMissingBanner');
  const text = document.getElementById('wsMissingBannerText');
  if (!banner || !text) return;

  if (missingMediaCache.length > 0) {
    text.textContent = `${missingMediaCache.length} arquivo${missingMediaCache.length !== 1 ? 's' : ''} não encontrado${missingMediaCache.length !== 1 ? 's' : ''} neste projeto.`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

async function openRelinkFlow() {
  if (missingMediaCache.length === 0) {
    setAppStatus('Nenhum arquivo ausente para reconectar.', 'info');
    return;
  }

  const folder = await window.bds.selectFolder();
  if (!folder) return;

  setAppStatus('Procurando arquivos na pasta selecionada...', 'info');
  try {
    const scannedFiles = await window.bds.scanRelinkFolder(folder);
    const missingList = missingMediaCache.map(m => ({
      media_id: m.id,
      filename: m.filename,
      original_path: m.filepath,
      filesize: m.filesize
    }));
    const matchResults = await window.bds.matchMissingMedia(missingList, scannedFiles);

    relinkResults = matchResults.map(r => ({
      media_id: r.missing.media_id,
      filename: r.missing.filename,
      resolvedPath: r.resolved && r.matched ? r.matched.filepath : null,
      matched: r.matched,
      confidence: r.confidence,
      resolved: r.resolved
    }));

    renderRelinkList();
    document.getElementById('wsRelinkModal')?.classList.remove('hidden');
    setAppStatus(`${scannedFiles.length} arquivo(s) encontrados na pasta. Revise os resultados.`, 'success');
  } catch (e) {
    console.error('[WORKSPACE] Erro ao escanear pasta para relink:', e);
    window.bdsModal.alert('Erro ao procurar arquivos na pasta selecionada.');
  }
}

function renderRelinkList() {
  const list = document.getElementById('wsRelinkList');
  if (!list) return;
  list.innerHTML = '';

  relinkResults.forEach((r, index) => {
    const row = document.createElement('div');
    row.className = 'ws-relink-row';

    let iconClass, statusClass, statusText, icon;
    if (r.resolvedPath && r.resolved) {
      iconClass = 'resolved'; statusClass = 'resolved'; icon = 'check_circle';
      statusText = `Encontrado (${r.confidence}% de confiança) — ${r.matched.filename}`;
    } else if (r.resolvedPath) {
      iconClass = 'resolved'; statusClass = 'resolved'; icon = 'check_circle';
      statusText = `Selecionado manualmente — ${r.matched?.filename || r.resolvedPath.split(/[\\/]/).pop()}`;
    } else if (r.matched) {
      iconClass = 'uncertain'; statusClass = 'uncertain'; icon = 'help';
      statusText = `Possível correspondência (${r.confidence}%) — ${r.matched.filename}. Confirme manualmente.`;
    } else {
      iconClass = 'unresolved'; statusClass = ''; icon = 'search_off';
      statusText = 'Nenhuma correspondência encontrada.';
    }

    row.innerHTML = `
      <span class="material-symbols-rounded ws-relink-row-icon ${iconClass}">${icon}</span>
      <div class="ws-relink-row-info">
        <span class="ws-relink-row-name" title="${escapeHtml(r.filename)}">${escapeHtml(r.filename)}</span>
        <span class="ws-relink-row-status ${statusClass}">${escapeHtml(statusText)}</span>
      </div>
      <button class="ws-relink-row-pick" data-index="${index}" type="button">Escolher arquivo...</button>
    `;

    row.querySelector('.ws-relink-row-pick')?.addEventListener('click', () => pickManualRelinkFile(index));
    list.appendChild(row);
  });

  updateRelinkCount();
}

async function pickManualRelinkFile(index) {
  try {
    const result = await window.bds.selectFile({ properties: ['openFile'] });
    const filePath = Array.isArray(result) ? result[0] : result;
    if (!filePath) return;
    relinkResults[index].resolvedPath = filePath;
    relinkResults[index].matched = { filename: filePath.split(/[\\/]/).pop() };
    relinkResults[index].resolved = true;
    renderRelinkList();
  } catch (e) {
    console.error('[WORKSPACE] Erro ao escolher arquivo manualmente:', e);
  }
}

function updateRelinkCount() {
  const el = document.getElementById('wsRelinkCount');
  if (!el) return;
  const resolvedCount = relinkResults.filter(r => r.resolvedPath).length;
  el.textContent = `${resolvedCount} de ${relinkResults.length} resolvido(s)`;
}

function closeRelinkModal() {
  document.getElementById('wsRelinkModal')?.classList.add('hidden');
}

async function confirmRelink() {
  const toApply = relinkResults.filter(r => r.resolvedPath);
  if (toApply.length === 0) {
    setAppStatus('Nenhum arquivo resolvido para reconectar.', 'info');
    return;
  }

  try {
    for (const r of toApply) {
      await window.bds.relinkMedia(r.media_id, r.resolvedPath);
    }
    closeRelinkModal();
    setAppStatus(`${toApply.length} arquivo(s) reconectado(s) com sucesso.`, 'success');
    await reloadLibrary();
    await reloadTree();
    await checkMissingMedia();
  } catch (e) {
    console.error('[WORKSPACE] Erro ao aplicar reconexão:', e);
    window.bdsModal.alert('Erro ao aplicar a reconexão dos arquivos.');
  }
}

function renderLibrary() {
  const container = document.getElementById('wsLibContent');
  const search = document.getElementById('wsLibSearch')?.value.toLowerCase() || '';
  container.innerHTML = '';

  const filtered = libraryMedia.filter(m =>
    m.filename.toLowerCase().includes(search)
  );

  filtered.forEach(m => {
    const thumbUrl = m.thumbnail_path ? `url('file:///${m.thumbnail_path.replace(/\\/g, '/')}')` : 'none';
    const el = document.createElement('div');
    el.className = 'ws-lib-item';
    el.draggable = true;
    el.dataset.id = m.id;
    el.innerHTML = `
      <div class="ws-lib-thumb" style="background-image: ${thumbUrl};"></div>
      <div class="ws-lib-info">
        <div class="ws-lib-title" title="${escapeHtml(m.filename)}">${escapeHtml(m.filename)}</div>
        <div class="ws-lib-meta">${formatBytes(m.filesize)} • ${m.extension || 'UNK'}</div>
      </div>
      <span class="material-symbols-rounded" style="color: var(--muted); font-size: 16px;">drag_indicator</span>
    `;
    el.addEventListener('dragstart', (e) => {
      draggedItem = { type: 'library_media', id: m.id };
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', m.id);
    });
    container.appendChild(el);
  });
}

function mediaMatchesFilter(pm) {
  if (mediaTypeFilter === 'all') return true;
  const isAudio = isMediaAudioOnly(pm);
  return mediaTypeFilter === 'audio' ? isAudio : !isAudio;
}

function isMediaSynced(pm) {
  const syncedMediaIds = new Set();
  syncGroupsCache.forEach(g => (g.items || []).forEach(it => syncedMediaIds.add(it.media_id)));
  return syncedMediaIds.has(pm.id);
}

function setMediaTypeFilter(filter) {
  mediaTypeFilter = filter;
  document.querySelectorAll('.ws-media-filter').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderTree();
}

function renderTree() {
  const container = document.getElementById('wsBinsTree');
  container.innerHTML = '';

  const rootBins = bins.filter(b => !b.parent_id);
  const rootMedia = projectMedia.filter(m => !m.bin_id && mediaMatchesFilter(m));

  rootBins.forEach(bin => container.appendChild(createBinNode(bin)));

  // Mídias do projeto que não estão dentro de nenhuma pasta: mostradas num
  // agrupamento visível "Sem Pasta", em vez de se misturarem soltas no topo
  // da árvore (o que fazia parecer que elas tinham sumido).
  if (rootMedia.length > 0) {
    container.appendChild(createUnfiledMediaGroup(rootMedia));
  }

  if (rootBins.length === 0 && rootMedia.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ws-empty-state';
    empty.textContent = 'Nenhum arquivo neste projeto ainda. Importe da Biblioteca ou do computador, ou arraste arquivos aqui.';
    container.appendChild(empty);
  }

  container.addEventListener('dragover', e => e.preventDefault());
  container.addEventListener('drop', e => {
    e.preventDefault();
    if (draggedItem) handleDrop(null);
  });
}

function createUnfiledMediaGroup(mediaList) {
  const wrapper = document.createElement('div');
  wrapper.className = 'ws-bin-node ws-unfiled-group';

  const header = document.createElement('div');
  header.className = 'ws-bin-header ws-unfiled-header';
  header.innerHTML = `
    <span class="material-symbols-rounded" style="color: var(--muted); font-size: 18px;">draft</span>
    <span>Sem Pasta</span>
    <span class="ws-unfiled-count">${mediaList.length}</span>
  `;
  header.addEventListener('dragover', e => {
    e.preventDefault();
    header.classList.add('drag-over');
  });
  header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
  header.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    header.classList.remove('drag-over');
    handleDrop(null);
  });
  wrapper.appendChild(header);

  const children = document.createElement('div');
  children.className = 'ws-bin-children';
  mediaList.forEach(pm => children.appendChild(createMediaNode(pm)));
  wrapper.appendChild(children);

  return wrapper;
}

function createBinNode(bin) {
  const wrapper = document.createElement('div');
  wrapper.className = 'ws-bin-node';

  const header = document.createElement('div');
  header.className = `ws-bin-header ${selectedItem?.type === 'bin' && selectedItem.id === bin.id ? 'selected' : ''}`;
  header.innerHTML = `
    <span class="material-symbols-rounded" style="color: #ecc055; font-size: 18px;">folder</span>
    <span>${escapeHtml(bin.name)}</span>
  `;
  header.draggable = true;
  header.addEventListener('dragstart', e => {
    e.stopPropagation();
    draggedItem = { type: 'bin', id: bin.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', bin.id);
  });
  header.addEventListener('dragover', e => {
    e.preventDefault();
    header.classList.add('drag-over');
  });
  header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
  header.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    header.classList.remove('drag-over');
    handleDrop(bin.id);
  });
  header.addEventListener('click', e => {
    e.stopPropagation();
    selectItem('bin', bin.id);
  });

  wrapper.appendChild(header);

  const children = document.createElement('div');
  children.className = 'ws-bin-children';

  bins.filter(b => b.parent_id === bin.id).forEach(sb => children.appendChild(createBinNode(sb)));
  projectMedia.filter(m => m.bin_id === bin.id && mediaMatchesFilter(m)).forEach(pm => children.appendChild(createMediaNode(pm)));

  wrapper.appendChild(children);
  return wrapper;
}

function createMediaNode(pm) {
  const el = document.createElement('div');
  el.className = `ws-bin-media ${selectedItem?.type === 'project_media' && selectedItem.id === pm.pm_id ? 'selected' : ''} ${syncSelection.has(pm.pm_id) ? 'sync-selected' : ''}`;
  const isAudio = pm.extension === 'MP3' || pm.extension === 'WAV';
  const icon = isAudio ? 'audiotrack' :
               ['JPG','PNG','WEBP'].includes(pm.extension) ? 'image' : 'movie';
  const name = pm.custom_name || pm.filename;
  const synced = isMediaSynced(pm);
  const thumbUrl = pm.thumbnail_path ? `url('file:///${pm.thumbnail_path.replace(/\\/g, '/')}')` : '';

  const thumbHtml = isAudio
    ? `<canvas class="ws-bin-media-thumb ws-bin-media-thumb-wave" data-uuid="${pm.uuid || ''}" data-path="${pm.filepath ? pm.filepath.replace(/"/g, '&quot;') : ''}"></canvas>`
    : `<div class="ws-bin-media-thumb" style="background-image:${thumbUrl};">${!thumbUrl ? `<span class="material-symbols-rounded">${icon}</span>` : ''}</div>`;

  el.innerHTML = `
    ${thumbHtml}
    <span class="ws-bin-media-name" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(name)}</span>
    <span class="ws-bin-media-sync-pill ${synced ? 'synced' : 'pending'}" title="${synced ? 'Sincronizado' : 'Pendente de sincronização'}">
      <span class="material-symbols-rounded">${synced ? 'check_circle' : 'warning'}</span>${synced ? 'Sync' : 'Pendente'}
    </span>
  `;
  el.draggable = true;
  el.addEventListener('dragstart', e => {
    e.stopPropagation();
    draggedItem = { type: 'project_media', id: pm.pm_id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', pm.pm_id);
  });
  el.addEventListener('click', e => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      toggleSyncSelection(pm.pm_id);
      return;
    }
    selectItem('project_media', pm.pm_id);
  });
  el.addEventListener('dblclick', e => {
    e.stopPropagation();
    selectItem('project_media', pm.pm_id);
    switchCenterTab('monitor');
    loadIntoMonitor(pm);
  });

  if (isAudio) {
    const canvas = el.querySelector('.ws-bin-media-thumb-wave');
    if (canvas && pm.uuid && pm.filepath && window.bds?.getMediaWaveform) {
      requestAnimationFrame(() => {
        canvas.height = 28;
        window.bds.getMediaWaveform({ uuid: pm.uuid, filePath: pm.filepath, peaksPerSecond: 30, streamIndex: 0 })
          .then(wf => { if (wf && wf.peaks) drawWaveformOnCanvas(canvas, wf.peaks); })
          .catch(() => {});
      });
    }
  }

  return el;
}

function toggleSyncSelection(pmId) {
  if (syncSelection.has(pmId)) syncSelection.delete(pmId);
  else syncSelection.add(pmId);
  renderTree();
  updateSyncSelectionHint();
}

function updateSyncSelectionHint() {
  const hint = document.getElementById('wsSyncSelectionHint');
  if (!hint) return;
  const n = syncSelection.size;
  hint.textContent = n > 0
    ? `${n} mídia${n > 1 ? 's' : ''} selecionada${n > 1 ? 's' : ''} para sync (Ctrl+clique)`
    : '';
}

async function handleDrop(targetBinId) {
  if (!draggedItem) return;
  try {
    if (draggedItem.type === 'library_media') {
      await window.bds.addProjectMedia(projectId, targetBinId, draggedItem.id, null);
    } else if (draggedItem.type === 'project_media') {
      await window.bds.moveProjectMedia(draggedItem.id, targetBinId);
    } else if (draggedItem.type === 'bin') {
      if (targetBinId !== draggedItem.id) {
        const bin = bins.find(b => b.id === draggedItem.id);
        if (bin) await window.bds.updateProjectBin(bin.id, bin.name, targetBinId);
      }
    }
  } catch (e) {
    console.error(e);
    window.bdsModal.alert('Erro ao mover item.');
  }
  draggedItem = null;
  await reloadTree();
}

function selectItem(type, id) {
  selectedItem = { type, id };
  document.querySelectorAll('.ws-bin-header, .ws-bin-media').forEach(el => el.classList.remove('selected'));
  updateInspector();
}

function updateInspector() {
  const noSel = document.getElementById('wsNoSelection');
  const details = document.getElementById('wsSelectionDetails');
  const mediaPreview = document.getElementById('wsMediaPreview');
  const mediaMeta = document.getElementById('wsMediaMeta');
  const inspTabs = document.getElementById('wsInspectorTabs');
  const inputName = document.getElementById('wsInputItemName');

  if (!selectedItem) {
    noSel.classList.remove('hidden');
    details.classList.add('hidden');
    return;
  }

  noSel.classList.add('hidden');
  details.classList.remove('hidden');

  if (selectedItem.type === 'bin') {
    const bin = bins.find(b => b.id === selectedItem.id);
    if (bin) {
      inputName.value = bin.name;
      mediaPreview?.classList.add('hidden');
      mediaMeta?.classList.add('hidden');
      inspTabs?.classList.add('hidden');
    }
  } else {
    const pm = projectMedia.find(m => m.pm_id === selectedItem.id);
    if (pm) {
      inputName.value = pm.custom_name || pm.filename;
      inspTabs?.classList.remove('hidden');
      setInspectorTab(inspectorTab);

      const thumbUrl = pm.thumbnail_path ? `url('file:///${pm.thumbnail_path.replace(/\\/g, '/')}')` : 'none';
      document.getElementById('wsMediaThumb').style.backgroundImage = thumbUrl;
      document.getElementById('wsMediaPath').textContent = pm.filepath;
      document.getElementById('wsMediaSize').textContent = formatBytes(pm.filesize);
      document.getElementById('wsMediaDuration').textContent = pm.duration ? secondsToTimecode(pm.duration, pm.fps || 30) : '—';
      document.getElementById('wsMediaRes').textContent = pm.width && pm.height ? `${pm.width}×${pm.height}` : '—';
      document.getElementById('wsMediaFps').textContent = pm.fps ? `${pm.fps} fps` : '—';
      document.getElementById('wsMediaCodecs').textContent = [pm.video_codec, pm.audio_codec].filter(Boolean).join(' / ') || '—';

      // Aba de Metadados BDSM (preparado para Fase 9 - campos ainda não existem no schema atual)
      document.getElementById('wsMetaCamera').textContent = pm.bdsm_camera || '—';
      document.getElementById('wsMetaProfile').textContent = pm.bdsm_profile || '—';
      document.getElementById('wsMetaLut').textContent = pm.bdsm_lut || '—';
      document.getElementById('wsMetaRecordedAt').textContent = pm.recorded_at || '—';
    }
  }
}

function setInspectorTab(tab) {
  inspectorTab = tab;
  document.getElementById('wsInspTabInfo')?.classList.toggle('active', tab === 'info');
  document.getElementById('wsInspTabMeta')?.classList.toggle('active', tab === 'meta');
  document.getElementById('wsMediaPreview')?.classList.toggle('hidden', tab !== 'info');
  document.getElementById('wsMediaMeta')?.classList.toggle('hidden', tab !== 'meta');
}

// ==========================================================================
// FASE 4 — SOURCE MONITOR (Decupagem)
// ==========================================================================

function switchCenterTab(tab) {
  centerTab = tab;
  document.getElementById('wsTabBins')?.classList.toggle('active', tab === 'bins');
  document.getElementById('wsTabMonitor')?.classList.toggle('active', tab === 'monitor');
  document.getElementById('wsTabSync')?.classList.toggle('active', tab === 'sync');
  document.getElementById('wsBinsTree')?.classList.toggle('hidden', tab !== 'bins');
  document.getElementById('wsMediaFilterRow')?.classList.toggle('hidden', tab !== 'bins');
  document.getElementById('wsSourceMonitor')?.classList.toggle('hidden', tab !== 'monitor');
  document.getElementById('wsSyncPanel')?.classList.toggle('hidden', tab !== 'sync');
  if (tab === 'sync') renderSyncGroupsList();
}

function isMediaAudioOnly(pm) {
  const ext = (pm.extension || pm.filename?.split('.').pop() || '').toUpperCase();
  return ['MP3', 'WAV', 'AAC', 'FLAC', 'M4A', 'OGG'].includes(ext) || (!pm.video_codec && !!pm.audio_codec);
}

async function loadIntoMonitor(pm) {
  try {
    teardownMonitorTrackAudio();
    monitorMedia = pm;
    markIn = 0;
    markOut = pm.duration || 0;
    hasOut = false;

    document.getElementById('wsMonitorEmpty')?.classList.add('hidden');
    document.getElementById('wsMonitorPlayer')?.classList.remove('hidden');
    document.getElementById('wsMonitorFileName').textContent = pm.custom_name || pm.filename;

    const videoEl = document.getElementById('wsVideoEl');
    const audioEl = document.getElementById('wsAudioEl');
    const audioIcon = document.getElementById('wsAudioOnlyIcon');

    monitorIsAudio = isMediaAudioOnly(pm);
    const fileUrl = `file:///${(pm.filepath || '').replace(/\\/g, '/')}`;

    // Pausa e limpa fonte anterior
    videoEl.pause(); audioEl.pause();
    videoEl.removeAttribute('src'); audioEl.removeAttribute('src');
    videoEl.load(); audioEl.load();

    if (monitorIsAudio) {
      videoEl.classList.add('hidden');
      audioIcon.classList.remove('hidden');
      audioEl.src = fileUrl;
      monitorEl = audioEl;
    } else {
      videoEl.classList.remove('hidden');
      audioIcon.classList.add('hidden');
      videoEl.src = fileUrl;
      monitorEl = videoEl;
    }

    monitorEl.onloadedmetadata = () => {
      markOut = monitorEl.duration || pm.duration || 0;
      document.getElementById('wsTcDuration').textContent = secondsToTimecode(monitorEl.duration, pm.fps || 30);
      document.getElementById('wsScrubber').max = String(Math.floor((monitorEl.duration || 0) * 1000));
      updateIoUi();
    };
    monitorEl.ontimeupdate = () => {
      document.getElementById('wsTcCurrent').textContent = secondsToTimecode(monitorEl.currentTime, pm.fps || 30);
      document.getElementById('wsScrubber').value = String(Math.floor(monitorEl.currentTime * 1000));
      // Corrige deriva leve entre as linhas extras e o player principal
      monitorTrackAudioEls.forEach(el => {
        if (el && Math.abs(el.currentTime - monitorEl.currentTime) > 0.25) {
          el.currentTime = monitorEl.currentTime;
        }
      });
    };
    monitorEl.onplay = () => {
      document.getElementById('wsPlayIcon').textContent = 'pause';
      monitorTrackAudioEls.forEach(el => { if (el) { el.currentTime = monitorEl.currentTime; el.play().catch(() => {}); } });
    };
    monitorEl.onpause = () => {
      document.getElementById('wsPlayIcon').textContent = 'play_arrow';
      monitorTrackAudioEls.forEach(el => { if (el) el.pause(); });
    };
    monitorEl.onseeked = () => {
      monitorTrackAudioEls.forEach(el => { if (el) el.currentTime = monitorEl.currentTime; });
    };

    loadWaveformForMonitor(pm);

  } catch (e) {
    console.error('[WORKSPACE] Erro ao carregar mídia no monitor:', e);
    setAppStatus('Erro ao carregar mídia no monitor.', 'error');
  }
}

function secondsToTimecode(totalSeconds, fps = 30) {  if (!totalSeconds || isNaN(totalSeconds)) return '00:00:00:00';
  const fr = Math.max(1, Math.round(fps));
  const totalFrames = Math.floor(totalSeconds * fr);
  const h = Math.floor(totalFrames / (fr * 3600));
  const m = Math.floor((totalFrames % (fr * 3600)) / (fr * 60));
  const s = Math.floor((totalFrames % (fr * 60)) / fr);
  const f = totalFrames % fr;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

// --- FASE 5: Waveform (geração/cache via WaveformService + render em canvas) ---
// --- FASE 5b: até 3 linhas de áudio visíveis ao mesmo tempo, cada uma com
//     mudo independente durante o preview (elementos <audio> extraídos e
//     sincronizados ao player principal, já que o Chromium não mixa
//     múltiplas tracks nativas de um mesmo arquivo com volume separado) ---
const MAX_MONITOR_AUDIO_TRACKS = 3;
let monitorTrackAudioEls = []; // <audio> extras sincronizados ao monitorEl

function teardownMonitorTrackAudio() {
  monitorTrackAudioEls.forEach(el => {
    try { el.pause(); el.src = ''; el.remove(); } catch (_) {}
  });
  monitorTrackAudioEls = [];
}

async function loadWaveformForMonitor(pm) {
  const container = document.getElementById('wsWaveformsContainer');
  if (!container) return;
  container.innerHTML = '';
  teardownMonitorTrackAudio();

  if (!pm.audio_codec && !monitorIsAudio) return; // sem faixa de áudio, nada a desenhar
  if (!pm.uuid || !pm.filepath) return;

  try {
    // Proba se o arquivo tem múltiplas tracks de áudio
    let audioStreams = [];
    if (window.bds.probeAudioStreams) {
      try {
        audioStreams = await window.bds.probeAudioStreams(pm.filepath);
      } catch (e) {}
    }

    if (!audioStreams || audioStreams.length === 0) {
      audioStreams = [{ index: 0, title: 'Audio 1', codec_name: pm.audio_codec || 'audio' }];
    }

    const visibleStreams = audioStreams.slice(0, MAX_MONITOR_AUDIO_TRACKS);
    if (audioStreams.length > MAX_MONITOR_AUDIO_TRACKS) {
      const notice = document.createElement('div');
      notice.style.cssText = 'font-size:10px; color:var(--muted); padding:2px 4px;';
      notice.textContent = `Mostrando ${MAX_MONITOR_AUDIO_TRACKS} de ${audioStreams.length} linhas de áudio.`;
      container.appendChild(notice);
    }

    // A track 0 já toca nativamente pelo monitorEl (video/audio principal).
    // Track 0 é sempre mudável via um <audio> espelho silencioso do próprio
    // monitorEl (para não duplicar som) — as demais (1, 2) são extraídas e
    // tocadas em elementos próprios, sincronizados ao monitorEl.
    for (let i = 0; i < visibleStreams.length; i++) {
      const stream = visibleStreams[i];
      const streamIndex = stream.index ?? i;
      const trackWrap = document.createElement('div');
      trackWrap.style.cssText = 'display:flex; flex-direction:column; gap:2px; width:100%; position:relative;';

      const label = document.createElement('div');
      label.style.cssText = 'font-size:10px; color:var(--muted); font-weight:700; padding-left:4px; display:flex; align-items:center; justify-content:space-between; gap:6px;';

      const muteBtn = document.createElement('button');
      muteBtn.type = 'button';
      muteBtn.className = 'ws-track-mute-btn';
      muteBtn.title = `Silenciar linha ${i + 1}`;
      muteBtn.style.cssText = 'background:none; border:0.5px solid var(--border, #444); border-radius:4px; width:20px; height:18px; padding:0; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; color:#22c55e;';
      muteBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:13px;">volume_up</span>';

      let isMuted = false;
      const applyMute = () => {
        if (i === 0) {
          // Track principal: muta o próprio monitorEl
          if (monitorEl) monitorEl.muted = isMuted;
        } else {
          const trackEl = monitorTrackAudioEls[i];
          if (trackEl) trackEl.muted = isMuted;
        }
        muteBtn.style.color = isMuted ? 'var(--danger, #ef4444)' : '#22c55e';
        muteBtn.title = isMuted ? `Ativar linha ${i + 1}` : `Silenciar linha ${i + 1}`;
        muteBtn.querySelector('span').textContent = isMuted ? 'volume_off' : 'volume_up';
      };
      muteBtn.addEventListener('click', () => { isMuted = !isMuted; applyMute(); });

      label.innerHTML = `<span><span style="color:#22c55e;">A${i+1}</span> (${stream.codec_name || 'audio'})</span><span>${escapeHtml(stream.title || '')}</span>`;
      label.appendChild(muteBtn);
      trackWrap.appendChild(label);

      const canvas = document.createElement('canvas');
      canvas.className = 'ws-waveform-canvas';
      canvas.height = 36;
      canvas.style.cssText = 'width:100%; height:36px; background:rgba(0,0,0,0.3); border-radius:4px; display:block;';
      trackWrap.appendChild(canvas);

      container.appendChild(trackWrap);

      // Carrega o waveform desta stream
      window.bds.getMediaWaveform({
        uuid: pm.uuid,
        filePath: pm.filepath,
        duration: pm.duration || 0,
        peaksPerSecond: 100,
        streamIndex
      }).then(wf => {
        if (monitorMedia?.pm_id === pm.pm_id && wf && wf.peaks) {
          drawWaveformOnCanvas(canvas, wf.peaks);
        }
      }).catch(err => {
        console.warn(`[WORKSPACE] Waveform indisponível para track ${i+1}:`, err.message);
      });

      // Para linhas além da 0, extrai e sincroniza um <audio> próprio
      if (i > 0 && window.bds.getTrackAudioPath) {
        window.bds.getTrackAudioPath({ uuid: pm.uuid, filePath: pm.filepath, streamIndex }).then(url => {
          if (monitorMedia?.pm_id !== pm.pm_id || !monitorEl) return;
          const trackEl = new Audio(url);
          trackEl.preload = 'auto';
          trackEl.currentTime = monitorEl.currentTime || 0;
          if (monitorEl.paused) trackEl.pause(); else trackEl.play().catch(() => {});
          monitorTrackAudioEls[i] = trackEl;
        }).catch(err => {
          console.warn(`[WORKSPACE] Não foi possível extrair a linha de áudio ${i + 1}:`, err.message);
        });
      }
    }
  } catch (e) {
    console.warn('[WORKSPACE] Waveform indisponível:', e.message);
  }
}

function drawWaveformOnCanvas(canvas, peaks) {
  if (!canvas || !peaks || peaks.length === 0) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth || 600;
  const h = canvas.height;
  const mid = h / 2;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(34, 197, 94, 0.65)';

  const step = peaks.length / w;
  for (let x = 0; x < w; x++) {
    const idx = Math.floor(x * step);
    const amp = peaks[idx] || 0;
    const barHeight = Math.max(1, amp * mid * 0.95);
    ctx.fillRect(x, mid - barHeight, 1, barHeight * 2);
  }
}

function drawWaveform(peaks) {
  const canvas = document.getElementById('wsWaveformCanvas');
  if (canvas) drawWaveformOnCanvas(canvas, peaks);
}

function updateIoUi() {
  if (!monitorEl || !monitorMedia) return;
  const dur = monitorEl.duration || monitorMedia.duration || 1;
  const fps = monitorMedia.fps || 30;
  const inPct = Math.min(100, (markIn / dur) * 100);
  const outPct = Math.min(100, ((hasOut ? markOut : dur) / dur) * 100);
  const range = document.getElementById('wsIoRange');
  if (range) {
    range.style.left = `${inPct}%`;
    range.style.width = `${Math.max(0, outPct - inPct)}%`;
  }
  document.getElementById('wsInLabel').textContent = secondsToTimecode(markIn, fps);
  document.getElementById('wsOutLabel').textContent = hasOut ? secondsToTimecode(markOut, fps) : '--:--:--:--';
  document.getElementById('wsSelDurationLabel').textContent = hasOut ? secondsToTimecode(Math.max(0, markOut - markIn), fps) : '--:--:--:--';
}

function monitorMarkIn() {
  if (!monitorEl) return;
  markIn = monitorEl.currentTime;
  if (hasOut && markIn > markOut) markOut = markIn;
  updateIoUi();
}

function monitorMarkOut() {
  if (!monitorEl) return;
  markOut = monitorEl.currentTime;
  hasOut = true;
  if (markOut < markIn) markIn = markOut;
  updateIoUi();
}

function monitorTogglePlay() {
  if (!monitorEl) return;
  if (monitorEl.paused) monitorEl.play(); else monitorEl.pause();
}

function monitorStepFrame(dir) {
  if (!monitorEl || !monitorMedia) return;
  const fps = monitorMedia.fps || 30;
  monitorEl.pause();
  monitorEl.currentTime = Math.max(0, Math.min(monitorEl.duration || 0, monitorEl.currentTime + (dir / fps)));
}

function setupMonitorKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (centerTab !== 'monitor' || !monitorEl) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

    switch (e.key.toLowerCase()) {
      case 'i':
        e.preventDefault();
        monitorMarkIn();
        break;
      case 'o':
        e.preventDefault();
        monitorMarkOut();
        break;
      case ' ':
      case 'k':
        e.preventDefault();
        monitorTogglePlay();
        break;
      case 'j':
        e.preventDefault();
        monitorStepFrame(-1);
        break;
      case 'l':
        e.preventDefault();
        monitorStepFrame(1);
        break;
      default:
        break;
    }
  });
}

// ==========================================================================
// FASE 6 — SINCRONIZAÇÃO AUTOMÁTICA POR ÁUDIO
// ==========================================================================

async function runAudioSyncOnSelection() {
  if (syncSelection.size < 2) {
    window.bdsModal.alert('Selecione ao menos 2 mídias (Ctrl+clique) para sincronizar por áudio.');
    return;
  }

  const selectedPm = projectMedia.filter(pm => syncSelection.has(pm.pm_id));
  const withoutAudio = selectedPm.filter(pm => !pm.audio_codec);
  if (withoutAudio.length > 0) {
    const proceed = await window.bdsModal.confirm(
      `${withoutAudio.length} mídia(s) selecionada(s) não possuem faixa de áudio detectada e podem falhar na sincronização. Continuar mesmo assim?`
    );
    if (!proceed) return;
  }

  // Master = mídia com maior duração (normalmente a câmera principal / referência mais longa)
  const master = [...selectedPm].sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];

  const groupName = await window.bdsModal.prompt('Nome do Sync Group:', `Sync ${new Date().toLocaleTimeString('pt-BR')}`);
  if (groupName === null) return; // usuário cancelou

  const mediaList = selectedPm.map(pm => ({ id: pm.id, filepath: pm.filepath }));

  setAppStatus(`Sincronizando ${mediaList.length} mídias por áudio...`, 'info');

  const progressCleanup = window.bds.onAudioSyncProgress(({ mediaId, status }) => {
    const pm = selectedPm.find(p => p.id === mediaId);
    const label = pm ? (pm.custom_name || pm.filename) : mediaId;
    const statusLabels = {
      extracting: 'extraindo áudio',
      correlating: 'calculando correlação',
      done: 'concluído',
      error: 'erro'
    };
    setAppStatus(`Sync: ${label} — ${statusLabels[status] || status}`, status === 'error' ? 'error' : 'info');
  });

  try {
    const { groupId, results } = await window.bds.runAudioSync({
      projectId,
      groupName: groupName || undefined,
      masterMediaId: master.id,
      mediaList,
      maxOffsetSeconds: 30
    });

    const summary = results.map(r => {
      const pm = selectedPm.find(p => p.id === r.media_id);
      const label = pm ? (pm.custom_name || pm.filename) : r.media_id;
      const isMaster = r.media_id === master.id;
      const offsetMs = Math.round(r.offset_seconds * 1000);
      const confidencePct = Math.round((r.confidence || 0) * 100);
      return isMaster
        ? `• ${label}: MASTER (offset 0ms)`
        : `• ${label}: ${offsetMs >= 0 ? '+' : ''}${offsetMs}ms (confiança ${confidencePct}%)${r.error ? ` — erro: ${r.error}` : ''}`;
    }).join('\n');

    setAppStatus('Sincronização por áudio concluída.', 'success');
    await window.bdsModal.alert(`Sync Group #${groupId} criado com sucesso:\n\n${summary}`);

    syncSelection.clear();
    renderTree();
    updateSyncSelectionHint();
    await reloadSyncGroups();
  } catch (e) {
    console.error('[WORKSPACE] Erro na sincronização por áudio:', e);
    setAppStatus('Erro ao sincronizar por áudio.', 'error');
    window.bdsModal.alert(`Erro ao sincronizar por áudio: ${e.message || e}`);
  } finally {
    if (typeof progressCleanup === 'function') progressCleanup();
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function setupEventListeners() {
  document.getElementById('wsBtnBack')?.addEventListener('click', goBack);

  // --- FASE B: Cabeçalho, Capa e Resumo do Projeto ---
  document.getElementById('wsCoverWrapper')?.addEventListener('click', pickProjectCover);
  document.getElementById('wsProjectStatus')?.addEventListener('change', (e) => {
    markHeaderDirty('status', e.target.value);
  });
  document.getElementById('wsBtnSaveProject')?.addEventListener('click', saveProjectHeader);
  document.getElementById('wsBtnExportBdspro')?.addEventListener('click', exportProjectBdspro);

  // --- FASE H: Relink de mídia ausente ---
  document.getElementById('wsBtnRelinkFolder')?.addEventListener('click', openRelinkFlow);
  document.getElementById('wsBtnCloseRelinkModal')?.addEventListener('click', closeRelinkModal);
  document.getElementById('wsBtnConfirmRelink')?.addEventListener('click', confirmRelink);

  // --- FASE 4: Tabs do centro (Bins / Source Monitor) ---
  document.getElementById('wsTabBins')?.addEventListener('click', () => switchCenterTab('bins'));
  document.getElementById('wsTabMonitor')?.addEventListener('click', () => switchCenterTab('monitor'));
  document.getElementById('wsTabSync')?.addEventListener('click', () => switchCenterTab('sync'));

  // --- FASE C: Filtro de tipo de mídia (Todos / Vídeos / Áudios) ---
  document.querySelectorAll('.ws-media-filter').forEach(btn => {
    btn.addEventListener('click', () => setMediaTypeFilter(btn.dataset.filter));
  });

  // --- FASE 4: Tabs do inspetor (Info / Metadados BDSM) ---
  document.getElementById('wsInspTabInfo')?.addEventListener('click', () => setInspectorTab('info'));
  document.getElementById('wsInspTabMeta')?.addEventListener('click', () => setInspectorTab('meta'));

  // --- FASE 4: Controles do Source Monitor ---
  document.getElementById('wsBtnMarkIn')?.addEventListener('click', monitorMarkIn);
  document.getElementById('wsBtnMarkOut')?.addEventListener('click', monitorMarkOut);
  document.getElementById('wsBtnPlayPause')?.addEventListener('click', monitorTogglePlay);
  document.getElementById('wsBtnFrameBack')?.addEventListener('click', () => monitorStepFrame(-1));
  document.getElementById('wsBtnFrameFwd')?.addEventListener('click', () => monitorStepFrame(1));
  document.getElementById('wsScrubber')?.addEventListener('input', (e) => {
    if (!monitorEl) return;
    monitorEl.currentTime = Number(e.target.value) / 1000;
  });

  // --- FASE 6: Sincronização por Áudio ---
  document.getElementById('wsBtnSyncAudio')?.addEventListener('click', runAudioSyncOnSelection);

  // --- Importação Direta de Arquivos ---
  document.getElementById('wsBtnImportFiles')?.addEventListener('click', importFilesViaDialog);
  setupImportDropzone();

  // --- Importar da Biblioteca (modal) ---
  document.getElementById('wsBtnImportLibrary')?.addEventListener('click', openImportLibraryModal);
  document.getElementById('wsBtnCloseImportModal')?.addEventListener('click', closeImportLibraryModal);
  document.getElementById('wsImportLibraryModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'wsImportLibraryModal') closeImportLibraryModal();
  });
  document.getElementById('wsImportModalSearch')?.addEventListener('input', renderImportModalList);
  document.getElementById('wsBtnConfirmImportLibrary')?.addEventListener('click', confirmImportFromLibrary);

  document.getElementById('wsBtnReloadLib')?.addEventListener('click', reloadLibrary);
  document.getElementById('wsLibSearch')?.addEventListener('input', renderLibrary);
  document.getElementById('wsBtnNewBin')?.addEventListener('click', async () => {
    const parentId = selectedItem?.type === 'bin' ? selectedItem.id : null;
    const name = await window.bdsModal.prompt('Nome da Nova Pasta:');
    if (name?.trim()) {
      try {
        await window.bds.createProjectBin(projectId, parentId, name.trim());
        await reloadTree();
      } catch (e) {
        console.error(e);
      }
    }
  });
  document.getElementById('wsBtnSaveItem')?.addEventListener('click', async () => {
    if (!selectedItem) return;
    const newName = document.getElementById('wsInputItemName').value.trim();
    if (!newName) return;
    try {
      if (selectedItem.type === 'bin') {
        const bin = bins.find(b => b.id === selectedItem.id);
        await window.bds.updateProjectBin(bin.id, newName, bin.parent_id);
      }
      await reloadTree();
    } catch (e) {
      console.error(e);
    }
  });
  document.getElementById('wsBtnDeleteItem')?.addEventListener('click', async () => {
    if (!selectedItem) return;
    const conf = await window.bdsModal.confirm('Remover item selecionado do projeto?');
    if (!conf) return;
    try {
      if (selectedItem.type === 'bin') {
        await window.bds.deleteProjectBin(selectedItem.id);
      } else {
        await window.bds.removeProjectMedia(selectedItem.id);
      }
      selectedItem = null;
      await reloadTree();
    } catch (e) {
      console.error(e);
    }
  });
  document.getElementById('wsBtnExportPremiere')?.addEventListener('click', async () => {
    const folder = await window.bds.selectFolder();
    if (folder) {
      const outputPath = `${folder}\\${project.name || 'Projeto'} - Pastas.xml`;
      try {
        await window.bds.exportProjectPremiere(projectId, outputPath);
        setAppStatus('XML gerado com sucesso!', 'success');
        await window.bds.openLocalPath(folder);
      } catch (e) {
        console.error(e);
        window.bdsModal.alert('Erro ao exportar XML.');
      }
    }
  });

  // --- FASE F/G: Gerar Sequência para Premiere (a partir dos Sync Groups) ---
  document.getElementById('wsBtnExportSequencePremiere')?.addEventListener('click', async () => {
    if (syncGroupsCache.length === 0) {
      const proceed = await window.bdsModal.confirm(
        'Nenhum Sync Group encontrado neste projeto. A sequência será gerada apenas com as mídias soltas, cada uma começando em 00:00. Deseja continuar?'
      );
      if (!proceed) return;
    }
    const folder = await window.bds.selectFolder();
    if (!folder) return;
    const outputPath = `${folder}\\${project.name || 'Projeto'} - Sequência.xml`;
    try {
      setAppStatus('Gerando sequência...', 'info');
      await window.bds.exportProjectSequencePremiere(projectId, outputPath);
      setAppStatus('Sequência exportada com sucesso!', 'success');
      await window.bds.openLocalPath(folder);
    } catch (e) {
      console.error('[WORKSPACE] Erro ao gerar sequência:', e);
      window.bdsModal.alert(`Erro ao gerar sequência: ${e.message || e}`);
    }
  });
}