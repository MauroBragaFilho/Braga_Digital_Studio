let recentJobs = [];
let thumbsDir = '';

export async function initScreen() {
  try {
    console.log('Home screen initialized');

    if (window.bds && window.bds.getThumbDir) {
      thumbsDir = await window.bds.getThumbDir();
      thumbsDir = 'file:///' + thumbsDir.replace(/\\/g, '/');
    }

    // Configuração das Ações Rápidas
    const actionCards = document.querySelectorAll('.qa-card');
    actionCards.forEach(card => {
      card.addEventListener('click', () => {
        const targetView = card.getAttribute('data-target');
        if (targetView) {
          const tabButton = document.querySelector(`.sidebar .tab-button[data-view="${targetView}"]`);
          if (tabButton) tabButton.click();
        }
      });
    });

    // Configuração das Abas de Últimos Trabalhos
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

    // Atualiza stats e recentes inicial
    await loadStats();
    await loadRecentJobs();

    // Escuta eventos reais do backend
    if (window.bds && window.bds.onMediaImported && !window.homeListenerRegistered) {
      window.homeListenerRegistered = true;
      window.bds.onMediaImported(async (media) => {
        console.log('Novo arquivo importado:', media.filename);
        await loadStats();
        await loadRecentJobs();
      });
    }
  } catch (err) {
    console.error("ERRO NO INIT DA HOME:", err);
    const mediaEl = document.getElementById('statTotalMedia');
    if (mediaEl) {
      mediaEl.style.fontSize = '12px';
      mediaEl.style.color = 'red';
      mediaEl.textContent = "ERRO: " + err.stack;
    }
  }
}

async function loadStats() {
  if (!window.bds || !window.bds.getLibraryStats) return;
  const stats = await window.bds.getLibraryStats();

  const totalMediaCount = stats.totalMedia || ((stats.videosCount || 0) + (stats.audiosCount || 0) + (stats.photosCount || 0)) || 0;
  
  const elMedia = document.getElementById('statTotalMedia');
  if (elMedia) elMedia.textContent = totalMediaCount.toLocaleString('pt-BR');

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
  
  // O load inicial da tabela pega a aba ativa
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
            filename: c.arquivo_saida ? c.arquivo_saida.split(/[\\/]/).pop() : (c.arquivo_origem ? c.arquivo_origem.split(/[\\/]/).pop() : 'Conversão'),
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
      // Recentes
      recentJobs = await window.bds.getRecentMedia(10);
    }
  } catch(e) {
    console.error('Erro ao carregar abas de últimos trabalhos:', e);
    recentJobs = [];
  }

  renderJobsTable();
}

function renderRecordingsCarousel() {
  const container = document.getElementById('recentRecordings');
  if (!container) return;

  const videos = (recentJobs || []).filter(m => m.video_codec !== null && m.filename).slice(0, 5);
  
  if (videos.length === 0) {
    container.innerHTML = '<div style="color: var(--muted); padding: 24px; font-size: 13px;">Nenhuma gravação recente encontrada.</div>';
    return;
  }

  container.innerHTML = videos.map(item => `
    <div class="recent-carousel-card" data-id="${item.id}" style="width: 256px; flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; cursor: pointer; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
      <div style="width: 100%; height: 144px; background-image: url('${item.thumbnail ? thumbsDir + '/' + item.thumbnail : ''}'); background-color: #111; background-size: cover; background-position: center; border-radius: 8px; position: relative; border: 1px solid var(--line);">
        <div style="position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.7); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; color: #fff;">${formatDuration(item.duration)}</div>
      </div>
      <div>
        <div style="font-size: 13px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${item.filename}">${item.filename}</div>
        <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">${new Date(item.imported_at + 'Z').toLocaleDateString('pt-BR')} &bull; ${item.height ? item.height + 'p' : ''}</div>
      </div>
    </div>
  `).join('');

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
    tbody.innerHTML = '<tr><td colspan="8" style="padding: 24px; text-align: center; color: var(--muted);">Nenhum trabalho recente nesta categoria.</td></tr>';
    return;
  }

  tbody.innerHTML = recentJobs.map(job => {
    const filename = job.filename || job.titulo || job.arquivo_saida || 'Arquivo sem nome';
    const isVideo = Boolean(job.video_codec || (job.width && job.width > 0) || (job.height && job.height > 0) || (filename && /\.(mp4|mkv|mov|webm|avi)$/i.test(filename)));
    const isAudio = !isVideo && Boolean(job.audio_codec || (job.typeLabel && (job.typeLabel.includes('MP3') || job.typeLabel.includes('M4A') || job.typeLabel.includes('WAV'))));
    const originText = job.origin || 'LOCAL';
    const originIcon = originText.includes('BDSM') ? 'smartphone' : (originText === 'DOWNLOAD' ? 'download' : (originText === 'CONVERTER' ? 'sync' : 'computer'));
    const typeLabel = isVideo ? 'Vídeo' : (isAudio ? 'Áudio' : (job.typeLabel || 'Vídeo'));
    const icon = isVideo ? 'movie' : (isAudio ? 'audio_file' : 'movie');
    const resString = job.resolution || (job.width ? `${job.width}x${job.height} ${job.fps || 30}fps` : '-');
    
    let dateStr = '-';
    if (job.imported_at) {
      try {
        const rawDate = job.imported_at.includes('T') ? job.imported_at : job.imported_at.replace(' ', 'T');
        dateStr = new Date(rawDate).toLocaleString('pt-BR');
      } catch (e) {
        dateStr = String(job.imported_at);
      }
    }

    const sizeStr = job.filesize ? formatBytes(job.filesize) : '-';

    return `
    <tr class="recent-job-row" data-id="${job.id || ''}" style="border-bottom: 1px solid var(--line); transition: background 0.2s; cursor: pointer;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
      <td style="padding: 12px 16px;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span class="material-symbols-rounded" style="color: var(--muted); font-size: 18px;">${icon}</span>
          <span title="${filename}">${filename.length > 35 ? filename.substring(0, 35) + '...' : filename}</span>
        </div>
      </td>
      <td style="padding: 12px 16px; color: var(--muted);">${typeLabel}</td>
      <td style="padding: 12px 16px; color: var(--muted);">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-rounded" style="font-size: 14px;">${originIcon}</span>
          ${originText}
        </div>
      </td>
      <td style="padding: 12px 16px; color: var(--muted);">${job.duration ? formatDuration(job.duration) : '-'}</td>
      <td style="padding: 12px 16px; color: var(--muted);">${resString}</td>
      <td style="padding: 12px 16px; color: var(--muted);">${dateStr}</td>
      <td style="padding: 12px 16px; color: var(--muted);">${sizeStr}</td>
      <td style="padding: 12px 16px; text-align: right; color: var(--muted);">
        <span class="material-symbols-rounded" style="font-size: 16px; cursor: pointer; margin-right: 8px;">folder</span>
        <span class="material-symbols-rounded" style="font-size: 16px; cursor: pointer;">more_vert</span>
      </td>
    </tr>
    `;
  }).join('');

  // Bind click events to open player
  tbody.querySelectorAll('.recent-job-row').forEach(row => {
    row.addEventListener('click', (e) => {
      // Ignore click if it's on the action icons
      if (e.target.closest('span.material-symbols-rounded') && e.target.textContent !== 'movie' && e.target.textContent !== 'audio_file') {
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
