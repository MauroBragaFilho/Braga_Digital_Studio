import { state, setStatus, escapeHtml, applyTheme, applyAccentColor } from '../app.js';

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

  toggleFolderInputs();
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

  // Pasta de uploads do YouTube — seleciona a pasta, escaneia os vídeos e persiste no save
  document.getElementById('uploadsFolderButton')?.addEventListener('click', async () => {
    const input = document.getElementById('uploadsFolderInput');
    const folder = await window.bds.selectFolder(input?.value || '');
    if (!folder) return;
    if (input) input.value = folder;
    try {
      await window.bds.uploadScanDirectory(folder);
    } catch (err) {
      console.error('[SETTINGS] Erro ao escanear a pasta de uploads:', err);
    }
  });

  // Relatório de Erros: abrir pasta de crash reports e atualizar a lista
  document.getElementById('openReportsFolderButton')?.addEventListener('click', () => {
    if (typeof window.bds?.openCrashReportsFolder === 'function') {
      try {
        window.bds.openCrashReportsFolder();
      } catch (err) {
        console.error('[SETTINGS] Erro ao abrir pasta de relatórios:', err);
      }
    }
  });
  document.getElementById('refreshCrashReportsButton')?.addEventListener('click', loadCrashReports);
  document.getElementById('clearCrashReportsButton')?.addEventListener('click', async () => {
    if (typeof window.bds?.clearCrashReports !== 'function') return;
    const confirmed = await window.bdsModal.confirm(
      'Tem certeza que deseja excluir todos os relatórios de erro?\nEsta ação não pode ser desfeita.'
    );
    if (!confirmed) return;
    try {
      const result = await window.bds.clearCrashReports();
      if (result && result.deleted > 0) {
        await loadCrashReports();
        window.bdsModal.alert(`${result.deleted} relatório(s) removido(s) com sucesso.`);
      } else {
        window.bdsModal.alert('Nenhum relatório encontrado para excluir.');
      }
    } catch (err) {
      console.error('[SETTINGS] Erro ao limpar crash reports:', err);
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
        if (input) input.value = filePath;
        const thumb = document.getElementById('settingsLutPreviewThumb');
        if (thumb) thumb.src = `file://${filePath}`;
      }
    } catch (err) {
      console.error('[SETTINGS] Erro ao selecionar imagem de LUT:', err);
    }
  });

  document.getElementById('lutPreviewImageResetBtn')?.addEventListener('click', () => {
    const input = document.getElementById('lutPreviewImageInput');
    if (input) input.value = '';
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
    if (folder) input.value = folder;
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
    });
    state.settings = updatedSettings;
    // Confirma o tema após salvar (garante consistência)
    applyTheme(updatedSettings.theme, updatedSettings.accentColor);
    setStatus('Configurações salvas com sucesso.');
    window.bdsModal.alert('Configurações salvas!');
  } catch (error) {
    setStatus('Erro ao salvar as configurações.');
    window.bdsModal.alert('Erro ao salvar configurações: ' + error.message);
  }
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
          <strong>${cat.label}</strong>
          <span>${cat.sizeFormatted}</span>
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
let currentCrashReportPath = null;
let errorReportingUIReady = false;

function setupErrorReportingUI() {
  if (errorReportingUIReady) return;
  errorReportingUIReady = true;
  setupCrashReportListActions();
  setupCrashDetailsModal();
  setupReportProblemModal();
}

async function loadCrashReports() {
  const container = document.getElementById('crashReportsList');
  if (!container) return;
  if (!window.bds?.getCrashReports) return;
  try {
    const reports = await window.bds.getCrashReports();
    renderCrashReports(Array.isArray(reports) ? reports : []);
  } catch (err) {
    console.error('[SETTINGS] Erro ao carregar crash reports:', err);
    container.innerHTML = '<div class="settings-crash-empty"><span class="material-symbols-rounded">error</span> Não foi possível carregar os relatórios.</div>';
  }
}

function formatReportDate(iso) {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (_) {
    return iso || '';
  }
}

