let viewMode = 'grid'; // 'grid' | 'list'
let mediaItems = [];
let thumbsDir = '';
let currentSearch = '';
let currentFilters = {
  types: [],
  origins: [],
  albums: [],
  resolutions: [],
  fps: [],
  dates: [],
  projects: [],
  tags: [],
  favorites: false
};
let selectedIds = new Set();
let lastSelectedId = null; // para shift-click se der tempo
let currentSort = 'recorded_at'; // ou 'imported_at'

export async function initScreen() {
  console.log('Library screen initialized');

  if (window.bds && window.bds.getThumbDir) {
    thumbsDir = await window.bds.getThumbDir();
    thumbsDir = 'file:///' + thumbsDir.replace(/\\/g, '/');
  }

  // View toggles
  document.getElementById('btnViewGrid').addEventListener('click', () => setViewMode('grid'));
  document.getElementById('btnViewList').addEventListener('click', () => setViewMode('list'));
  
  const btnReload = document.getElementById('btnReloadLibrary');
  if (btnReload) {
    btnReload.addEventListener('click', async () => {
      if (window.bds && window.bds.rescanAllLibrary) {
        await window.bds.rescanAllLibrary();
      }
      fetchMedia();
    });
  }

  // Search input global with debounce (evitar duplicação clonando o node)
  
  const selectSort = document.getElementById('selectSort');
  if (selectSort) {
    selectSort.value = currentSort;
    selectSort.addEventListener('change', (e) => {
      currentSort = e.target.value;
      fetchMedia();
    });
  }

  const btnSortOrder = document.getElementById('btnSortOrder');
  if (btnSortOrder) {
    btnSortOrder.addEventListener('click', () => {
      currentSortOrder = currentSortOrder === 'DESC' ? 'ASC' : 'DESC';
      btnSortOrder.textContent = currentSortOrder === 'DESC' ? 'arrow_downward' : 'arrow_upward';
      fetchMedia();
    });
  }
  const oldSearch = document.getElementById('globalSearch');
  const newSearch = oldSearch.cloneNode(true);
  oldSearch.parentNode.replaceChild(newSearch, oldSearch);
  
  let searchTimeout;
  newSearch.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      currentSearch = e.target.value.trim();
      fetchMedia();
    }, 300);
  });

  // Filter checkboxes
  const checkboxes = document.querySelectorAll('.lib-filter-chk');
  checkboxes.forEach(chk => {
    chk.addEventListener('change', () => {
      updateFilters();
      fetchMedia();
    });
  });

  // Inspector Buttons
  document.getElementById('closeInspectorBtn').addEventListener('click', closeInspector);
  document.getElementById('btnPlayMedia').addEventListener('click', () => {
    if (currentInspectorMedia && window.bdsPlayer) {
      window.bdsPlayer.play(currentInspectorMedia.filepath, currentInspectorMedia.filename);
    }
  });

  // Escuta novos arquivos pra atualizar automaticamente a biblioteca
  if (window.bds && window.bds.onMediaImported && !window.libraryListenerRegistered) {
    window.libraryListenerRegistered = true;
    window.bds.onMediaImported(() => {
      // Pequeno timeout para não recarregar loucamente se vierem muitos arquivos
      setTimeout(() => {
        loadFilterOptions();
        fetchMedia();
      }, 50); 
    });
  }
  
  // Limpar Filtros
  const btnLimpar = document.getElementById('btnLimparFiltros');
  if (btnLimpar) {
    btnLimpar.addEventListener('click', () => {
      document.querySelectorAll('.lib-filter-chk').forEach(chk => {
        chk.checked = false;
        const icon = chk.nextElementSibling;
        if (icon) icon.textContent = 'check_box_outline_blank';
      });
      updateFilters();
      fetchMedia();
    });
  }

  // Inicializar Modal Custom Source
  setupCustomSourceModal();
  await loadFilterOptions();
  fetchMedia();

  // Binds the inspector events
  bindInspectorEvents();
}

