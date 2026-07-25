let active = false;
let currentFilePath = null;
let currentInfo = null;

// State management for diffs
let originalTags = {};
let originalStreams = [];
let originalChapters = [];

let currentTags = {};
let currentStreams = [];
let currentChapters = [];

let thumbnailAction = 'none'; // 'none', 'remove', 'add', 'replace'
let newThumbnailPath = null;

export function initScreen() {
  active = true;
  bindEvents();
}

export function destroy() {
  active = false;
}

function bindEvents() {
  // Tabs
  document.querySelectorAll('.meta-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.meta-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.meta-panel').forEach(p => {
        p.classList.remove('active');
        p.classList.add('hidden');
      });
      
      e.target.classList.add('active');
      const targetPanel = document.getElementById(`tab-${e.target.dataset.tab}`);
      targetPanel.classList.remove('hidden');
      targetPanel.classList.add('active');
    });
  });

  // Buttons
  document.getElementById('btnSelectMetaFile')?.addEventListener('click', loadFile);
  document.getElementById('btnResetMeta')?.addEventListener('click', resetAll);
  
  // Tags inputs
  document.querySelectorAll('.tags-grid input').forEach(input => {
    input.addEventListener('input', (e) => {
      const tag = e.target.dataset.tag;
      currentTags[tag] = e.target.value;
    });
  });

  // Cover
  document.getElementById('btnReplaceCover')?.addEventListener('click', async () => {
    const result = await window.bds.selectFiles(); // ideal seria um filtro de imagem, mas podemos reusar
    const filePaths = Array.isArray(result) ? result : (result?.filePaths || []);
    if (filePaths.length > 0) {
      const p = filePaths[0];
      const ext = p.split('.').pop().toLowerCase();
      if (['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(ext)) {
        newThumbnailPath = p;
        thumbnailAction = document.getElementById('coverPreview').style.display === 'block' ? 'replace' : 'add';
        document.getElementById('coverPreview').src = `file:///${p.replace(/\\/g, '/')}`;
        document.getElementById('coverPreview').style.display = 'block';
        document.getElementById('coverPlaceholder').style.display = 'none';
        document.getElementById('coverStatusText').textContent = 'Nova capa selecionada para injeção.';
      } else {
        window.bdsModal.alert('Selecione uma imagem válida (JPG, PNG, WEBP).');
      }
    }
  });

  document.getElementById('btnRemoveCover')?.addEventListener('click', () => {
    thumbnailAction = 'remove';
    newThumbnailPath = null;
    document.getElementById('coverPreview').style.display = 'none';
    document.getElementById('coverPlaceholder').style.display = 'flex';
    document.getElementById('coverStatusText').textContent = 'A capa será removida no arquivo final.';
  });

  // Chapters
  document.getElementById('btnAddChapter')?.addEventListener('click', () => {
    const lastEnd = currentChapters.length > 0 ? currentChapters[currentChapters.length - 1].end : 0;
    currentChapters.push({ start: lastEnd, end: lastEnd + 10, title: 'Novo Capítulo' });
    renderChapters();
  });

  // JSON
  document.getElementById('btnCopyJson')?.addEventListener('click', () => {
    if (currentInfo) {
      navigator.clipboard.writeText(JSON.stringify(currentInfo, null, 2));
      window.bdsModal.alert('JSON copiado!');
    }
  });

  // Export
  document.querySelectorAll('input[name="exportMode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const group = document.getElementById('newFileOptions');
      if (e.target.value === 'new') group.classList.remove('hidden');
      else group.classList.add('hidden');
    });
  });

  document.getElementById('btnChangeMetaFolder')?.addEventListener('click', async () => {
    const currentPath = document.getElementById('outMetaFolder').value;
    const result = await window.bds.selectFolder(currentPath);
    // selectFolder in main.js returns a string (the path) or null if canceled
    if (result) {
      document.getElementById('outMetaFolder').value = result;
    }
  });

  document.getElementById('btnExportMeta')?.addEventListener('click', showValidationDiff);
  
  // Modal
  document.getElementById('btnCancelDiff')?.addEventListener('click', () => {
    document.getElementById('diffModal').close();
  });
  document.getElementById('btnConfirmDiff')?.addEventListener('click', executeSave);
  
  // IPC Events
  if (window.bds.onMetadataProgress) {
    window.bds.onMetadataProgress((data) => {
      if (!active) return;
      document.getElementById('metaStatusText').textContent = data.status || 'Processando...';
    });
    window.bds.onMetadataLog((text) => {
      if (!active) return;
      const out = document.getElementById('metaLogOutput');
      if (out) {
        out.textContent += text;
        out.scrollTop = out.scrollHeight;
      }
    });
  }
}

