import { els, state, setStatus } from '../app.js';

export function initScreen() {
  renderSettings();
  bindEvents();
  setupTabs();
  fetchAppVersion();
  loadSettingsCustomSources();
  setupSettingsCustomSourceModal();
}

function bindEvents() {
  // Salvar Configurações
  document.getElementById('saveSettingsButton').addEventListener('click', saveSettings);
  
  // Seleção de Pastas
  document.getElementById('mp3FolderButton').addEventListener('click', () => chooseFolder('mp3FolderInput'));
  document.getElementById('mp4FolderButton').addEventListener('click', () => chooseFolder('mp4FolderInput'));
  document.getElementById('obsFolderButton').addEventListener('click', () => chooseFolder('obsFolderInput'));
  document.getElementById('shadowplayFolderButton').addEventListener('click', () => chooseFolder('shadowplayFolderInput'));
  document.getElementById('deviceFolderButton').addEventListener('click', () => chooseFolder('deviceFolderInput'));
  
  // Toggle da Pasta Padrão
  document.getElementById('useDefaultFolderInput').addEventListener('change', toggleFolderInputs);

  // Botão de Atualizações
  document.getElementById('updateDepsButton').addEventListener('click', updateDependencies);

  // Limpar Banco de Dados
  const btnClearDb = document.getElementById('btnClearDatabase');
  if (btnClearDb) {
    btnClearDb.addEventListener('click', async () => {
      if (await window.bdsModal.confirm('TEM CERTEZA ABSOLUTA? Esta ação irá limpar todo o banco de dados interno da biblioteca. Os arquivos não serão apagados do disco, mas todo o histórico, tags e favoritos serão perdidos para sempre!')) {
        try {
          setStatus('Limpando banco de dados...');
          await window.bds.clearLibraryDatabase();
          setStatus('Banco de dados limpo com sucesso. Reinicie o aplicativo para forçar um re-escaneamento completo.');
          window.bdsModal.alert('O banco de dados foi limpo. As pastas voltarão a ser escaneadas do zero.');
        } catch (e) {
          setStatus('Erro ao limpar banco: ' + e.message);
        }
      }
    });
  }
}

function setupTabs() {
  const tabs = document.querySelectorAll('.settings-tab');
  const views = document.querySelectorAll('.settings-view');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => {
        t.classList.remove('active');
        t.style.borderLeftColor = 'transparent';
        t.style.background = 'transparent';
      });
      views.forEach(v => v.style.display = 'none');

      tab.classList.add('active');
      tab.style.borderLeftColor = 'var(--accent)';
      tab.style.background = 'rgba(255,255,255,0.05)';

      const targetView = document.getElementById(tab.dataset.target);
      if (targetView) targetView.style.display = 'block';
    });
  });
}

function renderSettings() {
  if (state.settings) {
    document.getElementById('mp3FolderInput').value = state.settings.mp3Folder || '';
    document.getElementById('mp4FolderInput').value = state.settings.mp4Folder || '';
    document.getElementById('obsFolderInput').value = state.settings.obsFolder || '';
    document.getElementById('shadowplayFolderInput').value = state.settings.shadowplayFolder || '';
    document.getElementById('deviceFolderInput').value = state.settings.deviceFolder || '';
    
    document.getElementById('useDefaultFolderInput').checked = Boolean(state.settings.useDefaultFolder);
    document.getElementById('autoUpdateInput').checked = Boolean(state.settings.autoUpdateDeps);
    if (document.getElementById('autoUpdateGithub')) {
      document.getElementById('autoUpdateGithub').checked = state.settings.autoUpdateGithub !== false; // Default true se undefined
    }
    toggleFolderInputs();
  }
}

function toggleFolderInputs() {
  const useDefault = document.getElementById('useDefaultFolderInput').checked;
  const customGroup = document.getElementById('customFoldersGroup');
  
  if (useDefault) {
    customGroup.style.opacity = '0.5';
    customGroup.style.pointerEvents = 'none';
  } else {
    customGroup.style.opacity = '1';
    customGroup.style.pointerEvents = 'auto';
  }
}

async function chooseFolder(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  try {
    const folder = await window.bds.selectFolder(input.value);
    if (folder) input.value = folder;
  } catch (error) {
    console.error(`Erro ao selecionar pasta:`, error);
  }
}

