import { mediaPreviewSystem } from './components/preview/MediaPreviewSystem.js';
import { initSliderSync } from './slider-sync.js';

// Expõe openPreview e mediaPreviewSystem globalmente
window.mediaPreviewSystem = mediaPreviewSystem;
window.openPreview = (media, collection = []) => mediaPreviewSystem.open(media, collection);

// Estado global que as telas podem ler/gravar se necessário
export const state = {
  settings: null,
  metadata: null,
  running: false,
  progressPercent: 0,
  converterQueue: [],
  downloadQueue: [],
  pendingUpdateCheck: null // resultado da checagem de updates no startup, consumido pela tela Settings
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

/* ==========================================================================
   SISTEMA DE TEMAS
   ========================================================================== */

/**
 * Converte um hex (#rrggbb) para rgba() com a opacidade fornecida.
 * @param {string} hex
 * @param {number} alpha  — 0 a 1
 */
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Clareia (amount > 0) ou escurece (amount < 0) uma cor hex.
 * Retorna um hex novo.
 * @param {string} hex
 * @param {number} amount  — ex: 15 = +15 em cada canal RGB
 */
function shiftHex(hex, amount) {
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp(parseInt(hex.slice(1, 3), 16) + amount);
  const g = clamp(parseInt(hex.slice(3, 5), 16) + amount);
  const b = clamp(parseInt(hex.slice(5, 7), 16) + amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Injeta as variáveis CSS de cor de destaque no :root.
 * Calcula automaticamente as variantes hover e light.
 * @param {string} hex  — ex: "#e53935"
 */
export function applyAccentColor(hex) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  // No tema escuro o hover clareia; no tema claro o hover escurece
  const hoverHex = isDark ? shiftHex(hex, 20) : shiftHex(hex, -30);
  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-hover', hoverHex);
  root.style.setProperty('--accent-light', hexToRgba(hex, 0.15));
  root.style.setProperty('--danger', hex);
}

/**
 * Aplica o tema ao documento e a cor de destaque.
 * @param {string} theme       — 'dark' | 'light'
 * @param {string} accentColor — hex, ex: "#e53935"
 */
/**
 * Preferências de interface que não são tema/cor: hoje, "reduzir animações".
 * Chamada ao iniciar o app e depois de salvar as Configurações.
 * @param {object} settings
 */
export function applyUiPreferences(settings = {}) {
  document.documentElement.classList.toggle('reduce-motion', settings.reduceMotion === true);
}

export function applyTheme(theme = 'dark', accentColor = '#e53935') {
  document.documentElement.setAttribute('data-theme', theme);
  applyAccentColor(accentColor);
}

/* ==========================================================================
   SIDEBAR COLAPSÁVEL (icon rail)
   ========================================================================== */

/**
 * Extrai o rótulo legível de um botão da sidebar (removendo ícones/spans).
 * @param {HTMLElement} btn — elemento `.tab-button`
 * @returns {string}
 */
function getTabLabel(btn) {
  const clone = btn.cloneNode(true);
  clone.querySelectorAll('span').forEach(s => s.remove());
  return clone.textContent.trim();
}

let _sidebarTooltipTitles = null; // guarda títulos originais (evita sobrescrever títulos manuais)
let _sidebarLabels = null;        // labels gerados automaticamente (para detectar títulos manuais)

/**
 * Labels de tela gerados automaticamente (Home, Downloads, ...).
 * Usado para não sobrescrever títulos manuais com valores derivados.
 * @returns {Set<string>}
 */
function getSidebarTitlesLabels() {
  if (!_sidebarLabels) {
    _sidebarLabels = new Set();
    document.querySelectorAll('.sidebar .tab-button').forEach(b => {
      _sidebarLabels.add(getTabLabel(b));
    });
  }
  return _sidebarLabels;
}

// Abaixo deste valor a sidebar vira barra inferior e deve colapsar automaticamente
const SIDEBAR_NARROW_BREAKPOINT = 980;

function applySidebarCollapsed(collapsed) {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  document.querySelector('.app-shell')?.classList.toggle('collapsed', collapsed);
  sidebar.classList.toggle('collapsed', collapsed);

  const toggleBtn = document.getElementById('sidebarToggleBtn');
  if (toggleBtn) {
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    toggleBtn.title = collapsed ? 'Expandir menu' : 'Recolher menu';
    const icon = toggleBtn.querySelector('.material-symbols-rounded');
    if (icon) icon.textContent = collapsed ? 'menu' : 'menu_open';
  }

  // Tooltip do BDS: indica que pode expandir quando colapsado
  const brand = document.querySelector('.sidebar .brand');
  if (brand) brand.title = collapsed ? 'Expandir menu' : '';

  // Tooltips com o nome da tela quando colapsada (sem perda de títulos manuais)
  document.querySelectorAll('.sidebar .tab-button').forEach(btn => {
    if (!_sidebarTooltipTitles) _sidebarTooltipTitles = new Map();
    if (!_sidebarTooltipTitles.has(btn)) {
      // Primeira vez: captura o título original (vazio ou manual)
      _sidebarTooltipTitles.set(btn, btn.title);
    } else if (collapsed && !getSidebarTitlesLabels().has(btn.title)) {
      // Título manual definido depois da primeira colapsagem: atualiza o registro
      _sidebarTooltipTitles.set(btn, btn.title);
    }
    btn.title = collapsed ? getTabLabel(btn) : (_sidebarTooltipTitles.get(btn) || '');
  });
}

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
      this._icon.style.color = (isConfirm || isPrompt) ? '#ffb300' : 'var(--accent)'; 
      
      if (isConfirm || isPrompt) {
        this._btnCancel.classList.remove('hidden');
        this._btnConfirm.textContent = 'Confirmar';
      } else {
        this._btnCancel.classList.add('hidden');
        this._btnConfirm.textContent = 'OK';
      }

      if (isPrompt && this._input) {
        this._input.classList.remove('hidden');
        this._input.value = defaultText;
        setTimeout(() => this._input.focus(), 100);
      } else if (this._input) {
        this._input.classList.add('hidden');
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
  // Inicializa o componente global de range sliders (sync --slider-value)
  initSliderSync();

  const contentContainer = document.getElementById('dynamic-content');
  const tabButtons = document.querySelectorAll('.tab-button');

  // --- Módulos restritos a builds de desenvolvimento (não aparecem no .exe final) ---
  // Recuperação e Montagem Automática ainda estão em otimização; ficam disponíveis apenas
  // quando o BDS roda a partir do código-fonte (não empacotado). Assume-se "empacotado" por
  // padrão (fail-safe) até a checagem real do processo principal responder.
  const DEV_ONLY_SCREENS = ['recovery', 'montage', 'ai'];
  let isPackagedApp = true;

  function applyDevOnlyVisibility() {
    DEV_ONLY_SCREENS.forEach((screenName) => {
      const btn = document.querySelector(`.tab-button[data-view="${screenName}"]`);
      if (!btn) return;
      if (isPackagedApp) {
        btn.classList.add('hidden');
        btn.style.display = 'none';
      } else {
        btn.classList.remove('hidden');
        btn.style.display = '';
      }
    });
  }

  applyDevOnlyVisibility(); // aplica o estado fail-safe (oculto) imediatamente

  // Blindagem: se por qualquer motivo window.bds.isPackaged não existir ou falhar (ex: preload
  // desatualizado, erro de IPC), isso NUNCA pode travar o restante da inicialização do app —
  // o app inteiro ficaria com nada clicável, já que este trecho roda logo no início do
  // DOMContentLoaded, antes dos listeners de clique serem registrados mais abaixo.
  try {
    if (window.bds && typeof window.bds.isPackaged === 'function') {
      window.bds.isPackaged().then((packaged) => {
        isPackagedApp = Boolean(packaged);
        applyDevOnlyVisibility();
      }).catch((err) => {
        console.error('[APP] Falha ao verificar isPackaged (mantendo módulos dev ocultos):', err);
      });
    } else {
      console.warn('[APP] window.bds.isPackaged indisponível — mantendo módulos dev ocultos (fail-safe).');
    }
  } catch (err) {
    console.error('[APP] Erro inesperado ao checar isPackaged:', err);
  }

  async function loadScreen(screenName) {
    // Defesa extra: mesmo que a aba tenha sido acionada por outro caminho (não pelo clique
    // visível do botão), builds empacotadas nunca carregam os módulos restritos.
    if (DEV_ONLY_SCREENS.includes(screenName) && isPackagedApp) {
      screenName = 'home';
    }

    try {
      // Notifica a tela ativa anterior para limpar listeners/menus temporários
      const prevActive = contentContainer.querySelector('.view.active');
      if (prevActive) {
        const prevName = (prevActive.id || '').replace(/View$/, '');
        if (prevName && prevName !== screenName) {
          try {
            const prevModule = await import(`./screens/${prevName}.js`);
            if (typeof prevModule.onLeave === 'function') prevModule.onLeave();
          } catch (_) {}
        }
      }

      // Oculta todas as views ativas
      const views = contentContainer.querySelectorAll('.view');
      views.forEach(v => {
        v.classList.remove('active');
        v.classList.add('hidden');
      });

      let viewSection = document.getElementById(`${screenName}View`);

      if (!viewSection) {
        // 0. INJEÇÃO DINÂMICA DE CSS MODULAR (Lazy Loading)
        const cssId = `css-modular-${screenName}`;
        if (!document.getElementById(cssId)) {
          try {
            // Verifica se o arquivo CSS existe antes de injetar para evitar erros 404 no console
            const cssCheck = await fetch(`./screens/${screenName}.css`, { method: 'HEAD' });
            if (cssCheck.ok) {
              const link = document.createElement('link');
              link.id = cssId;
              link.rel = 'stylesheet';
              link.href = `./screens/${screenName}.css`;
              document.head.appendChild(link);
            }
          } catch (e) {
            // CSS não existe ou falha de rede, ignora silenciosamente
          }
        }

        // 1. Carrega o HTML da tela solicitada (apenas na primeira vez)
        const response = await fetch(`./screens/${screenName}.html`);
        if (!response.ok) throw new Error(`Não foi possível carregar a tela: ${screenName}`);
        const htmlContent = await response.text();
        
        viewSection = document.createElement('section');
        viewSection.id = `${screenName}View`;
        viewSection.className = 'view active';
        viewSection.innerHTML = htmlContent;
        contentContainer.appendChild(viewSection);

        // 2. Atualiza referências do DOM para a nova tela ativa
        updateDOMReferences();

        // 3. Importa dinamicamente o arquivo JS da tela correspondente e inicializa
        try {
          const screenModule = await import(`./screens/${screenName}.js`);
          if (screenModule.initScreen) {
            screenModule.initScreen();
          }
        } catch (jsError) {
          console.log(`A tela ${screenName} não possui um arquivo JS dedicado ou ele falhou.`, jsError);
          if (screenName === 'home') {
            viewSection.innerHTML = `<p style="padding: 20px; color: red;">Erro de import: ${jsError.message} <br/> ${jsError.stack}</p>`;
          }
        }
      } else {
        // A tela já existe no DOM, apenas reativa
        viewSection.classList.add('active');
        viewSection.classList.remove('hidden');
        updateDOMReferences();
        
        // Em telas dinâmicas como biblioteca, disparar um refresh passivo
        if (screenName === 'library') {
          import('./screens/library.js').then(m => m.fetchMedia && m.fetchMedia()).catch(() => {});
        }
      }

    } catch (error) {
      console.error('Erro ao modularizar a tela:', error);
      contentContainer.innerHTML = `<p style="padding: 20px; color: red;">Erro ao carregar a página.</p>`;
    }
  }

  // Storage Polling
  const storageIndicators = document.getElementById('storageIndicators');
  if (storageIndicators) {
    storageIndicators.innerHTML = '<span style="color:yellow">Iniciando monitoramento...</span>';
    storageIndicators.classList.add('active');

    if (!window.bds || !window.bds.getStorageInfo) {
      storageIndicators.innerHTML = '<span style="color:red">IPC getStorageInfo não encontrado. Você reiniciou o app?</span>';
      storageIndicators.classList.add('active');
    } else {
      const updateStorage = async () => {
        try {
          const info = await window.bds.getStorageInfo();
          if (!info) {
            storageIndicators.innerHTML = '<span style="color:red">Erro ao ler armazenamento. (Retornou null)</span>';
            storageIndicators.classList.add('active');
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

          // Device Storage removed as requested
          
          storageIndicators.innerHTML = html;
          storageIndicators.classList.add('active');
        } catch(e) {
          storageIndicators.innerHTML = `<span style="color:red">Erro IPC: ${e.message}</span>`;
          storageIndicators.classList.add('active');
        }
      };
      
      updateStorage();
      // [PERF] Atualização de storage — pausa quando a aba está oculta
      // e usa intervalo mais longo (30s) pois espaço em disco muda lentamente
      let _storageInterval = setInterval(updateStorage, 30000);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          clearInterval(_storageInterval);
          _storageInterval = null;
        } else if (!_storageInterval) {
          updateStorage();
          _storageInterval = setInterval(updateStorage, 30000);
        }
      });
    }
  }

  // Sidebar colapsável (icon rail) — toggle manual + atalho Ctrl+B + clique no brand
  const toggleSidebarFn = () => {
    const next = !document.querySelector('.sidebar')?.classList.contains('collapsed');
    applySidebarCollapsed(next);
    if (state.settings) state.settings.sidebarCollapsed = next;
    if (window.bds?.saveSettings) {
      window.bds.saveSettings({ sidebarCollapsed: next }).catch(() => {});
    }
  };

  const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', toggleSidebarFn);
    // Atalho Ctrl+B (não interfere ao digitar em campos de texto)
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        toggleSidebarFn();
      }
    });
  }

  // Responsividade: em janelas estreitas/tamanho mínimo a sidebar colapsa
  // automaticamente (trilho de ícones); ao alargar, restaura a preferência salva.
  let _sidebarResizeTimer = null;
  const updateSidebarForWindowSize = () => {
    clearTimeout(_sidebarResizeTimer);
    _sidebarResizeTimer = setTimeout(() => {
      const isNarrow = window.innerWidth <= SIDEBAR_NARROW_BREAKPOINT;
      applySidebarCollapsed(isNarrow ? true : (state.settings?.sidebarCollapsed === true));
    }, 120);
  };
  window.addEventListener('resize', updateSidebarForWindowSize);

  // Clique no BDS (brand) expande a sidebar quando colapsada
  const brandMark = document.querySelector('.sidebar .brand');
  if (brandMark) {
    brandMark.addEventListener('click', (e) => {
      // Ignora cliques originados do botão toggle (evita duplo-toggle por bubbling)
      if (e.target.closest('#sidebarToggleBtn')) return;
      if (document.querySelector('.sidebar')?.classList.contains('collapsed')) {
        toggleSidebarFn();
      }
    });
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
        if (screenName === 'library') {
          globalMediaCount.classList.remove('hidden');
        } else {
          globalMediaCount.classList.add('hidden');
          globalMediaCount.textContent = '0 mídias encontradas';
        }
      }

      // Limpa a busca global ao trocar para outras telas (exceto biblioteca)
      const globalSearch = document.getElementById('globalSearch');
      if (globalSearch && screenName !== 'library') {
        globalSearch.value = '';
        document.getElementById('globalSearchClear')?.classList.add('hidden');
      }

      loadScreen(screenName);
    });
  });


  // Controles da janela (Frameless)
  document.getElementById('win-min')?.addEventListener('click', () => window.bds.minimizeWindow());
  document.getElementById('win-max')?.addEventListener('click', () => window.bds.maximizeWindow());
  document.getElementById('win-full')?.addEventListener('click', () => window.bds.fullscreenWindow());
  document.getElementById('win-close')?.addEventListener('click', () => window.bds.closeWindow());

  // Barra de Pesquisa Global — um único tratamento, via delegação no documento
  // (sobrevive a qualquer troca de tela). A pesquisa sempre acontece na Biblioteca.
  const getSearchInput = () => document.getElementById('globalSearch');
  const syncSearchClear = () => {
    const input = getSearchInput();
    document.getElementById('globalSearchClear')?.classList.toggle('hidden', !input || !input.value);
  };

  const runGlobalSearch = () => {
    const input = getSearchInput();
    if (!input) return;
    const query = input.value.trim();
    const activeTab = document.querySelector('.sidebar .tab-button.active');
    const activeScreen = activeTab ? activeTab.getAttribute('data-view') : 'home';

    if (activeScreen !== 'library') {
      // A Biblioteca lê o texto do campo ao inicializar, então basta abri-la.
      if (!query) return;
      document.querySelector('.sidebar .tab-button[data-view="library"]')?.click();
    } else {
      import('./screens/library.js')
        .then(m => { if (typeof m.applyGlobalSearch === 'function') m.applyGlobalSearch(query); })
        .catch(() => {});
    }
  };

  const focusGlobalSearch = () => {
    const input = getSearchInput();
    if (!input) return;
    input.focus();
    input.select();
  };
  window.focusGlobalSearch = focusGlobalSearch;

  const clearGlobalSearch = () => {
    const input = getSearchInput();
    if (!input) return;
    const hadText = !!input.value;
    input.value = '';
    syncSearchClear();
    if (hadText) runGlobalSearch();
    input.focus();
  };

  let searchDebounce = null;
  document.addEventListener('input', (e) => {
    if (e.target?.id !== 'globalSearch') return;
    syncSearchClear();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(runGlobalSearch, 300);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target?.id === 'globalSearch') {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchDebounce); runGlobalSearch(); }
      else if (e.key === 'Escape') { e.preventDefault(); clearGlobalSearch(); e.target.blur(); }
      return;
    }

    // Atalhos para abrir a pesquisa: Ctrl+K, Ctrl+F, ou "/" fora de campos de texto
    const mod = e.ctrlKey || e.metaKey;
    const key = String(e.key).toLowerCase();
    const typing = e.target?.matches?.('input, textarea, select, [contenteditable="true"]');
    if ((mod && (key === 'k' || key === 'f')) || (!mod && !e.altKey && key === '/' && !typing)) {
      e.preventDefault();
      focusGlobalSearch();
    }
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('#globalSearchBtn')) { getSearchInput()?.value ? runGlobalSearch() : focusGlobalSearch(); }
    else if (e.target.closest('#globalSearchShortcut')) focusGlobalSearch();
    else if (e.target.closest('#globalSearchClear')) clearGlobalSearch();
  });


  // Botão de configurações global
  document.getElementById('globalSettingsBtn')?.addEventListener('click', () => {
    const tabButton = document.querySelector('.sidebar .tab-button[data-view="settings"]');
    if (tabButton) tabButton.click();
  });

  // Navegação via clique em notificação nativa (Windows)
  // Mapeia nomes internos do NotificationCenter → data-view da sidebar
  if (window.bds?.onNavigateToScreen) {
    const NOTIFICATION_SCREEN_MAP = {
      'downloads': 'download',
      'converter': 'converter',
      'copy':      'upload',
      'silence':   'silence',
      'projects':  'projects',
    };
    window.bds.onNavigateToScreen((screen) => {
      const view = NOTIFICATION_SCREEN_MAP[screen] || screen;
      const tabButton = document.querySelector(`.sidebar .tab-button[data-view="${view}"]`);
      if (tabButton) tabButton.click();
    });
  }

  // Inicializa escutas globais do Electron (IPC)
  initGlobalElectronListeners();
  
  // Abre a tela inicial pela própria aba da sidebar (marca o botão, ajusta o título e carrega a tela).
  // A tela vem das Configurações; se a aba não existir ou estiver oculta (ex.: módulo só de
  // desenvolvimento), cai para a Home.
  const wanted = state.settings?.defaultStartScreen || 'home';
  let startTab = document.querySelector(`.sidebar .tab-button[data-view="${wanted}"]`);
  if (!startTab || startTab.classList.contains('hidden') || startTab.style.display === 'none') {
    startTab = document.querySelector('.sidebar .tab-button[data-view="home"]');
  }
  if (startTab) startTab.click();
  else loadScreen('home');
});

