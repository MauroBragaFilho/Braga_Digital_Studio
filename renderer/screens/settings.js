import { normalizeAccentHex } from '../utils/accent-palette.js';
import { state, setStatus, escapeHtml, applyTheme, applyAccentColor, applyUiPreferences, getVisibleSidebarTabs, getDefaultTabOrder, tabShortcutLabel } from '../app.js';
import { friendlyError } from '../utils/friendlyError.js';

let customSources = [];

export function initScreen() {
  console.log('[SETTINGS] Inicializando tela...');
  renderSettings();
  setupTabs();
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
    setUpdateStatusView(pending.hasUpdates ? 'has_updates' : 'up_to_date');
    // Se o resultado unificado trouxer dados do app, reflete no painel dedicado.
    if (pending.app) reflectAppUpdate(pending.app);
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
      clearSettingsSearch();
      const targetId = tab.dataset.tab;
      tabs.forEach(t => { t.classList.remove('active'); t.removeAttribute('aria-current'); });
      views.forEach(v => v.classList.add('hidden'));
      tab.classList.add('active');
      tab.setAttribute('aria-current', 'page');
      const targetView = document.getElementById(targetId);
      if (targetView) targetView.classList.remove('hidden');
      // O painel do módulo de transcrição só existe enquanto a aba está aberta
      if (targetId === 'settingsModulesView') loadModulesList();
      if (targetId === 'settingsTranscriptionView') mountTranscriptionPanel();
      else unmountTranscriptionPanel();
      // O servidor de IA (seção Inteligência Artificial) também só é montado com a aba aberta
      if (targetId === 'settingsAiView') mountAiPanel();
      else unmountAiPanel();
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
    if (go) document.querySelector('.settings-tab[data-tab="settingsTranscriptionView"]')?.click();
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
  setChk('downloadPauseEnabledInput', s.downloadPauseEnabled !== false);
  setVal('downloadPauseMinInput', s.downloadPauseMinSec ?? 10);
  setVal('downloadPauseMaxInput', s.downloadPauseMaxSec ?? 180);
  syncDownloadPauseRange();

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
    lutThumb.src = s.lutPreviewImage ? `file://${s.lutPreviewImage}` : './assets/lut_preview.jpg';
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

function bindEvents() {
  document.getElementById('saveSettingsButton')?.addEventListener('click', saveSettings);
  document.getElementById('downloadPauseEnabledInput')?.addEventListener('change', syncDownloadPauseRange);

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
  document.getElementById('shadowplayFolderButton')?.addEventListener('click', () => chooseFolder('shadowplayFolderInput'));
  document.getElementById('deviceFolderButton')?.addEventListener('click', () => chooseFolder('deviceFolderInput'));
  document.getElementById('converterFolderButton')?.addEventListener('click', () => chooseFolder('converterFolderInput'));
  document.getElementById('restoreDownloadFoldersButton')?.addEventListener('click', () => restoreDefaultFolders([['mp3FolderInput', 'mp3Folder'], ['mp4FolderInput', 'mp4Folder']]));
  document.getElementById('restoreConverterFolderButton')?.addEventListener('click', () => restoreDefaultFolders([['converterFolderInput', 'converterFolder']]));

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

  // Relatórios de erros: enviar e limpar (sem expor o conteúdo dos relatórios)
  document.getElementById('sendCrashReportsButton')?.addEventListener('click', sendCrashReports);
  document.getElementById('clearCrashReportsButton')?.addEventListener('click', async () => {
    if (typeof window.bds?.clearCrashReports !== 'function') return;
    const confirmed = await window.bdsModal.confirm(
      'Apagar os relatórios de erro guardados neste computador?\n\nEles deixam de poder ser enviados ao desenvolvedor. Esta ação não pode ser desfeita.'
    );
    if (!confirmed) return;
    try {
      const result = await window.bds.clearCrashReports();
      await loadCrashReports();
      window.bdsModal.alert(result && result.deleted > 0
        ? `${result.deleted} relatório(s) removido(s) com sucesso.`
        : 'Não havia relatórios para limpar.');
    } catch (err) {
      console.error('[SETTINGS] Erro ao limpar relatórios:', err);
      window.bdsModal.alert('Não foi possível limpar os relatórios. Tente novamente.');
    }
  });

  // LUTs Preview Image Select / Reset
  document.getElementById('lutPreviewImageSelectBtn')?.addEventListener('click', async () => {
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
        if (thumb) thumb.src = `file://${filePath}`;
      }
    } catch (err) {
      console.error('[SETTINGS] Erro ao selecionar imagem de LUT:', err);
    }
  });

  document.getElementById('lutPreviewImageResetBtn')?.addEventListener('click', () => {
    const input = document.getElementById('lutPreviewImageInput');
    if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
    const thumb = document.getElementById('settingsLutPreviewThumb');
    if (thumb) thumb.src = './assets/lut_preview.jpg';
  });

  // Tema — aplica preview imediato ao trocar
  document.getElementById('themeSelect')?.addEventListener('change', (e) => {
    const accentColor = document.getElementById('accentColorInput')?.value || state.settings?.accentColor || '#ff0000';
    applyTheme(e.target.value, accentColor);
  });

  // Atualizações
  document.getElementById('checkUpdatesButton')?.addEventListener('click', checkUpdates);
  document.getElementById('checkAppUpdateButton')?.addEventListener('click', checkAppUpdate);
  document.getElementById('updateNowButton')?.addEventListener('click', startUnifiedUpdate);

  document.getElementById('updateLaterButton')?.addEventListener('click', () => {
    const btnNow = document.getElementById('updateNowButton');
    const btnLater = document.getElementById('updateLaterButton');
    if (btnNow) btnNow.classList.add('hidden');
    if (btnLater) btnLater.classList.add('hidden');
    setUpdateStatusView('later');
  });

  // Exportar Logs de Diagnóstico
  document.getElementById('exportLogsButton')?.addEventListener('click', async () => {
    try {
      setStatus('Exportando registros de diagnóstico...');
      const res = await window.bds.exportDiagnosticLogs();
      if (res && res.success) {
        setStatus('Registros exportados com sucesso.');
        window.bdsModal.alert(`Registros exportados com sucesso para:\n${res.exportPath}`);
      } else if (!res?.cancelled) {
        window.bdsModal.alert('Não foi possível exportar os registros. Tente de novo em outra pasta.');
      }
    } catch (e) {
      console.error('[SETTINGS] Erro ao exportar logs:', e);
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
    const restore = setButtonBusy(document.getElementById('clearDbButton'), 'Limpando…');
    try {
      setStatus('Limpando o catálogo da biblioteca...');
      await window.bds.clearLibraryDatabase();
      setStatus('Catálogo da biblioteca limpo.');
      window.bdsModal.alert('Pronto. O catálogo foi limpo e as pastas serão lidas de novo do zero. Seus arquivos continuam no disco.');
    } catch (e) {
      if (/cancelad/i.test(e?.message || '')) { setStatus('Limpeza cancelada. Nada foi apagado.'); return; }
      setStatus('Não foi possível limpar o catálogo.');
      window.bdsModal.alert(`Não foi possível limpar o catálogo da biblioteca. ${friendlyError(e)}`);
    } finally {
      restore();
    }
  });

  // Armazenamento — Atualizar informações
  document.getElementById('refreshCacheButton')?.addEventListener('click', loadCacheInfo);

  // Armazenamento — Limpar tudo
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
  const all = ['clearCacheButton', 'refreshCacheButton'].map((id) => document.getElementById(id));
  const others = [...document.querySelectorAll('button[data-clear-cache]')].filter((b) => b !== button);
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
    window.bdsModal.alert(`Pronto! ${r.totalFormatted} liberados.`);
  } catch (e) {
    setStatus('Não foi possível limpar o armazenamento.');
    if (result) result.textContent = 'Não foi possível limpar.';
    window.bdsModal.alert(`Não foi possível limpar ${what}. ${friendlyError(e, 'Feche tarefas em andamento (downloads, conversões) e tente de novo.')}`);
  } finally {
    restore();
    [...all, ...others].forEach((b) => { if (b) b.disabled = false; });
    loadCacheInfo();
  }
}

