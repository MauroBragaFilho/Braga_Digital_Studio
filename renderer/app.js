// Estado global que as telas podem ler/gravar se necessário
export const state = {
  settings: null,
  metadata: null,
  running: false,
  progressPercent: 0,
  converterQueue: []
};

// Objeto de elementos global do módulo
export let els = {};

export function setAppStatus(text, type = 'success') {
  if (els.stateText) els.stateText.textContent = text;
  if (els.stateDot) {
    els.stateDot.className = 'state-dot';
    if (type) {
      els.stateDot.classList.add(`state-${type}`);
    } else {
      els.stateDot.classList.add('state-success'); // Default
    }
  }
}

function updateDOMReferences() {
  els = {
    urlInput: document.querySelector('#urlInput'),
    metadataButton: document.querySelector('#metadataButton'),
    thumbnail: document.querySelector('#thumbnail'),
    thumbnailPlaceholder: document.querySelector('#thumbnailPlaceholder'),
    mediaTitle: document.querySelector('#mediaTitle'),
    mediaChannel: document.querySelector('#mediaChannel'),
    mediaDuration: document.querySelector('#mediaDuration'),
    mediaType: document.querySelector('#mediaType'),
    resolutionSelect: document.querySelector('#resolutionSelect'),
    mp3Button: document.querySelector('#mp3Button'),
    mp4Button: document.querySelector('#mp4Button'),
    stopButton: document.querySelector('#stopButton'),
    progressPercent: document.querySelector('#progressPercent'),
    progressDetails: document.querySelector('#progressDetails'),
    progressFill: document.querySelector('#progressFill'),
    statusText: document.querySelector('#statusText'),
    stateDot: document.querySelector('#stateDot'),
    stateText: document.querySelector('#stateText'),
    historyBody: document.querySelector('#historyBody'),
    clearHistoryButton: document.querySelector('#clearHistoryButton'),
    mp3FolderInput: document.querySelector('#mp3FolderInput'),
    mp4FolderInput: document.querySelector('#mp4FolderInput'),
    cookiesFileInput: document.querySelector('#cookiesFileInput'),
    checkUpdatesInput: document.querySelector('#checkUpdatesInput'),
    saveSettingsButton: document.querySelector('#saveSettingsButton'),
    mp3FolderButton: document.querySelector('#mp3FolderButton'),
    mp4FolderButton: document.querySelector('#mp4FolderButton'),
    checkUpdatesButton: document.querySelector('#checkUpdatesButton'),
    updatesList: document.querySelector('#updatesList'),
    playlistDialog: document.querySelector('#playlistDialog'),
    playlistName: document.querySelector('#playlistName'),
    playlistCount: document.querySelector('#playlistCount'),
    addFilesButton: document.querySelector('#addFilesButton'),
    startConvertButton: document.querySelector('#startConvertButton'),
    cancelConvertButton: document.querySelector('#cancelConvertButton'),
    converterQueue: document.querySelector('#converterQueue'),
  };
}

// Atalho global para o status que os submódulos podem usar
export function setStatus(text) {
  if (els.statusText) els.statusText.textContent = text;
}

// Função utilitária exportada para higienizar strings contra XSS nos submódulos
export function escapeHtml(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>'"]/g, 
    match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match])
  );
}

