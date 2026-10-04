import { setAppStatus } from '../app.js';
import { escapeHtml, escapeAttr } from '../utils/escape.js';
import { friendlyError, cleanText } from '../utils/friendlyError.js';
const LAST_DIR_KEY = 'bds_silence_lastOutDir';
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
      output.textContent = `${time} - ${msg}\n` + output.textContent;
    }
  }
  console.log(`[SILENCE-${type.toUpperCase()}]:`, msg);
}

// Handlers de erro via addEventListener, removidos em onLeave
let errorHandlers = null;
function installErrorHandlers() {
  removeErrorHandlers();
  const onError = (e) => logSilenceScreen(`Erro JS: ${friendlyError(e)} (Linha: ${e.lineno})`, 'error');
  const onRejection = (e) => logSilenceScreen(`Rejeição de Promessa: ${e.reason?.message || e.reason}`, 'error');
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  errorHandlers = { onError, onRejection };
}
function removeErrorHandlers() {
  if (!errorHandlers) return;
  window.removeEventListener('error', errorHandlers.onError);
  window.removeEventListener('unhandledrejection', errorHandlers.onRejection);
  errorHandlers = null;
}

// Esc fecha o seletor da biblioteca
let escListener = null;
function removeEscListener() {
  if (escListener) document.removeEventListener('keydown', escListener);
  escListener = null;
}

export function onLeave() { removeErrorHandlers(); }
export function onEnter() { if (!errorHandlers) installErrorHandlers(); }

