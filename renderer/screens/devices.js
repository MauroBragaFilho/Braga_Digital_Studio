let selectedDeviceId = 'sony_a6000';
let activeInspectorTab = 'geral';
let appSettings = {};

const devicesData = [];
const allDevicesRaw = [];

function getDeviceImage(type, category, name) {
  const n = ((category || '') + ' ' + (name || '')).toLowerCase();
  if (type === 'usb') return './assets/devices/sd_card.jpg';
  if (type === 'bdsm') return './assets/devices/galaxy_phone.jpg';
  if (n.includes('media server') || n.includes('servidor') || n.includes('ftp')) {
    return './assets/devices/ftp_server.jpg';
  }
  if (n.includes('phone') || n.includes('celular') || n.includes('galaxy') || n.includes('iphone') || n.includes('android')) {
    return './assets/devices/galaxy_phone.jpg';
  }
  if (n.includes('camera') || n.includes('câmera') || n.includes('sony') || n.includes('canon') || n.includes('lumix') || n.includes('eos')) {
    return './assets/devices/sony_camera.jpg';
  }
  if (n.includes('disk') || n.includes('disco') || n.includes('storage') || n.includes('cartão') || n.includes('card')) {
    return './assets/devices/sd_card.jpg';
  }
  return './assets/devices/galaxy_phone.jpg';
}

export async function initScreen(forceRescan = false) {
  console.log('[DEVICES] Inicializando tela...');

  if (window.bds && window.bds.getSettings) {
    appSettings = await window.bds.getSettings();
  }
  if (!appSettings.hiddenDevices) appSettings.hiddenDevices = [];

  if (window.bds && window.bds.getAllDevices) {
    try {
      const mtpDevices = await window.bds.getAllDevices(forceRescan);
      devicesData.length = 0;
      allDevicesRaw.length = 0;

      if (mtpDevices && mtpDevices.length > 0) {
        mtpDevices.forEach((device, index) => {
          let dType = (device.type || device.Type || 'unknown').toLowerCase();
          let dName = device.name || device.Name || 'Dispositivo Desconhecido';
          
          allDevicesRaw.push({ title: dName, type: dType, raw: device });
          
          if (appSettings.hiddenDevices && appSettings.hiddenDevices.includes(dName)) {
            return;
          }
          
          let storageUsed = 0, storageFree = 0, storageTotal = 0, storagePercent = 0;
          
          if (dType === 'usb') {
             if (device.storage && device.storage.length > 0) {
                const store = device.storage[0];
                storageTotal = store.capacity / (1024 ** 3);
                storageFree = store.free / (1024 ** 3);
                storageUsed = storageTotal - storageFree;
                storagePercent = Math.round((storageUsed / storageTotal) * 100);
             }
             devicesData.push({
                id: 'usb_' + device.id.replace(/[^a-zA-Z0-9]/g, ''),
                title: dName,
                category: 'Mass Storage',
                categoryColor: '#ff9800',
                connectionText: 'Conectado via USB (Mass Storage)',
                statusDotColor: '#4caf50',
                image: getDeviceImage('usb', 'Mass Storage', dName),
                type: 'usb',
                rawDevice: device,
                badgeStatus: 'Conectado',
                details: {
                  deviceType: 'Removable Disk',
                  manufacturer: 'Generic',
                  model: dName,
                  connection: 'USB',
                  ip: 'N/A',
                  battery: 'N/A',
                  app: 'Windows Explorer',
                  status: 'Montado como Disco Local'
                },
                storage: {
                  used: storageUsed.toFixed(1) + ' GB',
                  free: storageFree.toFixed(1) + ' GB',
                  total: storageTotal.toFixed(1) + ' GB',
                  percent: storagePercent || 0
                },
                buttons: [
                  { label: 'Explorar', primary: true, action: 'explore' }
                ]
             });
          } else if (dType === 'bdsm') {
             storageTotal = device.storage_total || 0;
             storageFree = device.storage_free || 0;
             storageUsed = storageTotal - storageFree;
             storagePercent = storageTotal > 0 ? Math.round((storageUsed / storageTotal) * 100) : 0;

             devicesData.push({
                id: 'bdsm_' + device.id,
                title: dName,
                category: 'BDSM Mobile App',
                categoryColor: '#f25c05',
                connectionText: `Conectado via Wi-Fi (${device.ip})`,
                statusDotColor: '#4caf50',
                image: getDeviceImage('bdsm', 'BDSM Mobile App', dName),
                type: 'bdsm',
                wifiIp: device.ip,
                battery: device.battery || '--',
                rawDevice: device,
                badgeStatus: 'Conectado',
                details: {
                  deviceType: 'Smartphone',
                  manufacturer: 'Mobile',
                  model: device.model || dName,
                  connection: `Wi-Fi (${device.ip}:${device.port})`,
                  ip: device.ip,
                  battery: `${device.battery || '--'}%`,
                  app: `BDSM v${device.app_version || '1.0'}`,
                  status: 'Sincronização Ativa'
                },
                storage: {
                  used: (storageUsed / (1024 ** 3)).toFixed(1) + ' GB',
                  free: (storageFree / (1024 ** 3)).toFixed(1) + ' GB',
                  total: (storageTotal / (1024 ** 3)).toFixed(1) + ' GB',
                  percent: storagePercent
                },
                buttons: [
                  { label: 'Importar Mídia', primary: true, action: 'bdsm_import' },
                  { label: 'Sync LUTs', primary: false, action: 'bdsm_luts' }
                ]
             });
          } else if (dType === 'sony') {
             devicesData.push({
                id: 'sony_' + (device.id || 'cam').replace(/[^a-zA-Z0-9]/g, ''),
                title: dName,
                category: 'Sony Remote Camera',
                categoryColor: '#e040fb',
                connectionText: `Conectado via Wi-Fi Direct (${device.ip || '192.168.122.1'})`,
                statusDotColor: '#4caf50',
                image: getDeviceImage('sony', 'Sony Remote Camera', dName),
                type: 'sony',
                wifiIp: device.ip,
                rawDevice: device,
                badgeStatus: 'Conectado',
                details: {
                  deviceType: 'Mirrorless / Compact Camera',
                  manufacturer: 'Sony Corporation',
                  model: device.model || dName,
                  connection: `Wi-Fi (${device.ip || '192.168.122.1'}:8080)`,
                  ip: device.ip || '192.168.122.1',
                  battery: device.battery != null ? `${device.battery}%` : 'Ativa',
                  app: 'Sony Camera Remote API',
                  status: 'Pronto para Download'
                },
                storage: {
                  used: '0 GB',
                  free: 'Calculando...',
                  total: 'Calculando...',
                  percent: 0
                },
                buttons: [
                  { label: 'Importar Mídia', primary: true, action: 'sony_import' }
                ]
             });
          } else {
             if (device.Storages && device.Storages.length > 0) {
                const store = device.Storages[0];
                storageTotal = store.TotalSize / (1024 ** 3);
                storageFree = store.FreeSpace / (1024 ** 3);
                storageUsed = storageTotal - storageFree;
                storagePercent = Math.round((storageUsed / storageTotal) * 100);
             }
             devicesData.push({
                id: 'mtp_' + index,
                title: dName,
                category: device.Type || 'MTP Device',
                categoryColor: '#00bcd4',
                connectionText: 'Conectado via MTP (USB)',
                statusDotColor: '#4caf50',
                image: getDeviceImage('mtp', device.Type || 'MTP Device', dName),
                type: 'mtp',
                rawDevice: device,
                badgeStatus: 'Conectado',
                details: {
                  deviceType: device.Type,
                  manufacturer: device.Manufacturer || 'MTP Device',
                  model: dName,
                  connection: 'USB',
                  ip: 'N/A',
                  battery: device.BatteryLevel != null ? `${device.BatteryLevel}%` : 'N/A',
                  app: 'Windows Portable Device',
                  status: 'Montado e Pronto'
                },
                storage: {
                  used: storageUsed.toFixed(1) + ' GB',
                  free: storageFree.toFixed(1) + ' GB',
                  total: storageTotal.toFixed(1) + ' GB',
                  percent: storagePercent || 0
                },
                buttons: [
                  { label: 'Explorar', primary: true, action: 'explore' }
                ]
             });
          }
        });
        
        if (devicesData.length > 0) {
          selectedDeviceId = devicesData[0].id;
        }
      }
    } catch (e) {
      console.error('[DEVICES] Erro ao buscar MTP Devices:', e);
    }
  }

  renderDevicesGrid();
  renderInspector();
  bindGlobalEvents();

  if (window.bds.onBdsmDeviceAdded && !window._bdsmEventsRegistered) {
      window.bds.onBdsmDeviceAdded(() => initScreen());
      window.bds.onBdsmDeviceRemoved(() => initScreen());
      window.bds.onBdsmDeviceUpdated(() => initScreen());
      window._bdsmEventsRegistered = true;
  }
}