async function loadFile() {
  const result = await window.bds.selectFiles();
  let filePaths = [];
  if (Array.isArray(result)) {
    filePaths = result;
  } else if (result && result.filePaths) {
    if (result.canceled) return;
    filePaths = result.filePaths;
  }
  
  if (filePaths.length === 0) return;

  const filePath = filePaths[0];
  resetAll();
  
  const statusEl = document.getElementById('metaStatusText');
  if (statusEl) statusEl.textContent = 'Lendo metadados (FFprobe)...';
  
  const logArea = document.getElementById('metaLogArea');
  if (logArea) logArea.classList.remove('hidden');
  const logOutput = document.getElementById('metaLogOutput');
  if (logOutput) logOutput.textContent = '';
  
  try {
    currentFilePath = filePath;
    currentInfo = await window.bds.probeMetadataFile(filePath);
    
    // Parse to UI
    parseInfo(filePath);
    
    // Extract thumbnail if exists
    const thumbPath = await window.bds.extractMetadataThumb(filePath);
    if (thumbPath) {
      document.getElementById('coverPreview').src = `file:///${thumbPath.replace(/\\/g, '/')}?t=${Date.now()}`;
      document.getElementById('coverPreview').style.display = 'block';
      document.getElementById('coverPlaceholder').style.display = 'none';
      document.getElementById('coverStatusText').textContent = 'Capa embutida carregada.';
    }
    
    document.getElementById('btnSelectMetaFile')?.classList.add('hidden');
    document.getElementById('btnResetMeta')?.classList.remove('hidden');
    document.getElementById('metaExportArea')?.classList.remove('hidden');
    if (logArea) logArea.classList.add('hidden'); // hide after load
    
  } catch (err) {
    window.bdsModal.alert('Erro ao ler arquivo: ' + err.message);
    resetAll();
  }
}

function resetAll() {
  currentFilePath = null;
  currentInfo = null;
  originalTags = {}; currentTags = {};
  originalStreams = []; currentStreams = [];
  originalChapters = []; currentChapters = [];
  thumbnailAction = 'none';
  newThumbnailPath = null;
  
  document.getElementById('btnSelectMetaFile')?.classList.remove('hidden');
  document.getElementById('btnResetMeta')?.classList.add('hidden');
  document.getElementById('metaExportArea')?.classList.add('hidden');
  document.getElementById('metaLogArea')?.classList.add('hidden');
  
  const nameEl = document.getElementById('metaFileName');
  if (nameEl) nameEl.textContent = '-';
  const durationEl = document.getElementById('metaFileDurationInfo') || document.getElementById('metaFileDuration');
  if (durationEl) durationEl.textContent = '-';
  
  document.querySelectorAll('.meta-panel input[type="text"]').forEach(input => {
    if (input.id && input.id.startsWith('tag-')) {
      input.value = '';
    }
  });
  
  const coverPreview = document.getElementById('coverPreview');
  if (coverPreview) {
    coverPreview.style.display = 'none';
    coverPreview.src = '';
  }
  
  const coverPlaceholder = document.getElementById('coverPlaceholder');
  if (coverPlaceholder) coverPlaceholder.style.display = 'flex';
  
  const coverStatusText = document.getElementById('coverStatusText');
  if (coverStatusText) coverStatusText.textContent = '';
  
  // Clear other panels
  const grid = document.getElementById('readOnlyGrid');
  if (grid) grid.innerHTML = '';
  
  const streamsList = document.getElementById('streamsList');
  if (streamsList) streamsList.innerHTML = '';
  
  const chaptersList = document.getElementById('chaptersList');
  if (chaptersList) chaptersList.innerHTML = '';
  
  const rawJsonArea = document.getElementById('rawJsonArea');
  if (rawJsonArea) rawJsonArea.textContent = '';
  
  const metaStatusText = document.getElementById('metaStatusText');
  if (metaStatusText) metaStatusText.textContent = 'Aguardando...';
  
  const metaLogOutput = document.getElementById('metaLogOutput');
  if (metaLogOutput) {
    metaLogOutput.textContent = '';
    metaLogOutput.style.display = 'none';
  }
  
  // default to tags tab
  const tagsTab = document.querySelector('.meta-tab[data-tab="tags"]');
  if (tagsTab) tagsTab.click();
}

