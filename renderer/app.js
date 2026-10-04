performance.mark('bds:app-module-start');
import { mediaPreviewSystem } from './components/preview/MediaPreviewSystem.js';
import { escapeHtml } from './utils/escape.js';
import { maskEngineNames } from './utils/engineNames.js';
import { t } from './strings.js';
import { initSliderSync } from './slider-sync.js';
import './utils/toast.js';
import { accentTokens, normalizeAccentHex } from './utils/accent-palette.js';
import { initShortcutsHelp } from './utils/shortcutsHelp.js';

// [PERF] Portão de inicialização (renderer/boot-gate.js): o HTML, o CSS e estes módulos carregam em
// paralelo com a abertura do banco no processo principal; a partir daqui (que usa IPC) só depois que
// o main libera o portão. Sem o portão (ex.: testes), segue direto.
if (window.__bdsGate) await window.__bdsGate.promise;
performance.mark('bds:gate-opened');

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
  if (els.stateText) els.stateText.textContent = maskEngineNames(text);
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
  if (els.statusText) els.statusText.textContent = maskEngineNames(text);
}

// Reexporta o utilitário único de escape
export { escapeHtml };

/* ==========================================================================
   SISTEMA DE TEMAS
   ========================================================================== */

/**
 * Injeta as variáveis CSS de cor de destaque no :root a partir da paleta fixa (renderer/utils/accent-palette.js).
 * Qualquer valor fora da paleta (inclui o antigo #e53935) vira a opção mais próxima; inválido volta ao Vermelho.
 * Os tons (acento, texto em destaque, fundo de botão colorido, translúcido) já vêm por tema, com contraste AA conferido.
 * @param {string} value — hex salvo, ex: "#ff0000"
 */
export function applyAccentColor(value) {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const tone = accentTokens(value, isDark ? 'dark' : 'light');
  const root = document.documentElement;
  root.style.setProperty('--accent', tone.accent);
  root.style.setProperty('--accent-hover', tone.hover);
  root.style.setProperty('--accent-light', tone.light);
  root.style.setProperty('--accent-solid', tone.solid);
  root.style.setProperty('--accent-solid-hover', tone.solidHover);
  root.style.setProperty('--accent-text', tone.text);
}

/**
 * Preferências de interface que não são tema/cor: hoje, "reduzir animações".
 * Chamada ao iniciar o app e depois de salvar as Configurações.
 * @param {object} settings
 */
export function applyUiPreferences(settings = {}) {
  document.documentElement.classList.toggle('reduce-motion', settings.reduceMotion === true);
  // Só reordena quando a preferência veio no objeto (prévias parciais, como { reduceMotion }, não mexem no menu)
  if (Array.isArray(settings.sidebarOrder)) applySidebarOrder(settings.sidebarOrder);
}