// --- FLOATING VIDEO PLAYER ---
window.bdsPlayer = {
  _overlay: null,
  _video: null,
  _title: null,
  _closeBtn: null,
  
  // Custom Controls
  _controlsContainer: null,
  _btnPlayPause: null,
  _currentTimeEl: null,
  _durationEl: null,
  _progressTrack: null,
  _progressFill: null,
  _btnMute: null,
  _volumeSlider: null,
  _btnFullscreen: null,
  _videoContainer: null,
  
  _hideControlsTimeout: null,
  _isScrubbing: false,

  init() {
    this._overlay = document.getElementById('floatingPlayerOverlay');
    this._video = document.getElementById('floatingVideoElement');
    this._title = document.getElementById('floatingPlayerTitle');
    this._closeBtn = document.getElementById('floatingPlayerCloseBtn');
    
    this._controlsContainer = document.getElementById('customVideoControls');
    this._btnPlayPause = document.getElementById('btnPlayPause');
    this._currentTimeEl = document.getElementById('videoCurrentTime');
    this._durationEl = document.getElementById('videoDuration');
    this._progressTrack = document.getElementById('progressTrack');
    this._progressFill = document.getElementById('progressFill');
    this._btnMute = document.getElementById('btnMute');
    this._volumeSlider = document.getElementById('volumeSlider');
    this._btnFullscreen = document.getElementById('btnFullscreen');
    this._videoContainer = document.getElementById('videoContainer');

    this._closeBtn.addEventListener('click', () => this.close());

    // Click outside to close
    this._overlay.addEventListener('click', (e) => {
      if (e.target === this._overlay) {
        this.close();
      }
    });

    // Play/Pause toggle
    this._btnPlayPause.addEventListener('click', () => this.togglePlay());
    this._video.addEventListener('click', () => this.togglePlay());

    // Video Events
    this._video.addEventListener('play', () => {
      this._btnPlayPause.innerHTML = '<span class="material-symbols-rounded" style="font-size: 28px;">pause</span>';
    });
    this._video.addEventListener('pause', () => {
      this._btnPlayPause.innerHTML = '<span class="material-symbols-rounded" style="font-size: 28px;">play_arrow</span>';
    });
    this._video.addEventListener('loadedmetadata', () => {
      this._durationEl.textContent = this.formatTime(this._video.duration);
    });
    this._video.addEventListener('timeupdate', () => {
      if (!this._isScrubbing) {
        this._currentTimeEl.textContent = this.formatTime(this._video.currentTime);
        const percent = (this._video.currentTime / this._video.duration) * 100;
        this._progressFill.style.width = percent + '%';
      }
    });
    this._video.addEventListener('ended', () => {
      this._btnPlayPause.innerHTML = '<span class="material-symbols-rounded" style="font-size: 28px;">replay</span>';
    });

    // Progress Bar Scrubbing
    const updateProgress = (e) => {
      const rect = this._progressTrack.getBoundingClientRect();
      let pos = (e.clientX - rect.left) / rect.width;
      pos = Math.max(0, Math.min(pos, 1));
      this._progressFill.style.width = (pos * 100) + '%';
      this._currentTimeEl.textContent = this.formatTime(pos * this._video.duration);
      return pos;
    };
    
    this._progressTrack.parentElement.addEventListener('mousedown', (e) => {
      this._isScrubbing = true;
      updateProgress(e);
    });
    document.addEventListener('mousemove', (e) => {
      if (this._isScrubbing) updateProgress(e);
    });
    document.addEventListener('mouseup', (e) => {
      if (this._isScrubbing) {
        this._isScrubbing = false;
        const pos = updateProgress(e);
        this._video.currentTime = pos * this._video.duration;
      }
    });

    // Volume
    this._volumeSlider.addEventListener('input', (e) => {
      this._video.volume = e.target.value;
      this._video.muted = e.target.value == 0;
      this.updateVolumeIcon();
    });
    this._btnMute.addEventListener('click', () => {
      this._video.muted = !this._video.muted;
      if (this._video.muted) {
        this._volumeSlider.value = 0;
      } else {
        this._volumeSlider.value = this._video.volume || 1;
      }
      this.updateVolumeIcon();
    });

    // Fullscreen
    this._btnFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        this._videoContainer.requestFullscreen().catch(err => {
          console.error("Error attempting to enable fullscreen:", err);
        });
      } else {
        document.exitFullscreen();
      }
    });
    
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        this._btnFullscreen.innerHTML = '<span class="material-symbols-rounded" style="font-size: 20px;">fullscreen_exit</span>';
      } else {
        this._btnFullscreen.innerHTML = '<span class="material-symbols-rounded" style="font-size: 20px;">fullscreen</span>';
      }
    });

    // Hide controls on idle
    const resetIdleTimer = () => {
      this._controlsContainer.style.opacity = '1';
      this._videoContainer.style.cursor = 'default';
      clearTimeout(this._hideControlsTimeout);
      this._hideControlsTimeout = setTimeout(() => {
        if (!this._video.paused) {
          this._controlsContainer.style.opacity = '0';
          this._videoContainer.style.cursor = 'none';
        }
      }, 2500);
    };

    this._videoContainer.addEventListener('mousemove', resetIdleTimer);
    this._videoContainer.addEventListener('mouseleave', () => {
      if (!this._video.paused) {
        this._controlsContainer.style.opacity = '0';
      }
    });
  },

  formatTime(seconds) {
    if (isNaN(seconds)) return "00:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  },

  updateVolumeIcon() {
    if (this._video.muted || this._video.volume === 0) {
      this._btnMute.innerHTML = '<span class="material-symbols-rounded" style="font-size: 20px;">volume_off</span>';
    } else if (this._video.volume < 0.5) {
      this._btnMute.innerHTML = '<span class="material-symbols-rounded" style="font-size: 20px;">volume_down</span>';
    } else {
      this._btnMute.innerHTML = '<span class="material-symbols-rounded" style="font-size: 20px;">volume_up</span>';
    }
  },

  togglePlay() {
    if (this._video.paused || this._video.ended) {
      this._video.play();
    } else {
      this._video.pause();
    }
  },

  play(filePath, title = 'Vídeo') {
    if (!this._overlay) this.init();
    
    const srcUrl = `file:///${filePath.replace(/\\/g, '/')}`;
    this._title.textContent = title;
    
    const isPhoto = filePath.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/i);
    const imgEl = document.getElementById('floatingImageElement');
    
    if (isPhoto) {
      this._video.style.display = 'none';
      this._controlsContainer.style.display = 'none';
      if (imgEl) {
        imgEl.style.display = 'block';
        imgEl.src = srcUrl;
      }
    } else {
      this._video.style.display = 'block';
      this._controlsContainer.style.display = 'flex';
      if (imgEl) {
        imgEl.style.display = 'none';
        imgEl.src = '';
      }
      this._video.src = srcUrl;
      this._video.play().catch(e => console.error("Error playing video:", e));
    }
    
    this._overlay.style.display = 'flex';
  },

  close() {
    if (this._video) {
      this._video.pause();
      this._video.src = '';
    }
    const imgEl = document.getElementById('floatingImageElement');
    if (imgEl) {
      imgEl.src = '';
    }
    if (this._overlay) {
      this._overlay.style.display = 'none';
    }
    if (document.fullscreenElement) {
      document.exitFullscreen();
    }
  }
};

