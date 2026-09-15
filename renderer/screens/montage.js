import { setAppStatus, applyTheme, state as appState } from '../app.js';

/* =============================================================
   MONTAGEM DE VÍDEOS — ETAPA 3 (redesign DaVinci Resolve)
   Motor FFmpeg preservado em src/services/montageService.js.
   ============================================================= */

const STORAGE_KEY = 'montageSession.v1';
const ROW_HEIGHT = 52;                 // altura da linha virtual
const OVERSCAN = 5;                    // linhas extras fora da viewport
const FPS_SENTINEL = 'Manter original'; // valor aceito pelo motor FFmpeg
const VIDEO_EXT = new Set(['mp4','mkv','mov','webm','avi','m4v','ts','mts','m2ts','mpg','mpeg','wmv','flv','3gp','ogv']);
const DUR_SUMMARY_PATH = 'Montagem';

/* ----------------------------- Estado global ----------------------------- */
const state = {
  items: [],                 // vídeos principais (ordem de exibição)
  selected: new Set(),       // ids selecionados
  anchorId: null,            // âncora p/ seleção por intervalo (Shift)
  thumbsDir: '',
  sort: 'default',           // 'default' | 'name' | 'duration'
  durMode: 'percent',        // 'percent' | 'fixed' (padrão global)
  globalPct: 100,
  globalFixed: 30,           // segundos
  intro: { name: 'Nenhuma', path: '', duration: 0, width: 0, height: 0, thumbnail: '' },
  outro: { name: 'Nenhuma', path: '', duration: 0, width: 0, height: 0, thumbnail: '' },
  export: { active: false, completed: false, cancelled: false, current: 0, total: 0, percent: 0, jobId: null }
};

let saveTimer = null;
let listenerCleanups = [];
let dragState = { srcId: null };
let dropDepth = 0;

/* ------------------------------ Utilidades ------------------------------- */
function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function uid() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function logScreen(msg, type = 'info') {
  console.log(`[MONTAGE-${type.toUpperCase()}]:`, msg);
  if (type === 'error') {
    const banner = $('montageDebugBanner');
    const output = $('montageLogOutput');
    if (banner) banner.classList.remove('hidden');
    if (output) {
      const time = new Date().toLocaleTimeString('pt-BR');
      output.textContent = `[ERRO] ${time} — ${msg}\n` + output.textContent;
    }
  }
}

function setBottomStatus(text, kind = 'ok') {
  const msg = $('mgStatusMessage');
  const txt = $('mgStatusText');
  const icon = $('mgStatusIcon');
  if (!msg || !txt) return;
  msg.classList.remove('active', 'error', 'ok');
  if (kind === 'active') { msg.classList.add('active'); if (icon) icon.textContent = 'sync'; }
  else if (kind === 'error') { msg.classList.add('error'); if (icon) icon.textContent = 'error'; }
  else { msg.classList.add('ok'); if (icon) icon.textContent = 'check_circle'; }
  txt.textContent = text;

  /* --- Rodapé de progresso: mostra/esconde a track durante exportação --- */
  const track = $('mgExportProgressTrack');
  const pctEl = $('mgExportPercent');
  const fileEl = $('mgExportFileInfo');
  const isExporting = (kind === 'active' && /Renderizando|Exportando/i.test(text));
  if (track) track.classList.toggle('hidden', !isExporting);
  if (pctEl) pctEl.classList.toggle('hidden', !isExporting);
  if (fileEl) fileEl.classList.toggle('hidden', !isExporting);
}

/**
 * Atualiza a barra de progresso visual da exportação (track + percentual + info do arquivo).
 * Chamado pelos handlers IPC de progresso.
 */
function updateExportProgress(percent, fileName, current, total) {
  const fill = $('mgExportProgressFill');
  const pctEl = $('mgExportPercent');
  const fileEl = $('mgExportFileInfo');
  const p = Math.min(100, Math.max(0, Math.round(percent || 0)));
  if (fill) fill.style.width = `${p}%`;
  if (pctEl) { pctEl.textContent = `${p}%`; pctEl.classList.remove('hidden'); }
  if (fileEl) {
    const label = fileName || (current && total ? `${current}/${total}` : '');
    fileEl.textContent = label;
    fileEl.classList.remove('hidden');
  }
  const track = $('mgExportProgressTrack');
  if (track) track.classList.remove('hidden');
}

