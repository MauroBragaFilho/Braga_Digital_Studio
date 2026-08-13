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

export async function initScreen() {
  try {
    const app = await import('../app.js');
    projectId = app.state.currentProjectId;
    if (!projectId) return goBack();

    await loadInitialData();
    setupEventListeners();
  } catch (e) {
    console.error('[WORKSPACE] Erro na inicialização:', e);
    setAppStatus('Erro ao carregar workspace', 'error');
  }
}

function goBack() {
  import('../app.js').then(app => {
    app.state.currentProjectId = null;
    document.getElementById('navProjetos')?.click(); // Volta para Projetos
  });
}

async function loadInitialData() {
  try {
    project = await window.bds.getProject(projectId);
    if (!project) return goBack();

    document.getElementById('wsProjectName').textContent = project.name;
    await reloadLibrary();
    await reloadTree();
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

function renderTree() {
  const container = document.getElementById('wsBinsTree');
  container.innerHTML = '';

  const rootBins = bins.filter(b => !b.parent_id);
  const rootMedia = projectMedia.filter(m => !m.bin_id);

  rootBins.forEach(bin => container.appendChild(createBinNode(bin)));
  rootMedia.forEach(pm => container.appendChild(createMediaNode(pm)));

  container.addEventListener('dragover', e => e.preventDefault());
  container.addEventListener('drop', e => {
    e.preventDefault();
    if (draggedItem) handleDrop(null);
  });
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
  projectMedia.filter(m => m.bin_id === bin.id).forEach(pm => children.appendChild(createMediaNode(pm)));

  wrapper.appendChild(children);
  return wrapper;
}

function createMediaNode(pm) {
  const el = document.createElement('div');
  el.className = `ws-bin-media ${selectedItem?.type === 'project_media' && selectedItem.id === pm.pm_id ? 'selected' : ''}`;
  const icon = pm.extension === 'MP3' || pm.extension === 'WAV' ? 'audiotrack' :
               ['JPG','PNG','WEBP'].includes(pm.extension) ? 'image' : 'movie';
  const name = pm.custom_name || pm.filename;
  el.innerHTML = `
    <span class="material-symbols-rounded" style="font-size: 16px;">${icon}</span>
    <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(name)}</span>
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
    selectItem('project_media', pm.pm_id);
  });
  return el;
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
    }
  } else {
    const pm = projectMedia.find(m => m.pm_id === selectedItem.id);
    if (pm) {
      inputName.value = pm.custom_name || pm.filename;
      mediaPreview?.classList.remove('hidden');
      const thumbUrl = pm.thumbnail_path ? `url('file:///${pm.thumbnail_path.replace(/\\/g, '/')}')` : 'none';
      document.getElementById('wsMediaThumb').style.backgroundImage = thumbUrl;
      document.getElementById('wsMediaPath').textContent = pm.filepath;
      document.getElementById('wsMediaSize').textContent = formatBytes(pm.filesize);
    }
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
  document.getElementById('wsBtnReloadLib')?.addEventListener('click', reloadLibrary);
  document.getElementById('wsLibSearch')?.addEventListener('input', renderLibrary);
  document.getElementById('wsBtnNewBin')?.addEventListener('click', async () => {
    const parentId = selectedItem?.type === 'bin' ? selectedItem.id : null;
    const name = await window.bdsModal.prompt('Nome da Nova Pasta (Bin):');
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
    const folderRes = await window.bds.selectFolder();
    if (folderRes?.filePaths?.[0]) {
      const folder = folderRes.filePaths[0];
      const outputPath = `${folder}\\${project.name || 'Projeto'}.xml`;
      try {
        await window.bds.exportProjectPremiere(projectId, outputPath);
        setAppStatus('XML gerado com sucesso!', 'success');
        await window.bds.openPath(folder);
      } catch (e) {
        console.error(e);
        window.bdsModal.alert('Erro ao exportar XML.');
      }
    }
  });
}