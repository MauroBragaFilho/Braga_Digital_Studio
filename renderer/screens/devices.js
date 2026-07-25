let selectedDeviceId = 'sony_a6000';
let activeInspectorTab = 'geral';

const devicesData = [];

export async function initScreen() {
  console.log('Devices screen initialized');

  if (window.bds && window.bds.getAllDevices) {
    try {
      const mtpDevices = await window.bds.getAllDevices();
      if (mtpDevices && mtpDevices.length > 0) {
        // Substituir os placeholders pelos dados reais do MTP
        devicesData.length = 0; // Limpar o array atual
        
        mtpDevices.forEach((device, index) => {
          let storageUsed = 0;
          let storageFree = 0;
          let storageTotal = 0;
          let storagePercent = 0;
          
          let dType = device.type || device.Type || 'unknown';
          dType = dType.toLowerCase();
          
          let dName = device.name || device.Name || 'Dispositivo Desconhecido';
          
          if (dType === 'usb') {
             // Tratamento para USB Mass Storage
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
                categoryColor: '#ff9800', // Laranja para USB
                connectionText: 'Conectado via USB (Mass Storage)',
                statusDotColor: '#4caf50',
                image: './assets/devices/sd_card.jpg',
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
             
          } else {
             // Tratamento para MTP
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
                categoryColor: '#00bcd4', // Azulzinho para MTP
                connectionText: 'Conectado via MTP (USB)',
                statusDotColor: '#4caf50',
                image: './assets/devices/sony_camera.jpg',
                type: 'mtp',
                rawDevice: device,
                badgeStatus: 'Conectado',
                details: {
                  deviceType: device.Type,
                  manufacturer: device.Manufacturer || 'MTP Device',
                  model: dName,
                  connection: 'USB',
                  ip: 'N/A',
                  battery: 'N/A',
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
      console.error('Erro ao buscar MTP Devices:', e);
    }
  }

  renderDevicesGrid();
  renderInspector();

  // Evento de Refresh
  const btnRefresh = document.getElementById('btnRefreshDevices');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      btnRefresh.style.transform = 'rotate(360deg)';
      btnRefresh.style.transition = 'transform 0.5s ease';
      setTimeout(() => {
        btnRefresh.style.transform = 'none';
        btnRefresh.style.transition = 'all 0.2s';
      }, 500);
      await initScreen();
    });
  }

  // Evento de Adicionar Dispositivo
  const btnAdd = document.getElementById('btnAddDevice');
  if (btnAdd) {
    btnAdd.addEventListener('click', () => {
      window.bdsModal.alert('Recurso para adicionar novos dispositivos (Wi-Fi, FTP, USB) em desenvolvimento!');
    });
  }

// Bind Events for MTP Modal
  const btnMtpClose = document.getElementById('btnMtpClose');
  if (btnMtpClose) {
    btnMtpClose.addEventListener('click', closeMtpExplorer);
  }



}

function renderDevicesGrid() {
  const container = document.getElementById('devicesGrid');
  if (!container) return;

  const countEl = document.getElementById('devicesCount');
  if (countEl) countEl.textContent = devicesData.length;

  container.innerHTML = devicesData.map(dev => {
    const isSelected = dev.id === selectedDeviceId;
    const borderStyle = isSelected ? '1px solid #f25c05' : '1px solid var(--line)';
    const shadowStyle = isSelected ? '0 0 16px rgba(242, 92, 5, 0.15)' : 'none';

    return `
      <div class="device-card" data-id="${dev.id}" style="background: var(--card); border: ${borderStyle}; box-shadow: ${shadowStyle}; border-radius: 12px; padding: 20px; cursor: pointer; transition: all 0.2s ease; display: flex; flex-direction: column; gap: 16px; position: relative;">
        
        <!-- Topo: Imagem + Título + Status -->
        <div style="display: flex; gap: 16px; align-items: center;">
          <div style="width: 80px; height: 75px; background: #151515; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.05);">
            <img src="${dev.image}" alt="${dev.title}" style="width: 100%; height: 100%; object-fit: contain;" onError="this.style.display='none'" />
          </div>

          <div style="flex: 1; min-width: 0;">
            <h3 style="font-size: 16px; font-weight: 700; color: #ffffff; margin: 0 0 4px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${dev.title}</h3>
            <div style="font-size: 12px; font-weight: 600; color: ${dev.categoryColor}; margin-bottom: 6px;">${dev.category}</div>
            
            <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted);">
              <span style="width: 8px; height: 8px; border-radius: 50%; background: ${dev.statusDotColor}; display: inline-block;"></span>
              <span>${dev.connectionText}</span>
            </div>
          </div>
        </div>

        <!-- Conteúdo do Meio (Conexão ou Barra de Espaço) -->
        ${renderCardMiddle(dev)}

        <!-- Botões de Ação Inferiores -->
        <div style="display: flex; gap: 10px; margin-top: auto; padding-top: 4px;">
          ${dev.buttons.map(b => `
            <button class="dev-card-btn" data-action="${b.action}" data-devid="${dev.id}" style="flex: ${b.label === '...' ? '0 0 40px' : '1'}; height: 36px; background: ${b.primary ? '#f25c05' : 'var(--card-2)'}; color: #ffffff; border: 1px solid ${b.primary ? '#f25c05' : 'var(--line)'}; border-radius: 6px; font-weight: 600; font-size: 13px; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center;">
              ${b.label}
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');

  // Adiciona ouvintes de clique nos cards
  const cards = container.querySelectorAll('.device-card');
  cards.forEach(card => {
    card.addEventListener('click', (e) => {
      // Se clicou em um botão dentro do card, executa ação do botão sem fechar/abrir
      if (e.target.closest('.dev-card-btn')) {
        const btn = e.target.closest('.dev-card-btn');
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
      <div style="background: rgba(0,0,0,0.25); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; font-size: 12px;">
        <div style="display: flex; align-items: center; gap: 8px; color: var(--muted);">
          <span class="material-symbols-rounded" style="font-size: 16px;">wifi</span>
          <span>${dev.wifiIp}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; color: #ffffff; font-weight: 600;">
          <span class="material-symbols-rounded" style="font-size: 18px; color: #4caf50;">battery_charging_full</span>
          <span>${dev.battery}%</span>
        </div>
      </div>
    `;
  }

  if (dev.ftpInfo) {
    return `
      <div style="background: rgba(0,0,0,0.25); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--muted);">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="material-symbols-rounded" style="font-size: 14px;">lock</span>
            <span>${dev.ftpInfo.url}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 4px;">
            <span class="material-symbols-rounded" style="font-size: 14px;">person</span>
            <span>${dev.ftpInfo.user}</span>
          </div>
        </div>
        
        <div>
          <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-bottom: 6px;">
            <span style="display: flex; align-items: center; gap: 4px;">
              <span class="material-symbols-rounded" style="font-size: 14px;">hard_drive</span>
              ${dev.storageInfo.text}
            </span>
          </div>
          <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;">
            <div style="width: ${dev.storageInfo.percent}%; height: 100%; background: #4caf50; border-radius: 3px;"></div>
          </div>
        </div>
      </div>
    `;
  }

  if (dev.storageInfo) {
    return `
      <div style="background: rgba(0,0,0,0.25); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; display: flex; flex-direction: column; gap: 6px;">
        <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted);">
          <span class="material-symbols-rounded" style="font-size: 16px;">sd_storage</span>
          <span>${dev.storageInfo.text}</span>
        </div>
        <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;">
          <div style="width: ${dev.storageInfo.percent}%; height: 100%; background: #4caf50; border-radius: 3px;"></div>
        </div>
      </div>
    `;
  }

  return '';
}

function handleCardAction(action, devId) {
  const dev = devicesData.find(d => d.id === devId);
  if (!dev) return;

  if (action === 'explore') {
    if (typeof window.openMtpExplorer === 'function') { window.openMtpExplorer(devId); }
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

  panel.innerHTML = `
    <!-- Topo do Inspector -->
    <div style="padding: 16px 20px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <h2 style="font-size: 16px; font-weight: 700; color: #ffffff; margin: 0;">${dev.title}</h2>
        <span style="background: rgba(76, 175, 80, 0.15); color: #4caf50; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 12px;">${dev.badgeStatus}</span>
      </div>
      <button id="btnCloseInspector" style="background: transparent; border: none; color: var(--muted); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 4px;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='var(--muted)'">
        <span class="material-symbols-rounded" style="font-size: 18px;">close</span>
      </button>
    </div>

    <!-- Imagem em Destaque -->
    <div style="padding: 20px; display: flex; justify-content: center; background: rgba(0,0,0,0.2); border-bottom: 1px solid var(--line);">
      <img src="${dev.image}" alt="${dev.title}" style="max-width: 100%; height: 160px; object-fit: contain; border-radius: 8px;" />
    </div>

    <!-- Abas Internas -->
    <div style="display: flex; border-bottom: 1px solid var(--line); padding: 0 10px; background: rgba(0,0,0,0.1);">
      ${['geral', 'armazenamento', 'informações', 'configurações'].map(tabKey => {
        const labels = {
          geral: 'Geral',
          armazenamento: 'Armazenamento',
          informações: 'Informações',
          configurações: 'Configurações'
        };
        const icons = {
          geral: 'tune',
          armazenamento: 'hard_drive',
          informações: 'info',
          configurações: 'settings'
        };
        const isActive = activeInspectorTab === tabKey;
        const activeStyle = isActive ? 'color: #f25c05; border-bottom: 2px solid #f25c05;' : 'color: var(--muted); border-bottom: 2px solid transparent;';

        return `
          <button class="insp-tab-btn" data-tab="${tabKey}" style="flex: 1; padding: 12px 4px; background: transparent; border: none; ${activeStyle} font-size: 12px; font-weight: 600; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; transition: all 0.2s;">
            <span class="material-symbols-rounded" style="font-size: 16px;">${icons[tabKey]}</span>
            <span>${labels[tabKey]}</span>
          </button>
        `;
      }).join('')}
    </div>

    <!-- Conteúdo da Aba Ativa -->
    <div style="padding: 20px; flex: 1; overflow-y: auto;">
      ${renderInspectorTabContent(dev)}
    </div>

    <!-- Botões de Ação Inferiores -->
    <div style="padding: 16px 20px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 10px; background: rgba(0,0,0,0.15);">
      <button id="btnSyncTime" style="width: 100%; height: 38px; background: var(--card-2); color: #ffffff; border: 1px solid var(--line); border-radius: 6px; font-weight: 600; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='var(--card-2)'">
        <span class="material-symbols-rounded" style="font-size: 16px;">schedule</span>
        Sincronizar Hora
      </button>

      <button id="btnDisconnect" style="width: 100%; height: 38px; background: rgba(229, 57, 53, 0.15); color: #e53935; border: 1px solid rgba(229, 57, 53, 0.3); border-radius: 6px; font-weight: 600; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: background 0.2s;" onmouseover="this.style.background='rgba(229, 57, 53, 0.25)'" onmouseout="this.style.background='rgba(229, 57, 53, 0.15)'">
        <span class="material-symbols-rounded" style="font-size: 16px;">power_settings_new</span>
        Desconectar
      </button>
    </div>
  `;

  // Eventos das Abas do Inspector
  const tabBtns = panel.querySelectorAll('.insp-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      activeInspectorTab = btn.getAttribute('data-tab');
      renderInspector();
    });
  });

  // Eventos dos Botões do Inspector
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
      <div style="display: flex; flex-direction: column; gap: 14px;">
        ${items.map(it => `
          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 13px;">
            <div style="display: flex; align-items: center; gap: 10px; color: var(--muted);">
              <span class="material-symbols-rounded" style="font-size: 18px; color: var(--muted);">${it.icon}</span>
              <span>${it.label}</span>
            </div>
            <div style="font-weight: 600; color: #ffffff; text-align: right;">${it.val}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  if (activeInspectorTab === 'armazenamento') {
    return `
      <div style="display: flex; flex-direction: column; gap: 16px;">
        <div style="background: rgba(0,0,0,0.2); padding: 14px; border-radius: 8px; border: 1px solid var(--line);">
          <div style="font-size: 12px; color: var(--muted); margin-bottom: 6px;">Espaço Utilizado</div>
          <div style="font-size: 18px; font-weight: 700; color: #fff;">${dev.storage.used} / ${dev.storage.total}</div>
          <div style="width: 100%; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; margin-top: 8px; overflow: hidden;">
            <div style="width: ${dev.storage.percent}%; height: 100%; background: #4caf50;"></div>
          </div>
        </div>

        <div style="font-size: 13px; color: var(--muted); display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; justify-content: space-between;"><span>Espaço Livre:</span> <strong style="color: #fff;">${dev.storage.free}</strong></div>
          <div style="display: flex; justify-content: space-between;"><span>Sistema de Arquivos:</span> <strong style="color: #fff;">exFAT / NTFS</strong></div>
          <div style="display: flex; justify-content: space-between;"><span>Total de Mídias:</span> <strong style="color: #fff;">142 arquivos</strong></div>
        </div>
      </div>
    `;
  }

  if (activeInspectorTab === 'informações') {
    return `
      <div style="display: flex; flex-direction: column; gap: 12px; font-size: 13px;">
        <div style="display: flex; justify-content: space-between;"><span style="color: var(--muted);">Firmware:</span> <strong style="color: #fff;">v3.20</strong></div>
        <div style="display: flex; justify-content: space-between;"><span style="color: var(--muted);">Número de Série:</span> <strong style="color: #fff;">S01-9948210-B</strong></div>
        <div style="display: flex; justify-content: space-between;"><span style="color: var(--muted);">Última Sincronização:</span> <strong style="color: #fff;">Hoje às 14:32</strong></div>
        <div style="display: flex; justify-content: space-between;"><span style="color: var(--muted);">Origem de Ingestão:</span> <strong style="color: #fff;">BDSM_DEVICE</strong></div>
      </div>
    `;
  }

  if (activeInspectorTab === 'configurações') {
    return `
      <div style="display: flex; flex-direction: column; gap: 14px; font-size: 13px;">
        <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
          <span style="color: var(--muted);">Sincronização Automática</span>
          <input type="checkbox" checked style="accent-color: #f25c05; width: 16px; height: 16px;" />
        </label>
        <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
          <span style="color: var(--muted);">Ejetar ao Concluir Importação</span>
          <input type="checkbox" style="accent-color: #f25c05; width: 16px; height: 16px;" />
        </label>
        <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
          <span style="color: var(--muted);">Manter Cópia de Segurança</span>
          <input type="checkbox" checked style="accent-color: #f25c05; width: 16px; height: 16px;" />
        </label>
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

window.openMtpExplorer = async function(deviceId) {
  const device = devicesData.find(d => d.id === deviceId);
  if (!device) return;

  explorerDevId = device.id;
  mtpCurrentDevice = device.title;
  mtpCurrentPath = [];
  mtpSelectedItems.clear();

  document.getElementById('mtpExplorerModal').style.display = 'flex';
  
  if (device.type === 'mtp') {
    // Tenta abrir direto em "Storage Media" se existir
    try {
      const rootItems = await window.bds.listMtpFolder(mtpCurrentDevice, []);
      if (rootItems && rootItems.some(i => i.Name === 'Storage Media')) {
        mtpCurrentPath = ['Storage Media'];
      }
    } catch(e) {}
  }

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
    const dev = devicesData.find(d => d.id === explorerDevId);
      const isUsb = dev && dev.type === 'usb';
      const target = isUsb ? (dev.rawDevice.storage[0].path) : mtpCurrentDevice;
      
      let items;
      if (isUsb) {
        const usbResult = await window.bds.listUsbFolder(target, mtpCurrentPath);
        items = (usbResult && usbResult.success) ? usbResult.items.map(i => ({ Name: i.name, IsFolder: i.isFolder, ObjectSize: i.size })) : [];
      } else {
        items = await window.bds.listMtpFolder(target, mtpCurrentPath);
      }
    loading.style.display = 'none';

    if (!items || items.length === 0) {
      list.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--muted); padding: 40px;">Pasta vazia ou indisponível.</div>`;
      return;
    }

    // Ignore specific folders and files
    items = items.filter(i => {
      const n = i.Name.toUpperCase();
      return n !== 'INFO' && n !== 'FOR_WIN.URL';
    });

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



// Attach event listener inside grid generation to "Explorar" button
document.addEventListener('click', async (e) => {
  // MTP Import Button
  const mtpImportBtn = e.target.closest('#btnMtpImport');
  if (mtpImportBtn && !mtpImportBtn.hasAttribute('disabled')) {
    const eventName = await window.bdsModal.prompt('Digite o nome do Evento ou Pasta (ex: Casamento_Joao):');
    if (!eventName) return;

    const itemsToImport = Array.from(mtpSelectedItems);
    if (itemsToImport.length === 0) return;

    // Pegar configuracoes para saber o deviceFolder
    const settings = await window.bds.getSettings();
    const baseDest = settings.deviceFolder || 'C:/Users/Public/Videos/BDSM DEVICES'; // Fallback
    const finalDest = baseDest + '\\' + mtpCurrentDevice + '\\' + eventName;

    mtpImportBtn.setAttribute('disabled', 'true');
    mtpImportBtn.innerHTML = `<span class="material-symbols-rounded" style="animation: spin 1s linear infinite;">sync</span> Importando...`;

    const progressContainer = document.getElementById('mtpProgressContainer');
    const actionContainer = document.getElementById('mtpImportActionContainer');
    const pText = document.getElementById('mtpProgressText');
    const pPercent = document.getElementById('mtpProgressPercent');
    const pBar = document.getElementById('mtpProgressBar');
    const pEta = document.getElementById('mtpProgressEta');
    
    actionContainer.style.display = 'none';
    progressContainer.style.display = 'flex';
    
    let startTime = Date.now();
    let totalItems = itemsToImport.length;
    let completedItems = 0;
    
    const unsubProgress = window.bds.onMtpProgress((data) => {
      // Calculate overall progress based on items
      let filePercent = data.percent || 0;
      let overallPercent = ((completedItems * 100) + filePercent) / totalItems;
      
      pText.textContent = `Copiando: ${data.file}`;
      pPercent.textContent = `${Math.round(overallPercent)}%`;
      pBar.style.width = `${overallPercent}%`;
      
      if (filePercent >= 100) {
        completedItems++;
      }
      
      // Calculate ETA
      let elapsed = (Date.now() - startTime) / 1000;
      if (overallPercent > 0) {
        let totalEstimated = elapsed / (overallPercent / 100);
        let remaining = totalEstimated - elapsed;
        if (remaining > 0) {
          let mins = Math.floor(remaining / 60);
          let secs = Math.floor(remaining % 60);
          pEta.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else {
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
      
      actionContainer.style.display = 'flex';
      progressContainer.style.display = 'none';

      if (success) {
        window.bdsModal.alert('Importação Concluída');
        mtpSelectedItems.clear();
        loadMtpFolder();
      } else {
        window.bdsModal.alert('Houve um erro durante a importação.');
      }
    } catch(err) {
      unsubProgress();
      actionContainer.style.display = 'flex';
      progressContainer.style.display = 'none';
      window.bdsModal.alert('Erro ao importar itens.');
    }

    mtpImportBtn.innerHTML = `<span class="material-symbols-rounded" style="font-size: 18px;">download</span> Importar Selecionados`;
    updateMtpImportButton();
    return;
  }

  const exploreBtn = e.target.closest('button[data-action="explore"]');
  if (exploreBtn) {
    const devId = exploreBtn.getAttribute('data-devid');
    const dev = devicesData.find(d => d.id === devId);
    if (dev) { window.openMtpExplorer(devId); }
  }
});


