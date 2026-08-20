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
let lastSelectedId = null;
let currentSort = 'recorded_at';
let currentSortOrder = 'DESC';
let currentInspectorMedia = null;

export async function initScreen() {
  console.log('[LIBRARY] Inicializando tela...');

  if (window.bds && window.bds.getThumbDir) {
    try {
      thumbsDir = await window.bds.getThumbDir();
      thumbsDir = 'file:///' + thumbsDir.replace(/\\/g, '/');
    } catch (e) {
      console.warn('[LIBRARY] Não foi possível obter thumbsDir:', e);
    }
  }

  // View toggles
  document.getElementById('btnViewGrid')?.addEventListener('click', () => setViewMode('grid'));
  document.getElementById('btnViewList')?.addEventListener('click', () => setViewMode('list'));
  
  const btnReload = document.getElementById('btnReloadLibrary');
  if (btnReload) {
    btnReload.addEventListener('click', async () => {
      if (window.bds && window.bds.rescanAllLibrary) {
        await window.bds.rescanAllLibrary();
      }
      fetchMedia();
    });
  }

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

  // Search com debounce (clonando para remover listeners antigos)
  const oldSearch = document.getElementById('globalSearch');
  if (oldSearch) {
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
  }

  // Inspector Buttons
  document.getElementById('closeInspectorBtn')?.addEventListener('click', closeInspector);
  document.getElementById('btnPlayMedia')?.addEventListener('click', () => {
    if (currentInspectorMedia && window.bdsPlayer) {
      window.bdsPlayer.play(currentInspectorMedia.filepath, currentInspectorMedia.filename);
    }
  });

  // Escuta novos arquivos
  if (window.bds && window.bds.onMediaImported && !window.libraryListenerRegistered) {
    window.libraryListenerRegistered = true;
    window.bds.onMediaImported(() => {
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

  setupCustomSourceModal();
  setupAddToProjectModal();
  setupDelegatedMediaClicks();
  await loadFilterOptions();
  fetchMedia();
  bindInspectorEvents();
}

export function resetFilters() {
  currentFilters = {
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
  currentSearch = '';
  selectedIds.clear();
  document.querySelectorAll('.lib-filter-chk').forEach(chk => {
    chk.checked = false;
    const icon = chk.nextElementSibling;
    if (icon) icon.textContent = 'check_box_outline_blank';
  });
  const searchInput = document.getElementById('globalSearch');
  if (searchInput) searchInput.value = '';
}


function setupCustomSourceModal() {
  const modal = document.getElementById('modalAddCustomSource');
  const btnOpen = document.getElementById('btnAddCustomSourceBtn');
  const btnClose = document.getElementById('btnCloseCustomSourceModal');
  const btnCancel = document.getElementById('btnCancelAddCustomSource');
  const btnBrowse = document.getElementById('btnBrowseCustomSourceFolder');
  const btnConfirm = document.getElementById('btnConfirmAddCustomSource');

  const closeModal = () => {
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('active');
    }
  };

  const openModal = () => {
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('active');
    }
  };

  if (btnOpen) btnOpen.addEventListener('click', openModal);
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
          btnConfirm.innerHTML = '<span class="material-symbols-rounded">hourglass_top</span> Indexando Mídias...';

          await window.bds.addCustomSource({ name: sourceName, folderPath: folderPath });

          btnConfirm.disabled = false;
          btnConfirm.innerHTML = '<span class="material-symbols-rounded">check_circle</span> Cadastrar & Importar Mídias';

          closeModal();

          nameInput.value = '';
          pathInput.value = '';

          await loadFilterOptions();
          await fetchMedia();

          window.bdsModal.alert(`Sucesso! A fonte personalizada "${sourceName}" foi cadastrada e suas mídias foram indexadas na biblioteca!`);
        } catch (err) {
          btnConfirm.disabled = false;
          btnConfirm.innerHTML = '<span class="material-symbols-rounded">check_circle</span> Cadastrar & Importar Mídias';
          window.bdsModal.alert('Erro ao cadastrar fonte personalizada: ' + err.message);
        }
      }
    });
  }
}

