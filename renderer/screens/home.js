let recentJobs = [];
let thumbsDir = '';

export async function initScreen() {
  try {
    console.log('[HOME] Inicializando tela...');

    if (window.bds && window.bds.getThumbDir) {
      try {
        thumbsDir = await window.bds.getThumbDir();
        thumbsDir = 'file:///' + thumbsDir.replace(/\\/g, '/');
      } catch (e) {
        console.warn('[HOME] Não foi possível obter thumbsDir:', e);
      }
    }

    // Ações Rápidas
    document.querySelectorAll('.qa-card').forEach(card => {
      card.addEventListener('click', () => {
        const targetView = card.getAttribute('data-target');
        if (targetView) {
          const tabButton = document.querySelector(`.sidebar .tab-button[data-view="${targetView}"]`);
          if (tabButton) tabButton.click();
        }
      });
    });

    // Abas de Últimos Trabalhos
    const jobTabs = document.querySelectorAll('.job-tab');
    jobTabs.forEach(tab => {
      tab.addEventListener('click', async (e) => {
        jobTabs.forEach(t => t.classList.remove('active'));
        const current = e.target.closest('.job-tab') || e.target;
        current.classList.add('active');
        const tabName = current.textContent.trim();
        await loadJobsForTab(tabName);
      });
    });

    // Carga inicial
    await loadStats();
    await loadRecentJobs();

    // Listener de novas mídias (apenas uma vez)
    if (window.bds && window.bds.onMediaImported && !window.homeListenerRegistered) {
      window.homeListenerRegistered = true;
      window.bds.onMediaImported(async (media) => {
        console.log('[HOME] Novo arquivo importado:', media.filename);
        await loadStats();
        await loadRecentJobs();
      });
    }
  } catch (err) {
    console.error('[HOME] ERRO NO INIT:', err);
    const mediaEl = document.getElementById('statTotalMedia');
    if (mediaEl) {
      mediaEl.classList.add('stat-error');
      mediaEl.textContent = "ERRO: " + err.message;
    }
  }
}

async function loadStats() {
  if (!window.bds || !window.bds.getLibraryStats) return;
  const stats = await window.bds.getLibraryStats();

  const totalMediaCount = stats.totalMedia
    || ((stats.videosCount || 0) + (stats.audiosCount || 0) + (stats.photosCount || 0))
    || 0;
  
  const elMedia = document.getElementById('statTotalMedia');
  if (elMedia) {
    elMedia.classList.remove('stat-error');
    elMedia.textContent = totalMediaCount.toLocaleString('pt-BR');
  }

  const elVideos = document.getElementById('statCountVideos');
  if (elVideos) elVideos.textContent = (stats.videosCount || 0).toLocaleString('pt-BR');

  const elAudios = document.getElementById('statCountAudios');
  if (elAudios) elAudios.textContent = (stats.audiosCount || 0).toLocaleString('pt-BR');

  const elPhotos = document.getElementById('statCountPhotos');
  if (elPhotos) elPhotos.textContent = (stats.photosCount || 0).toLocaleString('pt-BR');

  const elSize = document.getElementById('statTotalSize');
  if (elSize) elSize.textContent = formatBytes(stats.totalSizeBytes);
  
  const elSync = document.getElementById('statLastSync');
  if (elSync) {
    if (stats.lastSyncDate) {
      const syncStr = new Date(stats.lastSyncDate + 'Z').toLocaleString('pt-BR');
      elSync.textContent = syncStr;
    } else {
      elSync.textContent = 'Nunca';
    }
  }
}

async function loadRecentJobs() {
  if (!window.bds || !window.bds.getRecentMedia) return;
  
  recentJobs = await window.bds.getRecentMedia(10);
  
  renderRecordingsCarousel();
  
  const activeTab = document.querySelector('.job-tab.active');
  if (activeTab) {
    await loadJobsForTab(activeTab.textContent.trim());
  } else {
    renderJobsTable();
  }
}

async function loadJobsForTab(tabName) {
  if (!window.bds) return;
  
  try {
    if (tabName === 'Downloads') {
      if (window.bds.listHistory) {
        const history = await window.bds.listHistory();
        if (history && history.length > 0) {
          recentJobs = history.map(d => ({
            filename: d.titulo || (d.url ? d.url.split('/').pop() : 'Download'),
            typeLabel: d.tipo || 'MP4',
            origin: 'DOWNLOAD',
            duration: 0,
            resolution: d.resolucao || '-',
            imported_at: d.data_download,
            filesize: 0
          }));
        } else {
          recentJobs = await window.bds.searchLibrary({ origins: ['DOWNLOAD'], limit: 10 });
        }
      } else {
        recentJobs = await window.bds.searchLibrary({ origins: ['DOWNLOAD'], limit: 10 });
      }
    } else if (tabName === 'Convertidos') {
      if (window.bds.listConversions) {
        const conversions = await window.bds.listConversions();
        if (conversions && conversions.length > 0) {
          recentJobs = conversions.map(c => ({
            filename: c.arquivo_saida
              ? c.arquivo_saida.split(/[\\/]/).pop()
              : (c.arquivo_origem ? c.arquivo_origem.split(/[\\/]/).pop() : 'Conversão'),
            typeLabel: c.formato || 'MP4',
            origin: 'CONVERTER',
            duration: 0,
            resolution: c.encoder || '-',
            imported_at: c.data_conversao,
            filesize: 0
          }));
        } else {
          recentJobs = await window.bds.searchLibrary({ origins: ['CONVERTER'], limit: 10 });
        }
      } else {
        recentJobs = await window.bds.searchLibrary({ origins: ['CONVERTER'], limit: 10 });
      }
    } else if (tabName === 'Favoritos') {
      recentJobs = await window.bds.searchLibrary({ favorites: true, limit: 10 });
    } else if (tabName === 'Importados') {
      recentJobs = await window.bds.searchLibrary({ limit: 10 });
    } else {
      recentJobs = await window.bds.getRecentMedia(10);
    }
  } catch(e) {
    console.error('[HOME] Erro ao carregar aba:', e);
    recentJobs = [];
  }

  renderJobsTable();
}