function parseInfo(filePath) {
  const f = currentInfo.format || {};
  
  // Header
  const nameEl = document.getElementById('metaFileName');
  if (nameEl) nameEl.textContent = filePath.split('\\').pop().split('/').pop();
  
  const durationEl = document.getElementById('metaFileDurationInfo') || document.getElementById('metaFileDuration');
  if (durationEl) durationEl.textContent = formatTime(f.duration || 0);
  
  // Raw JSON
  const rawJsonEl = document.getElementById('rawJsonArea');
  if (rawJsonEl) rawJsonEl.textContent = JSON.stringify(currentInfo, null, 2);
  
  // Info Grid
  const grid = document.getElementById('readOnlyGrid');
  if (grid) {
    grid.innerHTML = '';
    
    const addStat = (label, value) => {
      if (value === undefined || value === null || value === '') return;
      grid.innerHTML += `<div class="info-item"><label>${label}</label><span>${value}</span></div>`;
    };
    
    addStat('Formato (Container)', f.format_long_name || f.format_name);
    addStat('Tamanho', formatBytes(f.size));
    addStat('Bitrate Total', formatKbps(f.bit_rate));
    
    const video = currentInfo.streams?.find(s => s.codec_type === 'video' && (!s.disposition || s.disposition.attached_pic !== 1));
    const audio = currentInfo.streams?.find(s => s.codec_type === 'audio');
    
    if (video) {
      addStat('Codec de Vídeo', `${video.codec_name} (${video.profile || 'unknown'})`);
      addStat('Resolução', `${video.width}x${video.height}`);
      addStat('Aspect Ratio', video.display_aspect_ratio || 'N/A');
      addStat('FPS', evalFraction(video.r_frame_rate));
      addStat('Pixel Format', video.pix_fmt);
    }
    
    if (audio) {
      addStat('Codec de Áudio', audio.codec_name);
      addStat('Canais (Áudio)', audio.channels);
      addStat('Sample Rate', `${audio.sample_rate} Hz`);
    }
  }
  
  // Tags globais
  if (f.tags) {
    // Normalizar chaves para lower case para facilitar mapping
    const tags = {};
    for (const [k, v] of Object.entries(f.tags)) {
      tags[k.toLowerCase()] = v;
    }
    
    const mapping = {
      title: 'title', artist: 'artist', album: 'album', genre: 'genre', date: 'date',
      track: 'track', composer: 'composer', director: 'director', publisher: 'publisher',
      copyright: 'copyright', comment: 'comment', language: 'language', encoder: 'encoder',
      location: 'location'
    };
    
    for (const [uiTag, ffTag] of Object.entries(mapping)) {
      const val = tags[ffTag] || tags[ffTag.toUpperCase()] || '';
      document.getElementById(`tag-${uiTag}`).value = val;
      const origEl = document.getElementById(`tag-orig-${uiTag}`);
      if (origEl) origEl.value = val;
      originalTags[uiTag] = val;
      currentTags[uiTag] = val;
    }
  } else {
    // initialize empty
    document.querySelectorAll('.meta-panel input[data-tag]').forEach(input => {
      const uiTag = input.dataset.tag;
      input.value = '';
      const origEl = document.getElementById(`tag-orig-${uiTag}`);
      if (origEl) origEl.value = '';
      originalTags[uiTag] = '';
      currentTags[uiTag] = '';
    });
  }

  // Streams
  originalStreams = [];
  currentStreams = [];
  if (currentInfo.streams) {
    currentInfo.streams.forEach(s => {
      if (s.codec_type === 'data' || (s.disposition && s.disposition.attached_pic === 1)) return;
      
      const st = {
        index: s.index,
        type: s.codec_type,
        typeIndex: originalStreams.filter(x => x.type === s.codec_type).length,
        codec: s.codec_name,
        langOrig: (s.tags && s.tags.language) || 'und',
        lang: (s.tags && s.tags.language) || 'und',
        titleOrig: (s.tags && s.tags.title) || '',
        title: (s.tags && s.tags.title) || ''
      };
      originalStreams.push(JSON.parse(JSON.stringify(st)));
      currentStreams.push(st);
    });
    renderStreams();
  }

  // Chapters
  originalChapters = [];
  currentChapters = [];
  if (currentInfo.chapters) {
    currentInfo.chapters.forEach(c => {
      const ch = {
        start: parseFloat(c.start_time),
        end: parseFloat(c.end_time),
        title: (c.tags && c.tags.title) || `Capítulo ${c.id}`
      };
      originalChapters.push(JSON.parse(JSON.stringify(ch)));
      currentChapters.push(ch);
    });
    renderChapters();
  }
}

