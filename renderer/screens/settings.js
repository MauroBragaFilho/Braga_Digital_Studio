import { state, setStatus, escapeHtml, applyTheme, applyAccentColor, applyUiPreferences, getVisibleSidebarTabs, getDefaultTabOrder, tabShortcutLabel } from '../app.js';

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
  loadAiSummary();
  hideDevOnlySettings();
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

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      clearSettingsSearch();
      const targetId = tab.dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      views.forEach(v => v.classList.add('hidden'));
      tab.classList.add('active');
      const targetView = document.getElementById(targetId);
      if (targetView) targetView.classList.remove('hidden');
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

  setChk('useDefaultFolderInput', s.useDefaultFolder);
  setVal('mp3FolderInput', s.mp3Folder);
  setVal('mp4FolderInput', s.mp4Folder);
  setVal('obsFolderInput', s.obsFolder);
  setVal('shadowplayFolderInput', s.shadowplayFolder);
  setVal('deviceFolderInput', s.deviceFolder);
  setChk('autoUpdateInput', s.autoUpdateDeps);
  setChk('autoUpdateGithub', s.autoUpdateGithub !== false);
  setChk('checkUpdatesOnStartInput', s.checkUpdatesOnStart);

  // BDS Update Server (URL base opcional para componentes)
  setVal('updateServerUrlInput', s.updateServerUrl);

  // Upload para YouTube (pasta do scanner de mídias)
  setVal('uploadsFolderInput', s.uploadsFolder);

  // Relatório de erros / telemetria
  setChk('errorReportingEnabledInput', s.errorReportingEnabled !== false);
  setVal('developerEmailInput', s.developerEmail);
  setChk('notificationsEnabledInput', s.notificationsEnabled !== false);
  setChk('notifyDownloadsInput', s.notifyDownloads !== false);
  setChk('notifyConverterInput', s.notifyConverter !== false);
  setChk('notifyCopyInput', s.notifyCopy !== false);
  setChk('notifySilenceInput', s.notifySilence !== false);
  setChk('notifyDeadlinesInput', s.notifyDeadlines !== false);

  // Telegram
  setChk('telegramNotificationsEnabledInput', s.telegramNotificationsEnabled);
  setVal('telegramBotTokenInput', s.telegramBotToken);
  setVal('telegramChatIdInput', s.telegramChatId);

  // Antecedência e horário do lembrete de prazo
  const leadSelect = document.getElementById('deadlineNotifyLeadDaysInput');
  if (leadSelect) leadSelect.value = String(s.deadlineNotifyLeadDays ?? 5);
  const timeInput = document.getElementById('deadlineNotifyTimeInput');
  if (timeInput) timeInput.value = s.deadlineNotifyTime || '09:00';

  // Tema e cor de destaque
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) themeSelect.value = s.theme || 'dark';

  const accentInput = document.getElementById('accentColorInput');
  if (accentInput) accentInput.value = s.accentColor || '#e53935';

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

  toggleFolderInputs();
  syncNotifyModules();
  syncAccentSwatches();
}

function toggleFolderInputs() {
  const useDefault = document.getElementById('useDefaultFolderInput')?.checked;
  const group = document.getElementById('customFoldersGroup');
  if (group) group.classList.toggle('disabled-group', Boolean(useDefault));
}

/* ==========================================================================
   EVENTOS
   ========================================================================== */
