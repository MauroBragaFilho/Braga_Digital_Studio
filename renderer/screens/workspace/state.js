/**
 * Estado compartilhado e utilitários da área interna do projeto (project_workspace).
 * Cada aba (overview, files, audio, devices, delivery) é um módulo que lê/escreve aqui.
 */
import { setAppStatus } from '../../app.js';
import { friendlyError } from '../../utils/friendlyError.js';
import { toFileUrl, joinFileUrl } from '../../utils/fileUrl.js';
import { formatLocalDate } from '../../utils/localDate.js';

export { setAppStatus, friendlyError, toFileUrl, formatLocalDate };

export const ws = {
  projectId: null,
  project: null,
  bins: [],
  media: [],          // project_media (pm_id, bin_id, custom_name, ...media)
  library: [],        // biblioteca (para o modal "Da Biblioteca")
  syncGroups: [],
  missing: [],
  thumbsBase: '',
  tab: 'overview',
  // Arquivos
  currentBin: 'all',  // 'all' | 'unfiled' | <bin id>
  query: '',
  typeFilter: 'all',  // all | video | audio | photo
  view: 'grid',
  selected: new Set(),// pm_ids marcados
  inspected: null     // pm_id em destaque no painel direito (ou null)
};

export const $ = (id) => document.getElementById(id);

export function mk(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'disabled') el.disabled = !!v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of (Array.isArray(children) ? children : [children])) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const icon = (name) => mk('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true', text: name });

export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  const k = 1024; const sizes = ['KB', 'MB', 'GB', 'TB'];
  let v = b / k; let i = 0;
  while (v >= k && i < sizes.length - 1) { v /= k; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1).replace('.', ',')} ${sizes[i]}`;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** hh:mm:ss.d (décimos) para posições na linha do tempo. */
export function formatClock(sec) {
  const neg = sec < 0; const s = Math.abs(Number(sec) || 0);
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = (s % 60).toFixed(1).padStart(4, '0');
  return `${neg ? '-' : ''}${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${r}`;
}

export function secondsToTimecode(totalSeconds, fps = 30) {
  if (!totalSeconds || Number.isNaN(totalSeconds)) return '00:00:00:00';
  const fr = Math.max(1, Math.round(fps));
  const total = Math.floor(totalSeconds * fr);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / (fr * 3600)))}:${pad(Math.floor((total % (fr * 3600)) / (fr * 60)))}:${pad(Math.floor((total % (fr * 60)) / fr))}:${pad(total % fr)}`;
}

/** "Hoje, 22:41" / "Ontem, 10:02" / "12/03/2026 10:02" a partir de um DATETIME do banco (UTC). */
export function relativeWhen(value) {
  if (!value) return '—';
  const d = new Date(String(value).includes('T') ? value : `${value}Z`.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Hoje, ${hm}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Ontem, ${hm}`;
  return `${d.toLocaleDateString('pt-BR')} ${hm}`;
}

export function extLabel(pm) {
  const name = pm && (pm.filename || pm.filepath) ? String(pm.filename || pm.filepath) : '';
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toUpperCase() : '';
}
export function isPhoto(pm) {
  if (pm.media_type) return pm.media_type === 'photo' || pm.media_type === 'raw';
  return ['JPG', 'JPEG', 'PNG', 'WEBP', 'GIF', 'BMP', 'TIF', 'TIFF', 'HEIC'].includes(extLabel(pm));
}
export function isAudioOnly(pm) {
  if (pm.media_type) return pm.media_type === 'audio';
  return ['MP3', 'WAV', 'AAC', 'FLAC', 'M4A', 'OGG'].includes(extLabel(pm)) || (!pm.video_codec && !!pm.audio_codec);
}
export const kindOf = (pm) => (isPhoto(pm) ? 'photo' : isAudioOnly(pm) ? 'audio' : 'video');
export const nameOf = (pm) => pm.custom_name || pm.filename || '';

/** background-image CSS da miniatura (media.thumbnail dentro da pasta de miniaturas) ou ''. */
export function thumbCss(pm) {
  return pm && pm.thumbnail && ws.thumbsBase ? `url('${joinFileUrl(ws.thumbsBase, pm.thumbnail)}')` : '';
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Desenha um envelope (picos 0..1) num canvas, na cor de texto secundária. */
export function drawWaveform(canvas, peaks, color = null) {
  if (!canvas || !peaks || !peaks.length) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth || 300;
  const h = canvas.height;
  const mid = h / 2;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = color || getComputedStyle(canvas).color || '#888';
  const step = peaks.length / w;
  for (let x = 0; x < w; x++) {
    const amp = peaks[Math.floor(x * step)] || 0;
    const bar = Math.max(1, amp * mid * 0.95);
    ctx.fillRect(x, mid - bar, 1, bar * 2);
  }
}

export const synced = () => { const s = new Set(); ws.syncGroups.forEach((g) => (g.items || []).forEach((it) => s.add(it.media_id))); return s; };

/** Recarrega pastas e mídias do projeto. */
export async function reloadMedia() {
  ws.bins = (await window.bds.getProjectBins(ws.projectId)) || [];
  ws.media = (await window.bds.getProjectMedia(ws.projectId)) || [];
  const ids = new Set(ws.media.map((m) => m.pm_id));
  for (const id of [...ws.selected]) if (!ids.has(id)) ws.selected.delete(id);
  if (ws.inspected && !ids.has(ws.inspected)) ws.inspected = null;
}
export async function reloadSyncGroups() {
  try { ws.syncGroups = (await window.bds.getProjectSyncGroups(ws.projectId)) || []; } catch (_) { ws.syncGroups = []; }
}
export async function reloadMissing() {
  try { ws.missing = (await window.bds.getMissingProjectMedia(ws.projectId)) || []; } catch (_) { ws.missing = []; }
}

/** Pequeno evento interno para as abas se atualizarem quando os dados mudam. */
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const emitChange = (what) => { for (const fn of listeners) { try { fn(what); } catch (e) { console.error('[WORKSPACE]', e); } } };
export const clearListeners = () => listeners.clear();
