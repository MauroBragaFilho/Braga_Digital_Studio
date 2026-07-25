let luts = [];
let filteredLuts = [];
let selectedLut = null;

// Referências DOM
let lutsGrid;
let emptyState;
let ftTotal;
let ftSelected;
let inspector;
let sliderContainer;
let sliderOverlay;
let sliderDivider;
let sliderTargetImg;

// Filtros
let searchInput;
let sortFilter;

// Modal Tela Cheia
let fsModal;
let fsSliderContainer;
let fsSliderOverlay;
let fsSliderDivider;
let fsSliderTargetImg;

export function initScreen() {
  document.getElementById('btnImportLut').addEventListener('click', importLut);
  document.getElementById('btnRefreshLuts').addEventListener('click', loadLuts);
  
  lutsGrid = document.getElementById('lutsGrid');
  emptyState = document.getElementById('lutsEmptyState');
  ftTotal = document.getElementById('ftTotal');
  ftSelected = document.getElementById('ftSelected');
  
  searchInput = document.getElementById('lutSearchInput');
  sortFilter = document.getElementById('lutSortFilter');
  
  searchInput.addEventListener('input', applyFilters);
  sortFilter.addEventListener('change', applyFilters);
  
  // Inspector Actions
  document.getElementById('btnSendLutToBDSM').addEventListener('click', sendToBDSM);
  document.getElementById('btnDeleteLut').addEventListener('click', deleteLut);
  document.getElementById('btnRenameLut').addEventListener('click', renameLut);
  document.getElementById('btnFullscreenLut').addEventListener('click', openFullscreen);
  
  // Slider Logic (Inspector)
  sliderContainer = document.getElementById('lutSliderContainer');
  sliderOverlay = document.getElementById('lutSliderOverlay');
  sliderDivider = document.getElementById('lutSliderDivider');
  sliderTargetImg = document.getElementById('lutSliderTargetImg');
  setupSlider(sliderContainer, sliderOverlay, sliderDivider);
  
  // Slider Logic (Fullscreen)
  fsModal = document.getElementById('lutFullscreenModal');
  fsSliderContainer = document.getElementById('fsSliderContainer');
  fsSliderOverlay = document.getElementById('fsSliderOverlay');
  fsSliderDivider = document.getElementById('fsSliderDivider');
  fsSliderTargetImg = document.getElementById('fsSliderTargetImg');
  document.getElementById('btnFsClose').addEventListener('click', () => { fsModal.style.display = 'none'; });
  setupSlider(fsSliderContainer, fsSliderOverlay, fsSliderDivider);
  
  loadLuts();
}

function setupSlider(container, overlay, divider) {
  let isDragging = false;

  const onDrag = (e) => {
    if (!isDragging) return;
    
    const clientX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
    const rect = container.getBoundingClientRect();
    
    let x = clientX - rect.left;
    let percentage = (x / rect.width) * 100;
    
    if (percentage < 0) percentage = 0;
    if (percentage > 100) percentage = 100;
    
    overlay.style.width = `${percentage}%`;
    divider.style.left = `${percentage}%`;
  };

  container.addEventListener('mousedown', () => isDragging = true);
  container.addEventListener('touchstart', () => isDragging = true);
  
  window.addEventListener('mouseup', () => isDragging = false);
  window.addEventListener('touchend', () => isDragging = false);
  
  window.addEventListener('mousemove', onDrag);
  window.addEventListener('touchmove', onDrag);
}

async function loadLuts() {
  try {
    luts = await window.bds.getLuts();
    applyFilters();
  } catch (err) {
    console.error('Erro ao carregar LUTs', err);
  }
}

function applyFilters() {
  const query = searchInput.value.toLowerCase();
  const sort = sortFilter.value;
  
  filteredLuts = luts.filter(lut => lut.name.toLowerCase().includes(query));
  
  if (sort === 'Nome (A-Z)') {
    filteredLuts.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === 'Tamanho') {
    filteredLuts.sort((a, b) => b.size - a.size);
  } else {
    // Mais recentes
    filteredLuts.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
  }
  
  // Se o selecionado nao esta no filtro, deseleciona
  if (selectedLut && !filteredLuts.find(l => l.path === selectedLut.path)) {
    selectLut(null);
  }
  
  renderGrid();
}