// Em algum lugar do seu backend (ex: src/core/library/lutParser.js)
function parseCubeResolution(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (let line of lines) {
      if (line.startsWith('LUT_3D_SIZE')) {
        const size = line.split(/\s+/)[1]; // ex: "33"
        return `${size} x ${size} x ${size}`;
      }
    }
    return null; // Não encontrou
  } catch (e) {
    console.warn('Erro ao ler resolução do LUT:', filePath, e);
    return null;
  }
}

/**
 * Controla o footer compacto de downloads ativos (visível em qualquer tela).
 * @param {object|null} data  - payload de progresso/conclusão ou null para ocultar
 * @param {'downloading'|'completed'|'idle'} footerState
 */
function updateGlobalDownloadFooter(data, footerState) {
  const footer  = document.getElementById('globalDownloadFooter');
  const fill    = document.getElementById('gdfProgressFill');
  const title   = document.getElementById('gdfTitle');
  const stats   = document.getElementById('gdfStats');
  const percent = document.getElementById('gdfPercent');

  if (!footer) return;

  if (footerState === 'idle' || !data) {
    footer.classList.add('hidden');
    footer.classList.remove('gdf-completed');
    if (fill)    fill.style.width = '0%';
    if (percent) percent.textContent = '0%';
    return;
  }

  footer.classList.remove('hidden');

  if (footerState === 'completed') {
    footer.classList.add('gdf-completed');
    if (fill)    fill.style.width = '100%';
    if (title)   title.textContent = data.title ? `✓ ${data.title}` : '✓ Download concluído';
    if (stats)   stats.textContent = '';
    if (percent) percent.textContent = '100%';
    return;
  }

  // downloading
  footer.classList.remove('gdf-completed');
  const pct = typeof data.progress === 'number' ? Math.round(data.progress) : 0;
  if (fill)    fill.style.width = `${pct}%`;
  if (title)   title.textContent = data.title || 'Baixando mídia...';
  if (percent) percent.textContent = `${pct}%`;

  // stats: velocidade e ETA
  let statsText = '';
  if (data.speed && data.speed !== '--') statsText += data.speed;
  if (data.eta   && data.eta   !== '--') statsText += (statsText ? ' • ETA ' : 'ETA ') + data.eta;
  if (stats) stats.textContent = statsText || '--';
}