function bindGlobalEvents() {
  const btnRefresh = document.getElementById('btnRefreshDevices');
  if (btnRefresh && !btnRefresh.dataset.bound) {
    btnRefresh.dataset.bound = 'true';
    btnRefresh.addEventListener('click', async () => {
      btnRefresh.classList.add('spinning');
      setTimeout(() => btnRefresh.classList.remove('spinning'), 500);
      await initScreen(true);
    });
  }

  const btnAdd = document.getElementById('btnAddDevice');
  if (btnAdd && !btnAdd.dataset.bound) {
    btnAdd.dataset.bound = 'true';
    btnAdd.addEventListener('click', () => {
      window.bdsModal.alert('Recurso para adicionar novos dispositivos (Wi-Fi, FTP, USB) em desenvolvimento!');
    });
  }

  const btnManageHidden = document.getElementById('btnManageHiddenDevices');
  const countHidden = document.getElementById('hiddenDevicesCount');
  
  if (btnManageHidden) {
    if ((appSettings.hiddenDevices && appSettings.hiddenDevices.length > 0) || devicesData.length > 0) {
      btnManageHidden.classList.remove('hidden');
      if (countHidden) countHidden.textContent = (appSettings.hiddenDevices || []).length;
    } else {
      btnManageHidden.classList.add('hidden');
    }
    
    if (!btnManageHidden.dataset.bound) {
      btnManageHidden.dataset.bound = 'true';
      btnManageHidden.addEventListener('click', openManageHiddenModal);
    }
  }

  const btnMtpClose = document.getElementById('btnMtpClose');
  if (btnMtpClose && !btnMtpClose.dataset.bound) {
    btnMtpClose.dataset.bound = 'true';
    btnMtpClose.addEventListener('click', closeMtpExplorer);
  }

  const btnBdsmClose = document.getElementById('btnBdsmClose');
  if (btnBdsmClose && !btnBdsmClose.dataset.bound) {
    btnBdsmClose.dataset.bound = 'true';
    btnBdsmClose.addEventListener('click', closeBdsmImportModal);
  }

  const btnManageHiddenClose = document.getElementById('btnManageHiddenClose');
  if (btnManageHiddenClose && !btnManageHiddenClose.dataset.bound) {
    btnManageHiddenClose.dataset.bound = 'true';
    btnManageHiddenClose.addEventListener('click', () => {
      const modal = document.getElementById('manageHiddenDevicesModal');
      if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('active');
      }
    });
  }

  const btnManageHiddenDone = document.getElementById('btnManageHiddenDone');
  if (btnManageHiddenDone && !btnManageHiddenDone.dataset.bound) {
    btnManageHiddenDone.dataset.bound = 'true';
    btnManageHiddenDone.addEventListener('click', () => {
      const modal = document.getElementById('manageHiddenDevicesModal');
      if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('active');
      }
      initScreen();
    });
  }
}

