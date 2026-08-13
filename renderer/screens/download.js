import { els, state, setStatus, escapeHtml } from '../app.js';

let metadataTimer = null;

export function initScreen() {
  console.log('[DOWNLOAD] Inicializando tela...');
  setStatus('Pronto.');
  setControlsEnabled(true);

  if (els.urlInput) {
    els.urlInput.addEventListener('input', () => {
      clearTimeout(metadataTimer);
      metadataTimer = setTimeout(loadMetadata, 300);
    });

    els.urlInput.addEventListener('paste', () => {
      clearTimeout(metadataTimer);
      metadataTimer = setTimeout(loadMetadata, 100);
    });
  }

  if (els.metadataButton) {
    els.metadataButton.addEventListener('click', addToQueue);
  }
  if (els.mp3Button) {
    els.mp3Button.addEventListener('click', () => startDownloadDirect('MP3'));
  }
  if (els.mp4Button) {
    els.mp4Button.addEventListener('click', () => startDownloadDirect('MP4'));
  }
  if (els.stopButton) {
    els.stopButton.addEventListener('click', pauseQueue);
  }

  const btnStartQueue = document.getElementById('btnStartQueue');
  const btnPauseQueue = document.getElementById('btnPauseQueue');
  const btnClearCompleted = document.getElementById('btnClearCompleted');
  const btnClearAll = document.getElementById('btnClearAll');
  const btnQueueAllMp3 = document.getElementById('btnQueueAllMp3');
  const btnQueueAllMp4 = document.getElementById('btnQueueAllMp4');

  if (btnStartQueue) btnStartQueue.addEventListener('click', startQueue);
  if (btnPauseQueue) btnPauseQueue.addEventListener('click', pauseQueue);
  if (btnClearCompleted) btnClearCompleted.addEventListener('click', clearCompleted);
  if (btnClearAll) btnClearAll.addEventListener('click', clearAllQueue);
  if (btnQueueAllMp3) btnQueueAllMp3.addEventListener('click', () => convertAllQueueTo('MP3'));
  if (btnQueueAllMp4) btnQueueAllMp4.addEventListener('click', () => convertAllQueueTo('MP4'));

  if (state.metadata) {
    renderMetadata(state.metadata);
  }

  fetchQueue();
  setupEventListeners();
}

function getDownloadsApi() {
  return window.bds && window.bds.downloads ? window.bds.downloads : {
    getQueue: () => window.bds.downloadGetQueue ? window.bds.downloadGetQueue() : Promise.resolve([]),
    add: (req) => window.bds.startDownload ? window.bds.startDownload(req) : Promise.resolve(),
    start: () => Promise.resolve(),
    pause: () => Promise.resolve(),
    cancel: (id) => window.bds.downloadRemoveJob ? window.bds.downloadRemoveJob(id) : Promise.resolve(),
    retry: () => Promise.resolve(),
    remove: (id) => window.bds.downloadRemoveJob ? window.bds.downloadRemoveJob(id) : Promise.resolve(),
    reorder: () => Promise.resolve(),
    clearCompleted: () => window.bds.downloadClearQueue ? window.bds.downloadClearQueue() : Promise.resolve()
  };
}

async function fetchQueue() {
  try {
    const api = getDownloadsApi();
    const queue = await api.getQueue();
    state.downloadQueue = queue || [];
    renderDownloadQueue(state.downloadQueue);
  } catch (err) {
    console.error('[DOWNLOAD] Erro ao buscar fila:', err);
  }
}

function setupEventListeners() {
  const api = getDownloadsApi();

  if (api.onUpdated) {
    api.onUpdated((queue) => {
      state.downloadQueue = queue;
      renderDownloadQueue(queue);
    });
  }

  if (api.onProgress) {
    api.onProgress((data) => {
      updateProgressVisuals(data);
    });
  }
}

