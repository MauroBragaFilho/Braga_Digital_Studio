import { normalizeAccentHex } from '../utils/accent-palette.js';
import { state, setStatus, escapeHtml, applyTheme, applyAccentColor, applyUiPreferences, getVisibleSidebarTabs, getDefaultTabOrder, tabShortcutLabel } from '../app.js';
import { friendlyError } from '../utils/friendlyError.js';
import { enhanceModalOverlay } from '../utils/modal.js';
import { toFileUrl } from '../utils/fileUrl.js';

let customSources = [];

export function initScreen() {
  console.log('[SETTINGS] Inicializando tela...');
  renderSettings();
  setupTabs();
  setupSubnavs();
  bindEvents();
  setupCustomSourceModal();
  setupErrorReportingUI();
  fetchAppVersion();
  loadSettingsCustomSources();
  setupContainerClickHandler();
  setupSettingsSearch();
  setupSaveBar();
  setupSettingsExtras();
  setupSidebarOrder();
  setupModuleDependentUi();
  setupFieldDefaults();
  setupValidation();
  setupFieldKeyboard();
  setupLeaveGuard();
  setupAdvancedBlocks();
  rebaseline();
  updateSaveBar();
  setupRecordingFolderDetection();
  applyPendingUpdateCheck();
  loadCrashReports();
  loadCacheInfo();
  loadHardwareInfo();
}

/* ==========================================================================
   RESULTADO DE CHECAGEM AUTOMÁTICA (startup)
   ========================================================================== */
// Se o bootstrap já checou atualizações ao iniciar o app (checkUpdatesOnStart),
// reaproveita esse resultado em vez de disparar uma nova checagem, e limpa o
// badge da aba Configurações no menu lateral.
function applyPendingUpdateCheck() {
  const pending = state.pendingUpdateCheck;

  const badge = document.getElementById('settingsUpdateBadge');
  if (badge) badge.classList.add('hidden');

  if (pending) {
    // Mesmo desenho de uma verificação feita agora: duas linhas de estado e, se houver, as notas da versão
    showUpdateCheck(pending);
    state.pendingUpdateCheck = null;
  }
}

// Impede que cliques internos "borbulhem" para listeners globais do shell
function setupContainerClickHandler() {
  const container = document.querySelector('.settings-container');
  if (container) {
    container.addEventListener('click', (e) => e.stopPropagation());
  }
}

/* ==========================================================================
   ABAS
   ========================================================================== */
function setupTabs() {
  const tabs = document.querySelectorAll('.settings-tab');
  const views = document.querySelectorAll('.settings-view');
  if (tabs.length === 0 || views.length === 0) return;
  document.querySelector('.settings-tab.active')?.setAttribute('aria-current', 'page');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      flushAssistantInstructions?.(); // sair da aba grava as instruções da Yui digitadas
      clearSettingsSearch();
      const targetId = tab.dataset.tab;
      tabs.forEach(t => { t.classList.remove('active'); t.removeAttribute('aria-current'); });
      views.forEach(v => v.classList.add('hidden'));
      tab.classList.add('active');
      tab.setAttribute('aria-current', 'page');
      const targetView = document.getElementById(targetId);
      if (targetView) targetView.classList.remove('hidden');
      if (targetId === 'settingsModulesView') loadModulesList();
      // Abas com submenu: reabre o último subpainel usado (ou o que outra tela pediu)
      applyPendingSub(targetId);
      // Os painéis da seção Inteligência Artificial (provedores e transcrição neste computador) só existem com a aba aberta
      if (targetId === 'settingsAiView') { mountAiPanel(); mountTranscriptionPanel(); }
      else { unmountAiPanel(); unmountTranscriptionPanel(); }
      if (targetId === 'settingsAboutView') loadLicensesPage();
      // Recarrega a lista de crash reports ao abrir a aba Sistema
      if (targetId === 'settingsSystemView') {
        loadCrashReports();
        loadHardwareInfo();
        loadCacheInfo();
      }
    });
  });
}

/* ==========================================================================
   SUBMENUS: abas internas de cada seção (.st-subnav com .st-subtab[data-sub] e .st-subpanel[data-sub-panel])
   Um só mecanismo para todas as seções. O último subpainel usado em cada seção fica em localStorage
   ('bdsSub:<id da seção>'). Outra tela pode pedir um subpainel, uma vez, ao abrir a seção:
   sessionStorage 'bdsSubRequest' = {"view":"<id da seção>","sub":"<subpainel>"} ou o evento
   'bds:settings-open-sub' (detail {view, sub}). Ficam aceitos os nomes antigos da IA:
   sessionStorage 'bdsAiSubRequest' (id do subpainel) e o evento 'bds:ai-open-sub' (detail = id).
   ========================================================================== */
const SUB_KEY_PREFIX = 'bdsSub:';
const SUB_REQUEST_KEY = 'bdsSubRequest';
const AI_VIEW_ID = 'settingsAiView';
const AI_SUB_REQUEST_KEY = 'bdsAiSubRequest'; // nome antigo: só o id do subpainel da IA
let subEventsBound = false;

function readStoredSub(viewId) {
  try { return localStorage.getItem(SUB_KEY_PREFIX + viewId) || ''; } catch (_) { return ''; }
}

const subTabsOf = (nav) => [...nav.querySelectorAll('.st-subtab')];
const visibleSubTabsOf = (nav) => subTabsOf(nav).filter((b) => !b.classList.contains('hidden'));

/**
 * Mostra um subpainel da seção (os outros ficam escondidos). Um id desconhecido ou escondido cai no
 * primeiro item visível. Devolve false se a seção não tem submenu ou nenhum item está visível.
 */
function showSub(viewId, subId, { remember = true } = {}) {
  flushAssistantInstructions?.(); // trocar de subpainel esconde o campo: grava antes
  const view = document.getElementById(viewId);
  const nav = view?.querySelector('.st-subnav');
  if (!nav) return false;
  const visible = visibleSubTabsOf(nav);
  const target = visible.find((b) => b.dataset.sub === subId) || visible[0];
  if (!target) return false;
  const sub = target.dataset.sub;
  subTabsOf(nav).forEach((b) => {
    const on = b === target;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.setAttribute('tabindex', on ? '0' : '-1'); // padrão de abas: só o ativo entra na ordem do Tab; as setas trocam
  });
  view.querySelectorAll('[data-sub-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.subPanel !== sub));
  if (remember) { try { localStorage.setItem(SUB_KEY_PREFIX + viewId, sub); } catch (_) { /* sem armazenamento */ } }
  onSubShown(viewId, sub);
  return true;
}

/** Subpainéis cujo conteúdo muda sozinho são relidos toda vez que aparecem (no lugar de um botão "Atualizar"). */
function onSubShown(viewId, sub) {
  // LUTs, Coleção: pasta e contagem são sempre as do disco agora (só lê com a seção à vista)
  if (viewId === 'settingsLutsView' && sub === 'collection') {
    if (!document.getElementById(viewId)?.classList.contains('hidden')) loadLutsInfo();
    return;
  }
  if (viewId !== 'settingsSystemView') return;
  if (sub === 'about') loadCacheInfo();
  else if (sub === 'support') loadCrashReports();
}

/** Outra tela pediu um subpainel desta seção: vale uma vez (o pedido de outra seção fica guardado para ela). */
function takeSubRequest(viewId) {
  let sub = '';
  try {
    const raw = sessionStorage.getItem(SUB_REQUEST_KEY);
    if (raw) {
      let req = null;
      try { req = JSON.parse(raw); } catch (_) { /* pedido inválido */ }
      if (!req || typeof req !== 'object') sessionStorage.removeItem(SUB_REQUEST_KEY);
      else if (req.view === viewId) { sub = String(req.sub || ''); sessionStorage.removeItem(SUB_REQUEST_KEY); }
    }
    if (!sub && viewId === AI_VIEW_ID) {
      sub = sessionStorage.getItem(AI_SUB_REQUEST_KEY) || '';
      sessionStorage.removeItem(AI_SUB_REQUEST_KEY);
    }
  } catch (_) { /* sem armazenamento */ }
  return sub;
}

/** Ao abrir a seção: o subpainel pedido por outra tela, senão o último usado, senão o primeiro visível. */
function applyPendingSub(viewId) {
  if (!document.getElementById(viewId)?.querySelector('.st-subnav')) return;
  showSub(viewId, takeSubRequest(viewId) || readStoredSub(viewId), { remember: false });
}

/** Pede um subpainel de uma seção para quando ela for aberta (usado por quem clica na aba em seguida). */
function requestSub(viewId, sub) {
  try { sessionStorage.setItem(SUB_REQUEST_KEY, JSON.stringify({ view: viewId, sub })); } catch (_) { /* sem armazenamento */ }
}

/** O painel tem algo para mostrar? Painéis que montam o conteúdo depois (data-lazy-host) contam como cheios. */
function subPanelHasContent(panel) {
  if (panel.querySelector('[data-lazy-host]')) return true;
  return [...panel.querySelectorAll('.st-card')].some((c) => !c.classList.contains('hidden')
    && !c.classList.contains('st-devhidden') && !c.classList.contains('st-filtered'));
}

/**
 * Esconde o item do submenu cujo painel ficou sem cartão visível (módulo desligado) e, se o item ativo
 * sumiu, ativa o primeiro visível. Não mexe durante a busca (a barra fica escondida e o estado é preservado).
 */
function refreshSubnavs() {
  if (document.querySelector('.settings-container')?.classList.contains('st-searching')) return;
  document.querySelectorAll('.settings-view .st-subnav').forEach((nav) => {
    const view = nav.closest('.settings-view');
    subTabsOf(nav).forEach((b) => {
      const panel = view.querySelector(`[data-sub-panel="${b.dataset.sub}"]`);
      b.classList.toggle('hidden', !panel || !subPanelHasContent(panel));
    });
    // Uma barra com 0 ou 1 item não ajuda ninguém: some (o painel do item restante continua à vista)
    nav.classList.toggle('hidden', visibleSubTabsOf(nav).length < 2);
    const active = nav.querySelector('.st-subtab.active');
    if (!active || active.classList.contains('hidden')) showSub(view.id, '', { remember: false });
  });
}

/** Leva um campo à vista: abre a aba e o subpainel em que ele está (senão o usuário nunca vê o erro). */
function revealField(el) {
  const view = el.closest('.settings-view');
  if (view && view.classList.contains('hidden')) document.querySelector(`.settings-tab[data-tab="${view.id}"]`)?.click();
  const panel = el.closest('[data-sub-panel]');
  if (view && panel && panel.classList.contains('hidden')) showSub(view.id, panel.dataset.subPanel);
}

/** Como showSub, mas ignora ids que não existem ou estão escondidos (um pedido ruim não muda nada). */
function showSubIfVisible(viewId, subId) {
  const nav = document.getElementById(viewId)?.querySelector('.st-subnav');
  if (!nav || !visibleSubTabsOf(nav).some((b) => b.dataset.sub === subId)) return false;
  return showSub(viewId, subId);
}

function setupSubnavs() {
  document.querySelectorAll('.settings-view .st-subnav').forEach((nav) => {
    const view = nav.closest('.settings-view');
    if (!nav.dataset.subBound) {
      nav.dataset.subBound = '1';
      nav.setAttribute('aria-orientation', 'horizontal');
      nav.addEventListener('click', (e) => {
        const btn = e.target.closest('.st-subtab');
        if (btn && !btn.classList.contains('hidden')) showSub(view.id, btn.dataset.sub);
      });
      // Setas esquerda/direita, Home e End entre os itens (padrão de abas)
      nav.addEventListener('keydown', (e) => {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
        const tabs = visibleSubTabsOf(nav);
        const i = tabs.indexOf(e.target.closest('.st-subtab'));
        if (i < 0) return;
        let next = i;
        if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
        else if (e.key === 'Home') next = 0;
        else next = tabs.length - 1;
        tabs[next].focus();
        showSub(view.id, tabs[next].dataset.sub);
        e.preventDefault();
      });
    }
    // Estado inicial: o último usado (um pedido de outra tela só vale quando a seção é aberta)
    showSub(view.id, readStoredSub(view.id), { remember: false });
  });
  if (subEventsBound) return;
  subEventsBound = true;
  window.addEventListener('bds:settings-open-sub', (e) => {
    const d = e.detail || {};
    if (d.view && d.sub) showSubIfVisible(String(d.view), String(d.sub));
  });
  window.addEventListener('bds:ai-open-sub', (e) => showSubIfVisible(AI_VIEW_ID, String(e.detail || '')));
}

/* ==========================================================================
   MÓDULOS (ligar/desligar recursos)
   ========================================================================== */
let modulesCache = [];

async function loadModulesList() {
  const host = document.getElementById('modulesList');
  if (!host) return;
  let list = [];
  try {
    const r = await window.bds.modulesList();
    if (r && r.ok) list = r.data;
  } catch (_) { /* lista vazia */ }
  modulesCache = list;
  applyModuleDependentUi(list);
  host.innerHTML = list.map((m) => {
    const needsEngine = m.enabled && m.hasEngine && !m.installed;
    const status = needsEngine
      ? `<button type="button" class="st-module-link" data-module-install="${escapeHtml(m.id)}">Falta instalar um componente — instalar</button>`
      : (m.available === false ? '<span class="st-row-hint st-module-warn">Indisponível neste sistema</span>' : '');
    return `<label class="st-row st-row-toggle">
      <div class="st-row-text">
        <span class="st-row-label">${escapeHtml(m.title)}</span>
        <span class="st-row-hint">${escapeHtml(m.description)}</span>
        ${status}
      </div>
      <input type="checkbox" class="st-switch" data-module-id="${escapeHtml(m.id)}" ${m.enabled ? 'checked' : ''} ${m.available === false ? 'disabled' : ''} />
    </label>`;
  }).join('') || '<p class="st-card-desc">Nenhum módulo disponível.</p>';

  host.querySelectorAll('input[data-module-id]').forEach((input) => {
    input.addEventListener('change', async () => {
      const want = input.checked;
      const id = input.dataset.moduleId;
      input.disabled = true;
      let changed = false;
      try {
        const r = await window.bds.modulesSetEnabled(id, want);
        if (!r || !r.ok) throw new Error(r?.error || 'O recurso não respondeu.');
        changed = true;
      } catch (err) {
        input.checked = !want;
        setStatus(`Não foi possível ${want ? 'ativar' : 'desativar'} este recurso. ${friendlyError(err, 'Tente novamente.')}`);
      } finally {
        input.disabled = false;
      }
      if (!changed) return;
      await loadModulesList();
      // Ao ligar um módulo com motor ainda não instalado, oferece a instalação (nada é baixado sem confirmar)
      const m = modulesCache.find((x) => x.id === id);
      if (want && m && m.hasEngine && !m.installed) offerEngineInstall(m);
    });
  });
  host.querySelectorAll('[data-module-install]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const m = modulesCache.find((x) => x.id === btn.dataset.moduleInstall);
      if (m) offerEngineInstall(m);
    });
  });
}

/**
 * Oferece instalar o motor de um módulo. Transcrição leva ao painel de instalação existente (escolha de
 * motor e modelo); componentes sob demanda ('tool:<nome>') são baixados daqui, só depois de o usuário confirmar.
 */
async function offerEngineInstall(m) {
  const engine = m.engine || '';
  if (!engine.startsWith('tool:')) {
    const go = await window.bdsModal.confirm(`O módulo "${m.title}" precisa de um componente que ainda não está instalado. Abrir a instalação agora?`);
    if (go) {
      requestSub(AI_VIEW_ID, 'local');
      document.querySelector('.settings-tab[data-tab="settingsAiView"]')?.click();
    }
    return;
  }
  const go = await window.bdsModal.confirm(`O módulo "${m.title}" precisa baixar um componente para recuperar vídeos danificados (download da fonte oficial). Baixar agora?`);
  if (!go) return;
  setStatus('Baixando o componente de recuperação de vídeo...');
  try {
    const tool = engine.slice(5);
    const result = await window.bds.updateTool(tool, { allowUnverified: false });
    if (result && result.needsConfirmation) {
      const again = await window.bdsModal.confirm('A fonte deste componente não publica dados de verificação de integridade, então não é possível conferir o download. Instalar mesmo assim?');
      if (!again) { setStatus('Instalação cancelada.'); return; }
      await window.bds.updateTool(tool, { allowUnverified: true });
    }
    setStatus('Componente de recuperação de vídeo instalado.');
  } catch (err) {
    setStatus(`Não foi possível instalar o componente. ${friendlyError(err, 'Verifique a conexão e tente de novo.')}`);
  }
  await loadModulesList();
}

/**
 * Itens das Configurações que dependem dos módulos ligados: a seção Inteligência Artificial (módulo
 * Transcrição OU Assistente de IA), o cartão do Assistente e as telas oferecidas como "Tela inicial".
 */
function applyModuleDependentUi(list) {
  if (!Array.isArray(list)) return;
  const on = (id) => list.some((m) => m.id === id && m.enabled === true);
  const showAi = on('transcription') || on('ai');
  const tab = document.querySelector('.settings-tab[data-tab="settingsAiView"]');
  tab?.classList.toggle('st-devhidden', !showAi);
  document.getElementById('settingsAiView')?.classList.toggle('st-devhidden', !showAi);
  document.getElementById('settingsAssistantCard')?.classList.toggle('hidden', !on('ai'));
  if (!showAi && tab?.classList.contains('active')) {
    document.querySelector('.settings-tab[data-tab="settingsGeneralView"]')?.click();
  }

  // Cartões e abas ligados a uma tela somem quando o módulo dela está desligado ([data-module="<id>"])
  document.querySelectorAll('[data-module]').forEach((el) => el.classList.toggle('st-devhidden', !on(el.dataset.module)));
  refreshSubnavs(); // itens do submenu sem cartão visível somem (ex.: Downloads com o módulo desligado)
  const activeTab = document.querySelector('.settings-tab.active');
  if (activeTab?.classList.contains('st-devhidden')) document.querySelector('.settings-tab[data-tab="settingsGeneralView"]')?.click();

  // Tela inicial: só telas de módulos ligados (telas de desenvolvimento ausentes da lista ficam ocultas)
  const select = document.getElementById('defaultStartScreenInput');
  if (!select) return;
  const managed = new Map();
  list.forEach((m) => (m.screens || []).forEach((sc) => managed.set(sc, m.enabled === true)));
  const devScreens = ['montage', 'recovery'];
  [...select.options].forEach((opt) => {
    const allowed = managed.has(opt.value) ? managed.get(opt.value) : !devScreens.includes(opt.value);
    opt.hidden = !allowed;
    opt.disabled = !allowed;
  });
  if (select.selectedOptions[0]?.disabled) select.value = 'home';
}

/** Lê os módulos e aplica o que depende deles (seção de IA, tela inicial). */
async function refreshModuleDependentUi() {
  try {
    const r = await window.bds.modulesList();
    if (r && r.ok) { modulesCache = r.data; applyModuleDependentUi(r.data); }
  } catch (_) { /* mantém o estado atual */ }
}

/* ==========================================================================
   PAINEL DE TRANSCRIÇÃO (motor, modelos e GPU)
   ========================================================================== */