async function toggleHiddenDevice(title) {
  if (!appSettings.hiddenDevices) appSettings.hiddenDevices = [];
  const idx = appSettings.hiddenDevices.indexOf(title);
  if (idx > -1) {
    appSettings.hiddenDevices.splice(idx, 1);
  } else {
    appSettings.hiddenDevices.push(title);
  }
  if (window.bds && window.bds.saveSettings) await window.bds.saveSettings(appSettings);
  renderManageHiddenModal();
}

function openManageHiddenModal() {
  const modal = document.getElementById('manageHiddenDevicesModal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('active');
    renderManageHiddenModal();
  }
}

function renderManageHiddenModal() {
  const availableList = document.getElementById('manageHiddenAvailableList');
  const ignoredList = document.getElementById('manageHiddenIgnoredList');
  if (!availableList || !ignoredList) return;

  const hidden = appSettings.hiddenDevices || [];
  const available = allDevicesRaw.filter(d => !hidden.includes(d.title));
  
  if (available.length === 0) {
    availableList.innerHTML = '<div class="empty-state">Nenhum dispositivo disponível.</div>';
  } else {
    availableList.innerHTML = available.map(d => `
      <div class="manage-hidden-item">
        <span class="manage-hidden-item-name">${escapeHtml(d.title)}</span>
        <button class="manage-hidden-toggle-btn hide" data-device-title="${escapeAttr(d.title)}" title="Ocultar" type="button">
          <span class="material-symbols-rounded">visibility_off</span>
        </button>
      </div>
    `).join('');
  }

  if (hidden.length === 0) {
    ignoredList.innerHTML = '<div class="empty-state">Nenhum dispositivo ignorado.</div>';
  } else {
    ignoredList.innerHTML = hidden.map(title => `
      <div class="manage-hidden-item ignored">
        <span class="manage-hidden-item-name">${escapeHtml(title)}</span>
        <button class="manage-hidden-toggle-btn restore" data-device-title="${escapeAttr(title)}" title="Restaurar" type="button">
          <span class="material-symbols-rounded">visibility</span>
        </button>
      </div>
    `).join('');
  }

  // Bind toggle events
  availableList.querySelectorAll('.manage-hidden-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleHiddenDevice(btn.dataset.deviceTitle));
  });
  ignoredList.querySelectorAll('.manage-hidden-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleHiddenDevice(btn.dataset.deviceTitle));
  });
}

function renderDevicesGrid() {
  const container = document.getElementById('devicesGrid');
  if (!container) return;

  const countEl = document.getElementById('devicesCount');
  if (countEl) countEl.textContent = devicesData.length;

  if (devicesData.length === 0) {
    container.innerHTML = '<div class="devices-grid-empty">Nenhum dispositivo conectado.</div>';
    return;
  }

  container.innerHTML = devicesData.map(dev => {
    const isSelected = dev.id === selectedDeviceId;
    return `
      <div class="device-card ${isSelected ? 'selected' : ''}" data-id="${dev.id}">
        <button class="dev-card-hide-btn" data-action="hide" data-devid="${dev.id}" title="Ocultar Dispositivo" type="button">
          <span class="material-symbols-rounded">visibility_off</span>
        </button>

        <div class="dev-card-top">
          <div class="dev-card-image-wrap">
            <img src="${dev.image}" alt="${escapeAttr(dev.title)}" onError="this.style.display='none'" />
          </div>
          <div class="dev-card-info">
            <h3 class="dev-card-title">${escapeHtml(dev.title)}</h3>
            <div class="dev-card-category" style="color: ${dev.categoryColor};">${escapeHtml(dev.category)}</div>
            <div class="dev-card-status">
              <span class="dev-card-status-dot online"></span>
              <span>${escapeHtml(dev.connectionText)}</span>
            </div>
          </div>
        </div>

        ${renderCardMiddle(dev)}

        <div class="dev-card-actions">
          ${dev.buttons.map(b => `
            <button class="dev-card-btn ${b.primary ? 'primary' : ''} ${b.label === '...' ? 'small' : ''}" data-action="${b.action}" data-devid="${dev.id}" type="button">
              ${escapeHtml(b.label)}
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.device-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.dev-card-hide-btn') || e.target.closest('.dev-card-btn')) {
        const btn = e.target.closest('.dev-card-hide-btn') || e.target.closest('.dev-card-btn');
        const action = btn.getAttribute('data-action');
        const devId = btn.getAttribute('data-devid');
        handleCardAction(action, devId);
        e.stopPropagation();
        return;
      }
      selectedDeviceId = card.getAttribute('data-id');
      renderDevicesGrid();
      renderInspector();
    });
  });
}

