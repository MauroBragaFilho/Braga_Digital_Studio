/**
 * LUTs do projeto (na Visão geral): as LUTs da coleção ligadas a este trabalho, com miniatura, nome, tipo e tamanho,
 * "LUT ausente" / "Arquivo alterado" quando a LUT saiu ou mudou na coleção, "Mostrar na pasta" e "Remover" por item,
 * e "Adicionar da coleção…" (janela com busca, caixas e miniaturas sob demanda). A ligação é feita pelo conteúdo no
 * processo principal; aqui nenhum caminho de arquivo é montado: só se pedem LUTs pelo caminho relativo que a lista
 * da coleção informou. Todo nome entra na tela por textContent.
 */
import { ws, $, mk, icon, formatBytes, setAppStatus, friendlyError, emitChange } from './state.js';
import { createLutThumbs } from '../../utils/lutThumb.js';
import { state as appState } from '../../app.js';

const PICKER_MAX_ROWS = 300;
const thumbs = createLutThumbs({ getSettings: () => (appState && appState.settings) || {}, maxDim: 112 });

let current = [];            // LUTs do projeto, como o main devolveu
let renderSeq = 0;
let pendingFocus = null;     // depois de remover: { index } para devolver o foco
let listObserver = null;
let pickerObserver = null;
let collection = [];         // LUTs da coleção (janela de adicionar)
let pickerSelection = new Set();
let pickerBusy = false;
let onModules = null;

const lutsAllowed = () => (window.bdsIsScreenAllowed ? window.bdsIsScreenAllowed('luts') === true : true);
const searchKey = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const byRel = (a, b) => String(a.relPath).localeCompare(String(b.relPath), 'pt-BR', { numeric: true, sensitivity: 'base' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Chave de miniatura: o conteúdo (hash) quando se sabe; senão caminho + tamanho + data. */
const thumbKey = (item) => item.hash || `${item.path}:${item.size}:${item.modifiedAt}`;

/** "LUT 3D · 33³ · 917,0 KB" */
function metaText(l) {
  const parts = [l.kind === '1D' ? 'LUT 1D' : 'LUT 3D'];
  if (l.lutSize) parts.push(l.kind === '1D' ? `${l.lutSize} pontos` : `${l.lutSize}³`);
  if (l.bytes) parts.push(formatBytes(l.bytes));
  return parts.join(' · ');
}

/** Liga os eventos desta abertura (a tela é recriada a cada projeto aberto). */
export function bindLuts() {
  $('wsLutsAdd')?.addEventListener('click', openPicker);
  $('wsLutPickerSearch')?.addEventListener('input', renderPicker);
  $('wsLutPickerConfirm')?.addEventListener('click', confirmPicker);
  $('wsLutPickerClose')?.addEventListener('click', closePicker);
}

export function unbindLuts() {
  if (onModules) { window.removeEventListener('bds:modules-changed', onModules); onModules = null; }
  listObserver?.disconnect(); listObserver = null;
  pickerObserver?.disconnect(); pickerObserver = null;
  current = [];
  collection = [];
  pickerSelection = new Set();
}

function applyAllowed() {
  $('wsLutsCard')?.classList.toggle('hidden', !lutsAllowed());
}

// ------------------------------------------------------------------ cartão "LUTs"

export async function renderLuts() {
  applyAllowed();
  if (!onModules) {
    // Módulo LUTs ligado ou desligado enquanto o projeto está aberto: o cartão aparece ou some (os dados ficam)
    onModules = () => { if (lutsAllowed()) renderLuts(); else applyAllowed(); };
    window.addEventListener('bds:modules-changed', onModules);
  }
  if (!lutsAllowed()) return; // módulo desligado: o cartão fica escondido e nada é lido (as LUTs do projeto continuam guardadas)
  const host = $('wsLutsList');
  if (!host) return;
  const seq = ++renderSeq;
  let rows = [];
  let failed = false;
  try { rows = (await window.bds.listProjectLuts(ws.projectId)) || []; } catch (e) { failed = true; console.error('[WORKSPACE] LUTs:', e); }
  if (seq !== renderSeq) return; // uma atualização mais nova já foi pedida
  current = rows;
  host.textContent = '';
  listObserver?.disconnect();
  listObserver = null;
  if (failed) {
    host.append(mk('li', { class: 'ws-empty-line', text: 'Não foi possível ler as LUTs do projeto.' }));
  } else if (!rows.length) {
    host.append(mk('li', { class: 'ws-empty-line', text: 'LUTs de cor deste trabalho. Elas vão junto quando o projeto é exportado.' }));
  } else {
    for (const l of rows) host.append(lutItem(l));
    observeThumbs(host);
  }
  if (pendingFocus) {
    const { index } = pendingFocus;
    pendingFocus = null;
    const buttons = [...host.querySelectorAll('[data-lut-action="remove"]')];
    try { (buttons[Math.min(index, buttons.length - 1)] || $('wsLutsAdd'))?.focus(); } catch (_) { /* tela descartada */ }
  }
}

function lutItem(l) {
  const missing = l.status === 'missing';
  const changed = l.status === 'changed';
  const thumb = mk('span', { class: 'ws-lut-thumb', 'data-thumb-key': l.hash, 'data-thumb-path': l.path || '' }, [icon(missing ? 'broken_image' : 'gradient')]);
  const status = missing ? 'LUT ausente' : changed ? 'Arquivo alterado' : '';
  const hint = missing ? 'Esta LUT não está mais na coleção.' : changed ? 'O arquivo desta LUT mudou na coleção depois de ser adicionada.' : '';
  return mk('li', { class: `ws-lut-item${missing ? ' is-missing' : ''}`, 'data-hash': l.hash }, [
    thumb,
    mk('span', { class: 'ws-lut-text' }, [
      mk('b', { class: 'ws-lut-name', text: l.name, title: l.title && l.title !== l.name ? `${l.name} — ${l.title}` : l.name }),
      mk('small', { class: 'ws-lut-meta', text: metaText(l) }),
      status ? mk('small', { class: 'ws-lut-status tone-warn', text: status, title: hint }) : null
    ]),
    mk('button', {
      type: 'button', class: 'ws-icon-btn', 'data-lut-action': 'reveal', title: missing ? 'A LUT não está na coleção' : 'Mostrar na pasta',
      'aria-label': `Mostrar ${l.name} na pasta`, disabled: missing, onclick: () => reveal(l)
    }, [icon('folder_open')]),
    mk('button', {
      type: 'button', class: 'ws-icon-btn', 'data-lut-action': 'remove', title: 'Remover do projeto',
      'aria-label': `Remover ${l.name} do projeto`, onclick: () => removeLut(l)
    }, [icon('close')])
  ]);
}

/** Miniaturas sob demanda: só quando o item chega perto da tela. */
function observeThumbs(host) {
  if (typeof IntersectionObserver === 'undefined') return;
  listObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      listObserver?.unobserve(entry.target);
      fillThumb(entry.target);
    }
  }, { rootMargin: '120px' });
  for (const el of host.querySelectorAll('.ws-lut-thumb[data-thumb-path]')) {
    if (el.dataset.thumbPath) listObserver.observe(el);
  }
}