function setViewMode(mode) {
  viewMode = mode;
  document.getElementById('btnViewGrid')?.classList.toggle('active', mode === 'grid');
  document.getElementById('btnViewList')?.classList.toggle('active', mode === 'list');
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

export async function applyGlobalSearch(query) {
  currentSearch = query || '';
  const searchInput = document.getElementById('globalSearch');
  if (searchInput && searchInput.value !== currentSearch) {
    searchInput.value = currentSearch;
  }
  await fetchMedia();
}

export async function fetchMedia() {

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
  if (!container) return;
  
  if (mediaItems.length === 0) {
    container.innerHTML = '<div class="lib-empty-state">Nenhuma mídia encontrada.</div>';
    return;
  }

  const grouped = {};
  
  if (currentSort === 'filesize') {
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
      html += `<tr><td colspan="5" class="lib-date-header">${key}</td></tr>`;
      html += grouped[key].items.map(m => renderListRow(m)).join('');
    }
    html += `</tbody></table>`;
    container.innerHTML = html;
  }
}

function setupDelegatedMediaClicks() {
  const container = document.getElementById('libContentArea');
  if (!container || container.dataset.hasDelegatedClick) return;
  container.dataset.hasDelegatedClick = 'true';

  container.addEventListener('click', (e) => {
    const item = e.target.closest('.media-clickable');
    if (!item) return;

    const id = parseInt(item.getAttribute('data-id'));
    
    if (e.target.closest('.lib-card-menu')) return; 
    
    const favBadge = e.target.closest('.lib-card-badge-fav');
    if (favBadge) {
      const isFav = favBadge.classList.contains('active');
      if (window.bds && window.bds.toggleFavorite) {
        window.bds.toggleFavorite(id, !isFav).then(() => {
          fetchMedia();
          loadFilterOptions();
        });
      }
      return;
    }

    const favBadgeList = e.target.closest('.lib-list-fav-btn');
    if (favBadgeList) {
      const isFav = favBadgeList.classList.contains('active');
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
    } else {
      const media = mediaItems.find(m => m.id === id);
      if (media) openInspector(media);
    }
  });
}

function updateSelectionVisuals() {
  const container = document.getElementById('libContentArea');
  if (!container) return;
  
  const items = container.querySelectorAll('.media-clickable');
  items.forEach(item => {
    const id = parseInt(item.getAttribute('data-id'));
    const isSelected = selectedIds.has(id);
    item.classList.toggle('selected', isSelected);
    const checkbox = item.querySelector('.lib-card-checkbox');
    if (checkbox) checkbox.checked = isSelected;
  });

  const actionBar = document.getElementById('libActionBar');
  const selectedCountLabel = document.getElementById('libSelectedCount');
  
  if (actionBar && selectedCountLabel) {
    if (selectedIds.size > 0) {
      actionBar.classList.remove('hidden');
      actionBar.classList.add('active');
      selectedCountLabel.textContent = `${selectedIds.size} selecionado${selectedIds.size > 1 ? 's' : ''}`;
    } else {
      actionBar.classList.add('hidden');
      actionBar.classList.remove('active');
    }
  }
}