function renderStreams() {
  const container = document.getElementById('streamsList');
  container.innerHTML = '';
  
  currentStreams.forEach((s, idx) => {
    let icon = '🎞️';
    if (s.type === 'audio') icon = '🎵';
    else if (s.type === 'subtitle') icon = '💬';

    const div = document.createElement('div');
    div.className = 'stream-card';
    
    let titleHtml = `
      <div class="s-info">
        <strong>${icon} ${s.type.toUpperCase()} #${s.typeIndex}</strong> (Index: ${s.index})<br>
        <span class="muted small">Codec: ${s.codec}</span>
      </div>
    `;

    // A simple list of common langs
    const langs = ['und', 'eng', 'por', 'spa', 'fra', 'deu', 'jpn'];
    let langOptions = langs.map(l => `<option value="${l}" ${s.lang === l ? 'selected' : ''}>${l.toUpperCase()}</option>`).join('');
    // If original lang is not in the list, add it
    if (!langs.includes(s.langOrig)) {
      langOptions += `<option value="${s.langOrig}" ${s.lang === s.langOrig ? 'selected' : ''}>${s.langOrig.toUpperCase()}</option>`;
    }

    const editHtml = `
      <div class="s-edit">
        <div style="display:flex; flex-direction:column; gap:2px;">
          <label style="font-size:10px;" class="muted">Título da Trilha</label>
          <input type="text" value="${s.title}" oninput="window.updateStream(${idx}, 'title', this.value)" style="padding:4px; width: 120px; font-size:12px; background:var(--bg); border:1px solid var(--border); color:var(--text);">
        </div>
        <div style="display:flex; flex-direction:column; gap:2px;">
          <label style="font-size:10px;" class="muted">Idioma (ISO)</label>
          <select onchange="window.updateStream(${idx}, 'lang', this.value)" style="padding:4px; font-size:12px; background:var(--bg); border:1px solid var(--border); color:var(--text);">
            ${langOptions}
          </select>
        </div>
      </div>
    `;
    
    div.innerHTML = titleHtml + editHtml;
    container.appendChild(div);
  });
}

