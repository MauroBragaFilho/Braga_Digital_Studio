import { state, setStatus, escapeHtml, applyTheme, applyAccentColor } from '../app.js';

let customSources = [];

export function initScreen() {
  console.log('[SETTINGS] Inicializando tela...');
  renderSettings();
  setupTabs();
  bindEvents();
  setupCustomSourceModal();
  fetchAppVersion();
  loadSettingsCustomSources();
  setupContainerClickHandler();
  applyPendingUpdateCheck();
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

  // Tema e cor de destaque
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) themeSelect.value = s.theme || 'dark';

  const accentInput = document.getElementById('accentColorInput');
  if (accentInput) accentInput.value = s.accentColor || '#e53935';

  // LUTs Preview Image
  setVal('lutPreviewImageInput', s.lutPreviewImage);
  const lutThumb = document.getElementById('settingsLutPreviewThumb');
  if (lutThumb) {
    lutThumb.src = s.lutPreviewImage ? `file://${s.lutPreviewImage}` : './assets/lut_preview.jpg';
  }

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

  document.getElementById('useDefaultFolderInput')?.addEventListener('change', toggleFolderInputs);

  document.getElementById('mp3FolderButton')?.addEventListener('click', () => chooseFolder('mp3FolderInput'));
  document.getElementById('mp4FolderButton')?.addEventListener('click', () => chooseFolder('mp4FolderInput'));
  document.getElementById('obsFolderButton')?.addEventListener('click', () => chooseFolder('obsFolderInput'));
  document.getElementById('shadowplayFolderButton')?.addEventListener('click', () => chooseFolder('shadowplayFolderInput'));
  document.getElementById('deviceFolderButton')?.addEventListener('click', () => chooseFolder('deviceFolderInput'));

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
      autoUpdateDeps: document.getElementById('autoUpdateInput')?.checked,
      autoUpdateGithub: document.getElementById('autoUpdateGithub')?.checked,
      checkUpdatesOnStart: document.getElementById('checkUpdatesOnStartInput')?.checked,
      theme: document.getElementById('themeSelect')?.value || 'dark',
      accentColor: document.getElementById('accentColorInput')?.value || '#e53935',
      lutPreviewImage: document.getElementById('lutPreviewImageInput')?.value || '',
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
      const instalAuto = await window.bdsModal.confirm(
        `Nova versão do BDS disponível: v${result.latestVersion}.\n\nDeseja baixar e instalar automaticamente?`
      );
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

  try {
    const result = await window.bds.updateEverything();
    const appUpdate = result?.appUpdate;

    if (appUpdate && appUpdate.installed && appUpdate.needsRestart) {
      if (fill) fill.style.width = '100%';
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
      const pct = data.percent || 0;
      if (fill) fill.style.width = `${pct}%`;
      if (percentEl) percentEl.textContent = `${pct}%`;
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