let modulesPanel = null;
let analysisPanel = null;

async function mountTranscriptionPanel() {
  const host = document.getElementById('settingsTranscriptionPanel');
  if (!host) return;
  try {
    modulesPanel = modulesPanel || await import('../components/modules-panel.js');
    await modulesPanel.mountModulesPanel(host);
  } catch (err) {
    console.error('[SETTINGS] Falha ao carregar o painel de transcrição:', err);
    host.textContent = 'Não foi possível carregar o painel de transcrição.';
  }
}

/** Servidor de IA (seção Inteligência Artificial): um erro aqui não afeta o resto das Configurações. */
async function mountAiPanel() {
  const aiHost = document.getElementById('settingsAnalysisPanel');
  if (!aiHost) return;
  try {
    analysisPanel = analysisPanel || await import('../components/analysis-panel.js');
    await analysisPanel.mountAnalysisPanel(aiHost);
  } catch (err) {
    console.error('[SETTINGS] Falha ao carregar o painel do servidor de IA:', err);
    aiHost.textContent = 'Não foi possível carregar a configuração da IA.';
  }
}

function unmountTranscriptionPanel() {
  try { modulesPanel?.unmountModulesPanel(); } catch (_) { /* noop */ }
}

function unmountAiPanel() {
  try { analysisPanel?.unmountAnalysisPanel(); } catch (_) { /* noop */ }
}

/* ==========================================================================
   RENDERIZAÇÃO INICIAL
   ========================================================================== */
function renderSettings() {
  const s = state.settings;
  if (!s) return;

  const setVal = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value || '';
  };
  const setChk = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.checked = Boolean(value);
  };

  setVal('mp3FolderInput', s.mp3Folder);
  setVal('mp4FolderInput', s.mp4Folder);
  setVal('obsFolderInput', s.obsFolder);
  setVal('shadowplayFolderInput', s.shadowplayFolder);
  renderDetectedRecordingFolders(lastDetectedFolders); // só redesenha as dicas com o último resultado; a detecção roda por conta própria
  setVal('deviceFolderInput', s.deviceFolder);
  setChk('checkUpdatesOnStartInput', s.checkUpdatesOnStart);
  setVal('updateServerUrlInput', s.updateServerUrl);

  // Upload para YouTube (pasta do scanner de mídias)
  setVal('uploadsFolderInput', s.uploadsFolder);

  // Relatório de erros / telemetria
  setChk('errorReportingEnabledInput', s.errorReportingEnabled !== false);
  setChk('notificationsEnabledInput', s.notificationsEnabled !== false);
  setChk('notifyDownloadsInput', s.notifyDownloads !== false);
  setChk('notifyConverterInput', s.notifyConverter !== false);
  setChk('notifyCopyInput', s.notifyCopy !== false);
  setChk('notifySilenceInput', s.notifySilence !== false);
  setChk('notifyDeadlinesInput', s.notifyDeadlines !== false);

  // Pausa entre downloads da lista
  setVal('downloadVideoCodecSelect', ['h264', 'h265', 'av1'].includes(s.downloadVideoCodec) ? s.downloadVideoCodec : 'auto');
  setChk('downloadPauseEnabledInput', s.downloadPauseEnabled !== false);
  setChk('useYoutubeAccountInput', s.useYoutubeAccount === true);
  setChk('playlistFoldersInput', s.playlistFolders !== false);
  setVal('downloadPauseMinInput', s.downloadPauseMinSec ?? 10);
  setVal('downloadPauseMaxInput', s.downloadPauseMaxSec ?? 180);
  syncDownloadPauseRange();

  // Envio automático para o YouTube
  setChk('uploadAutoEnabledInput', s.uploadAutoEnabled === true);
  setChk('uploadPauseEnabledInput', s.uploadPauseEnabled !== false);
  setVal('uploadPauseMinInput', s.uploadPauseMinSec ?? 60);
  setVal('uploadPauseMaxInput', s.uploadPauseMaxSec ?? 300);
  setVal('uploadDailyLimitInput', s.uploadDailyLimit ?? 10);
  setVal('uploadDefaultVisibilitySelect', ['private', 'unlisted', 'public'].includes(s.uploadDefaultVisibility) ? s.uploadDefaultVisibility : 'private');
  syncUploadOptions();

  // Antecedência e horário do lembrete de prazo
  const leadSelect = document.getElementById('deadlineNotifyLeadDaysInput');
  if (leadSelect) leadSelect.value = String(s.deadlineNotifyLeadDays ?? 5);
  const timeInput = document.getElementById('deadlineNotifyTimeInput');
  if (timeInput) timeInput.value = s.deadlineNotifyTime || '09:00';

  // Tema e cor de destaque
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) themeSelect.value = s.theme || 'dark';

  const accentInput = document.getElementById('accentColorInput');
  if (accentInput) accentInput.value = normalizeAccentHex(s.accentColor);

  // Armazenamento (cache)
  setChk('cacheAutoCleanInput', s.cacheAutoClean);
  const cacheMaxSize = document.getElementById('cacheMaxSizeInput');
  if (cacheMaxSize) cacheMaxSize.value = s.cacheMaxSizeMB || 500;

  // LUTs Preview Image
  setVal('lutPreviewImageInput', s.lutPreviewImage);
  const lutThumb = document.getElementById('settingsLutPreviewThumb');
  if (lutThumb) {
    lutThumb.src = s.lutPreviewImage ? toFileUrl(s.lutPreviewImage) : './assets/lut_preview.jpg';
  }

  // Aceleração de Hardware (GPU)
  setChk('useHardwareAccelerationInput', s.useHardwareAcceleration !== false);
  const hwVendor = document.getElementById('preferredGpuVendorInput');
  if (hwVendor) hwVendor.value = s.preferredGpuVendor || 'auto';

  // Interface e janela
  setVal('converterFolderInput', s.converterFolder);
  const startScreen = document.getElementById('defaultStartScreenInput');
  if (startScreen) startScreen.value = s.defaultStartScreen || 'home';
  setChk('reduceMotionInput', s.reduceMotion === true);
  setChk('rememberWindowBoundsInput', s.rememberWindowBounds === true);
  renderSidebarOrderList();

  // Padrões do Conversor
  const setSel = (id, value, fallback) => {
    const el = document.getElementById(id);
    if (el) el.value = [...el.options].some(o => o.value === String(value)) ? String(value) : fallback;
  };
  setSel('converterDefaultFormatInput', s.converterDefaultFormat, 'mp4');
  setSel('converterDefaultCodecInput', s.converterDefaultCodec, 'libx264');
  setSel('converterDefaultResolutionInput', s.converterDefaultResolution, 'original');
  setSel('converterDefaultAudioBitrateInput', s.converterDefaultAudioBitrate, '192k');
  const vBitrate = document.getElementById('converterDefaultVideoBitrateInput');
  if (vBitrate) vBitrate.value = s.converterDefaultVideoBitrate || 10;

  syncNotifyModules();
  syncAccentSwatches();
}

/* ==========================================================================
   EVENTOS
   ========================================================================== */
/** Esmaece os campos de tempo quando a pausa entre downloads está desligada. */
function syncDownloadPauseRange() {
  const on = document.getElementById('downloadPauseEnabledInput')?.checked !== false;
  const box = document.getElementById('downloadPauseRange');
  if (box) box.style.opacity = on ? '' : '0.5';
  for (const id of ['downloadPauseMinInput', 'downloadPauseMaxInput']) {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  }
}

/** Esmaece as opções do envio automático quando ele (ou a pausa entre envios) está desligado. */
function syncUploadOptions() {
  const on = document.getElementById('uploadAutoEnabledInput')?.checked === true;
  const pauseOn = document.getElementById('uploadPauseEnabledInput')?.checked !== false;
  const box = document.getElementById('uploadAutoOptions');
  if (box) box.style.opacity = on ? '' : '0.5';
  const range = document.getElementById('uploadPauseRange');
  if (range) range.style.opacity = on && pauseOn ? '' : '0.5';
  for (const id of ['uploadPauseEnabledInput', 'uploadDailyLimitInput', 'uploadDefaultVisibilitySelect']) {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  }
  for (const id of ['uploadPauseMinInput', 'uploadPauseMaxInput']) {
    const el = document.getElementById(id);
    if (el) el.disabled = !(on && pauseOn);
  }
}

/* ==========================================================================
   PASTAS DE GRAVAÇÃO DETECTADAS (OBS Studio por perfil e NVIDIA App)
   A detecção é automática (sem botão): ao abrir a tela, ao voltar o foco para a janela e ao esvaziar um campo manual.
   O resultado aparece na dica de cada campo (aria-live). O processo principal só reinicia os monitores de pasta quando
   a detecção muda alguma biblioteca de verdade; aqui o intervalo mínimo evita ler a configuração à toa.
   ========================================================================== */
const DETECT_MIN_INTERVAL_MS = 10000;
let detectingRecordingFolders = false;
let detectAgainAfter = false;
let lastDetectedFolders = null;
let lastDetectionAt = 0;
let detectFocusHandler = null;

/** Mostra embaixo dos campos o que a detecção encontrou (o campo em branco significa "automático"). */
function renderDetectedRecordingFolders(detected, { failed = false } = {}) {
  const obsHint = document.getElementById('obsDetectedHint');
  const spHint = document.getElementById('shadowplayDetectedHint');
  if (!obsHint || !spHint) return;
  const obsInput = document.getElementById('obsFolderInput');
  const spInput = document.getElementById('shadowplayFolderInput');
  const manualObs = !!obsInput?.value.trim();
  const manualSp = !!spInput?.value.trim();
  // lembra se o campo estava preenchido: esvaziá-lo é o que dispara uma nova detecção (onRecordingFolderInput)
  if (obsInput) obsInput.dataset.manual = manualObs ? '1' : '';
  if (spInput) spInput.dataset.manual = manualSp ? '1' : '';

  const profiles = detected?.obs?.profiles || [];
  if (manualObs) obsHint.textContent = 'Pasta definida manualmente: a detecção automática fica desligada para o OBS.';
  else if (!detected) obsHint.textContent = failed ? 'Não foi possível detectar a pasta do OBS agora.' : '';
  else if (!detected.obs?.configDir) obsHint.textContent = 'OBS Studio não encontrado neste computador.';
  else if (!profiles.length) obsHint.textContent = 'Nenhuma pasta de gravação encontrada nos perfis do OBS.';
  else obsHint.textContent = 'Detectado do OBS: ' + profiles.map((p) => `${p.profile}${p.active ? ' (ativo)' : ''} → ${p.path}`).join(' · ');

  if (manualSp) spHint.textContent = 'Pasta definida manualmente: a detecção automática fica desligada para o ShadowPlay.';
  else if (!detected) spHint.textContent = failed ? 'Não foi possível detectar a pasta do NVIDIA App agora.' : '';
  else if (detected.shadowplay?.path) spHint.textContent = `Detectado do NVIDIA App: ${detected.shadowplay.path}`;
  else spHint.textContent = 'NVIDIA App não encontrado neste computador.';
}

/**
 * Pede ao processo principal para detectar (e ressincronizar as bibliotecas automáticas). Sem `force`, respeita o
 * intervalo mínimo desde a última leitura; com `force`, lê já (e, se uma leitura estiver em andamento, lê de novo no fim).
 */
async function detectRecordingFolders({ force = false } = {}) {
  if (typeof window.bds?.detectRecordingFolders !== 'function') return;
  if (detectingRecordingFolders) { if (force) detectAgainAfter = true; return; }
  if (!force && Date.now() - lastDetectionAt < DETECT_MIN_INTERVAL_MS) return;
  detectingRecordingFolders = true;
  try {
    const detected = await window.bds.detectRecordingFolders();
    lastDetectedFolders = detected || null;
    renderDetectedRecordingFolders(lastDetectedFolders);
  } catch (err) {
    console.error('[SETTINGS] Erro ao detectar pastas de gravação:', err);
    if (!lastDetectedFolders) renderDetectedRecordingFolders(null, { failed: true });
  } finally {
    lastDetectionAt = Date.now();
    detectingRecordingFolders = false;
    if (detectAgainAfter) { detectAgainAfter = false; detectRecordingFolders({ force: true }); }
  }
}

/** Digitar nos campos do OBS e do ShadowPlay: a dica acompanha o que está escrito; esvaziar um campo manual detecta de novo. */
function onRecordingFolderInput(e) {
  const input = e.currentTarget;
  const wasManual = input.dataset.manual === '1';
  renderDetectedRecordingFolders(lastDetectedFolders);
  if (wasManual && !input.value.trim()) detectRecordingFolders({ force: true });
}

/** Ao voltar o foco para a janela com a tela aberta, detecta de novo (a pessoa pode ter mexido no OBS ou no NVIDIA App). */
function setupRecordingFolderDetection() {
  if (detectFocusHandler) window.removeEventListener('focus', detectFocusHandler);
  detectFocusHandler = () => { detectRecordingFolders(); };
  window.addEventListener('focus', detectFocusHandler);
  detectRecordingFolders();
}

function teardownRecordingFolderDetection() {
  if (detectFocusHandler) { window.removeEventListener('focus', detectFocusHandler); detectFocusHandler = null; }
}

function bindEvents() {
  document.getElementById('downloadPauseEnabledInput')?.addEventListener('change', syncDownloadPauseRange);
  document.getElementById('uploadAutoEnabledInput')?.addEventListener('change', syncUploadOptions);
  document.getElementById('uploadPauseEnabledInput')?.addEventListener('change', syncUploadOptions);
  document.getElementById('btnYoutubeSignOut')?.addEventListener('click', signOutYoutube);

  // Exibe/oculta os ajustes de lembrete de prazo conforme o checkbox ativo
  const deadlineChk = document.getElementById('notifyDeadlinesInput');
  const deadlineGroup = document.getElementById('deadlineSettingsGroup');
  const deadlineTimeRow = document.getElementById('deadlineNotifyTimeRow');
  if (deadlineChk) {
    const syncDeadlineGroup = () => {
      const visible = !!deadlineChk.checked;
      if (deadlineGroup) deadlineGroup.style.display = visible ? '' : 'none';
      if (deadlineTimeRow) deadlineTimeRow.style.display = visible ? '' : 'none';
    };
    deadlineChk.addEventListener('change', syncDeadlineGroup);
    syncDeadlineGroup();
  }

  document.getElementById('mp3FolderButton')?.addEventListener('click', () => chooseFolder('mp3FolderInput'));
  document.getElementById('mp4FolderButton')?.addEventListener('click', () => chooseFolder('mp4FolderInput'));
  document.getElementById('obsFolderButton')?.addEventListener('click', () => chooseFolder('obsFolderInput'));
  for (const id of ['obsFolderInput', 'shadowplayFolderInput']) {
    document.getElementById(id)?.addEventListener('input', onRecordingFolderInput);
  }
  document.getElementById('shadowplayFolderButton')?.addEventListener('click', () => chooseFolder('shadowplayFolderInput'));
  document.getElementById('deviceFolderButton')?.addEventListener('click', () => chooseFolder('deviceFolderInput'));
  document.getElementById('converterFolderButton')?.addEventListener('click', () => chooseFolder('converterFolderInput'));
  for (const [buttonId, pairs] of Object.entries(FOLDER_RESET_PAIRS)) {
    document.getElementById(buttonId)?.addEventListener('click', () => restoreDefaultFolders(pairs));
  }

  // Pasta de uploads do YouTube — seleciona a pasta, escaneia os vídeos e persiste no save
  document.getElementById('uploadsFolderButton')?.addEventListener('click', async () => {
    const input = document.getElementById('uploadsFolderInput');
    const folder = await window.bds.selectFolder(input?.value || '');
    if (!folder) return;
    if (input) { input.value = folder; input.dispatchEvent(new Event('input', { bubbles: true })); }
    try {
      await window.bds.uploadScanDirectory(folder);
    } catch (err) {
      console.error('[SETTINGS] Erro ao escanear a pasta de uploads:', err);
    }
  });

  // Relatórios de erros e suporte: enviar (fora do menu) e, no menu "⋯", apagar e exportar os logs. O resultado de cada
  // ação fica escrito no cartão (#supportResult); erros e a confirmação de apagar continuam em diálogo.
  setupOverflowMenu(document.getElementById('supportMenuButton'), document.getElementById('supportMenu'));
  document.getElementById('sendCrashReportsButton')?.addEventListener('click', sendCrashReports);
  document.getElementById('clearCrashReportsButton')?.addEventListener('click', async () => {
    if (typeof window.bds?.clearCrashReports !== 'function') return;
    const confirmed = await window.bdsModal.confirm(
      'Apagar os relatórios de erro guardados neste computador?\n\nEles deixam de poder ser enviados ao desenvolvedor. Esta ação não pode ser desfeita.'
    );
    if (!confirmed) return;
    setResult('supportResult', '');
    try {
      const result = await window.bds.clearCrashReports();
      await loadCrashReports();
      const n = result && result.deleted > 0 ? result.deleted : 0;
      setResult('supportResult', n > 0
        ? `${n} ${n === 1 ? 'relatório removido' : 'relatórios removidos'}.`
        : 'Não havia relatórios para apagar.');
    } catch (err) {
      console.error('[SETTINGS] Erro ao limpar relatórios:', err);
      window.bdsModal.alert('Não foi possível limpar os relatórios. Tente novamente.');
    }
  });

  // LUTs, cartão Coleção: o ícone dentro do campo e o clique (ou Enter) no campo somente leitura abrem a pasta das LUTs
  document.getElementById('lutsFolderOpenBtn')?.addEventListener('click', openLutsCollectionFolder);
  const lutsFolderInput = document.getElementById('lutsFolderInput');
  lutsFolderInput?.addEventListener('click', openLutsCollectionFolder);
  lutsFolderInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation(); // aqui o Enter abre a pasta (nos outros campos ele salva)
    openLutsCollectionFolder();
  });

  // LUTs: imagem de referência. O ícone dentro do campo, o clique (ou Enter) no campo somente leitura e o clique na miniatura abrem o seletor
  document.getElementById('lutPreviewImageSelectBtn')?.addEventListener('click', chooseLutPreviewImage);
  document.getElementById('settingsLutPreviewThumbBox')?.addEventListener('click', chooseLutPreviewImage);
  const lutInput = document.getElementById('lutPreviewImageInput');
  lutInput?.addEventListener('click', chooseLutPreviewImage);
  lutInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation(); // aqui o Enter abre o seletor (nos outros campos ele salva)
    chooseLutPreviewImage();
  });

  document.getElementById('lutPreviewImageResetBtn')?.addEventListener('click', () => {
    const input = document.getElementById('lutPreviewImageInput');
    if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
    const thumb = document.getElementById('settingsLutPreviewThumb');
    if (thumb) thumb.src = './assets/lut_preview.jpg';
    finishReset(input);
  });

  // Tema — aplica preview imediato ao trocar
  document.getElementById('themeSelect')?.addEventListener('change', (e) => {
    const accentColor = document.getElementById('accentColorInput')?.value || state.settings?.accentColor || '#ff0000';
    applyTheme(e.target.value, accentColor);
  });

  // Atualizações: um botão só, que muda de papel (verificar, baixar e atualizar, reiniciar para instalar)
  pendingInstall = null;
  releaseNotes = null;
  document.getElementById('updateActionButton')?.addEventListener('click', onUpdateAction);

  // Exportar logs de diagnóstico: o caminho do arquivo salvo fica escrito no cartão (selecionável) para mandar ao suporte
  document.getElementById('exportLogsButton')?.addEventListener('click', async () => {
    setResult('supportResult', 'Exportando os registros de diagnóstico…');
    try {
      setStatus('Exportando registros de diagnóstico...');
      const res = await window.bds.exportDiagnosticLogs();
      if (res && res.success) {
        setStatus('Registros exportados com sucesso.');
        setResult('supportResult', 'Registros exportados para:', res.exportPath);
      } else {
        setResult('supportResult', '');
        if (!res?.cancelled) window.bdsModal.alert('Não foi possível exportar os registros. Tente de novo em outra pasta.');
      }
    } catch (e) {
      console.error('[SETTINGS] Erro ao exportar logs:', e);
      setResult('supportResult', '');
      window.bdsModal.alert(`Não foi possível exportar os registros. ${friendlyError(e)}`);
    }
  });

  // Limpar Banco de Dados
  document.getElementById('clearDbButton')?.addEventListener('click', async () => {
    const ok = await window.bdsModal.confirm(
      'Limpar o catálogo da biblioteca?\n\n' +
      'O que será apagado: favoritos, tags e a lista de mídias já lidas. As pastas serão lidas de novo do zero, o que pode demorar em bibliotecas grandes.\n\n' +
      'O que NÃO será apagado: seus vídeos, áudios e fotos no disco.\n\n' +
      'O BDS guarda um backup antes de limpar. Esta ação não pode ser desfeita pelo aplicativo.'
    );
    if (!ok) return;
    setResult('dbResult', '');
    const restore = setButtonBusy(document.getElementById('clearDbButton'), 'Limpando…');
    try {
      setStatus('Limpando o catálogo da biblioteca...');
      await window.bds.clearLibraryDatabase();
      setStatus('Catálogo da biblioteca limpo.');
      setResult('dbResult', 'Pronto. O catálogo foi limpo e as pastas serão lidas de novo do zero. Seus arquivos continuam no disco.');
    } catch (e) {
      if (/cancelad/i.test(e?.message || '')) { setStatus('Limpeza cancelada. Nada foi apagado.'); setResult('dbResult', 'Limpeza cancelada. Nada foi apagado.'); return; }
      setStatus('Não foi possível limpar o catálogo.');
      window.bdsModal.alert(`Não foi possível limpar o catálogo da biblioteca. ${friendlyError(e)}`);
    } finally {
      restore();
    }
  });

  // Armazenamento — Limpar tudo (o tamanho é relido sozinho ao abrir o subpainel e depois de cada limpeza)
  document.getElementById('clearCacheButton')?.addEventListener('click', async () => {
    const ok = await window.bdsModal.confirm(
      'Limpar todo o armazenamento temporário?\n\n' +
      'Serão removidos: miniaturas, ondas de áudio e arquivos de rascunho que o BDS criou para ficar mais rápido.\n\n' +
      'Não serão afetados: seus vídeos, projetos e arquivos convertidos. O BDS recria o que precisar, e a primeira abertura de pastas grandes pode ficar um pouco mais lenta.'
    );
    if (!ok) return;
    await runCacheClear(null, 'o armazenamento temporário', document.getElementById('clearCacheButton'));
  });

  // Armazenamento — Limpar categoria individual (delegação de eventos)
  const cacheList = document.getElementById('cacheCategoriesList');
  if (cacheList) {
    cacheList.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-clear-cache]');
      if (!btn) return;
      const key = btn.dataset.clearCache;
      const label = btn.dataset.label;
      const ok = await window.bdsModal.confirm(`Limpar "${label}"?\n\nSeus vídeos e projetos não são afetados. O BDS recria esses arquivos quando precisar deles.`);
      if (!ok) return;
      await runCacheClear(key, `"${label}"`, btn);
    });
  }

}