function setupCustomSourceModal() {
  const modal = document.getElementById('modalAddCustomSource');
  const btnOpen = document.getElementById('btnAddCustomSourceBtn');
  const btnClose = document.getElementById('btnCloseCustomSourceModal');
  const btnCancel = document.getElementById('btnCancelAddCustomSource');
  const btnBrowse = document.getElementById('btnBrowseCustomSourceFolder');
  const btnConfirm = document.getElementById('btnConfirmAddCustomSource');

  if (btnOpen && modal) {
    btnOpen.addEventListener('click', () => {
      modal.style.display = 'flex';
    });
  }

  const closeModal = () => {
    if (modal) modal.style.display = 'none';
  };

  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

  if (btnBrowse) {
    btnBrowse.addEventListener('click', async () => {
      if (window.bds && window.bds.selectFolder) {
        const folder = await window.bds.selectFolder();
        if (folder) {
          const pathInput = document.getElementById('inputCustomSourcePath');
          if (pathInput) pathInput.value = folder;
        }
      }
    });
  }

  if (btnConfirm) {
    btnConfirm.addEventListener('click', async () => {
      const nameInput = document.getElementById('inputCustomSourceName');
      const pathInput = document.getElementById('inputCustomSourcePath');
      
      const sourceName = nameInput?.value?.trim();
      const folderPath = pathInput?.value?.trim();

      if (!sourceName) {
        window.bdsModal.alert('Por favor, informe o nome desejado para a fonte personalizada.');
        return;
      }
      if (!folderPath) {
        window.bdsModal.alert('Por favor, selecione a pasta da fonte.');
        return;
      }

      if (window.bds && window.bds.addCustomSource) {
        try {
          btnConfirm.disabled = true;
          btnConfirm.innerHTML = '<span class="material-symbols-rounded" style="font-size: 18px;">hourglass_top</span> Indexando Mídias...';

          await window.bds.addCustomSource({ name: sourceName, folderPath: folderPath });

          btnConfirm.disabled = false;
          btnConfirm.innerHTML = '<span class="material-symbols-rounded" style="font-size: 18px;">check_circle</span> Cadastrar & Importar Mídias';

          closeModal();

          nameInput.value = '';
          pathInput.value = '';

          await loadFilterOptions();
          await fetchMedia();

          window.bdsModal.alert(`Sucesso! A fonte personalizada "${sourceName}" foi cadastrada e suas mídias foram indexadas na biblioteca!`);
        } catch (err) {
          btnConfirm.disabled = false;
          btnConfirm.innerHTML = '<span class="material-symbols-rounded" style="font-size: 18px;">check_circle</span> Cadastrar & Importar Mídias';
          window.bdsModal.alert('Erro ao cadastrar fonte personalizada: ' + err.message);
        }
      }
    });
  }
}

function setViewMode(mode) {
  viewMode = mode;
  document.getElementById('btnViewGrid').classList.toggle('active', mode === 'grid');
  document.getElementById('btnViewList').classList.toggle('active', mode === 'list');
  renderMedia();
}

function updateFilters() {
  const getChecked = (name) => Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map(el => el.value);
  currentFilters.types = getChecked('type');
  currentFilters.origins = getChecked('origin');
  currentFilters.albums = getChecked('album');
  currentFilters.resolutions = getChecked('res').map(Number);
  currentFilters.fps = getChecked('fps').map(Number);
  currentFilters.dates = getChecked('date');
  currentFilters.projects = getChecked('project').map(Number);
  currentFilters.tags = getChecked('tag').map(Number);
  currentFilters.favorites = getChecked('favorite').length > 0;
}

let currentSortOrder = 'DESC';

async function fetchMedia() {
  if (!window.bds || !window.bds.searchLibrary) return;

  const options = {
    query: currentSearch,
    types: currentFilters.types,
    origins: currentFilters.origins,
    albums: currentFilters.albums,
    resolutions: currentFilters.resolutions,
    fps: currentFilters.fps,
    dates: currentFilters.dates,
    projects: currentFilters.projects,
    tags: currentFilters.tags,
    favorites: currentFilters.favorites,
    sort: currentSort,
    order: currentSortOrder,
    limit: 300
  };

  const searchResult = await window.bds.searchLibrary(options);
  mediaItems = searchResult.items || [];
  
  const globalMediaCount = document.getElementById('globalMediaCount');
  if (globalMediaCount) {
    const count = searchResult.totalCount || mediaItems.length;
    globalMediaCount.textContent = `${count.toLocaleString('pt-BR')} mídias encontradas`;
  }
  
  renderMedia();
}