export function applyTheme(theme = 'dark', accentColor = '#ff0000') {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  applyAccentColor(normalizeAccentHex(accentColor));
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

/* ==========================================================================
   ORDEM DO MENU LATERAL + ATALHOS Ctrl+1..9
   A Home é sempre a 1ª aba. As demais seguem a ordem escolhida em Configurações
   (settings.sidebarOrder); telas fora da lista ficam depois, na ordem original.
   Ctrl+N abre a N-ésima aba VISÍVEL (abas ocultas, ex.: só de desenvolvimento, não contam).
   ========================================================================== */

const MAX_TAB_SHORTCUTS = 9;
let _defaultTabOrder = null;

function getTabButtons() {
  return [...document.querySelectorAll('.sidebar .tabs .tab-button')];
}

function isTabVisible(btn) {
  return !btn.classList.contains('hidden') && btn.style.display !== 'none';
}

/** Ordem original das abas (a do index.html), capturada uma única vez antes de qualquer reordenação. */
export function getDefaultTabOrder() {
  if (!_defaultTabOrder) _defaultTabOrder = getTabButtons().map(b => b.getAttribute('data-view'));
  return [..._defaultTabOrder];
}

/** Abas visíveis, na ordem atual do menu: [{ view, label, icon }]. */
export function getVisibleSidebarTabs() {
  return getTabButtons().filter(isTabVisible).map(b => ({
    view: b.getAttribute('data-view'),
    label: getTabLabel(b),
    icon: b.querySelector('.material-symbols-rounded')?.textContent?.trim() || 'circle'
  }));
}

/** Rótulo do atalho de uma aba pela posição entre as visíveis (1 = Home), ou '' se não houver. */
export function tabShortcutLabel(position) {
  return position >= 1 && position <= MAX_TAB_SHORTCUTS ? `Ctrl+${position}` : '';
}

function isSidebarCollapsed() {
  return document.querySelector('.sidebar')?.classList.contains('collapsed') === true;
}

/** Dica de cada aba: "Nome (Ctrl+N)" no menu recolhido, só "Ctrl+N" no expandido. */
function refreshTabTooltips() {
  const collapsed = isSidebarCollapsed();
  getTabButtons().forEach(btn => {
    const shortcut = btn.getAttribute('data-shortcut') || '';
    btn.title = collapsed
      ? (shortcut ? `${getTabLabel(btn)} (${shortcut})` : getTabLabel(btn))
      : shortcut;
  });
}

/** Recalcula os atalhos conforme a ordem e a visibilidade atuais das abas. */
export function updateTabShortcuts() {
  let position = 0;
  getTabButtons().forEach(btn => {
    const label = isTabVisible(btn) ? tabShortcutLabel(++position) : '';
    if (label) {
      btn.setAttribute('data-shortcut', label);
      btn.setAttribute('aria-keyshortcuts', `Control+${position}`);
    } else {
      btn.removeAttribute('data-shortcut');
      btn.removeAttribute('aria-keyshortcuts');
    }
  });
  refreshTabTooltips();
}

/**
 * Reordena as abas do menu lateral.
 * @param {string[]} [order] — ids de tela na ordem desejada (a Home é ignorada: fica sempre primeiro)
 */
export function applySidebarOrder(order) {
  const nav = document.querySelector('.sidebar .tabs');
  if (!nav) return;
  const known = getDefaultTabOrder();
  const wanted = (Array.isArray(order) ? order : []).filter(v => typeof v === 'string' && v !== 'home' && known.includes(v));
  const byView = new Map(getTabButtons().map(b => [b.getAttribute('data-view'), b]));
  const seen = new Set();
  ['home', ...wanted, ...known].forEach(view => {
    if (seen.has(view)) return;
    seen.add(view);
    const btn = byView.get(view);
    if (btn) nav.appendChild(btn); // mover o mesmo elemento preserva os listeners de clique
  });
  updateTabShortcuts();
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
    toggleBtn.title = collapsed ? 'Expandir menu (Ctrl+B)' : 'Recolher menu (Ctrl+B)';
    const icon = toggleBtn.querySelector('.material-symbols-rounded');
    if (icon) icon.textContent = collapsed ? 'menu' : 'menu_open';
  }

  // Tooltip do BDS: indica que pode expandir quando colapsado
  const brand = document.querySelector('.sidebar .brand');
  if (brand) brand.title = collapsed ? 'Expandir menu' : '';

  // Tooltips: nome da tela + atalho quando colapsada; só o atalho quando expandida
  refreshTabTooltips();
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

      this._title.textContent = maskEngineNames(title);
      this._message.innerHTML = escapeHtml(maskEngineNames(message)).replace(/\n/g, '<br/>');
      
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
        this._modal.removeEventListener('cancel', onNativeCancel);
        this._modal.close();
      };

      const onConfirm = () => { cleanup(); resolve(isPrompt ? (this._input ? this._input.value : null) : true); };
      const onCancel = () => { cleanup(); resolve(isPrompt ? null : false); };
      const onKeyDown = (e) => {
        if (e.key === 'Enter') onConfirm();
        if (e.key === 'Escape') onCancel();
      };

      // Esc nativo do <dialog>: resolve a promise como cancelamento (evita promise pendente)
      const onNativeCancel = (e) => { e.preventDefault(); onCancel(); };
      this._modal.addEventListener('cancel', onNativeCancel);
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