function renderGridCard(media) {
  const thumbUrl = media.thumbnail ? `${thumbsDir}/${media.thumbnail}` : '';
  const rawDate = media.recorded_at || media.imported_at;
  const cleanDate = rawDate ? rawDate.replace(' ', 'T') + (rawDate.endsWith('Z') ? '' : 'Z') : '';
  const dateObj = new Date(cleanDate);
  const dateStr = isNaN(dateObj) ? '-' : dateObj.toLocaleDateString('pt-BR');
  const isSelected = selectedIds.has(media.id);
  
  const isPhoto = media.filename && !!media.filename.match(/\.(jpg|jpeg|png|webp|gif|bmp|arw|cr2|cr3|nef|dng|raf|rw2|orf)$/i);
  const isAudio = media.filename && !!media.filename.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i);

  let originText = media.origin || 'Computador / Local';

  const favClass = media.favorite ? 'active' : '';
  const favIcon = media.favorite ? 'star' : 'star_border';

  const thumbClass = isAudio && !thumbUrl ? 'lib-card-thumb audio-placeholder' : 'lib-card-thumb';
  const thumbStyle = thumbUrl ? `background-image: url('${thumbUrl}');` : '';
  const audioPlaceholder = isAudio && !thumbUrl ? '<span>ÁUDIO</span>' : '';
  const durationBadge = (!isPhoto && !isAudio) ? `<div class="lib-card-duration">${formatDuration(media.duration)}</div>` : '';

  return `
    <div class="lib-card media-clickable ${isSelected ? 'selected' : ''}" data-id="${media.id}">
      <div class="${thumbClass}" style="${thumbStyle}">
        <input type="checkbox" class="lib-card-checkbox" ${isSelected ? 'checked' : ''}>
        <span class="material-symbols-rounded lib-card-badge-fav ${favClass}">${favIcon}</span>
        ${audioPlaceholder}
        ${durationBadge}
      </div>
      <div class="lib-card-info">
        <div class="lib-card-title" title="${escapeAttr(media.filename)}">${escapeHtml(media.filename)}</div>
        <div class="lib-card-meta">
          <span>${dateStr}</span>
          <span>${isPhoto ? 'Foto' : (isAudio ? 'Áudio' : (media.video_codec ? media.height+'p' : ''))}</span>
          <span>${(!isPhoto && !isAudio && media.fps) ? media.fps+'fps' : ''}</span>
        </div>
        <div class="lib-card-origin">${escapeHtml(originText)}</div>
        <span class="material-symbols-rounded lib-card-menu">more_vert</span>
      </div>
    </div>
  `;
}

function renderListRow(media) {
  const thumbUrl = media.thumbnail ? `${thumbsDir}/${media.thumbnail}` : '';
  const icon = (media.origin && media.origin.includes('BDSM')) ? 'smartphone' : 'computer';
  const isSelected = selectedIds.has(media.id);
  const favClass = media.favorite ? 'active' : '';
  const favIcon = media.favorite ? 'star' : 'star_border';
  const thumbStyle = thumbUrl ? `background-image: url('${thumbUrl}');` : '';

  return `
    <tr class="media-clickable ${isSelected ? 'selected' : ''}" data-id="${media.id}">
      <td>
        <div class="lib-list-cell-content">
          <input type="checkbox" class="lib-card-checkbox" ${isSelected ? 'checked' : ''}>
          <div class="lib-list-thumb" style="${thumbStyle}"></div>
          <span class="material-symbols-rounded lib-list-fav-btn ${favClass}">${favIcon}</span>
          <span class="lib-list-filename" title="${escapeAttr(media.filename)}">${escapeHtml(media.filename)}</span>
        </div>
      </td>
      <td>
        <div class="lib-list-origin-cell">
          <span class="material-symbols-rounded">${icon}</span>
          ${escapeHtml(media.origin || 'Computador / Local')}
        </div>
      </td>
      <td>${media.height ? media.height + 'p' : '-'}</td>
      <td>${media.fps || '-'}</td>
      <td>${formatBytes(media.filesize)}</td>
    </tr>
  `;
}