// --- MODAL GLOBAL BDS ---
window.bdsModal = {
  _modal: null,
  _title: null,
  _message: null,
  _btnCancel: null,
  _btnConfirm: null,
  _icon: null,
  _input: null,

  init() {
    this._modal = document.getElementById('bdsGlobalModal');
    this._title = document.getElementById('bdsModalTitle');
    this._message = document.getElementById('bdsModalMessage');
    this._btnCancel = document.getElementById('bdsModalBtnCancel');
    this._btnConfirm = document.getElementById('bdsModalBtnConfirm');
    this._icon = document.getElementById('bdsModalIcon');
    this._input = document.getElementById('bdsModalInput');
  },

  show({ title, message, isConfirm = false, isPrompt = false, defaultText = '' }) {
    return new Promise((resolve) => {
      if (!this._modal) this.init();

      this._title.textContent = title;
      this._message.innerHTML = String(message).replace(/\n/g, '<br/>');
      
      this._icon.textContent = (isConfirm || isPrompt) ? 'help' : 'info';
      this._icon.style.color = (isConfirm || isPrompt) ? '#ffb300' : 'var(--accent)'; // Yellow for confirm, Red for info
      
      if (isConfirm || isPrompt) {
        this._btnCancel.style.display = 'inline-block';
        this._btnConfirm.textContent = 'Confirmar';
      } else {
        this._btnCancel.style.display = 'none';
        this._btnConfirm.textContent = 'OK';
      }

      if (isPrompt && this._input) {
        this._input.style.display = 'block';
        this._input.value = defaultText;
        setTimeout(() => this._input.focus(), 100);
      } else if (this._input) {
        this._input.style.display = 'none';
      }

      const cleanup = () => {
        this._btnConfirm.removeEventListener('click', onConfirm);
        this._btnCancel.removeEventListener('click', onCancel);
        if (this._input) this._input.removeEventListener('keydown', onKeyDown);
        this._modal.close();
      };

      const onConfirm = () => { cleanup(); resolve(isPrompt ? (this._input ? this._input.value : null) : true); };
      const onCancel = () => { cleanup(); resolve(isPrompt ? null : false); };
      const onKeyDown = (e) => {
        if (e.key === 'Enter') onConfirm();
        if (e.key === 'Escape') onCancel();
      };

      this._btnConfirm.addEventListener('click', onConfirm);
      this._btnCancel.addEventListener('click', onCancel);
      if (isPrompt && this._input) {
        this._input.addEventListener('keydown', onKeyDown);
      }

      this._modal.showModal();
    });
  },

  alert(msg) {
    return this.show({ title: 'Aviso', message: msg, isConfirm: false });
  },

  confirm(msg) {
    return this.show({ title: 'Confirmação', message: msg, isConfirm: true });
  },
  
  prompt(msg, defaultText = '') {
    return this.show({ title: 'Entrada Necessária', message: msg, isPrompt: true, defaultText });
  }
};
// ------------------------