export async function initScreen() {
  logSilenceScreen('Inicializando tela de Remover Silêncio...', 'info');

  installErrorHandlers();

  if (window.bds && window.bds.getThumbDir) {
    try {
      const rawDir = await window.bds.getThumbDir();
      thumbsDir = 'file:///' + rawDir.replace(/\\/g, '/');
    } catch (e) {
      logSilenceScreen(`Erro ao buscar getThumbDir: ${friendlyError(e)}`, 'warn');
    }
  }

  // Inicializa pasta de destino padrão dinamicamente via backend
  const outFolderInput = document.getElementById('outSilenceFolder');
  // Lembra a última pasta de destino escolhida
  try { const saved = localStorage.getItem(LAST_DIR_KEY); if (outFolderInput && saved && !outFolderInput.value) outFolderInput.value = saved; } catch (_) { /* sem armazenamento */ }
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
      b1.style.color = 'var(--silence-ok)';
      b1.textContent = '✓';
      s1.style.color = 'var(--silence-ok)';
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
    b2.style.color = 'var(--silence-ok)';
    b2.textContent = '✓';
    s2.style.color = 'var(--silence-ok)';
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
      b3.style.color = 'var(--silence-ok)';
      b3.textContent = '✓';
      t3.textContent = 'CONCLUÍDO!';
      t3.style.color = 'var(--silence-ok)';
      s3.style.color = 'var(--silence-ok)';
      s3.textContent = 'Todos os arquivos foram processados!';
    } else if (exportSilenceState.active) {
      b3.style.borderColor = 'var(--accent)';
      b3.style.background = 'color-mix(in srgb, var(--accent) 15%, transparent)';
      b3.style.color = 'var(--accent)';
      b3.textContent = '⏳';
      t3.textContent = `PROCESSANDO (${exportSilenceState.current}/${exportSilenceState.total})`;
      t3.style.color = 'var(--accent)';
      s3.style.color = 'var(--accent)';
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
            <span style="font-size: 11px;">Arraste arquivos para cá ou use "Adicionar".</span>
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
          ${item.thumbnail ? `<img src="${escapeAttr(item.thumbnail)}" alt="" style="width: 100%; height: 100%; object-fit: cover; position: relative; z-index: 1;" />` : ''}
          <span class="material-symbols-rounded" style="color: var(--muted); font-size: 16px; position: absolute;">movie</span>
         </div>`;

    const isDone = item.status === 'Concluído' || String(item.status || '').startsWith('Exportado');
    const isBad = item.status === 'Erro';
    const isWarn = item.status === 'Ignorado' || item.status === 'Cancelado';
    const statusColor = isDone ? '#4caf50' : (isBad ? '#e53935' : (isWarn ? '#ffb300' : ((item.progress || 0) > 0 ? 'var(--accent)' : 'var(--muted)')));

    return `
      <tr class="silence-row" style="border-bottom: 1px solid var(--line);">
        <td style="padding: 10px 12px; font-weight: 700; color: var(--muted);">${index + 1}</td>
        
        <!-- VÍDEO / ARQUIVO COM THUMBNAIL REAL OU BADGE ÁUDIO -->
        <td style="padding: 10px 12px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            ${thumbHtml}
            <div style="min-width: 0; flex: 1;">
              <div style="font-weight: 700; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</div>
              <div style="font-size: 10px; color: var(--muted); margin-top: 2px;">Formato: ${escapeHtml(ext)}</div>
            </div>
          </div>
        </td>

        <td style="padding: 10px 12px; font-weight: 600; color: #ffffff;">${item.durationSeconds > 0 ? durStr : '—'}</td>
        <td style="padding: 10px 12px; color: var(--accent); font-weight: 600;">${item.silenceSeconds != null ? formatSecondsToHHMMSS(Math.round(item.silenceSeconds)) : '—'}</td>
        <td style="padding: 10px 12px; color: #4caf50; font-weight: 600;">${item.newDuration != null ? formatSecondsToHHMMSS(Math.round(item.newDuration)) : '—'}</td>

        <!-- PROGRESSO INDIVIDUAL POR ARQUIVO -->
        <td style="padding: 10px 12px; width: 160px;">
          <div style="display: flex; flex-direction: column; gap: 4px; width: 100%;">
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 10px; font-weight: 700;">
              <span style="color: ${statusColor};" title="${escapeAttr(cleanText(item.message || ''))}">${escapeHtml(item.status || 'Pronto')}</span>
              <span style="color: #ffffff;">${Math.round(item.progress || 0)}%</span>
            </div>
            <div style="width: 100%; height: 6px; background: rgba(0,0,0,0.5); border-radius: 3px; overflow: hidden; border: 1px solid var(--line);">
              <div style="width: ${Math.round(item.progress || 0)}%; height: 100%; background: ${isDone ? '#4caf50' : (isBad ? '#e53935' : 'var(--accent)')}; transition: width 0.25s ease;"></div>
            </div>
          </div>
        </td>

        <td style="padding: 10px 12px; text-align: center;">
          <button class="btn-remove-silence-item" data-id="${item.id}" title="Remover item" style="background: transparent; border: none; color: #e53935; cursor: pointer; padding: 4px; display: inline-flex; align-items: center;">
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
      const index = silenceList.findIndex(item => item.id === id);
      const removed = index >= 0 ? silenceList[index] : null;
      silenceList = silenceList.filter(item => item.id !== id);
      renderSilenceTable();
      updateSilenceStepperVisuals();
      if (removed) {
        window.bdsToast?.('Arquivo removido da fila.', {
          actionLabel: 'Desfazer',
          onAction: () => {
            if (silenceList.some(i => i.id === removed.id)) return;
            silenceList.splice(Math.min(index, silenceList.length), 0, removed);
            renderSilenceTable();
            updateSilenceStepperVisuals();
          }
        });
      }
    });
  });
}

const SILENCE_MEDIA_EXTENSIONS = ['mp4', 'mkv', 'mov', 'webm', 'avi', 'wmv', 'flv', 'm4v', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', '3gp', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'];

/** Entra na fila: ignora o que já está nela e o que não é áudio/vídeo; lê duração e miniatura de cada arquivo. */
async function addSilenceFiles(paths) {
  const fresh = [];
  for (const fp of paths || []) {
    const ext = String(fp).split('.').pop().toLowerCase();
    if (!SILENCE_MEDIA_EXTENSIONS.includes(ext)) continue;
    if (silenceList.some((it) => it.path === fp) || fresh.includes(fp)) continue;
    fresh.push(fp);
  }
  if (!fresh.length) {
    if (paths && paths.length) logSilenceScreen('Nenhum arquivo novo de áudio ou vídeo para adicionar.', 'info');
    return;
  }
  for (const fp of fresh) {
    const item = { id: String(Date.now() + Math.random()), name: fp.split(/[\\/]/).pop(), path: fp, thumbnail: '', durationSeconds: 0, isAudio: false };
    if (window.bds && window.bds.probeSilenceFile) {
      try {
        const probe = await window.bds.probeSilenceFile(fp);
        if (probe && probe.duration) item.durationSeconds = probe.duration;
        if (probe && probe.isVideo === false) item.isAudio = true;
      } catch (_) { /* arquivo ilegível: o aviso aparece ao processar */ }
    }
    if (!item.isAudio && window.bds && window.bds.extractMetadataThumb) {
      try {
        const tPath = await window.bds.extractMetadataThumb(fp);
        if (tPath) item.thumbnail = 'file:///' + tPath.replace(/\\/g, '/');
      } catch (_) { /* sem miniatura: fica o ícone */ }
    }
    silenceList.push(item);
  }
  renderSilenceTable();
  updateSilenceStepperVisuals();
}

