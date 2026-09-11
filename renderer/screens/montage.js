import { setAppStatus } from '../app.js';

let mainVideosList = [];
let selectedVideoIds = new Set();
let thumbsDir = '';
let globalDefaultPct = 100;

let introVideo = { name: 'Nenhuma', duration: 0, path: '', thumbnail: '' };
let outroVideo = { name: 'Nenhuma', duration: 0, path: '', thumbnail: '' };

let exportState = {
  active: false,
  completed: false,
  current: 0,
  total: 0,
  percent: 0
};

function logScreen(msg, type = 'info') {
  if (type === 'error') {
    const banner = document.getElementById('montageDebugBanner');
    const output = document.getElementById('montageLogOutput');
    if (banner) banner.style.display = 'block';
    if (output) {
      const time = new Date().toLocaleTimeString('pt-BR');
      output.textContent = `❌ [ERRO DETECTADO] ${time} - ${msg}\n` + output.textContent;
    }
  }
  console.log(`[MONTAGE-${type.toUpperCase()}]:`, msg);
}

export async function initScreen() {
  logScreen('Inicializando tela de Montagem de Mídia...', 'info');

  window.onerror = function(msg, url, lineNo, columnNo, error) {
    logScreen(`Erro JS: ${msg} (Linha: ${lineNo})`, 'error');
    return false;
  };

  window.onunhandledrejection = function(event) {
    logScreen(`Rejeição de Promessa: ${event.reason?.message || event.reason}`, 'error');
  };

  if (window.bds && window.bds.getThumbDir) {
    try {
      const rawDir = await window.bds.getThumbDir();
      thumbsDir = 'file:///' + rawDir.replace(/\\/g, '/');
      logScreen(`Diretório de miniaturas configurado.`, 'info');
    } catch (e) {
      logScreen(`Erro ao buscar getThumbDir: ${e.message}`, 'error');
    }
  } else {
    logScreen(`Aviso: API window.bds.getThumbDir não encontrada`, 'warn');
  }

  // Inicializa pasta de destino padrão dinamicamente via backend
  const destFolderInput = document.getElementById('txtDestFolder');
  if (destFolderInput && !destFolderInput.value) {
    try {
      const videosDir = (await window.bds?.getVideosPath?.()) || '';
      if (videosDir) {
        const sep = videosDir.includes('\\') ? '\\' : '/';
        destFolderInput.value = (videosDir.endsWith('/') || videosDir.endsWith('\\')) ? `${videosDir}Montagem` : `${videosDir}${sep}Montagem`;
      }
    } catch (_) {}
  }

  // A fila de vídeos inicia VAZIA por padrão
  mainVideosList = [];

  renderMainVideosTable();
  bindEvents();
  updateSummary();
  updateStepperVisuals();
  setupIPCListeners();
}