document.addEventListener('DOMContentLoaded', () => {
  const contentContainer = document.getElementById('dynamic-content');
  const tabButtons = document.querySelectorAll('.tab-button');

  // Storage Polling
  const storageIndicators = document.getElementById('storageIndicators');
  if (storageIndicators) {
    storageIndicators.innerHTML = '<span style="color:yellow">Iniciando monitoramento...</span>';
    storageIndicators.style.display = 'flex';

    if (!window.bds || !window.bds.getStorageInfo) {
      storageIndicators.innerHTML = '<span style="color:red">IPC getStorageInfo não encontrado. Você reiniciou o app?</span>';
      storageIndicators.style.display = 'flex';
    } else {
      const updateStorage = async () => {
        try {
          const info = await window.bds.getStorageInfo();
          if (!info) {
            storageIndicators.innerHTML = '<span style="color:red">Erro ao ler armazenamento. (Retornou null)</span>';
            storageIndicators.style.display = 'flex';
            return;
          }
          
          let html = '';
          
          // PC Storage
          if (info.pc) {
            const isCritical = info.pc.percent >= 90;
            html += `
              <div class="storage-indicator">
                <div class="storage-header">
                  <span class="storage-name">Computador</span>
                  <span class="storage-percent">${info.pc.percent}% ocupado</span>
                </div>
                <div class="storage-bar">
                  <div class="storage-fill ${isCritical ? 'critical' : ''}" style="width: ${info.pc.percent}%"></div>
                </div>
                <div class="storage-footer">
                  <span>${info.pc.free} livres</span>
                  <span>${info.pc.total}</span>
                </div>
              </div>
            `;
          }

          // Device Storage (if connected)
          if (info.device) {
            const isCritical = info.device.percent >= 90;
            html += `
              <div class="storage-indicator">
                <div class="storage-header">
                  <span class="storage-name">${info.device.name || "MTP Device"}</span>
                  <span class="storage-percent">${info.device.percent}% ocupado</span>
                </div>
                <div class="storage-bar">
                  <div class="storage-fill ${isCritical ? 'critical' : ''}" style="width: ${info.device.percent}%"></div>
                </div>
                <div class="storage-footer">
                  <span>${info.device.free} livres</span>
                  <span>${info.device.total}</span>
                </div>
              </div>
            `;
          }
          
          storageIndicators.innerHTML = html;
          storageIndicators.style.display = 'flex';
        } catch(e) {
          storageIndicators.innerHTML = `<span style="color:red">Erro IPC: ${e.message}</span>`;
          storageIndicators.style.display = 'flex';
        }
      };
      
      updateStorage();
      setInterval(updateStorage, 10000);
    }
  }

  async function loadScreen(screenName) {
    try {
      // 1. Carrega o HTML da tela solicitada
      const response = await fetch(`./screens/${screenName}.html`);
      if (!response.ok) throw new Error(`Não foi possível carregar a tela: ${screenName}`);
      const htmlContent = await response.text();
      
      contentContainer.innerHTML = '';
      const viewSection = document.createElement('section');
      viewSection.id = `${screenName}View`;
      viewSection.className = 'view active'; 
      viewSection.innerHTML = htmlContent;
      contentContainer.appendChild(viewSection);

      // 2. Atualiza referências do DOM para a nova tela ativa
      updateDOMReferences();

      // 3. Importa dinamicamente o arquivo JS da tela correspondente (se existir)
      try {
        const screenModule = await import(`./screens/${screenName}.js`);
        if (screenModule.initScreen) {
          screenModule.initScreen();
        }
      } catch (jsError) {
        console.log(`A tela ${screenName} não possui um arquivo JS dedicado ou ele falhou.`, jsError);
        if (screenName === 'home') {
          contentContainer.innerHTML = `<p style="padding: 20px; color: red;">Erro de import: ${jsError.message} <br/> ${jsError.stack}</p>`;
        }
      }

    } catch (error) {
      console.error('Erro ao modularizar a tela:', error);
      contentContainer.innerHTML = `<p style="padding: 20px; color: red;">Erro ao carregar a página.</p>`;
    }
  }

  // Configuração dos cliques de navegação da Sidebar
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      tabButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      
      const screenName = button.getAttribute('data-view');
      
      // Remove o texto do ícone para extrair apenas o nome da página
      const clone = button.cloneNode(true);
      const span = clone.querySelector('span');
      if (span) span.remove();
      const screenTitle = clone.textContent.trim();
      
      // Atualiza o título global no topo do app
      const globalTitleEl = document.getElementById('globalPageTitle');
      if (globalTitleEl) {
        globalTitleEl.textContent = screenTitle;
      }
      
      // Controla a exibição do contador global de mídias
      const globalMediaCount = document.getElementById('globalMediaCount');
      if (globalMediaCount) {
        globalMediaCount.style.display = screenName === 'library' ? 'block' : 'none';
        if (screenName !== 'library') globalMediaCount.textContent = '0 mídias encontradas';
      }

      // Limpa a busca global ao trocar de tela
      const globalSearch = document.getElementById('globalSearch');
      if (globalSearch) globalSearch.value = '';

      loadScreen(screenName);
    });
  });

  // Controles da janela (Frameless)
  document.getElementById('win-min')?.addEventListener('click', () => window.bds.minimizeWindow());
  document.getElementById('win-max')?.addEventListener('click', () => window.bds.maximizeWindow());
  document.getElementById('win-close')?.addEventListener('click', () => window.bds.closeWindow());

  // Barra de Pesquisa Global Interativa em Tempo Real
  const globalSearchInput = document.getElementById('globalSearch');
  if (globalSearchInput) {
    let searchDebounce = null;
    globalSearchInput.addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        const query = e.target.value.trim();
        const activeTab = document.querySelector('.sidebar .tab-button.active');
        const activeScreen = activeTab ? activeTab.getAttribute('data-view') : 'home';

        if (query.length > 0 && activeScreen !== 'library') {
          const libTabBtn = document.querySelector('.sidebar .tab-button[data-view="library"]');
          if (libTabBtn) libTabBtn.click();
        } else if (activeScreen === 'library') {
          import('./screens/library.js').then(m => {
            if (typeof m.fetchMedia === 'function') m.fetchMedia();
          }).catch(() => {});
        }
      }, 250);
    });
  }

  // Atalho global de pesquisa (Ctrl+K)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      document.getElementById('globalSearch')?.focus();
    }
  });

  // Botão de configurações global
  document.getElementById('globalSettingsBtn')?.addEventListener('click', () => {
    const tabButton = document.querySelector('.sidebar .tab-button[data-view="settings"]');
    if (tabButton) tabButton.click();
  });

  // Inicializa escutas globais do Electron (IPC)
  initGlobalElectronListeners();
  
  // Carrega a tela inicial por padrão
  loadScreen('home');
});