function bindSilenceEvents() {
  // Fechar o aviso de erro (a política de segurança bloqueia onclick inline)
  document.getElementById('btnCloseSilenceError')?.addEventListener('click', () => {
    const banner = document.getElementById('silenceDebugBanner');
    if (banner) banner.style.display = 'none';
  });

  // Arrastar e soltar arquivos na fila
  const dropZone = document.querySelector('#silenceView .silence-screen-container');
  if (dropZone && window.bds && window.bds.getPathForFile) {
    const isFileDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    dropZone.addEventListener('dragover', (e) => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    dropZone.addEventListener('drop', async (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      const paths = Array.from(e.dataTransfer.files || []).map((f) => window.bds.getPathForFile(f)).filter(Boolean);
      await addSilenceFiles(paths);
    });
  }

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

          if (result && result.length > 0) await addSilenceFiles(result);
        } catch (err) {
          logSilenceScreen(`Erro ao selecionar arquivo: ${friendlyError(err)}`, 'error');
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
  if (modal) {
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Escolher da biblioteca');
    removeEscListener();
    escListener = (e) => { if (e.key === 'Escape' && modal.style.display !== 'none') modal.style.display = 'none'; };
    document.addEventListener('keydown', escListener);
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
                  thumbnail: item.thumbnail ? `${thumbsDir}/${item.thumbnail}` : '',
                  durationSeconds: item.duration || 0
                });
              }
            });
            renderSilenceTable();
            updateSilenceStepperVisuals();
          } else {
            window.bdsModal.alert(`Nenhuma mídia encontrada na biblioteca "${originType}".`);
          }
        } catch (e) {
          logSilenceScreen(`Erro ao buscar biblioteca: ${friendlyError(e)}`, 'error');
        }
      }
    });
  });

  // 3. Adicionar Pasta
  document.getElementById('btnAddSilenceFolder')?.addEventListener('click', async () => {
    if (window.bds && window.bds.selectFolder) {
      const folder = await window.bds.selectFolder();
      if (!folder) return;
      try {
        const files = window.bds.getLibraryFolderFiles ? await window.bds.getLibraryFolderFiles(folder) : [];
        if (!files || files.length === 0) {
          window.bdsModal.alert(`Nenhum áudio ou vídeo encontrado na pasta:\n${folder}`);
          return;
        }
        await addSilenceFiles(files);
      } catch (err) {
        logSilenceScreen(`Erro ao ler a pasta: ${friendlyError(err)}`, 'error');
      }
    }
  });

  // 4. Limpar Fila
  document.getElementById('btnClearSilenceQueue')?.addEventListener('click', () => {
    const previous = silenceList;
    silenceList = [];
    if (previous.length) {
      window.bdsToast?.(`Fila limpa (${previous.length} arquivo${previous.length > 1 ? 's' : ''}).`, {
        actionLabel: 'Desfazer',
        onAction: () => {
          if (silenceList.length) return;
          silenceList = previous;
          renderSilenceTable();
          updateSilenceStepperVisuals();
        }
      });
    }
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
        try { localStorage.setItem(LAST_DIR_KEY, folder); } catch (_) { /* sem armazenamento */ }
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
        silenceList.forEach(item => { item.progress = 0; item.status = 'Pronto'; });
        renderSilenceTable();
        updateSilenceStepperVisuals();
        updateSilenceRunningUi();

        // O resultado real (sucesso, erro, cancelado) chega no evento silence:finished;
        // o retorno desta chamada só indica que o processamento terminou.
        await window.bds.processSilence(processConfig);
      } catch (err) {
        exportSilenceState.active = false;
        updateSilenceStepperVisuals();
        updateSilenceRunningUi();
        setAppStatus('Erro', 'error');
        logSilenceScreen(`Erro ao processar silêncios: ${friendlyError(err)}`, 'error');
        window.bdsModal.alert(`Não foi possível remover o silêncio:\n${friendlyError(err)}`);
      }
    }
  });

  // 7. Cancelar processamento em andamento
  document.getElementById('btnCancelSilence')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnCancelSilence');
    if (btn) btn.disabled = true;
    try {
      await window.bds?.cancelSilence?.();
    } catch (err) {
      logSilenceScreen(`Erro ao cancelar: ${friendlyError(err)}`, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

// Alterna "Remover Silêncio" / "Cancelar" conforme o processamento
function updateSilenceRunningUi() {
  const start = document.getElementById('btnStartSilenceQueue');
  const cancel = document.getElementById('btnCancelSilence');
  if (start) start.style.display = exportSilenceState.active ? 'none' : 'flex';
  if (cancel) cancel.style.display = exportSilenceState.active ? 'flex' : 'none';
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
          if (payload.silenceSeconds != null) silenceList[itemIdx].silenceSeconds = payload.silenceSeconds;
          if (payload.newDuration != null) silenceList[itemIdx].newDuration = payload.newDuration;
        }

        setAppStatus(`Removendo silêncio ${Math.round(payload.percent || 0)}%...`, 'info');
        if (payload.message && silenceList[itemIdx]) silenceList[itemIdx].message = cleanText(payload.message);
        renderSilenceTable();
        updateSilenceStepperVisuals();
        updateSilenceRunningUi();
      }
    });
  }

  if (window.bds && window.bds.onSilenceFinished) {
    window.bds.onSilenceFinished((payload) => {
      exportSilenceState.active = false;
      const status = payload?.status;
      const skipped = payload?.skipped || [];
      const failed = payload?.failed || [];
      const nameOf = (p) => String(p || '').split(/[\\/]/).pop();

      if (status === 'success' || status === 'partial') {
        exportSilenceState.completed = true;
        setAppStatus(status === 'success' ? 'Pronto' : 'Concluído com avisos', status === 'success' ? 'success' : 'warning');
        renderSilenceTable();
        updateSilenceStepperVisuals();
        updateSilenceRunningUi();

        const outFolder = document.getElementById('outSilenceFolder')?.value || 'RemoverSilencio';
        const threshold = document.getElementById('numSensitivity')?.value || '-30';

        let msg = `Processamento concluído em:\n${outFolder}`;
        if (payload.copiedCount > 0 && payload.processedCount === 0) {
          msg += `\n\nNenhum silêncio foi detectado sob o limiar de ${threshold}dB.\nOs arquivos foram exportados para a pasta de destino.\n\n(Dica: Para detectar silêncios com volume mais alto, tente ajustar a sensibilidade para -40dB ou -50dB).`;
        } else if (payload.processedCount > 0) {
          msg = `Silêncio removido de ${payload.processedCount} arquivo(s).\nSalvos em: ${outFolder}`;
        }
        if (skipped.length) msg += `\n\nIgnorados (${skipped.length}):\n` + skipped.map(s => `- ${nameOf(s.file)}: ${cleanText(s.reason)}`).join('\n');
        if (failed.length) msg += `\n\nCom erro (${failed.length}):\n` + failed.map(s => `- ${nameOf(s.file)}: ${friendlyError(s.error)}`).join('\n');
        window.bdsModal.alert(msg);
      } else if (status === 'canceled') {
        exportSilenceState.completed = false;
        silenceList.forEach(item => {
          if (item.status !== 'Concluído' && item.status !== 'Exportado (sem silêncio)') { item.status = 'Cancelado'; item.progress = 0; }
        });
        setAppStatus('Cancelado', 'warning');
        renderSilenceTable();
        updateSilenceStepperVisuals();
        updateSilenceRunningUi();
      } else {
        // Erro: a mensagem fica visível (banner + aviso) e o passo 3 NÃO aparece como concluído
        exportSilenceState.completed = false;
        const msg = friendlyError(payload?.error, 'Não foi possível remover o silêncio deste arquivo.');
        setAppStatus('Erro', 'error');
        renderSilenceTable();
        updateSilenceStepperVisuals();
        updateSilenceRunningUi();
        logSilenceScreen(msg, 'error');
        window.bdsModal.alert(msg);
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