function renderCardMiddle(dev) {
  if (dev.wifiIp) {
    return `
      <div class="dev-card-middle dev-card-middle-wifi">
        <div class="wifi-info">
          <span class="material-symbols-rounded">wifi</span>
          <span>${escapeHtml(dev.wifiIp)}</span>
        </div>
        <div class="battery-info">
          <span class="material-symbols-rounded">battery_charging_full</span>
          <span>${escapeHtml(dev.battery)}%</span>
        </div>
      </div>
    `;
  }

  if (dev.ftpInfo) {
    return `
      <div class="dev-card-middle">
        <div class="dev-card-ftp-info">
          <div class="ftp-url">
            <span class="material-symbols-rounded">lock</span>
            <span>${escapeHtml(dev.ftpInfo.url)}</span>
          </div>
          <div class="ftp-user">
            <span class="material-symbols-rounded">person</span>
            <span>${escapeHtml(dev.ftpInfo.user)}</span>
          </div>
        </div>
        <div class="dev-card-storage-label">
          <span class="material-symbols-rounded">hard_drive</span>
          <span>${escapeHtml(dev.storageInfo.text)}</span>
        </div>
        <div class="dev-card-storage-bar">
          <div class="dev-card-storage-fill ${dev.storageInfo.percent > 90 ? 'critical' : (dev.storageInfo.percent > 75 ? 'warning' : '')}" style="width: ${dev.storageInfo.percent}%;"></div>
        </div>
      </div>
    `;
  }

  if (dev.storage) {
    const percent = dev.storage.percent || 0;
    return `
      <div class="dev-card-middle dev-card-middle-storage">
        <div class="dev-card-storage-label">
          <span class="material-symbols-rounded">sd_storage</span>
          <span>${escapeHtml(dev.storage.used)} / ${escapeHtml(dev.storage.total)}</span>
        </div>
        <div class="dev-card-storage-bar">
          <div class="dev-card-storage-fill ${percent > 90 ? 'critical' : (percent > 75 ? 'warning' : '')}" style="width: ${percent}%;"></div>
        </div>
      </div>
    `;
  }

  return '';
}

async function handleCardAction(action, devId) {
  const dev = devicesData.find(d => d.id === devId);
  if (!dev) return;

  if (action === 'hide') {
    if (!appSettings.hiddenDevices) appSettings.hiddenDevices = [];
    appSettings.hiddenDevices.push(dev.title);
    if (window.bds && window.bds.saveSettings) await window.bds.saveSettings(appSettings);
    initScreen();
    return;
  }

  if (action === 'explore') {
    openMtpExplorer(devId);
  } else if (action === 'bdsm_import') {
    openBdsmImportModal(devId);
  } else if (action === 'bdsm_luts') {
    openBdsmLutsModal(devId);
  } else if (action === 'eject') {
    window.bdsModal.alert(`Ejetando o dispositivo com segurança: ${dev.title}`);
  } else if (action === 'configure') {
    window.bdsModal.alert(`Abrindo configurações avançadas de FTP para: ${dev.title}`);
  } else if (action === 'import') {
    window.bdsModal.alert(`Iniciando importação rápida de fotos e vídeos de: ${dev.title}`);
  } else if (action === 'more') {
    window.bdsModal.alert(`Opções adicionais para: ${dev.title}`);
  }
}