export function renderDownloadQueue(queue) {
  const container = document.getElementById('downloadQueueContainer');
  const activeSection = document.getElementById('activeDownloadSection');
  const activeContent = document.getElementById('activeDownloadContent');
  if (!container) return;

  const items = queue || [];

  // Métricas
  const total = items.length;
  const queuedCount = items.filter(i => i.status === 'queued').length;
  const activeItem = items.find(i => i.status === 'downloading');
  const activeCount = activeItem ? 1 : 0;
  const completedCount = items.filter(i => i.status === 'completed').length;

  const metricTotal = document.getElementById('metricTotal');
  const metricQueued = document.getElementById('metricQueued');
  const metricActive = document.getElementById('metricActive');
  const metricCompleted = document.getElementById('metricCompleted');

  if (metricTotal) metricTotal.textContent = total;
  if (metricQueued) metricQueued.textContent = queuedCount;
  if (metricActive) metricActive.textContent = activeCount;
  if (metricCompleted) metricCompleted.textContent = completedCount;

  // Download Ativo
  if (activeItem && activeSection && activeContent) {
    activeSection.classList.remove('hidden');
    activeSection.classList.add('active');
    
    const thumbHtml = activeItem.thumbnail 
      ? `<img src="${escapeHtml(activeItem.thumbnail)}" class="active-download-thumb" />` 
      : `<div class="active-download-thumb-placeholder"><span class="material-symbols-rounded">movie</span></div>`;

    const channelInfo = activeItem.channel ? escapeHtml(activeItem.channel) : (activeItem.platform || 'YouTube');

    activeContent.innerHTML = `
      ${thumbHtml}
      <div class="active-download-info">
        <div class="active-download-title-row">
          <span class="active-download-title" title="${escapeHtml(activeItem.title)}">${escapeHtml(activeItem.title)}</span>
          <span class="active-download-badge">${escapeHtml(activeItem.format)} • ${escapeHtml(activeItem.quality)}</span>
        </div>
        <div class="active-download-meta">
          ${channelInfo} • ${activeItem.duration ? formatDuration(activeItem.duration) : '--'}
        </div>
        <div class="active-download-progress">
          <div id="dl-fill-${activeItem.id}" class="active-download-progress-fill" style="width: ${activeItem.progress || 0}%;"></div>
        </div>
        <div class="active-download-stats">
          <span id="dl-percent-${activeItem.id}">${Math.round(activeItem.progress || 0)}%</span>
          <span id="dl-bytes-${activeItem.id}">${formatBytes(activeItem.downloadedBytes)} / ${formatBytes(activeItem.totalBytes)}</span>
          <span id="dl-speed-${activeItem.id}">${activeItem.speed || '--'} • ETA ${activeItem.eta || '--'}</span>
        </div>
      </div>
      <button type="button" class="active-download-cancel-btn" data-action="cancel" data-id="${activeItem.id}">
        <span class="material-symbols-rounded">cancel</span>
        Cancelar
      </button>
    `;
  } else if (activeSection) {
    activeSection.classList.add('hidden');
    activeSection.classList.remove('active');
  }

  if (items.length === 0) {
    container.innerHTML = `<div class="queue-empty-state">Nenhum download na fila.</div>`;
    setBusy(false);
    return;
  }

  let html = '';
  items.forEach((item) => {
    let statusBadge = '';
    let actionsHtml = '';
    let cardClass = 'download-card';

    if (item.status === 'queued') {
      statusBadge = `<span class="status-badge status-badge-queued">Aguardando</span>`;
      actionsHtml = `
        <button type="button" class="card-action-btn card-action-btn-default" data-action="reorder-up" data-id="${item.id}" title="Mover para cima">
          <span class="material-symbols-rounded">arrow_upward</span>
        </button>
        <button type="button" class="card-action-btn card-action-btn-default" data-action="reorder-down" data-id="${item.id}" title="Mover para baixo">
          <span class="material-symbols-rounded">arrow_downward</span>
        </button>
        <button type="button" class="card-action-btn card-action-btn-danger" data-action="remove" data-id="${item.id}" title="Remover">
          <span class="material-symbols-rounded">close</span>
        </button>
      `;
    } else if (item.status === 'downloading') {
      statusBadge = `<span class="status-badge status-badge-downloading">Baixando</span>`;
      cardClass += ' status-downloading';
      actionsHtml = `
        <button type="button" class="card-action-btn card-action-btn-danger" data-action="cancel" data-id="${item.id}" title="Cancelar">
          <span class="material-symbols-rounded">cancel</span>
        </button>
      `;
    } else if (item.status === 'paused') {
      statusBadge = `<span class="status-badge status-badge-paused">Pausado</span>`;
      actionsHtml = `
        <button type="button" class="card-action-btn card-action-btn-warning" data-action="retry" data-id="${item.id}" title="Retomar">
          <span class="material-symbols-rounded">play_arrow</span>
        </button>
        <button type="button" class="card-action-btn card-action-btn-default" data-action="remove" data-id="${item.id}" title="Remover">
          <span class="material-symbols-rounded">close</span>
        </button>
      `;
    } else if (item.status === 'completed') {
      statusBadge = `<span class="status-badge status-badge-completed">✓ Concluído</span>`;
      actionsHtml = `
        ${item.outputPath ? `<button type="button" class="card-action-btn card-action-btn-info" data-action="open-path" data-path="${escapeAttr(item.outputPath)}" title="Abrir arquivo">
          <span class="material-symbols-rounded">folder_open</span>
        </button>` : ''}
        <button type="button" class="card-action-btn card-action-btn-default" data-action="remove" data-id="${item.id}" title="Remover">
          <span class="material-symbols-rounded">close</span>
        </button>
      `;
    } else if (item.status === 'failed' || item.status === 'cancelled') {
      const isFailed = item.status === 'failed';
      statusBadge = `<span class="status-badge ${isFailed ? 'status-badge-failed' : 'status-badge-cancelled'}" title="${escapeHtml(item.error || '')}">${isFailed ? '✕ Falhou' : 'Cancelado'}</span>`;
      actionsHtml = `
        <button type="button" class="card-action-btn card-action-btn-warning" data-action="retry" data-id="${item.id}" title="Tentar novamente">
          <span class="material-symbols-rounded">replay</span>
        </button>
        <button type="button" class="card-action-btn card-action-btn-default" data-action="remove" data-id="${item.id}" title="Remover">
          <span class="material-symbols-rounded">close</span>
        </button>
      `;
    }

    const thumbHtml = item.thumbnail
      ? `<img src="${escapeHtml(item.thumbnail)}" class="download-card-thumb" />`
      : `<div class="download-card-thumb-placeholder"><span class="material-symbols-rounded">movie</span></div>`;

    let formatAndQualitySelectors = '';
    if (item.status === 'queued') {
      const isSpot = isSpotify(item.url || '');
      const isMp3 = item.format === 'MP3' || isSpot;
      const qualityOptions = isMp3 ? `
        <option value="320kbps" ${item.quality === '320kbps' || item.quality === 'best' ? 'selected' : ''}>320 kbps</option>
        <option value="256kbps" ${item.quality === '256kbps' ? 'selected' : ''}>256 kbps</option>
        <option value="192kbps" ${item.quality === '192kbps' ? 'selected' : ''}>192 kbps</option>
        <option value="128kbps" ${item.quality === '128kbps' ? 'selected' : ''}>128 kbps</option>
      ` : `
        <option value="best" ${item.quality === 'best' ? 'selected' : ''}>Melhor disponível</option>
        <option value="2160p" ${item.quality === '2160p' ? 'selected' : ''}>2160p (4K)</option>
        <option value="1440p" ${item.quality === '1440p' ? 'selected' : ''}>1440p (2K)</option>
        <option value="1080p" ${item.quality === '1080p' ? 'selected' : ''}>1080p (FHD)</option>
        <option value="720p" ${item.quality === '720p' ? 'selected' : ''}>720p (HD)</option>
        <option value="480p" ${item.quality === '480p' ? 'selected' : ''}>480p</option>
        <option value="360p" ${item.quality === '360p' ? 'selected' : ''}>360p</option>
      `;

      formatAndQualitySelectors = `
        <div class="download-card-selectors">
          <select class="download-card-select" data-action="toggle-format" data-id="${item.id}" ${isSpot ? 'disabled title="Links do Spotify são suportados apenas em MP3"' : ''}>
            <option value="MP4" ${!isMp3 ? 'selected' : ''}>MP4</option>
            <option value="MP3" ${isMp3 ? 'selected' : ''}>MP3</option>
          </select>
          <select class="download-card-select" data-action="update-quality" data-id="${item.id}">
            ${qualityOptions}
          </select>
        </div>
      `;
    } else {
      formatAndQualitySelectors = `
        <span class="download-card-format-badge">
          ${escapeHtml(item.format)} • ${escapeHtml(item.quality)}
        </span>
      `;
    }

    const channelText = item.channel ? escapeHtml(item.channel) : (item.platform || 'YouTube');
    const durationText = item.duration ? formatDuration(item.duration) : '';
    const metaSubtitle = `${channelText} • ${item.platform || 'YouTube'}${durationText ? ' • ' + durationText : ''}`;

    html += `
      <div class="${cardClass}" data-item-id="${item.id}">
        <div class="download-card-top">
          <div class="download-card-info">
            ${thumbHtml}
            <div class="download-card-details">
              <span class="download-card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
              <span class="download-card-subtitle">${metaSubtitle}</span>
            </div>
          </div>
          ${formatAndQualitySelectors}
        </div>

        <div class="download-card-bottom">
          <div class="download-card-progress-section">
            <div class="download-card-progress-track">
              <div class="download-card-progress-fill" style="width: ${item.progress || 0}%;"></div>
            </div>
            <div class="download-card-progress-info">
              <span>${Math.round(item.progress || 0)}%</span>
              <span class="speed-info">${item.speed || '--'} ${item.eta ? '• ETA ' + item.eta : ''}</span>
            </div>
          </div>
          <div class="download-card-actions">
            ${statusBadge}
            <div class="download-card-buttons">
              ${actionsHtml}
            </div>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  
  // Event delegation para botões dinâmicos
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const path = btn.dataset.path;
      
      handleQueueAction(action, id, path);
    });
  });
  
  // Selects de formato e qualidade
  container.querySelectorAll('[data-action="toggle-format"]').forEach(select => {
    select.addEventListener('change', (e) => {
      const id = select.dataset.id;
      const newFormat = e.target.value;
      toggleItemFormat(id, newFormat);
    });
  });
  
  container.querySelectorAll('[data-action="update-quality"]').forEach(select => {
    select.addEventListener('change', (e) => {
      const id = select.dataset.id;
      const newQuality = e.target.value;
      updateItemQuality(id, newQuality);
    });
  });
  
  // Event delegation para seção de download ativo
  if (activeContent) {
    activeContent.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        handleQueueAction(action, id, null);
      });
    });
  }
  
  setBusy(activeCount > 0);
}

async function handleQueueAction(action, id, path) {
  switch (action) {
    case 'cancel':
      await cancelDownload(id);
      break;
    case 'remove':
      await removeQueueItem(id);
      break;
    case 'retry':
      await retryQueueItem(id);
      break;
    case 'reorder-up':
      await reorderQueue(id, 'up');
      break;
    case 'reorder-down':
      await reorderQueue(id, 'down');
      break;
    case 'open-path':
      openPath(path);
      break;
  }
}

export function updateProgressVisuals(payload) {
  if (!payload.id) return;
  const fill = document.getElementById(`dl-fill-${payload.id}`);
  const percentEl = document.getElementById(`dl-percent-${payload.id}`);
  const speedEl = document.getElementById(`dl-speed-${payload.id}`);
  const bytesEl = document.getElementById(`dl-bytes-${payload.id}`);

  if (fill && typeof payload.progress === 'number') {
    fill.style.width = `${payload.progress}%`;
  }
  if (percentEl && typeof payload.progress === 'number') {
    percentEl.textContent = `${Math.round(payload.progress)}%`;
  }
  if (speedEl) {
    speedEl.textContent = `${payload.speed || '--'} | ETA ${payload.eta || '--'}`;
  }
  if (bytesEl) {
    bytesEl.textContent = `${formatBytes(payload.downloadedBytes)} / ${formatBytes(payload.totalBytes)}`;
  }
}

export function setControlsEnabled(enabled) {
  if (els.mp3Button) els.mp3Button.disabled = !enabled;
  if (els.mp4Button) els.mp4Button.disabled = !enabled;
  if (els.metadataButton) els.metadataButton.disabled = !enabled;
  if (els.urlInput) els.urlInput.disabled = !enabled;
  if (els.resolutionSelect) els.resolutionSelect.disabled = !enabled;
}

async function loadMetadata() {
  if (!els.urlInput) return;
  const url = els.urlInput.value.trim();
  if (!url) return;

  try {
    setStatus('Buscando informações da mídia...');
    const metadata = await window.bds.getMetadata(url);
    state.metadata = metadata;
    
    if (els.mediaTitle) {
      renderMetadata(metadata);
    }
    setStatus('Informações carregadas.');
  } catch (error) {
    state.metadata = null;
    setStatus(error.message || 'Não foi possível carregar a miniatura.');
  }
}

function renderMetadata(metadata) {
  if (!els.mediaTitle) return;
  
  els.mediaTitle.textContent = metadata.title || 'Mídia sem título';
  els.mediaChannel.textContent = metadata.channel || 'Canal não informado';
  els.mediaDuration.textContent = formatDuration(metadata.duration);
  els.mediaType.textContent = metadata.type === 'playlist' 
    ? 'Playlist' 
    : detectSource(metadata.webpageUrl || els.urlInput.value);

  if (metadata.thumbnail) {
    els.thumbnail.src = metadata.thumbnail;
    els.thumbnail.classList.remove('hidden');
    els.thumbnailPlaceholder.classList.add('hidden');
  } else {
    els.thumbnail.removeAttribute('src');
    els.thumbnail.classList.add('hidden');
    els.thumbnailPlaceholder.classList.remove('hidden');
  }
}

async function addToQueue() {
  const url = els.urlInput.value.trim();
  if (!url) {
    setStatus('Cole uma URL antes de adicionar.');
    return;
  }

  try {
    setStatus('Analisando URL...');
    const api = getDownloadsApi();
    
    let isPlaylist = false;
    if (window.bds && window.bds.inspectPlaylist) {
      try {
        const playlistInfo = await window.bds.inspectPlaylist(url);
        isPlaylist = playlistInfo && playlistInfo.isPlaylist;
      } catch (e) {}
    }

    if (isPlaylist && window.bds && window.bds.expandPlaylist) {
      setStatus('Expandindo playlist...');
      const items = await window.bds.expandPlaylist(url);
      if (Array.isArray(items) && items.length > 0) {
        setStatus(`Adicionando ${items.length} itens da playlist à fila...`);
        for (const item of items) {
          const isSpot = isSpotify(item.url || url);
          await api.add({
            url: item.url,
            format: isSpot ? 'MP3' : 'MP4',
            quality: els.resolutionSelect?.value || 'best',
            title: item.title,
            thumbnail: item.thumbnail,
            channel: item.channel || '',
            platform: item.platform || detectSource(item.url),
            duration: item.duration || null
          });
        }
        clearInputForm();
        setStatus(`${items.length} itens da playlist adicionados à fila com sucesso.`);
        fetchQueue();
        return;
      }
    }

    let titleToUse = state.metadata?.title || '';
    let thumbToUse = state.metadata?.thumbnail || '';
    let channelToUse = state.metadata?.channel || '';
    let durationToUse = state.metadata?.duration || null;
    let platformToUse = detectSource(url);
    const isSpot = isSpotify(url);

    if (!titleToUse) {
      try {
        const meta = await window.bds.getMetadata(url);
        if (meta) {
          titleToUse = meta.title;
          thumbToUse = meta.thumbnail;
          channelToUse = meta.channel;
          durationToUse = meta.duration;
        }
      } catch (e) {}
    }

    await api.add({
      url,
      format: isSpot ? 'MP3' : 'MP4',
      quality: els.resolutionSelect?.value || 'best',
      title: titleToUse,
      thumbnail: thumbToUse,
      channel: channelToUse,
      platform: platformToUse,
      duration: durationToUse
    });

    clearInputForm();
    setStatus('Item adicionado à fila com sucesso.');
    fetchQueue();
  } catch (error) {
    setStatus(error.message || 'Erro ao adicionar à fila.');
  }
}

async function startDownloadDirect(format) {
  const url = els.urlInput.value.trim();
  if (!url) {
    setStatus('Cole uma URL primeiro.');
    return;
  }

  try {
    setStatus('Analisando URL...');
    const api = getDownloadsApi();

    let isPlaylist = false;
    if (window.bds && window.bds.inspectPlaylist) {
      try {
        const playlistInfo = await window.bds.inspectPlaylist(url);
        isPlaylist = playlistInfo && playlistInfo.isPlaylist;
      } catch (e) {}
    }

    if (isPlaylist && window.bds && window.bds.expandPlaylist) {
      setStatus('Expandindo playlist...');
      const items = await window.bds.expandPlaylist(url);
      if (Array.isArray(items) && items.length > 0) {
        setStatus(`Adicionando ${items.length} itens da playlist à fila...`);
        for (const item of items) {
          const isSpot = isSpotify(item.url || url);
          const finalFormat = isSpot ? 'MP3' : format;
          await api.add({
            url: item.url,
            format: finalFormat,
            quality: els.resolutionSelect?.value || 'best',
            title: item.title,
            thumbnail: item.thumbnail,
            channel: item.channel || '',
            platform: item.platform || detectSource(item.url),
            duration: item.duration || null
          });
        }
        clearInputForm();
        setStatus(`${items.length} itens da playlist adicionados à fila.`);
        fetchQueue();
        return;
      }
    }

    let titleToUse = state.metadata?.title || '';
    let thumbToUse = state.metadata?.thumbnail || '';
    let channelToUse = state.metadata?.channel || '';
    let durationToUse = state.metadata?.duration || null;
    let platformToUse = detectSource(url);
    const isSpot = isSpotify(url);
    const finalFormat = isSpot ? 'MP3' : format;

    await api.add({
      url,
      format: finalFormat,
      quality: els.resolutionSelect?.value || 'best',
      title: titleToUse,
      thumbnail: thumbToUse,
      channel: channelToUse,
      platform: platformToUse,
      duration: durationToUse
    });

    clearInputForm();
    setStatus(`Item ${finalFormat} adicionado à fila.`);
    fetchQueue();
  } catch (error) {
    setStatus(error.message || 'Erro ao adicionar.');
  }
}

async function startQueue() {
  try {
    setStatus('Iniciando fila...');
    const api = getDownloadsApi();
    await api.start();
  } catch (err) {
    setStatus('Erro ao iniciar fila.');
  }
}

async function pauseQueue() {
  try {
    setStatus('Fila pausada.');
    const api = getDownloadsApi();
    await api.pause();
  } catch (err) {
    setStatus('Erro ao pausar fila.');
  }
}

async function clearCompleted() {
  try {
    const api = getDownloadsApi();
    await api.clearCompleted();
    fetchQueue();
  } catch (err) {}
}

async function cancelDownload(id) {
  const api = getDownloadsApi();
  await api.cancel(id);
  fetchQueue();
}

async function removeQueueItem(id) {
  const api = getDownloadsApi();
  await api.remove(id);
  fetchQueue();
}

async function retryQueueItem(id) {
  const api = getDownloadsApi();
  await api.retry(id);
  fetchQueue();
}

async function reorderQueue(id, direction) {
  const api = getDownloadsApi();
  await api.reorder(id, direction);
  fetchQueue();
}

async function toggleItemFormat(id, newFormat) {
  const api = getDownloadsApi();
  if (api.toggleFormat) {
    await api.toggleFormat(id, newFormat);
    fetchQueue();
  }
}

async function convertAllQueueTo(targetFormat) {
  const queuedItems = (state.downloadQueue || []).filter(item => item.status === 'queued');
  
  if (queuedItems.length === 0) {
    setStatus('Nenhum item aguardando na fila.');
    return;
  }

  setStatus(`Convertendo formato da fila para ${targetFormat}...`);
  for (const item of queuedItems) {
    if (isSpotify(item.url || '')) {
      if (item.format !== 'MP3') {
        await toggleItemFormat(item.id, 'MP3');
      }
      continue;
    }

    if (item.format !== targetFormat) {
      await toggleItemFormat(item.id, targetFormat);
    }
  }

  setStatus(`Formato da fila alterado para ${targetFormat} (links do Spotify mantidos em MP3).`);
  fetchQueue();
}

async function updateItemQuality(id, newQuality) {
  const api = getDownloadsApi();
  if (api.updateQuality) {
    await api.updateQuality(id, newQuality);
    fetchQueue();
  }
}

async function clearAllQueue() {
  try {
    const api = getDownloadsApi();
    if (api.clearAll) {
      await api.clearAll();
    } else {
      await api.clearCompleted();
    }
    fetchQueue();
    setStatus('Fila limpa por completo.');
  } catch (err) {
    console.error('[DOWNLOAD] Erro ao limpar fila:', err);
  }
}

function openPath(filePath) {
  if (window.bds && window.bds.openLocalPath) {
    window.bds.openLocalPath(filePath);
  }
}

function clearInputForm() {
  if (els.urlInput) els.urlInput.value = '';
  state.metadata = null;
  if (els.thumbnail) {
    els.thumbnail.removeAttribute('src');
    els.thumbnail.classList.add('hidden');
  }
  if (els.thumbnailPlaceholder) els.thumbnailPlaceholder.classList.remove('hidden');
  if (els.mediaTitle) els.mediaTitle.textContent = 'Aguardando URL';
  if (els.mediaChannel) els.mediaChannel.textContent = 'Cole um link para carregar título, canal e duração.';
  if (els.mediaDuration) els.mediaDuration.textContent = '--';
  if (els.mediaType) els.mediaType.textContent = '--';
}

function setBusy(busy) {
  if (!els.stateDot) return;
  els.stateDot.classList.toggle('busy', busy);
  if (els.stateText) els.stateText.textContent = busy ? 'Baixando' : 'Pronto';
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function formatDuration(seconds) {
  if (!seconds) return '--';
  const total = Number(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function detectSource(url) {
  if (isSpotify(url)) return 'Spotify';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '--';
  }
}

function isSpotify(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'spotify.com' || host.endsWith('.spotify.com');
  } catch {
    return false;
  }
}