async function saveSettings() {
  try {
    setStatus('Salvando configurações...');
    const updatedSettings = await window.bds.saveSettings({
      useDefaultFolder: document.getElementById('useDefaultFolderInput').checked,
      mp3Folder: document.getElementById('mp3FolderInput').value,
      mp4Folder: document.getElementById('mp4FolderInput').value,
      obsFolder: document.getElementById('obsFolderInput').value,
      shadowplayFolder: document.getElementById('shadowplayFolderInput').value,
      deviceFolder: document.getElementById('deviceFolderInput').value,
      autoUpdateDeps: document.getElementById('autoUpdateInput').checked,
      autoUpdateGithub: document.getElementById('autoUpdateGithub').checked,
    });
    state.settings = updatedSettings;
    setStatus('Configurações salvas com sucesso.');
  } catch (error) {
    setStatus('Erro ao salvar as configurações.');
  }
}

async function fetchAppVersion() {
  const versionDisplay = document.getElementById('versionDisplay');
  const sysVersion = document.getElementById('sysVersion');
  const sysFolders = document.getElementById('sysFolders');

  try {
    const version = await window.bds.getVersion();
    if (versionDisplay) versionDisplay.innerText = `v${version}`;
    if (sysVersion) sysVersion.innerText = `v${version}`;

    if (sysFolders && state.settings) {
      sysFolders.innerText = `${state.settings.mp4Folder || 'Padrão do Sistema'}`;
    }
  } catch (err) {
    console.error("Erro ao buscar versão:", err);
    if (versionDisplay) versionDisplay.innerText = "0.0.0";
    if (sysVersion) sysVersion.innerText = "0.0.0";
  }
}

async function updateDependencies() {
  const btn = document.getElementById('updateDepsButton');
  const statusEl = document.getElementById('updateStatusText');
  
  btn.disabled = true;
  btn.innerText = "ATUALIZANDO...";
  statusEl.innerText = "Baixando atualizações em segundo plano...";
  
  try {
    // Chama o main.js para atualizar yt-dlp, ffmpeg e spotdl silenciosamente
    await window.bds.updateAllDependencies();
    statusEl.innerText = "✅ Atualizações concluídas com sucesso.";
    statusEl.style.color = "var(--green)";
  } catch (error) {
    statusEl.innerText = "❌ Ocorreu um erro durante a atualização.";
    statusEl.style.color = "var(--danger)";
  } finally {
    btn.disabled = false;
    btn.innerText = "ATUALIZAR DEPENDÊNCIAS";
  }
}