function renderInspector() {
  const panel = document.getElementById('deviceInspector');
  if (!panel) return;

  const dev = devicesData.find(d => d.id === selectedDeviceId) || devicesData[0];
  if (!dev) {
    panel.innerHTML = '<div style="padding: 20px; color: var(--muted); text-align: center;">Nenhum dispositivo selecionado</div>';
    return;
  }

  const tabs = ['geral', 'armazenamento', 'informações', 'configurações'];
  const labels = { geral: 'Geral', armazenamento: 'Armazenamento', informações: 'Informações', configurações: 'Configurações' };
  const icons = { geral: 'tune', armazenamento: 'hard_drive', informações: 'info', configurações: 'settings' };

  panel.innerHTML = `
    <div class="inspector-header">
      <div class="inspector-header-left">
        <h2 class="inspector-header-title">${escapeHtml(dev.title)}</h2>
        <span class="inspector-badge">${escapeHtml(dev.badgeStatus)}</span>
      </div>
      <button id="btnCloseInspector" class="inspector-close-btn" type="button">
        <span class="material-symbols-rounded">close</span>
      </button>
    </div>

    <div class="inspector-image">
      <img src="${dev.image}" alt="${escapeAttr(dev.title)}" />
    </div>

    <div class="inspector-tabs">
      ${tabs.map(tabKey => `
        <button class="inspector-tab-btn ${activeInspectorTab === tabKey ? 'active' : ''}" data-tab="${tabKey}" type="button">
          <span class="material-symbols-rounded">${icons[tabKey]}</span>
          <span>${labels[tabKey]}</span>
        </button>
      `).join('')}
    </div>

    <div class="inspector-content">
      ${renderInspectorTabContent(dev)}
    </div>

    <div class="inspector-footer">
      <button id="btnSyncTime" class="inspector-footer-btn secondary" type="button">
        <span class="material-symbols-rounded">schedule</span>
        Sincronizar Hora
      </button>
      <button id="btnDisconnect" class="inspector-footer-btn danger" type="button">
        <span class="material-symbols-rounded">power_settings_new</span>
        Desconectar
      </button>
    </div>
  `;

  panel.querySelectorAll('.inspector-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeInspectorTab = btn.getAttribute('data-tab');
      renderInspector();
    });
  });

  document.getElementById('btnCloseInspector')?.addEventListener('click', () => {
    selectedDeviceId = null;
    renderDevicesGrid();
    panel.innerHTML = '';
  });
}