function renderMedia() {
  const container = document.getElementById('libContentArea');
  
  if (mediaItems.length === 0) {
    container.innerHTML = '<div style="color: var(--muted); padding: 40px; text-align: center;">Nenhuma mídia encontrada.</div>';
    return;
  }

  const grouped = {};
  
  if (currentSort === 'filesize') {
    // Agrupamento por tamanho
    // Padrão solicitado: 1GB, 5GB, 10GB, 25GB, 50GB, 100GB, 200GB, 400GB...
    const getGroupLimits = () => {
       const limits = [1, 5, 10, 25, 50];
       let current = 50;
       for (let i = 0; i < 15; i++) {
          current *= 2;
          limits.push(current);
       }
       return limits;
    };
    const limits = getGroupLimits();
    const GB = 1024 * 1024 * 1024;
    
    mediaItems.forEach(media => {
       const sizeBytes = media.filesize || 0;
       const sizeGB = sizeBytes / GB;
       let groupName = "Mais de " + limits[limits.length-1] + " GB";
       let groupSortIndex = limits.length;
       
       for (let i = 0; i < limits.length; i++) {
          if (sizeGB <= limits[i]) {
             groupName = "Até " + limits[i] + " GB";
             groupSortIndex = i;
             break;
          }
       }
       
       if (!grouped[groupName]) grouped[groupName] = { sortIndex: groupSortIndex, items: [] };
       grouped[groupName].items.push(media);
    });
  } else {
    // Agrupamento por data (imported_at ou recorded_at)
    mediaItems.forEach(media => {
      const rawDate = media[currentSort] || media.imported_at || '';
      const cleanDate = rawDate.replace(' ', 'T') + (rawDate.endsWith('Z') ? '' : 'Z');
      const dateObj = new Date(cleanDate);
      
      let dateKey;
      if (isNaN(dateObj)) {
        dateKey = 'Data Desconhecida';
        if (!grouped[dateKey]) grouped[dateKey] = { dateObj: new Date(0), items: [] };
      } else {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        
        dateKey = dateObj.toLocaleDateString('pt-BR');
        if (dateObj.toDateString() === today.toDateString()) {
          dateKey = 'Hoje';
        } else if (dateObj.toDateString() === yesterday.toDateString()) {
          dateKey = 'Ontem';
        }
        
        if (!grouped[dateKey]) grouped[dateKey] = { dateObj, items: [] };
      }
      
      grouped[dateKey].items.push(media);
    });
  }

  let sortedGroupKeys = [];
  if (currentSort === 'filesize') {
    sortedGroupKeys = Object.keys(grouped).sort((a, b) => {
      if (currentSortOrder === 'ASC') {
        return grouped[a].sortIndex - grouped[b].sortIndex;
      } else {
        return grouped[b].sortIndex - grouped[a].sortIndex;
      }
    });
  } else {
    sortedGroupKeys = Object.keys(grouped).sort((a, b) => {
      // Data Desconhecida always at the end (or beginning depending on sort, let's keep it at the end)
      if (a === 'Data Desconhecida') return 1;
      if (b === 'Data Desconhecida') return -1;
      
      if (currentSortOrder === 'ASC') {
        return grouped[a].dateObj - grouped[b].dateObj;
      } else {
        return grouped[b].dateObj - grouped[a].dateObj;
      }
    });
  }

  let html = '';
  if (viewMode === 'grid') {
    for (const key of sortedGroupKeys) {
      html += `<div class="lib-date-header">${key}</div>`;
      html += `<div class="lib-grid">${grouped[key].items.map(m => renderGridCard(m)).join('')}</div>`;
    }
    container.innerHTML = html;
  } else {
    html = `<table class="lib-list-table">
      <thead><tr>
        <th>Mídia</th><th>Origem</th><th>Resolução</th><th>FPS</th><th>Tamanho</th>
      </tr></thead><tbody>`;
    for (const key of sortedGroupKeys) {
      html += `<tr><td colspan="5" class="lib-date-header" style="padding-top: 24px; padding-bottom: 8px;">${key}</td></tr>`;
      html += grouped[key].items.map(m => renderListRow(m)).join('');
    }
    html += `</tbody></table>`;
    container.innerHTML = html;
  }

  // Bind clicks
  const items = container.querySelectorAll('.media-clickable');
  items.forEach(item => {
    item.addEventListener('click', (e) => {
      const id = parseInt(item.getAttribute('data-id'));
      
      // Se clicou no menu de contexto (3 pontos), não seleciona o card
      if (e.target.closest('.lib-card-menu')) {
        return; 
      }
      
      const favBadge = e.target.closest('.lib-card-badge-fav');
      if (favBadge) {
        const isFav = favBadge.textContent === 'star';
        if (window.bds && window.bds.toggleFavorite) {
          window.bds.toggleFavorite(id, !isFav).then(() => {
            fetchMedia();
            loadFilterOptions();
          });
        }
        return;
      }

      const isCheckbox = e.target.closest('.lib-card-checkbox');
      
      if (isCheckbox || e.ctrlKey || e.metaKey) {
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        updateSelectionVisuals();
        
        // Se após selecionar só sobrou 1 item na seleção, e o inspetor está fechado, talvez abra?
        // Vamos deixar o inspetor como está. Se quiser inspecionar, clica no card.
      } else {
        // Clique normal no card (fora do checkbox): apenas abre propriedades SEM selecionar
        const media = mediaItems.find(m => m.id === id);
        if (media) openInspector(media);
      }
    });
  });
}