function fillThumb(el) {
  const key = el.dataset.thumbKey;
  const lutPath = el.dataset.thumbPath;
  if (!key || !lutPath) return;
  thumbs.thumb(key, lutPath).then((url) => {
    if (!url || !el.isConnected) return;
    el.textContent = '';
    el.append(mk('img', { src: url, alt: '', draggable: 'false' }));
    el.classList.add('has-img');
  }).catch(() => { /* fica o ícone */ });
}

async function reveal(l) {
  try { await window.bds.revealProjectLut(ws.projectId, l.hash); }
  catch (err) { setAppStatus(friendlyError(err), 'error'); }
}

async function removeLut(l) {
  const ok = await window.bdsModal.confirm(`Remover "${l.name}" das LUTs do projeto?\n\nA LUT continua na coleção de LUTs.`);
  if (!ok) return;
  const index = Math.max(0, current.findIndex((x) => x.hash === l.hash));
  try {
    await window.bds.removeProjectLut(ws.projectId, l.hash);
    pendingFocus = { index };
    setAppStatus('LUT removida do projeto.', 'success');
    await renderLuts();
    emitChange('luts'); // a atividade da Visão geral acompanha
  } catch (err) { window.bdsModal.alert(`Não foi possível remover a LUT: ${friendlyError(err)}`); }
}

// ------------------------------------------------------------------ janela "Adicionar da coleção…"

/** Já está no projeto? Pelo conteúdo (hash) e, enquanto ele não é conhecido, pelo caminho que o projeto resolveu. */
function inProject(item) {
  return current.some((l) => (item.hash && l.hash === item.hash) || (l.relPath && l.relPath === item.relPath));
}

async function openPicker() {
  const modal = $('wsLutPicker');
  if (!modal || pickerBusy) return;
  pickerSelection = new Set();
  collection = [];
  const search = $('wsLutPickerSearch');
  if (search) search.value = '';
  setPickerNote('Lendo a coleção de LUTs…');
  modal.classList.remove('hidden');
  renderPicker();
  try {
    const res = await window.bds.listLuts();
    collection = (Array.isArray(res && res.items) ? res.items : []).filter((i) => i && i.relPath && i.path).sort(byRel);
    setPickerNote(collection.length ? '' : 'A coleção de LUTs está vazia. Importe LUTs na tela de LUTs.');
  } catch (err) {
    setPickerNote(`Não foi possível ler a coleção de LUTs: ${friendlyError(err)}`);
  }
  renderPicker();
}

function closePicker() {
  $('wsLutPicker')?.classList.add('hidden');
  pickerObserver?.disconnect();
  pickerObserver = null;
}