function openInspector(media) {
  currentInspectorMedia = media;
  const inspector = document.getElementById('libraryInspector');
  if (!inspector) return;
  
  const thumbUrl = media.thumbnail ? `${thumbsDir}/${media.thumbnail}` : '';
  const thumbEl = document.getElementById('inspectorThumbnail');
  if (thumbEl) thumbEl.style.backgroundImage = `url('${thumbUrl}')`;
  
  const titleEl = document.getElementById('inspectorTitle');
  const titleEdit = document.getElementById('inspectorTitleEdit');
  if (titleEl) titleEl.textContent = media.filename;
  if (titleEdit) titleEdit.value = media.filename;
  if (titleEl) {
    titleEl.classList.remove('hidden');
    titleEl.style.display = 'block';
  }
  if (titleEdit) {
    titleEdit.classList.add('hidden');
    titleEdit.style.display = 'none';
  }
  
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

  const setEl = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setEl('inspectorSize', formatBytes(media.filesize));
  setEl('inspectorRes', media.width ? `${media.width}x${media.height}` : '-');
  setEl('inspectorVCodec', media.video_codec || '-');
  setEl('inspectorACodec', media.audio_codec || '-');
  setEl('inspectorFps', media.fps || '-');
  setEl('inspectorOrigin', media.origin || 'Computador / Local');
  
  const parseDBDate = (dateStr) => {
    if (!dateStr) return null;
    const cleanStr = dateStr.replace(' ', 'T') + (dateStr.endsWith('Z') ? '' : 'Z');
    const d = new Date(cleanStr);
    return isNaN(d) ? null : d;
  };

  const importedD = parseDBDate(media.imported_at);
  const recordedD = parseDBDate(media.recorded_at);

  setEl('inspectorDate', importedD ? importedD.toLocaleString('pt-BR') : '-');
  setEl('inspectorRecordDate', recordedD ? recordedD.toLocaleString('pt-BR') : '-');
  setEl('inspectorDuration', isPhoto ? '-' : formatDuration(media.duration));
  
  if (thumbDuration) {
    if (isPhoto) {
      thumbDuration.style.display = 'none';
    } else {
      thumbDuration.style.display = 'block';
      thumbDuration.textContent = formatDuration(media.duration);
    }
  }

  function formatBitrate(bps) {
    if (!bps) return '-';
    const kbps = bps / 1000;
    if (kbps > 1000) return (kbps / 1000).toFixed(1) + ' Mbps';
    return Math.round(kbps) + ' kbps';
  }

  const bitrateStr = formatBitrate(media.bitrate);
  
  if (isAudio) {
    setEl('inspectorVBitrate', '-');
    setEl('inspectorABitrate', bitrateStr);
  } else if (!isPhoto) {
    setEl('inspectorVBitrate', bitrateStr);
    setEl('inspectorABitrate', '-');
  } else {
    setEl('inspectorVBitrate', '-');
    setEl('inspectorABitrate', '-');
  }

  const toggleRow = (id, show) => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? 'flex' : 'none';
  };

  toggleRow('rowDuration', !isPhoto);
  toggleRow('rowFps', !isPhoto && !isAudio);
  toggleRow('rowVCodec', !isPhoto && !isAudio);
  toggleRow('rowVBitrate', !isPhoto && !isAudio);
  toggleRow('rowRes', !isPhoto && !isAudio);
  toggleRow('rowACodec', !isPhoto);
  toggleRow('rowABitrate', !isPhoto);

  setEl('inspectorPath', media.filepath);
  
  const favStar = document.getElementById('inspectorFavStar');
  if (favStar) {
    if (media.favorite === 1) {
      favStar.classList.add('active');
      favStar.textContent = 'star';
    } else {
      favStar.classList.remove('active');
      favStar.textContent = 'star_border';
    }
  }

  setEl('inspectorProject', media.project_name ? media.project_name : 'Nenhum (Vincular)');

  loadMediaTags(media.id);
  
  inspector.classList.remove('hidden');
  inspector.classList.add('active');
}