/** Limpa o armazenamento (tudo ou uma categoria) com botão ocupado, resultado na tela e erro em linguagem simples. */
async function runCacheClear(key, what, button) {
  const all = [document.getElementById('clearCacheButton')];
  const others = [...document.querySelectorAll('button[data-clear-cache]')].filter((b) => b !== button);
  // O botão pode ser trocado pela releitura da lista: guarda se o foco estava nele para devolvê-lo ao equivalente no fim
  const hadFocus = !!button && button.ownerDocument.activeElement === button;
  [...all, ...others].forEach((b) => { if (b && b !== button) b.disabled = true; });
  const restore = setButtonBusy(button, 'Limpando…');
  const result = document.getElementById('cacheResult');
  if (result) result.textContent = `Limpando ${what}…`;
  try {
    setStatus(`Limpando ${what}...`);
    const r = await window.bds.clearCache(key);
    const msg = `Concluído: ${r.totalFormatted} liberados.`;
    setStatus(`Armazenamento limpo. ${msg}`);
    if (result) result.textContent = `${msg} (${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })})`;
  } catch (e) {
    setStatus('Não foi possível limpar o armazenamento.');
    if (result) result.textContent = 'Não foi possível limpar.';
    window.bdsModal.alert(`Não foi possível limpar ${what}. ${friendlyError(e, 'Feche tarefas em andamento (downloads, conversões) e tente de novo.')}`);
  } finally {
    restore();
    [...all, ...others].forEach((b) => { if (b) b.disabled = false; });
    await loadCacheInfo();
    if (hadFocus || document.activeElement === document.body) {
      const next = key ? [...document.querySelectorAll('button[data-clear-cache]')].find((b) => b.dataset.clearCache === key) : button;
      (next || document.getElementById('clearCacheButton'))?.focus();
    }
  }
}

/** Aviso visível (toast); o texto de status do app não existe nesta tela. */
function notify(message, type) {
  if (typeof window.bdsToast === 'function') window.bdsToast(message, { type });
  else setStatus(message);
}

/** Sair da conta do YouTube: apaga o login do navegador embutido e a sessão guardada (pede confirmação). */
async function signOutYoutube() {
  const btn = document.getElementById('btnYoutubeSignOut');
  const ok = await window.bdsModal.confirm('Sair da conta do YouTube neste computador?\n\nO login é encerrado e a sessão guardada é apagada. Para usar a conta de novo, será preciso entrar outra vez pela aba Envio.');
  if (!ok) return;
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  try {
    const r = await window.bds.youtubeSignOut();
    if (r && r.success) notify('Você saiu da conta do YouTube.', 'success');
    else notify((r && r.error) || 'Não foi possível sair da conta.', 'error');
  } catch (err) {
    notify((err && err.message) || 'Não foi possível sair da conta.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  }
}

/** "Restaurar padrão": põe nos campos as pastas padrão do app. Só vale depois de Salvar (como ao escolher uma pasta). */
async function restoreDefaultFolders(pairs) {
  try {
    const defaults = await window.bds.getDefaultFolders();
    if (defaults && typeof defaults === 'object') { defaultFoldersCache = defaults; syncFolderResetTitles(); }
    let changed = 0;
    for (const [inputId, key] of pairs) {
      const input = document.getElementById(inputId);
      if (!input || !defaults || !defaults[key]) continue;
      input.value = defaults[key];
      input.dispatchEvent(new Event('input', { bubbles: true }));
      changed++;
    }
    if (changed) {
      notify('Pasta padrão restaurada. Clique em Salvar para aplicar.', 'success');
      finishReset(document.getElementById(pairs[0][0]));
    }
  } catch (error) {
    console.error('[SETTINGS] Erro ao restaurar a pasta padrão:', error);
    notify('Não foi possível restaurar a pasta padrão.', 'error');
  }
}

/* ==========================================================================
   LUTs: cartão "Coleção de LUTs" (pasta, quantas LUTs e abrir a pasta)
   ========================================================================== */
let lutsInfoSeq = 0;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "40 LUTs em 3 pastas; 2 avisos." (pastas e avisos só aparecem quando há). */
function describeLutsInfo(info) {
  const count = Number(info.count) || 0;
  const groups = Number(info.groups) || 0;
  const warnings = Number(info.problemCount != null ? info.problemCount : (Array.isArray(info.problems) ? info.problems.length : 0)) || 0;
  let text = count === 0 ? 'Nenhuma LUT na pasta' : `${plural(count, 'LUT', 'LUTs')}${groups ? ` em ${plural(groups, 'pasta', 'pastas')}` : ''}`;
  if (warnings) text += `; ${plural(warnings, 'aviso', 'avisos')}`;
  return `${text}.`;
}

/** Lê o resumo da coleção no processo principal e o mostra no cartão (só vale a leitura mais nova). */
async function loadLutsInfo() {
  const input = document.getElementById('lutsFolderInput');
  const summary = document.getElementById('lutsCollectionSummary');
  if (!input || !summary || !window.bds || typeof window.bds.getLutsInfo !== 'function') return;
  const seq = ++lutsInfoSeq;
  try {
    const info = await window.bds.getLutsInfo();
    if (seq !== lutsInfoSeq || !info) return;
    input.value = info.folder || '';
    input.title = info.folder || '';
    summary.textContent = describeLutsInfo(info);
    const problems = document.getElementById('lutsCollectionProblems');
    if (problems) {
      const list = (Array.isArray(info.problems) ? info.problems : []).slice(0, 3).map((p) => (p.name ? `${p.name} (${p.reason})` : p.reason));
      problems.textContent = list.length ? `Atenção: ${list.join('; ')}${(Number(info.problemCount) || list.length) > list.length ? ' e mais' : ''}.` : '';
      problems.hidden = !list.length;
    }
  } catch (err) {
    if (seq !== lutsInfoSeq) return;
    console.error('[SETTINGS] Erro ao ler a coleção de LUTs:', err);
    summary.textContent = friendlyError(err, 'Não foi possível ler a pasta de LUTs.');
  }
}

async function openLutsCollectionFolder() {
  const status = document.getElementById('lutsCollectionStatus');
  try {
    await window.bds.openLutsFolder();
    if (status) status.textContent = '';
  } catch (err) {
    console.error('[SETTINGS] Erro ao abrir a pasta das LUTs:', err);
    if (status) status.textContent = friendlyError(err, 'Não foi possível abrir a pasta das LUTs.');
  }
}

/** Escolhe a imagem de referência do comparador de LUTs (campo somente leitura + miniatura). */
async function chooseLutPreviewImage() {
  try {
    const files = await window.bds.selectFiles({
      title: 'Selecionar Imagem de Referência para LUTs',
      filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
      properties: ['openFile']
    });
    if (files && files.length > 0) {
      const filePath = files[0];
      const input = document.getElementById('lutPreviewImageInput');
      if (input) { input.value = filePath; input.dispatchEvent(new Event('input', { bubbles: true })); }
      const thumb = document.getElementById('settingsLutPreviewThumb');
      if (thumb) thumb.src = toFileUrl(filePath);
    }
  } catch (err) {
    console.error('[SETTINGS] Erro ao selecionar imagem de LUT:', err);
  }
}

async function chooseFolder(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  try {
    const folder = await window.bds.selectFolder(input.value);
    if (folder) { input.value = folder; input.dispatchEvent(new Event('input', { bubbles: true })); }
  } catch (error) {
    console.error('[SETTINGS] Erro ao selecionar pasta:', error);
  }
}

async function saveSettings() {
  if (!validateAllFields()) {
    setStatus('Corrija os campos destacados antes de salvar.');
    return;
  }
  try {
    setStatus('Salvando configurações...');
    const updatedSettings = await window.bds.saveSettings({
      mp3Folder: document.getElementById('mp3FolderInput')?.value,
      mp4Folder: document.getElementById('mp4FolderInput')?.value,
      obsFolder: document.getElementById('obsFolderInput')?.value,
      shadowplayFolder: document.getElementById('shadowplayFolderInput')?.value,
      deviceFolder: document.getElementById('deviceFolderInput')?.value,
      uploadsFolder: document.getElementById('uploadsFolderInput')?.value,
      checkUpdatesOnStart: document.getElementById('checkUpdatesOnStartInput')?.checked,
      ...(document.getElementById('updateServerUrlInput') ? { updateServerUrl: document.getElementById('updateServerUrlInput').value.trim() } : {}),
      notificationsEnabled: document.getElementById('notificationsEnabledInput')?.checked,
      notifyDownloads: document.getElementById('notifyDownloadsInput')?.checked,
      notifyConverter: document.getElementById('notifyConverterInput')?.checked,
      notifyCopy: document.getElementById('notifyCopyInput')?.checked,
      notifySilence: document.getElementById('notifySilenceInput')?.checked,
      downloadVideoCodec: document.getElementById('downloadVideoCodecSelect')?.value || 'auto',
      downloadPauseEnabled: document.getElementById('downloadPauseEnabledInput')?.checked !== false,
      useYoutubeAccount: document.getElementById('useYoutubeAccountInput')?.checked === true,
      playlistFolders: document.getElementById('playlistFoldersInput')?.checked !== false,
      downloadPauseMinSec: Number(document.getElementById('downloadPauseMinInput')?.value),
      downloadPauseMaxSec: Number(document.getElementById('downloadPauseMaxInput')?.value),
      uploadAutoEnabled: document.getElementById('uploadAutoEnabledInput')?.checked === true,
      uploadPauseEnabled: document.getElementById('uploadPauseEnabledInput')?.checked !== false,
      uploadPauseMinSec: Number(document.getElementById('uploadPauseMinInput')?.value),
      uploadPauseMaxSec: Number(document.getElementById('uploadPauseMaxInput')?.value),
      uploadDailyLimit: Number(document.getElementById('uploadDailyLimitInput')?.value),
      uploadDefaultVisibility: document.getElementById('uploadDefaultVisibilitySelect')?.value || 'private',
      notifyDeadlines: document.getElementById('notifyDeadlinesInput')?.checked,
      deadlineNotifyLeadDays: Number(document.getElementById('deadlineNotifyLeadDaysInput')?.value) || 5,
      deadlineNotifyTime: document.getElementById('deadlineNotifyTimeInput')?.value || '09:00',
      theme: document.getElementById('themeSelect')?.value || 'dark',
      accentColor: normalizeAccentHex(document.getElementById('accentColorInput')?.value),
      lutPreviewImage: document.getElementById('lutPreviewImageInput')?.value || '',
      errorReportingEnabled: document.getElementById('errorReportingEnabledInput')?.checked,
      useHardwareAcceleration: document.getElementById('useHardwareAccelerationInput')?.checked !== false,
      preferredGpuVendor: document.getElementById('preferredGpuVendorInput')?.value || 'auto',
      cacheAutoClean: document.getElementById('cacheAutoCleanInput')?.checked === true,
      cacheMaxSizeMB: Number(document.getElementById('cacheMaxSizeInput')?.value) || 500,
      converterFolder: document.getElementById('converterFolderInput')?.value || '',
      defaultStartScreen: document.getElementById('defaultStartScreenInput')?.value || 'home',
      sidebarOrder: collectSidebarOrder(),
      reduceMotion: document.getElementById('reduceMotionInput')?.checked === true,
      rememberWindowBounds: document.getElementById('rememberWindowBoundsInput')?.checked === true,
      converterDefaultFormat: document.getElementById('converterDefaultFormatInput')?.value,
      converterDefaultCodec: document.getElementById('converterDefaultCodecInput')?.value,
      converterDefaultResolution: document.getElementById('converterDefaultResolutionInput')?.value,
      converterDefaultVideoBitrate: Number(document.getElementById('converterDefaultVideoBitrateInput')?.value) || 10,
      converterDefaultAudioBitrate: document.getElementById('converterDefaultAudioBitrateInput')?.value,
    });
    state.settings = updatedSettings;
    // Confirma o tema e as preferências após salvar (garante consistência)
    applyTheme(updatedSettings.theme, updatedSettings.accentColor);
    applyUiPreferences(updatedSettings);
    setStatus('Configurações salvas com sucesso.');
    markSettingsSaved();
  } catch (error) {
    setStatus('Erro ao salvar as configurações.');
    window.bdsModal.alert(`Não foi possível salvar as configurações. ${friendlyError(error, 'Tente novamente.')}`);
  }
}

/* ==========================================================================
   NOVO LAYOUT: busca, alterações não salvas, prévias e extras
   ========================================================================== */

const normalizeText = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

let settingsDirty = false;
let savedBarTimer = null;

/** Apaga os módulos de notificação quando o interruptor geral está desligado. */
function syncNotifyModules() {
  const on = document.getElementById('notificationsEnabledInput')?.checked !== false;
  document.getElementById('notifyModulesGroup')?.classList.toggle('st-disabled', !on);
}

/* ==========================================================================
   MENU LATERAL: ordem das telas (e atalhos Ctrl+1..9, que seguem essa ordem)
   A lista na tela é a fonte da ordem pendente; só vira configuração ao salvar.
   ========================================================================== */

/** Desenha a lista a partir do menu real (abas visíveis, na ordem atual). */
function renderSidebarOrderList() {
  const list = document.getElementById('sidebarOrderList');
  if (!list) return;
  const tabs = getVisibleSidebarTabs();
  // Com uma só tela móvel (a Home é fixa) não há para onde mover: as setas nem são desenhadas
  const canReorder = tabs.filter((tab) => tab.view !== 'home').length > 1;
  list.innerHTML = tabs.map((tab) => {
    const fixed = tab.view === 'home';
    const label = escapeHtml(tab.label);
    const moves = fixed || !canReorder ? '' : `
      <button type="button" class="st-order-move" data-dir="-1" aria-label="Mover ${label} para cima" title="Mover ${label} para cima"><span class="material-symbols-rounded" aria-hidden="true">keyboard_arrow_up</span></button>
      <button type="button" class="st-order-move" data-dir="1" aria-label="Mover ${label} para baixo" title="Mover ${label} para baixo"><span class="material-symbols-rounded" aria-hidden="true">keyboard_arrow_down</span></button>`;
    return `<li class="st-order-item${fixed ? ' is-fixed' : ''}" data-view="${escapeHtml(tab.view)}"${fixed ? ' title="A Home fica sempre em primeiro"' : ' draggable="true"'}>
      <span class="material-symbols-rounded st-order-grip" aria-hidden="true">${fixed ? 'lock' : 'drag_indicator'}</span>
      <span class="material-symbols-rounded st-order-icon" aria-hidden="true">${escapeHtml(tab.icon)}</span>
      <span class="st-order-label">${label}</span>
      <kbd class="st-kbd st-order-shortcut"></kbd>
      <span class="st-order-moves">${moves}</span>
    </li>`;
  }).join('');
  refreshSidebarOrderBadges();
}

/** Atualiza os atalhos mostrados e o estado das setas conforme a posição atual de cada item. */
function refreshSidebarOrderBadges() {
  const items = [...(document.getElementById('sidebarOrderList')?.children || [])];
  items.forEach((li, i) => {
    const kbd = li.querySelector('.st-order-shortcut');
    const label = tabShortcutLabel(i + 1);
    if (kbd) { kbd.textContent = label; kbd.classList.toggle('hidden', !label); }
    const up = li.querySelector('[data-dir="-1"]');
    const down = li.querySelector('[data-dir="1"]');
    if (up) up.disabled = i <= 1;               // logo abaixo da Home é o limite superior
    if (down) down.disabled = i === items.length - 1;
  });
}

/** Ordem pendente (sem a Home, que é sempre a primeira). */
function collectSidebarOrder() {
  const list = document.getElementById('sidebarOrderList');
  if (!list) return undefined; // tela ainda sem a lista: não altera a preferência salva
  return [...list.children].map(li => li.dataset.view).filter(v => v && v !== 'home');
}

function setupSidebarOrder() {
  const list = document.getElementById('sidebarOrderList');
  if (!list) return;

  // Setas (acessível por teclado)
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.st-order-move');
    if (!btn || btn.disabled) return;
    const li = btn.closest('.st-order-item');
    const dir = Number(btn.dataset.dir);
    if (dir < 0) {
      const prev = li.previousElementSibling;
      if (prev && !prev.classList.contains('is-fixed')) list.insertBefore(li, prev);
    } else if (li.nextElementSibling) {
      list.insertBefore(li.nextElementSibling, li);
    }
    refreshSidebarOrderBadges();
    markSettingsDirty();
    (li.querySelector(`[data-dir="${dir}"]:not(:disabled)`) || li.querySelector('.st-order-move:not(:disabled)'))?.focus();
  });

  // Arrastar e soltar (a Home não é arrastável nem recebe item acima dela)
  let dragging = null;
  let orderBeforeDrag = '';
  const currentOrder = () => (collectSidebarOrder() || []).join(',');
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.st-order-item');
    if (!li || li.classList.contains('is-fixed')) { e.preventDefault(); return; }
    dragging = li;
    orderBeforeDrag = currentOrder();
    li.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.view);
  });
  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const over = e.target.closest('.st-order-item');
    if (!over || over === dragging) return;
    const rect = over.getBoundingClientRect();
    const after = over.classList.contains('is-fixed') || e.clientY > rect.top + rect.height / 2;
    const ref = after ? over.nextElementSibling : over;
    if (ref !== dragging) list.insertBefore(dragging, ref);
  });
  list.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging.classList.remove('is-dragging');
    dragging = null;
    refreshSidebarOrderBadges();
    if (currentOrder() !== orderBeforeDrag) markSettingsDirty();
  });

  // Restaurar a ordem original do menu
  document.getElementById('sidebarOrderResetButton')?.addEventListener('click', () => {
    const items = sortByDefaultTabOrder([...list.children], (li) => li.dataset.view);
    items.forEach(li => list.appendChild(li));
    refreshSidebarOrderBadges();
    markSettingsDirty();
    // o botão some (a ordem já é a padrão): o foco vai para uma seta da lista
    finishReset(list.querySelector('.st-order-move:not(:disabled)'));
  });
}

