import { setAppStatus } from '../app.js';
let silenceList = [];
let thumbsDir = '';
let exportSilenceState = {
  active: false,
  completed: false,
  current: 0,
  total: 0,
  percent: 0
};

function logSilenceScreen(msg, type = 'info') {
  if (type === 'error') {
    const banner = document.getElementById('silenceDebugBanner');
    const output = document.getElementById('silenceLogOutput');
    if (banner) banner.style.display = 'block';
    if (output) {
      const time = new Date().toLocaleTimeString('pt-BR');
      output.textContent = `❌ [ERRO DETECTADO] ${time} - ${msg}\n` + output.textContent;
    }
  }
  console.log(`[SILENCE-${type.toUpperCase()}]:`, msg);
}

export async function initScreen() {
  logSilenceScreen('Inicializando tela de Remover Silêncio...', 'info');

  window.onerror = function(msg, url, lineNo, columnNo, error) {
    logSilenceScreen(`Erro JS: ${msg} (Linha: ${lineNo})`, 'error');
    return false;
  };

  window.onunhandledrejection = function(event) {
    logSilenceScreen(`Rejeição de Promessa: ${event.reason?.message || event.reason}`, 'error');
  };

  if (window.bds && window.bds.getThumbDir) {
    try {
      const rawDir = await window.bds.getThumbDir();
      thumbsDir = 'file:///' + rawDir.replace(/\\/g, '/');
    } catch (e) {
      logSilenceScreen(`Erro ao buscar getThumbDir: ${e.message}`, 'warn');
    }
  }

  // Inicializa pasta de destino padrão dinamicamente via backend
  const outFolderInput = document.getElementById('outSilenceFolder');
  if (outFolderInput && !outFolderInput.value) {
    try {
      const videosDir = (await window.bds?.getVideosPath?.()) || '';
      if (videosDir) {
        const sep = videosDir.includes('\\') ? '\\' : '/';
        outFolderInput.value = (videosDir.endsWith('/') || videosDir.endsWith('\\')) ? `${videosDir}RemoverSilencio` : `${videosDir}${sep}RemoverSilencio`;
      }
    } catch (_) {}
  }

  // Fila inicial de remoção de silêncio começa VAZIA por padrão
  silenceList = [];

  renderSilenceTable();
  bindSilenceEvents();
  updateSilenceStepperVisuals();
  setupSilenceIPCListeners();
}

function updateSilenceStepperVisuals() {
  // PASSO 1: FILA DE ARQUIVOS
  const b1 = document.getElementById('step1BadgeSilence');
  const s1 = document.getElementById('step1SubSilence');
  if (b1 && s1) {
    if (silenceList.length > 0) {
      b1.style.borderColor = '#4caf50';
      b1.style.background = 'rgba(76, 175, 80, 0.15)';
      b1.style.color = '#4caf50';
      b1.textContent = '✓';
      s1.style.color = '#4caf50';
      s1.textContent = `${silenceList.length} arquivo(s) na fila`;
    } else {
      b1.style.borderColor = 'var(--muted)';
      b1.style.background = 'transparent';
      b1.style.color = 'var(--muted)';
      b1.textContent = '1';
      s1.style.color = 'var(--muted)';
      s1.textContent = 'Adicione os áudios/vídeos';
    }
  }

  // PASSO 2: CONFIGURAÇÃO DE CORTE
  const b2 = document.getElementById('step2BadgeSilence');
  const s2 = document.getElementById('step2SubSilence');
  const sensitivity = document.getElementById('numSensitivity')?.value || '-30';
  const minDur = document.getElementById('numMinDuration')?.value || '0.5';

  if (b2 && s2) {
    b2.style.borderColor = '#4caf50';
    b2.style.background = 'rgba(76, 175, 80, 0.15)';
    b2.style.color = '#4caf50';
    b2.textContent = '✓';
    s2.style.color = '#4caf50';
    s2.textContent = `Sensibilidade: ${sensitivity}dB / ${minDur}s`;
  }

  // PASSO 3: PROCESSAR & EXPORTAR
  const b3 = document.getElementById('step3BadgeSilence');
  const t3 = document.getElementById('step3TitleSilence');
  const s3 = document.getElementById('step3SubSilence');

  if (b3 && t3 && s3) {
    if (exportSilenceState.completed) {
      b3.style.borderColor = '#4caf50';
      b3.style.background = 'rgba(76, 175, 80, 0.15)';
      b3.style.color = '#4caf50';
      b3.textContent = '✓';
      t3.textContent = 'CONCLUÍDO!';
      t3.style.color = '#4caf50';
      s3.style.color = '#4caf50';
      s3.textContent = 'Todos os arquivos foram processados!';
    } else if (exportSilenceState.active) {
      b3.style.borderColor = '#f25c05';
      b3.style.background = 'rgba(242, 92, 5, 0.15)';
      b3.style.color = '#f25c05';
      b3.textContent = '⏳';
      t3.textContent = `PROCESSANDO (${exportSilenceState.current}/${exportSilenceState.total})`;
      t3.style.color = '#f25c05';
      s3.style.color = '#f25c05';
      s3.textContent = `Progresso: ${Math.round(exportSilenceState.percent)}%`;
    } else {
      b3.style.borderColor = 'var(--muted)';
      b3.style.background = 'transparent';
      b3.style.color = 'var(--muted)';
      b3.textContent = '3';
      t3.textContent = 'PROCESSAR & EXPORTAR';
      t3.style.color = '#ffffff';
      s3.style.color = 'var(--muted)';
      s3.textContent = 'Inicie os cortes automáticos';
    }
  }
}

