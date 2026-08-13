// Constantes de Status (Centralizadas para evitar typos)
const STATUS_WAITING = 'Aguardando';
const STATUS_CONVERTING = 'Convertendo';
const STATUS_DONE = 'Concluído';

let converterList = [];
let thumbsDir = '';
let exportConverterState = {
  active: false,
  completed: false,
  current: 0,
  total: 0,
  percent: 0
};
let ipcListenersInitialized = false; // Previne duplicação de listeners em recargas de tela

// Função para escapar HTML e prevenir XSS/quebra de atributos
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function logConverterScreen(msg, type = 'info') {
  if (type === 'error') {
    const banner = document.getElementById('converterDebugBanner');
    const output = document.getElementById('converterLogOutput');
    if (banner) {
      banner.classList.add('active');
      banner.classList.remove('hidden');
    }
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

  // Define pasta de destino padrão se o campo estiver vazio
  const outFolderInput = document.getElementById('outConverterFolder');
  if (outFolderInput && !outFolderInput.value) {
    if (window.bds && window.bds.getDefaultOutputDir) {
      try {
        const defaultDir = await window.bds.getDefaultOutputDir();
        if (defaultDir) outFolderInput.value = defaultDir;
      } catch (e) {
        // Ignora erro silenciosamente se não houver fallback
      }
    }
  }

  converterList = [];

  renderConverterTable();
  bindConverterEvents();
  updateConverterStepperVisuals();
  setupConverterIPCListeners();
}

// Função auxiliar para atualizar os badges do Stepper (DRY - Don't Repeat Yourself)
function setStepBadge(badgeEl, subEl, titleEl, { isDone, isActive, text, subtitle, titleText }) {
  if (!badgeEl) return;
  
  if (isDone) {
    badgeEl.classList.add('step-badge-done');
    badgeEl.classList.remove('step-badge-active', 'step-badge-pending');
    badgeEl.textContent = '✓';
    if (subEl) {
      subEl.classList.add('step-text-done');
      subEl.classList.remove('step-text-pending');
    }
    if (titleEl) {
      titleEl.classList.add('step-text-done');
      titleEl.classList.remove('step-text-pending');
    }
  } else if (isActive) {
    badgeEl.classList.add('step-badge-active');
    badgeEl.classList.remove('step-badge-done', 'step-badge-pending');
    badgeEl.textContent = '⏳';
    if (subEl) {
      subEl.classList.add('step-text-done');
      subEl.classList.remove('step-text-pending');
    }
    if (titleEl) {
      titleEl.classList.add('step-text-done');
      titleEl.classList.remove('step-text-pending');
    }
  } else {
    badgeEl.classList.add('step-badge-pending');
    badgeEl.classList.remove('step-badge-done', 'step-badge-active');
    if (subEl) {
      subEl.classList.add('step-text-pending');
      subEl.classList.remove('step-text-done');
    }
    if (titleEl) {
      titleEl.classList.add('step-text-pending');
      titleEl.classList.remove('step-text-done');
    }
  }
  
  if (subEl && subtitle) subEl.textContent = subtitle;
  if (titleEl && titleText) titleEl.textContent = titleText;
}

function updateConverterStepperVisuals() {
  // PASSO 1: FILA DE ARQUIVOS
  const b1 = document.getElementById('step1BadgeConverter');
  const s1 = document.getElementById('step1SubConverter');
  
  if (b1 && s1) {
    if (converterList.length > 0) {
      setStepBadge(b1, s1, null, {
        isDone: true,
        isActive: false,
        subtitle: `${converterList.length} arquivo(s) na fila`
      });
    } else {
      setStepBadge(b1, s1, null, {
        isDone: false,
        isActive: false,
        subtitle: 'Adicione as mídias'
      });
      b1.textContent = '1'; // Número do passo quando pendente
    }
  }

  // PASSO 2: FORMATO & CODEC
  const b2 = document.getElementById('step2BadgeConverter');
  const s2 = document.getElementById('step2SubConverter');
  const outFormat = document.getElementById('selConverterOutFormat')?.value?.toUpperCase() || 'MP4';
  const resolution = document.getElementById('selConverterResolution')?.value || 'original';

  if (b2 && s2) {
    setStepBadge(b2, s2, null, {
      isDone: true,
      isActive: false,
      subtitle: `Formato: ${outFormat} (${resolution})`
    });
  }

  // PASSO 3: CONVERTER & EXPORTAR
  const b3 = document.getElementById('step3BadgeConverter');
  const t3 = document.getElementById('step3TitleConverter');
  const s3 = document.getElementById('step3SubConverter');

  if (b3 && t3 && s3) {
    if (exportConverterState.completed) {
      setStepBadge(b3, s3, t3, {
        isDone: true,
        isActive: false,
        titleText: 'CONCLUÍDO!',
        subtitle: 'Todos os arquivos foram convertidos!'
      });
    } else if (exportConverterState.active) {
      setStepBadge(b3, s3, t3, {
        isDone: false,
        isActive: true,
        titleText: `CONVERTENDO (${exportConverterState.current}/${exportConverterState.total})`,
        subtitle: `Progresso: ${Math.round(exportConverterState.percent)}%`
      });
    } else {
      setStepBadge(b3, s3, t3, {
        isDone: false,
        isActive: false,
        titleText: 'CONVERTER & EXPORTAR',
        subtitle: 'Inicie a conversão em lote'
      });
      b3.textContent = '3'; // Número do passo quando pendente
    }
  }
}

function renderConverterTable() {
  const tbody = document.getElementById('converterMainBody');
  const countEl = document.getElementById('converterMainCount');
  const totalDurEl = document.getElementById('converterTotalDuration');

  if (countEl) countEl.textContent = converterList.length;

  let totalSec = 0;
  let hasValidDuration = false;
  converterList.forEach(item => {
    if (item.durationSeconds > 0) {
      totalSec += item.durationSeconds;
      hasValidDuration = true;
    }
  });
  if (totalDurEl) {
    totalDurEl.textContent = hasValidDuration ? formatSecondsToHHMMSS(totalSec) : '—';
  }

  if (!tbody) return;

  if (converterList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="converter-empty-state">
          <div class="converter-empty-content">
            <span class="material-symbols-rounded converter-empty-icon">sync</span>
            <strong>Fila de conversão vazia</strong>
            <span>Clique em "+ Adicionar", "Biblioteca" ou "Pasta" para incluir vídeos ou áudios.</span>
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
    const statusText = item.status || STATUS_WAITING;
    const isDone = item.status === STATUS_DONE || pct >= 100;
    const isConverting = item.status === STATUS_CONVERTING;
    
    // Correção: Classes CSS dinâmicas para cores diferentes de status
    const barColorClass = isDone ? 'converter-progress-fill-done' : (isConverting ? 'converter-progress-fill-active' : 'converter-progress-fill-pending');
    const statusColorClass = isDone ? 'converter-status-done' : (isConverting ? 'converter-status-active' : 'converter-status-pending');

    const safeName = escapeHtml(item.name);
    const safeThumb = escapeHtml(item.thumbnail);
    
    // Correção: Duração fake -> Mostra "—" se não houver duração real
    const durationDisplay = (item.durationSeconds && item.durationSeconds > 0) 
      ? formatSecondsToHHMMSS(item.durationSeconds) 
      : '—';

    const thumbHtml = isAudio 
      ? `<div class="converter-thumb-audio">ÁUDIO</div>`
      : `<div class="converter-thumb-video">
          <img src="${safeThumb}" class="converter-thumb-img" onError="this.style.display='none'" />
          <span class="material-symbols-rounded converter-thumb-fallback">movie</span>
         </div>`;

    return `
      <tr class="converter-table-row">
        <td class="converter-table-cell converter-cell-index">${index + 1}</td>
        
        <td class="converter-table-cell">
          <div class="converter-file-info">
            ${thumbHtml}
            <div class="converter-file-details">
              <div class="converter-file-name" title="${safeName}">${safeName}</div>
              <div class="converter-file-duration">Duração: ${durationDisplay}</div>
            </div>
          </div>
        </td>

        <td class="converter-table-cell converter-cell-ext">${ext}</td>
        <td class="converter-table-cell converter-cell-out-format">${outFormatVal}</td>

        <td class="converter-table-cell">
          <div class="converter-progress-container">
            <div class="converter-progress-header">
              <span class="${statusColorClass}">${statusText}</span>
              <span class="converter-progress-pct">${pct}%</span>
            </div>
            <div class="converter-progress-bar">
              <div class="converter-progress-fill ${barColorClass}" style="width: ${pct}%;"></div>
            </div>
          </div>
        </td>

        <td class="converter-table-cell converter-cell-actions">
          <button class="btn-remove-converter-item" data-index="${index}" title="Remover item" type="button">
            <span class="material-symbols-rounded">delete</span>
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
    const resContainer = document.getElementById('converterResolutionContainer');
    const qualContainer = document.getElementById('converterVideoQualityContainer');
    const presetContainer = document.getElementById('converterPresetContainer');

    const isMp3 = e.target.value === 'mp3';
    [codecContainer, resContainer, qualContainer, presetContainer].forEach(el => {
      if (el) {
        if (isMp3) el.classList.add('hidden');
        else el.classList.remove('hidden');
      }
    });

    renderConverterTable();
    updateConverterStepperVisuals();
  });


  document.getElementById('selConverterResolution')?.addEventListener('change', () => {
    updateConverterStepperVisuals();
  });

  // Correção: Implementar ordenação da fila
  document.getElementById('selConverterSortOrder')?.addEventListener('change', (e) => {
    const sortOrder = e.target.value;
    if (sortOrder === 'default') {
      // Não faz nada, mantém a ordem original de importação
    } else if (sortOrder === 'name_asc') {
      converterList.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortOrder === 'duration_desc') {
      converterList.sort((a, b) => (b.durationSeconds || 0) - (a.durationSeconds || 0));
    }
    renderConverterTable();
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
                  let dur = 0;
                  let thumbUrl = './assets/podcast_thumb.jpg';

                  if (window.bds.extractMetadataThumb) {
                    try {
                      const tPath = await window.bds.extractMetadataThumb(fp);
                      if (tPath) {
                        thumbUrl = 'file:///' + tPath.replace(/\\/g, '/');
                      }
                    } catch (e) {
                      logConverterScreen(`Erro ao extrair metadados/thumbnail de ${name}: ${e.message}`, 'warn');
                    }
                  }

                  converterList.push({
                    id: String(backendItem.id),
                    name: name,
                    path: fp,
                    thumbnail: thumbUrl,
                    durationSeconds: dur,
                    progress: backendItem.progress || 0,
                    status: backendItem.status || STATUS_WAITING
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

  // 1.2 Adicionar Arquivos de uma Pasta inteira (Botão PASTA)
  const btnAddFolder = document.getElementById('btnAddConverterFolder');
  if (btnAddFolder) {
    btnAddFolder.addEventListener('click', async () => {
      if (window.bds && window.bds.selectFolder && window.bds.getLibraryFolderFiles) {
        try {
          const folder = await window.bds.selectFolder('');
          if (!folder) return;

          const files = await window.bds.getLibraryFolderFiles(folder);
          if (!files || files.length === 0) {
            if (window.bdsModal && window.bdsModal.alert) {
              window.bdsModal.alert(`Nenhum arquivo de mídia suportado encontrado na pasta:\n${folder}`);
            }
            return;
          }

          if (window.bds.converterAddFiles) {
            const res = await window.bds.converterAddFiles(files);
            if (res && res.items) {
              for (const backendItem of res.items) {
                const fp = backendItem.file;
                const name = fp.split(/[\\/]/).pop();
                converterList.push({
                  id: String(backendItem.id),
                  name: name,
                  path: fp,
                  thumbnail: './assets/podcast_thumb.jpg',
                  durationSeconds: 0,
                  progress: backendItem.progress || 0,
                  status: backendItem.status || STATUS_WAITING
                });
              }
            }
          }
          renderConverterTable();
          updateConverterStepperVisuals();
        } catch (err) {
          logConverterScreen(`Erro ao adicionar arquivos da pasta: ${err.message}`, 'error');
        }
      }
    });
  }

  // 2. Modal da Biblioteca (Dinâmico)
  const modal = document.getElementById('converterLibraryModal');
  const btnLib = document.getElementById('btnImportConverterFromLibrary');
  const btnClose = document.getElementById('btnCloseConverterLibModal');

  if (btnLib && modal) {
    btnLib.addEventListener('click', async () => {
      modal.classList.remove('hidden');
      modal.classList.add('active');

      const modalList = document.getElementById('converterLibModalList');
      if (!modalList) return;

      modalList.innerHTML = `<div style="padding: 16px; text-align: center; color: var(--muted);">Carregando bibliotecas...</div>`;

      try {
        let libraries = [];
        if (window.bds && window.bds.getAllLibraries) {
          libraries = await window.bds.getAllLibraries();
        }

        let optionsHtml = '';

        if (libraries.length > 0) {
          libraries.forEach(lib => {
            const safeName = escapeHtml(lib.name);
            const safePath = escapeHtml(lib.path || 'Sem caminho definido');
            const safeType = escapeHtml(lib.type || lib.name);
            
            let icon = 'folder_special';
            if (lib.type === 'OBS' || lib.type === 'OBS Studio') icon = 'videocam';
            else if (lib.type === 'SHADOWPLAY' || lib.type === 'NVIDIA ShadowPlay') icon = 'sports_esports';
            else if (lib.type === 'BDSM_DEVICE' || lib.type === 'BDSM Devices') icon = 'smartphone';

            optionsHtml += `
              <button class="converter-lib-option" data-lib-type="${safeType}" data-lib-path="${safePath}" type="button">
                <div class="converter-lib-option-text">
                  <span class="material-symbols-rounded converter-lib-icon">${icon}</span>
                  <div style="display: flex; flex-direction: column; align-items: flex-start; text-align: left;">
                    <span style="font-weight: 700;">${safeName}</span>
                    <span style="font-size: 11px; color: var(--muted);">${safePath}</span>
                  </div>
                </div>
                <span class="material-symbols-rounded">chevron_right</span>
              </button>
            `;
          });
        }

        // Opções Globais Adicionais
        optionsHtml += `
          <button class="converter-lib-option" data-lib-type="ALL" type="button">
            <div class="converter-lib-option-text">
              <span class="material-symbols-rounded converter-lib-icon icon-all">video_library</span>
              <div style="display: flex; flex-direction: column; align-items: flex-start; text-align: left;">
                <span style="font-weight: 700;">Todas as Mídias da Biblioteca</span>
                <span style="font-size: 11px; color: var(--muted);">Carrega mídias cadastradas de todas as fontes</span>
              </div>
            </div>
            <span class="material-symbols-rounded">chevron_right</span>
          </button>
          
          <button class="converter-lib-option" data-action="BROWSE_SUBFOLDER" type="button" style="border-style: dashed;">
            <div class="converter-lib-option-text">
              <span class="material-symbols-rounded converter-lib-icon">folder_open</span>
              <div style="display: flex; flex-direction: column; align-items: flex-start; text-align: left;">
                <span style="font-weight: 700;">Selecionar subpasta de biblioteca...</span>
                <span style="font-size: 11px; color: var(--muted);">Escolha uma pasta específica no computador</span>
              </div>
            </div>
            <span class="material-symbols-rounded">folder</span>
          </button>
        `;

        modalList.innerHTML = optionsHtml;

        // Bind dos eventos de clique nas opções dinâmicas
        modalList.querySelectorAll('.converter-lib-option').forEach(optionBtn => {
          optionBtn.addEventListener('click', async () => {
            modal.classList.remove('active');
            modal.classList.add('hidden');

            const action = optionBtn.getAttribute('data-action');
            const libType = optionBtn.getAttribute('data-lib-type');
            const libPath = optionBtn.getAttribute('data-lib-path');

            if (action === 'BROWSE_SUBFOLDER') {
              // Selecionar subpasta local
              if (window.bds && window.bds.selectFolder && window.bds.getLibraryFolderFiles) {
                const folder = await window.bds.selectFolder('');
                if (folder) {
                  const files = await window.bds.getLibraryFolderFiles(folder);
                  if (files && files.length > 0 && window.bds.converterAddFiles) {
                    const res = await window.bds.converterAddFiles(files);
                    if (res && res.items) {
                      res.items.forEach(backendItem => {
                        const fp = backendItem.file;
                        const name = fp.split(/[\\/]/).pop();
                        converterList.push({
                          id: String(backendItem.id),
                          name: name,
                          path: fp,
                          thumbnail: './assets/podcast_thumb.jpg',
                          durationSeconds: 0,
                          progress: backendItem.progress || 0,
                          status: backendItem.status || STATUS_WAITING
                        });
                      });
                    }
                    renderConverterTable();
                    updateConverterStepperVisuals();
                  } else {
                    if (window.bdsModal && window.bdsModal.alert) {
                      window.bdsModal.alert(`Nenhum arquivo de mídia encontrado em:\n${folder}`);
                    }
                  }
                }
              }
              return;
            }

            // Importar por tipo / busca na biblioteca ou por pasta da biblioteca
            if (window.bds && window.bds.searchLibrary) {
              try {
                let items = [];
                if (libType === 'ALL') {
                  items = await window.bds.searchLibrary({ limit: 100 });
                } else if (libType) {
                  items = await window.bds.searchLibrary({ origins: [libType], limit: 100 });
                }

                // Se a busca por origin não retornou e temos um libPath válido, varremos a pasta da biblioteca
                if ((!items || items.length === 0) && libPath && window.bds.getLibraryFolderFiles) {
                  const folderFiles = await window.bds.getLibraryFolderFiles(libPath);
                  if (folderFiles && folderFiles.length > 0 && window.bds.converterAddFiles) {
                    const res = await window.bds.converterAddFiles(folderFiles);
                    if (res && res.items) {
                      res.items.forEach(backendItem => {
                        const fp = backendItem.file;
                        const name = fp.split(/[\\/]/).pop();
                        if (!converterList.some(v => v.path === fp)) {
                          converterList.push({
                            id: String(backendItem.id),
                            name: name,
                            path: fp,
                            thumbnail: './assets/podcast_thumb.jpg',
                            durationSeconds: 0,
                            progress: backendItem.progress || 0,
                            status: backendItem.status || STATUS_WAITING
                          });
                        }
                      });
                    }
                    renderConverterTable();
                    updateConverterStepperVisuals();
                    return;
                  }
                }

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
                        converterList.push({
                          id: String(backendItem.id),
                          name: itemInfo ? itemInfo.filename : fp.split(/[\\/]/).pop(),
                          path: fp,
                          thumbnail: itemInfo && itemInfo.thumbnail ? `${thumbsDir}/${itemInfo.thumbnail}` : './assets/podcast_thumb.jpg',
                          durationSeconds: itemInfo ? (itemInfo.duration || 0) : 0,
                          progress: backendItem.progress || 0,
                          status: backendItem.status || STATUS_WAITING
                        });
                      });
                    }
                  }

                  renderConverterTable();
                  updateConverterStepperVisuals();
                } else {
                  if (window.bdsModal && window.bdsModal.alert) {
                    window.bdsModal.alert(`Nenhuma mídia encontrada na biblioteca selecionada.`);
                  }
                }
              } catch (e) {
                logConverterScreen(`Erro ao carregar biblioteca: ${e.message}`, 'error');
              }
            }
          });
        });

      } catch (err) {
        logConverterScreen(`Erro ao carregar lista de bibliotecas: ${err.message}`, 'error');
      }
    });
  }

  if (btnClose && modal) {
    btnClose.addEventListener('click', () => {
      modal.classList.remove('active');
      modal.classList.add('hidden');
    });
  }

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
      if (window.bdsModal && window.bdsModal.alert) {
        window.bdsModal.alert('Adicione pelo menos 1 arquivo de mídia para converter.');
      }
      return;
    }

    const format = document.getElementById('selConverterOutFormat').value;
    const codec = document.getElementById('selConverterCodec')?.value || 'libx264';
    const resolution = document.getElementById('selConverterResolution')?.value || 'original';
    const videoQualityRaw = document.getElementById('selConverterVideoQuality')?.value || 'crf-23';
    const preset = document.getElementById('selConverterPreset')?.value || 'medium';
    const audioBitrate = document.getElementById('selConverterAudioBitrate')?.value || '192k';
    const outFolder = document.getElementById('outConverterFolder')?.value || '';

    if (!outFolder) {
      if (window.bdsModal && window.bdsModal.alert) {
        window.bdsModal.alert('Por favor, selecione uma pasta de destino antes de iniciar a conversão.');
      }
      return;
    }

    let videoCrf = null;
    let videoBitrate = null;
    if (videoQualityRaw.startsWith('crf-')) {
      videoCrf = parseInt(videoQualityRaw.replace('crf-', ''), 10);
    } else if (videoQualityRaw.startsWith('bitrate-')) {
      videoBitrate = videoQualityRaw.replace('bitrate-', '');
    }

    const config = {
      format,
      videoCodec: codec,
      videoResolution: resolution === 'original' ? null : parseInt(resolution, 10),
      videoCrf,
      videoBitrate,
      preset,
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


  // Fechar Banner de Debug
  document.getElementById('btnCloseDebugBanner')?.addEventListener('click', () => {
    const banner = document.getElementById('converterDebugBanner');
    if (banner) {
      banner.classList.add('hidden');
      banner.classList.remove('active');
    }
  });
}

function setupConverterIPCListeners() {
  // Previne duplicação de listeners em recargas de tela
  if (ipcListenersInitialized) return;
  ipcListenersInitialized = true;

  if (window.bds && window.bds.onConverterProgress) {
    window.bds.onConverterProgress((payload) => {
      if (payload && payload.id) {
        const item = converterList.find(i => String(i.id) === String(payload.id));
        if (item) {
          item.progress = payload.progress || 0;
          item.status = payload.status || STATUS_CONVERTING;
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
          found.status = STATUS_CONVERTING;
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
          found.status = STATUS_DONE;
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
        item.status = STATUS_DONE;
        item.progress = 100;
      });
      renderConverterTable();
      updateConverterStepperVisuals();

      const outFolder = document.getElementById('outConverterFolder')?.value || 'Pasta não definida';
      if (window.bdsModal && window.bdsModal.alert) {
        window.bdsModal.alert(`Sucesso! Todos os ${converterList.length} arquivos foram convertidos com sucesso em:\n${outFolder}`);
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