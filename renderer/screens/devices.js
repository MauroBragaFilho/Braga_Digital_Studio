import { escapeHtml, escapeAttr } from '../utils/escape.js';
import { enhanceModals } from '../utils/modal.js';
import { friendlyError } from '../utils/friendlyError.js';
import { bdsmErrorInfo, pairingStateMessage } from '../utils/bdsmError.js';
import { setAppStatus } from '../app.js';

/** Mensagem legível de um erro vindo do IPC (remove o prefixo "Error invoking remote method"). */
const errMsg = (err) => friendlyError(err, 'Algo deu errado ao falar com o dispositivo. Tente de novo.');

/* ==========================================================================
   TELA DE DISPOSITIVOS
   - Modelo normalizado de dispositivo (USB/cartão, celular BDS Mobile, câmera Sony, MTP).
   - Estados de carregando, erro e vazio; atualização sem redesenhar tudo.
   - Painel de detalhes só com dados reais do dispositivo.
   - Explorador de arquivos (USB/MTP) e importação (USB, MTP, BDS Mobile, Sony).
   ========================================================================== */

const GB = 1024 ** 3;
const DEFAULT_IMPORT_ROOT = 'C:/Users/Public/Videos/BDSM DEVICES';
const FOCUS_REFRESH_MIN_MS = 5000; // ao voltar o foco à janela, procura de novo (cartão novo não gera evento)

const KINDS = {
  usb: { label: 'Cartão / unidade USB', icon: 'sd_card', tone: 'usb' },
  bdsm: { label: 'Celular (BDS Mobile)', icon: 'smartphone', tone: 'bdsm' },
  sony: { label: 'Câmera Sony (Wi-Fi)', icon: 'photo_camera', tone: 'sony' },
  mtp: { label: 'Dispositivo portátil', icon: 'devices', tone: 'mtp' }
};

const state = {
  devices: [],        // dispositivos visíveis (normalizados)
  rawAll: [],         // lista bruta do último scan (inclui ocultos): { title, type, raw }
  hidden: [],         // nomes ocultos (settings.hiddenDevices)
  selectedId: null,
  tab: 'geral',
  loading: false,
  error: null,
  updatedAt: null,
  deviceFolder: ''    // settings.deviceFolder
};

let cleanups = [];
let staticBound = false;
let refreshSeq = 0;
let refreshTimer = null;
let lastFocusRefresh = 0;
let bdsmDevice = null;      // dispositivo do modal de importação do celular
let bdsmItems = [];

/* ---------- utilidades ---------- */

const $ = (id) => document.getElementById(id);
const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= GB) return `${(v / GB).toFixed(1)} GB`;
  if (v >= 1048576) return `${Math.round(v / 1048576)} MB`;
  return `${Math.max(1, Math.round(v / 1024))} KB`;
}

/** Nome seguro para virar parte de um caminho de pasta (sem caracteres inválidos no Windows). */
function safeSegment(text, fallback = 'Dispositivo') {
  const clean = String(text || '').replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '').trim();
  return clean || fallback;
}

function buildStorage(totalBytes, freeBytes) {
  const total = num(totalBytes);
  const free = num(freeBytes);
  if (!total || total <= 0 || free == null) return null;
  const used = Math.max(0, total - free);
  return { total, free, used, percent: Math.min(100, Math.round((used / total) * 100)) };
}

function storageLevel(percent) {
  return percent > 90 ? 'critical' : (percent > 75 ? 'warning' : '');
}

function getDeviceImage(kind, name) {
  const n = String(name || '').toLowerCase();
  if (kind === 'usb') return './assets/devices/sd_card.jpg';
  if (kind === 'bdsm') return './assets/devices/galaxy_phone.jpg';
  if (kind === 'sony') return './assets/devices/sony_camera.jpg';
  if (/camera|câmera|canon|lumix|eos|nikon|sony|gopro/.test(n)) return './assets/devices/sony_camera.jpg';
  if (/server|servidor|ftp/.test(n)) return './assets/devices/ftp_server.jpg';
  return './assets/devices/galaxy_phone.jpg';
}

function mtpKindLabel(type) {
  const t = String(type || '').toLowerCase();
  if (/cam/.test(t)) return 'Câmera (USB)';
  if (/phone|telefone|celular/.test(t)) return 'Celular (USB)';
  return KINDS.mtp.label;
}

/* ---------- modelo de dispositivo ---------- */

/** Converte o objeto bruto do backend no modelo usado pela tela. Só entram dados que o dispositivo realmente informou. */
function normalizeDevice(raw, index) {
  const type = String(raw.type || raw.Type || 'unknown').toLowerCase();
  const name = raw.name || raw.Name || 'Dispositivo sem nome';
  const base = { title: name, rawDevice: raw, status: 'Conectado' };

  if (type === 'usb') {
    const st = raw.storage && raw.storage[0];
    return {
      ...base, id: `usb_${String(raw.id).replace(/[^a-zA-Z0-9]/g, '')}`, kind: 'usb', kindLabel: KINDS.usb.label,
      connection: 'Conectado via USB', image: getDeviceImage('usb', name),
      storage: st ? buildStorage(st.capacity, st.free) : null,
      details: [
        ['Tipo', 'Cartão / unidade USB', 'sd_card'],
        ['Unidade', raw.id, 'hard_drive'],
        ['Nome do volume', name, 'label'],
        ['Conexão', 'USB (disco removível)', 'usb']
      ],
      actions: [
        { id: 'explore', label: 'Explorar arquivos', icon: 'folder_open', primary: true },
        { id: 'open-os', label: 'Abrir no Windows', icon: 'open_in_new' }
      ]
    };
  }

  if (type === 'bdsm') {
    const viaUsb = raw.connection === 'usb' || raw.ip === '127.0.0.1';
    const battery = num(raw.battery);
    // 'needed' = o celular exige pareamento e este computador ainda não foi aprovado; 'paired' = aprovado
    const pairing = raw.paired ? 'paired' : (raw.authRequired ? 'needed' : null);
    return {
      ...base, id: `bdsm_${raw.id}`, kind: 'bdsm', kindLabel: KINDS.bdsm.label, pairing,
      status: pairing === 'needed' ? 'Pareamento necessário' : (pairing === 'paired' ? 'Pareado' : base.status),
      connection: viaUsb ? 'Conectado por cabo USB' : `Conectado via Wi-Fi (${raw.ip})`,
      image: getDeviceImage('bdsm', name), ip: viaUsb ? 'USB (127.0.0.1)' : raw.ip, battery,
      storage: buildStorage(raw.storage_total, raw.storage_free),
      details: [
        ['Tipo', 'Celular com BDS Mobile', 'smartphone'],
        ['Modelo', raw.model || name, 'memory'],
        ['Conexão', viaUsb ? 'Cabo USB' : `Wi-Fi (${raw.ip})`, 'wifi'],
        ['Bateria', battery != null ? `${battery}%` : null, 'battery_full'],
        ['Aplicativo', raw.app_version ? `BDS Mobile v${raw.app_version}` : 'BDS Mobile', 'apps'],
        ['Pareamento', pairing === 'paired' ? 'Este computador está pareado' : (pairing === 'needed' ? 'Necessário: confirme o código no celular' : null), pairing === 'paired' ? 'verified_user' : 'lock']
      ],
      actions: [
        { id: 'bdsm-import', label: 'Importar mídia', icon: 'download', primary: true },
        { id: 'bdsm-luts', label: 'Sincronizar LUTs', icon: 'palette' }
      ],
      // só no painel de detalhes (mantém o cartão com poucos botões)
      inspectorActions: pairing === 'paired'
        ? [{ id: 'bdsm-forget', label: 'Esquecer este celular', icon: 'link_off' }]
        : (pairing === 'needed' ? [{ id: 'bdsm-pair', label: 'Parear este celular', icon: 'link' }] : [])
    };
  }

  if (type === 'sony') {
    const ip = raw.ip || '192.168.122.1';
    const battery = num(raw.battery);
    return {
      ...base, id: `sony_${String(raw.id || 'cam').replace(/[^a-zA-Z0-9]/g, '')}`, kind: 'sony', kindLabel: KINDS.sony.label,
      connection: `Conectado via Wi-Fi Direct (${ip})`, image: getDeviceImage('sony', name), ip, battery,
      storage: null,
      details: [
        ['Tipo', 'Câmera Sony', 'photo_camera'],
        ['Modelo', raw.model || name, 'memory'],
        ['Conexão', `Wi-Fi Direct (${ip})`, 'wifi'],
        ['Bateria', battery != null ? `${battery}%` : null, 'battery_full']
      ],
      actions: [{ id: 'sony-import', label: 'Importar mídia', icon: 'download', primary: true }]
    };
  }

  const st = raw.Storages && raw.Storages[0];
  const battery = num(raw.BatteryLevel);
  return {
    ...base, id: `mtp_${index}`, kind: 'mtp', kindLabel: mtpKindLabel(raw.Type),
    connection: 'Conectado por cabo USB', image: getDeviceImage('mtp', `${raw.Type || ''} ${name}`), battery,
    storage: st ? buildStorage(st.TotalSize, st.FreeSpace) : null,
    details: [
      ['Tipo', raw.Type || KINDS.mtp.label, 'devices'],
      ['Fabricante', raw.Manufacturer, 'domain'],
      ['Modelo', name, 'memory'],
      ['Conexão', 'Cabo USB (dispositivo portátil)', 'usb'],
      ['Bateria', battery != null ? `${battery}%` : null, 'battery_full']
    ],
    actions: [{ id: 'explore', label: 'Explorar arquivos', icon: 'folder_open', primary: true }]
  };
}