function renderGrid() {
  lutsGrid.innerHTML = '';
  
  if (!filteredLuts || filteredLuts.length === 0) {
    emptyState.style.display = 'flex';
    ftTotal.textContent = '0 LUTs';
    if (!selectedLut) selectLut(null);
    return;
  }
  
  emptyState.style.display = 'none';
  ftTotal.textContent = `${filteredLuts.length} LUT${filteredLuts.length !== 1 ? 's' : ''}`;
  
  filteredLuts.forEach((lut) => {
    const isSelected = selectedLut && selectedLut.path === lut.path;
    
    const card = document.createElement('div');
    card.className = `lut-card ${isSelected ? 'selected' : ''}`;
    card.onclick = () => selectLut(lut);
    
    const dateObj = lut.modifiedAt ? new Date(lut.modifiedAt) : new Date();
    const dateStr = dateObj.toLocaleDateString('pt-BR');
    
    // Filtro visual mockado
    const visualFilter = `hue-rotate(${lut.name.length * 10}deg) saturate(${100 + (lut.size % 50)}%)`;
    
    card.innerHTML = `
      <img src="./assets/lut_preview.jpg" class="lut-card-img" style="filter: ${visualFilter};">
      <span class="lut-badge-3d">3D</span>
      <div class="lut-checkbox"><span class="material-symbols-rounded">check</span></div>
      
      <div class="lut-card-body">
        <div class="lut-card-info">
          <span class="lut-card-title" title="${lut.name}">${lut.name}</span>
          <div class="lut-card-meta">
            <span>.cube</span>
            <span>${dateStr}</span>
          </div>
        </div>
        <button class="lut-icon-btn small" title="Mais opções" onclick="event.stopPropagation()">
          <span class="material-symbols-rounded" style="font-size: 16px;">more_vert</span>
        </button>
      </div>
    `;
    lutsGrid.appendChild(card);
  });
}

function selectLut(lut) {
  selectedLut = lut;
  renderGrid();
  updateInspector();
}

function updateInspector() {
  const btnApply = document.getElementById('btnSendLutToBDSM');
  const btnFullscreen = document.getElementById('btnFullscreenLut');
  const btnRename = document.getElementById('btnRenameLut');
  const btnDelete = document.getElementById('btnDeleteLut');
  
  if (!selectedLut) {
    ftSelected.textContent = '0 LUTs';
    document.getElementById('insName').textContent = 'Selecione um LUT';
    document.getElementById('insType').textContent = '--';
    document.getElementById('insSize').textContent = '--';
    document.getElementById('insDate').textContent = '--';
    document.getElementById('insPath').textContent = '--';
    
    sliderTargetImg.style.filter = 'none';
    
    btnApply.disabled = true;
    btnFullscreen.disabled = true;
    btnRename.disabled = true;
    btnDelete.disabled = true;
    return;
  }
  
  ftSelected.textContent = '1 LUT';
  const dateObj = selectedLut.modifiedAt ? new Date(selectedLut.modifiedAt) : new Date();
  
  document.getElementById('insName').textContent = selectedLut.name;
  document.getElementById('insType').textContent = '3D LUT';
  document.getElementById('insSize').textContent = formatBytes(selectedLut.size);
  document.getElementById('insDate').textContent = dateObj.toLocaleDateString('pt-BR') + ' ' + dateObj.toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'});
  document.getElementById('insPath').textContent = selectedLut.path;
  
  const visualFilter = `hue-rotate(${selectedLut.name.length * 10}deg) saturate(${100 + (selectedLut.size % 50)}%)`;
  sliderTargetImg.style.filter = visualFilter;
  
  btnApply.disabled = false;
  btnFullscreen.disabled = false;
  btnRename.disabled = false;
  btnDelete.disabled = false;
}

// ACOES
async function importLut() {
  try {
    const success = await window.bds.importLut();
    if (success) await loadLuts();
  } catch (err) {
    console.error('Erro ao importar LUT', err);
  }
}

async function deleteLut() {
  if (!selectedLut) return;
  const confirmDelete = confirm(`Tem certeza que deseja excluir "${selectedLut.name}"?`);
  if (!confirmDelete) return;
  
  try {
    const success = await window.bds.deleteLut(selectedLut.path);
    if (success) {
      selectedLut = null;
      await loadLuts();
    }
  } catch (err) {
    alert('Erro ao excluir LUT: ' + err.message);
  }
}

async function renameLut() {
  if (!selectedLut) return;
  
  let newName = prompt('Digite o novo nome para o LUT (sem a extensão .cube):', selectedLut.name.replace('.cube', ''));
  if (!newName) return; // Cancelou
  
  if (newName.toLowerCase() === selectedLut.name.replace('.cube', '').toLowerCase()) return;
  
  try {
    const success = await window.bds.renameLut(selectedLut.path, newName);
    if (success) {
      selectedLut = null;
      await loadLuts();
    }
  } catch (err) {
    alert('Erro ao renomear LUT: ' + err.message);
  }
}

function openFullscreen() {
  if (!selectedLut) return;
  
  document.getElementById('fsLutName').textContent = selectedLut.name;
  
  const visualFilter = `hue-rotate(${selectedLut.name.length * 10}deg) saturate(${100 + (selectedLut.size % 50)}%)`;
  fsSliderTargetImg.style.filter = visualFilter;
  
  fsModal.style.display = 'flex';
}

async function sendToBDSM() {
  if (!selectedLut) return;
  
  const btn = document.getElementById('btnSendLutToBDSM');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span class="material-symbols-rounded" style="font-size: 16px; animation: spin 1s linear infinite;">sync</span> APLICANDO...';
  
  // Simula aplicacao por 1.5s
  setTimeout(() => {
    btn.innerHTML = '<span class="material-symbols-rounded" style="font-size: 16px;">check</span> APLICADO COM SUCESSO';
    setTimeout(() => {
      btn.innerHTML = originalText;
    }, 2000);
  }, 1500);
}

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}