/** Itens na ordem padrão do menu (a mesma que o botão de restaurar aplica). */
function sortByDefaultTabOrder(items, viewOf) {
  const defaults = getDefaultTabOrder();
  return [...items].sort((a, b) => defaults.indexOf(viewOf(a)) - defaults.indexOf(viewOf(b)));
}

function sidebarOrderDiffers() {
  const items = [...(document.getElementById('sidebarOrderList')?.children || [])];
  const sorted = sortByDefaultTabOrder(items, (li) => li.dataset.view);
  return items.some((li, i) => li !== sorted[i]);
}

/**
 * Componentes cuja fonte não publica checksum (SHA-256) NÃO são instalados sozinhos nas atualizações:
 * o resultado traz `needsConfirmation`. Pergunta ao usuário e, se confirmar, instala só esses.
 * @param {{ needsConfirmation?: Array<{ id?: string, tool?: string, version?: string }> }} [deps]
 * @returns {Promise<number>} quantidade instalada após a confirmação
 */
async function confirmUnverifiedUpdates(deps) {
  const pending = deps?.needsConfirmation || [];
  if (!pending.length || !window.bds?.updateTool) return 0;
  const names = pending.map(p => `• ${p.title || 'Componente'}${p.version ? ` ${p.version}` : ''}`).join('\n');
  const ok = await window.bdsModal.confirm(
    `A fonte destes componentes não publica dados de verificação de integridade, então não é possível conferir o download:\n\n${names}\n\nInstalar mesmo assim?`
  );
  if (!ok) return 0;
  let installed = 0;
  for (const p of pending) {
    try {
      await window.bds.updateTool(p.tool || p.id, { allowUnverified: true });
      installed++;
    } catch (err) {
      console.error('[SETTINGS] Falha ao instalar componente sem checksum:', p.tool || p.id, err);
    }
  }
  return installed;
}

/** Marca, no grupo de bolinhas, a cor de destaque atual (sempre uma opção da paleta fixa). */
function syncAccentSwatches() {
  const current = normalizeAccentHex(document.getElementById('accentColorInput')?.value);
  document.querySelectorAll('.st-accent-radio').forEach((radio) => {
    radio.checked = radio.value.toLowerCase() === current;
  });
}

/* ==========================================================================
   ALTERAÇÕES NÃO SALVAS: o estado "sujo" compara os campos com a foto tirada ao abrir/salvar/descartar,
   então desfazer uma mudança à mão também esconde a barra.
   ========================================================================== */
let baselineSnapshot = '';
let leaveHandler = null;
let leaveBypass = false;
let saveShortcutHandler = null;

const isTrackedField = (el) => el.id
  && el.id !== 'settingsSearch'
  && !el.closest('#modulesList, #settingsAnalysisPanel, #settingsAssistantCard, #settingsTranscriptionPanel, #settingsAboutView, #settingsLutsCollectionCard');

function takeSnapshot() {
  const parts = [];
  document.querySelectorAll('.settings-content input, .settings-content select, .settings-content textarea').forEach((el) => {
    if (!isTrackedField(el)) return;
    parts.push(`${el.id}=${el.type === 'checkbox' ? el.checked : el.value}`);
  });
  parts.push(`order=${(collectSidebarOrder() || []).join(',')}`);
  return parts.join('|');
}

function rebaseline() { baselineSnapshot = takeSnapshot(); }

function updateSaveBar() {
  const bar = document.getElementById('settingsSaveBar');
  if (!bar) return;
  clearTimeout(savedBarTimer);
  bar.classList.toggle('hidden', !settingsDirty);
  bar.classList.remove('is-saved');
  const text = document.getElementById('settingsSaveBarText');
  if (text) text.textContent = 'Você tem alterações não salvas. Ctrl+S salva.';
}

function markSettingsDirty() {
  settingsDirty = takeSnapshot() !== baselineSnapshot;
  updateSaveBar();
  refreshResetButtons();
}

/** Depois de salvar: some a barra de alterações e mostra uma confirmação rápida. */
function markSettingsSaved() {
  settingsDirty = false;
  rebaseline();
  refreshResetButtons();
  const bar = document.getElementById('settingsSaveBar');
  const text = document.getElementById('settingsSaveBarText');
  if (!bar) return;
  clearTimeout(savedBarTimer);
  bar.classList.remove('hidden');
  bar.classList.add('is-saved');
  if (text) text.textContent = 'Configurações salvas.';
  savedBarTimer = setTimeout(() => { bar.classList.add('hidden'); bar.classList.remove('is-saved'); }, 2200);
}

/** Descarta as alterações: recarrega os campos e desfaz as prévias (tema, cor, animações). */
function discardSettingsChanges() {
  renderSettings();
  const s = state.settings || {};
  applyTheme(s.theme, s.accentColor);
  applyUiPreferences(s);
  clearAllFieldErrors();
  settingsDirty = false;
  rebaseline();
  refreshResetButtons();
  updateSaveBar();
}

function setupSaveBar() {
  settingsDirty = false;
  const content = document.querySelector('.settings-content');
  const track = (e) => {
    if (e.target?.closest?.('#sidebarOrderList')) { markSettingsDirty(); return; }
    if (!isTrackedField(e.target)) return;
    markSettingsDirty();
  };
  content?.addEventListener('input', track);
  content?.addEventListener('change', track);
  document.getElementById('settingsSaveBarSave')?.addEventListener('click', saveSettings);
  document.getElementById('settingsSaveBarDiscard')?.addEventListener('click', discardSettingsChanges);
  rebaseline();
  updateSaveBar();
}

/** Ao sair da tela com alterações não salvas, desfaz as prévias para não deixar o app "meio mudado". */
export function onLeave() {
  flushAssistantInstructions?.(); // não perde as instruções da Yui ainda não gravadas
  unmountTranscriptionPanel();
  unmountAiPanel();
  if (settingsDirty) {
    const s = state.settings || {};
    applyTheme(s.theme, s.accentColor);
    applyUiPreferences(s);
  }
  renderSidebarOrderList(); // descarta uma ordem não salva e reflete o menu real ao voltar
  settingsDirty = false;
  clearTimeout(savedBarTimer);
  teardownRecordingFolderDetection();
  if (leaveHandler) { document.removeEventListener('click', leaveHandler, true); leaveHandler = null; }
  if (saveShortcutHandler) { document.removeEventListener('keydown', saveShortcutHandler, true); saveShortcutHandler = null; }
}

/** Ao voltar para a tela (ela fica no DOM): recarrega os campos, refaz os atalhos e reabre os painéis da aba atual. */
export function onEnter() {
  renderSettings();
  clearAllFieldErrors();
  setupLeaveGuard();
  setupAdvancedBlocks();
  setupRecordingFolderDetection();
  settingsDirty = false;
  rebaseline();
  updateSaveBar();
  refreshResetButtons();
  document.querySelector('.settings-tab.active')?.click();
}

/* --- Aviso ao sair com alterações não salvas (cliques no menu lateral e atalhos Ctrl+número) --- */
function askLeaveChoice() {
  return new Promise((resolve) => {
    const modal = document.getElementById('modalSettingsLeave');
    if (!modal) { resolve('discard'); return; }
    const stay = document.getElementById('modalSettingsLeaveStay');
    const discard = document.getElementById('modalSettingsLeaveDiscard');
    const save = document.getElementById('modalSettingsLeaveSave');
    const done = (choice) => {
      stay.removeEventListener('click', onStay);
      discard.removeEventListener('click', onDiscard);
      save.removeEventListener('click', onSave);
      modal.removeEventListener('keydown', onKey);
      closeSettingsModal('modalSettingsLeave');
      resolve(choice);
    };
    const onStay = () => done('stay');
    const onDiscard = () => done('discard');
    const onSave = () => done('save');
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done('stay'); }
      if (e.key === 'Tab') { // mantém o foco dentro do diálogo
        const items = [stay, discard, save];
        const i = items.indexOf(document.activeElement);
        const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
        e.preventDefault();
        items[next].focus();
      }
    };
    stay.addEventListener('click', onStay);
    discard.addEventListener('click', onDiscard);
    save.addEventListener('click', onSave);
    modal.addEventListener('keydown', onKey);
    openSettingsModal('modalSettingsLeave');
    stay.focus();
  });
}

function setupLeaveGuard() {
  if (leaveHandler) document.removeEventListener('click', leaveHandler, true);
  leaveHandler = async (e) => {
    if (!settingsDirty || leaveBypass) return;
    const btn = e.target.closest?.('.tab-button');
    if (!btn || btn.dataset.view === 'settings') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const choice = await askLeaveChoice();
    if (choice === 'stay') return;
    if (choice === 'save') {
      await saveSettings();
      if (settingsDirty) return; // não salvou (campo inválido ou erro): fica na tela
    } else {
      discardSettingsChanges();
    }
    leaveBypass = true;
    try { btn.click(); } finally { leaveBypass = false; }
  };
  document.addEventListener('click', leaveHandler, true);

  if (saveShortcutHandler) document.removeEventListener('keydown', saveShortcutHandler, true);
  saveShortcutHandler = (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 's' && document.getElementById('settingsGeneralView')) {
      e.preventDefault();
      if (settingsDirty) saveSettings();
    }
  };
  document.addEventListener('keydown', saveShortcutHandler, true);
}

/* ==========================================================================
   VALIDAÇÃO INLINE
   ========================================================================== */
const FOLDER_INPUTS = ['mp3FolderInput', 'mp4FolderInput', 'converterFolderInput', 'obsFolderInput', 'shadowplayFolderInput', 'deviceFolderInput', 'uploadsFolderInput'];
const NUMBER_RULES = {
  downloadPauseMinInput: { min: 0, max: 600, label: 'a pausa mínima' },
  downloadPauseMaxInput: { min: 0, max: 600, label: 'a pausa máxima' },
  uploadPauseMinInput: { min: 0, max: 3600, label: 'a pausa mínima' },
  uploadPauseMaxInput: { min: 0, max: 3600, label: 'a pausa máxima' },
  uploadDailyLimitInput: { min: 0, max: 100, label: 'o número de envios por dia' },
  converterDefaultVideoBitrateInput: { min: 1, max: 100, label: 'o bitrate de vídeo' },
  cacheMaxSizeInput: { min: 50, max: 10000, label: 'o limite de armazenamento' }
};

/** Texto de erro do campo, ou '' se estiver válido. */
function validateField(el) {
  if (!el || el.disabled) return '';
  const id = el.id;
  const value = String(el.value || '').trim();
  if (NUMBER_RULES[id]) {
    const r = NUMBER_RULES[id];
    if (value === '' || !/^-?\d+$/.test(value)) return `Informe um número inteiro para ${r.label}.`;
    const n = Number(value);
    if (n < r.min || n > r.max) return `Use um valor entre ${r.min} e ${r.max}.`;
    if (id === 'downloadPauseMaxInput' || id === 'uploadPauseMaxInput') {
      const min = Number(document.getElementById(id === 'downloadPauseMaxInput' ? 'downloadPauseMinInput' : 'uploadPauseMinInput')?.value);
      if (Number.isFinite(min) && n < min) return 'O máximo precisa ser igual ou maior que o mínimo.';
    }
    return '';
  }
  if (id === 'deadlineNotifyTimeInput' && !value) return 'Informe o horário do lembrete.';
  if (FOLDER_INPUTS.includes(id) && value && !/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value)) {
    return 'Informe o caminho completo da pasta (por exemplo, C:\\Vídeos) ou use o ícone de pasta no campo.';
  }
  if (id === 'updateServerUrlInput' && value) {
    let u = null;
    try { u = new URL(value); } catch (_) { /* inválida */ }
    if (!u || u.protocol !== 'https:') return 'Use um endereço seguro, que comece com https://.';
  }
  return '';
}

function showFieldError(el, message) {
  const row = el.closest('.st-row, .settings-form-group') || el.parentElement;
  let box = row.querySelector(`.st-field-error[data-for="${el.id}"]`);
  if (!message) {
    box?.remove();
    el.removeAttribute('aria-invalid');
    el.removeAttribute('aria-describedby');
    return;
  }
  if (!box) {
    box = document.createElement('div');
    box.className = 'st-field-error';
    box.dataset.for = el.id;
    box.id = `err-${el.id}`;
    box.setAttribute('role', 'alert');
    row.appendChild(box);
  }
  box.textContent = message;
  el.setAttribute('aria-invalid', 'true');
  el.setAttribute('aria-describedby', box.id);
}

function validatedFields() {
  return [...Object.keys(NUMBER_RULES), 'deadlineNotifyTimeInput', 'updateServerUrlInput', ...FOLDER_INPUTS]
    .map((id) => document.getElementById(id)).filter(Boolean);
}

function clearAllFieldErrors() {
  document.querySelectorAll('.st-field-error').forEach((n) => n.remove());
  document.querySelectorAll('[aria-invalid="true"]').forEach((n) => { n.removeAttribute('aria-invalid'); n.removeAttribute('aria-describedby'); });
}

/** Valida todos os campos; mostra os erros e leva o foco ao primeiro inválido (abrindo a aba e o bloco avançado). */
function validateAllFields() {
  let first = null;
  for (const el of validatedFields()) {
    const msg = validateField(el);
    showFieldError(el, msg);
    if (msg && !first) first = el;
  }
  if (first) {
    revealField(first);
    const adv = first.closest('details');
    if (adv) adv.open = true;
    first.focus();
    first.scrollIntoView({ block: 'center' });
  }
  return !first;
}

function setupValidation() {
  const content = document.querySelector('.settings-content');
  content?.addEventListener('input', (e) => {
    const el = e.target;
    if (!validatedFields().includes(el)) return;
    showFieldError(el, validateField(el));
    // a pausa máxima depende da mínima
    const pairs = { downloadPauseMinInput: 'downloadPauseMaxInput', uploadPauseMinInput: 'uploadPauseMaxInput' };
    if (pairs[el.id]) {
      const max = document.getElementById(pairs[el.id]);
      if (max && max.dataset.touched) showFieldError(max, validateField(max));
    }
    if (el.id === 'downloadPauseMaxInput' || el.id === 'uploadPauseMaxInput') el.dataset.touched = '1';
  });
}

/** Blocos "Ajustes avançados" ficam recolhidos; abrem sozinhos quando a busca acha algo dentro deles. */
function setupAdvancedBlocks() {
  document.querySelectorAll('details.st-advanced').forEach((d) => { d.open = false; });
}

/* ==========================================================================
   "RESTAURAR PADRÃO" POR CAMPO
   ========================================================================== */
const FIELD_DEFAULTS = {
  themeSelect: 'dark',
  defaultStartScreenInput: 'home',
  deadlineNotifyLeadDaysInput: '5',
  deadlineNotifyTimeInput: '09:00',
  preferredGpuVendorInput: 'auto',
  converterDefaultFormatInput: 'mp4',
  converterDefaultCodecInput: 'libx264',
  converterDefaultResolutionInput: 'original',
  converterDefaultVideoBitrateInput: '10',
  converterDefaultAudioBitrateInput: '192k',
  cacheMaxSizeInput: '500'
};
// A pausa entre downloads tem dois campos e um botão só.
const PAUSE_DEFAULTS = { downloadPauseMinInput: '10', downloadPauseMaxInput: '180' };
const UPLOAD_PAUSE_DEFAULTS = { uploadPauseMinInput: '60', uploadPauseMaxInput: '300' };

function defaultLabel(el, value) {
  if (el.tagName === 'SELECT') return [...el.options].find((o) => o.value === value)?.textContent.trim() || value;
  if (el.type === 'color') return value.toUpperCase();
  return value;
}

/* Mecanismo único do "Restaurar padrão": botão-ícone (.st-reset-icon) que só aparece quando o valor difere do padrão.
   O tipo do botão (data-reset-kind) diz como comparar:
     fields   campos com padrão fixo (data-targets, criado por makeResetButton)
     folders  pastas padrão do app (buscadas uma vez; ver FOLDER_RESET_PAIRS)
     empty    campos cujo padrão é vazio (data-reset-fields com os ids)
     order    ordem das telas no menu lateral (padrão calculado)
   O texto "Restaurar padrão" fica num span visualmente oculto (leitor de tela), o title mostra o valor padrão e, ao clicar,
   o foco volta ao campo (o botão some quando o valor volta ao padrão). Botão dentro de [data-reset-row] esconde a linha junto. */