async function loadMediaTags(mediaId) {
  const tagsContainer = document.getElementById('inspectorTags');
  const addBtn = document.getElementById('btnAddTag');
  if (!tagsContainer || !addBtn) return;
  
  tagsContainer.innerHTML = '';
  tagsContainer.appendChild(addBtn);

  if (!window.bds || !window.bds.getMediaTags) return;
  const tags = await window.bds.getMediaTags(mediaId);
  
  tags.forEach(tag => {
    const span = document.createElement('span');
    span.className = 'inspector-tag-chip';
    let displayName = tag.name;
    if (displayName.startsWith('TAG:creation_time=')) {
        displayName = 'Data da Gravação: ' + displayName.replace('TAG:creation_time=', '');
    }
    span.innerHTML = `
      ${escapeHtml(displayName)}
      <span class="material-symbols-rounded remove-tag" data-id="${tag.id}">close</span>
    `;
    tagsContainer.insertBefore(span, addBtn);
  });

  tagsContainer.querySelectorAll('.remove-tag').forEach(el => {
    el.addEventListener('click', async (e) => {
      const tagId = e.target.getAttribute('data-id');
      if (tagId && window.bds && window.bds.removeMediaTag) {
        await window.bds.removeMediaTag(mediaId, tagId);
        loadMediaTags(mediaId);
        loadFilterOptions();
      }
    });
  });
}

function bindInspectorEvents() {
  const titleText = document.getElementById('inspectorTitle');
  const titleEdit = document.getElementById('inspectorTitleEdit');

  if (titleText && titleEdit) {
    titleText.addEventListener('click', () => {
      titleText.style.display = 'none';
      titleText.classList.add('hidden');
      titleEdit.style.display = 'block';
      titleEdit.classList.remove('hidden');
      titleEdit.focus();
    });

    titleEdit.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const newName = titleEdit.value.trim();
        if (newName && currentInspectorMedia) {
          titleText.textContent = newName;
          if (window.bds && window.bds.renameMedia) {
            await window.bds.renameMedia(currentInspectorMedia.id, newName);
          }
          fetchMedia();
        }
        titleEdit.style.display = 'none';
        titleEdit.classList.add('hidden');
        titleText.style.display = 'block';
        titleText.classList.remove('hidden');
      }
      if (e.key === 'Escape') {
        titleEdit.value = titleText.textContent;
        titleEdit.style.display = 'none';
        titleEdit.classList.add('hidden');
        titleText.style.display = 'block';
        titleText.classList.remove('hidden');
      }
    });
  }

  const favStar = document.getElementById('inspectorFavStar');
  if (favStar) {
    favStar.addEventListener('click', async () => {
      if (!currentInspectorMedia) return;
      const isFav = currentInspectorMedia.favorite !== 1;
      currentInspectorMedia.favorite = isFav ? 1 : 0;
      
      if (isFav) {
        favStar.classList.add('active');
        favStar.textContent = 'star';
      } else {
        favStar.classList.remove('active');
        favStar.textContent = 'star_border';
      }
      
      if (window.bds && window.bds.toggleFavorite) {
        await window.bds.toggleFavorite(currentInspectorMedia.id, isFav);
      }
      fetchMedia();
    });
  }

  const btnAddTag = document.getElementById('btnAddTag');
  const tagEdit = document.getElementById('inspectorTagEdit');
  if (btnAddTag && tagEdit) {
    btnAddTag.addEventListener('click', () => {
      tagEdit.style.display = 'block';
      tagEdit.classList.remove('hidden');
      tagEdit.focus();
    });

    tagEdit.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const tagName = tagEdit.value.trim();
        if (tagName && currentInspectorMedia && window.bds && window.bds.addMediaTag) {
          await window.bds.addMediaTag(currentInspectorMedia.id, tagName);
          tagEdit.value = '';
          tagEdit.style.display = 'none';
          tagEdit.classList.add('hidden');
          loadMediaTags(currentInspectorMedia.id);
          loadFilterOptions();
        }
      }
      if (e.key === 'Escape') {
        tagEdit.value = '';
        tagEdit.style.display = 'none';
        tagEdit.classList.add('hidden');
      }
    });
  }

  // Vincular Projeto pelo Inspetor
  const inspectorProjectEl = document.querySelector('.inspector-value-project');
  if (inspectorProjectEl) {
    inspectorProjectEl.style.cursor = 'pointer';
    inspectorProjectEl.addEventListener('click', () => {
      if (currentInspectorMedia) {
        openAddToProjectModal([currentInspectorMedia.id]);
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
      if (conf && window.bds && window.bds.deleteMediaBulk) {
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
      const selectedMedia = mediaItems.filter(m => ids.includes(m.id));
      const favCount = selectedMedia.filter(m => m.favorite === 1).length;
      const isFav = favCount <= ids.length / 2;
      
      if (window.bds && window.bds.toggleFavoriteBulk) {
        await window.bds.toggleFavoriteBulk(ids, isFav);
        fetchMedia();
      }
    });
  }

  const btnRenameBulk = document.getElementById('btnActionRename');
  if (btnRenameBulk) {
    btnRenameBulk.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      const baseName = await window.bdsModal.prompt(`Renomear ${ids.length} arquivo(s) em lote.\nInforme o novo nome base:`);
      if (baseName && baseName.trim() && window.bds && window.bds.renameMediaBulk) {
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
      const tagName = await window.bdsModal.prompt(`Adicionar Tag a ${ids.length} arquivo(s):\nInforme o nome da tag:`);
      if (tagName && tagName.trim() && window.bds && window.bds.addMediaTagBulk) {
        await window.bds.addMediaTagBulk(ids, tagName.trim());
        fetchMedia();
        loadFilterOptions();
      }
    });
  }

  const btnMoveBulk = document.getElementById('btnActionMove');
  if (btnMoveBulk) {
    btnMoveBulk.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      const folder = await window.bds.selectFolder();
      if (folder && window.bds && window.bds.moveMediaBulk) {
        const conf = await window.bdsModal.confirm(`Mover ${ids.length} arquivo(s) para a pasta:\n${folder}?`);
        if (conf) {
          await window.bds.moveMediaBulk(ids, folder);
          selectedIds.clear();
          updateSelectionVisuals();
          fetchMedia();
        }
      }
    });
  }

  const btnProjectBulk = document.getElementById('btnActionProject');
  if (btnProjectBulk) {
    btnProjectBulk.addEventListener('click', () => {
      if (selectedIds.size === 0) return;
      openAddToProjectModal(Array.from(selectedIds));
    });
  }
}