function applyDevices(rawList) {
  state.rawAll = rawList.map((raw) => ({
    title: raw.name || raw.Name || 'Dispositivo sem nome',
    type: String(raw.type || raw.Type || 'unknown').toLowerCase(),
    raw
  }));
  state.devices = [];
  rawList.forEach((raw, index) => {
    const name = raw.name || raw.Name || 'Dispositivo sem nome';
    if (state.hidden.includes(name)) return;
    try { state.devices.push(normalizeDevice(raw, index)); } catch (e) { console.error('[DEVICES] Dispositivo ignorado (dados inválidos):', e); }
  });
  if (state.selectedId && !state.devices.some((d) => d.id === state.selectedId)) state.selectedId = null;
}

const currentDevice = () => state.devices.find((d) => d.id === state.selectedId) || null;
const deviceById = (id) => state.devices.find((d) => d.id === id) || null;

/* ---------- ciclo de vida ---------- */

export async function initScreen(forceRescan = false) {
  bindStatic();
  bindLive();
  enhanceModals($('devicesView') || document, '.devices-modal-overlay');
  await loadSettings();
  await refresh({ force: forceRescan });
}

export function onEnter() {
  bindLive();
  loadSettings().then(() => refresh({ silent: true }));
}

export function onLeave() {
  if (pair.dev) cancelPairingDialog();
  cleanups.forEach((fn) => { try { fn(); } catch (_) { /* noop */ } });
  cleanups = [];
  clearTimeout(refreshTimer);
}

/** Esc fecha o painel de detalhes (se nenhum modal estiver aberto). */
export function onKeyDown(e) {
  if (e.key !== 'Escape') return;
  const panel = $('deviceInspector');
  if (!panel || panel.classList.contains('hidden')) return;
  if (document.querySelector('.devices-modal-overlay.active:not(.hidden)')) return;
  selectDevice(null);
}

async function loadSettings() {
  try {
    const s = (await window.bds?.getSettings?.()) || {};
    state.hidden = Array.isArray(s.hiddenDevices) ? [...s.hiddenDevices] : [];
    state.deviceFolder = s.deviceFolder || '';
  } catch (_) { /* mantém o que já tinha */ }
}

/** Listeners que dependem de document/window/IPC: só existem enquanto a tela está ativa. */
function bindLive() {
  if (cleanups.length) return;
  ['onBdsmDeviceAdded', 'onBdsmDeviceRemoved', 'onBdsmDeviceUpdated'].forEach((evt) => {
    if (typeof window.bds?.[evt] !== 'function') return;
    const unsub = window.bds[evt](() => scheduleRefresh());
    if (typeof unsub === 'function') cleanups.push(unsub);
  });
  const onFocus = () => {
    if (Date.now() - lastFocusRefresh < FOCUS_REFRESH_MIN_MS) return;
    lastFocusRefresh = Date.now();
    scheduleRefresh(200);
  };
  window.addEventListener('focus', onFocus);
  cleanups.push(() => window.removeEventListener('focus', onFocus));
  document.addEventListener('error', onImageError, true);
  cleanups.push(() => document.removeEventListener('error', onImageError, true));
}

/** Imagem que não carregou: troca por um ícone (o evento 'error' não borbulha, por isso o listener é de captura). */
function onImageError(e) {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  const wrap = img.closest('.dev-card-image-wrap, .inspector-image');
  if (!wrap || wrap.dataset.fallback) return;
  wrap.dataset.fallback = '1';
  img.remove();
  wrap.classList.add('no-image');
  wrap.insertAdjacentHTML('beforeend', `<span class="material-symbols-rounded" aria-hidden="true">${escapeHtml(wrap.dataset.icon || 'devices')}</span>`);
}

/** Vários eventos seguidos (celular reconectando) viram uma única busca. */
function scheduleRefresh(delay = 700) {
  if (!cleanups.length) return; // tela inativa (listeners já removidos): ignora eventos atrasados
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh({ silent: true }), delay);
}

async function refresh({ force = false, silent = false } = {}) {
  const seq = ++refreshSeq;
  if (!window.bds?.getAllDevices) return;
  if (!silent || !state.devices.length) { state.loading = true; renderAll(); }
  state.error = null;
  try {
    const list = await window.bds.getAllDevices(force);
    if (seq !== refreshSeq) return; // chegou uma resposta mais nova
    applyDevices(Array.isArray(list) ? list : []);
    state.updatedAt = new Date();
  } catch (e) {
    if (seq !== refreshSeq) return;
    console.error('[DEVICES] Falha ao procurar dispositivos:', e);
    state.error = errMsg(e) || 'Falha ao procurar dispositivos.';
  } finally {
    if (seq === refreshSeq) { state.loading = false; renderAll(); }
  }
}

/* ---------- renderização ---------- */

function renderAll() {
  renderControlBar();
  renderGrid();
  renderInspector();
}