const RESET_ICON_HTML = '<span class="material-symbols-rounded" aria-hidden="true">restart_alt</span>\n<span class="st-sr">Restaurar padrão</span>';

// Botões estáticos de pastas: id do botão -> [id do campo, chave em getDefaultFolders]
const FOLDER_RESET_PAIRS = {
  restoreDownloadFoldersButton: [['mp3FolderInput', 'mp3Folder'], ['mp4FolderInput', 'mp4Folder']],
  restoreConverterFolderButton: [['converterFolderInput', 'converterFolder']]
};

// Pastas padrão do app: undefined = ainda carregando (botões escondidos), objeto = carregadas, null = falhou (botões visíveis)
let defaultFoldersCache;
let defaultFoldersLoad = null;

/** Busca as pastas padrão uma única vez e guarda em memória; só o clique em "Restaurar padrão" busca de novo. */
function loadDefaultFoldersOnce() {
  if (!defaultFoldersLoad) {
    defaultFoldersLoad = (async () => {
      try {
        const defaults = await window.bds.getDefaultFolders();
        defaultFoldersCache = defaults && typeof defaults === 'object' ? defaults : null;
      } catch (_) {
        defaultFoldersCache = null; // sem o padrão não dá para comparar: o botão fica visível, como antes
      }
      syncFolderResetTitles();
      refreshResetButtons();
    })();
  }
  return defaultFoldersLoad;
}

/** Normaliza para comparar caminhos sem diferenciar barra, maiúscula nem barra final. */
function samePath(a, b) {
  const norm = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** title dos botões de pastas: "Restaurar padrão: <pasta>" (quando as pastas padrão já foram carregadas). */
function syncFolderResetTitles() {
  if (!defaultFoldersCache) return;
  for (const [buttonId, pairs] of Object.entries(FOLDER_RESET_PAIRS)) {
    const paths = pairs.map(([, key]) => defaultFoldersCache[key]).filter(Boolean);
    const btn = document.getElementById(buttonId);
    if (btn && paths.length) btn.title = `Restaurar padrão: ${paths.join(' · ')}`;
  }
}

/** Depois de restaurar: o botão some, então o foco volta ao campo (nunca se perde no vazio) e os botões são reavaliados. */
function finishReset(focusEl) {
  if (focusEl && !focusEl.disabled && typeof focusEl.focus === 'function') focusEl.focus();
  refreshResetButtons();
}

function makeResetButton(label, title, targets) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'st-reset-icon st-reset-field hidden';
  btn.dataset.resetKind = 'fields';
  btn.setAttribute('aria-label', `Restaurar o padrão de ${label}`);
  btn.title = title;
  btn.innerHTML = RESET_ICON_HTML;
  btn.addEventListener('click', () => {
    for (const [id, value] of targets) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setStatus(`Padrão de ${label} restaurado. Salve para manter.`);
    finishReset(targets.map(([id]) => document.getElementById(id)).find((el) => el && !el.disabled));
  });
  btn.dataset.targets = JSON.stringify(targets);
  return btn;
}

function setupFieldDefaults() {
  // só os botões criados aqui (.st-reset-field); os estáticos do HTML não levam essa classe e ficam
  document.querySelectorAll('.st-reset-field').forEach((n) => n.remove());
  const attach = (el, btn) => {
    const host = el.closest('.st-row-control') || el.parentElement;
    host.appendChild(btn);
  };
  for (const [id, def] of Object.entries(FIELD_DEFAULTS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const label = (document.querySelector(`label[for="${id}"]`)?.textContent || id).trim().toLowerCase();
    attach(el, makeResetButton(label, `Restaurar padrão: ${defaultLabel(el, def)}`, [[id, def]]));
  }
  const maxEl = document.getElementById('downloadPauseMaxInput');
  if (maxEl) attach(maxEl, makeResetButton('tempo da pausa', 'Restaurar padrão: 10 a 180 segundos', Object.entries(PAUSE_DEFAULTS)));
  const uplMaxEl = document.getElementById('uploadPauseMaxInput');
  if (uplMaxEl) attach(uplMaxEl, makeResetButton('tempo da pausa entre envios', 'Restaurar padrão: 60 a 300 segundos', Object.entries(UPLOAD_PAUSE_DEFAULTS)));
  loadDefaultFoldersOnce();
  refreshResetButtons();
}

/** O valor atual difere do padrão? (o botão só aparece quando sim) */
function resetDiffers(btn) {
  switch (btn.dataset.resetKind) {
    case 'folders': {
      if (defaultFoldersCache === undefined) return false; // ainda carregando: evita piscar
      if (defaultFoldersCache === null) return true;       // não carregou: mostra, como antes
      return (FOLDER_RESET_PAIRS[btn.id] || []).some(([inputId, key]) => {
        const el = document.getElementById(inputId);
        return el && !samePath(el.value, defaultFoldersCache[key]);
      });
    }
    case 'empty':
      return (btn.dataset.resetFields || '').split(/\s+/).filter(Boolean).some((id) => {
        const el = document.getElementById(id);
        return el && el.value.trim() !== '';
      });
    case 'order':
      return sidebarOrderDiffers();
    default: {
      let targets = [];
      try { targets = JSON.parse(btn.dataset.targets || '[]'); } catch (_) { /* ignora */ }
      return targets.some(([id, def]) => {
        const el = document.getElementById(id);
        return el && String(el.value).toLowerCase() !== String(def).toLowerCase();
      });
    }
  }
}

function refreshResetButtons() {
  document.querySelectorAll('.st-reset-icon').forEach((btn) => {
    const differs = resetDiffers(btn);
    btn.classList.toggle('hidden', !differs);
    btn.closest('[data-reset-row]')?.classList.toggle('hidden', !differs);
  });
}

/* ==========================================================================
   TECLADO: Enter salva, Esc desfaz o campo, Ctrl+S salva tudo
   ========================================================================== */
function setupFieldKeyboard() {
  const content = document.querySelector('.settings-content');
  if (!content) return;
  const SKIP = ':not([type=checkbox]):not([type=search]):not([type=color]):not([type=range])';
  content.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.matches?.(`input${SKIP}, select`)) el.dataset.focusValue = el.value;
  });
  content.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el.matches?.(`input${SKIP}`) || !isTrackedField(el)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (settingsDirty) saveSettings();
    } else if (e.key === 'Escape' && el.dataset.focusValue !== undefined && el.value !== el.dataset.focusValue) {
      e.preventDefault();
      e.stopPropagation();
      el.value = el.dataset.focusValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setStatus('Alteração do campo desfeita.');
    }
  });
}

/** Deixa um botão "ocupado" (texto de progresso, ícone girando, sem cliques duplicados) e devolve a função que restaura. */
function setButtonBusy(btn, busyLabel) {
  if (!btn) return () => {};
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.innerHTML = `<span class="material-symbols-rounded st-spin" aria-hidden="true">progress_activity</span> ${busyLabel}`;
  return () => { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.innerHTML = html; };
}

/** Primeiro controle visível do cartão que não esteja dentro de `el` (para onde o foco vai quando `el` some). */
function firstFocusableOutside(el) {
  const scope = el.closest('.st-card') || el.ownerDocument;
  return [...scope.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')]
    .find((c) => !el.contains(c) && !c.closest('.hidden') && !c.closest('[hidden]'));
}

/**
 * Mostra ou esconde um controle que só faz sentido em certas situações (no lugar de deixá-lo desabilitado e à vista).
 * Se o foco está dentro dele, o foco passa antes para `fallback` (ou o primeiro controle visível do cartão): quem usa
 * teclado ou leitor de tela nunca fica com o foco perdido no vazio.
 */
function setVisible(el, visible, fallback) {
  if (!el) return;
  if (!visible && !el.classList.contains('hidden')) {
    const active = el.ownerDocument.activeElement;
    if (active && el.contains(active)) {
      const target = fallback || firstFocusableOutside(el);
      if (target && typeof target.focus === 'function') target.focus();
    }
  }
  el.classList.toggle('hidden', !visible);
}

/**
 * Resultado de uma ação escrito no próprio cartão (região aria-live): sucesso e "nada a fazer" ficam na tela em vez de
 * abrir um alerta. `detail` (um caminho, por exemplo) entra em destaque e pode ser selecionado e copiado.
 */
function setResult(id, text, detail) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || '';
  if (text && detail) {
    const span = document.createElement('span');
    span.className = 'st-result-path';
    span.textContent = detail;
    el.append(' ', span);
  }
}

/**
 * Menu "⋯" (botão com aria-haspopup e aria-expanded, lista com role=menu). Abre por clique, seta para baixo ou para cima
 * (o foco vai para o primeiro ou o último item); setas, Home e End percorrem os itens; Esc, Tab e escolher um item fecham
 * e devolvem o foco ao botão (o item escolhido age depois disso); clicar fora também fecha. Os itens do menu precisam
 * existir no HTML quando esta função roda, e os ouvintes de ação de cada item são ligados depois dela.
 */
function setupOverflowMenu(button, menu) {
  if (!button || !menu) return;
  const items = () => [...menu.querySelectorAll('[role="menuitem"]')].filter((i) => !i.classList.contains('hidden'));
  const isOpen = () => !menu.classList.contains('hidden');
  const onOutside = (e) => { if (!menu.contains(e.target) && !button.contains(e.target)) close({ refocus: false }); };
  function close({ refocus = true } = {}) {
    if (!isOpen()) return;
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutside, true);
    if (refocus) button.focus();
  }
  function open(which) {
    const list = items();
    if (!list.length) return;
    menu.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onOutside, true); // captura: o contêiner da tela impede o clique de subir
    list[which === 'last' ? list.length - 1 : 0].focus();
  }

  button.addEventListener('click', () => (isOpen() ? close() : open('first')));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open('first'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); open('last'); }
  });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(menu.ownerDocument.activeElement);
    const go = (n) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? list.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close();
  });
  menu.addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    if (to && (menu.contains(to) || to === button)) return;
    if (to) close({ refocus: false }); // o foco foi para outro controle da tela
  });
  // Escolher um item fecha o menu e devolve o foco ao botão. Este ouvinte é registrado antes dos de ação de cada item
  // (quem chama monta o menu primeiro), então o menu já está fechado quando o item age.
  menu.querySelectorAll('[role="menuitem"]').forEach((item) => item.addEventListener('click', () => close()));
}

function setupSettingsExtras() {
  // Cor de destaque: paleta fixa em grupo de bolinhas (radio); a prévia é imediata e só vale ao salvar
  document.getElementById('accentSwatches')?.addEventListener('change', (e) => {
    const radio = e.target.closest('.st-accent-radio');
    if (!radio || !radio.checked) return;
    const input = document.getElementById('accentColorInput');
    if (input) input.value = radio.value;
    applyAccentColor(radio.value);
    markSettingsDirty();
  });

  // Prévia imediata de "reduzir animações"
  document.getElementById('reduceMotionInput')?.addEventListener('change', (e) => {
    applyUiPreferences({ reduceMotion: e.target.checked });
  });

  // Interruptor geral de notificações
  document.getElementById('notificationsEnabledInput')?.addEventListener('change', syncNotifyModules);

  setupAssistantCard();
  setupMcpCard();
  setupLocalLlmCard();
}

/**
 * Cartão "Assistente de IA": interruptor "Ativar assistente" e instruções personalizadas. Ficam na configuração
 * da IA (não nas configurações gerais), então valem na hora e não entram na barra "Salvar". Ao mudar o interruptor
 * o botão flutuante aparece/some imediatamente (evento bds:ai-assistant-changed).
 */
let flushAssistantInstructions = null; // grava na hora as instruções da Yui se o texto mudou (definida por setupAssistantCard)

async function setupAssistantCard() {
  const sw = document.getElementById('aiAssistantEnabledInput');
  const autoSw = document.getElementById('aiAssistantAutoConfirmInput');
  const text = document.getElementById('aiAssistantInstructionsInput');
  const status = document.getElementById('aiAssistantStatus');
  if (!sw || typeof window.bds?.aiGetConfig !== 'function') return;
  const say = (msg) => { if (status) status.textContent = msg || ''; };
  const save = async (patch) => {
    const r = await window.bds.aiSaveConfig(patch);
    if (!r || !r.ok) throw new Error(r?.error || 'A Yui não respondeu.');
    return r.data;
  };
  try {
    const r = await window.bds.aiGetConfig();
    if (r && r.ok) {
      sw.checked = r.data.assistantEnabled !== false;
      if (autoSw) autoSw.checked = r.data.autoConfirm !== false;
      if (text) text.value = r.data.customInstructions || '';
    }
  } catch (_) { /* mantém os padrões da tela */ }

  autoSw?.addEventListener('change', async () => {
    const want = autoSw.checked;
    autoSw.disabled = true;
    try {
      await save({ autoConfirm: want });
      say(want ? 'A Yui executa os pedidos direto.' : 'A Yui vai pedir confirmação a cada ação.');
    } catch (err) {
      autoSw.checked = !want;
      say(`Não foi possível alterar. ${friendlyError(err, 'Tente novamente.')}`);
    } finally {
      autoSw.disabled = false;
    }
  });
  sw.addEventListener('change', async () => {
    const want = sw.checked;
    sw.disabled = true;
    try {
      await save({ assistantEnabled: want });
      say(want ? 'Yui ativada.' : 'Yui desativada.');
      window.dispatchEvent(new CustomEvent('bds:ai-assistant-changed'));
    } catch (err) {
      sw.checked = !want;
      say(`Não foi possível alterar. ${friendlyError(err, 'Tente novamente.')}`);
    } finally {
      sw.disabled = false;
    }
  });
  // Instruções personalizadas: sem botão próprio. Gravam ao mudar e ao sair do campo; trocar de aba, de subpainel
  // ou de tela também grava (via flushAssistantInstructions), então o texto digitado não se perde sem aviso.
  if (text) {
    let savedText = text.value; // o que a configuração da IA já tem
    let saving = null;
    const commit = async () => {
      while (saving) await saving; // uma gravação por vez; a seguinte já enxerga o resultado da anterior
      const value = text.value;
      if (value === savedText) return;
      saving = (async () => {
        try {
          await save({ customInstructions: value });
          savedText = value;
          say('Instruções salvas.');
        } catch (err) {
          say(`Não foi possível salvar as instruções. ${friendlyError(err, 'Tente novamente.')}`);
        }
      })();
      try { await saving; } finally { saving = null; }
    };
    text.addEventListener('change', commit);
    text.addEventListener('focusout', commit);
    flushAssistantInstructions = commit;
  }
}

/**
 * Cartão "Conectar agentes (MCP)": liga/desliga o servidor local, copia a configuração pronta para o agente (o token
 * nunca chega aqui: o app copia direto para a área de transferência) e gera um token novo. Vale na hora.
 */