// --- MODAL DE ADICIONAR MÍDIAS AO PROJETO ---
let pendingAddToProjectMediaIds = [];

function setupAddToProjectModal() {
  const modal = document.getElementById('modalAddToProject');
  const btnClose = document.getElementById('btnCloseAddToProjectModal');
  const btnCancel = document.getElementById('btnCancelAddToProject');
  const btnConfirm = document.getElementById('btnConfirmAddToProject');
  const selectProj = document.getElementById('selectTargetProject');
  const selectBin = document.getElementById('selectTargetBin');
  const btnNewBin = document.getElementById('btnCreateBinInModal');

  const closeModal = () => {
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('active');
      pendingAddToProjectMediaIds = [];
    }
  };

  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

  if (selectProj) {
    selectProj.addEventListener('change', async () => {
      const projId = selectProj.value ? parseInt(selectProj.value, 10) : null;
      await loadBinsForProject(projId);
    });
  }

  if (btnNewBin) {
    btnNewBin.addEventListener('click', async () => {
      const projId = selectProj.value ? parseInt(selectProj.value, 10) : null;
      if (!projId) {
        window.bdsModal.alert('Selecione primeiro um projeto de destino.');
        return;
      }
      const binName = await window.bdsModal.prompt('Nome da nova pasta (Bin):');
      if (binName && binName.trim()) {
        try {
          const newBinId = await window.bds.createProjectBin(projId, null, binName.trim());
          await loadBinsForProject(projId);
          if (selectBin) selectBin.value = newBinId;
        } catch (e) {
          console.error(e);
          window.bdsModal.alert('Erro ao criar pasta no projeto.');
        }
      }
    });
  }

  if (btnConfirm) {
    btnConfirm.addEventListener('click', async () => {
      const projId = selectProj.value ? parseInt(selectProj.value, 10) : null;
      if (!projId) {
        window.bdsModal.alert('Selecione um projeto de destino.');
        return;
      }
      const binId = selectBin.value ? parseInt(selectBin.value, 10) : null;
      
      try {
        const addedCount = await window.bds.addProjectMediaBulk(projId, binId, pendingAddToProjectMediaIds);
        closeModal();
        selectedIds.clear();
        updateSelectionVisuals();
        fetchMedia();
        loadFilterOptions();
        window.bdsModal.alert(`${addedCount} mídia(s) adicionada(s) ao projeto com sucesso!`);
      } catch (e) {
        console.error('Erro ao adicionar mídias ao projeto:', e);
        window.bdsModal.alert('Erro ao vincular mídias ao projeto.');
      }
    });
  }
}