// Attach to window so inline handlers work
window.updateStream = (idx, key, val) => {
  currentStreams[idx][key] = val;
};

function renderChapters() {
  const tbody = document.getElementById('chaptersList');
  tbody.innerHTML = '';
  
  if (currentChapters.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted text-center">Nenhum capítulo embutido.</td></tr>';
    return;
  }
  
  currentChapters.forEach((ch, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="number" step="0.1" value="${ch.start}" onchange="window.updateChapter(${idx}, 'start', this.value)"></td>
      <td><input type="number" step="0.1" value="${ch.end}" onchange="window.updateChapter(${idx}, 'end', this.value)"></td>
      <td><input type="text" value="${ch.title}" onchange="window.updateChapter(${idx}, 'title', this.value)"></td>
      <td><button type="button" class="btn-clear" onclick="window.removeChapter(${idx})" style="padding: 4px 8px; font-size:11px;">Excluir</button></td>
    `;
    tbody.appendChild(tr);
  });
}

window.updateChapter = (idx, key, val) => {
  if (key === 'start' || key === 'end') {
    currentChapters[idx][key] = parseFloat(val) || 0;
  } else {
    currentChapters[idx][key] = val;
  }
};
window.removeChapter = (idx) => {
  currentChapters.splice(idx, 1);
  renderChapters();
};

function showValidationDiff() {
  const diffList = document.getElementById('diffList');
  diffList.innerHTML = '';
  
  let changesFound = false;
  
  // Tags
  for (const key of Object.keys(originalTags)) {
    if (originalTags[key] !== currentTags[key]) {
      changesFound = true;
      diffList.innerHTML += `<div style="margin-bottom:10px; border-bottom:1px solid #333; padding-bottom:5px;">
        <span style="color:#a855f7; font-weight:bold;">TAG [${key.toUpperCase()}]</span><br>
        <span style="color:#ff4c4c;">- ${originalTags[key] || 'vazio'}</span><br>
        <span style="color:#4ade80;">+ ${currentTags[key] || 'vazio'}</span>
      </div>`;
    }
  }

  // Streams
  for (let i = 0; i < currentStreams.length; i++) {
    const orig = originalStreams[i];
    const curr = currentStreams[i];
    if (orig.title !== curr.title) {
      changesFound = true;
      diffList.innerHTML += `<div style="margin-bottom:10px; border-bottom:1px solid #333; padding-bottom:5px;">
        <span style="color:#3b82f6; font-weight:bold;">STREAM [${curr.type} #${curr.typeIndex}] - TITLE</span><br>
        <span style="color:#ff4c4c;">- ${orig.titleOrig || 'vazio'}</span><br>
        <span style="color:#4ade80;">+ ${curr.title || 'vazio'}</span>
      </div>`;
    }
    if (orig.langOrig !== curr.lang) {
      changesFound = true;
      diffList.innerHTML += `<div style="margin-bottom:10px; border-bottom:1px solid #333; padding-bottom:5px;">
        <span style="color:#3b82f6; font-weight:bold;">STREAM [${curr.type} #${curr.typeIndex}] - LANGUAGE</span><br>
        <span style="color:#ff4c4c;">- ${orig.langOrig}</span><br>
        <span style="color:#4ade80;">+ ${curr.lang}</span>
      </div>`;
    }
  }

  // Cover
  if (thumbnailAction !== 'none') {
    changesFound = true;
    let desc = '';
    if (thumbnailAction === 'remove') desc = '<span style="color:#ff4c4c;">Remover arte de capa</span>';
    if (thumbnailAction === 'add') desc = '<span style="color:#4ade80;">Adicionar arte de capa</span>';
    if (thumbnailAction === 'replace') desc = '<span style="color:#f59e0b;">Substituir arte de capa</span>';
    
    diffList.innerHTML += `<div style="margin-bottom:10px; border-bottom:1px solid #333; padding-bottom:5px;">
      <span style="color:#eab308; font-weight:bold;">MINIATURA</span><br>
      ${desc}
    </div>`;
  }

  // Chapters (simple length check or deep compare)
  let chapChanged = false;
  if (originalChapters.length !== currentChapters.length) chapChanged = true;
  else {
    for (let i = 0; i < currentChapters.length; i++) {
      if (originalChapters[i].start !== currentChapters[i].start ||
          originalChapters[i].end !== currentChapters[i].end ||
          originalChapters[i].title !== currentChapters[i].title) {
        chapChanged = true; break;
      }
    }
  }
  
  if (chapChanged) {
    changesFound = true;
    diffList.innerHTML += `<div style="margin-bottom:10px; border-bottom:1px solid #333; padding-bottom:5px;">
      <span style="color:#f97316; font-weight:bold;">CAPÍTULOS</span><br>
      Foram detectadas modificações estruturais nos capítulos.
    </div>`;
  }
  
  if (!changesFound) {
    diffList.innerHTML = '<span class="muted">Nenhuma alteração detectada.</span>';
    document.getElementById('btnConfirmDiff').style.display = 'none';
  } else {
    document.getElementById('btnConfirmDiff').style.display = 'block';
  }
  
  document.getElementById('diffModal').showModal();
}

async function executeSave() {
  document.getElementById('diffModal').close();
  
  const mode = document.querySelector('input[name="exportMode"]:checked').value;
  let outputPath = '';
  if (mode === 'new') {
    const folder = document.getElementById('outMetaFolder').value;
    const name = document.getElementById('outMetaName').value || 'copia_metadados' + currentFilePath.substring(currentFilePath.lastIndexOf('.'));
    if (!folder) return window.bdsModal.alert('Selecione uma pasta para salvar a cópia.');
    outputPath = folder + '\\' + name;
  }
  
  document.getElementById('metaLogArea').classList.remove('hidden');
  document.getElementById('metaLogOutput').textContent = '';
  document.getElementById('metaStatusText').textContent = 'Iniciando cópia de streams e injeção de metadados...';
  
  // Prepare streams payload for FFmpeg mapping
  const streamsPayload = currentStreams.map(s => ({
    type: s.type === 'audio' ? 'a' : (s.type === 'video' ? 'v' : 's'),
    typeIndex: s.typeIndex,
    language: s.lang,
    title: s.title
  }));
  
  const config = {
    filePath: currentFilePath,
    outMode: mode,
    outputPath: outputPath,
    tags: currentTags,
    streams: streamsPayload,
    chapters: currentChapters,
    thumbnailAction,
    newThumbnailPath
  };
  
  try {
    const result = await window.bds.saveMetadata(config);
    if (result.status === 'success') {
      document.getElementById('metaStatusText').textContent = 'Concluído com sucesso! (Direct Stream Copy)';
      // reload
      setTimeout(() => { loadFile(); }, 1000);
    } else {
      document.getElementById('metaStatusText').textContent = 'Cancelado.';
    }
  } catch (err) {
    document.getElementById('metaStatusText').textContent = 'Falha: ' + err.message;
  }
}

// Helpers
function formatTime(seconds) {
  if (isNaN(seconds)) return '00:00:00';
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) * 1 + ' ' + ['B', 'kB', 'MB', 'GB', 'TB'][i];
}

function formatKbps(bps) {
  if (!bps || isNaN(bps)) return '0 kbps';
  return (bps / 1000).toFixed(0) + ' kbps';
}

function evalFraction(str) {
  if (!str) return '0';
  const parts = str.split('/');
  if (parts.length === 2) {
    return (parseFloat(parts[0]) / parseFloat(parts[1])).toFixed(2);
  }
  return str;
}