async function setupMcpCard() {
  const sw = document.getElementById('aiMcpEnabledInput');
  if (!sw || typeof window.bds?.aiMcpStatus !== 'function') return;
  const hint = document.getElementById('aiMcpHint');
  const status = document.getElementById('aiMcpStatus');
  const copyRow = document.getElementById('aiMcpCopyRow');
  const advanced = document.getElementById('aiMcpAdvanced');
  const kind = document.getElementById('aiMcpKindSelect');
  const tokenSw = document.getElementById('aiMcpTokenInput');
  const confirmSw = document.getElementById('aiMcpConfirmInput');
  const say = (msg) => { if (status) status.textContent = msg || ''; };
  const call = async (fn, ...args) => {
    const r = await fn(...args);
    if (!r || !r.ok) throw new Error(r?.error || 'O aplicativo não respondeu.');
    return r.data;
  };
  const render = (s) => {
    sw.checked = s.enabled === true;
    if (tokenSw) tokenSw.checked = s.requireToken !== false;
    if (confirmSw) confirmSw.checked = s.autoConfirm !== true;
    // "Novo token" só faz sentido com "Exigir token" ligado: desligado, a linha some (em vez de ficar desabilitada)
    const regenRow = document.getElementById('aiMcpRegenRow');
    if (regenRow) {
      const hide = s.requireToken === false;
      // O foco nunca se perde: se estava no botão que vai sumir, passa para o interruptor que explica o motivo
      if (hide && regenRow.contains(document.activeElement)) tokenSw?.focus();
      regenRow.hidden = hide;
    }
    const on = s.enabled && s.running;
    if (copyRow) copyRow.hidden = !on;
    if (advanced) advanced.hidden = !on;
    if (hint) {
      if (!s.enabled) hint.textContent = 'Desligado. Nenhuma porta é aberta.';
      else if (!s.running) hint.textContent = s.error || 'Ligando…';
      else hint.textContent = `Ligado neste computador (porta ${s.port})${s.client ? `. Último agente: ${s.client}` : ''}.`;
    }
  };
  try { render(await call(window.bds.aiMcpStatus)); } catch (_) { /* mantém desligado */ }

  sw.addEventListener('change', async () => {
    const want = sw.checked;
    sw.disabled = true;
    try {
      render(await call(window.bds.aiMcpSetEnabled, want));
      say(want ? 'Pronto. Copie a configuração e cole no agente.' : 'Agentes desconectados.');
    } catch (err) {
      sw.checked = !want;
      say(`Não foi possível alterar. ${friendlyError(err, 'Tente novamente.')}`);
    } finally {
      sw.disabled = false;
    }
  });
  const option = (input, patch) => input?.addEventListener('change', async () => {
    const want = input.checked;
    try {
      render(await call(window.bds.aiMcpSetOptions, patch(want)));
      say('Opção salva. Copie a configuração de novo se o agente já estava conectado.');
    } catch (err) {
      input.checked = !want;
      say(`Não foi possível alterar. ${friendlyError(err, 'Tente novamente.')}`);
    }
  });
  option(tokenSw, (v) => ({ requireToken: v }));
  option(confirmSw, (v) => ({ autoConfirm: !v }));
  document.getElementById('aiMcpCopyBtn')?.addEventListener('click', async () => {
    try {
      await call(window.bds.aiMcpCopyConfig, kind ? kind.value : 'antigravity');
      say('Configuração copiada. Cole no arquivo de servidores MCP do agente.');
    } catch (err) {
      say(`Não foi possível copiar. ${friendlyError(err, 'Tente novamente.')}`);
    }
  });
  document.getElementById('aiMcpRegenBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    // Quem usa o token atual perde o acesso na hora: pede confirmação antes de trocar
    const ok = await window.bdsModal.confirm(
      'Gerar um novo token?\n\nO token atual deixa de valer agora. Os agentes conectados perdem o acesso até você copiar a configuração de novo no agente.'
    );
    if (!ok) return;
    btn.disabled = true;
    try {
      render(await call(window.bds.aiMcpRegenerateToken));
      say('Novo token gerado. Copie a configuração de novo no agente.');
    } catch (err) {
      say(`Não foi possível gerar. ${friendlyError(err, 'Tente novamente.')}`);
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * Cartão "Modelo local": instala/remove o modelo de IA que roda neste computador (llama.cpp + Qwen pequeno, fontes
 * oficiais com SHA-256). A instalação é longa: o progresso chega pelo evento ai:localLlmProgress.
 */
async function setupLocalLlmCard() {
  const installBtn = document.getElementById('aiLocalLlmInstallBtn');
  if (!installBtn || typeof window.bds?.aiLocalLlmStatus !== 'function') return;
  const cancelBtn = document.getElementById('aiLocalLlmCancelBtn');
  const removeBtn = document.getElementById('aiLocalLlmRemoveBtn');
  const hint = document.getElementById('aiLocalLlmHint');
  const bar = document.getElementById('aiLocalLlmProgress');
  const advanced = document.getElementById('aiLocalLlmAdvanced');
  const sizeEl = document.getElementById('aiLocalLlmSize');
  const status = document.getElementById('aiLocalLlmStatus');
  const say = (msg) => { if (status) status.textContent = msg || ''; };
  const call = async (fn, ...args) => {
    const r = await fn(...args);
    if (!r || !r.ok) throw new Error(r?.error || 'O aplicativo não respondeu.');
    return r.data;
  };
  const modelRow = document.getElementById('aiLocalLlmModelRow');
  const modelSel = document.getElementById('aiLocalLlmModel');
  const fitEl = document.getElementById('aiLocalLlmFit');
  const gb = (n) => `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  const gbMB = (mb) => `${(mb / 1024).toFixed(1).replace('.', ',')} GB`;
  // Como cada modelo se sai na placa de vídeo AGORA (o processo principal lê a memória livre dela)
  const FIT_TEXT = { fits: 'cabe na placa de vídeo', tight: 'cabe se outros programas liberarem a placa', partial: 'parte roda no processador', slow: 'quase tudo no processador (lento)' };
  let last = null; // último estado recebido (a troca de modelo olha a lista)
  let pick = null; // modelo escolhido no seletor ainda não instalado (fica marcado até instalar ou desistir)
  let touched = false; // o usuário já mexeu no seletor (antes disso, sem nada instalado, vem marcado o recomendado)
  const render = (s, installing = false) => {
    if (s.models) last = s;
    // Seletor: só aparece havendo mais de um modelo; o escolhido é o selecionado, os demais mostram o tamanho
    if (modelRow && modelSel && last && Array.isArray(last.models) && last.models.length > 1) {
      const current = (last.models.find((m) => m.selected) || last.models[0]).id;
      if (pick && (!last.models.some((m) => m.id === pick) || pick === current)) pick = null;
      const keep = pick || modelSel.value;
      const rec = last.recommendedId || '';
      modelSel.innerHTML = last.models.map((m) => {
        const note = m.fit && FIT_TEXT[m.fit.state] ? ` · ${FIT_TEXT[m.fit.state]}` : '';
        return `<option value="${m.id}">${m.label} (${m.installed ? 'instalado' : gb(m.sizeBytes)})${m.vision ? ' — entende imagens' : ''}${note}${m.id === rec ? ' · recomendado' : ''}</option>`;
      }).join('');
      // Nada instalado e ainda sem escolha do usuário: já vem marcado o modelo recomendado para a placa, em vez do básico
      const start = !s.installed && !pick && !touched && rec && last.models.some((m) => m.id === rec) ? rec : current;
      modelSel.value = (installing || pick) && keep ? keep : start;
      modelSel.disabled = installing;
      modelRow.hidden = !s.supported;
    }
    if (fitEl) {
      const mem = last && last.memory;
      const recModel = last && Array.isArray(last.models) ? last.models.find((m) => m.id === last.recommendedId) : null;
      let text = '';
      if (mem && mem.checked && mem.gpu) text = `Placa de vídeo: ${mem.gpu.name} — ${gbMB(mem.gpu.freeMB)} livres de ${gbMB(mem.gpu.totalMB)}.`;
      else if (mem && mem.checked) text = mem.integratedOnly ? 'Este computador só tem placa de vídeo integrada: o modelo roda no processador.' : 'Não encontrei uma placa de vídeo dedicada: o modelo roda no processador.';
      if (text && recModel) text += ` Recomendado: ${recModel.label}.`;
      if (text && last.plan && last.plan.mode === 'partial') text += ' Agora parte do modelo roda no processador: outros programas estão usando a placa.';
      if (text && last.plan && last.plan.mode === 'cpu') text += ' Agora o modelo roda no processador: a placa está ocupada.';
      if (text && last.gpuRetryAt) text += ' Não deu para usar a placa de vídeo da última vez: por enquanto o modelo roda no processador, e o app tenta a placa de novo mais tarde.';
      fitEl.textContent = text;
      fitEl.hidden = !text;
    }
    const picked = last && last.models ? last.models.find((m) => m.id === (modelSel ? modelSel.value : '')) : null;
    const pickedMissing = Boolean(picked && !picked.installed);
    if (sizeEl) {
      const bytes = picked ? picked.sizeBytes + Math.max(0, (s.sizeBytes || 0) - ((last.models.find((m) => m.selected) || picked).sizeBytes)) : s.sizeBytes;
      if (bytes) sizeEl.textContent = gb(bytes);
    }
    installBtn.hidden = installing || (s.installed && !pickedMissing) || !s.supported;
    installBtn.disabled = !s.supported;
    if (cancelBtn) cancelBtn.hidden = !installing;
    if (advanced) advanced.hidden = !s.installed || installing;
    if (bar) bar.hidden = !installing;
    if (hint && !installing) {
      if (!s.supported) hint.textContent = s.reason || 'Indisponível neste sistema.';
      else if (pickedMissing) hint.textContent = `Não instalado: ${picked.label}. A troca vale quando a instalação terminar.`;
      else if (s.installed) hint.textContent = `Instalado (${s.modelLabel}). Liga sozinho quando o assistente precisa e desliga depois de alguns minutos sem uso.`;
      else hint.textContent = 'Não instalado.';
    }
  };
  let installing = false;
  try { render(await call(window.bds.aiLocalLlmStatus)); } catch (_) { /* mantém o padrão */ }

  const off = window.bds.onAiLocalLlmProgress?.((p) => {
    if (!p || p.kind !== 'llm') return;
    if (bar && typeof p.percent === 'number') bar.value = Math.max(0, Math.min(100, p.percent));
    if (hint && installing && p.message) hint.textContent = `${p.message}${typeof p.percent === 'number' ? ` ${Math.round(p.percent)}%` : ''}`;
  });
  window.addEventListener('pagehide', () => { try { if (typeof off === 'function') off(); } catch (_) { /* noop */ } }, { once: true });

  modelSel?.addEventListener('change', async () => {
    touched = true;
    const chosen = last && last.models ? last.models.find((m) => m.id === modelSel.value) : null;
    say('');
    try {
      if (chosen && !chosen.installed) {
        pick = chosen.id;
        render(last);
      } else if (chosen && chosen.installed && !chosen.selected) {
        pick = null;
        render(await call(window.bds.aiLocalLlmSetModel, chosen.id));
        say('Modelo trocado. Vale já na próxima pergunta.');
        window.dispatchEvent(new CustomEvent('bds:ai-assistant-changed'));
      } else if (last) {
        pick = null;
        render(last);
      }
    } catch (err) {
      say(`Não foi possível trocar. ${friendlyError(err, 'Tente novamente.')}`);
      try { render(await call(window.bds.aiLocalLlmStatus)); } catch (_) { /* noop */ }
    }
  });

  installBtn.addEventListener('click', async () => {
    installing = true;
    say('');
    if (bar) bar.value = 0;
    const wanted = modelSel && modelSel.value ? modelSel.value : undefined;
    render({ installed: false, supported: true, sizeBytes: 0 }, true);
    if (hint) hint.textContent = 'Preparando…';
    try {
      const s = await call(window.bds.aiLocalLlmInstall, wanted);
      installing = false;
      pick = null;
      render(s);
      say('Pronto. O modelo local entrou na lista de servidores, como reserva.');
      window.dispatchEvent(new CustomEvent('bds:ai-assistant-changed'));
      try { analysisPanel?.reloadAnalysisPanel?.(); } catch (_) { /* a lista se atualiza ao reabrir */ }
    } catch (err) {
      installing = false;
      try { render(await call(window.bds.aiLocalLlmStatus)); } catch (_) { /* noop */ }
      say(/cancel/i.test(String(err && err.message)) ? 'Instalação cancelada.' : `Não foi possível instalar. ${friendlyError(err, 'Tente novamente.')}`);
    }
  });
  cancelBtn?.addEventListener('click', () => { window.bds.aiLocalLlmCancel(); });
  removeBtn?.addEventListener('click', async () => {
    const ok = await window.bdsModal.confirm('Remover o modelo local?\n\nApaga os arquivos do computador e tira o modelo da lista de servidores de IA. Você pode instalá-lo de novo quando quiser.');
    if (!ok) return;
    try {
      render(await call(window.bds.aiLocalLlmRemove));
      say('Modelo local removido.');
      window.dispatchEvent(new CustomEvent('bds:ai-assistant-changed'));
      try { analysisPanel?.reloadAnalysisPanel?.(); } catch (_) { /* a lista se atualiza ao reabrir */ }
    } catch (err) {
      say(`Não foi possível remover. ${friendlyError(err, 'Tente novamente.')}`);
    }
  });
}

let modulesListenerBound = false;

/**
 * A seção Inteligência Artificial e as telas da "Tela inicial" seguem os módulos ligados (o Assistente
 * de IA vem ligado por padrão e pode ser desligado em Módulos). Reaplica quando o main avisa.
 */
function setupModuleDependentUi() {
  refreshModuleDependentUi();
  if (modulesListenerBound) return;
  modulesListenerBound = true;
  window.addEventListener('bds:modules-changed', () => {
    if (document.getElementById('settingsAiView')) refreshModuleDependentUi();
  });
}

/* ==========================================================================
   SOBRE E LICENÇAS (único lugar da interface com nomes de componentes: atribuição exigida pelas licenças)
   ========================================================================== */
let licensesLoaded = false;

/**
 * Link de texto para a página do projeto ou o código-fonte. É um <a href> de verdade (foco, leitor de tela, "copiar
 * endereço"), mas quem abre é o navegador padrão, pelo openExternal; o clique nunca navega a janela do BDS.
 * Só aceita endereço http(s): qualquer outro esquema não vira link.
 */
function licenseLink(url, text, label) {
  if (!/^https?:\/\//i.test(String(url || ''))) return '';
  return `<a class="st-license-link" href="${escapeHtml(url)}" rel="noopener noreferrer" draggable="false" aria-label="${escapeHtml(label)}">${text}</a>`;
}

function renderLicenseGroup(title, items) {
  const rows = items.map((i) => `<details class="st-license" data-license-id="${escapeHtml(i.id)}" data-search="${escapeHtml(`${i.name} ${i.license} ${i.note || ''}`.toLowerCase())}">
      <summary><strong>${escapeHtml(i.name)}</strong> <span class="st-license-meta">${escapeHtml(i.version)} · ${escapeHtml(i.license)}</span></summary>
      <div class="st-license-body">
        ${i.note ? `<p class="st-card-desc">${escapeHtml(i.note)}</p>` : ''}
        ${licenseLink(i.url, 'Página do projeto', `Abrir página do projeto ${i.name}`)}
        ${i.sourceUrl ? licenseLink(i.sourceUrl, 'Código-fonte', `Abrir código-fonte de ${i.name}`) : ''}
        <pre class="st-license-text" tabindex="0">Abra para carregar…</pre>
      </div>
    </details>`).join('');
  return `<h5 class="st-license-group">${escapeHtml(title)} (${items.length})</h5>${rows}`;
}

async function loadLicensesPage() {
  try {
    const v = document.getElementById('aboutVersion');
    if (v && window.bds?.getVersion) window.bds.getVersion().then((x) => { v.textContent = `v${x}`; }).catch(() => {});
  } catch (_) { /* versão opcional */ }
  const host = document.getElementById('licensesList');
  if (!host || licensesLoaded) return;
  licensesLoaded = true;
  const toggle = document.getElementById('licensesToggle');
  const panel = document.getElementById('licensesPanel');
  let data = null;
  let rendered = false;

  // A lista começa recolhida: só carrega e desenha quando o usuário abre
  const render = async () => {
    if (rendered) return;
    try {
      data = data || await window.bds.getLicenses();
      host.innerHTML = renderLicenseGroup('Incluídos no aplicativo', [...data.bundled])
        + renderLicenseGroup('Baixados quando você ativa um recurso', [...data.runtime]);
      rendered = true;
    } catch (_) {
      host.innerHTML = '<p class="st-card-desc">Não foi possível carregar a lista de licenças. Reinicie o aplicativo e tente de novo.</p>';
    }
  };
  toggle?.addEventListener('click', async () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.classList.toggle('open', open);
    document.getElementById('licensesToggleText').textContent = open ? 'Ocultar lista de componentes' : 'Ver lista de componentes';
    if (panel) panel.hidden = !open;
    if (open) await render();
  });

  host.addEventListener('toggle', async (e) => {
    const det = e.target;
    if (!det.open || !det.matches?.('details.st-license')) return;
    const pre = det.querySelector('.st-license-text');
    if (!pre || pre.dataset.loaded) return;
    try {
      pre.textContent = await window.bds.getLicenseText(det.dataset.licenseId);
      pre.dataset.loaded = '1';
    } catch (_) { pre.textContent = 'Texto da licença indisponível.'; }
  }, true);
  // click (inclusive Ctrl+clique) e auxclick (botão do meio) não podem navegar a janela: abre-se no navegador padrão
  const openLicenseLink = (e) => {
    const link = e.target.closest?.('a.st-license-link');
    if (!link) return;
    e.preventDefault();
    if (e.type === 'auxclick' && e.button !== 1) return; // outros botões do mouse só não navegam
    Promise.resolve()
      .then(() => window.bds.openExternal(link.getAttribute('href')))
      .catch(() => notify('Não foi possível abrir o link.', 'error'));
  };
  host.addEventListener('click', openLicenseLink);
  host.addEventListener('auxclick', openLicenseLink);
  document.getElementById('licensesSearch')?.addEventListener('input', (e) => {
    const q = normalizeText(e.target.value).trim();
    host.querySelectorAll('details.st-license').forEach((d) => { d.hidden = q && !normalizeText(d.dataset.search).includes(q); });
  });
}

/* --- Busca --- */
function clearSettingsSearch() {
  const input = document.getElementById('settingsSearch');
  if (!input || !input.value) return;
  input.value = '';
  applySettingsSearch('');
}

let searchMounted = false;

function closeSearchOpenedBlocks() {
  document.querySelectorAll('details.st-advanced[data-search-opened]').forEach((d) => { d.open = false; delete d.dataset.searchOpened; });
}

function applySettingsSearch(raw) {
  const query = normalizeText(raw).trim();
  const container = document.querySelector('.settings-container');
  const views = [...document.querySelectorAll('.settings-content > .settings-view:not(.st-devhidden)')];
  const noResults = document.getElementById('settingsNoResults');
  const activeTabId = document.querySelector('.settings-tab.active')?.dataset.tab;

  document.querySelectorAll('.st-card, .st-row, [data-sub-panel]').forEach(el => el.classList.remove('st-filtered'));

  if (!query) {
    container?.classList.remove('st-searching');
    views.forEach(v => v.classList.toggle('hidden', v.id !== activeTabId));
    noResults?.classList.add('hidden');
    closeSearchOpenedBlocks();
    searchMounted = false;
    refreshSubnavs(); // a busca terminou: o submenu volta como estava
    return;
  }

  container?.classList.add('st-searching');
  closeSearchOpenedBlocks();
  views.forEach(view => {
    let hits = 0;
    // Palavras-chave da seção: acham seções cujo conteúdo só aparece depois de abertas (Módulos, Transcrição)
    const kwMatch = normalizeText(view.dataset.searchKeywords).includes(query)
      || normalizeText(view.querySelector('.settings-section-title')?.textContent).includes(query);
    const cards = [...view.querySelectorAll('.st-card')];
    cards.forEach(card => {
      if (card.classList.contains('hidden')) { card.classList.add('st-filtered'); return; }
      const titleMatch = normalizeText(card.querySelector('.st-card-title')?.textContent).includes(query);
      const rows = [...card.querySelectorAll('.st-row')];
      let visible;
      if (rows.length) {
        let rowHits = 0;
        rows.forEach(row => {
          const match = titleMatch || kwMatch || normalizeText(row.textContent).includes(query);
          row.classList.toggle('st-filtered', !match);
          if (match) {
            rowHits++;
            const adv = row.closest('details.st-advanced');
            if (adv && !adv.open) { adv.open = true; adv.dataset.searchOpened = '1'; }
          }
        });
        visible = rowHits > 0;
      } else {
        visible = kwMatch || titleMatch || normalizeText(card.textContent).includes(query);
      }
      card.classList.toggle('st-filtered', !visible);
      if (visible) hits++;
    });
    // Na busca todos os subpainéis aparecem: o que ficou sem cartão visível some inteiro (os que montam depois, não)
    view.querySelectorAll('[data-sub-panel]').forEach((panel) => {
      if (panel.querySelector('[data-lazy-host]')) return;
      const inside = [...panel.querySelectorAll('.st-card')];
      panel.classList.toggle('st-filtered', inside.length > 0
        && inside.every((c) => c.classList.contains('st-filtered') || c.classList.contains('hidden') || c.classList.contains('st-devhidden')));
    });
    if (!cards.length && (kwMatch || normalizeText(view.textContent).includes(query))) hits++;
    if (!hits && kwMatch) hits++;
    view.classList.toggle('hidden', hits === 0);
  });

  // Seções de carregamento tardio: monta o conteúdo uma vez por busca para os resultados não ficarem vazios
  if (!searchMounted) {
    searchMounted = true;
    const shown = (id) => !document.getElementById(id)?.classList.contains('hidden');
    if (shown('settingsModulesView')) loadModulesList();
    if (shown('settingsAiView')) { mountAiPanel(); mountTranscriptionPanel(); }
    if (shown('settingsAboutView')) loadLicensesPage();
  }

  noResults?.classList.toggle('hidden', views.some(v => !v.classList.contains('hidden')));
}

function setupSettingsSearch() {
  const input = document.getElementById('settingsSearch');
  if (!input) return;
  input.addEventListener('input', () => applySettingsSearch(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { e.stopPropagation(); clearSettingsSearch(); }
  });
}

/* ==========================================================================
   SISTEMA / VERSÃO
   ========================================================================== */
async function fetchAppVersion() {
  try {
    const version = await window.bds.getVersion();
    const sysVersion = document.getElementById('sysVersion');
    if (sysVersion) sysVersion.textContent = `v${version}`;
  } catch (err) {
    console.error('[SETTINGS] Erro ao buscar versão:', err);
  }
}

/* ==========================================================================
   ARMAZENAMENTO / CACHE
   ========================================================================== */
/**
 * Relê o armazenamento (uso total e uma linha por tipo de arquivo). Não há botão "Atualizar": isto roda ao iniciar a
 * tela, ao abrir a aba Sistema, ao voltar para "Sobre e armazenamento" e depois de cada limpeza. Chamadas juntas dividem
 * a mesma leitura, e a lista só é redesenhada se algo mudou (sem piscar "Calculando..." nem tirar o foco de quem navega).
 */
let cacheInfoLoad = null;
let cacheInfoShown = '';

function loadCacheInfo() {
  if (!cacheInfoLoad) cacheInfoLoad = readCacheInfo().finally(() => { cacheInfoLoad = null; });
  return cacheInfoLoad;
}

/** Uma linha de aviso dentro da lista por tipo (carregando, erro, vazio). */
function cacheMessageRow(text) {
  const row = document.createElement('div');
  row.className = 'st-row';
  const box = document.createElement('div');
  box.className = 'st-row-text';
  const hint = document.createElement('span');
  hint.className = 'st-row-hint';
  hint.textContent = text;
  box.append(hint);
  row.append(box);
  return row;
}

/** Uma linha por tipo de arquivo: nome, tamanho e o Limpar daquele tipo (a confirmação é pedida no clique). */
function cacheCategoryRow(cat) {
  const row = document.createElement('div');
  row.className = 'st-row';
  const box = document.createElement('div');
  box.className = 'st-row-text';
  const label = document.createElement('span');
  label.className = 'st-row-label';
  label.textContent = cat.label;
  const size = document.createElement('span');
  size.className = 'st-row-hint';
  size.textContent = cat.sizeFormatted;
  box.append(label, size);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'settings-btn-outline settings-cache-clear-btn';
  btn.dataset.clearCache = cat.key;
  btn.dataset.label = cat.label;
  btn.setAttribute('aria-label', `Limpar ${cat.label}`);
  const icon = document.createElement('span');
  icon.className = 'material-symbols-rounded';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'delete';
  btn.append(icon, ' Limpar');
  row.append(box, btn);
  return row;
}

async function readCacheInfo() {
  const listEl = document.getElementById('cacheCategoriesList');
  const totalEl = document.getElementById('cacheTotalSize');
  if (!listEl && !totalEl) return;

  const showMessage = (text) => {
    cacheInfoShown = '';
    listEl?.replaceChildren(cacheMessageRow(text));
  };

  if (!window.bds?.getCacheInfo) {
    showMessage('Não foi possível ler o armazenamento. Reinicie o aplicativo.');
    return;
  }

  try {
    const info = await window.bds.getCacheInfo();
    if (totalEl) totalEl.textContent = info.totalFormatted;

    if (listEl) {
      const categories = Array.isArray(info.categories) ? info.categories : [];
      const signature = JSON.stringify(categories.map((c) => [c.key, c.label, c.sizeFormatted]));
      if (signature !== cacheInfoShown || !listEl.firstChild) {
        if (categories.length === 0) showMessage('Nenhum item de armazenamento encontrado.');
        else { listEl.replaceChildren(...categories.map(cacheCategoryRow)); cacheInfoShown = signature; }
      }
    }

    // Atualiza indicadores do limite
    const maxInput = document.getElementById('cacheMaxSizeInput');
    if (maxInput && !maxInput.value) maxInput.value = info.maxSizeMB || 500;
  } catch (err) {
    console.error('[SETTINGS] Erro ao carregar informações de cache:', err);
    showMessage(`Não foi possível ler o armazenamento. ${friendlyError(err)}`);
  }
}


/* ==========================================================================
   ACELERAÇÃO DE HARDWARE / GPU
/** Retorna true quando o encoder é de hardware (GPU). */
function _isGpu(encoder) {
  const e = String(encoder || '').toLowerCase();
  return e.includes('nvenc') || e.includes('qsv') || e.includes('amf');
}

// Busca no processo principal as GPUs (WMI) e os encoders de vídeo
// selecionados (HardwareDetectionService) para exibição na aba Sistema.
async function loadHardwareInfo() {
  const gpuEl = document.getElementById('sysGpu');
  const encEl = document.getElementById('sysEncoder');
  if (!gpuEl && !encEl) return;

  try {
    const info = await window.bds.getHardwareInfo();
    if (!info) return;

    if (gpuEl) {
      const gpus = Array.isArray(info.gpus) ? info.gpus : [];
      if (gpus.length > 0) {
        // Exibe apenas o modelo da GPU (ex: "GeForce GTX 1650").
        const labels = gpus.map((g) => {
          return g.model || g.name || 'GPU';
        });
        // Remove duplicatas mantendo a ordem.
        gpuEl.textContent = [...new Set(labels)].join(' + ');
      } else {
        gpuEl.textContent = info.useHardwareAcceleration
          ? 'Nenhuma GPU com codificação detectada (CPU)'
          : 'Aceleração de hardware desativada';
      }
    }

    if (encEl) {
      const selected = info.selected || {};
      const labels = [];
      if (selected.h264) labels.push(`H.264: ${_isGpu(selected.h264) ? 'GPU' : 'CPU'}`);
      if (selected.hevc) labels.push(`HEVC: ${_isGpu(selected.hevc) ? 'GPU' : 'CPU'}`);
      if (selected.av1) labels.push(`AV1: ${_isGpu(selected.av1) ? 'GPU' : 'CPU'}`);
      encEl.textContent = labels.length > 0 ? labels.join(' | ') : '—';
    }
  } catch (err) {
    console.error('[SETTINGS] Erro ao carregar informações de hardware:', err);
    if (gpuEl) gpuEl.textContent = 'Indisponível';
    if (encEl) encEl.textContent = 'Indisponível';
  }
}

/* ==========================================================================
   ATUALIZAÇÕES (aplicativo e componentes no mesmo cartão)
   Um botão só, que muda de papel: Verificar atualizações, Baixar e atualizar, Reiniciar para instalar.
   ========================================================================== */
const UPDATE_ACTIONS = {
  check: { icon: 'sync', label: 'Verificar atualizações', busyLabel: 'Verificando…', primary: false },
  update: { icon: 'download', label: 'Baixar e atualizar', busyLabel: 'Atualizando…', primary: true },
  install: { icon: 'restart_alt', label: 'Reiniciar para instalar', busyLabel: 'Abrindo o instalador…', primary: true }
};
let pendingInstall = null; // nova versão do app já baixada, à espera do "Reiniciar para instalar"
let releaseNotes = null; // { version, text } da nova versão do app (aparece no estado "há atualização")
let updateProgressBound = false;

/** Troca o papel do botão. Ocupado usa aria-disabled (e não disabled) para o foco não se perder no botão. */
function setUpdateAction(role, busy = false) {
  const btn = document.getElementById('updateActionButton');
  if (!btn) return;
  const def = UPDATE_ACTIONS[role] || UPDATE_ACTIONS.check;
  btn.dataset.role = role;
  btn.classList.toggle('settings-btn-primary', def.primary);
  btn.classList.toggle('settings-btn-outline', !def.primary);
  if (busy) {
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('aria-busy', 'true');
  } else {
    btn.removeAttribute('aria-disabled');
    btn.removeAttribute('aria-busy');
  }
  const icon = document.getElementById('updateActionIcon');
  if (icon) {
    icon.textContent = busy ? 'progress_activity' : def.icon;
    icon.classList.toggle('st-spin', busy);
  }
  const label = document.getElementById('updateActionLabel');
  if (label) label.textContent = busy ? def.busyLabel : def.label;
}

function onUpdateAction() {
  const btn = document.getElementById('updateActionButton');
  if (!btn || btn.getAttribute('aria-disabled') === 'true') return undefined;
  if (btn.dataset.role === 'update') return startUnifiedUpdate();
  if (btn.dataset.role === 'install') return installPendingUpdate();
  return checkUpdates();
}

function setAppLine(text) {
  const el = document.getElementById('appUpdateStatusText');
  if (el) el.textContent = text;
}

function setComponentsLine(text) {
  const el = document.getElementById('componentsUpdateStatusText');
  if (el) el.textContent = text;
}

/** Notas da versão: só aparecem enquanto há atualização do aplicativo para baixar ou instalar. */
function renderReleaseNotes(visible) {
  const box = document.getElementById('updateReleaseNotes');
  if (!box) return;
  const show = Boolean(visible && releaseNotes);
  box.classList.toggle('hidden', !show);
  if (!show) return;
  const title = document.getElementById('updateReleaseNotesTitle');
  const text = document.getElementById('updateReleaseNotesText');
  if (title) title.textContent = releaseNotes.version ? `Novidades da v${releaseNotes.version}` : 'Novidades desta versão';
  if (text) text.textContent = releaseNotes.text;
}

function setUpdateStatusView(stateType, extraMessage = '') {
  const iconWrap = document.getElementById('updateStatusIconWrap');
  const icon = document.getElementById('updateStatusIcon');
  const headline = document.getElementById('updateHeadline');
  const subHeadline = document.getElementById('updateSubHeadline');
  const progressContainer = document.getElementById('updateProgressContainer');

  if (!iconWrap || !icon || !headline || !subHeadline) return;

  iconWrap.className = 'settings-update-icon-wrap';
  const hideProgress = () => { if (progressContainer) progressContainer.classList.add('hidden'); };

  switch (stateType) {
    case 'loading':
      iconWrap.classList.add('updating');
      icon.textContent = 'sync';
      headline.textContent = 'Verificando atualizações...';
      subHeadline.textContent = 'Consultando as fontes oficiais. Isso leva alguns segundos.';
      hideProgress();
      setUpdateAction('check', true);
      break;

    case 'has_updates':
      iconWrap.classList.add('has-updates');
      icon.textContent = 'system_update';
      headline.textContent = 'Existem atualizações disponíveis.';
      subHeadline.textContent = extraMessage || 'Veja abaixo o que será atualizado e use "Baixar e atualizar".';
      hideProgress();
      setUpdateAction('update');
      break;

    case 'up_to_date':
      icon.textContent = 'check_circle';
      headline.textContent = 'Tudo está atualizado.';
      subHeadline.textContent = 'O aplicativo e os recursos do BDS já estão nas versões mais recentes.';
      hideProgress();
      setUpdateAction('check');
      break;

    case 'updating':
      iconWrap.classList.add('updating');
      icon.textContent = 'downloading';
      headline.textContent = 'Atualizando o BDS...';
      subHeadline.textContent = extraMessage || 'Preparando componentes...';
      if (progressContainer) progressContainer.classList.remove('hidden');
      setUpdateAction('update', true);
      break;

    case 'ready':
      iconWrap.classList.add('has-updates');
      icon.textContent = 'restart_alt';
      headline.textContent = 'A nova versão do BDS está pronta para instalar.';
      subHeadline.textContent = extraMessage || 'O BDS vai fechar, o instalador roda sozinho e o BDS abre de novo atualizado.';
      hideProgress();
      setUpdateAction('install');
      break;

    case 'partial':
      iconWrap.classList.add('has-updates');
      icon.textContent = 'info';
      headline.textContent = 'Verificação incompleta.';
      subHeadline.textContent = extraMessage || 'Não foi possível consultar todas as fontes agora.';
      hideProgress();
      setUpdateAction('check');
      break;

    case 'error':
      iconWrap.classList.add('error');
      icon.textContent = 'error';
      headline.textContent = 'Não foi possível verificar atualizações.';
      subHeadline.textContent = extraMessage || 'Verifique sua conexão com a internet e tente novamente.';
      hideProgress();
      setUpdateAction('check');
      break;
  }
  renderReleaseNotes(stateType === 'has_updates' || stateType === 'ready');
}

const OFFLINE_HINT = 'Não foi possível consultar as fontes de atualização. Verifique sua conexão com a internet e tente novamente.';

function setLastCheck(text) {
  const el = document.getElementById('updateLastCheck');
  if (!el) return;
  const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  el.textContent = text ? `Última verificação às ${time}: ${text}` : '';
}

/** Títulos dos componentes que precisam de atualização (os sob demanda e ainda não instalados não contam). */
function componentsNeedingUpdate(deps) {
  return (deps?.components || [])
    .filter((c) => c.needsUpdate && !c.unavailable && !(c.onDemand && !c.isInstalled))
    .map((c) => c.title);
}

/** Linha de estado dos componentes. */
function reflectComponentsUpdate(deps) {
  if (!deps) return;
  if (deps.checkFailed || deps.error) {
    setComponentsLine('Não foi possível verificar agora (sem conexão ou serviço indisponível).');
    return;
  }
  const names = componentsNeedingUpdate(deps);
  setComponentsLine(names.length ? `Há atualização para: ${names.join(', ')}.` : 'Todos estão nas versões mais recentes.');
}

/** Linha de estado do aplicativo e, havendo versão nova, as notas dela (texto puro, vindo da página da release). */
function reflectAppUpdate(appInfo) {
  if (!appInfo) return;
  const notes = typeof appInfo.releaseNotes === 'string' ? appInfo.releaseNotes.trim() : '';
  releaseNotes = appInfo.hasUpdate && notes
    ? { version: appInfo.latestVersion || '', text: notes.length > 1200 ? `${notes.slice(0, 1200).trimEnd()}…` : notes }
    : null;
  if (appInfo.devBuild) {
    setAppLine(`Versão de desenvolvimento (v${appInfo.currentVersion}): a atualização automática do aplicativo só vale para a versão instalada.`);
  } else if (appInfo.hasUpdate) {
    setAppLine(`Nova versão disponível: v${appInfo.latestVersion} (você está na v${appInfo.currentVersion}).`);
  } else if (appInfo.checkFailed || appInfo.error) {
    setAppLine('Não foi possível verificar a versão do aplicativo agora (sem conexão ou serviço indisponível).');
  } else if (appInfo.currentVersion) {
    setAppLine(`Você está na versão mais recente (v${appInfo.currentVersion}).`);
  }
}

/**
 * Mostra o resultado de uma verificação (feita agora ou ao abrir o BDS) no cartão: as duas linhas de estado, o
 * cabeçalho, o papel do botão e as notas da versão. Devolve o estado escolhido.
 */
function showUpdateCheck(result) {
  const deps = result?.dependencies;
  const app = result?.app;
  const depsFailed = Boolean(deps?.checkFailed || deps?.error);
  const appFailed = Boolean(app?.checkFailed || app?.error);
  // as notas e as linhas vêm antes do cabeçalho: setUpdateStatusView decide se as notas aparecem
  if (app) reflectAppUpdate(app);
  reflectComponentsUpdate(deps);

  if (result?.hasUpdates) {
    setUpdateStatusView('has_updates');
    return { kind: 'has_updates', listed: componentsNeedingUpdate(deps).length > 0 || Boolean(app?.hasUpdate) };
  }
  if (depsFailed && appFailed) {
    setUpdateStatusView('error', OFFLINE_HINT);
    return { kind: 'error' };
  }
  if (depsFailed || appFailed) {
    setUpdateStatusView('partial', depsFailed
      ? 'Os recursos do BDS não puderam ser conferidos agora (sem conexão ou serviço indisponível). Tente novamente mais tarde.'
      : 'A versão do aplicativo não pôde ser conferida agora (sem conexão ou serviço indisponível). Os recursos estão em dia.');
    return { kind: 'partial' };
  }
  setUpdateStatusView('up_to_date');
  return { kind: 'up_to_date' };
}

async function checkUpdates() {
  const container = document.getElementById('updateProgressContainer');
  const fill = document.getElementById('updateProgressFill');
  const stepEl = document.getElementById('updateProgressStep');
  const percentEl = document.getElementById('updateProgressPercent');
  setUpdateStatusView('loading');
  // Barra indeterminada enquanto consulta (sem porcentagem inventada)
  if (container) container.classList.remove('hidden');
  if (fill) { fill.classList.add('indeterminate'); fill.style.width = ''; }
  if (stepEl) stepEl.textContent = 'Consultando as fontes oficiais…';
  if (percentEl) percentEl.textContent = '';
  setLastCheck('');
  setStatus('Verificando atualizações...');
  const finish = () => { fill?.classList.remove('indeterminate'); container?.classList.add('hidden'); };

  try {
    const result = window.bds.checkEverything ? await window.bds.checkEverything() : await window.bds.checkUpdates();
    finish();
    const shown = showUpdateCheck(result);
    if (shown.kind === 'has_updates') {
      setStatus('Existem atualizações disponíveis.');
      setLastCheck(shown.listed ? 'há atualizações disponíveis.' : 'concluída.');
    } else if (shown.kind === 'error') {
      setStatus('Sem conexão com as fontes de atualização.');
      setLastCheck('não foi possível consultar as fontes.');
    } else if (shown.kind === 'partial') {
      setStatus('Não foi possível verificar tudo agora.');
      setLastCheck('verificação incompleta.');
    } else {
      setStatus('Tudo atualizado.');
      setLastCheck('tudo atualizado.');
    }
  } catch (error) {
    console.error('[SETTINGS] Erro ao verificar atualizações:', error);
    finish();
    setUpdateStatusView('error', `${friendlyError(error, OFFLINE_HINT)}`);
    setStatus('Não foi possível verificar atualizações.');
    setLastCheck('falhou.');
  }
}

/**
 * Nova versão já baixada: pergunta e, se o usuário aceitar, fecha o BDS e abre o instalador
 * (que reabre o app ao terminar). Devolve true se a instalação foi disparada.
 */
async function offerInstallDownloadedUpdate(appUpdate) {
  const version = appUpdate?.latestVersion ? `v${appUpdate.latestVersion}` : 'nova versão';
  // "Verificada" só quando o SHA-256 publicado na release foi conferido; sem ele, dizer a verdade e deixar a decisão com o usuário
  const verified = appUpdate?.digestVerified === true;
  let question = verified
    ? `A ${version} do BDS foi baixada e verificada.\n\nPara instalar, o BDS vai fechar, o instalador roda sozinho e o BDS abre de novo atualizado. Instalar agora?`
    : `A ${version} do BDS foi baixada, mas a release não publicou o código de verificação: não foi possível conferir se o instalador está íntegro.\n\nPara instalar, o BDS vai fechar, o instalador roda sozinho e o BDS abre de novo atualizado. Instalar mesmo assim?`;
  // Instalado numa pasta protegida (Program Files): o Windows pode pedir permissão (UAC) durante a instalação
  if (typeof window.bds?.isPackaged === 'function') {
    let packaged = false;
    try { packaged = Boolean(await window.bds.isPackaged()); } catch (_) { /* sem a informação, só não mostra o aviso */ }
    if (packaged) question += '\n\nObservação: como o BDS está instalado em uma pasta protegida, o Windows pode exibir um aviso de permissão (UAC) durante a instalação.';
  }
  const ok = await window.bdsModal.confirm(question);
  if (!ok || !window.bds.installAppUpdate) {
    setAppLine('Nova versão baixada. Use "Reiniciar para instalar" quando quiser concluir.');
    return false;
  }
  setAppLine('Abrindo o instalador... o BDS vai fechar.');
  try {
    const r = await window.bds.installAppUpdate();
    if (r && r.success === false) {
      setAppLine(`Não foi possível abrir o instalador. ${friendlyError(r.error || '')}`.trim());
      window.bdsModal?.alert?.(`Não foi possível abrir o instalador.\n${friendlyError(r.error || '')}`.trim());
      return false;
    }
    return true;
  } catch (err) {
    setAppLine('Não foi possível abrir o instalador.');
    window.bdsModal?.alert?.('Não foi possível abrir o instalador. ' + friendlyError(err, ''));
    return false;
  }
}

/** "Reiniciar para instalar": a nova versão já está baixada (e verificada pelo SHA-256 quando a release o publica). */
async function installPendingUpdate() {
  if (!pendingInstall) { await checkUpdates(); return; }
  setUpdateAction('install', true);
  const launched = await offerInstallDownloadedUpdate(pendingInstall);
  if (!launched) setUpdateStatusView('ready');
}

/** Barra de progresso única (aplicativo e componentes): uma assinatura só, que procura os elementos a cada evento. */
function bindUpdateProgress() {
  if (updateProgressBound || !window.bds.onUpdateProgress) return;
  updateProgressBound = true;
  window.bds.onUpdateProgress((data) => {
    const fill = document.getElementById('updateProgressFill');
    const percentEl = document.getElementById('updateProgressPercent');
    const stepEl = document.getElementById('updateProgressStep');
    const info = data || {};
    const pct = info.percent == null ? null : info.percent;
    if (fill) {
      if (pct == null) {
        // Total desconhecido: mostra barra indeterminada animada.
        fill.classList.add('indeterminate');
      } else {
        fill.classList.remove('indeterminate');
        fill.style.width = `${pct}%`;
      }
    }
    if (percentEl) percentEl.textContent = pct == null ? (info.message ? '...' : '') : `${pct}%`;
    if (stepEl && info.message) stepEl.textContent = info.message;
  });
}

async function startUnifiedUpdate() {
  setUpdateStatusView('updating', 'Iniciando atualização...');
  setStatus('Atualizando o BDS...');

  const fill = document.getElementById('updateProgressFill');
  const percentEl = document.getElementById('updateProgressPercent');
  const stepEl = document.getElementById('updateProgressStep');
  if (fill) { fill.classList.remove('indeterminate'); fill.style.width = '0%'; }
  if (percentEl) percentEl.textContent = '0%';
  bindUpdateProgress();

  try {
    // updateEverything atualiza as dependências E, se houver nova versão do app,
    // baixa o instalador (verificado) e o deixa pronto. Retorna { dependencies, appUpdate, needsRestart }.
    const result = window.bds.updateEverything
      ? await window.bds.updateEverything()
      : await window.bds.installUpdates();

    // Se o fluxo unificado não estiver disponível (fallback), trata apenas dependências.
    if (!window.bds.updateEverything) {
      const nothingChanged = result?.updatedCount === 0 && (result?.skippedDueToBusy || result?.errors?.length === 0);
      if (result && result.success && !nothingChanged) {
        if (fill) fill.style.width = '100%';
        if (percentEl) percentEl.textContent = '100%';
        if (stepEl) stepEl.textContent = 'Componentes atualizados!';
        setStatus('Atualização concluída com sucesso.');
        setTimeout(() => setUpdateStatusView('up_to_date'), 1500);
      } else if (result && result.success) {
        setUpdateStatusView('up_to_date');
        setStatus('Todos os componentes já estão atualizados.');
      } else {
        setUpdateStatusView('error');
        setStatus('Atualização concluída com avisos.');
      }
      return;
    }

    // Fluxo unificado disponível.
    const appUpdate = result?.appUpdate;
    const deps = result?.dependencies;
    await confirmUnverifiedUpdates(deps);

    if (fill) fill.style.width = '100%';
    if (percentEl) percentEl.textContent = '100%';
    if (appUpdate?.appInfo) reflectAppUpdate(appUpdate.appInfo);
    if (deps) {
      setComponentsLine(deps.success
        ? (deps.updatedCount > 0 ? 'Componentes atualizados.' : 'Todos estão nas versões mais recentes.')
        : 'Alguns componentes não puderam ser atualizados.');
    }

    // Nova versão do app baixada? A instalação fecha o BDS e abre o instalador.
    if (appUpdate && appUpdate.readyToInstall) {
      if (stepEl) stepEl.textContent = appUpdate.digestVerified ? 'Nova versão do BDS baixada e verificada.' : 'Nova versão do BDS baixada, sem verificação de integridade.';
      setAppLine('Nova versão baixada. Falta instalar.');
      setStatus('Nova versão do BDS pronta para instalar.');
      pendingInstall = appUpdate;
      const launched = await offerInstallDownloadedUpdate(appUpdate);
      if (!launched) {
        setUpdateStatusView('ready', 'A nova versão do BDS já foi baixada. Use "Reiniciar para instalar" quando quiser concluir.');
        setStatus('Instalação adiada.');
      }
      return;
    }

    if (appUpdate && appUpdate.error) {
      // Falha ao baixar/instalar o app — oferecer abrir a release no navegador.
      if (stepEl) stepEl.textContent = 'Falha ao atualizar o app automaticamente.';
      setAppLine(`Não foi possível atualizar automaticamente. ${friendlyError(appUpdate.error)}`);
      const openRelease = await window.bdsModal.confirm(
        `Não foi possível atualizar o aplicativo automaticamente.\n${friendlyError(appUpdate.error)}\n\nDeseja abrir a página oficial do BDS para baixar manualmente?`
      );
      if (openRelease && appUpdate.appInfo?.releaseUrl) {
        window.bds.openExternal?.(appUpdate.appInfo.releaseUrl);
      }
      setUpdateStatusView('has_updates', 'Não foi possível baixar a nova versão do BDS automaticamente. Use "Baixar e atualizar" para tentar de novo.');
      setStatus('Não foi possível atualizar o aplicativo.');
      return;
    }

    // Dependências
    if (deps && deps.success) {
      if (deps.updatedCount > 0) {
        if (stepEl) stepEl.textContent = 'Componentes atualizados!';
        setStatus('Atualização concluída com sucesso.');
      } else {
        if (stepEl) stepEl.textContent = 'Todos os componentes já estavam atualizados.';
        setStatus('Todos os componentes já estão atualizados.');
      }
      setTimeout(() => setUpdateStatusView('up_to_date'), 1500);
    } else if (deps && deps.errors?.length) {
      setUpdateStatusView('error');
      setStatus('Atualização de componentes concluída com avisos.');
    } else {
      setUpdateStatusView('error');
      setStatus('Falha ao atualizar os componentes.');
    }
  } catch (error) {
    console.error('[SETTINGS] Erro durante a atualização:', error);
    setUpdateStatusView('error', friendlyError(error, 'Verifique sua conexão e tente novamente.'));
    setStatus('Não foi possível atualizar. ' + friendlyError(error, 'Tente novamente.'));
  }
}

/* ==========================================================================
   RELATÓRIOS DE ERROS / CRASH REPORTS
   ========================================================================== */
let errorReportingUIReady = false;

function setupErrorReportingUI() {
  if (errorReportingUIReady) return;
  errorReportingUIReady = true;
  setupReportProblemModal();
}

/** Atualiza só o resumo ("N relatórios"); o conteúdo dos relatórios não é exibido ao usuário. */
async function loadCrashReports() {
  const summary = document.getElementById('crashReportsSummary');
  if (!summary) return;
  if (!window.bds?.getCrashReports) return;
  try {
    const reports = await window.bds.getCrashReports();
    const count = Array.isArray(reports) ? reports.length : 0;
    summary.textContent = count === 0
      ? 'Nenhum relatório guardado.'
      : (count === 1 ? '1 relatório guardado.' : `${count} relatórios guardados.`);
    // Sem relatórios, enviar e apagar não fazem sentido: somem (não ficam desabilitados). Se o foco estava num deles, vai
    // para "Relatar um problema" antes de o botão sumir.
    const fallback = document.getElementById('reportProblemButton');
    const sendLabel = document.getElementById('sendCrashReportsLabel');
    if (sendLabel && !sendingReports) sendLabel.textContent = count === 1 ? 'Enviar 1 relatório' : count > 1 ? `Enviar ${count} relatórios` : 'Enviar relatórios';
    setVisible(document.getElementById('sendCrashReportsButton'), count > 0, fallback);
    setVisible(document.getElementById('clearCrashReportsButton'), count > 0, fallback);
  } catch (err) {
    console.error('[SETTINGS] Erro ao carregar relatórios:', err);
    summary.textContent = 'Não foi possível verificar os relatórios.';
  }
}

/** Envia todos os relatórios guardados: direto (servidor configurado) ou pelo e-mail do usuário. */
let sendingReports = false;

async function sendCrashReports() {
  if (!window.bds?.sendCrashReports || sendingReports) return;
  const button = document.getElementById('sendCrashReportsButton');
  const label = document.getElementById('sendCrashReportsLabel');
  // Em vez de desabilitar o botão (o foco se perderia), ele fica marcado como ocupado e ignora cliques até terminar
  sendingReports = true;
  button?.setAttribute('aria-busy', 'true');
  if (label) label.textContent = 'Enviando…';
  setResult('supportResult', '');
  try {
    setStatus('Enviando relatórios...');
    const result = await window.bds.sendCrashReports();
    if (!result || result.method === 'none') {
      setResult('supportResult', 'Não há relatórios para enviar.');
    } else if (result.method === 'http') {
      setResult('supportResult', result.sent === result.count
        ? `${result.sent} ${result.sent === 1 ? 'relatório enviado' : 'relatórios enviados'}. Obrigado!`
        : `${result.sent} de ${result.count} relatórios enviados. Os demais continuam guardados para uma nova tentativa.`);
    } else if (result.mailto && typeof window.bds.openExternal === 'function') {
      await window.bds.openExternal(result.mailto);
      // pede uma ação (enviar a mensagem): fica escrito até a próxima ação
      setResult('supportResult', 'Abrimos o seu e-mail com o resumo dos relatórios. Basta enviar a mensagem.');
    } else {
      window.bdsModal.alert('Não foi possível abrir o cliente de e-mail neste dispositivo.');
    }
  } catch (err) {
    console.error('[SETTINGS] Falha ao enviar relatórios:', err);
    window.bdsModal.alert(`Não foi possível enviar os relatórios. ${friendlyError(err, 'Verifique sua conexão e tente de novo.')}`);
  } finally {
    sendingReports = false;
    button?.removeAttribute('aria-busy');
    if (label) label.textContent = 'Enviar relatórios'; // loadCrashReports põe o número de relatórios
    await loadCrashReports();
  }
}

function openSettingsModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('active');
  }
}

function closeSettingsModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('active');
  }
}

/**
 * Janela de Configurações que fecha por X, Esc e clique fora, sem botão Cancelar.
 *  - Esc: enhanceModalOverlay (utils/modal.js) clica no X, então X e Esc passam pela mesma trava; ele também prende o
 *    Tab dentro da janela e devolve o foco a quem abriu.
 *  - clique fora: só fecha se o botão do mouse também foi pressionado fora (selecionar texto e soltar fora não conta)
 *    e se nenhum campo foi preenchido (nada digitado se perde).
 *  - enquanto `setBusy(true)` (cadastro ou geração em andamento) nada fecha a janela; o X fica aria-disabled.
 */
function setupDismissibleModal(modal, { closeBtn, fields = [] }) {
  enhanceModalOverlay(modal, { isOpen: (el) => !el.classList.contains('hidden') });
  let busy = false;

  const open = () => {
    modal.classList.remove('hidden');
    modal.classList.add('active');
  };
  const close = () => {
    modal.classList.add('hidden');
    modal.classList.remove('active');
  };
  const setBusy = (value) => {
    busy = value;
    if (value) closeBtn?.setAttribute('aria-disabled', 'true');
    else closeBtn?.removeAttribute('aria-disabled');
  };

  closeBtn?.addEventListener('click', () => { if (!busy) close(); });

  let pressedOutside = false;
  modal.addEventListener('mousedown', (e) => { pressedOutside = e.target === modal; });
  modal.addEventListener('click', (e) => {
    const startedOutside = pressedOutside;
    pressedOutside = false;
    if (e.target !== modal || !startedOutside || busy) return;
    if (fields.some((field) => (field?.value || '').trim())) return;
    close();
  });

  return { open, close, setBusy };
}

function setupReportProblemModal() {
  const modal = document.getElementById('modalSettingsReportProblem');
  if (!modal) return;
  const desc = document.getElementById('modalSettingsReportProblemDesc');
  const confirmBtn = document.getElementById('modalSettingsReportProblemConfirm');
  const dialog = setupDismissibleModal(modal, {
    closeBtn: document.getElementById('btnCloseSettingsReportProblem'),
    fields: [desc]
  });

  document.getElementById('reportProblemButton')?.addEventListener('click', dialog.open);

  confirmBtn?.addEventListener('click', async () => {
    const description = (desc?.value || '').trim();
    if (!description) {
      await window.bdsModal.alert('Por favor, descreva o problema antes de gerar o e-mail.');
      desc?.focus();
      return;
    }
    if (!window.bds?.generateManualMailto) return;
    const restore = setButtonBusy(confirmBtn, 'Gerando...');
    dialog.setBusy(true);
    try {
      const mailtoUrl = await window.bds.generateManualMailto(description);
      if (!mailtoUrl) {
        window.bdsModal.alert('Não foi possível gerar o e-mail de suporte.');
        return;
      }
      dialog.close();
      if (desc) desc.value = '';
      if (typeof window.bds.openExternal === 'function') {
        await window.bds.openExternal(mailtoUrl);
      }
      // O relato é salvo localmente pelo processo principal — atualiza a lista.
      await loadCrashReports();
    } catch (err) {
      console.error('[SETTINGS] Erro ao gerar e-mail de suporte:', err);
      window.bdsModal.alert(`Não foi possível preparar o e-mail de suporte. ${friendlyError(err)}`);
    } finally {
      dialog.setBusy(false);
      restore();
    }
  });
}

/* ==========================================================================
   FONTES PERSONALIZADAS
   ========================================================================== */
async function loadSettingsCustomSources() {
  const container = document.getElementById('settingsCustomSourcesList');
  if (!container) return;

  try {
    customSources = (await window.bds.getCustomSources()) || [];
    renderCustomSourcesList();
  } catch (err) {
    console.error('[SETTINGS] Erro ao carregar fontes personalizadas:', err);
    container.innerHTML = `<p class="settings-empty-sources">Não foi possível carregar as fontes. ${escapeHtml(friendlyError(err))}</p>`;
  }
}

function renderCustomSourcesList() {
  const container = document.getElementById('settingsCustomSourcesList');
  if (!container) return;

  if (customSources.length === 0) {
    container.innerHTML = '<p class="settings-empty-sources">Nenhuma fonte personalizada cadastrada no momento.</p>';
    return;
  }

  container.innerHTML = customSources.map(src => `
    <div class="settings-custom-source-item">
      <div class="settings-custom-source-info">
        <span class="material-symbols-rounded">folder_special</span>
        <div class="settings-custom-source-text">
          <div class="settings-custom-source-name">${escapeHtml(src.name)}</div>
          <div class="settings-custom-source-path" title="${escapeHtml(src.path)}">${escapeHtml(src.path)}</div>
        </div>
      </div>
      <div class="settings-custom-source-actions">
        <button class="btn-edit-custom-source" data-id="${src.id}" data-name="${escapeHtml(src.name)}" data-path="${escapeHtml(src.path)}" aria-label="Alterar a pasta de ${escapeHtml(src.name)}" title="Alterar a pasta de ${escapeHtml(src.name)}" type="button">
          <span class="material-symbols-rounded" aria-hidden="true">edit</span>
        </button>
        <button class="btn-delete-custom-source" data-id="${src.id}" data-name="${escapeHtml(src.name)}" aria-label="Remover a fonte ${escapeHtml(src.name)}" title="Remover a fonte ${escapeHtml(src.name)} e suas mídias" type="button">
          <span class="material-symbols-rounded" aria-hidden="true">delete</span>
        </button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.btn-edit-custom-source').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { id, name, path } = btn.dataset;
      const newFolder = await window.bds.selectFolder(path);
      if (newFolder && newFolder !== path) {
        try {
          await window.bds.updateCustomSourcePath({ id, name, newFolderPath: newFolder });
          await loadSettingsCustomSources();
          window.bdsModal.alert(`A pasta da fonte "${name}" foi alterada para:\n${newFolder}`);
        } catch (err) {
          window.bdsModal.alert(`Não foi possível alterar a pasta da fonte. ${friendlyError(err)}`);
        }
      }
    });
  });

  container.querySelectorAll('.btn-delete-custom-source').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { id, name } = btn.dataset;
      const confirm = await window.bdsModal.confirm(
        `Deseja realmente remover a fonte personalizada "${name}"?\nTodas as mídias associadas a esta fonte serão removidas da biblioteca.`
      );
      if (!confirm) return;
      try {
        await window.bds.removeCustomSource({ id, name });
        await loadSettingsCustomSources();
        window.bdsModal.alert(`A fonte "${name}" e suas mídias foram removidas da biblioteca com sucesso!`);
      } catch (err) {
        if (/cancelad/i.test(err.message || '')) return; // usuário desistiu no diálogo nativo
        window.bdsModal.alert(`Não foi possível remover a fonte. ${friendlyError(err)}`);
      }
    });
  });
}