function renderCrashReports(reports) {
  const container = document.getElementById('crashReportsList');
  if (!container) return;

  if (!reports.length) {
    container.innerHTML = `
      <div class="settings-crash-empty">
        <span class="material-symbols-rounded">verified_user</span>
        Nenhum relatório de erro registrado até o momento.
      </div>`;
    return;
  }

  container.innerHTML = reports.map((r) => `
    <div class="settings-crash-item">
      <div class="settings-crash-item-head">
        <span class="settings-crash-date">${escapeHtml(formatReportDate(r.timestamp))}</span>
        <span class="settings-crash-source" title="${escapeHtml(r.source || 'unknown')}">${escapeHtml(r.source || 'unknown')}</span>
      </div>
      <p class="settings-crash-msg" title="${escapeHtml(r.errorMessage)}">${escapeHtml(r.errorMessage)}</p>
      <div class="settings-crash-actions">
        <button class="settings-btn-outline settings-btn-sm" type="button" data-action="email" data-path="${escapeHtml(r.path || '')}">
          <span class="material-symbols-rounded">mail</span> Enviar por e-mail
        </button>
        <button class="settings-btn-outline settings-btn-sm" type="button" data-action="details" data-path="${escapeHtml(r.path || '')}">
          <span class="material-symbols-rounded">visibility</span> Detalhes
        </button>
      </div>
    </div>`).join('');
}

function setupCrashReportListActions() {
  const container = document.getElementById('crashReportsList');
  if (!container) return;
  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const reportPath = btn.dataset.path;
    if (btn.dataset.action === 'email') {
      await sendCrashReportByEmail(reportPath);
    } else if (btn.dataset.action === 'details') {
      await openCrashReportDetails(reportPath);
    }
  });
}

async function sendCrashReportByEmail(reportPath) {
  if (!reportPath || !window.bds?.getCrashReportMailto) return;
  try {
    setStatus('Gerando e-mail do relatório de erro...');
    const mailtoUrl = await window.bds.getCrashReportMailto(reportPath);
    if (!mailtoUrl) {
      window.bdsModal.alert('Não foi possível gerar o e-mail para este relatório.');
      return;
    }
    if (typeof window.bds.openExternal === 'function') {
      await window.bds.openExternal(mailtoUrl);
    } else {
      window.bdsModal.alert('Não foi possível abrir o cliente de e-mail neste dispositivo.');
    }
  } catch (err) {
    console.error('[SETTINGS] Falha ao enviar relatório por e-mail:', err);
    window.bdsModal.alert('Falha ao abrir o cliente de e-mail: ' + err.message);
  }
}

async function openCrashReportDetails(reportPath) {
  if (!reportPath || !window.bds?.getCrashReportDetails) return;
  try {
    const details = await window.bds.getCrashReportDetails(reportPath);
    if (!details) {
      window.bdsModal.alert('Não foi possível carregar os detalhes deste relatório.');
      return;
    }
    currentCrashReportPath = reportPath;
    fillCrashDetails(details);
    openSettingsModal('modalSettingsCrashDetails');
  } catch (err) {
    console.error('[SETTINGS] Erro ao carregar detalhes do relatório:', err);
    window.bdsModal.alert('Erro ao carregar detalhes: ' + err.message);
  }
}

function fillCrashDetails(d) {
  const pre = document.getElementById('modalSettingsCrashDetailsBody');
  if (!pre) return;
  const sys = d.system || {};
  const lines = [
    `Data/Hora: ${d.timestamp || '—'}`,
    `ID: ${d.id || '—'}`,
    `Origem: ${d.context?.source || '—'}`,
    `Fatal: ${d.context?.isFatal ? 'Sim' : 'Não'}${d.context?.action ? ` | Ação: ${d.context.action}` : ''}`,
    '',
    `App: ${d.app?.name || 'BDS'} v${d.app?.version || '—'}`,
    `Sistema: ${sys.platform || ''} ${sys.arch || ''} (${sys.osType || ''}) — CPU: ${sys.cpuModel || '?'} — Mem: ${sys.totalMemoryMB || 0} MB`,
    '',
    `Erro: ${d.error?.name || 'Error'} — ${d.error?.message || ''}`,
    '',
    'Stack Trace:',
    d.error?.stack || '(sem stack trace)'
  ];
  if (d.localFilePath) lines.push('', `Arquivo local: ${d.localFilePath}`);
  if (Array.isArray(d.recentLogs) && d.recentLogs.length) {
    lines.push('', 'Últimas linhas do log:', d.recentLogs.slice(-15).join('\n'));
  }
  pre.textContent = lines.join('\n');
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

function setupCrashDetailsModal() {
  const modal = document.getElementById('modalSettingsCrashDetails');
  if (!modal) return;
  document.getElementById('btnCloseSettingsCrashDetails')?.addEventListener('click', () => closeSettingsModal('modalSettingsCrashDetails'));
  document.getElementById('modalSettingsCrashDetailsClose')?.addEventListener('click', () => closeSettingsModal('modalSettingsCrashDetails'));
  document.getElementById('modalSettingsCrashDetailsEmail')?.addEventListener('click', () => {
    if (currentCrashReportPath) sendCrashReportByEmail(currentCrashReportPath);
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeSettingsModal('modalSettingsCrashDetails');
  });
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