function updateSelectionVisuals() {
  const container = document.getElementById('libContentArea');
  const items = container.querySelectorAll('.media-clickable');
  items.forEach(item => {
    const id = parseInt(item.getAttribute('data-id'));
    const isSelected = selectedIds.has(id);
    if (isSelected) {
      item.classList.add('selected');
    } else {
      item.classList.remove('selected');
    }
    const checkbox = item.querySelector('.lib-card-checkbox');
    if (checkbox) {
      checkbox.checked = isSelected;
    }
  });

  const actionBar = document.getElementById('libActionBar');
  const selectedCountLabel = document.getElementById('libSelectedCount');
  
  if (selectedIds.size > 0) {
    actionBar.style.display = 'flex';
    selectedCountLabel.textContent = `${selectedIds.size} selecionado${selectedIds.size > 1 ? 's' : ''}`;
  } else {
    actionBar.style.display = 'none';
  }
}

function renderGridCard(media) {
  const thumbUrl = media.thumbnail ? `${thumbsDir}/${media.thumbnail}` : '';
  const rawDate = media.recorded_at || media.imported_at;
  const cleanDate = rawDate.replace(' ', 'T') + (rawDate.endsWith('Z') ? '' : 'Z');
  const dateObj = new Date(cleanDate);
  const dateStr = isNaN(dateObj) ? '-' : dateObj.toLocaleDateString('pt-BR');
  const isSelected = selectedIds.has(media.id);
  
  const isPhoto = media.filename && !!media.filename.match(/\.(jpg|jpeg|png|webp|gif|bmp|arw|cr2|cr3|nef|dng|raf|rw2|orf)$/i);
  const isAudio = media.filename && !!media.filename.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i);

  // Lógica de ícones da origem
  let originIcon = 'computer';
  let originText = media.origin || 'Computador / Local';
  if (originText.includes('OBS')) originIcon = 'videocam';
  else if (originText.includes('Shadow')) originIcon = 'sports_esports';
  else if (originText.includes('BDSM')) originIcon = 'smartphone';
  else if (originText.includes('Downloader')) originIcon = 'download';

  const favIcon = media.favorite ? 'star' : 'star_border';
  const favColor = media.favorite ? 'color: #f25c05;' : '';

  return `
    <div class="lib-card media-clickable ${isSelected ? 'selected' : ''}" data-id="${media.id}">
      <div class="lib-card-thumb" style="background-image: url('${thumbUrl}'); ${isAudio && !thumbUrl ? 'display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.02);' : ''}">
        <input type="checkbox" class="lib-card-checkbox" ${isSelected ? 'checked' : ''} style="position: absolute; top: 8px; left: 8px; z-index: 10; width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent);">
        <span class="material-symbols-rounded lib-card-badge-fav" style="position: absolute; top: 8px; right: 8px; ${favColor}">${favIcon}</span>
        ${isAudio && !thumbUrl ? '<span style="font-size: 18px; font-weight: 800; color: rgba(255,255,255,0.1); letter-spacing: 2px;">ÁUDIO</span>' : ''}
        ${(!isPhoto && !isAudio) ? `<div class="lib-card-duration">${formatDuration(media.duration)}</div>` : ''}
      </div>
      <div class="lib-card-info">
        <div class="lib-card-title" title="${media.filename}">${media.filename}</div>
        <div class="lib-card-meta">
          <span>${dateStr}</span>
          <span>${isPhoto ? 'Foto' : (isAudio ? 'Áudio' : (media.video_codec ? media.height+'p' : ''))}</span>
          <span>${(!isPhoto && !isAudio && media.fps) ? media.fps+'fps' : ''}</span>
        </div>
        <div class="lib-card-origin">${originText}</div>
        <span class="material-symbols-rounded lib-card-menu">more_vert</span>
      </div>
    </div>
  `;
}