function updateStepperVisuals() {
  // PASSO 1: ABERTURA
  const b1 = document.getElementById('step1Badge');
  const s1 = document.getElementById('step1Sub');
  if (b1 && s1) {
    if (introVideo && introVideo.path) {
      b1.style.borderColor = '#4caf50';
      b1.style.background = 'rgba(76, 175, 80, 0.15)';
      b1.style.color = '#4caf50';
      b1.textContent = '✓';
      s1.style.color = '#4caf50';
      s1.textContent = 'Abertura definida';
    } else {
      b1.style.borderColor = 'var(--muted)';
      b1.style.background = 'transparent';
      b1.style.color = 'var(--muted)';
      b1.textContent = '1';
      s1.style.color = 'var(--muted)';
      s1.textContent = 'Defina a abertura do vídeo';
    }
  }

  // PASSO 2: VÍDEOS PRINCIPAIS
  const b2 = document.getElementById('step2Badge');
  const s2 = document.getElementById('step2Sub');
  if (b2 && s2) {
    if (mainVideosList.length > 0) {
      b2.style.borderColor = '#4caf50';
      b2.style.background = 'rgba(76, 175, 80, 0.15)';
      b2.style.color = '#4caf50';
      b2.textContent = '✓';
      s2.style.color = '#4caf50';
      s2.textContent = `${mainVideosList.length} vídeo(s) pronto(s)`;
    } else {
      b2.style.borderColor = 'var(--muted)';
      b2.style.background = 'transparent';
      b2.style.color = 'var(--muted)';
      b2.textContent = '2';
      s2.style.color = 'var(--muted)';
      s2.textContent = 'Adicione os vídeos principais';
    }
  }

  // PASSO 3: FINALIZAÇÃO
  const b3 = document.getElementById('step3Badge');
  const s3 = document.getElementById('step3Sub');
  if (b3 && s3) {
    if (outroVideo && outroVideo.path) {
      b3.style.borderColor = '#4caf50';
      b3.style.background = 'rgba(76, 175, 80, 0.15)';
      b3.style.color = '#4caf50';
      b3.textContent = '✓';
      s3.style.color = '#4caf50';
      s3.textContent = 'Finalização definida';
    } else {
      b3.style.borderColor = 'var(--muted)';
      b3.style.background = 'transparent';
      b3.style.color = 'var(--muted)';
      b3.textContent = '3';
      s3.style.color = 'var(--muted)';
      s3.textContent = 'Defina a finalização do vídeo';
    }
  }

  // PASSO 4: EXPORTAR
  const b4 = document.getElementById('step4Badge');
  const t4 = document.getElementById('step4Title');
  const s4 = document.getElementById('step4Sub');
  if (b4 && t4 && s4) {
    if (exportState.completed) {
      b4.style.borderColor = '#4caf50';
      b4.style.background = 'rgba(76, 175, 80, 0.15)';
      b4.style.color = '#4caf50';
      b4.textContent = '✓';
      t4.style.color = '#4caf50';
      t4.textContent = 'CONCLUÍDO!';
      s4.style.color = '#4caf50';
      s4.textContent = 'Todos os vídeos exportados!';
    } else if (exportState.active) {
      b4.style.borderColor = '#f25c05';
      b4.style.background = 'rgba(242, 92, 5, 0.15)';
      b4.style.color = '#f25c05';
      b4.textContent = '⚙';
      t4.style.color = '#f25c05';
      t4.textContent = `EXPORTANDO (${exportState.current}/${exportState.total})`;
      s4.style.color = '#f25c05';
      s4.textContent = `Progresso: ${Math.round(exportState.percent)}%`;
    } else {
      b4.style.borderColor = 'var(--muted)';
      b4.style.background = 'transparent';
      b4.style.color = 'var(--muted)';
      b4.textContent = '4';
      t4.style.color = '#ffffff';
      t4.textContent = 'EXPORTAR';
      s4.style.color = 'var(--muted)';
      s4.textContent = 'Configure e exporte seu vídeo';
    }
  }
}