/**
 * Escutas globais do processo principal (IPC) centralizadas.
 * Repassam os dados em tempo real para os módulos das telas se estiverem ativos/carregados.
 */
async function initGlobalElectronListeners() {
  // Carrega as configurações assim que o app inicia
  state.settings = await window.bds.getSettings();
  // Aplica tema e cor de destaque sem flash, antes do primeiro render
  applyTheme(state.settings.theme, state.settings.accentColor);
  applyUiPreferences(state.settings);
  // Reaplica o estado persistido da sidebar (colapsada/expandida); em janela
  // estreita/tamanho mínimo, colapsa automaticamente para liberar espaço.
  applySidebarCollapsed(window.innerWidth <= SIDEBAR_NARROW_BREAKPOINT || state.settings.sidebarCollapsed === true);

  // ── Downloads: Queue Manager (canal correto com `id` nos payloads) ──────────

  // Progresso granular: `{ id, progress, speed, eta, downloadedBytes, totalBytes }`
  window.bds.downloads?.onProgress?.((data) => {
    state.running = true;
    if (typeof data.progress === 'number') {
      state.progressPercent = data.progress;
    }

    // Footer global — visível em qualquer tela
    updateGlobalDownloadFooter(data, 'downloading');

    // Repassa para a tela de download se estiver aberta
    import('./screens/download.js')
      .then(m => m.updateProgressVisuals?.(data))
      .catch(() => {});
  });

  // Fila atualizada: re-renderiza lista e fecha footer se não houver download ativo
  window.bds.downloads?.onUpdated?.((queue) => {
    state.downloadQueue = queue;
    const active = queue.find(i => i.status === 'downloading');
    state.running = Boolean(active);

    if (!active) {
      updateGlobalDownloadFooter(null, 'idle');
    }

    import('./screens/download.js')
      .then(m => m.renderDownloadQueue?.(queue))
      .catch(() => {});
  });

  // Concluído: mostra flash verde por 3 s e fecha o footer
  window.bds.downloads?.onCompleted?.((item) => {
    state.running = false;
    updateGlobalDownloadFooter(item, 'completed');
    setTimeout(() => updateGlobalDownloadFooter(null, 'idle'), 3000);

    import('./screens/library.js')
      .then(m => m.fetchMedia?.())
      .catch(() => {});
  });

  // Falhou: fecha footer
  window.bds.downloads?.onFailed?.((item) => {
    state.running = false;
    updateGlobalDownloadFooter(null, 'idle');
  });

  // ── Legado: canais antigos (backward compat) ────────────────────────────────
  // onDownloadQueue (canal `download:queue`) — mantido para outros emissores
  window.bds.onDownloadQueue((queue) => {
    state.downloadQueue = queue;
    const isRunning = queue.some(i => i.status === 'downloading');
    state.running = isRunning;
    import('./screens/download.js')
      .then(m => m.renderDownloadQueue?.(queue))
      .catch(() => {});
  });

  // onFinished (canal `download:finished`) — mantido para compat
  window.bds.onFinished((payload) => {
    state.running = false;
    import('./screens/download.js').then(m => {
      m.setControlsEnabled?.(true);
    }).catch(() => {});
  });

// ===== INÍCIO: LISTENERS DO CONVERSOR =====
// Listener para atualizar a fila inteira (quando arquivos são adicionados ou removidos)
window.bds?.onConverterQueue?.((queue) => {
  console.log('Evento recebido: converter:queue', queue);
  state.converterQueue = queue;
  // Chama a função de renderização do converter.js
  if (typeof renderConverterQueue === 'function') {
    renderConverterQueue();
  }
});

// Listener para atualizar o progresso de um arquivo específico
window.bds?.onConverterProgress?.((data) => {
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
window.bds?.onConverterFileFinished?.((data) => {
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
// Eventos do Conversor que deram erro foram removidos temporariamente

  // ===== INÍCIO: UPDATES =====
  // Ouvinte de resposta para checagem automática de atualizações no início do app
  // (disparada pelo bootstrap.js quando "checkUpdatesOnStart" está ativo nas Configurações).
  // Não existe uma tela dedicada de updates: o resultado é sinalizado com um badge na aba
  // Configurações e consumido por renderer/screens/settings.js, que já tem a UI completa de
  // atualização de componentes.
  window.bds.onUpdatesChecked((result) => {
    state.pendingUpdateCheck = result;

    const badge = document.getElementById('settingsUpdateBadge');
    if (result && result.hasUpdates) {
      if (badge) badge.classList.remove('hidden');
      window.bdsModal?.alert?.(
        'Há atualizações disponíveis para o BDS (aplicativo e/ou componentes internos como yt-dlp/FFmpeg). ' +
        'Abra Configurações → Atualizações para instalar.'
      );
    } else if (badge) {
      badge.classList.add('hidden');
    }
  });

  // ===== DEPENDÊNCIAS INICIAIS =====
  window.bds.onDependenciesDownloading(() => {
    const overlay = document.getElementById('initOverlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      overlay.classList.add('active');
    }
  });

  window.bds.onDependenciesDone(() => {
    const overlay = document.getElementById('initOverlay');
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.classList.remove('active');
    }
  });

  // ===== SISTEMA DE ENVIO DE ERROS / TELEMETRIA =====
  window.addEventListener('error', (event) => {
    try {
      window.bds?.reportError?.({
        name: event.error?.name || 'ClientError',
        message: event.message || 'Erro inesperado na interface',
        stack: event.error?.stack || ''
      }, {
        source: 'renderer:window.onerror',
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      });
    } catch (_) {}
  });

  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event.reason;
      window.bds?.reportError?.({
        name: reason?.name || 'UnhandledRejection',
        message: reason?.message || String(reason || 'Promessa rejeitada sem tratamento'),
        stack: reason?.stack || ''
      }, {
        source: 'renderer:unhandledrejection'
      });
    } catch (_) {}
  });
}