function renderListRow(media) {
  const thumbUrl = media.thumbnail ? `${thumbsDir}/${media.thumbnail}` : '';
  const icon = (media.origin && media.origin.includes('BDSM')) ? 'smartphone' : 'computer';
  const isSelected = selectedIds.has(media.id);
  const favIcon = media.favorite ? 'star' : 'star_border';
  const favColor = media.favorite ? 'color: #f25c05;' : 'color: var(--muted);';

  return `
    <tr class="media-clickable ${isSelected ? 'selected' : ''}" data-id="${media.id}">
      <td>
        <div style="display: flex; align-items: center; gap: 12px;">
          <input type="checkbox" class="lib-card-checkbox" ${isSelected ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent);">
          <div class="lib-list-thumb" style="background-image: url('${thumbUrl}'); background-color: #000;"></div>
          <span class="material-symbols-rounded lib-card-badge-fav" style="font-size: 16px; cursor: pointer; ${favColor}">${favIcon}</span>
          <span style="color: #fff;">${media.filename}</span>
        </div>
      </td>
      <td>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-rounded" style="font-size: 14px;">${icon}</span>
          ${media.origin || 'Computador / Local'}
        </div>
      </td>
      <td>${media.height ? media.height + 'p' : '-'}</td>
      <td>${media.fps || '-'}</td>
      <td>${formatBytes(media.filesize)}</td>
    </tr>
  `;
}

let currentInspectorMedia = null;

function openInspector(media) {
  currentInspectorMedia = media;
  const inspector = document.getElementById('libraryInspector');
  
  const thumbUrl = media.thumbnail ? `${thumbsDir}/${media.thumbnail}` : '';
  document.getElementById('inspectorThumbnail').style.backgroundImage = `url('${thumbUrl}')`;
  document.getElementById('inspectorTitle').textContent = media.filename;
  document.getElementById('inspectorTitleEdit').value = media.filename;
  document.getElementById('inspectorTitle').style.display = 'block';
  document.getElementById('inspectorTitleEdit').style.display = 'none';
  const isPhoto = media.filename && !!media.filename.match(/\.(jpg|jpeg|png|webp|gif|bmp|arw|cr2|cr3|nef|dng|raf|rw2|orf)$/i);
  const isAudio = media.filename && !!media.filename.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i);

  const btnPlayMedia = document.getElementById('btnPlayMedia');
  if (btnPlayMedia) {
    btnPlayMedia.style.display = isPhoto ? 'none' : 'flex';
  }

  const thumbDuration = document.getElementById('inspectorThumbDuration');
  if (thumbDuration) {
    thumbDuration.style.display = isPhoto ? 'none' : 'block';
  }

  // Helper to toggle visibility
  const toggleRow = (id, show) => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? 'flex' : 'none';
  };

  document.getElementById('inspectorSize').textContent = formatBytes(media.filesize);
  document.getElementById('inspectorRes').textContent = media.width ? `${media.width}x${media.height}` : '-';
  document.getElementById('inspectorVCodec').textContent = media.video_codec || '-';
  document.getElementById('inspectorACodec').textContent = media.audio_codec || '-';
  
  // Bitrates can be extracted from media.bitrate if available. We don't have separate VBitrate and ABitrate fields yet unless we format them.
  // We'll leave the text content as is (or '-').
  document.getElementById('inspectorFps').textContent = media.fps || '-';
  
  document.getElementById('inspectorOrigin').textContent = media.origin || 'Computador / Local';
  const parseDBDate = (dateStr) => {
    if (!dateStr) return null;
    const cleanStr = dateStr.replace(' ', 'T') + (dateStr.endsWith('Z') ? '' : 'Z');
    const d = new Date(cleanStr);
    return isNaN(d) ? null : d;
  };

  const importedD = parseDBDate(media.imported_at);
  const recordedD = parseDBDate(media.recorded_at);

  document.getElementById('inspectorDate').textContent = importedD ? importedD.toLocaleString('pt-BR') : '-';
  document.getElementById('inspectorRecordDate').textContent = recordedD ? recordedD.toLocaleString('pt-BR') : '-';
  
  document.getElementById('inspectorDuration').textContent = isPhoto ? '-' : formatDuration(media.duration);
  
  const thumbDur = document.getElementById('inspectorThumbDuration');
  if (thumbDur) {
    if (isPhoto) {
      thumbDur.style.display = 'none';
    } else {
      thumbDur.style.display = 'block';
      thumbDur.textContent = formatDuration(media.duration);
    }
  }

  // Hide specific rows for Photo
  function formatBitrate(bps) {
    if (!bps) return '-';
    const kbps = bps / 1000;
    if (kbps > 1000) return (kbps / 1000).toFixed(1) + ' Mbps';
    return Math.round(kbps) + ' kbps';
  }

  const bitrateStr = formatBitrate(media.bitrate);
  
  if (isAudio) {
    document.getElementById('inspectorVBitrate').textContent = '-';
    document.getElementById('inspectorABitrate').textContent = bitrateStr;
  } else if (!isPhoto) {
    // Para vídeos, mostramos o bitrate total no campo de vídeo por enquanto
    document.getElementById('inspectorVBitrate').textContent = bitrateStr;
    document.getElementById('inspectorABitrate').textContent = '-';
  } else {
    document.getElementById('inspectorVBitrate').textContent = '-';
    document.getElementById('inspectorABitrate').textContent = '-';
  }

  toggleRow('rowDuration', !isPhoto);
  toggleRow('rowFps', !isPhoto && !isAudio);
  toggleRow('rowVCodec', !isPhoto && !isAudio);
  toggleRow('rowVBitrate', !isPhoto && !isAudio);
  toggleRow('rowRes', !isPhoto && !isAudio);
  
  // Hide specific rows for Audio
  toggleRow('rowACodec', !isPhoto);
  toggleRow('rowABitrate', !isPhoto);

  document.getElementById('inspectorPath').textContent = media.filepath;
  
  // Favorito State
  const favStar = document.getElementById('inspectorFavStar');
  if (favStar) {
    if (media.favorite === 1) {
      favStar.style.color = 'var(--accent)';
      favStar.textContent = 'star';
    } else {
      favStar.style.color = 'var(--muted)';
      favStar.textContent = 'star_border';
    }
  }

  // Projeto Placeholder
  document.getElementById('inspectorProject').textContent = 'Projeto (Em breve)';

  // Carregar Tags
  loadMediaTags(media.id);
  
  inspector.style.display = 'flex';
}

