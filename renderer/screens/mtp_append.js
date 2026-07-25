// --- MTP Explorer Logic ---
let mtpCurrentDevice = null;
let mtpCurrentPath = [];
let mtpSelectedItems = new Set();

window.openMtpExplorer = async function(deviceId) {
  const device = devicesData.find(d => d.id === deviceId);
  if (!device) return;

  mtpCurrentDevice = device.title;
  mtpCurrentPath = [];
  mtpSelectedItems.clear();

  document.getElementById('mtpExplorerModal').style.display = 'flex';
  await loadMtpFolder();
};

window.closeMtpExplorer = function() {
  document.getElementById('mtpExplorerModal').style.display = 'none';
  mtpCurrentDevice = null;
  mtpCurrentPath = [];
  mtpSelectedItems.clear();
};

async function loadMtpFolder() {
  const loading = document.getElementById('mtpExplorerLoading');
  const list = document.getElementById('mtpExplorerList');
  const breadcrumb = document.getElementById('mtpExplorerBreadcrumb');
  
  loading.style.display = 'block';
  list.innerHTML = '';
  updateMtpImportButton();

  // Render Breadcrumbs
  let bcHtml = `<span style="cursor:pointer; color: #00bcd4;" onclick="mtpNavigateTo(-1)">${mtpCurrentDevice}</span>`;
  mtpCurrentPath.forEach((p, idx) => {
    bcHtml += ` <span class="material-symbols-rounded" style="font-size:14px; opacity:0.5;">chevron_right</span> `;
    bcHtml += `<span style="cursor:pointer; ${idx === mtpCurrentPath.length - 1 ? 'color: #fff;' : 'color: #00bcd4;'}" onclick="mtpNavigateTo(${idx})">${p}</span>`;
  });
  breadcrumb.innerHTML = bcHtml;

  try {
    const items = await window.bds.listMtpFolder(mtpCurrentDevice, mtpCurrentPath);
    loading.style.display = 'none';

    if (!items || items.length === 0) {
      list.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--muted); padding: 40px;">Pasta vazia ou indisponível.</div>`;
      return;
    }

    // Sort: Folders first
    items.sort((a, b) => {
      if (a.IsFolder && !b.IsFolder) return -1;
      if (!a.IsFolder && b.IsFolder) return 1;
      return a.Name.localeCompare(b.Name);
    });

    items.forEach(item => {
      const isSelected = mtpSelectedItems.has(item.Name);
      const icon = item.IsFolder ? 'folder' : (item.Name.toLowerCase().endsWith('.mp4') ? 'movie' : 'image');
      const color = item.IsFolder ? '#FFC107' : '#00bcd4';

      const div = document.createElement('div');
      div.className = `mtp-item ${isSelected ? 'selected' : ''}`;
      div.innerHTML = `
        <input type="checkbox" class="checkbox" ${isSelected ? 'checked' : ''}>
        <span class="material-symbols-rounded" style="font-size: 36px; color: ${color};">${icon}</span>
        <span style="font-size: 11px; font-weight: 600; text-align: center; word-break: break-all; color: #fff;">${item.Name}</span>
      `;

      if (item.IsFolder) {
        div.addEventListener('dblclick', () => {
          mtpCurrentPath.push(item.Name);
          loadMtpFolder();
        });
      }

      div.addEventListener('click', (e) => {
        // Toggle Selection
        if (mtpSelectedItems.has(item.Name)) {
          mtpSelectedItems.delete(item.Name);
          div.classList.remove('selected');
          div.querySelector('.checkbox').checked = false;
        } else {
          mtpSelectedItems.add(item.Name);
          div.classList.add('selected');
          div.querySelector('.checkbox').checked = true;
        }
        updateMtpImportButton();
      });

      list.appendChild(div);
    });

  } catch (e) {
    loading.style.display = 'none';
    list.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: red; padding: 40px;">Erro ao carregar diretório.</div>`;
  }
}

window.mtpNavigateTo = function(index) {
  if (index === -1) {
    mtpCurrentPath = [];
  } else {
    mtpCurrentPath = mtpCurrentPath.slice(0, index + 1);
  }
  loadMtpFolder();
};

function updateMtpImportButton() {
  const btn = document.getElementById('btnMtpImport');
  const count = document.getElementById('mtpExplorerSelectedCount');
  const selectedSize = mtpSelectedItems.size;
  
  count.textContent = selectedSize;
  if (selectedSize > 0) {
    btn.removeAttribute('disabled');
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  } else {
    btn.setAttribute('disabled', 'true');
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
  }
}

// Bind Events for MTP Modal
setTimeout(() => {
  const btnMtpClose = document.getElementById('btnMtpClose');
  if (btnMtpClose) {
    btnMtpClose.addEventListener('click', closeMtpExplorer);
  }

  const btnMtpImport = document.getElementById('btnMtpImport');
  if (btnMtpImport) {
    btnMtpImport.addEventListener('click', async () => {
      const eventName = prompt('Digite o nome do Evento ou Pasta (ex: Casamento_Joao):');
      if (!eventName) return;

      const itemsToImport = Array.from(mtpSelectedItems);
      if (itemsToImport.length === 0) return;

      // Pegar configurações para saber o deviceFolder
      const settings = await window.api.getSettings();
      const baseDest = settings.deviceFolder || 'C:/Users/Public/Videos/BDSM DEVICES'; // Fallback
      const finalDest = baseDest + '\\\\' + mtpCurrentDevice + '\\\\' + eventName;

      btnMtpImport.setAttribute('disabled', 'true');
      btnMtpImport.innerHTML = `<span class="material-symbols-rounded" style="animation: spin 1s linear infinite;">sync</span> Importando...`;

      try {
        const success = await window.bds.importMtpItems(mtpCurrentDevice, mtpCurrentPath, itemsToImport, finalDest);
        if (success) {
          alert('Importação Concluída');
          mtpSelectedItems.clear();
          loadMtpFolder();
        } else {
          alert('Houve um erro durante a importação.');
        }
      } catch(e) {
        alert('Erro ao importar itens.');
      }

      btnMtpImport.innerHTML = `<span class="material-symbols-rounded" style="font-size: 18px;">download</span> Importar Selecionados`;
      updateMtpImportButton();
    });
  }
}, 500);

// Attach event listener inside grid generation to "Explorar" button
document.addEventListener('click', (e) => {
  const exploreBtn = e.target.closest('button[data-action="explore"]');
  if (exploreBtn) {
    const devId = exploreBtn.getAttribute('data-devid');
    const dev = devicesData.find(d => d.id === devId);
    if (dev && dev.type === 'mtp') {
      openMtpExplorer(devId);
    }
  }
});