function renderRecordingsCarousel() {
  const container = document.getElementById('recentRecordings');
  if (!container) return;

  const videos = (recentJobs || []).filter(m => m.video_codec !== null && m.filename).slice(0, 5);
  
  if (videos.length === 0) {
    container.innerHTML = '<div class="empty-message">Nenhuma gravação recente encontrada.</div>';
    return;
  }

  const html = videos.map(item => {
    const thumbStyle = item.thumbnail
      ? `background-image: url('${thumbsDir}/${item.thumbnail}');`
      : '';
    const safeTitle = escapeAttr(item.filename);
    
    return `
      <div class="recent-carousel-card" data-id="${item.id}">
        <div class="recent-carousel-thumb" style="${thumbStyle}">
          <div class="recent-carousel-duration">${formatDuration(item.duration)}</div>
        </div>
        <div class="recent-carousel-info">
          <div class="recent-carousel-title" title="${safeTitle}">${escapeHtml(item.filename)}</div>
          <div class="recent-carousel-meta">
            ${new Date(item.imported_at + 'Z').toLocaleDateString('pt-BR')}
            ${item.height ? ` &bull; ${item.height}p` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;

  container.querySelectorAll('.recent-carousel-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      const item = videos.find(v => String(v.id) === String(id));
      if (item && item.filepath && window.bdsPlayer) {
        window.bdsPlayer.play(item.filepath, item.filename);
      }
    });
  });
}

function renderJobsTable() {
  const tbody = document.getElementById('recentJobsTable');
  if (!tbody) return;

  if (!recentJobs || recentJobs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="jobs-empty-state">Nenhum trabalho recente nesta categoria.</td></tr>';
    return;
  }

  const html = recentJobs.map(job => {
    const filename = job.filename || job.titulo || job.arquivo_saida || 'Arquivo sem nome';
    const isVideo = Boolean(
      job.video_codec
      || (job.width && job.width > 0)
      || (job.height && job.height > 0)
      || (filename && /\.(mp4|mkv|mov|webm|avi)$/i.test(filename))
    );
    const isAudio = !isVideo && Boolean(
      job.audio_codec
      || (job.typeLabel && (
        job.typeLabel.includes('MP3')
        || job.typeLabel.includes('M4A')
        || job.typeLabel.includes('WAV')
      ))
    );
    const originText = job.origin || 'LOCAL';
    const originIcon = originText.includes('BDSM')
      ? 'smartphone'
      : (originText === 'DOWNLOAD' ? 'download' : (originText === 'CONVERTER' ? 'sync' : 'computer'));
    const typeLabel = isVideo ? 'Vídeo' : (isAudio ? 'Áudio' : (job.typeLabel || 'Vídeo'));
    const icon = isVideo ? 'movie' : (isAudio ? 'audio_file' : 'movie');
    const resString = job.resolution
      || (job.width ? `${job.width}x${job.height} ${job.fps || 30}fps` : '-');
    
    let dateStr = '-';
    if (job.imported_at) {
      try {
        const rawDate = job.imported_at.includes('T')
          ? job.imported_at
          : job.imported_at.replace(' ', 'T');
        dateStr = new Date(rawDate).toLocaleString('pt-BR');
      } catch (e) {
        dateStr = String(job.imported_at);
      }
    }

    const sizeStr = job.filesize ? formatBytes(job.filesize) : '-';
    const truncated = filename.length > 35 ? filename.substring(0, 35) + '...' : filename;

    return `
      <tr class="recent-job-row" data-id="${job.id || ''}">
        <td>
          <div class="job-name-cell">
            <span class="material-symbols-rounded">${icon}</span>
            <span class="filename" title="${escapeAttr(filename)}">${escapeHtml(truncated)}</span>
          </div>
        </td>
        <td class="muted-cell">${escapeHtml(typeLabel)}</td>
        <td>
          <div class="job-origin-cell">
            <span class="material-symbols-rounded">${originIcon}</span>
            <span>${escapeHtml(originText)}</span>
          </div>
        </td>
        <td class="muted-cell">${job.duration ? formatDuration(job.duration) : '-'}</td>
        <td class="muted-cell">${escapeHtml(resString)}</td>
        <td class="muted-cell">${escapeHtml(dateStr)}</td>
        <td class="muted-cell">${escapeHtml(sizeStr)}</td>
        <td class="job-actions-cell">
          <span class="material-symbols-rounded" title="Abrir pasta">folder</span>
          <span class="material-symbols-rounded" title="Mais opções">more_vert</span>
        </td>
      </tr>
    `;
  }).join('');

  tbody.innerHTML = html;

  tbody.querySelectorAll('.recent-job-row').forEach(row => {
    row.addEventListener('click', (e) => {
      // Ignora clique nos ícones de ação
      if (e.target.closest('.job-actions-cell .material-symbols-rounded')) {
        return;
      }
      const id = row.getAttribute('data-id');
      const job = recentJobs.find(j => String(j.id) === String(id));
      if (job && job.filepath && window.bdsPlayer) {
        window.bdsPlayer.play(job.filepath, job.filename);
      }
    });
  });
}

// Helpers
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