// Roda no DOMContentLoaded ou, se ele já passou (o módulo esperou o portão acima), imediatamente — a chamada
// fica no fim do arquivo para que tudo que o corpo usa já esteja declarado.
const startApp = () => {
  performance.mark('bds:domcontentloaded-handler');
  // Inicializa o componente global de range sliders (sync --slider-value)
  initSliderSync();
  initShortcutsHelp();

  const contentContainer = document.getElementById('dynamic-content');
  const tabButtons = document.querySelectorAll('.tab-button');

  // --- Módulos restritos a builds de desenvolvimento (não aparecem no .exe final) ---
  // Recuperação e Montagem Automática ainda estão em otimização; ficam disponíveis apenas
  // quando o BDS roda a partir do código-fonte (não empacotado). Assume-se "empacotado" por
  // padrão (fail-safe) até a checagem real do processo principal responder.
  const DEV_ONLY_SCREENS = ['recovery', 'montage'];
  let isPackagedApp = true;

  // Módulos (Configurações → Módulos): a lista e o estado vêm do processo principal (fonte da
  // verdade). screen → ligado. Antes da primeira resposta, telas sem módulo ficam como estão e as
  // telas de desenvolvimento permanecem ocultas (fail-safe).
  const moduleScreens = new Map();
  let modulesLoaded = false;

  function isScreenAllowed(screenName) {
    if (DEV_ONLY_SCREENS.includes(screenName)) {
      if (isPackagedApp || !modulesLoaded) return false;
      return moduleScreens.get(screenName) === true;
    }
    return moduleScreens.has(screenName) ? moduleScreens.get(screenName) : true;
  }

  function applyDevOnlyVisibility() {
    const managed = new Set([...DEV_ONLY_SCREENS, ...moduleScreens.keys()]);
    managed.forEach((screenName) => {
      const btn = document.querySelector(`.tab-button[data-view="${screenName}"]`);
      if (!btn) return;
      if (!isScreenAllowed(screenName)) {
        btn.classList.add('hidden');
        btn.style.display = 'none';
      } else {
        btn.classList.remove('hidden');
        btn.style.display = '';
      }
    });
    updateTabShortcuts(); // abas ocultas não ocupam número de atalho
    window.dispatchEvent(new CustomEvent('bds:modules-changed'));
  }

  // Aplica a lista de módulos recebida do main e, se a tela aberta foi desligada, volta à Home.
  function applyModules(list) {
    if (!Array.isArray(list)) return;
    moduleScreens.clear();
    list.forEach((m) => (m.screens || []).forEach((s) => moduleScreens.set(s, m.enabled === true)));
    modulesLoaded = true;
    applyDevOnlyVisibility();
    const active = document.querySelector('.sidebar .tab-button.active')?.getAttribute('data-view');
    if (active && !isScreenAllowed(active)) {
      document.querySelector('.sidebar .tab-button[data-view="home"]')?.click();
    }
  }

  async function refreshModules() {
    try {
      const r = await window.bds.modulesList();
      if (r && r.ok) applyModules(r.data);
    } catch (err) {
      console.warn('[APP] Falha ao ler módulos:', err);
    }
  }

  getDefaultTabOrder(); // captura a ordem original do menu antes de qualquer reordenação

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
        if (typeof window.bds.modulesList === 'function') refreshModules();
      }).catch((err) => {
        console.error('[APP] Falha ao verificar isPackaged (mantendo módulos dev ocultos):', err);
      });
    } else {
      console.warn('[APP] window.bds.isPackaged indisponível — mantendo módulos dev ocultos (fail-safe).');
    }
  } catch (err) {
    console.error('[APP] Erro inesperado ao checar isPackaged:', err);
  }

  let activeModule = null;
  let activeModuleName = null;

  // Navegações em série: dois cliques rápidos (ou o clique do usuário durante a abertura inicial)
  // não podem criar a mesma tela duas vezes nem deixar a tela errada visível.
  let navQueue = Promise.resolve();
  function loadScreen(screenName) {
    navQueue = navQueue.then(() => loadScreenNow(screenName)).catch(() => {});
    return navQueue;
  }

  async function loadScreenNow(screenName) {
    // Defesa extra: mesmo que a aba tenha sido acionada por outro caminho (não pelo clique
    // visível do botão), builds empacotadas nunca carregam os módulos restritos.
    if (!isScreenAllowed(screenName)) {
      screenName = 'home';
    }

    // Remove bloco de erro anterior (se houver)
    contentContainer.querySelectorAll('.screen-error').forEach(n => n.remove());

    try {
      // Notifica a tela ativa anterior (módulo guardado em activeModule) para limpar listeners/timers
      const prevActive = contentContainer.querySelector('.view.active');
      if (prevActive) {
        const prevName = (prevActive.id || '').replace(/View$/, '');
        if (prevName && prevName !== screenName) {
          try {
            if (activeModule && activeModuleName === prevName && typeof activeModule.onLeave === 'function') {
              await activeModule.onLeave();
            }
          } catch (leaveErr) {
            console.error(`[APP] Erro em onLeave de "${prevName}":`, leaveErr);
          }
          activeModule = null;
          activeModuleName = null;
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
        // 0. INJEÇÃO DINÂMICA DE CSS MODULAR (Lazy Loading) — aguarda load/error para evitar FOUC
        const cssId = `css-modular-${screenName}`;
        let cssPromise = Promise.resolve();
        if (!document.getElementById(cssId)) {
          const link = document.createElement('link');
          link.id = cssId;
          link.rel = 'stylesheet';
          link.href = `./screens/${screenName}.css`;
          cssPromise = new Promise((resolve) => {
            link.addEventListener('load', resolve, { once: true });
            link.addEventListener('error', () => { link.remove(); resolve(); }, { once: true }); // tela sem CSS dedicado
            setTimeout(resolve, 3000); // não trava a navegação
          });
          document.head.appendChild(link);
        }

        // 1. Carrega o HTML da tela solicitada (apenas na primeira vez)
        const [response] = await Promise.all([fetch(`./screens/${screenName}.html`), cssPromise]);
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
          const screenModule = await getScreenModule(screenName);
          activeModule = screenModule;
          activeModuleName = screenName;
          performance.mark(`bds:screen-module-loaded:${screenName}`);
          if (screenModule.initScreen) {
            screenModule.initScreen();
          }
          performance.mark(`bds:screen-init-done:${screenName}`);
          // Marco de diagnóstico: pintura efetiva da tela (2 frames depois do init)
          requestAnimationFrame(() => requestAnimationFrame(() => performance.mark(`bds:${screenName}-painted`)));
        } catch (jsError) {
          console.log(`A tela ${screenName} não possui um arquivo JS dedicado ou ele falhou.`, jsError);
          if (screenName === 'home') {
            viewSection.innerHTML = '';
            const p = document.createElement('p');
            p.style.cssText = 'padding: 20px; color: var(--danger, red);';
            p.textContent = `Erro de import: ${jsError.message}`;
            viewSection.appendChild(p);
          }
        }
      } else {
        // A tela já existe no DOM, apenas reativa
        viewSection.classList.add('active');
        viewSection.classList.remove('hidden');
        updateDOMReferences();

        try {
          const screenModule = await getScreenModule(screenName);
          activeModule = screenModule;
          activeModuleName = screenName;
          // Re-registra listeners globais removidos em onLeave e atualiza dados se necessário
          if (typeof screenModule.onEnter === 'function') await screenModule.onEnter();
        } catch (_) { /* tela sem JS dedicado */ }
      }

    } catch (error) {
      console.error('Erro ao carregar a tela:', error);
      contentContainer.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); });
      const box = document.createElement('div');
      box.className = 'view active screen-error';
      box.setAttribute('role', 'alert');
      box.style.cssText = 'padding:40px;text-align:center;';
      const msg = document.createElement('p');
      msg.style.color = 'var(--danger, #ff6b63)';
      msg.textContent = t('screen.loadError');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bds-btn-secondary';
      btn.textContent = t('common.retry');
      btn.addEventListener('click', () => { box.remove(); loadScreen(screenName); });
      box.append(msg, btn);
      contentContainer.appendChild(box);
    }
  }

  window.bdsLoadScreen = loadScreen;

  // Ctrl+1..9: abre a tela na posição correspondente do menu lateral (1 = Home).
  // Vale também dentro de campos de texto (Ctrl+número não digita nada) e é ignorado com um diálogo aberto.
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !/^[1-9]$/.test(e.key)) return;
    if (document.querySelector('dialog[open]')) return;
    const btn = getTabButtons().filter(isTabVisible)[Number(e.key) - 1];
    if (!btn) return;
    e.preventDefault();
    btn.click();
  });

  // Despachante central de teclado: roteia keydown para screen.onKeyDown(e) da tela ativa
  document.addEventListener('keydown', (e) => {
    if (activeModule && typeof activeModule.onKeyDown === 'function') {
      try { activeModule.onKeyDown(e); } catch (err) { console.error('[APP] Erro em onKeyDown:', err); }
    }
  });

  // F11 alterna a tela cheia da janela; Esc sai dela quando nada mais usou a tecla
  // (prévia, modal, diálogo, busca...). O listener de Esc fica em `window`, que roda depois dos
  // de `document`: quem tratou o Esc chamou preventDefault e a janela continua em tela cheia.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'F11' || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    window.bds?.fullscreenWindow?.();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.querySelector('dialog[open]')) return;
    window.bds?.fullscreenWindow?.('exit');
  });

  // Storage Polling
  const storageIndicators = document.getElementById('storageIndicators');
  if (storageIndicators) {
    storageIndicators.innerHTML = '<span class="storage-note">Verificando espaço em disco…</span>';
    storageIndicators.classList.add('active');

    if (!window.bds || !window.bds.getStorageInfo) {
      storageIndicators.innerHTML = '<span class="storage-note storage-note-error">Não foi possível ler o espaço em disco. Reinicie o aplicativo.</span>';
      storageIndicators.classList.add('active');
    } else {
      const updateStorage = async () => {
        try {
          const info = await window.bds.getStorageInfo();
          if (!info) {
            storageIndicators.innerHTML = '<span class="storage-note storage-note-error">Não foi possível ler o espaço em disco.</span>';
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
                  <span class="storage-percent">${escapeHtml(info.pc.percent)}% ocupado</span>
                </div>
                <div class="storage-bar">
                  <div class="storage-fill ${isCritical ? 'critical' : ''}" style="width: ${info.pc.percent}%"></div>
                </div>
                <div class="storage-footer">
                  <span>${escapeHtml(info.pc.free)} livres</span>
                  <span>${escapeHtml(info.pc.total)}</span>
                </div>
              </div>
            `;
          }

          // Device Storage removed as requested
          
          storageIndicators.innerHTML = html;
          storageIndicators.classList.add('active');
        } catch(e) {
          storageIndicators.innerHTML = '<span class="storage-note storage-note-error">Não foi possível ler o espaço em disco.</span>';
          storageIndicators.classList.add('active');
        }
      };
      
      // [PERF] A primeira leitura (dispara a enumeração de dispositivos via PowerShell) espera a Home
      // aparecer; antes ela disputava CPU/IPC com a abertura. O texto "Verificando..." cobre o intervalo.
      setTimeout(updateStorage, 1500);
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
      // Tela de módulo desligado (atalho, notificação, cartão): volta à Home.
      if (!isScreenAllowed(button.getAttribute('data-view'))) {
        document.querySelector('.sidebar .tab-button[data-view="home"]')?.click();
        return;
      }
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
      getScreenModule('library')
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

  if (window.bds?.onModulesChanged) window.bds.onModulesChanged(() => refreshModules());

  // Assistente de IA: botão flutuante em todas as telas (só existe com o módulo e o interruptor ligados; liberado no app final).
  // Um erro aqui nunca pode afetar o restante do app.
  import('./components/ai-assistant.js')
    .then((m) => m.mountAssistant())
    .catch((err) => console.warn('[APP] Assistente de IA indisponível:', err));

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
};

// Módulos de tela já importados (evita import() dinâmico a cada navegação/tick de progresso)
const screenModules = {};
function getScreenModule(name) {
  if (!screenModules[name]) {
    screenModules[name] = import(`./screens/${name}.js`).catch((err) => { delete screenModules[name]; throw err; });
  }
  return screenModules[name];
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

  // ÚNICO assinante de progresso/fila: repassa para a tela de downloads (que não assina mais).
  // Os payloads podem trazer a fila inteira (array) ou só o item ({ id, ... }).
  const pendingProgress = new Map(); // id -> payload mais recente (coalescido por quadro)
  let progressRaf = 0;
  const flushProgress = () => {
    progressRaf = 0;
    if (!pendingProgress.size) return;
    const batch = Array.from(pendingProgress.values());
    pendingProgress.clear();
    const last = batch[batch.length - 1];
    updateGlobalDownloadFooter(last, 'downloading');
    getScreenModule('download').then((m) => batch.forEach((d) => m.updateProgressVisuals?.(d))).catch(() => {});
  };
  const scheduleProgress = (data) => {
    pendingProgress.set(data.id ?? '_', { ...(pendingProgress.get(data.id ?? '_') || {}), ...data });
    if (!progressRaf) progressRaf = (document.hidden ? setTimeout : requestAnimationFrame)(flushProgress, 250);
  };

  // Mescla um payload de item único na fila local (o item é criado se ainda não existir)
  const mergeQueueItem = (item) => {
    const q = Array.isArray(state.downloadQueue) ? state.downloadQueue : [];
    const i = q.findIndex((x) => x.id === item.id);
    if (i >= 0) { q[i] = { ...q[i], ...item }; return q; }
    return q.concat([item]);
  };

  // Progresso granular: `{ id, progress, speed, eta, downloadedBytes, totalBytes }`
  window.bds.downloads?.onProgress?.((data) => {
    if (!data) return;
    if (Array.isArray(data)) { handleQueueUpdate(data); return; }
    state.running = true;
    if (typeof data.progress === 'number') {
      state.progressPercent = data.progress;
    }
    // Mantém o item da fila local em dia (sem re-renderizar a lista a cada tick)
    if (data.id != null && Array.isArray(state.downloadQueue)) {
      const it = state.downloadQueue.find((x) => x.id === data.id);
      if (it) Object.assign(it, data);
    }
    scheduleProgress(data);
  });

  // Fila atualizada: re-renderiza (no máximo 1x por quadro) e fecha o footer se não houver download ativo
  let queueRaf = 0;
  const handleQueueUpdate = (payload) => {
    const queue = Array.isArray(payload) ? payload : mergeQueueItem(payload);
    state.downloadQueue = queue;
    const active = queue.find(i => i.status === 'downloading');
    state.running = Boolean(active);

    if (!active) {
      updateGlobalDownloadFooter(null, 'idle');
    }
    if (queueRaf) return;
    queueRaf = (document.hidden ? setTimeout : requestAnimationFrame)(() => {
      queueRaf = 0;
      getScreenModule('download')
        .then(m => m.renderDownloadQueue?.(state.downloadQueue))
        .catch(() => {});
    }, 250);
  };
  window.bds.downloads?.onUpdated?.((payload) => { if (payload) handleQueueUpdate(payload); });

  // Concluído: mostra flash verde por 3 s e fecha o footer
  window.bds.downloads?.onCompleted?.((item) => {
    state.running = false;
    updateGlobalDownloadFooter(item, 'completed');
    setTimeout(() => updateGlobalDownloadFooter(null, 'idle'), 3000);

    getScreenModule('library')
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
    getScreenModule('download')
      .then(m => m.renderDownloadQueue?.(queue))
      .catch(() => {});
  });

  // onFinished (canal `download:finished`) — mantido para compat
  window.bds.onFinished((payload) => {
    state.running = false;
    getScreenModule('download').then(m => {
      m.setControlsEnabled?.(true);
    }).catch(() => {});
  });

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
        'Há atualizações disponíveis para o BDS (aplicativo e/ou componentes internos). ' +
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

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startApp);
else startApp();