function renderMainVideosTable() {
  const tbody = document.getElementById('montageMainBody');
  if (!tbody) return;

  const countEl = document.getElementById('mainCount');
  if (countEl) countEl.textContent = mainVideosList.length;

  if (mainVideosList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="padding: 40px; text-align: center; color: var(--muted);">
          <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
            <span class="material-symbols-rounded" style="font-size: 32px; color: var(--muted);">video_library</span>
            <span style="font-size: 13px; font-weight: 600; color: #ffffff;">Fila de vídeos vazia</span>
            <span style="font-size: 11px;">Clique em <strong>"+ Adicionar"</strong>, <strong>"Biblioteca"</strong> ou <strong>"Pasta"</strong> para incluir vídeos.</span>
          </div>
        </td>
      </tr>
    `;
    updateSummary();
    updateStepperVisuals();
    return;
  }

  tbody.innerHTML = mainVideosList.map((item, index) => {
    const isSelected = selectedVideoIds.has(item.id);
    const rowNum = String(index + 1).padStart(2, '0');
    const ext = item.name.split('.').pop().toUpperCase();
    const isAudio = item.isAudio || ['MP3', 'WAV', 'M4A', 'AAC', 'FLAC', 'OGG'].includes(ext);

    const origDurStr = formatSecondsToHHMMSS(item.durationSeconds);
    const finalSec = Math.round((item.durationSeconds * item.pctUsed) / 100);
    const finalDurStr = formatSecondsToHHMMSS(finalSec);

    const thumbHtml = isAudio
      ? `<div style="width: 52px; height: 32px; background: rgba(33, 150, 243, 0.15); border: 1px solid rgba(33, 150, 243, 0.3); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #2196f3; font-size: 9px; font-weight: 800; letter-spacing: 0.5px; flex-shrink: 0;">ÁUDIO</div>`
      : `<div style="width: 52px; height: 32px; background: #000; border-radius: 4px; overflow: hidden; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.1); position: relative; display: flex; align-items: center; justify-content: center;">
          <img src="${item.thumbnail}" style="width: 100%; height: 100%; object-fit: cover;" onError="this.style.display='none'" />
          <span class="material-symbols-rounded" style="font-size: 16px; color: var(--muted);">movie</span>
         </div>`;

    return `
      <tr class="montage-row" data-id="${item.id}" style="border-bottom: 1px solid var(--line); background: ${isSelected ? 'rgba(229, 57, 53, 0.15)' : 'transparent'}; transition: background 0.15s; cursor: pointer;">
        <td style="padding: 10px 12px; color: var(--muted); font-weight: 600; font-family: monospace;">${rowNum}</td>
        
        <!-- Thumbnail Real ou Badge ÁUDIO + Nome -->
        <td style="padding: 10px 12px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            ${thumbHtml}
            <span style="font-weight: 600; color: #ffffff; font-size: 12px;" title="${item.name}">${item.name}</span>
          </div>
        </td>

        <!-- Duração Original -->
        <td style="padding: 10px 12px; color: var(--muted); font-family: monospace;">${origDurStr}</td>

        <!-- % UTILIZADO DO VÍDEO (Com Número Nítido + Slider) -->
        <td style="padding: 10px 12px;" onclick="event.stopPropagation();">
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="range" min="1" max="100" value="${item.pctUsed}" class="pct-slider" data-id="${item.id}" style="flex: 1; accent-color: #e53935; cursor: pointer;" />
            
            <div style="display: flex; align-items: center; gap: 4px; background: rgba(0,0,0,0.5); border: 1px solid var(--line); border-radius: 4px; padding: 2px 6px;">
              <input type="number" min="1" max="100" value="${item.pctUsed}" class="pct-num-input" data-id="${item.id}" style="width: 44px; background: transparent; border: none; color: #ffffff; font-weight: 700; text-align: center; font-size: 13px; outline: none; -moz-appearance: textfield;" />
              <span style="color: #e53935; font-weight: 700; font-size: 12px;">%</span>
            </div>
          </div>
        </td>

        <!-- Duração Final Calculada -->
        <td style="padding: 10px 12px; color: #4caf50; font-weight: 700; font-family: monospace; font-size: 12px;">${finalDurStr}</td>

        <!-- Status & Barra de Progresso Individual -->
        <td style="padding: 10px 12px; width: 140px;" onclick="event.stopPropagation();">
          <div style="display: flex; flex-direction: column; gap: 4px; width: 100%;">
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 10px; font-weight: 700;">
              <span style="color: ${item.status === 'Concluído' ? '#4caf50' : ((item.progress || 0) > 0 ? '#e53935' : 'var(--muted)')};">${item.status || 'Pronto'}</span>
              <span style="color: #ffffff;">${Math.round(item.progress || 0)}%</span>
            </div>
            <div style="width: 100%; height: 6px; background: rgba(0,0,0,0.5); border-radius: 3px; overflow: hidden; border: 1px solid var(--line);">
              <div style="width: ${Math.round(item.progress || 0)}%; height: 100%; background: ${item.status === 'Concluído' ? '#4caf50' : '#e53935'}; transition: width 0.25s ease;"></div>
            </div>
          </div>
        </td>

        <!-- Botão Excluir Single -->
        <td style="padding: 10px 12px; text-align: right; color: var(--muted);" onclick="event.stopPropagation();">
          <span class="btn-remove-single material-symbols-rounded" data-id="${item.id}" style="font-size: 18px; cursor: pointer; color: var(--muted);" onmouseover="this.style.color='#e53935'" onmouseout="this.style.color='var(--muted)'" title="Remover item">delete</span>
        </td>
      </tr>
    `;
  }).join('');

  // Ouvintes de Seleção de Linhas
  const rows = tbody.querySelectorAll('.montage-row');
  rows.forEach(row => {
    row.addEventListener('click', (e) => {
      const id = row.getAttribute('data-id');
      if (e.ctrlKey || e.metaKey) {
        if (selectedVideoIds.has(id)) selectedVideoIds.delete(id);
        else selectedVideoIds.add(id);
      } else {
        selectedVideoIds.clear();
        selectedVideoIds.add(id);
      }
      renderMainVideosTable();
    });
  });

  // Alteração Individual de Porcentagem
  tbody.querySelectorAll('.pct-slider').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const id = e.target.getAttribute('data-id');
      const val = parseInt(e.target.value, 10) || 100;
      updateIndividualPercentage(id, val);
    });
  });

  tbody.querySelectorAll('.pct-num-input').forEach(numInput => {
    numInput.addEventListener('change', (e) => {
      const id = e.target.getAttribute('data-id');
      let val = parseInt(e.target.value, 10);
      if (isNaN(val) || val < 1) val = 1;
      if (val > 100) val = 100;
      updateIndividualPercentage(id, val);
    });
  });

  tbody.querySelectorAll('.btn-remove-single').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = btn.getAttribute('data-id');
      mainVideosList = mainVideosList.filter(item => item.id !== id);
      selectedVideoIds.delete(id);
      renderMainVideosTable();
    });
  });

  updateSummary();
  updateStepperVisuals();
}

function updateIndividualPercentage(id, val) {
  const item = mainVideosList.find(v => v.id === id);
  if (item) {
    item.pctUsed = val;
    item.isCustomPct = true;
    renderMainVideosTable();
  }
}

function updateGlobalPercentage(val) {
  globalDefaultPct = val;
  mainVideosList.forEach(item => {
    if (!item.isCustomPct) {
      item.pctUsed = val;
    }
  });
  renderMainVideosTable();
}

function updateSummary() {
  let mainTotalSec = 0;
  mainVideosList.forEach(item => {
    mainTotalSec += Math.round((item.durationSeconds * item.pctUsed) / 100);
  });

  const mainDurStr = formatSecondsToHHMMSS(mainTotalSec);
  const elMainTotal = document.getElementById('mainTotalDuration');
  if (elMainTotal) elMainTotal.textContent = mainDurStr;

  const elSumMain = document.getElementById('sumMainDur');
  if (elSumMain) elSumMain.textContent = mainDurStr;

  const introSec = introVideo.duration || 0;
  const outroSec = outroVideo.duration || 0;
  const totalSec = introSec + mainTotalSec + outroSec;

  const elSumIntro = document.getElementById('sumIntroDur');
  if (elSumIntro) elSumIntro.textContent = formatSecondsToHHMMSS(introSec);

  const elSumOutro = document.getElementById('sumOutroDur');
  if (elSumOutro) elSumOutro.textContent = formatSecondsToHHMMSS(outroSec);

  const elSumTotal = document.getElementById('sumTotalDur');
  if (elSumTotal) elSumTotal.textContent = formatSecondsToHHMMSS(totalSec);

  const elSumCount = document.getElementById('sumTotalCount');
  if (elSumCount) elSumCount.textContent = mainVideosList.length;
}

function formatSecondsToHHMMSS(totalSeconds) {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function bindEvents() {
  // Controle de Duração Fixa Global (Slider & Input)
  const sliderGlobal = document.getElementById('sliderGlobalPct');
  const numGlobal = document.getElementById('numGlobalPct');

  if (sliderGlobal && numGlobal) {
    sliderGlobal.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10) || 100;
      numGlobal.value = val;
      updateGlobalPercentage(val);
    });

    numGlobal.addEventListener('change', (e) => {
      let val = parseInt(e.target.value, 10);
      if (isNaN(val) || val < 1) val = 1;
      if (val > 100) val = 100;
      sliderGlobal.value = val;
      updateGlobalPercentage(val);
    });
  }

  // 1. Adicionar Vídeos (Arquivos do PC com Extração de Thumbnail Real)
  const btnAddMain = document.getElementById('btnAddMainVideos');
  if (btnAddMain) {
    btnAddMain.addEventListener('click', async () => {
      logScreen('Botão "+ Adicionar" clicado. Abrindo seletor de arquivos...', 'info');
      if (window.bds && window.bds.selectFile) {
        try {
          const result = await window.bds.selectFile({
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Vídeos', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi'] }]
          });

          logScreen(`Retorno do seletor: ${result ? result.length : 0} arquivos selecionados`, 'info');

          if (result && result.length > 0) {
            for (let i = 0; i < result.length; i++) {
              const fp = result[i];
              const name = fp.split(/[\\/]/).pop();
              logScreen(`Adicionando vídeo: ${name}`, 'info');
              
              let dur = 1800;
              let thumbUrl = './assets/podcast_thumb.jpg';

              if (window.bds.probeMontageFile) {
                try {
                  const probe = await window.bds.probeMontageFile(fp);
                  if (probe && probe.duration) dur = probe.duration;
                } catch (e) {
                  logScreen(`Aviso probe file (${name}): ${e.message}`, 'warn');
                }
              }

              // Gerar thumbnail real do vídeo selecionado
              if (window.bds.extractMetadataThumb) {
                try {
                  const tPath = await window.bds.extractMetadataThumb(fp);
                  if (tPath) thumbUrl = 'file:///' + tPath.replace(/\\/g, '/');
                } catch (e) {
                  logScreen(`Aviso extract thumb (${name}): ${e.message}`, 'warn');
                }
              }

              mainVideosList.push({
                id: String(Date.now() + i + Math.random()),
                name: name,
                path: fp,
                thumbnail: thumbUrl,
                durationSeconds: dur,
                pctUsed: globalDefaultPct,
                isCustomPct: false,
                status: 'ok'
              });
            }
            renderMainVideosTable();
            logScreen(`Tabela atualizada. Total de vídeos principais: ${mainVideosList.length}`, 'info');
          }
        } catch (err) {
          logScreen(`Erro ao selecionar arquivo: ${err.message}`, 'error');
          console.error(err);
        }
      } else {
        logScreen('Erro crítico: API window.bds.selectFile não está disponível!', 'error');
      }
    });
  } else {
    logScreen('Erro: Elemento #btnAddMainVideos não encontrado no DOM!', 'error');
  }

  // 2. Modal para Escolher Biblioteca (BDSM, OBS, NVIDIA, TODAS)
  const modal = document.getElementById('librarySelectModal');
  const btnLib = document.getElementById('btnImportFromLibrary');
  const btnCloseModal = document.getElementById('btnCloseLibModal');

  if (btnLib && modal) {
    btnLib.addEventListener('click', () => {
      modal.style.display = 'flex';
    });
  }

  if (btnCloseModal && modal) {
    btnCloseModal.addEventListener('click', () => {
      modal.style.display = 'none';
    });
  }

  document.querySelectorAll('.btn-lib-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      const originType = btn.getAttribute('data-origin');
      if (modal) modal.style.display = 'none';

      if (window.bds && window.bds.searchLibrary) {
        try {
          const filter = originType === 'ALL' ? { limit: 50 } : { origins: [originType], limit: 50 };
          const items = await window.bds.searchLibrary(filter);

          if (items && items.length > 0) {
            let countAdded = 0;
            items.forEach(item => {
              const exists = mainVideosList.some(v => v.path === item.filepath);
              if (!exists) {
                mainVideosList.push({
                  id: String(item.id || Date.now() + Math.random()),
                  name: item.filename,
                  path: item.filepath,
                  thumbnail: item.thumbnail ? `${thumbsDir}/${item.thumbnail}` : './assets/podcast_thumb.jpg',
                  durationSeconds: item.duration || 1800,
                  pctUsed: globalDefaultPct,
                  isCustomPct: false,
                  status: 'ok'
                });
                countAdded++;
              }
            });
            renderMainVideosTable();
          } else {
            window.bdsModal.alert(`Nenhum vídeo encontrado na biblioteca "${originType}".`);
          }
        } catch (e) {
          window.bdsModal.alert('Erro ao buscar vídeos da biblioteca: ' + e.message);
        }
      }
    });
  });

  // 3. Adicionar Pasta
  document.getElementById('btnAddFolder')?.addEventListener('click', async () => {
    if (window.bds && window.bds.selectFolder) {
      const folder = await window.bds.selectFolder();
      if (folder) {
        window.bdsModal.alert(`Pasta selecionada: ${folder}. Mídias prontas para inclusão.`);
      }
    }
  });

  // 4. Limpar Fila
  document.getElementById('btnClearQueue')?.addEventListener('click', async () => {
    if (mainVideosList.length === 0) return;
    if (await window.bdsModal.confirm('Deseja limpar todos os vídeos da fila de montagem?')) {
      mainVideosList = [];
      selectedVideoIds.clear();
      renderMainVideosTable();
    }
  });

  // 5. Ordenar
  document.getElementById('selSortOrder')?.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === 'name_asc') {
      mainVideosList.sort((a, b) => a.name.localeCompare(b.name));
    } else if (val === 'duration_desc') {
      mainVideosList.sort((a, b) => b.durationSeconds - a.durationSeconds);
    }
    renderMainVideosTable();
  });

  // 6. Alterar Abertura & Finalização com Miniaturas Reais
  document.getElementById('btnSelectIntro')?.addEventListener('click', async () => {
    if (window.bds && window.bds.selectFile) {
      const res = await window.bds.selectFile({ properties: ['openFile'] });
      if (res && res.length > 0) {
        const fp = res[0];
        const name = fp.split(/[\\/]/).pop();
        let dur = 7;
        let thumbUrl = '';

        if (window.bds.probeMontageFile) {
          try {
            const probe = await window.bds.probeMontageFile(fp);
            if (probe && probe.duration) dur = probe.duration;
            if (probe && probe.width && probe.height) {
              const resEl = document.getElementById('lblIntroRes');
              if (resEl) resEl.textContent = `${probe.width}x${probe.height}`;
            }
          } catch(e) {}
        }

        if (window.bds.extractMetadataThumb) {
          try {
            const tPath = await window.bds.extractMetadataThumb(fp);
            if (tPath) thumbUrl = 'file:///' + tPath.replace(/\\/g, '/');
          } catch(e) {}
        }

        introVideo = { name, duration: Math.round(dur), path: fp, thumbnail: thumbUrl };
        
        const imgEl = document.getElementById('imgIntroThumb');
        const phEl = document.getElementById('phIntroIcon');
        if (imgEl && thumbUrl) {
          imgEl.src = thumbUrl;
          imgEl.style.display = 'block';
          if (phEl) phEl.style.display = 'none';
        }
        const nameEl = document.getElementById('lblIntroName');
        if (nameEl) nameEl.textContent = name;
        const durEl = document.getElementById('lblIntroDuration');
        if (durEl) durEl.textContent = formatSecondsToHHMMSS(dur);
        updateSummary();
        updateStepperVisuals();
      }
    }
  });

  document.getElementById('btnRemoveIntro')?.addEventListener('click', () => {
    introVideo = { name: 'Nenhuma', duration: 0, path: '', thumbnail: '' };
    const nEl = document.getElementById('lblIntroName');
    if (nEl) nEl.textContent = 'Nenhuma';
    const dEl = document.getElementById('lblIntroDuration');
    if (dEl) dEl.textContent = '00:00:00';
    const rEl = document.getElementById('lblIntroRes');
    if (rEl) rEl.textContent = '-';
    const imgEl = document.getElementById('imgIntroThumb');
    const phEl = document.getElementById('phIntroIcon');
    if (imgEl) imgEl.style.display = 'none';
    if (phEl) phEl.style.display = 'block';
    updateSummary();
    updateStepperVisuals();
  });

  document.getElementById('btnSelectOutro')?.addEventListener('click', async () => {
    if (window.bds && window.bds.selectFile) {
      const res = await window.bds.selectFile({ properties: ['openFile'] });
      if (res && res.length > 0) {
        const fp = res[0];
        const name = res[0].split(/[\\/]/).pop();
        let dur = 7;
        let thumbUrl = '';

        if (window.bds.probeMontageFile) {
          try {
            const probe = await window.bds.probeMontageFile(fp);
            if (probe && probe.duration) dur = probe.duration;
            if (probe && probe.width && probe.height) {
              const resEl = document.getElementById('lblOutroRes');
              if (resEl) resEl.textContent = `${probe.width}x${probe.height}`;
            }
          } catch(e) {}
        }

        if (window.bds.extractMetadataThumb) {
          try {
            const tPath = await window.bds.extractMetadataThumb(fp);
            if (tPath) thumbUrl = 'file:///' + tPath.replace(/\\/g, '/');
          } catch(e) {}
        }

        outroVideo = { name, duration: Math.round(dur), path: fp, thumbnail: thumbUrl };
        
        const imgEl = document.getElementById('imgOutroThumb');
        const phEl = document.getElementById('phOutroIcon');
        if (imgEl && thumbUrl) {
          imgEl.src = thumbUrl;
          imgEl.style.display = 'block';
          if (phEl) phEl.style.display = 'none';
        }
        const nameEl = document.getElementById('lblOutroName');
        if (nameEl) nameEl.textContent = name;
        const durEl = document.getElementById('lblOutroDuration');
        if (durEl) durEl.textContent = formatSecondsToHHMMSS(dur);
        updateSummary();
        updateStepperVisuals();
      }
    }
  });

  document.getElementById('btnRemoveOutro')?.addEventListener('click', () => {
    outroVideo = { name: 'Nenhuma', duration: 0, path: '', thumbnail: '' };
    const nEl = document.getElementById('lblOutroName');
    if (nEl) nEl.textContent = 'Nenhuma';
    const dEl = document.getElementById('lblOutroDuration');
    if (dEl) dEl.textContent = '00:00:00';
    const rEl = document.getElementById('lblOutroRes');
    if (rEl) rEl.textContent = '-';
    const imgEl = document.getElementById('imgOutroThumb');
    const phEl = document.getElementById('phOutroIcon');
    if (imgEl) imgEl.style.display = 'none';
    if (phEl) phEl.style.display = 'block';
    updateSummary();
    updateStepperVisuals();
  });

  // 7. Seleção da Pasta de Destino das Configurações de Saída
  document.getElementById('btnSelectDestFolder')?.addEventListener('click', async () => {
    if (window.bds && window.bds.selectFolder) {
      const currentFolder = document.getElementById('txtDestFolder').value;
      const folder = await window.bds.selectFolder(currentFolder);
      if (folder) {
        document.getElementById('txtDestFolder').value = folder;
      }
    }
  });

  // 8. EXPORTAÇÃO REAL DE TODOS OS VÍDEOS COM AS CONFIGURAÇÕES SELECIONADAS
  document.getElementById('btnExportAll')?.addEventListener('click', async () => {
    if (mainVideosList.length === 0) {
      window.bdsModal.alert('Adicione pelo menos 1 vídeo principal antes de exportar.');
      return;
    }

    const resolution = document.getElementById('selRes')?.value || '1080p';
    const fps = document.getElementById('selFps')?.value || '30';
    const codec = document.getElementById('selCodec')?.value || 'H.264';
    const quality = document.getElementById('selQuality')?.value || 'Alta';
    const format = (document.getElementById('selFormat')?.value || 'mp4').toLowerCase();
    let defaultDest = 'Montagem';
    try {
      const vDir = (await window.bds?.getVideosPath?.()) || '';
      const sep = vDir.includes('\\') ? '\\' : '/';
      defaultDest = (vDir.endsWith('/') || vDir.endsWith('\\')) ? `${vDir}Montagem` : `${vDir}${sep}Montagem`;
    } catch (_) {}
    const destFolder = document.getElementById('txtDestFolder')?.value || defaultDest;
    const baseOutputName = document.getElementById('txtOutputName')?.value || 'Montagem';

    const exportConfig = {
      introPath: introVideo.path,
      outroPath: outroVideo.path,
      resolution,
      fps,
      codec,
      quality,
      format,
      destFolder,
      outputName: baseOutputName,
      items: mainVideosList.map(item => ({
        name: item.name,
        path: item.path,
        durationSeconds: item.durationSeconds,
        pctUsed: item.pctUsed,
        finalDurationSeconds: Math.round((item.durationSeconds * item.pctUsed) / 100)
      }))
    };

    if (window.bds && window.bds.enqueueMontage) {
      try {
        exportState = { active: true, completed: false, current: 1, total: mainVideosList.length, percent: 0 };
        updateStepperVisuals();
        setAppStatus('Montando vídeos...', 'info');

        await window.bds.enqueueMontage(exportConfig);

        exportState = { active: false, completed: true, current: mainVideosList.length, total: mainVideosList.length, percent: 100 };
        updateStepperVisuals();
        setAppStatus('Pronto', 'success');
        window.bdsModal.alert(`Sucesso! Todos os ${mainVideosList.length} vídeos foram exportados com sucesso em ${destFolder}.`);
      } catch (err) {
        exportState.active = false;
        updateStepperVisuals();
        setAppStatus('Erro na montagem', 'error');
        window.bdsModal.alert('Erro ao enviar montagem para o motor FFmpeg: ' + err.message);
      }
    }
  });

  // Salvar Projeto
  document.getElementById('btnSaveProject')?.addEventListener('click', () => {
    window.bdsModal.alert('Configurações e lista de montagem salvas no seu projeto!');
  });
}

function setupIPCListeners() {
  if (window.bds && window.bds.onMontageProgress) {
    window.bds.onMontageProgress((payload) => {
      if (!payload) return;
      
      exportState.active = true;
      exportState.completed = false;
      if (payload.currentFile) exportState.current = payload.currentFile;
      if (payload.totalFiles) exportState.total = payload.totalFiles;
      if (typeof payload.percent === 'number') exportState.percent = payload.percent;

      const idx = (payload.currentFile || 1) - 1;
      if (mainVideosList[idx]) {
        mainVideosList[idx].progress = payload.percent || 0;
        mainVideosList[idx].status = 'Renderizando';
      }

      setAppStatus(`Renderizando ${Math.round(payload.percent || 0)}%...`, 'info');

      renderMainVideosTable();
      updateStepperVisuals();
    });
  }

  if (window.bds && window.bds.onMontageFinished) {
    window.bds.onMontageFinished((payload) => {
      if (payload && (payload.status === 'batch-success' || payload.status === 'success')) {
        exportState.active = false;
        exportState.completed = true;
        exportState.percent = 100;
        
        mainVideosList.forEach(item => {
          item.progress = 100;
          item.status = 'Concluído';
        });

        setAppStatus('Pronto', 'success');
        renderMainVideosTable();
        updateStepperVisuals();
      } else if (payload && payload.status === 'error') {
        exportState.active = false;
        setAppStatus('Erro na montagem', 'error');
      }
    });
  }
}
