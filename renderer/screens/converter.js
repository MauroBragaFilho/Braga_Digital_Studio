let converterList = [];
let thumbsDir = '';
let exportConverterState = {
  active: false,
  completed: false,
  current: 0,
  total: 0,
  percent: 0
};

function logConverterScreen(msg, type = 'info') {
  if (type === 'error') {
    const banner = document.getElementById('converterDebugBanner');
    const output = document.getElementById('converterLogOutput');
    if (banner) banner.style.display = 'block';
    if (output) {
      const time = new Date().toLocaleTimeString('pt-BR');
      output.textContent = `❌ [ERRO DETECTADO] ${time} - ${msg}\n` + output.textContent;
    }
  }
  console.log(`[CONVERTER-${type.toUpperCase()}]:`, msg);
}

export async function initScreen() {
  logConverterScreen('Inicializando tela de Conversão de Mídias...', 'info');

  window.onerror = function(msg, url, lineNo, columnNo, error) {
    logConverterScreen(`Erro JS: ${msg} (Linha: ${lineNo})`, 'error');
    return false;
  };

  window.onunhandledrejection = function(event) {
    logConverterScreen(`Rejeição de Promessa: ${event.reason?.message || event.reason}`, 'error');
  };

  if (window.bds && window.bds.getThumbDir) {
    try {
      const rawDir = await window.bds.getThumbDir();
      thumbsDir = 'file:///' + rawDir.replace(/\\/g, '/');
    } catch (e) {
      logConverterScreen(`Erro ao buscar getThumbDir: ${e.message}`, 'warn');
    }
  }

  converterList = [];

  renderConverterTable();
  bindConverterEvents();
  updateConverterStepperVisuals();
  setupConverterIPCListeners();
}

function updateConverterStepperVisuals() {
  // PASSO 1: FILA DE ARQUIVOS
  const b1 = document.getElementById('step1BadgeConverter');
  const s1 = document.getElementById('step1SubConverter');
  if (b1 && s1) {
    if (converterList.length > 0) {
      b1.style.borderColor = '#4caf50';
      b1.style.background = 'rgba(76, 175, 80, 0.15)';
      b1.style.color = '#4caf50';
      b1.textContent = '✓';
      s1.style.color = '#4caf50';
      s1.textContent = `${converterList.length} arquivo(s) na fila`;
    } else {
      b1.style.borderColor = 'var(--muted)';
      b1.style.background = 'transparent';
      b1.style.color = 'var(--muted)';
      b1.textContent = '1';
      s1.style.color = 'var(--muted)';
      s1.textContent = 'Adicione as mídias';
    }
  }

  // PASSO 2: FORMATO & CODEC
  const b2 = document.getElementById('step2BadgeConverter');
  const s2 = document.getElementById('step2SubConverter');
  const outFormat = document.getElementById('selConverterOutFormat')?.value?.toUpperCase() || 'MP4';
  const resolution = document.getElementById('selConverterResolution')?.value || 'original';

  if (b2 && s2) {
    b2.style.borderColor = '#4caf50';
    b2.style.background = 'rgba(76, 175, 80, 0.15)';
    b2.style.color = '#4caf50';
    b2.textContent = '✓';
    s2.style.color = '#4caf50';
    s2.textContent = `Formato: ${outFormat} (${resolution})`;
  }

  // PASSO 3: CONVERTER & EXPORTAR
  const b3 = document.getElementById('step3BadgeConverter');
  const t3 = document.getElementById('step3TitleConverter');
  const s3 = document.getElementById('step3SubConverter');

  if (b3 && t3 && s3) {
    if (exportConverterState.completed) {
      b3.style.borderColor = '#4caf50';
      b3.style.background = 'rgba(76, 175, 80, 0.15)';
      b3.style.color = '#4caf50';
      b3.textContent = '✓';
      t3.textContent = 'CONCLUÍDO!';
      t3.style.color = '#4caf50';
      s3.style.color = '#4caf50';
      s3.textContent = 'Todos os arquivos foram convertidos!';
    } else if (exportConverterState.active) {
      b3.style.borderColor = '#4caf50';
      b3.style.background = 'rgba(76, 175, 80, 0.15)';
      b3.style.color = '#4caf50';
      b3.textContent = '⏳';
      t3.textContent = `CONVERTENDO (${exportConverterState.current}/${exportConverterState.total})`;
      t3.style.color = '#4caf50';
      s3.style.color = '#4caf50';
      s3.textContent = `Progresso: ${Math.round(exportConverterState.percent)}%`;
    } else {
      b3.style.borderColor = 'var(--muted)';
      b3.style.background = 'transparent';
      b3.style.color = 'var(--muted)';
      b3.textContent = '3';
      t3.textContent = 'CONVERTER & EXPORTAR';
      t3.style.color = '#ffffff';
      s3.style.color = '#var(--muted)';
      s3.textContent = 'Inicie a conversão em lote';
    }
  }
}