/** Aviso visível (toast); o texto de status do app não existe nesta tela. */
function notify(message, type) {
  if (typeof window.bdsToast === 'function') window.bdsToast(message, { type });
  else setStatus(message);
}

/** "Restaurar padrão": põe nos campos as pastas padrão do app. Só vale depois de Salvar (como ao escolher uma pasta). */
async function restoreDefaultFolders(pairs) {
  try {
    const defaults = await window.bds.getDefaultFolders();
    let changed = 0;
    for (const [inputId, key] of pairs) {
      const input = document.getElementById(inputId);
      if (!input || !defaults || !defaults[key]) continue;
      input.value = defaults[key];
      input.dispatchEvent(new Event('input', { bubbles: true }));
      changed++;
    }
    if (changed) notify('Pasta padrão restaurada. Clique em Salvar para aplicar.', 'success');
  } catch (error) {
    console.error('[SETTINGS] Erro ao restaurar a pasta padrão:', error);
    notify('Não foi possível restaurar a pasta padrão.', 'error');
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
      downloadPauseEnabled: document.getElementById('downloadPauseEnabledInput')?.checked !== false,
      downloadPauseMinSec: Number(document.getElementById('downloadPauseMinInput')?.value),
      downloadPauseMaxSec: Number(document.getElementById('downloadPauseMaxInput')?.value),
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
  list.innerHTML = getVisibleSidebarTabs().map((tab) => {
    const fixed = tab.view === 'home';
    const label = escapeHtml(tab.label);
    const moves = fixed ? '' : `
      <button type="button" class="st-order-move" data-dir="-1" aria-label="Mover ${label} para cima"><span class="material-symbols-rounded" aria-hidden="true">keyboard_arrow_up</span></button>
      <button type="button" class="st-order-move" data-dir="1" aria-label="Mover ${label} para baixo"><span class="material-symbols-rounded" aria-hidden="true">keyboard_arrow_down</span></button>`;
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
    const defaults = getDefaultTabOrder();
    const items = [...list.children].sort((a, b) => defaults.indexOf(a.dataset.view) - defaults.indexOf(b.dataset.view));
    items.forEach(li => list.appendChild(li));
    refreshSidebarOrderBadges();
    markSettingsDirty();
  });
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
  && !el.closest('#modulesList, #settingsAnalysisPanel, #settingsAssistantCard, #settingsTranscriptionPanel, #settingsAboutView');

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
  const headerBtn = document.getElementById('saveSettingsButton');
  if (headerBtn) {
    headerBtn.disabled = !settingsDirty;
    headerBtn.title = settingsDirty ? 'Salvar as alterações (Ctrl+S)' : 'Nenhuma alteração para salvar';
  }
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
  const headerBtn = document.getElementById('saveSettingsButton');
  if (headerBtn) { headerBtn.disabled = true; headerBtn.title = 'Nenhuma alteração para salvar'; }
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
  if (leaveHandler) { document.removeEventListener('click', leaveHandler, true); leaveHandler = null; }
  if (saveShortcutHandler) { document.removeEventListener('keydown', saveShortcutHandler, true); saveShortcutHandler = null; }
}

/** Ao voltar para a tela (ela fica no DOM): recarrega os campos, refaz os atalhos e reabre os painéis da aba atual. */
export function onEnter() {
  renderSettings();
  clearAllFieldErrors();
  setupLeaveGuard();
  setupAdvancedBlocks();
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
    if (id === 'downloadPauseMaxInput') {
      const min = Number(document.getElementById('downloadPauseMinInput')?.value);
      if (Number.isFinite(min) && n < min) return 'O máximo precisa ser igual ou maior que o mínimo.';
    }
    return '';
  }
  if (id === 'deadlineNotifyTimeInput' && !value) return 'Informe o horário do lembrete.';
  if (FOLDER_INPUTS.includes(id) && value && !/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value)) {
    return 'Informe o caminho completo da pasta (por exemplo, C:\\Vídeos) ou use o botão Alterar.';
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
    const view = first.closest('.settings-view');
    if (view && view.classList.contains('hidden')) document.querySelector(`.settings-tab[data-tab="${view.id}"]`)?.click();
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
    if (el.id === 'downloadPauseMinInput') {
      const max = document.getElementById('downloadPauseMaxInput');
      if (max && max.dataset.touched) showFieldError(max, validateField(max));
    }
    if (el.id === 'downloadPauseMaxInput') el.dataset.touched = '1';
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

function defaultLabel(el, value) {
  if (el.tagName === 'SELECT') return [...el.options].find((o) => o.value === value)?.textContent.trim() || value;
  if (el.type === 'color') return value.toUpperCase();
  return value;
}

function makeResetButton(label, title, targets) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'st-reset-field hidden';
  btn.setAttribute('aria-label', `Restaurar o padrão de ${label}`);
  btn.title = title;
  btn.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">restart_alt</span> Restaurar padrão';
  btn.addEventListener('click', () => {
    for (const [id, value] of targets) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    refreshResetButtons();
    setStatus(`Padrão de ${label} restaurado. Salve para manter.`);
  });
  btn.dataset.targets = JSON.stringify(targets);
  return btn;
}