async function loadMediaTags(mediaId) {
  const tagsContainer = document.getElementById('inspectorTags');
  const addBtn = document.getElementById('btnAddTag');
  
  // Limpar exceto o botão Add
  tagsContainer.innerHTML = '';
  tagsContainer.appendChild(addBtn);

  if (!window.bds || !window.bds.getMediaTags) return;
  const tags = await window.bds.getMediaTags(mediaId);
  
  tags.forEach(tag => {
    const span = document.createElement('span');
    span.style.cssText = `font-size: 10px; color: #fff; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2); padding: 2px 8px; border-radius: 12px; display: flex; align-items: center; gap: 4px;`;
    let displayName = tag.name;
    if (displayName.startsWith('TAG:creation_time=')) {
        displayName = 'Data da Gravação: ' + displayName.replace('TAG:creation_time=', '');
    }
    span.innerHTML = `
      ${displayName}
      <span class="material-symbols-rounded remove-tag" style="font-size: 12px; cursor: pointer;" data-id="${tag.id}">close</span>
    `;
    tagsContainer.insertBefore(span, addBtn);
  });

  // Attach remove events
  tagsContainer.querySelectorAll('.remove-tag').forEach(el => {
    el.addEventListener('click', async (e) => {
      const tagId = e.target.getAttribute('data-id');
      await window.bds.removeMediaTag(mediaId, tagId);
      loadMediaTags(mediaId);
      loadFilterOptions(); // Atualiza contador na lateral
    });
  });
}