/* ==========================================================================
   MODAL DE FONTE PERSONALIZADA
   ========================================================================== */
function setupCustomSourceModal() {
  const modal = document.getElementById('modalSettingsAddCustomSource');
  const btnOpen = document.getElementById('btnSettingsAddCustomSource');
  const btnClose = document.getElementById('btnCloseSettingsCustomSourceModal');
  const btnBrowse = document.getElementById('modalSettingsAddCustomSourceSelectBtn');
  const btnConfirm = document.getElementById('modalSettingsAddCustomSourceConfirm');
  const nameInput = document.getElementById('modalSettingsAddCustomSourceName');
  const pathInput = document.getElementById('modalSettingsAddCustomSourcePath');
  const statusEl = document.getElementById('settingsCustomSourcesStatus');

  if (!modal) return;

  const dialog = setupDismissibleModal(modal, { closeBtn: btnClose, fields: [nameInput, pathInput] });

  btnOpen?.addEventListener('click', () => {
    if (statusEl) statusEl.textContent = '';
    dialog.open();
  });

  btnBrowse?.addEventListener('click', async () => {
    const folder = await window.bds.selectFolder();
    if (folder && pathInput) pathInput.value = folder;
  });

  btnConfirm?.addEventListener('click', async () => {
    const sourceName = nameInput?.value?.trim();
    const folderPath = pathInput?.value?.trim();

    if (!sourceName) return window.bdsModal.alert('Por favor, informe o nome desejado para a fonte personalizada.');
    if (!folderPath) return window.bdsModal.alert('Por favor, selecione a pasta da fonte.');

    const restore = setButtonBusy(btnConfirm, 'Indexando...');
    dialog.setBusy(true);

    try {
      await window.bds.addCustomSource({ name: sourceName, folderPath });
      dialog.close();
      if (nameInput) nameInput.value = '';
      if (pathInput) pathInput.value = '';
      await loadSettingsCustomSources();
      // Sucesso fica no cartão das fontes (região aria-live); só o erro continua em diálogo.
      if (statusEl) statusEl.textContent = `Fonte "${sourceName}" cadastrada. As mídias dela foram indexadas na biblioteca.`;
    } catch (err) {
      window.bdsModal.alert(`Não foi possível cadastrar a fonte. ${friendlyError(err)}`);
    } finally {
      dialog.setBusy(false);
      restore();
    }
  });
}