async function loadSettingsCustomSources() {
  const container = document.getElementById('settingsCustomSourcesList');
  if (!container) return;

  if (window.bds && window.bds.getCustomSources) {
    try {
      const sources = await window.bds.getCustomSources();

      if (!sources || sources.length === 0) {
        container.innerHTML = '<div style="font-size: 11px; color: var(--muted); padding: 8px;">Nenhuma fonte personalizada cadastrada no momento.</div>';
        return;
      }

      container.innerHTML = sources.map(src => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: rgba(255,255,255,0.03); border: 1px solid var(--line); border-radius: 6px;">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1;">
            <span class="material-symbols-rounded" style="color: #f25c05; font-size: 20px;">folder_special</span>
            <div style="min-width: 0;">
              <div style="font-weight: 700; color: #ffffff; font-size: 12px;">${src.name}</div>
              <div style="font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${src.path}">${src.path}</div>
            </div>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button class="btn-edit-custom-source" data-id="${src.id}" data-name="${src.name}" data-path="${src.path}" title="Alterar pasta da fonte" style="background: transparent; border: none; color: #f25c05; cursor: pointer; padding: 4px; display: inline-flex; align-items: center;" onmouseover="this.style.color='#ff9800'" onmouseout="this.style.color='#f25c05'">
              <span class="material-symbols-rounded" style="font-size: 20px;">edit</span>
            </button>
            <button class="btn-delete-custom-source" data-id="${src.id}" data-name="${src.name}" title="Remover esta fonte e suas mídias" style="background: transparent; border: none; color: #e53935; cursor: pointer; padding: 4px; display: inline-flex; align-items: center;" onmouseover="this.style.color='#ff5252'" onmouseout="this.style.color='#e53935'">
              <span class="material-symbols-rounded" style="font-size: 20px;">delete</span>
            </button>
          </div>
        </div>
      `).join('');

      // Evento de Editar Pasta (Lápis)
      container.querySelectorAll('.btn-edit-custom-source').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          const name = btn.getAttribute('data-name');
          const oldPath = btn.getAttribute('data-path');

          if (window.bds && window.bds.selectFolder) {
            const newFolder = await window.bds.selectFolder(oldPath);
            if (newFolder && newFolder !== oldPath) {
              try {
                if (window.bds.updateCustomSourcePath) {
                  await window.bds.updateCustomSourcePath({ id, name, newFolderPath: newFolder });
                  await loadSettingsCustomSources();
                  window.bdsModal.alert(`A pasta da fonte "${name}" foi alterada para:\n${newFolder}`);
                }
              } catch (err) {
                window.bdsModal.alert('Erro ao alterar pasta da fonte: ' + err.message);
              }
            }
          }
        });
      });

      // Evento de Excluir Fonte (Lixeira)
      container.querySelectorAll('.btn-delete-custom-source').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          const name = btn.getAttribute('data-name');
          if (await window.bdsModal.confirm(`Deseja realmente remover a fonte personalizada "${name}"?\nTodas as mídias associadas a esta fonte serão removidas da biblioteca.`)) {
            try {
              if (window.bds.removeCustomSource) {
                await window.bds.removeCustomSource({ id, name });
                await loadSettingsCustomSources();
                window.bdsModal.alert(`A fonte "${name}" e suas mídias foram removidas da biblioteca com sucesso!`);
              }
            } catch (err) {
              window.bdsModal.alert('Erro ao remover fonte: ' + err.message);
            }
          }
        });
      });
    } catch (err) {
      console.error("Erro ao carregar fontes personalizadas em configurações:", err);
    }
  }
}

function setupSettingsCustomSourceModal() {
  const modal = document.getElementById('modalSettingsAddCustomSource');
  const btnOpen = document.getElementById('btnSettingsAddCustomSource');
  const btnClose = document.getElementById('btnCloseSettingsCustomSourceModal');
  const btnCancel = document.getElementById('btnSettingsCancelAddCustomSource');
  const btnBrowse = document.getElementById('btnSettingsBrowseCustomSourceFolder');
  const btnConfirm = document.getElementById('btnSettingsConfirmAddCustomSource');

  if (btnOpen && modal) {
    btnOpen.addEventListener('click', () => {
      modal.style.display = 'flex';
    });
  }

  const closeModal = () => {
    if (modal) modal.style.display = 'none';
  };

  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

  if (btnBrowse) {
    btnBrowse.addEventListener('click', async () => {
      if (window.bds && window.bds.selectFolder) {
        const folder = await window.bds.selectFolder();
        if (folder) {
          const pathInput = document.getElementById('inputSettingsCustomSourcePath');
          if (pathInput) pathInput.value = folder;
        }
      }
    });
  }

  if (btnConfirm) {
    btnConfirm.addEventListener('click', async () => {
      const nameInput = document.getElementById('inputSettingsCustomSourceName');
      const pathInput = document.getElementById('inputSettingsCustomSourcePath');
      
      const sourceName = nameInput?.value?.trim();
      const folderPath = pathInput?.value?.trim();

      if (!sourceName) {
        window.bdsModal.alert('Por favor, informe o nome desejado para a fonte personalizada.');
        return;
      }
      if (!folderPath) {
        window.bdsModal.alert('Por favor, selecione a pasta da fonte.');
        return;
      }

      if (window.bds && window.bds.addCustomSource) {
        try {
          btnConfirm.disabled = true;
          btnConfirm.innerHTML = '<span class="material-symbols-rounded" style="font-size: 18px;">hourglass_top</span> Indexando...';

          await window.bds.addCustomSource({ name: sourceName, folderPath: folderPath });

          btnConfirm.disabled = false;
          btnConfirm.innerHTML = '<span class="material-symbols-rounded" style="font-size: 18px;">check_circle</span> Cadastrar & Importar Mídias';

          closeModal();

          nameInput.value = '';
          pathInput.value = '';

          await loadSettingsCustomSources();
          window.bdsModal.alert(`Sucesso! A fonte personalizada "${sourceName}" foi cadastrada e suas mídias foram indexadas na biblioteca!`);
        } catch (err) {
          btnConfirm.disabled = false;
          btnConfirm.innerHTML = '<span class="material-symbols-rounded" style="font-size: 18px;">check_circle</span> Cadastrar & Importar Mídias';
          window.bdsModal.alert('Erro ao cadastrar fonte personalizada: ' + err.message);
        }
      }
    });
  }
}