// Event Listeners for Inspector UI
function bindInspectorEvents() {
  // Title Edit
  const titleText = document.getElementById('inspectorTitle');
  const titleEdit = document.getElementById('inspectorTitleEdit');

  if (titleText && titleEdit) {
    titleText.addEventListener('click', () => {
      titleText.style.display = 'none';
      titleEdit.style.display = 'block';
      titleEdit.focus();
    });

    titleEdit.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const newName = titleEdit.value.trim();
        if (newName && currentInspectorMedia) {
          titleText.textContent = newName;
          await window.bds.renameMedia(currentInspectorMedia.id, newName);
          fetchMedia(); // Atualiza a grid
        }
        titleEdit.style.display = 'none';
        titleText.style.display = 'block';
      }
      if (e.key === 'Escape') {
        titleEdit.value = titleText.textContent;
        titleEdit.style.display = 'none';
        titleText.style.display = 'block';
      }
    });
  }

  // Favorite Toggle
  const favStar = document.getElementById('inspectorFavStar');
  if (favStar) {
    // Remove previous listeners if any (by replacing node, or just ensure it's bound once. Since it's DOMContentLoaded, it binds once)
    // Actually we should bind it only once, but since this runs once it's fine.
    // Wait, DOMContentLoaded runs once, but currentInspectorMedia changes.
    // So the listener is fine.
    favStar.addEventListener('click', async () => {
      if (!currentInspectorMedia) return;
      const isFav = currentInspectorMedia.favorite !== 1;
      currentInspectorMedia.favorite = isFav ? 1 : 0;
      
      if (isFav) {
        favStar.style.color = 'var(--accent)';
        favStar.textContent = 'star';
      } else {
        favStar.style.color = 'var(--muted)';
        favStar.textContent = 'star_border';
      }
      
      await window.bds.toggleFavorite(currentInspectorMedia.id, isFav);
      fetchMedia(); // Atualiza a grid (pra mostrar ícone de fav)
    });
  }

  // Tags Add
  const btnAddTag = document.getElementById('btnAddTag');
  const tagEdit = document.getElementById('inspectorTagEdit');
  if (btnAddTag) {
    btnAddTag.addEventListener('click', () => {
      tagEdit.style.display = 'block';
      tagEdit.focus();
    });

    tagEdit.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const tagName = tagEdit.value.trim();
        if (tagName && currentInspectorMedia) {
          await window.bds.addMediaTag(currentInspectorMedia.id, tagName);
          tagEdit.value = '';
          tagEdit.style.display = 'none';
          loadMediaTags(currentInspectorMedia.id);
          loadFilterOptions();
        }
      }
      if (e.key === 'Escape') {
        tagEdit.value = '';
        tagEdit.style.display = 'none';
      }
    });
  }

  // Bulk Actions
  const btnDeleteBulk = document.getElementById('btnActionDelete');
  if (btnDeleteBulk) {
    btnDeleteBulk.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      const conf = await window.bdsModal.confirm(`Tem certeza que deseja excluir ${ids.length} arquivo(s)? Esta ação apagará o arquivo do disco também.`);
      if (conf) {
        await window.bds.deleteMediaBulk(ids);
        selectedIds.clear();
        updateSelectionVisuals();
        fetchMedia();
        loadFilterOptions();
      }
    });
  }

  const btnFavBulk = document.getElementById('btnActionFavorite');
  if (btnFavBulk) {
    btnFavBulk.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      // Toggle logic: se a maioria não for fav, favorita. Senao, desfavorita.
      const selectedMedia = mediaItems.filter(m => ids.includes(m.id));
      const favCount = selectedMedia.filter(m => m.favorite === 1).length;
      const isFav = favCount <= ids.length / 2; // if half or less are fav, make all fav
      
      await window.bds.toggleFavoriteBulk(ids, isFav);
      fetchMedia();
      loadFilterOptions();
    });
  }

  const btnRenameBulk = document.getElementById('btnActionRename');
  if (btnRenameBulk) {
    btnRenameBulk.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      const baseName = await window.bdsModal.prompt(`Digite o novo Nome Base para os ${ids.length} arquivos selecionados:`, 'Novo Nome');
      if (baseName && baseName.trim()) {
        await window.bds.renameMediaBulk(ids, baseName.trim());
        fetchMedia();
      }
    });
  }

  const btnTagsBulk = document.getElementById('btnActionTags');
  if (btnTagsBulk) {
    btnTagsBulk.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      const tagName = await window.bdsModal.prompt(`Digite a tag a ser adicionada nos ${ids.length} arquivos:`);
      if (tagName && tagName.trim()) {
        await window.bds.addMediaTagBulk(ids, tagName.trim());
        fetchMedia();
        loadFilterOptions();
        // Se o inspetor estiver aberto pra esse 1, atualiza
        if (ids.length === 1 && currentInspectorMedia) {
           loadMediaTags(ids[0]);
        }
      }
    });
  }

  const btnMoveBulk = document.getElementById('btnActionMove');
  if (btnMoveBulk) {
    btnMoveBulk.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      if (window.bds && window.bds.selectFolder) {
        const folder = await window.bds.selectFolder();
        if (folder) {
          await window.bds.moveMediaBulk(ids, folder);
          fetchMedia();
        }
      }
    });
  }

  const btnProjectBulk = document.getElementById('btnActionProject');
  if (btnProjectBulk) {
    btnProjectBulk.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      // For now just ask for project ID (number). Later we can build a proper select.
      const projIdStr = await window.bdsModal.prompt(`Digite o ID numérico do Projeto (ou deixe vazio para remover):`);
      if (projIdStr !== null) {
        const projId = parseInt(projIdStr) || null;
        await window.bds.setProjectBulk(ids, projId);
        fetchMedia();
      }
    });
  }
}

function closeInspector() {
  document.getElementById('libraryInspector').style.display = 'none';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024, dm = 2, sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
  if (!seconds) return '00:00';
  const d = new Date(seconds * 1000);
  return d.toISOString().substring(11, 19).replace(/^00:/, '');
}