function renderSilenceTable() {
  const tbody = document.getElementById('silenceMainBody');
  const countEl = document.getElementById('silenceMainCount');
  const totalDurEl = document.getElementById('silenceTotalDuration');

  if (countEl) countEl.textContent = silenceList.length;

  let totalSec = 0;
  silenceList.forEach(item => {
    totalSec += (item.durationSeconds || 0);
  });
  if (totalDurEl) totalDurEl.textContent = formatSecondsToHHMMSS(totalSec);

  if (!tbody) return;

  if (silenceList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="padding: 40px; text-align: center; color: var(--muted);">
          <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
            <span class="material-symbols-rounded" style="font-size: 36px; opacity: 0.4;">graphic_eq</span>
            <strong>Fila de arquivos vazia</strong>
            <span style="font-size: 11px;">Clique em "+ Adicionar", "Biblioteca" ou "Pasta" para incluir áudios ou vídeos.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = silenceList.map((item, index) => {
    const ext = item.name.split('.').pop().toUpperCase();
    const durStr = formatSecondsToHHMMSS(item.durationSeconds || 0);
    const isAudio = item.isAudio || ['MP3', 'WAV', 'M4A', 'AAC', 'FLAC', 'OGG'].includes(ext);

    const thumbHtml = isAudio
      ? `<div style="width: 56px; height: 34px; background: rgba(33, 150, 243, 0.15); border: 1px solid rgba(33, 150, 243, 0.3); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #2196f3; font-size: 10px; font-weight: 800; letter-spacing: 0.5px; flex-shrink: 0;">ÁUDIO</div>`
      : `<div style="width: 56px; height: 34px; background: #000; border-radius: 4px; overflow: hidden; flex-shrink: 0; position: relative; display: flex; align-items: center; justify-content: center; border: 1px solid var(--line);">
          <img src="${item.thumbnail}" style="width: 100%; height: 100%; object-fit: cover;" onError="this.style.display='none'" />
          <span class="material-symbols-rounded" style="color: var(--muted); font-size: 16px; position: absolute;">movie</span>
         </div>`;

    return `
      <tr style="border-bottom: 1px solid var(--line); transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
        <td style="padding: 10px 12px; font-weight: 700; color: var(--muted);">${index + 1}</td>
        
        <!-- VÍDEO / ARQUIVO COM THUMBNAIL REAL OU BADGE ÁUDIO -->
        <td style="padding: 10px 12px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            ${thumbHtml}
            <div style="min-width: 0; flex: 1;">
              <div style="font-weight: 700; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${item.name}">${item.name}</div>
              <div style="font-size: 10px; color: var(--muted); margin-top: 2px;">Formato: ${ext}</div>
            </div>
          </div>
        </td>

        <td style="padding: 10px 12px; font-weight: 600; color: #ffffff;">${durStr}</td>
        <td style="padding: 10px 12px; color: #f25c05; font-weight: 600;">Automático</td>
        <td style="padding: 10px 12px; color: #4caf50; font-weight: 600;">Corte inteligente</td>

        <!-- PROGRESSO INDIVIDUAL POR ARQUIVO -->
        <td style="padding: 10px 12px; width: 160px;">
          <div style="display: flex; flex-direction: column; gap: 4px; width: 100%;">
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 10px; font-weight: 700;">
              <span style="color: ${item.status === 'Concluído' ? '#4caf50' : ((item.progress || 0) > 0 ? '#f25c05' : 'var(--muted)')};">${item.status || 'Pronto'}</span>
              <span style="color: #ffffff;">${Math.round(item.progress || 0)}%</span>
            </div>
            <div style="width: 100%; height: 6px; background: rgba(0,0,0,0.5); border-radius: 3px; overflow: hidden; border: 1px solid var(--line);">
              <div style="width: ${Math.round(item.progress || 0)}%; height: 100%; background: ${item.status === 'Concluído' ? '#4caf50' : '#f25c05'}; transition: width 0.25s ease;"></div>
            </div>
          </div>
        </td>

        <td style="padding: 10px 12px; text-align: center;">
          <button class="btn-remove-silence-item" data-id="${item.id}" title="Remover item" style="background: transparent; border: none; color: #e53935; cursor: pointer; padding: 4px; display: inline-flex; align-items: center;" onmouseover="this.style.color='#ff5252'" onmouseout="this.style.color='#e53935'">
            <span class="material-symbols-rounded" style="font-size: 18px;">delete</span>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // Adiciona evento aos botões de remoção individual
  document.querySelectorAll('.btn-remove-silence-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = btn.getAttribute('data-id');
      silenceList = silenceList.filter(item => item.id !== id);
      renderSilenceTable();
      updateSilenceStepperVisuals();
    });
  });
}

function bindSilenceEvents() {
  // Controle de Sensibilidade (Slider & Input)
  const sliderSens = document.getElementById('sliderSensitivity');
  const numSens = document.getElementById('numSensitivity');
  const lblSens = document.getElementById('lblSensitivity');

  if (sliderSens && numSens) {
    sliderSens.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10) || -30;
      numSens.value = val;
      if (lblSens) lblSens.textContent = `${val} dB`;
      updateSilenceStepperVisuals();
    });

    numSens.addEventListener('change', (e) => {
      let val = parseInt(e.target.value, 10);
      if (isNaN(val)) val = -30;
      if (val < -60) val = -60;
      if (val > -10) val = -10;
      sliderSens.value = val;
      if (lblSens) lblSens.textContent = `${val} dB`;
      updateSilenceStepperVisuals();
    });
  }

  // Controle de Duração Mínima (Slider & Input)
  const sliderMin = document.getElementById('sliderMinDuration');
  const numMin = document.getElementById('numMinDuration');
  const lblMin = document.getElementById('lblMinDuration');

  if (sliderMin && numMin) {
    sliderMin.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value) || 0.5;
      numMin.value = val;
      if (lblMin) lblMin.textContent = `${val}s (${Math.round(val * 1000)}ms)`;
      updateSilenceStepperVisuals();
    });

    numMin.addEventListener('change', (e) => {
      let val = parseFloat(e.target.value);
      if (isNaN(val) || val < 0.1) val = 0.1;
      if (val > 5.0) val = 5.0;
      sliderMin.value = val;
      if (lblMin) lblMin.textContent = `${val}s (${Math.round(val * 1000)}ms)`;
      updateSilenceStepperVisuals();
    });
  }

  // 1. Adicionar Vídeos (Arquivos do PC)
  const btnAddMain = document.getElementById('btnAddSilenceVideos');
  if (btnAddMain) {
    btnAddMain.addEventListener('click', async () => {
      logSilenceScreen('Botão "+ Adicionar" clicado. Abrindo seletor de arquivos...', 'info');
      if (window.bds && window.bds.selectFile) {
        try {
          const result = await window.bds.selectFile({
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Mídias', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'mp3', 'wav', 'm4a'] }]
          });

          if (result && result.length > 0) {
            for (let i = 0; i < result.length; i++) {
              const fp = result[i];
              const name = fp.split(/[\\/]/).pop();
              
              let dur = 300;
              let thumbUrl = './assets/podcast_thumb.jpg';

              if (window.bds.probeSilenceFile) {
                try {
                  const probe = await window.bds.probeSilenceFile(fp);
                  if (probe && probe.duration) dur = probe.duration;
                } catch (e) {}
              }

              if (window.bds.extractMetadataThumb) {
                try {
                  const tPath = await window.bds.extractMetadataThumb(fp);
                  if (tPath) thumbUrl = 'file:///' + tPath.replace(/\\/g, '/');
                } catch (e) {}
              }

              silenceList.push({
                id: String(Date.now() + i + Math.random()),
                name: name,
                path: fp,
                thumbnail: thumbUrl,
                durationSeconds: dur
              });
            }
            renderSilenceTable();
            updateSilenceStepperVisuals();
          }
        } catch (err) {
          logSilenceScreen(`Erro ao selecionar arquivo: ${err.message}`, 'error');
        }
      }
    });
  }

  // 2. Modal de Biblioteca para Remover Silêncio
  const modal = document.getElementById('silenceLibraryModal');
  const btnLib = document.getElementById('btnImportSilenceFromLibrary');
  const btnCloseModal = document.getElementById('btnCloseSilenceLibModal');

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

  document.querySelectorAll('.btn-silence-lib-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      const originType = btn.getAttribute('data-origin');
      if (modal) modal.style.display = 'none';

      if (window.bds && window.bds.searchLibrary) {
        try {
          const filter = originType === 'ALL' ? { limit: 50 } : { origins: [originType], limit: 50 };
          const items = await window.bds.searchLibrary(filter);

          if (items && items.length > 0) {
            items.forEach(item => {
              const exists = silenceList.some(v => v.path === item.filepath);
              if (!exists) {
                silenceList.push({
                  id: String(item.id || Date.now() + Math.random()),
                  name: item.filename,
                  path: item.filepath,
                  thumbnail: item.thumbnail ? `${thumbsDir}/${item.thumbnail}` : './assets/podcast_thumb.jpg',
                  durationSeconds: item.duration || 300
                });
              }
            });
            renderSilenceTable();
            updateSilenceStepperVisuals();
          } else {
            window.bdsModal.alert(`Nenhuma mídia encontrada na biblioteca "${originType}".`);
          }
        } catch (e) {
          logSilenceScreen(`Erro ao buscar biblioteca: ${e.message}`, 'error');
        }
      }
    });
  });

  // 3. Adicionar Pasta
  document.getElementById('btnAddSilenceFolder')?.addEventListener('click', async () => {
    if (window.bds && window.bds.selectFolder) {
      const folder = await window.bds.selectFolder();
      if (folder) {
        window.bdsModal.alert(`Pasta selecionada: ${folder}. Mídias prontas para inclusão.`);
      }
    }
  });

  // 4. Limpar Fila
  document.getElementById('btnClearSilenceQueue')?.addEventListener('click', () => {
    silenceList = [];
    renderSilenceTable();
    updateSilenceStepperVisuals();
  });

  // 5. Seleção de Pasta de Destino
  document.getElementById('btnSelectSilenceDestFolder')?.addEventListener('click', async () => {
    if (window.bds && window.bds.selectFolder) {
      const currentFolder = document.getElementById('outSilenceFolder')?.value || '';
      const folder = await window.bds.selectFolder(currentFolder);
      if (folder) {
        const input = document.getElementById('outSilenceFolder');
        if (input) input.value = folder;
      }
    }
  });

  // 6. PROCESSAR REMOVER SILÊNCIO
  document.getElementById('btnStartSilenceQueue')?.addEventListener('click', async () => {
    if (silenceList.length === 0) {
      window.bdsModal.alert('Adicione pelo menos 1 vídeo ou áudio antes de iniciar.');
      return;
    }

    const threshold = parseInt(document.getElementById('numSensitivity')?.value || '-30', 10);
    const minDuration = parseFloat(document.getElementById('numMinDuration')?.value || '0.5');
    const mode = document.getElementById('selSilenceMode')?.value || 'remove';
    let defaultOut = '';
    try {
      const vDir = (await window.bds?.getVideosPath?.()) || '';
      const sep = vDir.includes('\\') ? '\\' : '/';
      defaultOut = (vDir.endsWith('/') || vDir.endsWith('\\')) ? `${vDir}RemoverSilencio` : `${vDir}${sep}RemoverSilencio`;
    } catch (_) {}
    const outFolder = document.getElementById('outSilenceFolder')?.value || defaultOut;

    const processConfig = {
      files: silenceList.map(item => item.path),
      threshold: threshold,
      minDuration: minDuration,
      mode: mode,
      outFolder: outFolder
    };

    if (window.bds && window.bds.processSilence) {
      try {
        setAppStatus('Removendo Silêncio...', 'warning');
        exportSilenceState = { active: true, completed: false, current: 1, total: silenceList.length, percent: 0 };
        updateSilenceStepperVisuals();

        const res = await window.bds.processSilence(processConfig);

        exportSilenceState = { active: false, completed: true, current: silenceList.length, total: silenceList.length, percent: 100 };
        updateSilenceStepperVisuals();
        setAppStatus('Pronto', 'success');
      } catch (err) {
        exportSilenceState.active = false;
        updateSilenceStepperVisuals();
        setAppStatus('Erro', 'error');
        logSilenceScreen(`Erro ao processar silêncios: ${err.message}`, 'error');
      }
    }
  });
}

function setupSilenceIPCListeners() {
  if (window.bds && window.bds.onSilenceProgress) {
    window.bds.onSilenceProgress((payload) => {
      if (payload) {
        exportSilenceState.active = true;
        exportSilenceState.current = payload.index || 1;
        exportSilenceState.total = payload.total || silenceList.length;
        exportSilenceState.percent = payload.percent || 0;

        const itemIdx = (payload.index || 1) - 1;
        if (silenceList[itemIdx]) {
          silenceList[itemIdx].progress = payload.percent || 0;
          silenceList[itemIdx].status = payload.status || 'Processando';
        }

        setAppStatus(`Removendo silêncio ${Math.round(payload.percent || 0)}%...`, 'info');
        renderSilenceTable();
        updateSilenceStepperVisuals();
      }
    });
  }

  if (window.bds && window.bds.onSilenceFinished) {
    window.bds.onSilenceFinished((payload) => {
      if (payload && payload.status === 'success') {
        exportSilenceState.active = false;
        exportSilenceState.completed = true;
        
        silenceList.forEach(item => {
          item.progress = 100;
          item.status = 'Concluído';
        });

        setAppStatus('Pronto', 'success');
        renderSilenceTable();
        updateSilenceStepperVisuals();

        const outFolder = document.getElementById('outSilenceFolder')?.value || 'RemoverSilencio';
        const threshold = document.getElementById('numSensitivity')?.value || '-30';

        let msg = `Processamento concluído com sucesso em:\n${outFolder}`;
        if (payload.copiedCount > 0 && payload.processedCount === 0) {
          msg += `\n\n📌 Nenhum silêncio foi detectado sob o limiar de ${threshold}dB.\nOs arquivos foram exportados para a pasta de destino.\n\n(Dica: Para detectar silêncios com volume mais alto, tente ajustar a sensibilidade para -40dB ou -50dB).`;
        } else if (payload.processedCount > 0) {
          msg = `Sucesso! Silêncio removido de ${payload.processedCount} arquivo(s).\nSalvos em: ${outFolder}`;
        }
        window.bdsModal.alert(msg);
      } else {
        exportSilenceState.active = false;
        setAppStatus('Erro', 'error');
      }
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