function setupFieldDefaults() {
  document.querySelectorAll('.st-reset-field').forEach((n) => n.remove());
  const attach = (el, btn) => {
    const host = el.closest('.st-row-control') || el.parentElement;
    host.appendChild(btn);
  };
  for (const [id, def] of Object.entries(FIELD_DEFAULTS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const label = (document.querySelector(`label[for="${id}"]`)?.textContent || id).trim().toLowerCase();
    attach(el, makeResetButton(label, `Voltar para o padrão: ${defaultLabel(el, def)}`, [[id, def]]));
  }
  const maxEl = document.getElementById('downloadPauseMaxInput');
  if (maxEl) attach(maxEl, makeResetButton('tempo da pausa', 'Voltar para o padrão: 10 a 180 segundos', Object.entries(PAUSE_DEFAULTS)));
  refreshResetButtons();
}

function refreshResetButtons() {
  document.querySelectorAll('.st-reset-field').forEach((btn) => {
    let targets = [];
    try { targets = JSON.parse(btn.dataset.targets || '[]'); } catch (_) { /* ignora */ }
    const differs = targets.some(([id, def]) => {
      const el = document.getElementById(id);
      return el && String(el.value).toLowerCase() !== String(def).toLowerCase();
    });
    btn.classList.toggle('hidden', !differs);
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
}

/**
 * Cartão "Assistente de IA": interruptor "Ativar assistente" e instruções personalizadas. Ficam na configuração
 * da IA (não nas configurações gerais), então valem na hora e não entram na barra "Salvar". Ao mudar o interruptor
 * o botão flutuante aparece/some imediatamente (evento bds:ai-assistant-changed).
 */
async function setupAssistantCard() {
  const sw = document.getElementById('aiAssistantEnabledInput');
  const text = document.getElementById('aiAssistantInstructionsInput');
  const saveBtn = document.getElementById('aiAssistantInstructionsSave');
  const status = document.getElementById('aiAssistantStatus');
  if (!sw || typeof window.bds?.aiGetConfig !== 'function') return;
  const say = (msg) => { if (status) status.textContent = msg || ''; };
  const save = async (patch) => {
    const r = await window.bds.aiSaveConfig(patch);
    if (!r || !r.ok) throw new Error(r?.error || 'O assistente não respondeu.');
    return r.data;
  };
  try {
    const r = await window.bds.aiGetConfig();
    if (r && r.ok) {
      sw.checked = r.data.assistantEnabled !== false;
      if (text) text.value = r.data.customInstructions || '';
    }
  } catch (_) { /* mantém os padrões da tela */ }

  sw.addEventListener('change', async () => {
    const want = sw.checked;
    sw.disabled = true;
    try {
      await save({ assistantEnabled: want });
      say(want ? 'Assistente ativado.' : 'Assistente desativado.');
      window.dispatchEvent(new CustomEvent('bds:ai-assistant-changed'));
    } catch (err) {
      sw.checked = !want;
      say(`Não foi possível alterar. ${friendlyError(err, 'Tente novamente.')}`);
    } finally {
      sw.disabled = false;
    }
  });
  saveBtn?.addEventListener('click', async () => {
    try {
      await save({ customInstructions: text ? text.value : '' });
      say('Instruções salvas.');
    } catch (err) {
      say(`Não foi possível salvar. ${friendlyError(err, 'Tente novamente.')}`);
    }
  });
}

let modulesListenerBound = false;

/**
 * A seção Inteligência Artificial e as telas da "Tela inicial" seguem os módulos ligados (o Assistente
 * de IA só existe em desenvolvimento e já vem fora da lista no app final). Reaplica quando o main avisa.
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

function renderLicenseGroup(title, items) {
  const rows = items.map((i) => `<details class="st-license" data-license-id="${escapeHtml(i.id)}" data-search="${escapeHtml(`${i.name} ${i.license} ${i.note || ''}`.toLowerCase())}">
      <summary><strong>${escapeHtml(i.name)}</strong> <span class="st-license-meta">${escapeHtml(i.version)} · ${escapeHtml(i.license)}</span></summary>
      <div class="st-license-body">
        ${i.note ? `<p class="st-card-desc">${escapeHtml(i.note)}</p>` : ''}
        <button type="button" class="settings-btn-outline" data-license-link="${escapeHtml(i.url)}" aria-label="Abrir página do projeto ${escapeHtml(i.name)}">Abrir página do projeto</button>
        ${i.sourceUrl ? `<button type="button" class="settings-btn-outline" data-license-link="${escapeHtml(i.sourceUrl)}" aria-label="Abrir código-fonte de ${escapeHtml(i.name)}">Código-fonte</button>` : ''}
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
  host.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-license-link]');
    if (btn) window.bds.openExternal(btn.dataset.licenseLink).catch(() => setStatus('Não foi possível abrir o link.'));
  });
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

  document.querySelectorAll('.st-card, .st-row').forEach(el => el.classList.remove('st-filtered'));

  if (!query) {
    container?.classList.remove('st-searching');
    views.forEach(v => v.classList.toggle('hidden', v.id !== activeTabId));
    noResults?.classList.add('hidden');
    closeSearchOpenedBlocks();
    searchMounted = false;
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
    if (!cards.length && (kwMatch || normalizeText(view.textContent).includes(query))) hits++;
    if (!hits && kwMatch) hits++;
    view.classList.toggle('hidden', hits === 0);
  });

  // Seções de carregamento tardio: monta o conteúdo uma vez por busca para os resultados não ficarem vazios
  if (!searchMounted) {
    searchMounted = true;
    const shown = (id) => !document.getElementById(id)?.classList.contains('hidden');
    if (shown('settingsModulesView')) loadModulesList();
    if (shown('settingsTranscriptionView')) mountTranscriptionPanel();
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
async function loadCacheInfo() {
  const listEl = document.getElementById('cacheCategoriesList');
  const totalEl = document.getElementById('cacheTotalSize');
  if (!listEl && !totalEl) return;

  // Estado de carregamento
  if (listEl) listEl.innerHTML = '<div class="settings-crash-empty"><span class="material-symbols-rounded">sync</span> Calculando...</div>';
  if (totalEl) totalEl.textContent = 'Calculando...';

  if (!window.bds?.getCacheInfo) {
    if (listEl) listEl.innerHTML = '<div class="settings-crash-empty">Não foi possível ler o armazenamento. Reinicie o aplicativo.</div>';
    return;
  }

  try {
    const info = await window.bds.getCacheInfo();
    if (totalEl) totalEl.textContent = info.totalFormatted;

    if (!listEl) return;
    if (!info.categories || info.categories.length === 0) {
      listEl.innerHTML = '<div class="settings-crash-empty">Nenhum item de armazenamento encontrado.</div>';
      return;
    }

    listEl.innerHTML = info.categories.map(cat => `
      <div class="settings-cache-item">
        <div class="settings-cache-item-info">
          <strong>${escapeHtml(cat.label)}</strong>
          <span>${escapeHtml(cat.sizeFormatted)}</span>
        </div>
        <button class="settings-btn-outline settings-cache-clear-btn" type="button"
                data-clear-cache="${escapeHtml(cat.key)}" data-label="${escapeHtml(cat.label)}" aria-label="Limpar ${escapeHtml(cat.label)}">
          <span class="material-symbols-rounded">delete</span> Limpar
        </button>
      </div>
    `).join('');

    // Atualiza indicadores do limite
    const maxInput = document.getElementById('cacheMaxSizeInput');
    if (maxInput && !maxInput.value) maxInput.value = info.maxSizeMB || 500;
  } catch (err) {
    console.error('[SETTINGS] Erro ao carregar informações de cache:', err);
    if (listEl) listEl.innerHTML = `<div class="settings-crash-empty">Não foi possível ler o armazenamento. ${escapeHtml(friendlyError(err))}</div>`;
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

/** Verifica se há uma nova versão do BDS publicada nas GitHub Releases (src/config/appUpdate.config.json). */
async function checkAppUpdate() {
  const button = document.getElementById('checkAppUpdateButton');
  const statusText = document.getElementById('appUpdateStatusText');
  const progressContainer = document.getElementById('appUpdateProgress');

  if (button) {
    button.dataset.html = button.dataset.html || button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = '<span class="material-symbols-rounded st-spin" aria-hidden="true">progress_activity</span> Verificando…';
  }
  if (statusText) statusText.textContent = 'Consultando a página oficial do BDS…';

  try {
    const result = await window.bds.checkForAppUpdate();

    if (!result.hasUpdate && (result.checkFailed || result.error)) {
      if (statusText) statusText.textContent = 'Não foi possível verificar agora (sem conexão ou serviço indisponível). Tente novamente mais tarde.';
      window.bdsModal?.alert?.('Não foi possível verificar se há uma nova versão do BDS. Confira sua conexão com a internet e tente de novo.');
      return;
    }

    if (result.hasUpdate) {
      if (statusText) {
        statusText.textContent = `Nova versão disponível: v${result.latestVersion} (você está na v${result.currentVersion}).`;
      }
      // Mostra as notas da release (changelog) quando disponíveis e houver update.
      let confirmMsg = `Nova versão do BDS disponível: v${result.latestVersion}.\n\nDeseja baixar e instalar automaticamente?`;
      if (result.releaseNotes && typeof result.releaseNotes === 'string' && result.releaseNotes.trim()) {
        const excerpt = result.releaseNotes.trim().slice(0, 400);
        confirmMsg = `Nova versão do BDS disponível: v${result.latestVersion}.\n\nNovidades desta versão:\n${excerpt}${result.releaseNotes.length > 400 ? '\n…' : ''}\n\nDeseja baixar e instalar automaticamente?`;
      }
      // Avisa sobre possível prompt UAC quando empacotado (instalação em Program Files).
      if (window.bds && typeof window.bds.isPackaged === 'function') {
        let packaged = false;
        try { packaged = Boolean(await window.bds.isPackaged()); } catch (_) { /* noop */ }
        if (packaged) {
          confirmMsg += '\n\nObservação: como o BDS está instalado em uma pasta protegida, o Windows pode exibir um aviso de permissão (UAC) durante a instalação.';
        }
      }
      const instalAuto = await window.bdsModal.confirm(confirmMsg);
      if (instalAuto && window.bds.updateEverything) {
        await runAppAutoInstall({ statusText, button, progressContainer, releaseUrl: result.releaseUrl });
        return;
      }
      const abrirRelease = result.releaseUrl
        ? await window.bdsModal.confirm('Deseja abrir a página oficial do BDS para baixar manualmente?')
        : false;
      if (abrirRelease) window.bds.openExternal?.(result.releaseUrl);
    } else {
      if (statusText) statusText.textContent = `Você já está na versão mais recente (v${result.currentVersion}).`;
      window.bdsModal?.alert?.('Você já está usando a versão mais recente do BDS.');
    }
  } catch (err) {
    console.error('[SETTINGS] Erro ao checar atualização do BDS:', err);
    if (statusText) statusText.textContent = 'Não foi possível verificar agora (sem conexão ou serviço indisponível).';
    window.bdsModal?.alert?.('Não foi possível verificar se há uma nova versão do BDS. Confira sua conexão com a internet e tente de novo.');
  } finally {
    if (button) { button.disabled = false; button.removeAttribute('aria-busy'); button.innerHTML = button.dataset.html || button.innerHTML; }
  }
}

// Realiza download + instalação silenciosa do app, mostrando progresso e oferecendo restart.
async function runAppAutoInstall({ statusText, button, progressContainer, releaseUrl }) {
  if (statusText) statusText.textContent = 'Baixando e instalando a nova versão do BDS...';
  if (button) { button.dataset.html = button.dataset.html || button.innerHTML; button.disabled = true; button.innerHTML = '<span class="material-symbols-rounded st-spin" aria-hidden="true">progress_activity</span> Atualizando…'; }
  if (progressContainer) progressContainer.classList.remove('hidden');

  const fill = document.getElementById('appUpdateProgressFill');
  const percentEl = document.getElementById('appUpdateProgressPercent');
  const stepEl = document.getElementById('appUpdateProgressStep');

  // Regista ouvinte de progresso local (barra do painel dedicado do app).
  if (window.bds.onUpdateProgress) {
    window.bds.onUpdateProgress((data) => {
      const pct = data.percent == null ? null : data.percent;
      if (fill) {
        if (pct == null) {
          fill.classList.add('indeterminate');
        } else {
          fill.classList.remove('indeterminate');
          fill.style.width = `${pct}%`;
        }
      }
      if (percentEl) percentEl.textContent = pct == null ? (data.message ? '...' : '') : `${pct}%`;
      if (stepEl && data.message) stepEl.textContent = data.message;
    });
  }

  try {
    const result = await window.bds.updateEverything();
    await confirmUnverifiedUpdates(result?.dependencies);
    const appUpdate = result?.appUpdate;

    if (appUpdate && appUpdate.installed && appUpdate.needsRestart) {
      if (fill) { fill.classList.remove('indeterminate'); fill.style.width = '100%'; }
      if (percentEl) percentEl.textContent = '100%';
      if (stepEl) stepEl.textContent = 'Instalado! Reiniciando...';
      if (statusText) statusText.textContent = 'Nova versão instalada com sucesso.';
      const restart = await window.bdsModal.confirm(
        'Nova versão do BDS instalada com sucesso.\n\nReiniciar agora para aplicar?'
      );
      if (restart && window.bds.relaunchApp) {
        await window.bds.relaunchApp();
      }
      return;
    }

    if (appUpdate && appUpdate.error) {
      if (statusText) statusText.textContent = `Não foi possível atualizar automaticamente. ${friendlyError(appUpdate.error)}`;
      const openRelease = await window.bdsModal.confirm(
        `Não foi possível instalar automaticamente.\n${friendlyError(appUpdate.error)}\n\nDeseja abrir a página oficial do BDS para baixar manualmente?`
      );
      if (openRelease && releaseUrl) window.bds.openExternal?.(releaseUrl);
      return;
    }

    // Sem update do app nesse fluxo (apenas dependências foram atualizadas).
    if (statusText) statusText.textContent = 'O app já estava atualizado.';
  } catch (err) {
    console.error('[SETTINGS] Erro na instalação automática do app:', err);
    if (statusText) statusText.textContent = 'Falha durante a instalação automática.';
    const openRelease = await window.bdsModal.confirm(
      'Ocorreu um erro durante a instalação automática.\n\nDeseja abrir a página oficial do BDS para baixar manualmente?'
    );
    if (openRelease && releaseUrl) window.bds.openExternal?.(releaseUrl);
  } finally {
    if (progressContainer) progressContainer.classList.add('hidden');
    if (button) { button.disabled = false; button.innerHTML = button.dataset.html || button.innerHTML; }
  }
}

/* ==========================================================================
   ATUALIZAÇÕES UNIFICADAS (BDS Update Manager)
   ========================================================================== */
function setUpdateStatusView(stateType, extraMessage = '') {
  const iconWrap = document.getElementById('updateStatusIconWrap');
  const icon = document.getElementById('updateStatusIcon');
  const headline = document.getElementById('updateHeadline');
  const subHeadline = document.getElementById('updateSubHeadline');
  const progressContainer = document.getElementById('updateProgressContainer');
  const btnCheck = document.getElementById('checkUpdatesButton');
  const btnNow = document.getElementById('updateNowButton');
  const btnLater = document.getElementById('updateLaterButton');

  if (!iconWrap || !icon || !headline || !subHeadline) return;

  iconWrap.className = 'settings-update-icon-wrap';

  switch (stateType) {
    case 'loading':
      iconWrap.classList.add('updating');
      icon.textContent = 'sync';
      headline.textContent = 'Verificando atualizações...';
      subHeadline.textContent = 'Consultando as fontes oficiais. Isso leva alguns segundos.';
      if (progressContainer) progressContainer.classList.add('hidden');
      if (btnCheck) btnCheck.disabled = true;
      if (btnNow) btnNow.classList.add('hidden');
      if (btnLater) btnLater.classList.add('hidden');
      break;

    case 'has_updates':
      iconWrap.classList.add('has-updates');
      icon.textContent = 'system_update';
      headline.textContent = 'Existem atualizações disponíveis.';
      subHeadline.textContent = extraMessage || 'Deseja atualizar os componentes do BDS agora?';
      if (progressContainer) progressContainer.classList.add('hidden');
      if (btnCheck) { btnCheck.disabled = false; btnCheck.classList.add('hidden'); }
      if (btnNow) btnNow.classList.remove('hidden');
      if (btnLater) btnLater.classList.remove('hidden');
      break;

    case 'up_to_date':
      icon.textContent = 'check_circle';
      headline.textContent = 'Tudo está atualizado.';
      subHeadline.textContent = 'Os recursos do BDS já estão nas versões mais recentes.';
      if (progressContainer) progressContainer.classList.add('hidden');
      if (btnCheck) { btnCheck.disabled = false; btnCheck.classList.remove('hidden'); }
      if (btnNow) btnNow.classList.add('hidden');
      if (btnLater) btnLater.classList.add('hidden');
      break;

    case 'updating':
      iconWrap.classList.add('updating');
      icon.textContent = 'downloading';
      headline.textContent = 'Atualizando o BDS...';
      subHeadline.textContent = extraMessage || 'Preparando componentes...';
      if (progressContainer) progressContainer.classList.remove('hidden');
      if (btnCheck) btnCheck.disabled = true;
      if (btnNow) btnNow.classList.add('hidden');
      if (btnLater) btnLater.classList.add('hidden');
      break;

    case 'later':
      icon.textContent = 'schedule';
      headline.textContent = 'Atualizações adiadas.';
      subHeadline.textContent = 'Você poderá atualizar os componentes a qualquer momento clicando em verificar.';
      if (btnCheck) { btnCheck.disabled = false; btnCheck.classList.remove('hidden'); }
      break;

    case 'partial':
      iconWrap.classList.add('has-updates');
      icon.textContent = 'info';
      headline.textContent = 'Verificação incompleta.';
      subHeadline.textContent = extraMessage || 'Não foi possível consultar todas as fontes agora.';
      if (progressContainer) progressContainer.classList.add('hidden');
      if (btnCheck) { btnCheck.disabled = false; btnCheck.classList.remove('hidden'); }
      if (btnNow) btnNow.classList.add('hidden');
      if (btnLater) btnLater.classList.add('hidden');
      break;

    case 'error':
      iconWrap.classList.add('error');
      icon.textContent = 'error';
      headline.textContent = 'Não foi possível verificar atualizações.';
      subHeadline.textContent = extraMessage || 'Verifique sua conexão com a internet e tente novamente.';
      if (progressContainer) progressContainer.classList.add('hidden');
      if (btnCheck) { btnCheck.disabled = false; btnCheck.classList.remove('hidden'); }
      if (btnNow) btnNow.classList.add('hidden');
      if (btnLater) btnLater.classList.add('hidden');
      break;
  }
}

const OFFLINE_HINT = 'Não foi possível consultar as fontes de atualização. Verifique sua conexão com a internet e tente novamente.';

function setLastCheck(text) {
  const el = document.getElementById('updateLastCheck');
  if (!el) return;
  const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  el.textContent = text ? `Última verificação às ${time}: ${text}` : '';
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
    const deps = result?.dependencies;
    const app = result?.app;
    const depsFailed = Boolean(deps?.checkFailed || deps?.error);
    const appFailed = Boolean(app?.checkFailed || app?.error);
    const names = (deps?.components || [])
      .filter((c) => c.needsUpdate && !c.unavailable && !(c.onDemand && !c.isInstalled))
      .map((c) => c.title);
    if (app) reflectAppUpdate(app);

    if (result?.hasUpdates) {
      const parts = [];
      if (names.length) parts.push(`Há atualização para: ${names.join(', ')}.`);
      if (app?.hasUpdate) parts.push(`Há uma nova versão do BDS (v${app.latestVersion}).`);
      parts.push('Deseja atualizar agora?');
      setUpdateStatusView('has_updates', parts.join(' '));
      setStatus('Existem atualizações disponíveis.');
      setLastCheck(names.length || app?.hasUpdate ? 'há atualizações disponíveis.' : 'concluída.');
    } else if (depsFailed && appFailed) {
      setUpdateStatusView('error', OFFLINE_HINT);
      setStatus('Sem conexão com as fontes de atualização.');
      setLastCheck('não foi possível consultar as fontes.');
    } else if (depsFailed || appFailed) {
      setUpdateStatusView('partial', depsFailed
        ? 'Os recursos do BDS não puderam ser conferidos agora (sem conexão ou serviço indisponível). Tente novamente mais tarde.'
        : 'A versão do aplicativo não pôde ser conferida agora (sem conexão ou serviço indisponível). Os recursos estão em dia.');
      setStatus('Não foi possível verificar tudo agora.');
      setLastCheck('verificação incompleta.');
    } else {
      setUpdateStatusView('up_to_date');
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

// Mostra o estado do app no painel dedicado (dentro da aba Atualizações).
function reflectAppUpdate(appInfo) {
  const statusText = document.getElementById('appUpdateStatusText');
  if (!statusText || !appInfo) return;
  if (appInfo.hasUpdate) {
    statusText.textContent = `Nova versão disponível: v${appInfo.latestVersion} (você está na v${appInfo.currentVersion}).`;
  } else if (appInfo.checkFailed || appInfo.error) {
    statusText.textContent = 'Não foi possível verificar a versão do aplicativo agora (sem conexão ou serviço indisponível).';
  } else if (appInfo.currentVersion) {
    statusText.textContent = `Você está na versão mais recente (v${appInfo.currentVersion}).`;
  }
}

async function startUnifiedUpdate() {
  setUpdateStatusView('updating', 'Iniciando atualização de componentes...');
  setStatus('Atualizando o BDS...');

  const fill = document.getElementById('updateProgressFill');
  const percentEl = document.getElementById('updateProgressPercent');
  const stepEl = document.getElementById('updateProgressStep');

  // Registrar ouvinte de progresso
  if (window.bds.onUpdateProgress) {
    window.bds.onUpdateProgress((data) => {
      const pct = data.percent == null ? null : data.percent;
      if (fill) {
        if (pct == null) {
          // Total desconhecido: mostra barra indeterminada animada.
          fill.classList.add('indeterminate');
        } else {
          fill.classList.remove('indeterminate');
          fill.style.width = `${pct}%`;
        }
      }
      if (percentEl) percentEl.textContent = pct == null ? (data.message ? '...' : '') : `${pct}%`;
      if (stepEl && data.message) stepEl.textContent = data.message;
    });
  }

  try {
    // updateEverything atualiza as dependências E, se houver nova versão do app,
    // baixa e instala silenciosamente. Retorna { dependencies, appUpdate, needsRestart }.
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

    // Atualização do app instalada?
    if (appUpdate && appUpdate.installed && appUpdate.needsRestart) {
      if (stepEl) stepEl.textContent = 'Nova versão do BDS instalada!';
      setStatus('BDS atualizado para a versão mais recente.');
      const restart = await window.bdsModal.confirm(
        'Uma nova versão do Braga Digital Studio foi instalada com sucesso.\n\nReinicie o aplicativo agora para aplicar a atualização?'
      );
      if (restart && window.bds.relaunchApp) {
        setUpdateStatusView('up_to_date');
        setStatus('Reiniciando o BDS...');
        await window.bds.relaunchApp();
      } else {
        setUpdateStatusView('up_to_date');
        setStatus('Atualização instalada. O BDS será atualizado na próxima inicialização.');
      }
      return;
    }

    if (appUpdate && appUpdate.error) {
      // Falha ao baixar/instalar o app — oferecer abrir a release no navegador.
      if (stepEl) stepEl.textContent = 'Falha ao atualizar o app automaticamente.';
      const openRelease = await window.bdsModal.confirm(
        `Não foi possível atualizar o aplicativo automaticamente.\n${friendlyError(appUpdate.error)}\n\nDeseja abrir a página oficial do BDS para baixar manualmente?`
      );
      if (openRelease && appUpdate.appInfo?.releaseUrl) {
        window.bds.openExternal?.(appUpdate.appInfo.releaseUrl);
      }
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
    const sendBtn = document.getElementById('sendCrashReportsButton');
    const clearBtn = document.getElementById('clearCrashReportsButton');
    if (sendBtn) sendBtn.disabled = count === 0;
    if (clearBtn) clearBtn.disabled = count === 0;
  } catch (err) {
    console.error('[SETTINGS] Erro ao carregar relatórios:', err);
    summary.textContent = 'Não foi possível verificar os relatórios.';
  }
}

/** Envia todos os relatórios guardados: direto (servidor configurado) ou pelo e-mail do usuário. */
async function sendCrashReports() {
  if (!window.bds?.sendCrashReports) return;
  const button = document.getElementById('sendCrashReportsButton');
  if (button) button.disabled = true;
  try {
    setStatus('Enviando relatórios...');
    const result = await window.bds.sendCrashReports();
    if (!result || result.method === 'none') {
      window.bdsModal.alert('Não há relatórios para enviar.');
    } else if (result.method === 'http') {
      window.bdsModal.alert(result.sent === result.count
        ? `${result.sent} relatório(s) enviado(s). Obrigado!`
        : `${result.sent} de ${result.count} relatório(s) enviado(s). Os demais continuam guardados para uma nova tentativa.`);
    } else if (result.mailto && typeof window.bds.openExternal === 'function') {
      await window.bds.openExternal(result.mailto);
      window.bdsModal.alert('Abrimos o seu e-mail com o resumo dos relatórios. Basta enviar a mensagem.');
    } else {
      window.bdsModal.alert('Não foi possível abrir o cliente de e-mail neste dispositivo.');
    }
  } catch (err) {
    console.error('[SETTINGS] Falha ao enviar relatórios:', err);
    window.bdsModal.alert(`Não foi possível enviar os relatórios. ${friendlyError(err, 'Verifique sua conexão e tente de novo.')}`);
  } finally {
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

function setupReportProblemModal() {
  const modal = document.getElementById('modalSettingsReportProblem');
  if (!modal) return;
  const desc = document.getElementById('modalSettingsReportProblemDesc');

  document.getElementById('reportProblemButton')?.addEventListener('click', () => openSettingsModal('modalSettingsReportProblem'));
  document.getElementById('btnCloseSettingsReportProblem')?.addEventListener('click', () => closeSettingsModal('modalSettingsReportProblem'));
  document.getElementById('modalSettingsReportProblemCancel')?.addEventListener('click', () => closeSettingsModal('modalSettingsReportProblem'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeSettingsModal('modalSettingsReportProblem');
  });

  document.getElementById('modalSettingsReportProblemConfirm')?.addEventListener('click', async () => {
    const description = (desc?.value || '').trim();
    if (!description) {
      window.bdsModal.alert('Por favor, descreva o problema antes de gerar o e-mail.');
      return;
    }
    if (!window.bds?.generateManualMailto) return;
    const confirmBtn = document.getElementById('modalSettingsReportProblemConfirm');
    const originalHTML = confirmBtn?.innerHTML;
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<span class="material-symbols-rounded">hourglass_top</span> Gerando...';
    }
    try {
      const mailtoUrl = await window.bds.generateManualMailto(description);
      if (!mailtoUrl) {
        window.bdsModal.alert('Não foi possível gerar o e-mail de suporte.');
        return;
      }
      closeSettingsModal('modalSettingsReportProblem');
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
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = originalHTML;
      }
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
        <button class="btn-edit-custom-source" data-id="${src.id}" data-name="${escapeHtml(src.name)}" data-path="${escapeHtml(src.path)}" title="Alterar pasta da fonte" type="button">
          <span class="material-symbols-rounded">edit</span>
        </button>
        <button class="btn-delete-custom-source" data-id="${src.id}" data-name="${escapeHtml(src.name)}" title="Remover esta fonte e suas mídias" type="button">
          <span class="material-symbols-rounded">delete</span>
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
  const btnCancel = document.getElementById('modalSettingsAddCustomSourceCancel');
  const btnBrowse = document.getElementById('modalSettingsAddCustomSourceSelectBtn');
  const btnConfirm = document.getElementById('modalSettingsAddCustomSourceConfirm');
  const nameInput = document.getElementById('modalSettingsAddCustomSourceName');
  const pathInput = document.getElementById('modalSettingsAddCustomSourcePath');

  if (!modal) return;

  const openModal = () => {
    modal.classList.remove('hidden');
    modal.classList.add('active');
  };
  const closeModal = () => {
    modal.classList.add('hidden');
    modal.classList.remove('active');
  };

  btnOpen?.addEventListener('click', openModal);
  btnClose?.addEventListener('click', closeModal);
  btnCancel?.addEventListener('click', closeModal);

  btnBrowse?.addEventListener('click', async () => {
    const folder = await window.bds.selectFolder();
    if (folder && pathInput) pathInput.value = folder;
  });

  btnConfirm?.addEventListener('click', async () => {
    const sourceName = nameInput?.value?.trim();
    const folderPath = pathInput?.value?.trim();

    if (!sourceName) return window.bdsModal.alert('Por favor, informe o nome desejado para a fonte personalizada.');
    if (!folderPath) return window.bdsModal.alert('Por favor, selecione a pasta da fonte.');

    btnConfirm.disabled = true;
    btnConfirm.innerHTML = '<span class="material-symbols-rounded">hourglass_top</span> Indexando...';

    try {
      await window.bds.addCustomSource({ name: sourceName, folderPath });
      closeModal();
      if (nameInput) nameInput.value = '';
      if (pathInput) pathInput.value = '';
      await loadSettingsCustomSources();
      window.bdsModal.alert(`Sucesso! A fonte personalizada "${sourceName}" foi cadastrada e suas mídias foram indexadas na biblioteca!`);
    } catch (err) {
      window.bdsModal.alert(`Não foi possível cadastrar a fonte. ${friendlyError(err)}`);
    } finally {
      btnConfirm.disabled = false;
      btnConfirm.innerHTML = '<span class="material-symbols-rounded">check_circle</span> Cadastrar & Importar Mídias';
    }
  });
}