function renderConverterTable() {
  const tbody = document.getElementById('converterMainBody');
  const countEl = document.getElementById('converterMainCount');
  const totalDurEl = document.getElementById('converterTotalDuration');

  if (countEl) countEl.textContent = converterList.length;

  let totalSec = 0;
  converterList.forEach(item => {
    totalSec += (item.durationSeconds || 0);
  });
  if (totalDurEl) totalDurEl.textContent = formatSecondsToHHMMSS(totalSec);

  if (!tbody) return;

  if (converterList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="padding: 40px; text-align: center; color: var(--muted);">
          <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
            <span class="material-symbols-rounded" style="font-size: 36px; opacity: 0.4;">sync</span>
            <strong>Fila de conversão vazia</strong>
            <span style="font-size: 11px;">Clique em "+ Adicionar", "Biblioteca" ou "Pasta" para incluir vídeos ou áudios.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  const outFormatVal = document.getElementById('selConverterOutFormat')?.value?.toUpperCase() || 'MP4';

  tbody.innerHTML = converterList.map((item, index) => {
    const ext = item.name.split('.').pop().toUpperCase();
    const isAudio = item.isAudio || ['MP3', 'WAV', 'M4A', 'AAC', 'FLAC', 'OGG'].includes(ext);

    const pct = Math.round(item.progress || 0);
    const statusText = item.status || 'Aguardando';
    const isDone = item.status === 'Concluído' || pct >= 100;
    const barColor = isDone ? '#4caf50' : '#4caf50';

    const thumbHtml = isAudio 
      ? `<div style="width: 56px; height: 34px; background: rgba(33, 150, 243, 0.15); border: 1px solid rgba(33, 150, 243, 0.3); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #2196f3; font-size: 10px; font-weight: 800; letter-spacing: 0.5px; flex-shrink: 0;">ÁUDIO</div>`
      : `<div style="width: 56px; height: 34px; background: #000; border-radius: 4px; overflow: hidden; flex-shrink: 0; position: relative; display: flex; align-items: center; justify-content: center; border: 1px solid var(--line);">
          <img src="${item.thumbnail}" style="width: 100%; height: 100%; object-fit: cover;" onError="this.style.display='none'" />
          <span class="material-symbols-rounded" style="color: var(--muted); font-size: 16px; position: absolute;">movie</span>
         </div>`;

    return `
      <tr style="border-bottom: 1px solid var(--line); transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
        <td style="padding: 10px 12px; font-weight: 700; color: var(--muted);">${index + 1}</td>
        
        <!-- VÍDEO / ARQUIVO COM THUMBNAIL OU BADGE ÁUDIO -->
        <td style="padding: 10px 12px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            ${thumbHtml}
            <div style="min-width: 0; flex: 1;">
              <div style="font-weight: 700; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${item.name}">${item.name}</div>
              <div style="font-size: 10px; color: var(--muted); margin-top: 2px;">Duração: ${formatSecondsToHHMMSS(item.durationSeconds)}</div>
            </div>
          </div>
        </td>

        <td style="padding: 10px 12px; font-weight: 600; color: var(--muted);">${ext}</td>
        <td style="padding: 10px 12px; color: #4caf50; font-weight: 700;">${outFormatVal}</td>

        <!-- BARRA DE PROGRESSO INDIVIDUAL POR LINHA COM NÚMERO NÍTIDO -->
        <td style="padding: 10px 12px;">
          <div style="display: flex; flex-direction: column; gap: 4px; width: 100%;">
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 10px; font-weight: 700;">
              <span style="color: ${isDone ? '#4caf50' : (pct > 0 ? '#4caf50' : 'var(--muted)')};">${statusText}</span>
              <span style="color: #ffffff;">${pct}%</span>
            </div>
            <div style="width: 100%; height: 6px; background: rgba(0,0,0,0.5); border-radius: 3px; overflow: hidden; border: 1px solid var(--line);">
              <div style="width: ${pct}%; height: 100%; background: ${barColor}; transition: width 0.25s ease;"></div>
            </div>
          </div>
        </td>

        <td style="padding: 10px 12px; text-align: center;">
          <button class="btn-remove-converter-item" data-index="${index}" title="Remover item" style="background: transparent; border: none; color: #e53935; cursor: pointer; padding: 4px; display: inline-flex; align-items: center;" onmouseover="this.style.color='#ff5252'" onmouseout="this.style.color='#e53935'">
            <span class="material-symbols-rounded" style="font-size: 18px;">delete</span>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('.btn-remove-converter-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(btn.getAttribute('data-index'), 10);
      if (!isNaN(idx)) {
        converterList.splice(idx, 1);
        if (window.bds && window.bds.converterRemoveFile) {
          window.bds.converterRemoveFile(idx);
        }
        renderConverterTable();
        updateConverterStepperVisuals();
      }
    });
  });
}

function bindConverterEvents() {
  document.getElementById('selConverterOutFormat')?.addEventListener('change', (e) => {
    const codecContainer = document.getElementById('converterCodecContainer');
    if (codecContainer) {
      if (e.target.value === 'mp3') {
        codecContainer.style.display = 'none';
      } else {
        codecContainer.style.display = 'block';
      }
    }
    renderConverterTable();
    updateConverterStepperVisuals();
  });

  document.getElementById('selConverterResolution')?.addEventListener('change', () => {
    updateConverterStepperVisuals();
  });

  // 1. Adicionar Arquivos do PC
  const btnAdd = document.getElementById('btnAddConverterFiles');
  if (btnAdd) {
    btnAdd.addEventListener('click', async () => {
      if (window.bds && window.bds.selectFile) {
        try {
          const files = await window.bds.selectFile({
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Mídias', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mts', 'mpeg', 'mpg', 'vob', 'm4v', '3gp', 'mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'wma'] }]
          });

          if (files && files.length > 0) {
            if (window.bds.converterAddFiles) {
              const res = await window.bds.converterAddFiles(files);
              if (res && res.items) {
                for (let i = 0; i < res.items.length; i++) {
                  const backendItem = res.items[i];
                  const fp = backendItem.file;
                  const name = fp.split(/[\\/]/).pop();
                  let dur = 300; // Will be updated by probe if needed
                  let thumbUrl = './assets/podcast_thumb.jpg';

                  if (window.bds.extractMetadataThumb) {
                    try {
                      const tPath = await window.bds.extractMetadataThumb(fp);
                      if (tPath) thumbUrl = 'file:///' + tPath.replace(/\\/g, '/');
                    } catch (e) {}
                  }

                  converterList.push({
                    id: String(backendItem.id),
                    name: name,
                    path: fp,
                    thumbnail: thumbUrl,
                    durationSeconds: dur,
                    progress: backendItem.progress || 0,
                    status: backendItem.status || 'Aguardando'
                  });
                }
              }
            }
            renderConverterTable();
            updateConverterStepperVisuals();
          }
        } catch (err) {
          logConverterScreen(`Erro ao selecionar arquivo: ${err.message}`, 'error');
        }
      }
    });
  }

  // 2. Modal da Biblioteca
  const modal = document.getElementById('converterLibraryModal');
  const btnLib = document.getElementById('btnImportConverterFromLibrary');
  const btnClose = document.getElementById('btnCloseConverterLibModal');

  if (btnLib && modal) {
    btnLib.addEventListener('click', () => {
      modal.style.display = 'flex';
    });
  }

  if (btnClose && modal) {
    btnClose.addEventListener('click', () => {
      modal.style.display = 'none';
    });
  }

  document.querySelectorAll('.btn-converter-lib-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      const originType = btn.getAttribute('data-origin');
      if (modal) modal.style.display = 'none';

      if (window.bds && window.bds.searchLibrary) {
        try {
          const filter = originType === 'ALL' ? { limit: 50 } : { origins: [originType], limit: 50 };
          const items = await window.bds.searchLibrary(filter);

          if (items && items.length > 0) {
            const addedPaths = [];
            items.forEach(item => {
              const exists = converterList.some(v => v.path === item.filepath);
              if (!exists) {
                addedPaths.push(item.filepath);
              }
            });

            if (addedPaths.length > 0 && window.bds.converterAddFiles) {
              const res = await window.bds.converterAddFiles(addedPaths);
              if (res && res.items) {
                res.items.forEach(backendItem => {
                  const fp = backendItem.file;
                  const itemInfo = items.find(v => v.filepath === fp);
                  if (itemInfo) {
                    converterList.push({
                      id: String(backendItem.id),
                      name: itemInfo.filename,
                      path: itemInfo.filepath,
                      thumbnail: itemInfo.thumbnail ? `${thumbsDir}/${itemInfo.thumbnail}` : './assets/podcast_thumb.jpg',
                      durationSeconds: itemInfo.duration || 300,
                      progress: backendItem.progress || 0,
                      status: backendItem.status || 'Aguardando'
                    });
                  }
                });
              }
            }

            renderConverterTable();
            updateConverterStepperVisuals();
          } else {
            window.bdsModal.alert(`Nenhuma mídia encontrada na biblioteca "${originType}".`);
          }
        } catch (e) {
          logConverterScreen(`Erro ao carregar biblioteca: ${e.message}`, 'error');
        }
      }
    });
  });

  // 3. Limpar Fila
  document.getElementById('btnClearConverterQueue')?.addEventListener('click', () => {
    converterList = [];
    if (window.bds && window.bds.converterClearQueue) {
      window.bds.converterClearQueue();
    }
    renderConverterTable();
    updateConverterStepperVisuals();
  });

  // 4. Selecionar Pasta de Destino
  document.getElementById('btnSelectConverterDestFolder')?.addEventListener('click', async () => {
    if (window.bds && window.bds.selectFolder) {
      const currentFolder = document.getElementById('outConverterFolder')?.value || '';
      const folder = await window.bds.selectFolder(currentFolder);
      if (folder) {
        const input = document.getElementById('outConverterFolder');
        if (input) input.value = folder;
      }
    }
  });

  // 5. INICIAR CONVERSÃO
  document.getElementById('btnStartConverterQueue')?.addEventListener('click', async () => {
    if (converterList.length === 0) {
      window.bdsModal.alert('Adicione pelo menos 1 arquivo de mídia para converter.');
      return;
    }

    const format = document.getElementById('selConverterOutFormat').value;
    const codec = document.getElementById('selConverterCodec')?.value || 'libx264';
    const resolution = document.getElementById('selConverterResolution')?.value || 'original';
    const audioBitrate = document.getElementById('selConverterAudioBitrate')?.value || '192k';
    const outFolder = document.getElementById('outConverterFolder')?.value || 'C:\\Users\\mauri\\Videos\\Conversao';

    const config = {
      format,
      videoCodec: codec,
      videoResolution: resolution === 'original' ? null : parseInt(resolution, 10),
      audioBitrate,
      outFolder
    };

    if (window.bds && window.bds.converterStart) {
      try {
        exportConverterState = { active: true, completed: false, current: 1, total: converterList.length, percent: 0 };
        updateConverterStepperVisuals();

        await window.bds.converterStart(config);
      } catch (err) {
        exportConverterState.active = false;
        updateConverterStepperVisuals();
        logConverterScreen(`Erro ao iniciar conversão: ${err.message}`, 'error');
      }
    }
  });
}

function setupConverterIPCListeners() {
  if (window.bds && window.bds.onConverterProgress) {
    window.bds.onConverterProgress((payload) => {
      if (payload && payload.id) {
        const item = converterList.find(i => String(i.id) === String(payload.id));
        if (item) {
          item.progress = payload.progress || 0;
          item.status = payload.status || 'Convertendo';
        }
        exportConverterState.active = true;
        exportConverterState.percent = payload.progress || 0;
        renderConverterTable();
        updateConverterStepperVisuals();
      }
    });
  }

  if (window.bds && window.bds.onConverterFileStarted) {
    window.bds.onConverterFileStarted((item) => {
      if (item && item.id) {
        const found = converterList.find(i => String(i.id) === String(item.id));
        if (found) {
          found.status = 'Convertendo';
          found.progress = 0;
        }
        renderConverterTable();
      }
    });
  }

  if (window.bds && window.bds.onConverterFileFinished) {
    window.bds.onConverterFileFinished((item) => {
      if (item && item.id) {
        const found = converterList.find(i => String(i.id) === String(item.id));
        if (found) {
          found.status = 'Concluído';
          found.progress = 100;
        }
        renderConverterTable();
      }
    });
  }

  if (window.bds && window.bds.onConverterFinished) {
    window.bds.onConverterFinished((payload) => {
      exportConverterState.active = false;
      exportConverterState.completed = true;
      converterList.forEach(item => {
        item.status = 'Concluído';
        item.progress = 100;
      });
      renderConverterTable();
      updateConverterStepperVisuals();

      const outFolder = document.getElementById('outConverterFolder')?.value || 'C:\\Users\\mauri\\Videos\\Conversao';
      window.bdsModal.alert(`Sucesso! Todos os ${converterList.length} arquivos foram convertidos com sucesso em:\n${outFolder}`);
    });
  }
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