function bindEvents() {
  document.getElementById('saveSettingsButton')?.addEventListener('click', saveSettings);

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

  // Botão de teste do Telegram
  document.getElementById('testTelegramButton')?.addEventListener('click', async () => {
    const btn = document.getElementById('testTelegramButton');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-rounded">hourglass_top</span> Enviando...'; }
    try {
      const result = await window.bds.sendTelegramTest({
        botToken: document.getElementById('telegramBotTokenInput')?.value,
        chatId: document.getElementById('telegramChatIdInput')?.value
      });
      if (result?.success) {
        window.bdsModal.alert('Sucesso! A mensagem de teste foi enviada para o seu Telegram.');
      } else {
        window.bdsModal.alert('Falha ao enviar: ' + (result?.error || 'Verifique o token e o Chat ID.'));
      }
    } catch (err) {
      window.bdsModal.alert('Falha ao enviar: ' + (err.message || err));
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-rounded">send</span> Testar envio no Telegram'; }
    }
  });

  document.getElementById('useDefaultFolderInput')?.addEventListener('change', toggleFolderInputs);

  document.getElementById('mp3FolderButton')?.addEventListener('click', () => chooseFolder('mp3FolderInput'));
  document.getElementById('mp4FolderButton')?.addEventListener('click', () => chooseFolder('mp4FolderInput'));
  document.getElementById('obsFolderButton')?.addEventListener('click', () => chooseFolder('obsFolderInput'));
  document.getElementById('shadowplayFolderButton')?.addEventListener('click', () => chooseFolder('shadowplayFolderInput'));
  document.getElementById('deviceFolderButton')?.addEventListener('click', () => chooseFolder('deviceFolderInput'));
  document.getElementById('converterFolderButton')?.addEventListener('click', () => chooseFolder('converterFolderInput'));

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
      'Tem certeza que deseja limpar todos os relatórios guardados? Esta ação não pode ser desfeita.'
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
      window.bdsModal.alert('Ocorreu um erro ao tentar limpar os relatórios.');
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
    const accentColor = document.getElementById('accentColorInput')?.value || state.settings?.accentColor || '#e53935';
    applyTheme(e.target.value, accentColor);
  });

  // Cor de destaque — preview em tempo real enquanto o usuário arrasta
  document.getElementById('accentColorInput')?.addEventListener('input', (e) => {
    applyAccentColor(e.target.value);
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
      setStatus('Exportando logs de diagnóstico...');
      const res = await window.bds.exportDiagnosticLogs();
      if (res && res.success) {
        setStatus('Logs exportados com sucesso.');
        window.bdsModal.alert(`Logs de diagnóstico exportados com sucesso para:\n${res.exportPath}`);
      } else if (!res?.cancelled) {
        window.bdsModal.alert('Não foi possível exportar os logs.');
      }
    } catch (e) {
      console.error('[SETTINGS] Erro ao exportar logs:', e);
      window.bdsModal.alert('Erro ao exportar logs: ' + e.message);
    }
  });

  // Limpar Banco de Dados
  document.getElementById('clearDbButton')?.addEventListener('click', async () => {
    const confirm = await window.bdsModal.confirm(
      'TEM CERTEZA ABSOLUTA? Esta ação irá limpar todo o banco de dados interno da biblioteca.\n' +
      'Os arquivos não serão apagados do disco, mas todo o histórico, tags e favoritos serão perdidos para sempre!'
    );
    if (!confirm) return;
    try {
      setStatus('Limpando banco de dados...');
      await window.bds.clearLibraryDatabase();
      setStatus('Banco de dados limpo com sucesso.');
      window.bdsModal.alert('O banco de dados foi limpo. As pastas voltarão a ser escaneadas do zero.');
    } catch (e) {
      setStatus('Erro ao limpar banco: ' + e.message);
      window.bdsModal.alert('Erro ao limpar banco de dados: ' + e.message);
    }
  });

  // Armazenamento — Atualizar informações
  document.getElementById('refreshCacheButton')?.addEventListener('click', loadCacheInfo);

  // Armazenamento — Limpar tudo
  document.getElementById('clearCacheButton')?.addEventListener('click', async () => {
    const confirm = await window.bdsModal.confirm(
      'Tem certeza que deseja limpar TODO o armazenamento temporário?\n' +
      'Isso removerá thumbnails, waveforms e arquivos temporários.\n' +
      'As conversões e projetos não serão afetados, mas os arquivos poderão ser regenerados na próxima vez que forem necessários.'
    );
    if (!confirm) return;
    try {
      setStatus('Limpando armazenamento...');
      const result = await window.bds.clearCache(null);
      setStatus('Armazenamento limpo com sucesso.');
      window.bdsModal.alert(`Armazenamento limpo! ${result.totalFormatted} liberados.`);
      loadCacheInfo();
    } catch (e) {
      setStatus('Erro ao limpar armazenamento: ' + e.message);
      window.bdsModal.alert('Erro ao limpar armazenamento: ' + e.message);
    }
  });

  // Armazenamento — Limpar categoria individual (delegação de eventos)
  const cacheList = document.getElementById('cacheCategoriesList');
  if (cacheList) {
    cacheList.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-clear-cache]');
      if (!btn) return;
      const key = btn.dataset.clearCache;
      const label = btn.dataset.label;
      const ok = await window.bdsModal.confirm(`Limpar o armazenamento de "${label}"? Os arquivos serão regenerados quando necessários.`);
      if (!ok) return;
      try {
        setStatus(`Limpando ${label}...`);
        const result = await window.bds.clearCache(key);
        setStatus(`${label} limpos com sucesso.`);
        window.bdsModal.alert(`${label} limpos! ${result.totalFormatted} liberados.`);
        loadCacheInfo();
      } catch (err) {
        window.bdsModal.alert('Erro ao limpar: ' + err.message);
      }
    });
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
  try {
    setStatus('Salvando configurações...');
    const updatedSettings = await window.bds.saveSettings({
      useDefaultFolder: document.getElementById('useDefaultFolderInput')?.checked,
      mp3Folder: document.getElementById('mp3FolderInput')?.value,
      mp4Folder: document.getElementById('mp4FolderInput')?.value,
      obsFolder: document.getElementById('obsFolderInput')?.value,
      shadowplayFolder: document.getElementById('shadowplayFolderInput')?.value,
      deviceFolder: document.getElementById('deviceFolderInput')?.value,
      uploadsFolder: document.getElementById('uploadsFolderInput')?.value,
      autoUpdateDeps: document.getElementById('autoUpdateInput')?.checked,
      autoUpdateGithub: document.getElementById('autoUpdateGithub')?.checked,
      checkUpdatesOnStart: document.getElementById('checkUpdatesOnStartInput')?.checked,
      updateServerUrl: document.getElementById('updateServerUrlInput')?.value?.trim() || '',
      notificationsEnabled: document.getElementById('notificationsEnabledInput')?.checked,
      notifyDownloads: document.getElementById('notifyDownloadsInput')?.checked,
      notifyConverter: document.getElementById('notifyConverterInput')?.checked,
      notifyCopy: document.getElementById('notifyCopyInput')?.checked,
      notifySilence: document.getElementById('notifySilenceInput')?.checked,
      notifyDeadlines: document.getElementById('notifyDeadlinesInput')?.checked,
      deadlineNotifyLeadDays: Number(document.getElementById('deadlineNotifyLeadDaysInput')?.value) || 5,
      deadlineNotifyTime: document.getElementById('deadlineNotifyTimeInput')?.value || '09:00',
      telegramNotificationsEnabled: document.getElementById('telegramNotificationsEnabledInput')?.checked,
      telegramBotToken: document.getElementById('telegramBotTokenInput')?.value || '',
      telegramChatId: document.getElementById('telegramChatIdInput')?.value || '',
      theme: document.getElementById('themeSelect')?.value || 'dark',
      accentColor: document.getElementById('accentColorInput')?.value || '#e53935',
      lutPreviewImage: document.getElementById('lutPreviewImageInput')?.value || '',
      errorReportingEnabled: document.getElementById('errorReportingEnabledInput')?.checked,
      developerEmail: document.getElementById('developerEmailInput')?.value?.trim() || '',
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
    window.bdsModal.alert('Erro ao salvar configurações: ' + error.message);
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
  const names = pending.map(p => `• ${p.tool || p.id}${p.version ? ` ${p.version}` : ''}`).join('\n');
  const ok = await window.bdsModal.confirm(
    `A fonte destes componentes não publica checksum (SHA-256), então a integridade do download não pode ser verificada:\n\n${names}\n\nInstalar mesmo assim?`
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

/** Marca a cor de destaque atual entre as cores sugeridas. */
function syncAccentSwatches() {
  const current = (document.getElementById('accentColorInput')?.value || '').toLowerCase();
  document.querySelectorAll('.st-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color.toLowerCase() === current);
  });
}

function updateSaveBar() {
  const bar = document.getElementById('settingsSaveBar');
  if (!bar) return;
  clearTimeout(savedBarTimer);
  bar.classList.toggle('hidden', !settingsDirty);
  bar.classList.remove('is-saved');
  const text = document.getElementById('settingsSaveBarText');
  if (text) text.textContent = 'Você tem alterações não salvas.';
}

function markSettingsDirty() {
  settingsDirty = true;
  updateSaveBar();
}

/** Depois de salvar: some a barra de alterações e mostra uma confirmação rápida. */
function markSettingsSaved() {
  settingsDirty = false;
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
  settingsDirty = false;
  updateSaveBar();
}

function setupSaveBar() {
  settingsDirty = false;
  const content = document.querySelector('.settings-content');
  const track = (e) => {
    if (e.target?.id === 'settingsSearch') return;
    markSettingsDirty();
  };
  content?.addEventListener('input', track);
  content?.addEventListener('change', track);
  document.getElementById('settingsSaveBarSave')?.addEventListener('click', saveSettings);
  document.getElementById('settingsSaveBarDiscard')?.addEventListener('click', discardSettingsChanges);
}

/** Ao sair da tela com alterações não salvas, desfaz as prévias para não deixar o app "meio mudado". */
export function onLeave() {
  if (settingsDirty) {
    const s = state.settings || {};
    applyTheme(s.theme, s.accentColor);
    applyUiPreferences(s);
  }
  renderSidebarOrderList(); // descarta uma ordem não salva e reflete o menu real ao voltar
  settingsDirty = false;
  clearTimeout(savedBarTimer);
}

function setupSettingsExtras() {
  // Cores sugeridas
  document.getElementById('accentSwatches')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.st-swatch');
    if (!btn) return;
    const input = document.getElementById('accentColorInput');
    if (input) input.value = btn.dataset.color;
    applyAccentColor(btn.dataset.color);
    syncAccentSwatches();
    markSettingsDirty();
  });
  document.getElementById('accentColorInput')?.addEventListener('input', syncAccentSwatches);

  // Prévia imediata de "reduzir animações"
  document.getElementById('reduceMotionInput')?.addEventListener('change', (e) => {
    applyUiPreferences({ reduceMotion: e.target.checked });
  });

  // Interruptor geral de notificações
  document.getElementById('notificationsEnabledInput')?.addEventListener('change', syncNotifyModules);

  // Atalho para a tela do Assistente
  document.getElementById('settingsOpenAiButton')?.addEventListener('click', () => {
    document.querySelector('.sidebar .tab-button[data-view="ai"]')?.click();
  });
}

/**
 * O Assistente de IA só existe em builds de desenvolvimento (app não empacotado).
 * No app final, esconde a categoria dele nas Configurações e a opção de tela inicial.
 */
async function hideDevOnlySettings() {
  let packaged = true; // fail-safe: na dúvida, esconde
  try {
    if (typeof window.bds?.isPackaged === 'function') packaged = Boolean(await window.bds.isPackaged());
  } catch (_) { /* mantém o padrão */ }
  if (!packaged) return;
  document.querySelector('.settings-tab[data-tab="settingsAiView"]')?.classList.add('st-devhidden');
  document.getElementById('settingsAiView')?.classList.add('st-devhidden');
  document.querySelector('#defaultStartScreenInput option[value="ai"]')?.classList.add('st-devhidden');
  document.querySelector('#defaultStartScreenInput option[value="ai"]')?.setAttribute('hidden', '');
}

/** Resumo (somente leitura) da configuração da IA. */
async function loadAiSummary() {
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  try {
    const res = await window.bds?.aiGetConfig?.();
    if (!res?.ok) throw new Error(res?.error || 'indisponível');
    const c = res.data;
    let host = c.baseUrl;
    try { host = new URL(c.baseUrl).host; } catch (_) { /* mantém a URL crua */ }
    set('settingsAiServer', host);
    set('settingsAiModel', c.model || 'não definido');
    set('settingsAiKey', c.hasKey ? 'Guardada (criptografada)' : (c.isOfficialOpenAI ? 'Não configurada' : 'Não necessária'));
  } catch (_) {
    set('settingsAiServer', 'indisponível');
    set('settingsAiModel', '—');
    set('settingsAiKey', '—');
  }
}

/* --- Busca --- */
function clearSettingsSearch() {
  const input = document.getElementById('settingsSearch');
  if (!input || !input.value) return;
  input.value = '';
  applySettingsSearch('');
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
    return;
  }

  container?.classList.add('st-searching');
  views.forEach(view => {
    let hits = 0;
    view.querySelectorAll('.st-card').forEach(card => {
      if (card.classList.contains('hidden')) { card.classList.add('st-filtered'); return; }
      const titleMatch = normalizeText(card.querySelector('.st-card-title')?.textContent).includes(query);
      const rows = [...card.querySelectorAll('.st-row')];
      let visible;
      if (rows.length) {
        let rowHits = 0;
        rows.forEach(row => {
          const match = titleMatch || normalizeText(row.textContent).includes(query);
          row.classList.toggle('st-filtered', !match);
          if (match) rowHits++;
        });
        visible = rowHits > 0;
      } else {
        visible = titleMatch || normalizeText(card.textContent).includes(query);
      }
      card.classList.toggle('st-filtered', !visible);
      if (visible) hits++;
    });
    view.classList.toggle('hidden', hits === 0);
  });

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
    const updatesVersion = document.getElementById('updatesVersionDisplay');
    const sysFolders = document.getElementById('sysFolders');
    if (sysVersion) sysVersion.textContent = `v${version}`;
    if (updatesVersion) updatesVersion.textContent = `v${version}`;
    if (sysFolders && state.settings) {
      sysFolders.textContent = state.settings.mp4Folder || 'Padrão do Sistema';
    }
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
    if (listEl) listEl.innerHTML = '<div class="settings-crash-empty">IPC getCacheInfo não encontrado. Reinicie o aplicativo.</div>';
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
                data-clear-cache="${cat.key}" data-label="${cat.label}">
          <span class="material-symbols-rounded">delete</span> Limpar
        </button>
      </div>
    `).join('');

    // Atualiza indicadores do limite
    const maxInput = document.getElementById('cacheMaxSizeInput');
    if (maxInput && !maxInput.value) maxInput.value = info.maxSizeMB || 500;
  } catch (err) {
    console.error('[SETTINGS] Erro ao carregar informações de cache:', err);
    if (listEl) listEl.innerHTML = `<div class="settings-crash-empty">Erro ao carregar armazenamento: ${escapeHtml(err.message || err)}</div>`;
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

  if (button) { button.disabled = true; button.textContent = 'Verificando...'; }

  try {
    const result = await window.bds.checkForAppUpdate();

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
        ? await window.bdsModal.confirm('Deseja abrir a página da release no GitHub para baixar manualmente?')
        : false;
      if (abrirRelease) window.bds.openExternal?.(result.releaseUrl);
    } else {
      if (statusText) statusText.textContent = `Você já está na versão mais recente (v${result.currentVersion}).`;
      window.bdsModal?.alert?.('Você já está usando a versão mais recente do BDS.');
    }
  } catch (err) {
    console.error('[SETTINGS] Erro ao checar atualização do BDS:', err);
    if (statusText) statusText.textContent = 'Não foi possível checar atualizações agora.';
    window.bdsModal?.alert?.('Não foi possível checar atualizações do BDS agora. Tente novamente mais tarde.');
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Verificar Atualização do BDS'; }
  }
}

// Realiza download + instalação silenciosa do app, mostrando progresso e oferecendo restart.
async function runAppAutoInstall({ statusText, button, progressContainer, releaseUrl }) {
  if (statusText) statusText.textContent = 'Baixando e instalando a nova versão do BDS...';
  if (button) { button.disabled = true; button.textContent = 'Atualizando...'; }
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
      if (statusText) statusText.textContent = `Falha ao atualizar automaticamente (${appUpdate.error}).`;
      const openRelease = await window.bdsModal.confirm(
        `Não foi possível instalar automaticamente (${appUpdate.error}).\n\nDeseja abrir a release no GitHub?`
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
      'Ocorreu um erro durante a instalação automática.\n\nDeseja abrir a release no GitHub para baixar manualmente?'
    );
    if (openRelease && releaseUrl) window.bds.openExternal?.(releaseUrl);
  } finally {
    if (progressContainer) progressContainer.classList.add('hidden');
    if (button) { button.disabled = false; button.textContent = 'Verificar Atualização do BDS'; }
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
      subHeadline.textContent = 'Consultando integridade dos componentes do BDS.';
      if (progressContainer) progressContainer.classList.add('hidden');
      if (btnCheck) btnCheck.disabled = true;
      if (btnNow) btnNow.classList.add('hidden');
      if (btnLater) btnLater.classList.add('hidden');
      break;

    case 'has_updates':
      iconWrap.classList.add('has-updates');
      icon.textContent = 'system_update';
      headline.textContent = 'Existem atualizações disponíveis.';
      subHeadline.textContent = 'Deseja atualizar os componentes do BDS agora?';
      if (progressContainer) progressContainer.classList.add('hidden');
      if (btnCheck) { btnCheck.disabled = false; btnCheck.classList.add('hidden'); }
      if (btnNow) btnNow.classList.remove('hidden');
      if (btnLater) btnLater.classList.remove('hidden');
      break;

    case 'up_to_date':
      icon.textContent = 'check_circle';
      headline.textContent = 'Tudo está atualizado.';
      subHeadline.textContent = 'Todos os componentes internos do BDS estão operando com as versões mais recentes.';
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

    case 'error':
      iconWrap.classList.add('error');
      icon.textContent = 'error';
      headline.textContent = 'Não foi possível verificar atualizações.';
      subHeadline.textContent = 'Verifique sua conexão com a internet e tente novamente.';
      if (progressContainer) progressContainer.classList.add('hidden');
      if (btnCheck) { btnCheck.disabled = false; btnCheck.classList.remove('hidden'); }
      if (btnNow) btnNow.classList.add('hidden');
      if (btnLater) btnLater.classList.add('hidden');
      break;
  }
}

async function checkUpdates() {
  setUpdateStatusView('loading');
  setStatus('Verificando atualizações dos componentes...');

  try {
    let result;
    if (window.bds.checkEverything) {
      result = await window.bds.checkEverything();
    } else {
      result = await window.bds.checkUpdates();
    }
    // Fluxo unificado: result = { hasUpdates, app, dependencies }
    const hasUpdates = typeof result?.hasUpdates === 'boolean' ? result.hasUpdates : result?.hasUpdates;
    if (hasUpdates) {
      setUpdateStatusView('has_updates');
      setStatus('Existem atualizações disponíveis.');
    } else {
      setUpdateStatusView('up_to_date');
      setStatus('Tudo atualizado.');
      // Atualiza também o painel do app se vierem dados explícitos.
      if (result && result.app) reflectAppUpdate(result.app);
    }
  } catch (error) {
    console.error('[SETTINGS] Erro ao verificar atualizações:', error);
    setUpdateStatusView('error');
    setStatus('Falha ao verificar atualizações.');
  }
}

// Mostra o estado do app no painel dedicado (dentro da aba Atualizações).
function reflectAppUpdate(appInfo) {
  const statusText = document.getElementById('appUpdateStatusText');
  if (!statusText || !appInfo) return;
  if (appInfo.hasUpdate) {
    statusText.textContent = `Nova versão disponível: v${appInfo.latestVersion} (você está na v${appInfo.currentVersion}).`;
  } else if (appInfo.currentVersion) {
    statusText.textContent = `Você está na versão mais recente (v${appInfo.currentVersion}).`;
  } else if (appInfo.error) {
    statusText.textContent = `Não foi possível verificar atualizações do app (${appInfo.error}).`;
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
        `Não foi possível automatizar a atualização do app (${appUpdate.error}).\n\nDeseja abrir a página da release no GitHub para baixar manualmente?`
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
    setUpdateStatusView('error');
    setStatus('Erro ao atualizar componentes: ' + error.message);
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
    window.bdsModal.alert('Falha ao enviar os relatórios: ' + err.message);
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
      window.bdsModal.alert('Erro ao gerar o e-mail de suporte: ' + err.message);
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
    container.innerHTML = `<p class="settings-empty-sources">Erro ao carregar fontes: ${escapeHtml(err.message)}</p>`;
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
          window.bdsModal.alert('Erro ao alterar pasta da fonte: ' + err.message);
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
        window.bdsModal.alert('Erro ao remover fonte: ' + err.message);
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
      window.bdsModal.alert('Erro ao cadastrar fonte personalizada: ' + err.message);
    } finally {
      btnConfirm.disabled = false;
      btnConfirm.innerHTML = '<span class="material-symbols-rounded">check_circle</span> Cadastrar & Importar Mídias';
    }
  });
}