function renderInspectorTabContent(dev) {
  if (activeInspectorTab === 'geral') {
    const items = [
      { label: 'Tipo de dispositivo', val: dev.details.deviceType, icon: 'photo_camera' },
      { label: 'Fabricante', val: dev.details.manufacturer, icon: 'domain' },
      { label: 'Modelo', val: dev.details.model, icon: 'memory' },
      { label: 'Conexão', val: dev.details.connection, icon: 'wifi' },
      { label: 'Endereço IP', val: dev.details.ip, icon: 'language' },
      { label: 'Bateria', val: dev.details.battery, icon: 'battery_charging_full' },
      { label: 'Aplicativo', val: dev.details.app, icon: 'apps' },
      { label: 'Status', val: dev.details.status, icon: 'check_circle' }
    ];

    return `
      <div class="inspector-details-list">
        ${items.map(it => `
          <div class="inspector-detail-row">
            <div class="inspector-detail-label">
              <span class="material-symbols-rounded">${it.icon}</span>
              <span>${it.label}</span>
            </div>
            <div class="inspector-detail-value">${escapeHtml(it.val)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  if (activeInspectorTab === 'armazenamento') {
    const percent = dev.storage.percent || 0;
    return `
      <div>
        <div class="inspector-storage-card">
          <div class="inspector-storage-label">Espaço Utilizado</div>
          <div class="inspector-storage-value">${escapeHtml(dev.storage.used)} / ${escapeHtml(dev.storage.total)}</div>
          <div class="inspector-storage-bar">
            <div class="inspector-storage-fill" style="width: ${percent}%;"></div>
          </div>
        </div>
        <div class="inspector-storage-details">
          <div class="row"><span>Espaço Livre:</span> <strong>${escapeHtml(dev.storage.free)}</strong></div>
          <div class="row"><span>Sistema de Arquivos:</span> <strong>exFAT / NTFS</strong></div>
          <div class="row"><span>Total de Mídias:</span> <strong>142 arquivos</strong></div>
        </div>
      </div>
    `;
  }

  if (activeInspectorTab === 'informações') {
    return `
      <div class="inspector-info-list">
        <div class="row"><span class="label">Firmware:</span> <strong>v3.20</strong></div>
        <div class="row"><span class="label">Número de Série:</span> <strong>S01-9948210-B</strong></div>
        <div class="row"><span class="label">Última Sincronização:</span> <strong>Hoje às 14:32</strong></div>
        <div class="row"><span class="label">Origem de Ingestão:</span> <strong>BDSM_DEVICE</strong></div>
      </div>
    `;
  }

  if (activeInspectorTab === 'configurações') {
    return `
      <div class="inspector-config-list">
        <label><span>Sincronização Automática</span> <input type="checkbox" checked /></label>
        <label><span>Ejetar ao Concluir Importação</span> <input type="checkbox" /></label>
        <label><span>Manter Cópia de Segurança</span> <input type="checkbox" checked /></label>
      </div>
    `;
  }

  return '';
}

// --- MTP Explorer Logic ---
let explorerDevId = null;
let mtpCurrentDevice = null;
let mtpCurrentPath = [];
let mtpSelectedItems = new Set();

function openMtpExplorer(deviceId) {
  const device = devicesData.find(d => d.id === deviceId);
  if (!device) return;

  explorerDevId = device.id;
  mtpCurrentDevice = device.title;
  mtpCurrentPath = [];
  mtpSelectedItems.clear();

  const modal = document.getElementById('mtpExplorerModal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('active');
  }
  
  if (device.type === 'mtp') {
    window.bds.listMtpFolder(mtpCurrentDevice, []).then(rootItems => {
      if (rootItems && rootItems.some(i => i.Name === 'Storage Media')) {
        mtpCurrentPath = ['Storage Media'];
      }
      loadMtpFolder();
    }).catch(() => loadMtpFolder());
  } else {
    loadMtpFolder();
  }
}

function closeMtpExplorer() {
  const modal = document.getElementById('mtpExplorerModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('active');
  }
  mtpCurrentDevice = null;
  mtpCurrentPath = [];
  mtpSelectedItems.clear();
}

function mtpNavigateTo(index) {
  if (index === -1) {
    mtpCurrentPath = [];
  } else {
    mtpCurrentPath = mtpCurrentPath.slice(0, index + 1);
  }
  loadMtpFolder();
}

async function loadMtpFolder() {
  const loading = document.getElementById('mtpExplorerLoading');
  const list = document.getElementById('mtpExplorerList');
  const breadcrumb = document.getElementById('mtpExplorerBreadcrumb');
  
  if (loading) {
    loading.classList.remove('hidden');
    loading.style.display = 'block';
  }
  if (list) list.innerHTML = '';
  updateMtpImportButton();

  // Breadcrumbs
  let bcHtml = `<span class="bc-link" data-index="-1">${escapeHtml(mtpCurrentDevice)}</span>`;
  mtpCurrentPath.forEach((p, idx) => {
    bcHtml += ` <span class="material-symbols-rounded">chevron_right</span> `;
    const isCurrent = idx === mtpCurrentPath.length - 1;
    bcHtml += `<span class="${isCurrent ? 'bc-current' : 'bc-link'}" data-index="${idx}">${escapeHtml(p)}</span>`;
  });
  if (breadcrumb) breadcrumb.innerHTML = bcHtml;

  // Bind breadcrumb clicks
  if (breadcrumb) {
    breadcrumb.querySelectorAll('.bc-link').forEach(link => {
      link.addEventListener('click', () => {
        const idx = parseInt(link.dataset.index);
        mtpNavigateTo(idx);
      });
    });
  }

  try {
    const dev = devicesData.find(d => d.id === explorerDevId);
    const isUsb = dev && dev.type === 'usb';
    const target = isUsb ? dev.rawDevice.storage[0].path : mtpCurrentDevice;
      
    let items;
    if (isUsb) {
      const usbResult = await window.bds.listUsbFolder(target, mtpCurrentPath);
      items = (usbResult && usbResult.success) ? usbResult.items.map(i => ({ Name: i.name, IsFolder: i.isFolder, ObjectSize: i.size })) : [];
    } else {
      items = await window.bds.listMtpFolder(target, mtpCurrentPath);
    }

    if (loading) {
      loading.classList.add('hidden');
      loading.style.display = 'none';
    }

    if (!items || items.length === 0) {
      list.className = 'mtp-items-grid empty-state';
      list.innerHTML = 'Pasta vazia ou indisponível.';
      return;
    }

    list.className = 'mtp-items-grid';
    items = items.filter(i => {
      const n = i.Name.toUpperCase();
      return n !== 'INFO' && n !== 'FOR_WIN.URL';
    }).sort((a, b) => {
      if (a.IsFolder && !b.IsFolder) return -1;
      if (!a.IsFolder && b.IsFolder) return 1;
      return a.Name.localeCompare(b.Name);
    });

    items.forEach(item => {
      const isSelected = mtpSelectedItems.has(item.Name);
      const icon = item.IsFolder ? 'folder' : (item.Name.toLowerCase().endsWith('.mp4') ? 'movie' : 'image');
      const iconClass = item.IsFolder ? 'folder' : 'file';

      const div = document.createElement('div');
      div.className = `mtp-item ${isSelected ? 'selected' : ''}`;
      div.dataset.name = item.Name;
      div.dataset.isFolder = item.IsFolder ? 'true' : 'false';
      div.innerHTML = `
        <input type="checkbox" class="checkbox" ${isSelected ? 'checked' : ''}>
        <span class="material-symbols-rounded item-icon ${iconClass}">${icon}</span>
        <span class="item-name">${escapeHtml(item.Name)}</span>
      `;

      div.addEventListener('click', (e) => {
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

      if (item.IsFolder) {
        div.addEventListener('dblclick', () => {
          mtpCurrentPath.push(item.Name);
          loadMtpFolder();
        });
      }

      list.appendChild(div);
    });

  } catch (e) {
    if (loading) {
      loading.classList.add('hidden');
      loading.style.display = 'none';
    }
    list.className = 'mtp-items-grid error-state';
    list.innerHTML = 'Erro ao carregar diretório.';
  }
}

function updateMtpImportButton() {
  const btn = document.getElementById('btnMtpImport');
  const count = document.getElementById('mtpExplorerSelectedCount');
  const selectedSize = mtpSelectedItems.size;
  
  if (count) count.textContent = selectedSize;
  if (btn) {
    if (selectedSize > 0) {
      btn.removeAttribute('disabled');
    } else {
      btn.setAttribute('disabled', 'true');
    }
  }
}

// MTP Import Event
document.addEventListener('click', async (e) => {
  const mtpImportBtn = e.target.closest('#btnMtpImport');
  if (mtpImportBtn && !mtpImportBtn.hasAttribute('disabled')) {
    const eventName = await window.bdsModal.prompt('Digite o nome do Evento ou Pasta (ex: Casamento_Joao):');
    if (!eventName) return;

    const itemsToImport = Array.from(mtpSelectedItems);
    if (itemsToImport.length === 0) return;

    const settings = await window.bds.getSettings();
    const baseDest = settings.deviceFolder || 'C:/Users/Public/Videos/BDSM DEVICES';
    const finalDest = baseDest + '\\' + mtpCurrentDevice + '\\' + eventName;

    mtpImportBtn.setAttribute('disabled', 'true');
    mtpImportBtn.innerHTML = `<span class="material-symbols-rounded" style="animation: spin 1s linear infinite;">sync</span> Importando...`;

    const progressContainer = document.getElementById('mtpProgressContainer');
    const actionContainer = document.getElementById('mtpImportActionContainer');
    const pText = document.getElementById('mtpProgressText');
    const pPercent = document.getElementById('mtpProgressPercent');
    const pBar = document.getElementById('mtpProgressBar');
    const pEta = document.getElementById('mtpProgressEta');
    const pSpeed = document.getElementById('mtpProgressSpeed');
    
    if (actionContainer) actionContainer.style.display = 'none';
    if (progressContainer) {
      progressContainer.classList.remove('hidden');
      progressContainer.style.display = 'flex';
    }
    
    let startTime = Date.now();
    let totalItems = itemsToImport.length;
    let completedItems = 0;
    
    const unsubProgress = window.bds.onMtpProgress((data) => {
      let filePercent = data.percent || 0;
      let overallPercent = ((completedItems * 100) + filePercent) / totalItems;
      
      if (pText) pText.textContent = `Copiando: ${data.file}`;
      if (pPercent) pPercent.textContent = `${Math.round(overallPercent)}%`;
      if (pBar) pBar.style.width = `${overallPercent}%`;

      if (pSpeed && data.speedBps != null) {
        let speed = data.speedBps;
        if (speed >= 1048576) {
          pSpeed.textContent = `${(speed / 1048576).toFixed(1)} MB/s`;
        } else if (speed >= 1024) {
          pSpeed.textContent = `${Math.round(speed / 1024)} KB/s`;
        } else {
          pSpeed.textContent = `${speed} B/s`;
        }
      }
      
      if (filePercent >= 100) completedItems++;
      
      let elapsed = (Date.now() - startTime) / 1000;
      if (data.speedBps > 0 && data.totalSize > 0 && data.currentSize < data.totalSize) {
        let remainingBytes = (data.totalSize - data.currentSize) + ((totalItems - completedItems - 1) * data.totalSize);
        let remainingSecs = Math.ceil(remainingBytes / data.speedBps);
        if (remainingSecs > 0 && pEta) {
          let mins = Math.floor(remainingSecs / 60);
          let secs = Math.floor(remainingSecs % 60);
          pEta.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else if (pEta) {
          pEta.textContent = 'Quase lá...';
        }
      } else if (overallPercent > 0) {
        let totalEstimated = elapsed / (overallPercent / 100);
        let remaining = totalEstimated - elapsed;
        if (remaining > 0 && pEta) {
          let mins = Math.floor(remaining / 60);
          let secs = Math.floor(remaining % 60);
          pEta.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else if (pEta) {
          pEta.textContent = 'Quase lá...';
        }
      }
    });

    try {
      let success;
      const dev = devicesData.find(d => d.id === explorerDevId);
      if (dev && dev.type === 'usb') {
        const usbPath = dev.rawDevice.storage[0].path;
        success = await window.bds.importUsbItems(usbPath, mtpCurrentPath, itemsToImport, finalDest);
      } else {
        success = await window.bds.importMtpItems(mtpCurrentDevice, mtpCurrentPath, itemsToImport, finalDest);
      }
      unsubProgress();
      
      if (actionContainer) actionContainer.style.display = 'flex';
      if (progressContainer) {
        progressContainer.classList.add('hidden');
        progressContainer.style.display = 'none';
      }

      if (success) {
        window.bdsModal.alert('Importação Concluída');
        mtpSelectedItems.clear();
        loadMtpFolder();
      } else {
        window.bdsModal.alert('Houve um erro durante a importação.');
      }
    } catch(err) {
      unsubProgress();
      if (actionContainer) actionContainer.style.display = 'flex';
      if (progressContainer) {
        progressContainer.classList.add('hidden');
        progressContainer.style.display = 'none';
      }
      window.bdsModal.alert('Erro ao importar itens.');
    }

    mtpImportBtn.innerHTML = `<span class="material-symbols-rounded">download</span> Importar Selecionados`;
    updateMtpImportButton();
  }
});

// --- BDSM Logic ---
let bdsmMediaList = [];

async function openBdsmImportModal(devId) {
  const dev = devicesData.find(d => d.id === devId);
  if (!dev || dev.type !== 'bdsm') return;

  const modal = document.getElementById('bdsmImportModal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('active');
  }

  const loading = document.getElementById('bdsmLoading');
  const content = document.getElementById('bdsmContent');
  if (loading) loading.style.display = 'block';
  if (content) {
    content.classList.add('hidden');
    content.style.display = 'none';
  }

  try {
    bdsmMediaList = await window.bds.getBdsmMedia(dev.rawDevice.ip, dev.rawDevice.port) || [];
    const bdsmImportHistory = await window.bds.getBdsmImportHistory(dev.rawDevice.id) || [];
    
    const historySet = new Set(bdsmImportHistory);
    let newCount = 0, existCount = 0;
    
    bdsmMediaList.forEach(m => {
      if (historySet.has(m.name)) {
        m.alreadyImported = true;
        existCount++;
      } else {
        m.alreadyImported = false;
        newCount++;
      }
    });

    const statsEl = document.getElementById('bdsmStats');
    if (statsEl) statsEl.textContent = `${bdsmMediaList.length} vídeos encontrados. ${newCount} novos, ${existCount} já importados.`;
    
    const list = document.getElementById('bdsmMediaList');
    if (list) {
      list.innerHTML = '';
      bdsmMediaList.forEach(m => {
        const div = document.createElement('div');
        div.className = `mtp-item ${m.alreadyImported ? 'imported-item' : 'bdsm-new'}`;
        div.innerHTML = `
          <span class="material-symbols-rounded item-icon">${m.alreadyImported ? 'movie' : 'movie'}</span>
          <span class="item-name">${escapeHtml(m.name)}</span>
        `;
        list.appendChild(div);
      });
    }

    if (loading) loading.style.display = 'none';
    if (content) {
      content.classList.remove('hidden');
      content.style.display = 'flex';
    }

    const btnImport = document.getElementById('btnBdsmImportAction');
    if (btnImport && !btnImport.dataset.bound) {
      btnImport.dataset.bound = 'true';
      btnImport.onclick = async () => {
        const target = document.getElementById('bdsmProjectSelect').value;
        const projectId = target === 'lib' ? null : parseInt(target);
        const itemsToImport = bdsmMediaList.filter(m => !m.alreadyImported);
        if (itemsToImport.length === 0) return window.bdsModal.alert('Nenhum vídeo novo para importar.');

        const settings = await window.bds.getSettings();
        const destFolder = settings.deviceFolder || 'C:/Users/Public/Videos/BDSM DEVICES';

        btnImport.disabled = true;
        btnImport.innerHTML = 'Importando...';

        window.bds.onBdsmProgress((data) => {
          const statsEl = document.getElementById('bdsmStats');
          if (statsEl) statsEl.textContent = `Importando ${data.completed}/${data.total}: ${data.current}`;
        });

        try {
          await window.bds.importBdsmMedia({
            ip: dev.rawDevice.ip,
            port: dev.rawDevice.port,
            deviceId: dev.rawDevice.id,
            items: itemsToImport,
            destFolder,
            projectId
          });
          window.bdsModal.alert('Importação Concluída com sucesso!');
          closeBdsmImportModal();
        } catch(e) {
          window.bdsModal.alert('Erro ao importar: ' + e.message);
          btnImport.disabled = false;
          btnImport.innerHTML = '<span class="material-symbols-rounded">download</span> Importar Novos';
        }
      };
    }

  } catch(e) {
    if (loading) loading.style.display = 'none';
    window.bdsModal.alert('Erro ao carregar mídias do dispositivo: ' + e.message);
  }
}

function closeBdsmImportModal() {
  const modal = document.getElementById('bdsmImportModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('active');
  }
}

async function openBdsmLutsModal(devId) {
  const dev = devicesData.find(d => d.id === devId);
  if (!dev || dev.type !== 'bdsm') return;

  window.bdsModal.alert('Calculando diferenças, aguarde...');
  
  try {
    const plan = await window.bds.analyzeBdsmLutSync(dev.rawDevice.ip, dev.rawDevice.port);
    
    let confirmMsg = `Plano de Sincronização:\n\n`;
    confirmMsg += `- Enviar para o celular: ${plan.upload.length} LUT(s)\n`;
    confirmMsg += `- Baixar do celular: ${plan.download.length} LUT(s)\n`;
    confirmMsg += `- Conflitos (Mesmo nome, arquivos diferentes): ${plan.conflict.length}\n`;
    
    if (plan.upload.length === 0 && plan.download.length === 0 && plan.conflict.length === 0) {
      return window.bdsModal.alert('Tudo já está sincronizado!');
    }

    const proceed = await window.bdsModal.confirm(confirmMsg + '\nDeseja prosseguir com a sincronização?');
    if (!proceed) return;

    plan.conflict.forEach(c => c.resolution = 'keep_both');

    window.bds.onBdsmLutSyncProgress((data) => {
      console.log(`LutSync: ${data.current} (${data.completed}/${data.total})`);
    });

    await window.bds.executeBdsmLutSync({
      ip: dev.rawDevice.ip,
      port: dev.rawDevice.port,
      plan
    });

    window.bdsModal.alert('Sincronização de LUTs finalizada com sucesso!');
  } catch(e) {
    window.bdsModal.alert('Erro na sincronização de LUTs: ' + e.message);
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>'"]/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[m]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}