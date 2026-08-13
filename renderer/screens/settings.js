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

  // Tema e cor de destaque
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) themeSelect.value = s.theme || 'dark';

  const accentInput = document.getElementById('accentColorInput');
  if (accentInput) accentInput.value = s.accentColor || '#e53935';

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
  document.getElementById('updateDepsButton')?.addEventListener('click', updateDependencies);

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
      theme: document.getElementById('themeSelect')?.value || 'dark',
      accentColor: document.getElementById('accentColorInput')?.value || '#e53935',
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
   ATUALIZAÇÕES (lógica consolidada do antigo updates.js)
   ========================================================================== */
async function checkUpdates() {
  const updatesList = document.getElementById('updatesList');
  if (!updatesList) return;

  updatesList.innerHTML = '<p class="loading-text">Verificando atualizações...</p>';
  setStatus('Verificando atualizações das dependências...');

  try {
    const result = await window.bds.checkUpdates();
    renderUpdates(result);
    setStatus('Verificação de atualizações concluída.');
  } catch (error) {
    console.error('[SETTINGS] Erro ao verificar atualizações:', error);
    updatesList.innerHTML = `<p class="error-text">Erro: ${escapeHtml(error.message)}</p>`;
    setStatus('Falha ao verificar atualizações.');
  }
}

export function renderUpdates(result) {
  const updatesList = document.getElementById('updatesList');
  if (!updatesList || !result) return;

  const items = [result.ytDlp, result.ffmpeg, result.spotdl].filter(Boolean);

  if (items.length === 0) {
    updatesList.innerHTML = '<p>Nenhuma ferramenta configurada para atualização.</p>';
    return;
  }

  updatesList.innerHTML = items.map((item) => {
    const errorMarkup = item.error ? `<p class="tool-error">${escapeHtml(item.error)}</p>` : '';
    const buttonText = item.needsUpdate ? 'Atualizar' : 'Reinstalar';
    return `
      <section class="update-item">
        <div class="tool-info">
          <h3>${escapeHtml(item.tool)}</h3>
          <p>Instalada: <span class="version-tag">${escapeHtml(item.installed || 'não encontrada')}</span></p>
          <p>Mais recente: <span class="version-tag">${escapeHtml(item.latest || 'indisponível')}</span></p>
          ${errorMarkup}
        </div>
        <div class="tool-actions">
          <button class="settings-btn-outline" data-update-tool="${escapeHtml(item.tool)}" ${item.canUpdate ? '' : 'disabled'}>
            ${buttonText}
          </button>
        </div>
      </section>
    `;
  }).join('');

  updatesList.querySelectorAll('[data-update-tool]').forEach((button) => {
    button.addEventListener('click', () => executeToolUpdate(button, button.dataset.updateTool));
  });
}

async function executeToolUpdate(button, toolName) {
  button.disabled = true;
  button.textContent = 'Atualizando...';
  setStatus(`Atualizando ${toolName}, aguarde...`);

  try {
    await window.bds.updateTool(toolName);
    setStatus(`${toolName} atualizado com sucesso!`);
    const freshResult = await window.bds.checkUpdates();
    renderUpdates(freshResult);
  } catch (error) {
    console.error(`[SETTINGS] Erro ao atualizar ${toolName}:`, error);
    button.textContent = 'Erro';
    setStatus(`Falha ao atualizar ${toolName}: ${error.message}`);
    setTimeout(() => {
      button.disabled = false;
      button.textContent = 'Tentar Novamente';
    }, 3000);
  }
}

async function updateDependencies() {
  const btn = document.getElementById('updateDepsButton');
  const statusEl = document.getElementById('updateStatusText');
  if (!btn) return;

  const showStatus = (text, type) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = `settings-update-status status-${type}`;
  };

  btn.disabled = true;
  btn.innerText = 'ATUALIZANDO...';
  showStatus('Baixando atualizações em segundo plano...', 'loading');

  try {
    await window.bds.updateAllDependencies();
    showStatus('✅ Atualizações concluídas com sucesso.', 'ok');
    setTimeout(() => checkUpdates(), 1000);
  } catch (error) {
    showStatus('❌ Ocorreu um erro durante a atualização.', 'error');
    console.error('[SETTINGS] Erro ao atualizar dependências:', error);
  } finally {
    btn.disabled = false;
    btn.innerText = 'ATUALIZAR DEPENDÊNCIAS';
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