/* ---------------------------- Formatação de tempo ------------------------- */
function formatHMS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function formatFixedLabel(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function parseFixedLabel(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const parts = t.split(':').map(p => parseFloat(p));
  if (parts.length < 2 || parts.length > 3 || parts.some(p => isNaN(p))) return null;
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

function isVideoPath(p) {
  const ext = String(p || '').split('.').pop().toLowerCase();
  return VIDEO_EXT.has(ext);
}

function fileUrl(p) {
  if (!p) return '';
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') ? 'file:///' + p.replace(/\\/g, '/') : p;
}

function applySortOrder(list, mode) {
  if (mode === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
  if (mode === 'duration') return [...list].sort((a, b) => b.durationSeconds - a.durationSeconds);
  return [...list];
}
/* =====================================================================
   PERSISTÊNCIA DE SESSÃO (localStorage)
   ===================================================================== */
function getSessionData() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
}

function saveSession() {
  clearTimeout(saveTimer);
  const payload = {
    v: 1,
    items: state.items.map(i => ({
      id: i.id, name: i.name, path: i.path, thumbnail: i.thumbnail,
      durationSeconds: i.durationSeconds, width: i.width, height: i.height,
      durMode: i.durMode, pctUsed: i.pctUsed, fixedSeconds: i.fixedSeconds
    })),
    intro: state.intro, outro: state.outro,
    sort: state.sort, durMode: state.durMode,
    globalPct: state.globalPct, globalFixed: state.globalFixed,
    exportUI: { active: state.export.active, completed: state.export.completed, cancelled: state.export.cancelled }
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    logScreen('Falha ao salvar sessão: ' + e.message, 'error');
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveSession(); }, 400);
}

function loadSession() {
  const data = getSessionData();
  if (!data || !Array.isArray(data.items)) return false;
  state.items = data.items
    .filter(i => i && i.path)
    .map(i => ({
      id: i.id || uid(), name: i.name || '', path: i.path,
      thumbnail: i.thumbnail || '', durationSeconds: i.durationSeconds || 0,
      width: i.width || 0, height: i.height || 0,
      durMode: i.durMode === 'fixed' ? 'fixed' : 'percent',
      pctUsed: typeof i.pctUsed === 'number' ? Math.min(100, Math.max(1, i.pctUsed)) : 100,
      fixedSeconds: typeof i.fixedSeconds === 'number' ? Math.max(1, i.fixedSeconds) : 30
    }));
  if (data.intro) state.intro = { name: 'Nenhuma', path: '', duration: 0, width: 0, height: 0, thumbnail: '', ...data.intro };
  if (data.outro) state.outro = { name: 'Nenhuma', path: '', duration: 0, width: 0, height: 0, thumbnail: '', ...data.outro };
  if (data.sort && ['default','name','duration'].includes(data.sort)) state.sort = data.sort;
  if (data.durMode && ['percent','fixed'].includes(data.durMode)) state.durMode = data.durMode;
  if (typeof data.globalPct === 'number') state.globalPct = Math.min(100, Math.max(1, data.globalPct));
  if (typeof data.globalFixed === 'number') state.globalFixed = Math.max(1, data.globalFixed);
  return true;
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}
/* =====================================================================
   RENDERIZAÇÃO VIRTUALIZADA DA LISTA
   ===================================================================== */
function statusMeta(item) {
  const s = item.status || 'pending';
  switch (s) {
    case 'queued':    return { pill: 'queued',    label: 'Na fila' };
    case 'exporting': return { pill: 'exporting', label: item.progress != null ? `${Math.round(item.progress)}%` : 'Renderizando' };
    case 'done':      return { pill: 'done',      label: 'Concluído' };
    case 'error':     return { pill: 'error',     label: 'Erro' };
    case 'cancelled': return { pill: 'cancelled', label: 'Cancelado' };
    default:          return { pill: 'pending',   label: 'Pronto' };
  }
}

function getFinalSeconds(item) {
  const base = item.durationSeconds || 0;
  if (item.durMode === 'fixed') {
    const f = Math.max(1, item.fixedSeconds || 1);
    return base > 0 ? Math.min(f, base) : f;
  }
  return Math.round((base * (item.pctUsed || 100)) / 100);
}

function rowHtml(item, idx) {
  const sel = state.selected.has(item.id);
  const st = statusMeta(item);
  const modeFixed = item.durMode === 'fixed';
  const durText = modeFixed ? formatFixedLabel(item.fixedSeconds) : `${item.pctUsed}%`;
  const finalSec = getFinalSeconds(item);
  const finalTxt = st.pill === 'done' ? '✓ ' + formatHMS(finalSec) : formatHMS(finalSec);
  const thumb = item.thumbnail
    ? `<img class="mg-thumb-img" src="${escapeHtml(item.thumbnail)}" alt="" />`
    : `<span class="material-symbols-rounded mg-thumb-ph">movie</span>`;
  const disabled = state.export.active ? ' disabled' : '';
  const editHtml = modeFixed
    ? `<span class="mg-use-edit"><input class="mg-te-input mg-te-time" data-id="${item.id}" type="text" value="${escapeHtml(durText)}" ${disabled} title="Duração fixa (segundos ou MM:SS)"/><span class="mg-te-type" data-id="${item.id}" data-type="toggle" title="Alternar para % do vídeo">%</span></span>`
    : `<span class="mg-use-edit"><input class="mg-te-input" data-id="${item.id}" type="number" min="1" max="100" step="1" value="${item.pctUsed}" ${disabled} title="% do vídeo original a usar"/><span class="mg-te-suffix">%</span><span class="mg-te-type" data-id="${item.id}" data-type="toggle" title="Alternar para duração fixa">Fixo</span></span>`;

  return `
  <div class="mg-row${sel ? ' selected' : ''} ${st.pill}" data-id="${item.id}" style="top:${idx * ROW_HEIGHT}px; height:${ROW_HEIGHT - 1}px;" draggable="true">
    <span class="mg-row-num">${String(idx + 1).padStart(2, '0')}</span>
    <span class="mg-row-check"><input type="checkbox" data-id="${item.id}" ${sel ? 'checked' : ''} /></span>
    <span class="mg-col-name">
      <span class="mg-thumb">${thumb}</span>
      <span class="mg-name-wrap">
        <span class="mg-file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <span class="mg-file-path">${escapeHtml(item.path)}</span>
      </span>
    </span>
    <span class="mg-col-dur">${formatHMS(item.durationSeconds)}</span>
    <span class="mg-use">${editHtml}</span>
    <span class="mg-final">${finalTxt}</span>
    <span class="mg-pill ${st.pill}">${st.label}</span>
    <span class="mg-row-x"><button type="button" class="mg-x-btn material-symbols-rounded" data-id="${item.id}" data-action="remove" title="Remover" ${disabled}>close</button></span>
  </div>`;
}

function renderEmptyList() {
  const body = $('montageMainBody');
  if (!body) return;
  body.innerHTML = `
    <div class="mg-empty">
      <span class="material-symbols-rounded">video_library</span>
      <span class="mg-empty-title">Nenhum vídeo na lista</span>
      <span class="mg-empty-sub">Use <b>Adicionar</b>, <b>Biblioteca</b> ou <b>Pasta</b> para montar sua sequência,<br/>ou arraste arquivos de vídeo diretamente para cá.</span>
    </div>`;
  body.style.height = 'auto';
}

function renderVirtual(scrollPos) {
  const body = $('montageMainBody');
  const area = $('mgVirtualArea');
  if (!body || !area) return;
  const count = state.items.length;

  if (!count) { renderEmptyList(); return; }

  const viewH = area.clientHeight || 480;
  const scroll = typeof scrollPos === 'number' ? scrollPos : (area.scrollTop || 0);
  const start = Math.max(0, Math.floor(scroll / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(count, Math.ceil((scroll + viewH) / ROW_HEIGHT) + OVERSCAN);
  const sorted = applySortOrder(state.items, state.sort);

  body.style.height = (count * ROW_HEIGHT) + 'px';
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const wrap = document.createElement('div');
    wrap.innerHTML = rowHtml(sorted[i], i);
    frag.appendChild(wrap.firstElementChild);
  }
  body.replaceChildren(frag);
}
/* =====================================================================
   SELEÇÃO MÚLTIPLA
   ===================================================================== */
function refreshSelectionUI() {
  const count = state.selected.size;
  const bar = $('mgSelectionBar');
  if (bar) bar.classList.toggle('hidden', count === 0);
  const c = $('selectedCount');
  if (c) c.textContent = String(count);
  const selectAll = $('btnSelectAll');
  const clearSel = $('btnClearSelection');
  if (selectAll) selectAll.disabled = state.items.length === 0 || count === state.items.length;
  if (clearSel) clearSel.disabled = count === 0;
  const checkAll = $('mgCheckAll');
  if (checkAll) {
    checkAll.checked = count > 0 && count === state.items.length;
    checkAll.indeterminate = count > 0 && count < state.items.length;
  }
}

function toggleSelect(id, force) {
  if (force === true) state.selected.add(id);
  else if (force === false) state.selected.delete(id);
  else if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
}

function selectRange(fromId, toId) {
  const ids = state.items.map(i => i.id);
  const a = ids.indexOf(fromId);
  const b = ids.indexOf(toId);
  if (a < 0 || b < 0) return;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  state.selected = new Set(ids.slice(lo, hi + 1));
}

function selectOnly(id) {
  state.selected = new Set([id]);
}

/* =====================================================================
   CONTADORES / RESUMO / STEPPER
   ===================================================================== */
function refreshCounters() {
  const mainCount = $('mainCount');
  if (mainCount) mainCount.textContent = String(state.items.length);
  const total = $('sumTotalCount');
  if (total) total.textContent = String(state.items.length);
}

function refreshSummary() {
  let totalMain = 0;
  let totalOrig = 0;
  state.items.forEach(i => {
    totalMain += getFinalSeconds(i);
    totalOrig += i.durationSeconds || 0;
  });
  const intro = state.intro.duration || 0;
  const outro = state.outro.duration || 0;
  const set = (id, txt) => { const e = $(id); if (e) e.textContent = txt; };
  set('sumIntroDur', formatHMS(intro));
  set('sumMainDur', formatHMS(totalMain));
  set('sumOutroDur', formatHMS(outro));
  set('sumTotalDur', formatHMS(intro + totalMain + outro));
  const mainTotal = $('mainTotalDuration');
  if (mainTotal) mainTotal.textContent = formatHMS(totalMain);
}

function refreshStepper() {
  const s1 = $('step1Item'); if (s1) s1.classList.toggle('done', !!state.intro.path);
  const s3 = $('step3Item'); if (s3) s3.classList.toggle('done', !!state.outro.path);
  const s2 = $('step2Item'); if (s2) s2.classList.toggle('done', state.items.length > 0);
  const s4 = $('step4Item');
  if (s4) {
    const exporting = state.export.active;
    const completed = state.export.completed;
    s4.classList.toggle('active', exporting);
    s4.classList.toggle('done', completed);
    const sub = $('step4Sub') || $('step4Badge');
    if (sub && exporting) {
      sub.textContent = `Progresso: ${Math.round(state.export.percent)}% (${state.export.current}/${state.export.total})`;
    }
  }
}

function refreshAll() {
  renderVirtual();
  refreshSummary();
  refreshCounters();
  refreshStepper();
  refreshSelectionUI();
}
/* =====================================================================
   CARD DE ABERTURA / FINALIZAÇÃO
   ===================================================================== */
function renderCompanionCard(kind) {
  const v = kind === 'intro' ? state.intro : state.outro;
  const p = kind === 'intro' ? 'intro' : 'outro';
  const set = (suffix, txt) => {
    const e = $(`lbl${p === 'intro' ? 'Intro' : 'Outro'}${suffix}`);
    if (e) e.textContent = txt;
  };
  set('Name', v.path ? v.name : 'Nenhuma');
  set('Duration', formatHMS(v.duration));
  set('Res', v.width && v.height ? `${v.width}×${v.height}` : '-');
  const img = $(`img${p === 'intro' ? 'Intro' : 'Outro'}Thumb`);
  const ph = $(`ph${p === 'intro' ? 'Intro' : 'Outro'}Icon`);
  if (v.thumbnail) {
    if (img) { img.src = v.thumbnail; img.classList.remove('hidden'); }
    if (ph) ph.classList.add('hidden');
  } else {
    if (img) img.classList.add('hidden');
    if (ph) ph.classList.remove('hidden');
  }
}

async function pickCompanion(kind) {
  const allowed = ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'ts', 'mts', 'm2ts'];
  // selectFile retorna string[] (array de caminhos ou [] ao cancelar)
  const paths = await window.bds.selectFile({
    title: 'Selecionar vídeo',
    filters: [{ name: 'Vídeos', extensions: allowed }],
    properties: ['openFile']
  });
  if (!Array.isArray(paths) || !paths.length) return;
  const path = paths[0];
  const name = path.split(/[\\/]/).pop();
  const meta = await getFileMeta(path);
  const obj = { name, path, duration: meta.durationSeconds || 0, width: meta.width || 0, height: meta.height || 0, thumbnail: meta.thumbnail || '' };
  if (kind === 'intro') state.intro = obj; else state.outro = obj;
  renderCompanionCard(kind);
  refreshSummary();
  refreshStepper();
  scheduleSave();
  setBottomStatus(`${kind === 'intro' ? 'Abertura' : 'Finalização'} definida: ${name}`, 'ok');
}

function removeCompanion(kind) {
  const empty = { name: 'Nenhuma', path: '', duration: 0, width: 0, height: 0, thumbnail: '' };
  if (kind === 'intro') state.intro = empty; else state.outro = empty;
  renderCompanionCard(kind);
  refreshSummary();
  refreshStepper();
  scheduleSave();
}

async function getFileMeta(filePath) {
  const result = { durationSeconds: 0, width: 0, height: 0, thumbnail: '' };
  // 1. ffprobe para duration, width, height (montage:probe)
  if (window.bds.probeMontageFile) {
    try {
      const probe = await window.bds.probeMontageFile(filePath);
      if (probe) {
        result.durationSeconds = Number.isFinite(probe.duration) ? probe.duration : 0;
        result.width = probe.width || 0;
        result.height = probe.height || 0;
      }
    } catch (e) {
      logScreen(`probeMontageFile falhou para ${filePath}: ${e.message}`, 'error');
    }
  }
  // 2. Thumbnail extraído via ffmpeg (metadata:extractThumb)
  if (window.bds.extractMetadataThumb) {
    try {
      const tPath = await window.bds.extractMetadataThumb(filePath);
      if (tPath) result.thumbnail = fileUrl(tPath);
    } catch (e) {
      logScreen(`extractMetadataThumb falhou para ${filePath}: ${e.message}`, 'error');
    }
  }
  return result;
}

/* =====================================================================
   ADIÇÃO DE VÍDEOS PRINCIPAIS
   ===================================================================== */
function addVideos(entries) {
  const existing = new Set(state.items.map(i => i.path.toLowerCase()));
  let added = 0;
  (entries || []).forEach(entry => {
    if (!entry || !entry.path) return;
    const key = entry.path.toLowerCase();
    if (existing.has(key)) return;
    existing.add(key);
    state.items.push({
      id: uid(),
      name: entry.name || entry.path.split(/[\\/]/).pop(),
      path: entry.path,
      thumbnail: entry.thumbnail || '',
      durationSeconds: entry.durationSeconds || 0,
      width: entry.width || 0,
      height: entry.height || 0,
      durMode: state.durMode,
      pctUsed: state.globalPct,
      fixedSeconds: state.globalFixed,
      status: 'pending',
      progress: 0
    });
    added++;
  });
  if (added > 0) {
    refreshAll();
    scheduleSave();
  }
  return added;
}

async function addPaths(paths) {
  const videoPaths = (paths || []).filter(isVideoPath);
  if (!videoPaths.length) {
    setBottomStatus('Nenhum arquivo de vídeo válido encontrado.', 'error');
    return 0;
  }
  setBottomStatus('Lendo metadados dos vídeos...', 'active');
  const entries = [];
  for (const p of videoPaths) {
    const meta = await getFileMeta(p);
    entries.push({ path: p, name: p.split(/[\\/]/).pop(), ...meta });
  }
  const added = addVideos(entries);
  setBottomStatus(`${added} vídeo(s) adicionado(s) à sequência.`, added > 0 ? 'ok' : 'error');
  return added;
}

function removeItems(ids) {
  if (!ids || !ids.length) return;
  const idSet = new Set(ids);
  state.items = state.items.filter(i => !idSet.has(i.id));
  idSet.forEach(id => state.selected.delete(id));
  refreshAll();
  scheduleSave();
  setBottomStatus(`${idSet.size} item(ns) removido(s).`, 'ok');
}

function clearQueue() {
  if (!state.items.length) return;
  state.selected.clear();
  state.items = [];
  refreshAll();
  scheduleSave();
  setBottomStatus('Fila limpa.', 'ok');
}
/* =====================================================================
   CONTROLE DE DURAÇÃO (% / FIXA)
   ===================================================================== */
function syncGlobalControls() {
  const segPercent = document.querySelector('.mg-seg-btn[data-mode="percent"]');
  const segFixed = document.querySelector('.mg-seg-btn[data-mode="fixed"]');
  if (segPercent) segPercent.classList.toggle('active', state.durMode === 'percent');
  if (segFixed) segFixed.classList.toggle('active', state.durMode === 'fixed');
  const pctWrap = $('mgGlobalPctWrap');
  const fixedWrap = $('mgGlobalFixedWrap');
  if (pctWrap) pctWrap.classList.toggle('hidden', state.durMode !== 'percent');
  if (fixedWrap) fixedWrap.classList.toggle('hidden', state.durMode !== 'fixed');
  const slider = $('sliderGlobalPct');
  const num = $('numGlobalPct');
  if (slider) slider.value = String(state.globalPct);
  if (num) num.value = String(state.globalPct);
  const fixed = $('numGlobalFixed');
  if (fixed) fixed.value = state.durMode !== 'percent' ? formatFixedLabel(state.globalFixed) : String(state.globalFixed);
}

function setGlobalPct(v) {
  state.globalPct = Math.min(100, Math.max(1, parseInt(v, 10) || 100));
  const slider = $('sliderGlobalPct');
  const num = $('numGlobalPct');
  if (slider) slider.value = String(state.globalPct);
  if (num) num.value = String(state.globalPct);
  if (state.durMode === 'percent') {
    // Aplica o padrão global apenas a itens ainda não personalizados
    state.items.forEach(i => {
      if (i.durMode === 'percent' && !i.customized) i.pctUsed = state.globalPct;
    });
    renderVirtual();
    refreshSummary();
  }
  scheduleSave();
}

function setGlobalFixed() {
  const input = $('numGlobalFixed');
  if (!input) return;
  const sec = parseFixedLabel(input.value);
  if (!sec || sec < 1) {
    input.value = formatFixedLabel(state.globalFixed);
    return;
  }
  state.globalFixed = Math.round(sec);
  input.value = formatFixedLabel(state.globalFixed);
  scheduleSave();
}

function setItemDuration(item, value) {
  if (item.durMode === 'fixed') {
    let sec = parseFixedLabel(value);
    if (!sec || sec < 1) sec = 1;
    if (item.durationSeconds > 0) sec = Math.min(sec, item.durationSeconds);
    item.fixedSeconds = Math.round(sec);
  } else {
    item.pctUsed = Math.min(100, Math.max(1, parseInt(value, 10) || 100));
    item.customized = true;
  }
  renderVirtual();
  refreshSummary();
  scheduleSave();
  setBottomStatus('Duração atualizada.', 'ok');
}

function toggleItemDurMode(item) {
  item.durMode = item.durMode === 'fixed' ? 'percent' : 'fixed';
  if (item.durMode === 'percent') {
    if (!item.customized) item.pctUsed = state.globalPct;
  } else {
    if (!item.fixedSeconds) item.fixedSeconds = state.globalFixed || 30;
  }
  renderVirtual();
  refreshSummary();
  scheduleSave();
  setBottomStatus(item.durMode === 'fixed' ? 'Agora com duração fixa (segundos).' : 'Agora com porcentagem do vídeo.', 'ok');
}

function applyBulkDuration() {
  const target = state.selected.size ? state.items.filter(i => state.selected.has(i.id)) : [];
  if (!target.length) {
    setBottomStatus('Selecione os vídeos que devem receber a duração.', 'error');
    return;
  }
  if (state.durMode === 'fixed') {
    const sec = state.globalFixed || 30;
    target.forEach(i => { i.durMode = 'fixed'; i.fixedSeconds = sec; i.customized = true; });
  } else {
    target.forEach(i => { i.durMode = 'percent'; i.pctUsed = state.globalPct; i.customized = true; });
  }
  refreshAll();
  scheduleSave();
  setBottomStatus(`Duração aplicada a ${target.length} vídeo(s).`, 'ok');
}
/* =====================================================================
   BIBLIOTECA DE MÍDIA
   ===================================================================== */
function openLibraryModal() {
  const modal = $('librarySelectModal');
  if (modal) modal.classList.remove('hidden');
}

function closeLibraryModal() {
  const modal = $('librarySelectModal');
  if (modal) modal.classList.add('hidden');
}

async function importFromLibrary(origin) {
  closeLibraryModal();
  let result;
  try {
    result = await window.bds.searchLibrary({ origins: origin ? [origin] : undefined, limit: 200 });
  } catch (e) {
    logScreen('Falha ao consultar biblioteca: ' + e.message, 'error');
    setBottomStatus('Erro ao consultar a biblioteca de mídia.', 'error');
    return;
  }
  const items = result && result.items ? result.items
    : (Array.isArray(result) ? result : []);
  if (!items.length) {
    setBottomStatus('Biblioteca vazia.', 'error');
    return;
  }
  setBottomStatus('Importando da biblioteca...', 'active');
  const entries = items.map(it => ({
    path: it.filepath || it.path,
    name: it.filename || it.name || (it.filepath || '').split(/[\\/]/).pop(),
    thumbnail: it.thumbnail ? (state.thumbsDir ? `file:///${state.thumbsDir.replace(/\\/g, '/')}/${it.thumbnail.replace(/^.*[\\/]/, '')}` : fileUrl(it.thumbnail)) : fileUrl(it.thumbnail),
    durationSeconds: parseFloat(it.duration) || 0,
    width: parseInt(it.width, 10) || 0,
    height: parseInt(it.height, 10) || 0
  }));
  const added = addVideos(entries);
  setBottomStatus(`${added} vídeo(s) importado(s) da biblioteca.`, added > 0 ? 'ok' : 'error');
}

/* =====================================================================
   HELPERS: rótulos dos selects + percentual composto + ordenação
   ===================================================================== */

/** Restaura o textContent de todas as <option data-label-ok> dos <select> */
function restoreSelectLabels() {
  document.querySelectorAll('select option[data-label-ok]').forEach(opt => {
    const ok = opt.getAttribute('data-label-ok');
    if (ok) opt.textContent = ok;
  });
}

/**
 * Normaliza valores legados nos selects de saída para que correspondam
 * às chaves aceitas pelo motor FFmpeg em montageService.js.
 */
function normalizeOutputSelects() {
  const selFps = $('selFps');
  if (selFps) {
    // Valor legado 'original' → sentinela do motor
    const origOpt = selFps.querySelector('option[value="original"]');
    if (origOpt) {
      origOpt.value = FPS_SENTINEL;
      origOpt.setAttribute('data-label-ok', 'Manter original');
    }
    if (selFps.value === 'original') selFps.value = FPS_SENTINEL;
  }
  const selCodec = $('selCodec');
  if (selCodec) {
    const hevcOpt = selCodec.querySelector('option[value="H.265 (HEVC)"]');
    if (hevcOpt) {
      hevcOpt.value = 'H.265';
      hevcOpt.setAttribute('data-label-ok', 'H.265 (HEVC)');
    }
    if (selCodec.value === 'H.265 (HEVC)') selCodec.value = 'H.265';
  }
  restoreSelectLabels();
}

/** Sincroniza o selSortOrder a partir de state.sort (bidirecional) */
const SORT_SELECT_MAP = { default: 'default', name: 'name_asc', duration: 'duration_desc' };
const SORT_STATE_MAP  = { default: 'default', name_asc: 'name', duration_desc: 'duration' };
function syncSortSelect() {
  const sel = $('selSortOrder');
  if (sel) sel.value = SORT_SELECT_MAP[state.sort] || 'default';
}

/**
 * Percentual composto do lote: progresso ponderado de todos os arquivos.
 * @param {number} done    — arquivos já concluídos (0-based)
 * @param {number} total   — total de arquivos do lote
 * @param {number} filePct — percentual do arquivo atual (0-100)
 * @returns {number} percentual composto (0-100)
 */
function batchPercent(done, total, filePct) {
  const d = Math.max(0, parseInt(done, 10) || 0);
  const t = Math.max(1, parseInt(total, 10) || 1);
  const f = Math.max(0, Math.min(100, parseFloat(filePct) || 0));
  return (d + f / 100) / t * 100;
}

/* =====================================================================
   ORDENAÇÃO
   ===================================================================== */
function onSortChange(value) {
  state.sort = SORT_STATE_MAP[value] || 'default';
  renderVirtual();
  scheduleSave();
}

function reorderItem(srcId, tgtId, before) {
  if (state.sort !== 'default') return;
  const src = state.items.findIndex(i => i.id === srcId);
  const tgt = state.items.findIndex(i => i.id === tgtId);
  if (src < 0 || tgt < 0) return;
  const [item] = state.items.splice(src, 1);
  let newTgt = state.items.findIndex(i => i.id === tgtId);
  if (newTgt < 0) newTgt = state.items.length;
  state.items.splice(before ? newTgt : newTgt + 1, 0, item);
  refreshAll();
  scheduleSave();
}
/* =====================================================================
   DRAG & DROP — reordenar linhas + soltar arquivos do sistema
   ===================================================================== */
function showDropOverlay(visible) {
  const area = $('mgVirtualArea');
  if (!area) return;
  let overlay = $('mgDropOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'mgDropOverlay';
    overlay.className = 'mg-drop-overlay hidden';
    overlay.innerHTML = '<span class="material-symbols-rounded">file_download</span><span>Soltar para adicionar vídeos</span>';
    area.appendChild(overlay);
  }
  overlay.classList.toggle('hidden', !visible);
}

function hasFiles(e) {
  return e && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

function setupDropZone() {
  const area = $('mgVirtualArea');
  if (!area) return;
  const onEnter = (e) => {
    if (!hasFiles(e)) return;
    dropDepth++;
    showDropOverlay(true);
  };
  const onLeave = (e) => {
    if (!hasFiles(e)) return;
    dropDepth = Math.max(0, dropDepth - 1);
    if (dropDepth === 0) showDropOverlay(false);
  };
  const onOver = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropDepth = Math.max(1, dropDepth);
    showDropOverlay(true);
  };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dropDepth = 0;
    showDropOverlay(false);
    const paths = Array.from(e.dataTransfer.files || []).map(f => {
      try {
        return (window.bds && window.bds.getPathForFile) ? window.bds.getPathForFile(f) : (f.path || '');
      } catch { return f.path || ''; }
    }).filter(Boolean);
    addPaths(paths);
  };
  area.addEventListener('dragenter', onEnter);
  area.addEventListener('dragleave', onLeave);
  area.addEventListener('dragover', onOver);
  area.addEventListener('drop', onDrop);
  listenerCleanups.push(() => {
    area.removeEventListener('dragenter', onEnter);
    area.removeEventListener('dragleave', onLeave);
    area.removeEventListener('dragover', onOver);
    area.removeEventListener('drop', onDrop);
  });
}