function setPickerNote(text) {
  const n = $('wsLutPickerNote');
  if (n) n.textContent = text;
}

function renderPicker() {
  const list = $('wsLutPickerList');
  if (!list) return;
  list.textContent = '';
  pickerObserver?.disconnect();
  pickerObserver = null;
  const q = searchKey($('wsLutPickerSearch')?.value || '').trim();
  const matches = collection.filter((i) => !q || searchKey(`${i.folder ? `${i.folder} ` : ''}${i.displayName || i.name}`).includes(q));
  if (collection.length && !matches.length) list.append(mk('div', { class: 'ws-empty-line', text: 'Nenhuma LUT para essa busca.' }));
  const shown = matches.slice(0, PICKER_MAX_ROWS);
  for (const item of shown) {
    const had = inProject(item);
    const checked = !had && pickerSelection.has(item.relPath);
    const label = item.displayName || item.name;
    const thumb = mk('span', { class: 'ws-lut-thumb ws-lut-thumb-small', 'data-thumb-key': thumbKey(item), 'data-thumb-path': item.path }, [icon('gradient')]);
    const row = mk('label', { class: `ws-import-item${checked ? ' checked' : ''}${had ? ' is-disabled' : ''}` }, [
      mk('input', {
        type: 'checkbox', checked, disabled: had, 'data-rel': item.relPath, 'aria-label': `Escolher ${label}`,
        onchange: (e) => {
          if (e.target.checked) pickerSelection.add(item.relPath); else pickerSelection.delete(item.relPath);
          row.classList.toggle('checked', e.target.checked);
          updatePickerCount();
        }
      }),
      thumb,
      mk('span', { class: 'ws-import-name', text: label, title: item.folder ? `${item.folder} / ${label}` : label }),
      mk('span', { class: 'ws-import-meta', text: had ? 'No projeto' : (item.folder ? item.folder.split('/').join(' / ') : '') })
    ]);
    list.append(row);
  }
  if (matches.length > shown.length) {
    list.append(mk('div', { class: 'ws-empty-line', text: `Mostrando ${shown.length} de ${matches.length}. Use a busca para achar as outras.` }));
  }
  observePickerThumbs(list);
  updatePickerCount();
}

function observePickerThumbs(list) {
  if (typeof IntersectionObserver === 'undefined') return;
  pickerObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      pickerObserver?.unobserve(entry.target);
      fillThumb(entry.target);
    }
  }, { root: list, rootMargin: '80px' });
  for (const el of list.querySelectorAll('.ws-lut-thumb[data-thumb-path]')) pickerObserver.observe(el);
}

function updatePickerCount() {
  const n = pickerSelection.size;
  const count = $('wsLutPickerCount');
  if (count) count.textContent = `${n} ${n === 1 ? 'selecionada' : 'selecionadas'}`;
  const btn = $('wsLutPickerConfirm');
  if (btn) {
    btn.textContent = n ? `Adicionar ${n}` : 'Adicionar';
    btn.disabled = n === 0 || pickerBusy;
  }
}

/** Texto do resultado: "3 LUTs adicionadas; 1 já estava no projeto." */
export function addSummary(res) {
  const lines = [];
  if (res.added) lines.push(`${plural(res.added, 'LUT adicionada', 'LUTs adicionadas')} ao projeto.`);
  if (res.already) lines.push(`${plural(res.already, 'LUT já estava', 'LUTs já estavam')} no projeto.`);
  if (res.overLimit) lines.push(`O projeto aceita até 100 LUTs; ${plural(res.overLimit, 'LUT não foi adicionada', 'LUTs não foram adicionadas')}.`);
  const invalid = Array.isArray(res.invalid) ? res.invalid : [];
  if (invalid.length) {
    const shown = invalid.slice(0, 3).map((i) => `${i.name} (${i.reason})`).join('; ');
    lines.push(`${plural(invalid.length, 'LUT não pôde ser adicionada', 'LUTs não puderam ser adicionadas')}: ${shown}${invalid.length > 3 ? ` e mais ${invalid.length - 3}` : ''}.`);
  }
  if (!lines.length) lines.push('Nenhuma LUT foi adicionada.');
  return lines.join(' ');
}

async function confirmPicker() {
  if (!pickerSelection.size || pickerBusy) return;
  pickerBusy = true;
  updatePickerCount();
  try {
    const res = await window.bds.addProjectLuts(ws.projectId, [...pickerSelection]);
    closePicker();
    const problem = res.overLimit || (res.invalid && res.invalid.length);
    setAppStatus(addSummary(res), res.added && !problem ? 'success' : 'warning');
    if (problem) window.bdsModal.alert(addSummary(res));
    await renderLuts();
    emitChange('luts'); // a atividade da Visão geral acompanha
  } catch (err) {
    setPickerNote(`Não foi possível adicionar: ${friendlyError(err)}`);
  } finally {
    pickerBusy = false;
    updatePickerCount();
  }
}