function renderControlBar() {
  const count = $('devicesCount');
  if (count) count.textContent = state.devices.length;
  const btnRefresh = $('btnRefreshDevices');
  if (btnRefresh) btnRefresh.classList.toggle('spinning', state.loading);
  const updated = $('devicesUpdated');
  if (updated) {
    updated.textContent = state.loading ? 'Procurando…'
      : (state.updatedAt ? `Atualizado às ${state.updatedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : '');
  }
  const manage = $('btnManageHiddenDevices');
  if (manage) {
    manage.classList.toggle('hidden', !(state.hidden.length > 0 || state.devices.length > 0));
    const c = $('hiddenDevicesCount');
    if (c) c.textContent = state.hidden.length;
  }
}

function skeletonHtml() {
  return [1, 2].map(() => `
    <div class="device-card dev-skeleton" aria-hidden="true">
      <div class="dev-card-top"><div class="dev-skel-img"></div><div class="dev-skel-lines"><i></i><i></i><i></i></div></div>
      <div class="dev-skel-bar"></div><div class="dev-skel-btn"></div>
    </div>`).join('');
}

function emptyHtml() {
  const allHidden = state.rawAll.length > 0 && state.devices.length === 0;
  if (allHidden) {
    return `
      <div class="devices-empty">
        <span class="material-symbols-rounded devices-empty-icon" aria-hidden="true">visibility_off</span>
        <h3>Todos os dispositivos estão ocultos</h3>
        <p>${state.rawAll.length} dispositivo(s) conectado(s), mas ignorado(s) na lista.</p>
        <button class="devices-btn-secondary" data-action="manage-hidden" type="button">Gerenciar ocultos</button>
      </div>`;
  }
  return `
    <div class="devices-empty">
      <span class="material-symbols-rounded devices-empty-icon" aria-hidden="true">usb_off</span>
      <h3>Nenhum dispositivo conectado</h3>
      <p>Conecte algo para importar mídia:</p>
      <ul>
        <li><span class="material-symbols-rounded" aria-hidden="true">sd_card</span>Cartão de memória ou pen drive no computador</li>
        <li><span class="material-symbols-rounded" aria-hidden="true">usb</span>Câmera ou celular por cabo USB</li>
        <li><span class="material-symbols-rounded" aria-hidden="true">smartphone</span>Celular com o app BDS Mobile na mesma rede Wi-Fi</li>
        <li><span class="material-symbols-rounded" aria-hidden="true">photo_camera</span>Câmera Sony com o Wi-Fi ligado</li>
      </ul>
      <button class="devices-btn-secondary" data-action="rescan" type="button">
        <span class="material-symbols-rounded" aria-hidden="true">refresh</span>Procurar novamente
      </button>
    </div>`;
}

function errorHtml() {
  return `
    <div class="devices-error" role="alert">
      <span class="material-symbols-rounded" aria-hidden="true">error</span>
      <div><strong>Não foi possível procurar os dispositivos.</strong><span>${escapeHtml(state.error)}</span></div>
      <button class="devices-btn-secondary" data-action="rescan" type="button">Tentar novamente</button>
    </div>`;
}

function renderGrid() {
  const grid = $('devicesGrid');
  if (!grid) return;
  grid.setAttribute('aria-busy', state.loading ? 'true' : 'false');

  if (state.loading && !state.devices.length) { grid.innerHTML = skeletonHtml(); return; }
  if (state.error && !state.devices.length) { grid.innerHTML = errorHtml(); return; }
  if (!state.devices.length) { grid.innerHTML = emptyHtml(); return; }

  grid.innerHTML = (state.error ? errorHtml() : '') + state.devices.map(cardHtml).join('');
}

function cardMiddleHtml(dev) {
  const parts = [];
  if (dev.ip) {
    parts.push(`
      <div class="dev-card-middle dev-card-middle-wifi">
        <div class="wifi-info"><span class="material-symbols-rounded" aria-hidden="true">wifi</span><span>${escapeHtml(dev.ip)}</span></div>
        ${dev.battery != null ? `<div class="battery-info"><span class="material-symbols-rounded" aria-hidden="true">battery_full</span><span>${dev.battery}%</span></div>` : ''}
      </div>`);
  } else if (dev.battery != null) {
    parts.push(`
      <div class="dev-card-middle dev-card-middle-wifi">
        <div class="wifi-info"><span class="material-symbols-rounded" aria-hidden="true">usb</span><span>USB</span></div>
        <div class="battery-info"><span class="material-symbols-rounded" aria-hidden="true">battery_full</span><span>${dev.battery}%</span></div>
      </div>`);
  }
  if (dev.storage) {
    const st = dev.storage;
    parts.push(`
      <div class="dev-card-middle dev-card-middle-storage">
        <div class="dev-card-storage-label">
          <span class="material-symbols-rounded" aria-hidden="true">sd_storage</span>
          <span>${formatBytes(st.used)} usados de ${formatBytes(st.total)}</span>
          <span class="dev-card-storage-free">${formatBytes(st.free)} livres</span>
        </div>
        <div class="dev-card-storage-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${st.percent}" aria-label="Espaço usado">
          <div class="dev-card-storage-fill ${storageLevel(st.percent)}" style="width: ${st.percent}%;"></div>
        </div>
      </div>`);
  }
  return parts.join('');
}

function cardHtml(dev) {
  const selected = dev.id === state.selectedId;
  const kind = KINDS[dev.kind] || KINDS.mtp;
  return `
    <article class="device-card${selected ? ' selected' : ''}" data-id="${escapeAttr(dev.id)}" tabindex="0" role="button"
             aria-pressed="${selected}" aria-label="${escapeAttr(`${dev.title}, ${dev.kindLabel}. ${dev.status}`)}">
      <button class="dev-card-hide-btn" data-action="hide" data-devid="${escapeAttr(dev.id)}" title="Ocultar dispositivo" aria-label="Ocultar ${escapeAttr(dev.title)}" type="button">
        <span class="material-symbols-rounded" aria-hidden="true">visibility_off</span>
      </button>
      <div class="dev-card-top">
        <div class="dev-card-image-wrap" data-icon="${escapeAttr(kind.icon)}">
          <img src="${escapeAttr(dev.image)}" alt="" />
        </div>
        <div class="dev-card-info">
          <h3 class="dev-card-title" title="${escapeAttr(dev.title)}">${escapeHtml(dev.title)}</h3>
          <div class="dev-card-category tone-${kind.tone}">${escapeHtml(dev.kindLabel)}</div>
          <div class="dev-card-status"><span class="dev-card-status-dot online"></span><span>${escapeHtml(dev.connection)}</span></div>
          ${dev.pairing ? `<div class="dev-card-pair ${dev.pairing}"><span class="material-symbols-rounded" aria-hidden="true">${dev.pairing === 'paired' ? 'verified_user' : 'lock'}</span>${dev.pairing === 'paired' ? 'Pareado' : 'Pareamento necessário'}</div>` : ''}
        </div>
      </div>
      ${cardMiddleHtml(dev)}
      <div class="dev-card-actions">
        ${dev.actions.map((a) => `
          <button class="dev-card-btn${a.primary ? ' primary' : ''}" data-action="${escapeAttr(a.id)}" data-devid="${escapeAttr(dev.id)}" type="button">${escapeHtml(a.label)}</button>`).join('')}
      </div>
    </article>`;
}

/** Seleciona/deseleciona um cartão sem redesenhar a grade. */
function selectDevice(id) {
  state.selectedId = id;
  document.querySelectorAll('#devicesGrid .device-card[data-id]').forEach((card) => {
    const on = card.dataset.id === id;
    card.classList.toggle('selected', on);
    card.setAttribute('aria-pressed', String(on));
  });
  renderInspector();
}

/* ---------- painel de detalhes ---------- */

const INSPECTOR_TABS = [
  { key: 'geral', label: 'Geral', icon: 'tune' },
  { key: 'armazenamento', label: 'Armazenamento', icon: 'hard_drive' }
];

function inspectorContent(dev) {
  if (state.tab === 'armazenamento') {
    const st = dev.storage;
    if (!st) {
      return dev.pairing === 'needed'
        ? '<p class="inspector-note">Pareie o celular para ver bateria e espaço de armazenamento.</p>'
        : '<p class="inspector-note">Este dispositivo não informou o espaço de armazenamento.</p>';
    }
    return `
      <div>
        <div class="inspector-storage-card">
          <div class="inspector-storage-label">Espaço utilizado</div>
          <div class="inspector-storage-value">${formatBytes(st.used)} / ${formatBytes(st.total)} (${st.percent}%)</div>
          <div class="inspector-storage-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${st.percent}">
            <div class="inspector-storage-fill ${storageLevel(st.percent)}" style="width: ${st.percent}%;"></div>
          </div>
        </div>
        <div class="inspector-storage-details">
          <div class="row"><span>Espaço livre:</span> <strong>${formatBytes(st.free)}</strong></div>
          <div class="row"><span>Capacidade total:</span> <strong>${formatBytes(st.total)}</strong></div>
        </div>
      </div>`;
  }
  const rows = dev.details.filter(([, value]) => value != null && value !== '');
  return `
    <div class="inspector-details-list">
      ${rows.map(([label, value, icon]) => `
        <div class="inspector-detail-row">
          <div class="inspector-detail-label"><span class="material-symbols-rounded" aria-hidden="true">${icon}</span><span>${escapeHtml(label)}</span></div>
          <div class="inspector-detail-value" title="${escapeAttr(value)}">${escapeHtml(value)}</div>
        </div>`).join('')}
    </div>`;
}

function renderInspector() {
  const panel = $('deviceInspector');
  if (!panel) return;
  const dev = currentDevice();
  if (!dev) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  panel.classList.remove('hidden');

  panel.innerHTML = `
    <div class="inspector-header">
      <div class="inspector-header-left">
        <h2 class="inspector-header-title" title="${escapeAttr(dev.title)}">${escapeHtml(dev.title)}</h2>
        <span class="inspector-badge">${escapeHtml(dev.status)}</span>
      </div>
      <button class="inspector-close-btn" data-inspector="close" aria-label="Fechar detalhes" type="button">
        <span class="material-symbols-rounded" aria-hidden="true">close</span>
      </button>
    </div>
    <div class="inspector-image" data-icon="${escapeAttr((KINDS[dev.kind] || KINDS.mtp).icon)}"><img src="${escapeAttr(dev.image)}" alt="" /></div>
    <div class="inspector-tabs" role="tablist">
      ${INSPECTOR_TABS.map((t) => `
        <button class="inspector-tab-btn${state.tab === t.key ? ' active' : ''}" role="tab" aria-selected="${state.tab === t.key}" data-tab="${t.key}" type="button">
          <span class="material-symbols-rounded" aria-hidden="true">${t.icon}</span><span>${t.label}</span>
        </button>`).join('')}
    </div>
    <div class="inspector-content" role="tabpanel">${inspectorContent(dev)}</div>
    <div class="inspector-footer">
      ${dev.actions.map((a) => `
        <button class="inspector-footer-btn${a.primary ? ' primary' : ' secondary'}" data-action="${escapeAttr(a.id)}" data-devid="${escapeAttr(dev.id)}" type="button">
          <span class="material-symbols-rounded" aria-hidden="true">${a.icon}</span>${escapeHtml(a.label)}
        </button>`).join('')}
      ${(dev.inspectorActions || []).map((a) => `
        <button class="inspector-footer-btn secondary" data-action="${escapeAttr(a.id)}" data-devid="${escapeAttr(dev.id)}" type="button">
          <span class="material-symbols-rounded" aria-hidden="true">${a.icon}</span>${escapeHtml(a.label)}
        </button>`).join('')}
      <button class="inspector-footer-btn secondary" data-action="hide" data-devid="${escapeAttr(dev.id)}" type="button">
        <span class="material-symbols-rounded" aria-hidden="true">visibility_off</span>Ocultar dispositivo
      </button>
    </div>`;
}

/* ---------- eventos fixos (delegação) ---------- */

function bindStatic() {
  if (staticBound) return;
  staticBound = true;

  const grid = $('devicesGrid');
  grid?.addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      e.stopPropagation();
      handleAction(actionBtn.dataset.action, actionBtn.dataset.devid);
      return;
    }
    const card = e.target.closest('.device-card[data-id]');
    if (card) selectDevice(card.dataset.id === state.selectedId ? null : card.dataset.id);
  });
  grid?.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || e.target.closest('button')) return;
    const card = e.target.closest('.device-card[data-id]');
    if (!card) return;
    e.preventDefault();
    selectDevice(card.dataset.id === state.selectedId ? null : card.dataset.id);
  });
  $('deviceInspector')?.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { state.tab = tab.dataset.tab; renderInspector(); return; }
    if (e.target.closest('[data-inspector="close"]')) { selectDevice(null); return; }
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) handleAction(actionBtn.dataset.action, actionBtn.dataset.devid);
  });

  $('btnRefreshDevices')?.addEventListener('click', () => refresh({ force: true }));
  $('btnManageHiddenDevices')?.addEventListener('click', openManageHidden);
  $('btnMtpClose')?.addEventListener('click', closeExplorer);
  $('btnBdsmClose')?.addEventListener('click', closeBdsmImport);
  $('btnManageHiddenClose')?.addEventListener('click', closeManageHidden);
  $('btnManageHiddenDone')?.addEventListener('click', closeManageHidden);
  $('manageHiddenDevicesModal')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.manage-hidden-toggle-btn');
    if (btn) toggleHidden(btn.dataset.deviceTitle);
  });

  // Explorador
  $('mtpFilterInput')?.addEventListener('input', (e) => { ex.filter = e.target.value.trim().toLowerCase(); renderExplorerList(); });
  $('btnMtpSelectAll')?.addEventListener('click', () => {
    visibleItems().filter((i) => !i.isFolder).forEach((i) => ex.selected.add(i.key));
    renderExplorerList();
  });
  $('btnMtpClearSel')?.addEventListener('click', () => { ex.selected.clear(); renderExplorerList(); });
  $('btnMtpImport')?.addEventListener('click', onExplorerImport);
  $('mtpExplorerBreadcrumb')?.addEventListener('click', (e) => {
    const link = e.target.closest('.bc-link');
    if (link) explorerNavigateTo(Number(link.dataset.index));
  });
  bindExplorerList($('mtpExplorerList'));
  $('btnBdsmImportAction')?.addEventListener('click', onBdsmImportClick);
  // Diálogo de pareamento (Esc e o X também cancelam)
  $('btnBdsmPairClose')?.addEventListener('click', cancelPairingDialog);
  $('btnBdsmPairCancel')?.addEventListener('click', cancelPairingDialog);
  $('btnBdsmPairRetry')?.addEventListener('click', startPairingDialog);
}

function handleAction(action, devId) {
  switch (action) {
    case 'rescan': refresh({ force: true }); return;
    case 'manage-hidden': openManageHidden(); return;
    default: break;
  }
  const dev = deviceById(devId);
  if (!dev) return;
  switch (action) {
    case 'hide': toggleHidden(dev.title); break;
    case 'explore': openExplorer(dev); break;
    case 'open-os': openInWindows(dev); break;
    case 'bdsm-import': openBdsmImport(dev); break;
    case 'bdsm-luts': syncBdsmLuts(dev); break;
    case 'bdsm-pair': pairDevice(dev).then((ok) => { if (ok) refresh({ silent: true }); }); break;
    case 'bdsm-forget': forgetBdsm(dev); break;
    case 'sony-import': openSonyImport(dev); break;
    default: break;
  }
}

async function openInWindows(dev) {
  const target = dev.rawDevice?.storage?.[0]?.path;
  if (!target || !window.bds?.openLocalPath) return;
  const res = await window.bds.openLocalPath(target);
  if (res && res.success === false) window.bdsModal.alert(`Não foi possível abrir a unidade: ${friendlyError(res.error, 'motivo desconhecido')}`);
}

/* ---------- ocultar / gerenciar ---------- */

async function persistHidden() {
  // Salva SÓ esta preferência (antes enviava as configurações inteiras, com valores possivelmente desatualizados).
  if (window.bds?.saveSettings) await window.bds.saveSettings({ hiddenDevices: [...state.hidden] });
}

async function toggleHidden(title) {
  const idx = state.hidden.indexOf(title);
  if (idx > -1) state.hidden.splice(idx, 1); else state.hidden.push(title);
  try { await persistHidden(); } catch (e) { console.error('[DEVICES] Falha ao salvar dispositivos ocultos:', e); }
  applyDevices(state.rawAll.map((d) => d.raw)); // reaproveita a última busca, sem varrer de novo
  renderAll();
  if ($('manageHiddenDevicesModal')?.classList.contains('active')) renderManageHidden();
}

function openManageHidden() {
  const modal = $('manageHiddenDevicesModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('active');
  renderManageHidden();
}

function closeManageHidden() {
  const modal = $('manageHiddenDevicesModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('active');
}

function manageItem(title, ignored) {
  return `
    <div class="manage-hidden-item${ignored ? ' ignored' : ''}">
      <span class="manage-hidden-item-name">${escapeHtml(title)}</span>
      <button class="manage-hidden-toggle-btn ${ignored ? 'restore' : 'hide'}" data-device-title="${escapeAttr(title)}"
              title="${ignored ? 'Mostrar de novo' : 'Ocultar'}" aria-label="${ignored ? 'Mostrar' : 'Ocultar'} ${escapeAttr(title)}" type="button">
        <span class="material-symbols-rounded" aria-hidden="true">${ignored ? 'visibility' : 'visibility_off'}</span>
      </button>
    </div>`;
}

function renderManageHidden() {
  const available = $('manageHiddenAvailableList');
  const ignored = $('manageHiddenIgnoredList');
  if (!available || !ignored) return;
  const connected = state.rawAll.filter((d) => !state.hidden.includes(d.title));
  available.innerHTML = connected.length
    ? connected.map((d) => manageItem(d.title, false)).join('')
    : '<div class="empty-state">Nenhum dispositivo disponível.</div>';
  ignored.innerHTML = state.hidden.length
    ? state.hidden.map((t) => manageItem(t, true)).join('')
    : '<div class="empty-state">Nenhum dispositivo ignorado.</div>';
}

/* ==========================================================================
   EXPLORADOR (USB / MTP em pastas; Sony em lista única)
   ========================================================================== */

const ex = {
  dev: null,
  mode: 'fs',        // 'fs' (pastas) | 'flat' (lista única, Sony)
  path: [],
  items: [],         // { key, name, isFolder, size, raw }
  selected: new Set(),
  filter: '',
  seq: 0,
  importing: false
};

const FILE_ICONS = [
  [/\.(mp4|mov|mkv|avi|mts|m2ts|mxf|webm)$/i, 'movie'],
  [/\.(jpg|jpeg|png|heic|arw|cr2|cr3|nef|dng|raf|rw2|orf|tif|tiff|gif)$/i, 'image'],
  [/\.(wav|mp3|aac|flac|m4a|ogg)$/i, 'audio_file']
];
const fileIcon = (name) => (FILE_ICONS.find(([re]) => re.test(name)) || [null, 'draft'])[1];

function importRoot() {
  return (state.deviceFolder || DEFAULT_IMPORT_ROOT).replace(/[\\/]+$/, '');
}

function showModal(id) {
  const m = $(id);
  if (m) { m.classList.remove('hidden'); m.classList.add('active'); }
}
function hideModal(id) {
  const m = $(id);
  if (m) { m.classList.add('hidden'); m.classList.remove('active'); }
}

function openExplorer(dev) {
  Object.assign(ex, { dev, mode: 'fs', path: [], items: [], filter: '', importing: false });
  ex.selected.clear();
  const filterInput = $('mtpFilterInput');
  if (filterInput) filterInput.value = '';
  setExplorerHeader(dev, dev.title);
  showModal('mtpExplorerModal');

  if (dev.kind === 'mtp') {
    // Câmeras MTP costumam ter a pasta "Storage Media" na raiz: já entra nela.
    window.bds.listMtpFolder(dev.title, []).then((root) => {
      if (Array.isArray(root) && root.some((i) => i.Name === 'Storage Media')) ex.path = ['Storage Media'];
    }).catch(() => {}).finally(loadExplorerFolder);
  } else {
    loadExplorerFolder();
  }
}

async function openSonyImport(dev) {
  Object.assign(ex, { dev, mode: 'flat', path: [], items: [], filter: '', importing: false });
  ex.selected.clear();
  const filterInput = $('mtpFilterInput');
  if (filterInput) filterInput.value = '';
  setExplorerHeader(dev, dev.title);
  showModal('mtpExplorerModal');
  loadExplorerFolder();
}

function setExplorerHeader(dev, crumbRoot) {
  const icon = $('mtpExplorerIcon');
  if (icon) icon.textContent = (KINDS[dev.kind] || KINDS.mtp).icon;
  const title = $('mtpExplorerTitle');
  if (title) title.textContent = ex.mode === 'flat' ? 'Importar da câmera' : 'Explorador de dispositivo';
  const dest = $('mtpDestHint');
  if (dest) dest.textContent = `Destino: ${importRoot()}/${safeSegment(dev.title)}/<evento>`;
  const bc = $('mtpExplorerBreadcrumb');
  if (bc) bc.innerHTML = `<span class="bc-current">${escapeHtml(crumbRoot)}</span>`;
}

function renderBreadcrumb() {
  const bc = $('mtpExplorerBreadcrumb');
  if (!bc || !ex.dev) return;
  if (ex.mode === 'flat') { bc.innerHTML = `<span class="bc-current">${escapeHtml(ex.dev.title)}</span>`; return; }
  let html = `<button class="bc-link" data-index="-1" type="button">${escapeHtml(ex.dev.title)}</button>`;
  ex.path.forEach((p, idx) => {
    const current = idx === ex.path.length - 1;
    html += '<span class="material-symbols-rounded" aria-hidden="true">chevron_right</span>';
    html += current
      ? `<span class="bc-current" aria-current="page">${escapeHtml(p)}</span>`
      : `<button class="bc-link" data-index="${idx}" type="button">${escapeHtml(p)}</button>`;
  });
  bc.innerHTML = html;
}

function closeExplorer() {
  hideModal('mtpExplorerModal');
  ex.dev = null; ex.path = []; ex.items = []; ex.selected.clear();
  ex.seq++; // descarta respostas que ainda estejam a caminho
}

function explorerNavigateTo(index) {
  ex.path = index < 0 ? [] : ex.path.slice(0, index + 1);
  loadExplorerFolder();
}

function explorerOpenFolder(name) {
  ex.path = [...ex.path, name];
  loadExplorerFolder();
}

function setExplorerLoading(on) {
  const loading = $('mtpExplorerLoading');
  if (loading) loading.classList.toggle('hidden', !on);
}

async function loadExplorerFolder() {
  const dev = ex.dev;
  if (!dev) return;
  const seq = ++ex.seq;
  ex.selected.clear(); // a seleção vale só para a pasta atual (antes ela "vazava" para a pasta seguinte)
  ex.items = [];
  const filterInput = $('mtpFilterInput');
  if (filterInput) { filterInput.value = ''; ex.filter = ''; }
  setExplorerLoading(true);
  renderBreadcrumb();
  const list = $('mtpExplorerList');
  list.className = 'mtp-items-grid';
  list.innerHTML = '';
  updateExplorerFooter();
  try {
    let items;
    if (ex.mode === 'flat') {
      const res = await window.bds.sonyList(dev.rawDevice.id, {});
      items = (Array.isArray(res) ? res : []).map((it) => ({
        key: String(it.id || it.uri || it.filename), name: it.filename || it.title || 'arquivo', isFolder: false, size: num(it.size) || 0, raw: it
      }));
    } else if (dev.kind === 'usb') {
      const res = await window.bds.listUsbFolder(dev.rawDevice.storage[0].path, ex.path);
      items = res && res.success ? res.items.map((i) => ({ key: i.name, name: i.name, isFolder: !!i.isFolder, size: num(i.size) || 0 })) : [];
    } else {
      const res = await window.bds.listMtpFolder(dev.title, ex.path);
      items = (Array.isArray(res) ? res : []).map((i) => ({ key: i.Name, name: i.Name, isFolder: !!i.IsFolder, size: num(i.ObjectSize) || 0 }));
    }
    if (seq !== ex.seq) return;
    ex.items = items
      .filter((i) => !/^(info|for_win\.url)$/i.test(i.name))
      .sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name, 'pt-BR', { numeric: true }) : (a.isFolder ? -1 : 1)));
    list.className = 'mtp-items-grid';
  } catch (e) {
    if (seq !== ex.seq) return;
    console.error('[DEVICES] Erro ao listar pasta:', e);
    ex.items = [];
    list.className = 'mtp-items-grid error-state';
    list.textContent = 'Não foi possível ler esta pasta. Verifique se o dispositivo continua conectado.';
    setExplorerLoading(false);
    updateExplorerFooter();
    return;
  }
  setExplorerLoading(false);
  renderExplorerList();
}

const visibleItems = () => (ex.filter ? ex.items.filter((i) => i.name.toLowerCase().includes(ex.filter)) : ex.items);

function renderExplorerList() {
  const list = $('mtpExplorerList');
  if (!list) return;
  if (list.classList.contains('error-state') && !ex.items.length) { updateExplorerFooter(); return; }
  const items = visibleItems();
  list.className = items.length ? 'mtp-items-grid' : 'mtp-items-grid empty-state';
  if (!items.length) {
    const loading = !$('mtpExplorerLoading')?.classList.contains('hidden');
    list.textContent = loading ? '' : (ex.items.length ? 'Nenhum arquivo com esse nome.' : 'Pasta vazia.');
    updateExplorerFooter();
    return;
  }
  list.innerHTML = items.map((item) => {
    const sel = ex.selected.has(item.key);
    const icon = item.isFolder ? 'folder' : fileIcon(item.name);
    return `
      <div class="mtp-item${sel ? ' selected' : ''}" role="option" aria-selected="${sel}" tabindex="0" data-key="${escapeAttr(item.key)}" data-folder="${item.isFolder ? '1' : '0'}">
        <input type="checkbox" class="checkbox" tabindex="-1" aria-hidden="true" ${sel ? 'checked' : ''} />
        <span class="material-symbols-rounded item-icon ${item.isFolder ? 'folder' : 'file'}" aria-hidden="true">${icon}</span>
        <span class="item-name" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</span>
        <span class="item-meta">${item.isFolder ? 'Pasta' : formatBytes(item.size)}</span>
      </div>`;
  }).join('');
  updateExplorerFooter();
}

function toggleExplorerItem(key) {
  if (ex.selected.has(key)) ex.selected.delete(key); else ex.selected.add(key);
  const el = [...document.querySelectorAll('#mtpExplorerList .mtp-item')].find((n) => n.dataset.key === key);
  if (el) {
    const on = ex.selected.has(key);
    el.classList.toggle('selected', on);
    el.setAttribute('aria-selected', String(on));
    const cb = el.querySelector('.checkbox');
    if (cb) cb.checked = on;
  }
  updateExplorerFooter();
}

function bindExplorerList(list) {
  if (!list || list.dataset.delegated) return;
  list.dataset.delegated = '1';
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.mtp-item');
    if (row && list.contains(row)) toggleExplorerItem(row.dataset.key);
  });
  list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.mtp-item');
    if (!row || row.dataset.folder !== '1') return;
    explorerOpenFolder(row.dataset.key);
  });
  list.addEventListener('keydown', (e) => {
    const row = e.target.closest('.mtp-item');
    if (!row) return;
    if (e.key === ' ') { e.preventDefault(); toggleExplorerItem(row.dataset.key); }
    else if (e.key === 'Enter' && row.dataset.folder === '1') { e.preventDefault(); explorerOpenFolder(row.dataset.key); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
      if (next && next.classList.contains('mtp-item')) next.focus();
    }
  });
}

function updateExplorerFooter() {
  const count = $('mtpExplorerSelectedCount');
  const size = $('mtpExplorerSelectedSize');
  const btn = $('btnMtpImport');
  const n = ex.selected.size;
  if (count) count.textContent = n;
  if (size) {
    const total = ex.items.filter((i) => ex.selected.has(i.key)).reduce((a, i) => a + (i.isFolder ? 0 : i.size), 0);
    size.textContent = total > 0 ? ` • ${formatBytes(total)}` : '';
  }
  if (btn && !ex.importing) btn.disabled = n === 0;
  const clear = $('btnMtpClearSel');
  if (clear) clear.disabled = n === 0;
}

function formatEta(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatSpeed(bps) {
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`;
  return `${bps} B/s`;
}

async function onExplorerImport() {
  const btn = $('btnMtpImport');
  const dev = ex.dev;
  if (!dev || ex.importing || ex.selected.size === 0) return;

  const eventName = await window.bdsModal.prompt('Digite o nome do evento ou pasta (ex.: Casamento_Joao):');
  if (!eventName || !eventName.trim()) return;
  const keys = [...ex.selected];
  const finalDest = `${importRoot()}/${safeSegment(dev.title)}/${safeSegment(eventName, 'Importacao')}`;

  ex.importing = true;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-rounded dev-spin" aria-hidden="true">sync</span> Importando...';
  }
  const progressBox = $('mtpProgressContainer');
  const actions = $('mtpImportActionContainer');
  const els = { text: $('mtpProgressText'), percent: $('mtpProgressPercent'), bar: $('mtpProgressBar'), eta: $('mtpProgressEta'), speed: $('mtpProgressSpeed') };
  if (actions) actions.style.display = 'none';
  if (progressBox) { progressBox.classList.remove('hidden'); progressBox.style.display = 'flex'; }
  if (els.bar) els.bar.style.width = '0%';

  const startedAt = Date.now();
  const total = keys.length;
  let completed = 0;
  const showProgress = (overall, label, speedBps, etaSeconds) => {
    if (els.text) els.text.textContent = label;
    if (els.percent) els.percent.textContent = `${Math.round(overall)}%`;
    if (els.bar) els.bar.style.width = `${overall}%`;
    if (els.speed && speedBps != null) els.speed.textContent = formatSpeed(speedBps);
    if (els.eta) els.eta.textContent = etaSeconds > 0 ? formatEta(etaSeconds) : 'Quase lá...';
  };

  let unsub = () => {};
  const finish = () => {
    try { unsub(); } catch (_) { /* noop */ }
    ex.importing = false;
    if (actions) actions.style.display = 'flex';
    if (progressBox) { progressBox.classList.add('hidden'); progressBox.style.display = 'none'; }
    if (btn) btn.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">download</span> Importar selecionados';
    updateExplorerFooter();
  };

  try {
    let ok;
    if (ex.mode === 'flat') {
      unsub = window.bds.onSonyImportProgress?.((data) => {
        const done = Number(data.completed ?? data.index ?? completed);
        const overall = total ? Math.min(100, ((done + (Number(data.percent) || 0) / 100) / total) * 100) : 0;
        showProgress(overall, `Copiando: ${data.currentItem || data.file || ''}`, null, 0);
      }) || (() => {});
      const items = keys.map((k) => ex.items.find((i) => i.key === k)?.raw).filter(Boolean);
      const result = await window.bds.sonyImportItems(dev.rawDevice.id, items, finalDest);
      const failed = (result && result.failed) ? result.failed.length : 0;
      ok = (result && Array.isArray(result.imported) ? result.imported.length : 0) > 0 || failed === 0;
      if (failed) window.bdsModal.alert(`${failed} arquivo(s) não puderam ser importados.`);
    } else {
      unsub = window.bds.onMtpProgress((data) => {
        const filePercent = data.percent || 0;
        const overall = ((completed * 100) + filePercent) / total;
        if (filePercent >= 100) completed++;
        let eta = 0;
        if (data.speedBps > 0 && data.totalSize > 0 && data.currentSize < data.totalSize) {
          eta = ((data.totalSize - data.currentSize) + ((total - completed - 1) * data.totalSize)) / data.speedBps;
        } else if (overall > 0) {
          const elapsed = (Date.now() - startedAt) / 1000;
          eta = elapsed / (overall / 100) - elapsed;
        }
        showProgress(overall, `Copiando: ${data.file}`, data.speedBps != null ? data.speedBps : null, eta);
      });
      ok = dev.kind === 'usb'
        ? await window.bds.importUsbItems(dev.rawDevice.storage[0].path, ex.path, keys, finalDest)
        : await window.bds.importMtpItems(dev.title, ex.path, keys, finalDest);
    }
    finish();
    if (ok) {
      ex.selected.clear();
      renderExplorerList();
      const open = await window.bdsModal.confirm(`Importação concluída.\n\nDestino: ${finalDest}\n\nAbrir a pasta agora?`);
      if (open && window.bds.openLocalPath) window.bds.openLocalPath(finalDest.replace(/\//g, '\\'));
    } else {
      window.bdsModal.alert('Houve um erro durante a importação. Confira se o dispositivo continua conectado e se há espaço no destino.');
    }
  } catch (err) {
    console.error('[DEVICES] Falha na importação:', err);
    finish();
    window.bdsModal.alert(`Erro ao importar: ${errMsg(err)}`);
  }
}

/* ==========================================================================
   CELULAR (BDS MOBILE): pareamento, importação e sincronização de LUTs
   O celular só entrega gravações e LUTs a um computador PAREADO: o operador confere um código de 4 dígitos e
   aprova no próprio celular. O acesso (token) fica guardado só no processo principal; aqui só chegam estado e código.
   ========================================================================== */

const PAIR_TOTAL_SECONDS = 90;
const pair = { dev: null, resolve: null, unsub: null, tick: null, expiresAt: 0, phase: 'idle', code: '', seq: 0 };

const needsPairing = (dev) => dev.pairing === 'needed';

/**
 * Executa `run`; se o celular pedir pareamento (antes ou no meio da ação), abre o diálogo "Conectar ao celular" e,
 * aprovado, repete a ação sozinho. Devolve undefined se o usuário cancelou o pareamento.
 */
async function withPairing(dev, run) {
  if (needsPairing(dev) && !(await pairDevice(dev))) return undefined;
  try {
    return await run();
  } catch (e) {
    if (bdsmErrorInfo(e).code !== 'PAIRING_REQUIRED') throw e;
    if (!(await pairDevice(dev))) return undefined;
    return run();
  }
}

/* ---------- diálogo de pareamento ---------- */

/** Abre o diálogo "Conectar ao celular". Resolve true quando o celular aprova (ou já estava pareado). */
export function pairDevice(dev) {
  if (!dev || dev.kind !== 'bdsm') return Promise.resolve(false);
  if (pair.dev) cancelPairingDialog();
  return new Promise((resolve) => {
    pair.dev = dev;
    pair.resolve = resolve;
    pair.phase = 'loading';
    pair.code = '';
    pair.unsub = (typeof window.bds?.onBdsmPairing === 'function' && window.bds.onBdsmPairing(onPairingEvent)) || null;
    const name = $('bdsmPairDevice');
    if (name) name.textContent = dev.title;
    showModal('bdsmPairModal');
    startPairingDialog();
  });
}

function pairMatches(p) {
  const raw = pair.dev && pair.dev.rawDevice;
  return !!(raw && p && String(p.ip) === String(raw.ip) && Number(p.port || 8080) === Number(raw.port || 8080));
}

function setHidden(id, hidden) {
  const el = $(id);
  if (el) el.classList.toggle('hidden', hidden);
}

function renderPair(phase, data = {}) {
  pair.phase = phase;
  setHidden('bdsmPairWait', phase !== 'loading');
  setHidden('bdsmPairCodeBox', phase !== 'code');
  setHidden('bdsmPairResult', phase !== 'result');
  setHidden('btnBdsmPairRetry', phase !== 'result');
  const cancel = $('btnBdsmPairCancel');
  if (cancel) cancel.textContent = phase === 'result' ? 'Fechar' : 'Cancelar';

  if (phase === 'code') {
    pair.code = String(data.code || '');
    const box = $('bdsmPairCode');
    if (box) {
      box.innerHTML = [...pair.code].map((d) => `<span class="bdsm-pair-digit" aria-hidden="true">${escapeHtml(d)}</span>`).join('');
      box.setAttribute('aria-label', `Código de pareamento: ${[...pair.code].join(' ')}`);
    }
    startPairCountdown(Number.isFinite(Number(data.seconds)) ? Number(data.seconds) : PAIR_TOTAL_SECONDS);
  } else {
    clearInterval(pair.tick);
    pair.tick = null;
  }
  if (phase === 'result') {
    const res = $('bdsmPairResult');
    if (res) {
      res.innerHTML = `
        <span class="material-symbols-rounded bds-empty-icon" aria-hidden="true">${escapeHtml(data.icon || 'link_off')}</span>
        <strong class="bds-empty-title">${escapeHtml(data.title || 'Não foi possível parear')}</strong>
        <span class="bds-empty-text">${escapeHtml(data.text || '')}</span>`;
    }
  }
}

function startPairCountdown(seconds) {
  clearInterval(pair.tick);
  pair.expiresAt = Date.now() + Math.max(0, seconds) * 1000;
  updatePairTimer();
  pair.tick = setInterval(updatePairTimer, 500);
}

function updatePairTimer() {
  const left = Math.max(0, Math.ceil((pair.expiresAt - Date.now()) / 1000));
  const text = $('bdsmPairTimer');
  if (text) text.textContent = left > 0 ? `Expira em ${left} s` : 'Finalizando…';
  const bar = $('bdsmPairBar');
  if (bar) bar.style.width = `${Math.min(100, (left / PAIR_TOTAL_SECONDS) * 100)}%`;
}

async function startPairingDialog() {
  const dev = pair.dev;
  if (!dev) return;
  const seq = ++pair.seq;
  renderPair('loading');
  try {
    const res = await window.bds.startBdsmPairing(dev.rawDevice.ip, dev.rawDevice.port);
    if (seq !== pair.seq || !pair.dev) return;
    if (res && res.alreadyPaired) { finishPairing(true); return; }
    if (pair.phase !== 'code') renderPair('code', { code: res && res.code, seconds: res && res.secondsLeft });
  } catch (e) {
    if (seq !== pair.seq || !pair.dev) return;
    const info = bdsmErrorInfo(e);
    const busy = info.code === 'DEVICE_BUSY';
    renderPair('result', {
      icon: busy ? 'hourglass_top' : 'wifi_off',
      title: busy ? 'O celular está ocupado' : 'Não foi possível conectar',
      text: info.message
    });
  }
}

/** Andamento enviado pelo processo principal ('bdsm:pairing'). */
function onPairingEvent(p) {
  if (!pair.dev || !pairMatches(p)) return;
  switch (p.state) {
    case 'PENDING':
      if (pair.phase !== 'code' || p.code !== pair.code) renderPair('code', { code: p.code, seconds: p.secondsLeft });
      else if (Number.isFinite(Number(p.secondsLeft))) { pair.expiresAt = Date.now() + Number(p.secondsLeft) * 1000; updatePairTimer(); }
      break;
    case 'APPROVED':
      finishPairing(true);
      break;
    case 'DENIED':
      renderPair('result', { icon: 'block', title: 'Pareamento recusado', text: pairingStateMessage('DENIED') });
      break;
    case 'EXPIRED':
      renderPair('result', { icon: 'timer_off', title: 'Tempo esgotado', text: pairingStateMessage('EXPIRED') });
      break;
    case 'ERROR':
      renderPair('result', { icon: 'wifi_off', title: 'Não foi possível parear', text: pairingStateMessage('ERROR', p.message) });
      break;
    default: break; // CANCELED: já tratado em cancelPairingDialog
  }
}

function finishPairing(ok) {
  clearInterval(pair.tick);
  try { if (typeof pair.unsub === 'function') pair.unsub(); } catch (_) { /* noop */ }
  const resolve = pair.resolve;
  Object.assign(pair, { dev: null, resolve: null, unsub: null, tick: null, phase: 'idle', code: '' });
  pair.seq++;
  hideModal('bdsmPairModal');
  if (ok) {
    window.bdsToast?.('Celular pareado. Agora você pode importar mídia e sincronizar LUTs.', { type: 'success' });
    refresh({ silent: true });
  }
  if (resolve) resolve(ok);
}

/** Cancelar / Fechar / Esc: para de acompanhar o pedido e devolve false a quem estava esperando. */
function cancelPairingDialog() {
  const dev = pair.dev;
  if (!dev) return;
  try { Promise.resolve(window.bds?.cancelBdsmPairing?.(dev.rawDevice.ip, dev.rawDevice.port)).catch(() => {}); } catch (_) { /* noop */ }
  finishPairing(false);
}

async function forgetBdsm(dev) {
  if (!dev || dev.kind !== 'bdsm') return;
  const ok = await window.bdsModal.confirm('Esquecer este celular?\n\nNa próxima vez será preciso parear de novo e aprovar no celular.');
  if (!ok) return;
  try {
    await window.bds.forgetBdsmPairing(dev.rawDevice.ip, dev.rawDevice.port);
    window.bdsToast?.('Pareamento removido deste computador.', { type: 'success' });
    await refresh({ silent: true });
  } catch (e) {
    console.error('[DEVICES] Falha ao esquecer o pareamento:', e);
    window.bdsModal.alert(`Não foi possível esquecer o pareamento: ${bdsmErrorInfo(e).message}`);
  }
}

/* ---------- importação de mídia ---------- */

async function openBdsmImport(dev) {
  if (!dev || dev.kind !== 'bdsm') return;
  try {
    await withPairing(dev, () => loadBdsmImport(dev));
  } catch (e) {
    console.error('[DEVICES] Erro ao listar mídias do celular:', e);
    window.bdsModal.alert(`Não foi possível ler as mídias do celular: ${bdsmErrorInfo(e).message}`);
  }
}

/** Abre o modal e carrega a lista; em erro fecha o modal e relança (quem chamou decide: parear ou avisar). */
async function loadBdsmImport(dev) {
  bdsmDevice = dev;
  bdsmItems = [];
  showModal('bdsmImportModal');
  const loading = $('bdsmLoading');
  const content = $('bdsmContent');
  if (loading) loading.style.display = 'block';
  if (content) { content.classList.add('hidden'); content.style.display = 'none'; }
  const btn = $('btnBdsmImportAction');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">download</span> Importar novos'; }

  try {
    const raw = (await window.bds.getBdsmMedia(dev.rawDevice.ip, dev.rawDevice.port)) || [];
    const history = new Set((await window.bds.getBdsmImportHistory(dev.rawDevice.id)) || []);
    if (bdsmDevice !== dev) return; // o usuário fechou ou abriu outro
    bdsmItems = raw.map((m) => ({ ...m, alreadyImported: history.has(m.name) }));
    renderBdsmList();
    if (loading) loading.style.display = 'none';
    if (content) { content.classList.remove('hidden'); content.style.display = 'flex'; }
  } catch (e) {
    if (loading) loading.style.display = 'none';
    closeBdsmImport();
    throw e;
  }
}

function renderBdsmList() {
  const fresh = bdsmItems.filter((m) => !m.alreadyImported);
  const imported = bdsmItems.length - fresh.length;
  const totalSize = fresh.reduce((a, m) => a + (num(m.size) || 0), 0);
  const stats = $('bdsmStats');
  if (stats) {
    stats.textContent = `${bdsmItems.length} vídeo(s) encontrado(s): ${fresh.length} novo(s)${totalSize ? ` (${formatBytes(totalSize)})` : ''}, ${imported} já importado(s).`;
  }
  const list = $('bdsmMediaList');
  if (list) {
    list.innerHTML = bdsmItems.length ? bdsmItems.map((m) => `
      <div class="mtp-item ${m.alreadyImported ? 'imported-item' : 'bdsm-new'}">
        <span class="material-symbols-rounded item-icon ${m.alreadyImported ? 'ok' : ''}" aria-hidden="true">${m.alreadyImported ? 'check_circle' : 'movie'}</span>
        <span class="item-name" title="${escapeAttr(m.name)}">${escapeHtml(m.name)}</span>
        <span class="item-meta">${m.alreadyImported ? 'Já importado' : formatBytes(num(m.size))}</span>
      </div>`).join('') : '<div class="empty-state">Nenhum vídeo no celular.</div>';
  }
  const btn = $('btnBdsmImportAction');
  if (btn) {
    btn.disabled = fresh.length === 0;
    btn.innerHTML = `<span class="material-symbols-rounded" aria-hidden="true">download</span> ${fresh.length ? `Importar ${fresh.length} novo(s)` : 'Nada novo para importar'}`;
  }
}

function closeBdsmImport() {
  hideModal('bdsmImportModal');
  bdsmDevice = null;
  bdsmItems = [];
}

async function onBdsmImportClick() {
  const dev = bdsmDevice; // sempre o dispositivo do modal aberto agora (antes ficava preso ao primeiro aberto)
  if (!dev) return;
  const items = bdsmItems.filter((m) => !m.alreadyImported);
  if (!items.length) { window.bdsModal.alert('Nenhum vídeo novo para importar.'); return; }
  const target = $('bdsmProjectSelect')?.value;
  const projectId = !target || target === 'lib' ? null : parseInt(target, 10);
  const btn = $('btnBdsmImportAction');
  const stats = $('bdsmStats');

  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-rounded dev-spin" aria-hidden="true">sync</span> Importando...'; }
  const unsub = window.bds.onBdsmProgress?.((data) => {
    if (stats) stats.textContent = `Importando ${data.completed}/${data.total}: ${data.current}`;
  });
  try {
    const imported = await withPairing(dev, () => window.bds.importBdsmMedia({
      ip: dev.rawDevice.ip, port: dev.rawDevice.port, deviceId: dev.rawDevice.id,
      items, destFolder: importRoot(), projectId
    }));
    if (imported === undefined) { renderBdsmList(); return; } // pareamento cancelado
    closeBdsmImport();
    const n = Number(imported);
    window.bdsModal.alert(Number.isFinite(n) && n < items.length
      ? `${n} de ${items.length} vídeo(s) importado(s). Os demais falharam: confira a conexão e o espaço no computador e tente de novo.`
      : 'Importação concluída com sucesso!');
  } catch (e) {
    console.error('[DEVICES] Falha ao importar do celular:', e);
    window.bdsModal.alert(`Não foi possível importar: ${bdsmErrorInfo(e).message}`);
    renderBdsmList();
  } finally {
    if (typeof unsub === 'function') unsub();
  }
}

/* ---------- sincronização de LUTs ---------- */

async function syncBdsmLuts(dev) {
  if (!dev || dev.kind !== 'bdsm') return;
  try {
    await withPairing(dev, () => runBdsmLutSync(dev));
  } catch (e) {
    console.error('[DEVICES] Erro na sincronização de LUTs:', e);
    setAppStatus('Falha ao sincronizar LUTs.', 'error');
    window.bdsModal.alert(`Não foi possível sincronizar as LUTs: ${bdsmErrorInfo(e).message}`);
  }
}

/** O celular só recebe LUTs (não há download): envia as que faltam e deixa conflitos como estão. */
async function runBdsmLutSync(dev) {
  setAppStatus('Calculando diferenças entre as LUTs do computador e do celular...', 'info');
  const plan = await window.bds.analyzeBdsmLutSync(dev.rawDevice.ip, dev.rawDevice.port);
  const up = plan.upload.length;
  const onlyPhone = (plan.remoteOnly || []).length;
  const conflicts = plan.conflict.length;
  if (!up) {
    setAppStatus('LUTs já sincronizadas.', 'success');
    const notes = [];
    if (onlyPhone) notes.push(`O celular tem ${onlyPhone} LUT(s) que não estão no computador (o celular não permite baixá-las).`);
    if (conflicts) notes.push(`${conflicts} LUT(s) têm o mesmo nome, mas conteúdo diferente (nada foi alterado).`);
    window.bdsModal.alert(notes.length ? `Nenhuma LUT nova para enviar.\n\n${notes.join('\n')}` : 'Tudo já está sincronizado!');
    return true;
  }

  const ok = await window.bdsModal.confirm(
    `Plano de sincronização:\n\n- Enviar para o celular: ${up} LUT(s)\n- Só no celular: ${onlyPhone} LUT(s) (continuam lá)\n- Mesmo nome, conteúdo diferente: ${conflicts} (nada será alterado)\n\nDeseja prosseguir?`
  );
  if (!ok) { setAppStatus('Sincronização de LUTs cancelada.', 'info'); return true; }

  const unsub = window.bds.onBdsmLutSyncProgress?.((data) => {
    setAppStatus(`Sincronizando LUTs: ${data.current} (${data.completed}/${data.total})`, 'info');
  });
  let result;
  try {
    result = await window.bds.executeBdsmLutSync({ ip: dev.rawDevice.ip, port: dev.rawDevice.port, plan });
  } finally {
    if (typeof unsub === 'function') unsub();
  }
  const failed = result && Number(result.failed) > 0;
  setAppStatus(failed ? 'LUTs sincronizadas com falhas.' : 'LUTs sincronizadas.', failed ? 'error' : 'success');
  window.bdsModal.alert(failed
    ? `${result.completed} LUT(s) enviada(s); ${result.failed} não puderam ser enviadas. Tente de novo.`
    : 'Sincronização de LUTs concluída com sucesso!');
  return true;
}