async function loadBinsForProject(projectId) {
  const selectBin = document.getElementById('selectTargetBin');
  if (!selectBin) return;
  selectBin.innerHTML = '<option value="">Raiz do Projeto (Sem pasta)</option>';
  if (!projectId) return;

  try {
    const bins = await window.bds.getProjectBins(projectId);
    (bins || []).forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = `📁 ${b.name}`;
      selectBin.appendChild(opt);
    });
  } catch (e) {
    console.error('Erro ao listar bins do projeto:', e);
  }
}

async function openAddToProjectModal(mediaIds = []) {
  if (!mediaIds || mediaIds.length === 0) return;
  pendingAddToProjectMediaIds = mediaIds;

  const modal = document.getElementById('modalAddToProject');
  const summary = document.getElementById('addToProjectSummary');
  const selectProj = document.getElementById('selectTargetProject');
  const selectBin = document.getElementById('selectTargetBin');

  if (!modal || !selectProj) return;

  if (summary) {
    summary.textContent = `Adicionar ${mediaIds.length} mídia(s) selecionada(s) como referências no projeto escolhido.`;
  }

  selectProj.innerHTML = '<option value="">Selecione um projeto...</option>';
  if (selectBin) selectBin.innerHTML = '<option value="">Raiz do Projeto (Sem pasta)</option>';

  try {
    const projects = await window.bds.listProjects();
    if (!projects || projects.length === 0) {
      selectProj.innerHTML = '<option value="">Nenhum projeto encontrado</option>';
      window.bdsModal.alert('Nenhum projeto encontrado. Crie um projeto primeiro na tela de Projetos.');
      return;
    }

    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.status || 'Ativo'})`;
      selectProj.appendChild(opt);
    });

    if (projects.length === 1) {
      selectProj.value = projects[0].id;
      await loadBinsForProject(projects[0].id);
    }

    modal.classList.remove('hidden');
    modal.classList.add('active');
  } catch (e) {
    console.error('Erro ao carregar projetos:', e);
    window.bdsModal.alert('Erro ao carregar lista de projetos.');
  }
}

function closeInspector() {
  const inspector = document.getElementById('libraryInspector');
  if (inspector) {
    inspector.classList.add('hidden');
    inspector.classList.remove('active');
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>'"]/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[m]));
}

function escapeAttr(str) {
  return escapeHtml(str);
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
  
  // Se o banco foi limpo (total de tipos = 0), resetamos os filtros selecionados
  const totalItemsInDb = (options.types.video || 0) + (options.types.audio || 0) + (options.types.photo || 0);
  if (totalItemsInDb === 0) {
    resetFilters();
  }
  
  const createGroup = (title, items, name, valueKey, labelKey, countKey, formatter = v=>v) => {
    if (!items || items.length === 0) return '';
    let html = `
      <div class="filter-group-header">
        <h3 class="filter-group-title">${title}</h3>
      </div>
    `;
    items.forEach(item => {
      const isChecked = currentFilters[name + 's']?.includes(item[valueKey]) || currentFilters[name]?.includes(item[valueKey]);
      html += `
        <label class="lib-filter-row">
          <div class="lib-filter-row-inner">
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
  const originsContainer = document.getElementById('filterOriginsContainer');
  if (originsContainer) {
    originsContainer.innerHTML = originsHtml;
    bindEvents('filterOriginsContainer');
  }

  // Albums
  const albumsHtml = createGroup('Álbuns / Pastas', options.albums, 'album', 'name', 'name', 'count');
  const albumsContainer = document.getElementById('filterAlbumsContainer');
  if (albumsContainer) {
    albumsContainer.innerHTML = albumsHtml;
    bindEvents('filterAlbumsContainer');
  }

  // Types
  const typeArr = [
    { typeVal: 'video', label: 'Vídeos', count: options.types.video },
    { typeVal: 'audio', label: 'Áudios', count: options.types.audio },
    { typeVal: 'photo', label: 'Fotos', count: options.types.photo }
  ].filter(t => t.count > 0);
  const typesHtml = createGroup('Tipos', typeArr, 'type', 'typeVal', 'typeVal', 'count', val => val === 'video' ? 'Vídeos' : (val === 'audio' ? 'Áudios' : 'Fotos'));
  const typesContainer = document.getElementById('filterTypesContainer');
  if (typesContainer) {
    typesContainer.innerHTML = typesHtml;
    bindEvents('filterTypesContainer');
  }

  // Resolutions
  const resHtml = createGroup('Resolução Vertical', options.resolutions, 'res', 'height', 'height', 'count', r => r + 'p');
  const resContainer = document.getElementById('filterResContainer');
  if (resContainer) {
    resContainer.innerHTML = resHtml;
    bindEvents('filterResContainer');
  }

  // FPS
  const fpsHtml = createGroup('FPS', options.fps, 'fps', 'fps', 'fps', 'count', f => f + ' fps');
  const fpsContainer = document.getElementById('filterFpsContainer');
  if (fpsContainer) {
    fpsContainer.innerHTML = fpsHtml;
    bindEvents('filterFpsContainer');
  }
  
  // Data
  const dateHtml = createGroup('Data de Gravação', options.dates, 'date', 'dt', 'dt', 'count', d => {
    const parts = d.split('-');
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  });
  const dateContainer = document.getElementById('filterDateContainer');
  if (dateContainer) {
    dateContainer.innerHTML = dateHtml;
    bindEvents('filterDateContainer');
  }

  // Projetos
  const projHtml = createGroup('Projetos', options.projects, 'project', 'id', 'name', 'count');
  const projContainer = document.getElementById('filterProjectsContainer');
  if (projContainer) {
    projContainer.innerHTML = projHtml;
    bindEvents('filterProjectsContainer');
  }

  // Tags
  const tagsHtml = createGroup('Tags', options.tags, 'tag', 'id', 'name', 'count');
  const tagsContainer = document.getElementById('filterTagsContainer');
  if (tagsContainer) {
    tagsContainer.innerHTML = tagsHtml;
    bindEvents('filterTagsContainer');
  }

  // Favorites
  const favContainer = document.getElementById('filterFavoritesContainer');
  if (favContainer) {
    if (options.favoritesCount > 0) {
      const isFav = currentFilters.favorites;
      favContainer.innerHTML = `
        <div class="filter-group-header">
          <h3 class="filter-group-title">Favoritos</h3>
        </div>
        <label class="lib-filter-row">
          <div class="lib-filter-row-inner">
            <input type="checkbox" name="favorite" value="1" class="lib-filter-chk" ${isFav ? 'checked' : ''}>
            <span class="lib-filter-custom-chk material-symbols-rounded" style="color: var(--accent);">${isFav ? 'check_box' : 'check_box_outline_blank'}</span>
            <span>Apenas Favoritos</span>
          </div>
          <span class="lib-filter-count">${options.favoritesCount}</span>
        </label>
      `;
      bindEvents('filterFavoritesContainer');
    } else {
      favContainer.innerHTML = '';
    }
  }
}