/**
 * Escutas globais do processo principal (IPC) centralizadas.
 * Repassam os dados em tempo real para os módulos das telas se estiverem ativos/carregados.
 */
async function initGlobalElectronListeners() {
  // Carrega as configurações assim que o app inicia
  state.settings = await window.bds.getSettings();

  // Ouvinte de progresso do Download
  window.bds.onProgress((payload) => {
    state.running = payload.running;
    if (typeof payload.percent === 'number') {
      state.progressPercent = Math.max(0, Math.min(100, payload.percent));
    }
    
    // Repassa os dados para a tela de download atualizar os componentes visuais
    import('./screens/download.js')
      .then(m => m.updateProgressVisuals?.(payload))
      .catch(() => {});
  });

  // Ouvinte de fim de Download (Sucesso ou Falha)
  window.bds.onFinished((payload) => {
    state.running = false;
    
    // Libera os botões e atualiza o estado na tela de download
    import('./screens/download.js').then(m => {
      m.setControlsEnabled?.(true);
      m.updateProgressVisuals?.({ 
        percent: payload.status === 'sucesso' ? 100 : state.progressPercent, 
        status: payload.message || 'Finalizado.' 
      });
    }).catch(() => {});
    
    // Atualiza a tabela dinamicamente se a tela de biblioteca estiver aberta
    import('./screens/library.js')
      .then(m => m.fetchMedia?.())
      .catch(() => {});
  });

// ===== INÍCIO: LISTENERS DO CONVERSOR =====
// Listener para atualizar a fila inteira (quando arquivos são adicionados ou removidos)
window.bds?.on('converter:queue', (queue) => {
  console.log('Evento recebido: converter:queue', queue);
  state.converterQueue = queue;
  // Chama a função de renderização do converter.js
  if (typeof renderConverterQueue === 'function') {
    renderConverterQueue();
  }
});

// Listener para atualizar o progresso de um arquivo específico
window.bds?.on('converter:progress', (data) => {
  console.log('Evento recebido: converter:progress', data);
  const { index, progress, status } = data;
  
  // Encontra o item na fila e atualiza seu progresso e status
  if (state.converterQueue && state.converterQueue[index]) {
    state.converterQueue[index].progress = progress;
    if (status) {
      state.converterQueue[index].status = status;
    }
    // Re-renderiza a fila para mostrar a mudança
    if (typeof renderConverterQueue === 'function') {
      renderConverterQueue();
    }
  }
});

// Listener para quando a conversão de um arquivo é concluída
window.bds?.on('converter:completed', (data) => {
  console.log('Evento recebido: converter:completed', data);
  const { index, outputPath } = data;
  
  if (state.converterQueue && state.converterQueue[index]) {
    state.converterQueue[index].status = 'completed';
    state.converterQueue[index].progress = 100;
    state.converterQueue[index].outputPath = outputPath;
    // Re-renderiza a fila
    if (typeof renderConverterQueue === 'function') {
      renderConverterQueue();
    }
  }
});

// Listener para quando um arquivo falha na conversão
window.bds?.on('converter:error', (data) => {
  console.log('Evento recebido: converter:error', data);
  const { index, error } = data;
  
  if (state.converterQueue && state.converterQueue[index]) {
    state.converterQueue[index].status = 'failed';
    state.converterQueue[index].error = error;
    // Re-renderiza a fila
    if (typeof renderConverterQueue === 'function') {
      renderConverterQueue();
    }
  }
});

// Listener para quando a fila inteira é limpa
window.bds?.on('converter:queue-cleared', () => {
  console.log('Evento recebido: converter:queue-cleared');
  state.converterQueue = [];
  // Re-renderiza a fila
  if (typeof renderConverterQueue === 'function') {
    renderConverterQueue();
  }
});

  // ===== INÍCIO: UPDATES =====
  // Ouvinte de resposta para checagem de atualizações externas (yt-dlp / FFmpeg)
  window.bds.onUpdatesChecked((result) => {
    import('./screens/updates.js')
      .then(m => m.renderUpdates?.(result))
      .catch(() => {});
  });

  // ===== DEPENDÊNCIAS INICIAIS =====
  window.bds.onDependenciesDownloading(() => {
    const overlay = document.getElementById('initOverlay');
    if (overlay) {
      overlay.style.display = 'flex';
    }
  });

  window.bds.onDependenciesDone(() => {
    const overlay = document.getElementById('initOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
  });
}