function setupRowDragDrop() {
  const body = $('montageMainBody');
  if (!body) return;
  const onDragStart = (e) => {
    const row = e.target.closest('.mg-row');
    if (!row || state.export.active || state.sort !== 'default') {
      e.preventDefault();
      return;
    }
    const editable = e.target.closest('input, button, .mg-te-type');
    if (editable) { e.preventDefault(); return; }
    dragState.srcId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragState.srcId);
  };
  const onDragOver = (e) => {
    if (!dragState.srcId || hasFiles(e)) return;
    const row = e.target.closest('.mg-row');
    if (!row || row.dataset.id === dragState.srcId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onDrop = (e) => {
    if (!dragState.srcId || hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const row = e.target.closest('.mg-row');
    if (!row || row.dataset.id === dragState.srcId) { dragState.srcId = null; return; }
    const rect = row.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    reorderItem(dragState.srcId, row.dataset.id, before);
    dragState.srcId = null;
  };
  const onDragEnd = () => { dragState.srcId = null; };
  body.addEventListener('dragstart', onDragStart);
  body.addEventListener('dragover', onDragOver);
  body.addEventListener('drop', onDrop);
  body.addEventListener('dragend', onDragEnd);
  listenerCleanups.push(() => {
    body.removeEventListener('dragstart', onDragStart);
    body.removeEventListener('dragover', onDragOver);
    body.removeEventListener('drop', onDrop);
    body.removeEventListener('dragend', onDragEnd);
  });
}
/* =====================================================================
   EXPORTAÇÃO / MONTAGEM (motor FFmpeg)
   ===================================================================== */
function buildExportConfig(dest) {
  const getVal = id => { const e = $(id); return e ? e.value : ''; };
  const res = getVal('selRes');
  const fpsRaw = getVal('selFps');
  // Normalização do FPS: 'original' (legado) e 'Manter original' viram sentinela.
  const fps = fpsRaw === 'original' || fpsRaw === FPS_SENTINEL ? FPS_SENTINEL : fpsRaw;
  let codec = getVal('selCodec');
  // Normalização: o motor usa normalizeCodecKey, que não conhece 'H.265 (HEVC)'.
  codec = codec === 'H.265 (HEVC)' ? 'H.265' : codec;
  let quality = getVal('selQuality');
  // O motor só reconhece Baixa/Média/Alta/Muito Alta; 'Máxima' cairia em CRF 23.
  quality = quality === 'Máxima' ? 'Muito Alta' : quality;

  const items = state.items.map((item, idx) => {
    const isFixed = item.durMode === 'fixed';
    return {
      id: item.id,
      name: item.name,
      path: item.path,
      durationSeconds: item.durationSeconds || 0,
      durMode: item.durMode,
      pctUsed: isFixed ? undefined : (item.pctUsed || 100),
      fixedSeconds: isFixed ? Math.max(1, item.fixedSeconds || 1) : undefined,
      finalDurationSeconds: isFixed ? getFinalSeconds(item) : undefined,
      label: item.durMode === 'fixed' ? formatFixedLabel(item.fixedSeconds) : `${item.pctUsed || 100}%`,
      index: idx + 1
    };
  });

  return {
    v: 1,
    jobId: state.export.jobId,
    introPath: state.intro.path || null,
    outroPath: state.outro.path || null,
    items,
    destFolder: dest,
    outputName: getVal('txtOutputName') || 'montagem',
    format: getVal('selFormat') || 'MP4',
    codec,
    quality,
    resolution: res,
    fps,
    baseFileName: getVal('txtOutputName') || 'montagem'
  };
}

async function startExport() {
  if (state.export.active) return;
  if (!state.items.length) {
    setBottomStatus('Adicione vídeos à sequência antes de exportar.', 'error');
    return;
  }
  const dest = $('txtDestFolder')?.value?.trim();
  if (!dest) {
    setBottomStatus('Defina a pasta de destino antes de exportar.', 'error');
    return;
  }
  if (!window.bds || !window.bds.enqueueMontage) {
    setBottomStatus('Motor de montagem indisponível.', 'error');
    return;
  }

  state.export = {
    active: true, completed: false, cancelled: false,
    current: 0, total: state.items.length, percent: 0,
    jobId: `montage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
  };
  state.items.forEach(i => { i.status = 'queued'; i.progress = 0; });
  refreshAll();
  const btnExport = $('btnExportAll');
  const btnCancel = $('btnCancelExport');
  if (btnExport) btnExport.disabled = true;
  if (btnCancel) btnCancel.classList.remove('hidden');
  setBottomStatus('Enviando lote para o motor FFmpeg...', 'active');
  setAppStatus('Montagem em andamento...', 'info');

  try {
    const result = await window.bds.enqueueMontage(buildExportConfig(dest));
    // O invoke só resolve quando o lote termina (sucesso ou cancelamento).
    if (state.export.cancelled || (result && result.cancelled === true)) {
      finalizeExport('cancelled');
    } else {
      finalizeExport('success');
    }
  } catch (e) {
    logScreen('Falha na montagem: ' + (e && e.message ? e.message : e), 'error');
    if (state.export.cancelled) finalizeExport('cancelled');
    else finalizeExport('error', e);
  }
}

async function cancelExport() {
  if (!state.export.active) return;
  state.export.cancelled = true;
  const btnCancel = $('btnCancelExport');
  if (btnCancel) btnCancel.disabled = true;
  setBottomStatus('Cancelando... aguarde o FFmpeg encerrar.', 'active');
  try {
    if (window.bds && window.bds.cancelMontageJob && state.export.jobId) {
      await window.bds.cancelMontageJob(state.export.jobId);
    } else if (window.bds && window.bds.cancelMontage) {
      await window.bds.cancelMontage();
    }
  } catch (e) {
    logScreen('Erro ao cancelar: ' + e.message, 'error');
  }
}

function finalizeExport(kind, error) {
  if (!state.export.active && state.export.completed) return;
  state.export.active = false;
  const btnExport = $('btnExportAll');
  const btnCancel = $('btnCancelExport');
  if (btnExport) btnExport.disabled = false;
  if (btnCancel) { btnCancel.disabled = false; btnCancel.classList.add('hidden'); }

  if (kind === 'success') {
    state.export.completed = true;
    state.export.percent = 100;
    state.items.forEach(i => { if (i.status !== 'cancelled') { i.status = 'done'; i.progress = 100; } });
    setBottomStatus('Montagem concluída com sucesso!', 'ok');
    setAppStatus('Pronto', 'success');
  } else if (kind === 'cancelled') {
    state.export.completed = true;
    state.export.cancelled = true;
    state.items.forEach(i => { if (i.status === 'queued' || i.status === 'exporting') i.status = 'cancelled'; });
    setBottomStatus('Montagem cancelada.', 'error');
    setAppStatus('Cancelado', 'info');
  } else {
    state.export.completed = true;
    state.items.forEach(i => { if (i.status === 'queued' || i.status === 'exporting') i.status = 'error'; });
    const msg = error && error.message ? error.message : 'Erro desconhecido';
    setBottomStatus(`Erro na montagem: ${msg}`, 'error');
    setAppStatus('Erro na montagem', 'error');
  }
  refreshAll();
  scheduleSave();
}
/* =====================================================================
   LISTENERS IPC (progresso / fim do lote / cancelamento)
   ===================================================================== */
function setupIPCListeners() {
  const bds = window.bds;
  if (!bds) return;

  if (bds.onMontageProgress) {
    const unsub = bds.onMontageProgress((payload) => {
      if (!payload || !state.export.active) return;
      if (state.export.jobId && payload.jobId && payload.jobId !== state.export.jobId) return;
      const curFile = payload.currentFile || payload.index || state.export.current;
      const totFiles = payload.totalFiles || state.export.total;
      const filePct = Math.min(100, Math.max(0, parseFloat(payload.percent) || 0));
      state.export.current = curFile;
      state.export.total  = totFiles;
      // Percentual composto: concluídos + (arquivo atual / total)
      state.export.percent = batchPercent(Math.max(0, curFile - 1), totFiles, filePct);
      const idx = curFile - 1;
      const item = state.items[idx];
      if (item) {
        if (item.status !== 'done') item.status = 'exporting';
        item.progress = filePct;
      }
      setBottomStatus(
        `Renderizando ${payload.fileName || (curFile + '/' + totFiles)} — ${Math.round(state.export.percent)}%`,
        'active'
      );
      updateExportProgress(state.export.percent, payload.fileName, curFile, totFiles);
      refreshStepper();
      refreshSelectionUI();
      renderVirtual();
    });
    listenerCleanups.push(unsub);
  }

  if (bds.onMontageFinished) {
    const unsub = bds.onMontageFinished((payload) => {
      if (!payload) return;
      if (state.export.jobId && payload.jobId && payload.jobId !== state.export.jobId) return;
      if (!state.export.active && state.export.completed) return;
      if (payload.status === 'cancelled' || state.export.cancelled) {
        finalizeExport('cancelled');
      } else if (payload.status === 'batch-success' || payload.status === 'success') {
        finalizeExport('success');
      } else {
        finalizeExport('error', payload && payload.error ? new Error(payload.error) : null);
      }
    });
    listenerCleanups.push(unsub);
  }

  if (bds.onMontageQueueUpdated) {
    const unsub = bds.onMontageQueueUpdated((queue) => {
      if (!Array.isArray(queue) || !queue.length || !state.export.active) return;
      const job = queue[0];
      if (!job || job.status !== 'running') return;
      const curFile = job.current || state.export.current;
      const totFiles = job.total || state.export.total;
      const filePct = Math.min(100, Math.max(0, parseFloat(job.percent) || 0));
      state.export.current = curFile;
      state.export.total  = totFiles;
      state.export.percent = batchPercent(Math.max(0, curFile - 1), totFiles, filePct);
      updateExportProgress(state.export.percent, job.fileName, curFile, totFiles);
      refreshStepper();
    });
    listenerCleanups.push(unsub);
  }
}
/* =====================================================================
   BIND DE EVENTOS DO DOM (PARTE 1 — lista virtual)
   ===================================================================== */
function bindListEvents() {
  const area = $('mgVirtualArea');
  const body = $('montageMainBody');
  if (!area || !body) return;

  const onScroll = () => renderVirtual();
  area.addEventListener('scroll', onScroll, { passive: true });
  listenerCleanups.push(() => area.removeEventListener('scroll', onScroll));

  // --- Clique na linha: seleção ---
  const onClickRow = (e) => {
    const row = e.target.closest('.mg-row');
    if (!row) return;
    const id = row.dataset.id;
    const editable = e.target.closest('input, button, .mg-te-type, select');
    if (editable) return;

    const idx = state.items.findIndex(i => i.id === id);
    if (idx < 0) return;

    if (e.shiftKey && state.anchorId) {
      selectRange(state.anchorId, id);
    } else if (e.ctrlKey || e.metaKey) {
      toggleSelect(id);
      state.anchorId = id;
    } else {
      selectOnly(id);
      state.anchorId = id;
    }
    refreshSelectionUI();
    renderVirtual();
  };
  body.addEventListener('click', onClickRow);
  listenerCleanups.push(() => body.removeEventListener('click', onClickRow));

  // --- Botão remover dentro da linha ---
  const onClickRemove = (e) => {
    const btn = e.target.closest('[data-action="remove"]');
    if (!btn) return;
    e.stopPropagation();
    removeItems([btn.dataset.id]);
  };
  body.addEventListener('click', onClickRemove);
  listenerCleanups.push(() => body.removeEventListener('click', onClickRemove));

  // --- Checkbox individual ---
  const onChangeCheck = (e) => {
    const cb = e.target.closest('.mg-row-check input[type="checkbox"]');
    if (!cb) return;
    e.stopPropagation();
    toggleSelect(cb.dataset.id, cb.checked);
    state.anchorId = cb.dataset.id;
    refreshSelectionUI();
    const row = cb.closest('.mg-row');
    if (row) row.classList.toggle('selected', cb.checked);
  };
  body.addEventListener('change', onChangeCheck);
  listenerCleanups.push(() => body.removeEventListener('change', onChangeCheck));

  // --- Alternar modo % / fixo por linha ---
  const onClickToggle = (e) => {
    const toggle = e.target.closest('.mg-te-type[data-type="toggle"]');
    if (!toggle) return;
    e.stopPropagation();
    const item = state.items.find(i => i.id === toggle.dataset.id);
    if (item) toggleItemDurMode(item);
  };
  body.addEventListener('click', onClickToggle);
  listenerCleanups.push(() => body.removeEventListener('click', onClickToggle));
}
function bindDurationInputs() {
  const body = $('montageMainBody');
  if (!body) return;

  const onInputRow = (e) => {
    const input = e.target.closest('.mg-te-input');
    if (!input) return;
    const item = state.items.find(i => i.id === input.dataset.id);
    if (!item) return;
    if (item.durMode === 'fixed') {
      const sec = parseFixedLabel(input.value);
      input.dataset.pending = sec && sec >= 1 ? String(sec) : '';
    } else {
      const v = parseInt(input.value, 10);
      input.dataset.pending = !isNaN(v) && v >= 1 ? String(Math.min(100, v)) : '';
    }
  };
  const commitRow = (input) => {
    if (!input || input.closest('.mg-te-input') !== input) return;
    const item = state.items.find(i => i.id === input.dataset.id);
    if (!item) return;
    const pending = input.dataset.pending || input.value;
    setItemDuration(item, pending);
    delete input.dataset.pending;
  };
  const onChangeRow = (e) => {
    const input = e.target.closest('.mg-te-input');
    if (input) commitRow(input);
  };
  const onKeyRow = (e) => {
    if (e.key === 'Enter' && e.target.closest('.mg-te-input')) {
      commitRow(e.target);
      e.target.blur();
    }
  };
  body.addEventListener('input', onInputRow);
  body.addEventListener('change', onChangeRow);
  body.addEventListener('keydown', onKeyRow);
  listenerCleanups.push(() => {
    body.removeEventListener('input', onInputRow);
    body.removeEventListener('change', onChangeRow);
    body.removeEventListener('keydown', onKeyRow);
  });
}
/* =====================================================================
   BIND DE EVENTOS (PARTE 2 — controles globais)
   ===================================================================== */
function bindControlsEvents() {
  const on = (id, evt, fn, opts) => {
    const el = $(id);
    if (el) { el.addEventListener(evt, fn, opts); listenerCleanups.push(() => el.removeEventListener(evt, fn, opts)); }
  };

  // --- Salvar projeto / banner de debug ---
  on('btnSaveProject', 'click', () => {
    saveSession();
    setBottomStatus('Projeto salvo no armazenamento local.', 'ok');
  });
  on('btnCloseDebugBanner', 'click', () => { $('montageDebugBanner')?.classList.add('hidden'); });

  // --- Abertura / Finalização ---
  on('btnSelectIntro', 'click', () => pickCompanion('intro'));
  on('btnRemoveIntro', 'click', () => removeCompanion('intro'));
  on('btnSelectOutro', 'click', () => pickCompanion('outro'));
  on('btnRemoveOutro', 'click', () => removeCompanion('outro'));

  // --- Adicionar vídeos principais ---
  on('btnAddMainVideos', 'click', async () => {
    const paths = await window.bds.selectFile({
      title: 'Selecionar vídeos',
      filters: [{ name: 'Vídeos', extensions: Array.from(VIDEO_EXT) }],
      properties: ['openFile', 'multiSelections']
    });
    if (Array.isArray(paths) && paths.length) addPaths(paths);
  });
  on('btnAddFolder', 'click', async () => {
    // selectFolder retorna string | null (caminho da pasta ou null ao cancelar)
    const folder = await window.bds.selectFolder('');
    if (typeof folder !== 'string' || !folder) return;
    const files = (window.bds && window.bds.getLibraryFolderFiles)
      ? await window.bds.getLibraryFolderFiles(folder)
      : [];
    if (!files || !files.length) {
      setBottomStatus('Nenhum vídeo encontrado na pasta selecionada.', 'error');
      return;
    }
    addPaths(files);
  });
  on('btnImportFromLibrary', 'click', () => openLibraryModal());

  // --- Fila ---
  on('btnClearQueue', 'click', () => {
    if (state.items.length) clearQueue();
  });

  // --- Seleção em massa ---
  on('btnSelectAll', 'click', () => {
    state.selected = new Set(state.items.map(i => i.id));
    state.anchorId = state.items[state.items.length - 1]?.id || null;
    refreshSelectionUI();
    renderVirtual();
  });
  on('btnClearSelection', 'click', () => {
    state.selected.clear();
    state.anchorId = null;
    refreshSelectionUI();
    renderVirtual();
  });
  on('btnRemoveSelected', 'click', () => {
    if (state.selected.size) removeItems(Array.from(state.selected));
  });
  on('mgCheckAll', 'change', (e) => {
    if (e.target.checked) {
      state.selected = new Set(state.items.map(i => i.id));
    } else {
      state.selected.clear();
    }
    refreshSelectionUI();
    renderVirtual();
  });

  // --- Ordenação ---
  on('selSortOrder', 'change', (e) => onSortChange(e.target.value));

  // --- Controle de duração global ---
  document.querySelectorAll('.mg-seg-btn[data-mode]').forEach(btn => {
    const fn = () => {
      state.durMode = btn.dataset.mode;
      syncGlobalControls();
      scheduleSave();
    };
    btn.addEventListener('click', fn);
    listenerCleanups.push(() => btn.removeEventListener('click', fn));
  });
  const slider = $('sliderGlobalPct');
  const numPct = $('numGlobalPct');
  const syncPctInputs = (v) => {
    if (slider) slider.value = String(v);
    if (numPct) numPct.value = String(v);
  };
  const onSlider = (e) => { syncPctInputs(e.target.value); setGlobalPct(e.target.value); };
  if (slider) {
    slider.addEventListener('input', onSlider);
    listenerCleanups.push(() => slider.removeEventListener('input', onSlider));
  }
  const onNumPct = (e) => {
    const v = e.target.value;
    syncPctInputs(v);
    setGlobalPct(v);
  };
  if (numPct) {
    numPct.addEventListener('input', onNumPct);
    listenerCleanups.push(() => numPct.removeEventListener('input', onNumPct));
  }
  on('numGlobalFixed', 'change', setGlobalFixed);
  on('btnApplyDurationBulk', 'click', applyBulkDuration);

  // --- Modal de biblioteca ---
  on('btnCloseLibModal', 'click', closeLibraryModal);
  const libButtons = document.querySelectorAll('#librarySelectModal .montage-lib-option');
  libButtons.forEach(btn => {
    const fn = () => {
      const origin = btn.dataset.origin || '';
      const all = btn.dataset.all === 'true';
      importFromLibrary(all ? undefined : origin);
    };
    btn.addEventListener('click', fn);
    listenerCleanups.push(() => btn.removeEventListener('click', fn));
  });
  on('librarySelectModal', 'click', (e) => {
    if (e.target.id === 'librarySelectModal') closeLibraryModal();
  });

  // --- Exportação ---
  on('btnExportAll', 'click', startExport);
  on('btnCancelExport', 'click', cancelExport);
  on('btnSelectDestFolder', 'click', async () => {
    const fallback = $('txtDestFolder')?.value || '';
    // selectFolder retorna string | null
    const folder = await window.bds.selectFolder(fallback);
    if (typeof folder === 'string' && folder) {
      const dest = $('txtDestFolder');
      if (dest) dest.value = folder;
      scheduleSave();
    }
  });

  // --- Auto-save em mudanças dos controles de saída ---
  ['selRes', 'selFps', 'selCodec', 'selQuality', 'selFormat', 'txtOutputName'].forEach(id => {
    const el = $(id);
    if (!el) return;
    const fn = () => scheduleSave();
    el.addEventListener('change', fn);
    listenerCleanups.push(() => el.removeEventListener('change', fn));
  });
}
/* =====================================================================
   DIÁLOGO DE PASTA DE DESTINO (fallback via input webkitdirectory)
   ===================================================================== */
function bindDestFolderFallback() {
  const ph = $('phSelectDestFolder');
  if (!ph) return;
  const fn = (e) => {
    if (e.target.files && e.target.files.length) {
      const file = e.target.files[0];
      let p = '';
      try {
        p = (window.bds && window.bds.getPathForFile) ? window.bds.getPathForFile(file) : (file.path || '');
      } catch { p = file.path || ''; }
      if (p) {
        const folder = p.split(/[\\/]/).slice(0, -1).join('/');
        const dest = $('txtDestFolder');
        if (dest) dest.value = folder;
        scheduleSave();
      }
    }
  };
  ph.addEventListener('change', fn);
  listenerCleanups.push(() => ph.removeEventListener('change', fn));
}

/* =====================================================================
   SELEÇÃO DE PASTA CHEIA DE VÍDEOS (Add Folder)
   ===================================================================== */
function bindAddFolderNative() {
  const btn = $('btnAddFolder');
  if (!btn) return;
  // O botão já usa selectFolder (dialog nativo) em bindControlsEvents;
  // este fallback garante que, sem o dialog, ainda exista o input oculto.
  const ph = $('phAddFolderInput');
  if (ph) {
    const fn = (e) => {
      if (e.target.files && e.target.files.length) {
        const paths = Array.from(e.target.files).map(f => {
          try {
            return (window.bds && window.bds.getPathForFile) ? window.bds.getPathForFile(f) : (f.path || '');
          } catch { return f.path || ''; }
        }).filter(Boolean);
        addPaths(paths);
        e.target.value = '';
      }
    };
    ph.addEventListener('change', fn);
    listenerCleanups.push(() => ph.removeEventListener('change', fn));
  }
}

/**
 * Re-probe em background: itens restaurados da sessão com durationSeconds === 0
 * (causado por sessão salva com bug anterior do getFileMeta).
 * Atualiza duration, width, height e thumbnail sem bloquear a UI.
 */
async function reprobeZeroDurationItems() {
  const needsProbe = state.items.filter(i => !i.durationSeconds && i.path);
  if (!needsProbe.length) return;
  logScreen(`Re-probe: ${needsProbe.length} item(ns) sem duração.`, 'info');
  let updated = 0;
  for (const item of needsProbe) {
    try {
      const meta = await getFileMeta(item.path);
      if (meta.durationSeconds > 0) {
        item.durationSeconds = meta.durationSeconds;
        updated++;
      }
      if (meta.width && meta.height) {
        item.width = meta.width;
        item.height = meta.height;
      }
      if (meta.thumbnail && !item.thumbnail) {
        item.thumbnail = meta.thumbnail;
      }
    } catch (e) { /* ignora */ }
  }
  if (updated > 0) {
    logScreen(`Re-probe: ${updated} item(ns) atualizado(s) com duração real.`, 'info');
    scheduleSave();
    refreshAll();
  }
}

/* =====================================================================
   INIT DA TELA
   ===================================================================== */
export async function initScreen() {
  logScreen('Inicializando tela de Montagem de Vídeos (ETAPA 3)...', 'info');

  // Garante que o tema ativo é aplicado na tela de Montagem
  if (appState?.settings) {
    applyTheme(appState.settings.theme, appState.settings.accentColor);
  }

  // Restaura sessão salva
  const restored = loadSession();
  if (restored) {
    logScreen('Sessão anterior restaurada.', 'info');
    // Re-probe em background: itens com durationSeconds === 0 (legado/sessão anterior)
    reprobeZeroDurationItems();
  }

  // Diretório de miniaturas
  if (window.bds && window.bds.getThumbDir) {
    try {
      const rawDir = await window.bds.getThumbDir();
      state.thumbsDir = rawDir.replace(/\\/g, '/');
      logScreen('Diretório de miniaturas configurado.', 'info');
    } catch (e) {
      logScreen(`Erro ao buscar getThumbDir: ${e.message}`, 'error');
    }
  }

  // Pasta de destino padrão (somente se vazia)
  const dest = $('txtDestFolder');
  if (dest && !dest.value && window.bds && window.bds.getDefaultOutputDir) {
    try {
      const defaultDir = await window.bds.getDefaultOutputDir();
      if (defaultDir) dest.value = defaultDir;
    } catch (e) { /* ignora */ }
  }

  // Normaliza selects de saída (FPS legado, codec legado, restaura labels)
  normalizeOutputSelects();
  syncSortSelect();

  syncGlobalControls();
  setupDropZone();
  setupRowDragDrop();
  bindListEvents();
  bindDurationInputs();
  setupIPCListeners();
  bindControlsEvents();
  bindDestFolderFallback();
  bindAddFolderNative();

  // Valor inicial do marcador se houver seleção restaurada
  renderCompanionCard('intro');
  renderCompanionCard('outro');
  refreshAll();
  setBottomStatus('Montagem pronta. Adicione vídeos para começar.', 'ok');
}

/* =====================================================================
   AO SAIR DA TELA — salva a sessão e remove listeners
   ===================================================================== */
export function onLeave() {
  saveSession();
  listenerCleanups.forEach(fn => { try { fn(); } catch (e) { /* ignora */ } });
  listenerCleanups = [];
}