async function loadFilterOptions() {
  if (!window.bds || !window.bds.getLibraryFilterOptions) return;
  const options = await window.bds.getLibraryFilterOptions();
  
  const createGroup = (title, items, name, valueKey, labelKey, countKey, formatter = v=>v) => {
    if (!items || items.length === 0) return '';
    let html = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <h3 style="font-size: 13px; font-weight: 600; margin: 0;">${title}</h3>
      </div>
    `;
    items.forEach(item => {
      const isChecked = currentFilters[name + 's']?.includes(item[valueKey]) || currentFilters[name]?.includes(item[valueKey]);
      html += `
        <label class="lib-filter-row">
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" name="${name}" value="${item[valueKey]}" class="lib-filter-chk" ${isChecked ? 'checked' : ''}>
            <span class="lib-filter-custom-chk material-symbols-rounded">${isChecked ? 'check_box' : 'check_box_outline_blank'}</span>
            <span>${formatter(item[labelKey])}</span>
          </div>
          <span class="lib-filter-count">${item[countKey]}</span>
        </label>
      `;
    });
    return html;
  };

  const bindEvents = (containerId) => {
    const container = document.getElementById(containerId);
    if (container) {
      container.querySelectorAll('.lib-filter-chk').forEach(chk => {
        chk.addEventListener('change', (e) => {
          const icon = e.target.nextElementSibling;
          if (e.target.checked) {
            icon.textContent = 'check_box';
          } else {
            icon.textContent = 'check_box_outline_blank';
          }
          updateFilters();
          fetchMedia();
        });
      });
    }
  };

  // Origins
  const originsHtml = createGroup('Origem', options.origins, 'origin', 'origin', 'origin', 'count', o => o === 'LOCAL' ? 'Computador' : o);
  document.getElementById('filterOriginsContainer').innerHTML = originsHtml;
  bindEvents('filterOriginsContainer');

  // Albums
  const albumsHtml = createGroup('Álbuns / Pastas', options.albums, 'album', 'name', 'name', 'count');
  document.getElementById('filterAlbumsContainer').innerHTML = albumsHtml;
  bindEvents('filterAlbumsContainer');

  // Types
  const typeArr = [
    { typeVal: 'video', label: 'Vídeos', count: options.types.video },
    { typeVal: 'audio', label: 'Áudios', count: options.types.audio },
    { typeVal: 'photo', label: 'Fotos', count: options.types.photo }
  ].filter(t => t.count > 0);
  const typesHtml = createGroup('Tipos', typeArr, 'type', 'typeVal', 'typeVal', 'count', val => val === 'video' ? 'Vídeos' : (val === 'audio' ? 'Áudios' : 'Fotos'));
  document.getElementById('filterTypesContainer').innerHTML = typesHtml;
  bindEvents('filterTypesContainer');

  // Resolutions
  const resHtml = createGroup('Resolução Vertical', options.resolutions, 'res', 'height', 'height', 'count', r => r + 'p');
  document.getElementById('filterResContainer').innerHTML = resHtml;
  bindEvents('filterResContainer');

  // FPS
  const fpsHtml = createGroup('FPS', options.fps, 'fps', 'fps', 'fps', 'count', f => f + ' fps');
  document.getElementById('filterFpsContainer').innerHTML = fpsHtml;
  bindEvents('filterFpsContainer');
  
  // Data (Datas distintas dos arquivos)
  const dateHtml = createGroup('Data de Gravação', options.dates, 'date', 'dt', 'dt', 'count', d => {
    const parts = d.split('-');
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  });
  document.getElementById('filterDateContainer').innerHTML = dateHtml;
  bindEvents('filterDateContainer');

  // Projetos
  const projHtml = createGroup('Projetos', options.projects, 'project', 'id', 'name', 'count');
  document.getElementById('filterProjectsContainer').innerHTML = projHtml;
  bindEvents('filterProjectsContainer');

  // Tags
  const tagsHtml = createGroup('Tags', options.tags, 'tag', 'id', 'name', 'count');
  document.getElementById('filterTagsContainer').innerHTML = tagsHtml;
  bindEvents('filterTagsContainer');

  // Favorites (special case)
  if (options.favoritesCount > 0) {
    const isFav = currentFilters.favorites;
    document.getElementById('filterFavoritesContainer').innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <h3 style="font-size: 13px; font-weight: 600; margin: 0;">Favoritos</h3>
      </div>
      <label class="lib-filter-row">
        <div style="display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" name="favorite" value="1" class="lib-filter-chk" ${isFav ? 'checked' : ''}>
          <span class="lib-filter-custom-chk material-symbols-rounded" style="color: var(--accent);">${isFav ? 'check_box' : 'check_box_outline_blank'}</span>
          <span>Apenas Favoritos</span>
        </div>
        <span class="lib-filter-count">${options.favoritesCount}</span>
      </label>
    `;
    bindEvents('filterFavoritesContainer');
  } else {
    document.getElementById('filterFavoritesContainer').innerHTML = '';
  }
}
