/**
 * Aba Arquivos: estrutura de pastas à esquerda, mídias ao centro (busca, filtros, grade/lista, "Selecionar todos" e
 * Ctrl+A, seleção com barra de ações), detalhes do arquivo à direita (só quando há um clicado). Importação da Biblioteca
 * (janela), do computador (diálogo) e por arrastar — sempre perguntando em qual pasta colocar; reconexão de arquivos
 * ausentes; monitor de origem em sobreposição.
 */
import {
  ws, $, mk, icon, formatBytes, formatDuration, secondsToTimecode, extLabel, isPhoto, kindOf, nameOf,
  thumbCss, debounce, drawWaveform, synced, reloadMedia, reloadMissing, emitChange, setAppStatus, friendlyError, showMenu
} from './state.js';
import { openMonitor } from './monitor.js';

let dragged = null; // { type: 'media'|'bin'|'library', id }
let goTo = () => {};
let relinkResults = [];
let importSelection = new Set();
let pickResolve = null; // janela "Em qual pasta colocar?" aberta: quem espera a resposta

/** Liga os eventos aos elementos desta abertura (a tela é recriada a cada projeto aberto). */
export function bindFiles(navigate) {
  goTo = navigate;
  dragged = null; relinkResults = []; importSelection = new Set(); pickResolve = null;
  // selecionar todos (barra de filtros e cabeçalho da tabela) e, na Biblioteca, todas as mídias da lista
  $('wsSelectAll')?.addEventListener('change', (e) => setAllVisible(e.target.checked));
  $('wsSelectAllTable')?.addEventListener('change', (e) => setAllVisible(e.target.checked));
  $('wsImportSelectAll')?.addEventListener('change', (e) => setAllImport(e.target.checked));
  // janela "Em qual pasta colocar?"
  $('wsPickBinOk')?.addEventListener('click', () => finishPick(true));
  $('wsPickBinCancel')?.addEventListener('click', () => finishPick(false));
  $('wsPickBinClose')?.addEventListener('click', () => finishPick(false));
  $('wsPickBinSelect')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finishPick(true); } });
  $('wsFilesSearch')?.addEventListener('input', debounce((e) => { ws.query = e.target.value.trim().toLowerCase(); renderMedia(); }, 120));
  document.querySelectorAll('.ws-type-filter').forEach((b) => b.addEventListener('click', () => { ws.typeFilter = b.dataset.filter; renderMedia(); }));
  $('wsViewGrid')?.addEventListener('click', () => { ws.view = 'grid'; renderMedia(); });
  $('wsViewList')?.addEventListener('click', () => { ws.view = 'list'; renderMedia(); });
  $('wsBtnAddMenu')?.addEventListener('click', (e) => { e.stopPropagation(); openAddMenu(e.currentTarget); });
  $('wsBtnDefaultBins')?.addEventListener('click', createDefaultBins);
  $('wsMissingPill')?.addEventListener('click', openRelinkFlow);
  $('wsBtnCloseImportModal')?.addEventListener('click', closeImportModal);
  $('wsImportLibraryModal')?.addEventListener('click', (e) => { if (e.target.id === 'wsImportLibraryModal') closeImportModal(); });
  $('wsImportModalSearch')?.addEventListener('input', debounce(renderImportList, 120));
  $('wsBtnConfirmImportLibrary')?.addEventListener('click', confirmImportFromLibrary);
  $('wsBtnCloseRelinkModal')?.addEventListener('click', () => $('wsRelinkModal')?.classList.add('hidden'));
  $('wsBtnConfirmRelink')?.addEventListener('click', confirmRelink);
  // barra de seleção
  $('wsSelMove')?.addEventListener('click', moveSelection);
  $('wsSelSync')?.addEventListener('click', () => goTo('audio'));
  $('wsSelRemove')?.addEventListener('click', removeSelection);
  $('wsSelClear')?.addEventListener('click', () => { ws.selected.clear(); renderMedia(); });
  // inspetor
  $('wsInspOpenMonitor')?.addEventListener('click', () => { const pm = inspected(); if (pm) openMonitor(pm); });
  $('wsInspReveal')?.addEventListener('click', () => { const pm = inspected(); if (pm && pm.filepath) window.bds.modulesReveal?.(pm.filepath) || window.bds.openLocalPath?.(pm.filepath); });
  $('wsInspSaveName')?.addEventListener('click', saveInspectedName);
  $('wsInspClose')?.addEventListener('click', () => { ws.inspected = null; renderMedia(); });
  $('wsInspRemove')?.addEventListener('click', async () => { const pm = inspected(); if (!pm) return; ws.selected = new Set([pm.pm_id]); await removeSelection(); });
  $('wsBinRename')?.addEventListener('click', renameCurrentBin);
  $('wsBinDelete')?.addEventListener('click', deleteCurrentBin);
  setupDropzone();
}

const inspected = () => ws.media.find((m) => m.pm_id === ws.inspected) || null;

/** Menu "Adicionar": do computador, da Biblioteca ou uma pasta nova (também usado pelo botão do cabeçalho). */
export function openAddMenu(anchor, { withFolder = true } = {}) {
  const where = typeof ws.currentBin === 'number' ? (ws.bins.find((b) => b.id === ws.currentBin) || {}).name : '';
  const entries = [
    { icon: 'upload_file', label: 'Do computador…', sub: where ? `Vai para a pasta ${where}` : 'Escolha arquivos ou arraste para a lista', run: importFromComputer },
    { icon: 'video_library', label: 'Da Biblioteca…', sub: 'O que você já importou no app', run: openImportModal }
  ];
  if (withFolder) entries.push({ separator: true }, { icon: 'create_new_folder', label: 'Nova pasta…', sub: 'Uma para cada câmera ou gravador', run: newBin });
  showMenu(anchor, entries);
}

export function renderFiles() {
  renderStructure();
  renderMedia();
  renderMissing();
}

// ------------------------------------------------------------------ estrutura (pastas)

function countIn(binId) {
  const kids = (id) => ws.bins.filter((b) => b.parent_id === id).map((b) => b.id);
  const all = [binId]; for (let i = 0; i < all.length; i++) all.push(...kids(all[i]));
  const set = new Set(all);
  return ws.media.filter((m) => set.has(m.bin_id)).length;
}

function renderStructure() {
  const host = $('wsStructure');
  if (!host) return;
  host.textContent = '';
  const row = (label, key, count, ic, depth = 0, bin = null) => {
    const el = mk('button', { type: 'button', class: `ws-tree-row${ws.currentBin === key ? ' active' : ''}`, 'data-key': String(key) }, [
      icon(ic), mk('span', { class: 'ws-tree-name', text: label }), mk('span', { class: 'ws-tree-count', text: String(count) })
    ]);
    el.style.paddingLeft = `${10 + depth * 14}px`;
    el.addEventListener('click', () => { ws.currentBin = key; ws.selected.clear(); renderStructure(); renderMedia(); });
    if (bin) {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => { dragged = { type: 'bin', id: bin.id }; e.dataTransfer.effectAllowed = 'move'; });
    }
    el.addEventListener('dragover', (e) => { if (dragged) { e.preventDefault(); el.classList.add('drag-over'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('drag-over'); handleDrop(bin ? bin.id : null); });
    return el;
  };
  host.append(row('Todos os arquivos', 'all', ws.media.length, 'perm_media'));
  const walk = (parentId, depth) => {
    for (const b of ws.bins.filter((x) => (x.parent_id || null) === parentId).sort((a, c) => a.name.localeCompare(c.name, 'pt-BR'))) {
      host.append(row(b.name, b.id, countIn(b.id), 'folder', depth, b));
      walk(b.id, depth + 1);
    }
  };
  walk(null, 0);
  const unfiled = ws.media.filter((m) => !m.bin_id).length;
  host.append(row('Sem pasta', 'unfiled', unfiled, 'folder_off'));
  $('wsBtnDefaultBins')?.classList.toggle('hidden', ws.bins.length > 0);
  const cur = typeof ws.currentBin === 'number' ? ws.bins.find((b) => b.id === ws.currentBin) : null;
  $('wsBinTools')?.classList.toggle('hidden', !cur);
}

async function newBin() {
  const parentId = typeof ws.currentBin === 'number' ? ws.currentBin : null;
  const name = await window.bdsModal.prompt(parentId ? 'Nome da subpasta:' : 'Nome da pasta:');
  if (!name || !name.trim()) return;
  try { const id = await window.bds.createProjectBin(ws.projectId, parentId, name.trim()); await refresh(); ws.currentBin = id; renderFiles(); }
  catch (e) { window.bdsModal.alert(`Não foi possível criar a pasta: ${friendlyError(e)}`); }
}

async function createDefaultBins() {
  try {
    const created = await window.bds.createProjectDefaultBins(ws.projectId);
    await refresh();
    setAppStatus(created.length ? `Estrutura criada: ${created.join(', ')}.` : 'A estrutura já existia.', 'success');
    renderFiles();
  } catch (e) { window.bdsModal.alert(`Não foi possível criar a estrutura: ${friendlyError(e)}`); }
}

async function renameCurrentBin() {
  const bin = ws.bins.find((b) => b.id === ws.currentBin);
  if (!bin) return;
  const name = await window.bdsModal.prompt('Novo nome da pasta:', bin.name);
  if (!name || !name.trim() || name.trim() === bin.name) return;
  try { await window.bds.updateProjectBin(bin.id, name.trim(), bin.parent_id); await refresh(); renderFiles(); }
  catch (e) { window.bdsModal.alert(`Não foi possível renomear: ${friendlyError(e)}`); }
}

async function deleteCurrentBin() {
  const bin = ws.bins.find((b) => b.id === ws.currentBin);
  if (!bin) return;
  const n = countIn(bin.id);
  const ok = await window.bdsModal.confirm(`Excluir a pasta "${bin.name}"?${n ? `\n\n${n} ${n === 1 ? 'arquivo sai' : 'arquivos saem'} do projeto (continuam na Biblioteca e no disco).` : ''}`);
  if (!ok) return;
  try { await window.bds.deleteProjectBin(bin.id); ws.currentBin = 'all'; await refresh(); renderFiles(); }
  catch (e) { window.bdsModal.alert(`Não foi possível excluir: ${friendlyError(e)}`); }
}

// ------------------------------------------------------------------ mídias

function inCurrentBin(m) {
  if (ws.currentBin === 'all') return true;
  if (ws.currentBin === 'unfiled') return !m.bin_id;
  const kids = (id) => ws.bins.filter((b) => b.parent_id === id).map((b) => b.id);
  const all = [ws.currentBin]; for (let i = 0; i < all.length; i++) all.push(...kids(all[i]));
  return all.includes(m.bin_id);
}
function matches(m) {
  if (!inCurrentBin(m)) return false;
  if (ws.typeFilter !== 'all' && kindOf(m) !== ws.typeFilter) return false;
  if (ws.query && !nameOf(m).toLowerCase().includes(ws.query) && !(m.filename || '').toLowerCase().includes(ws.query)) return false;
  return true;
}

function renderMedia() {
  const grid = $('wsMediaGrid'); const table = $('wsMediaTableBody');
  if (!grid || !table) return;
  document.querySelectorAll('.ws-type-filter').forEach((b) => b.classList.toggle('active', b.dataset.filter === ws.typeFilter));
  $('wsViewGrid')?.classList.toggle('active', ws.view === 'grid');
  $('wsViewList')?.classList.toggle('active', ws.view === 'list');
  $('wsMediaGrid')?.classList.toggle('hidden', ws.view !== 'grid');
  $('wsMediaTable')?.classList.toggle('hidden', ws.view !== 'list');
  const list = ws.media.filter(matches);
  const syncSet = synced();
  grid.textContent = ''; table.textContent = '';
  const title = $('wsFilesTitle');
  if (title) {
    const cur = typeof ws.currentBin === 'number' ? ws.bins.find((b) => b.id === ws.currentBin) : null;
    title.textContent = cur ? cur.name : ws.currentBin === 'unfiled' ? 'Sem pasta' : 'Todos os arquivos';
  }
  const count = $('wsFilesCount');
  if (count) count.textContent = `${list.length} ${list.length === 1 ? 'arquivo' : 'arquivos'}`;
  if (!list.length) {
    grid.append(mk('div', { class: 'bds-empty ws-files-empty' }, [
      mk('span', { class: 'material-symbols-rounded bds-empty-icon', 'aria-hidden': 'true', text: ws.media.length ? 'search_off' : 'upload_file' }),
      mk('strong', { class: 'bds-empty-title', text: ws.media.length ? 'Nenhum arquivo aqui' : 'Nenhum arquivo no projeto ainda' }),
      mk('span', { class: 'bds-empty-text', text: ws.media.length ? 'Tente outra pasta, filtro ou busca.' : 'Use "Adicionar" ou solte arquivos aqui. Dica: uma pasta para cada câmera facilita a sincronização.' })
    ]));
  }
  for (const pm of list) {
    grid.append(mediaCard(pm, syncSet));
    table.append(mediaRow(pm, syncSet));
  }
  grid.append(mk('div', { class: 'ws-drop-hint', text: 'Solte arquivos aqui para adicionar ao projeto' }));
  renderSelectionBar();
  renderInspector();
}

function stateLine(pm, syncSet) {
  const parts = [];
  if (!isPhoto(pm) && pm.duration) parts.push(formatDuration(pm.duration));
  if (pm.width && pm.height) parts.push(pm.height >= 2160 ? '4K' : pm.height >= 1080 ? 'Full HD' : pm.height >= 720 ? 'HD' : `${pm.width}×${pm.height}`);
  if (syncSet.has(pm.id)) parts.push('sincronizado');
  if (pm.missing) parts.push('ausente');
  return parts.join(' · ');
}

function mediaCard(pm, syncSet) {
  const kind = kindOf(pm);
  const thumb = mk('div', { class: `ws-media-thumb${kind === 'audio' ? ' is-audio' : ''}` });
  const bg = thumbCss(pm);
  if (bg) thumb.style.backgroundImage = bg;
  else if (kind === 'audio') { const c = mk('canvas', { class: 'ws-media-wave', height: '60' }); thumb.append(c); loadWave(pm, c, 40); }
  else thumb.append(icon(kind === 'photo' ? 'image' : 'movie'));
  const card = mk('div', {
    class: `ws-media-card${ws.selected.has(pm.pm_id) ? ' selected' : ''}${ws.inspected === pm.pm_id ? ' inspected' : ''}${pm.missing ? ' is-missing' : ''}`,
    tabindex: '0', role: 'option', 'aria-selected': String(ws.selected.has(pm.pm_id)), 'data-pm': pm.pm_id
  }, [
    mk('label', { class: 'ws-media-check' }, [mk('input', { type: 'checkbox', checked: ws.selected.has(pm.pm_id), 'aria-label': `Selecionar ${nameOf(pm)}`, onclick: (e) => e.stopPropagation(), onchange: (e) => { toggleSelect(pm.pm_id, e.target.checked); } })]),
    thumb,
    mk('div', { class: 'ws-media-name', text: nameOf(pm), title: nameOf(pm) }),
    mk('div', { class: `ws-media-state${pm.missing ? ' tone-warn' : ''}`, text: stateLine(pm, syncSet) || extLabel(pm) })
  ]);
  card.draggable = true;
  card.addEventListener('dragstart', (e) => { e.stopPropagation(); dragged = { type: 'media', id: pm.pm_id }; e.dataTransfer.effectAllowed = 'move'; });
  card.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) { toggleSelect(pm.pm_id, !ws.selected.has(pm.pm_id)); return; }
    ws.inspected = pm.pm_id; renderMedia();
  });
  card.addEventListener('dblclick', () => openMonitor(pm));
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openMonitor(pm); if (e.key === ' ') { e.preventDefault(); toggleSelect(pm.pm_id, !ws.selected.has(pm.pm_id)); } });
  return card;
}

function mediaRow(pm, syncSet) {
  const kind = kindOf(pm);
  const binName = pm.bin_id ? (ws.bins.find((b) => b.id === pm.bin_id) || {}).name : '—';
  const tr = mk('tr', { class: `${ws.selected.has(pm.pm_id) ? 'selected' : ''}${ws.inspected === pm.pm_id ? ' inspected' : ''}`, tabindex: '0' }, [
    mk('td', {}, [mk('input', { type: 'checkbox', checked: ws.selected.has(pm.pm_id), 'aria-label': `Selecionar ${nameOf(pm)}`, onclick: (e) => e.stopPropagation(), onchange: (e) => toggleSelect(pm.pm_id, e.target.checked) })]),
    mk('td', {}, [mk('div', { class: 'ws-td-name' }, [icon(kind === 'audio' ? 'mic' : kind === 'photo' ? 'image' : 'movie'), mk('span', { text: nameOf(pm), title: nameOf(pm) })])]),
    mk('td', { text: binName || '—' }),
    mk('td', { class: 'ws-td-num', text: !isPhoto(pm) && pm.duration ? formatDuration(pm.duration) : '—' }),
    mk('td', { text: pm.width && pm.height ? `${pm.width}×${pm.height}` : '—' }),
    mk('td', { class: 'ws-td-num', text: formatBytes(pm.filesize) }),
    mk('td', { class: pm.missing ? 'tone-warn' : '', text: pm.missing ? 'ausente' : syncSet.has(pm.id) ? 'sincronizado' : '' })
  ]);
  tr.addEventListener('click', (e) => { if (e.ctrlKey || e.metaKey) { toggleSelect(pm.pm_id, !ws.selected.has(pm.pm_id)); return; } ws.inspected = pm.pm_id; renderMedia(); });
  tr.addEventListener('dblclick', () => openMonitor(pm));
  tr.draggable = true;
  tr.addEventListener('dragstart', (e) => { dragged = { type: 'media', id: pm.pm_id }; e.dataTransfer.effectAllowed = 'move'; });
  return tr;
}

function loadWave(pm, canvas, pps) {
  if (!pm.uuid || !pm.filepath || !window.bds?.getMediaWaveform) return;
  requestAnimationFrame(() => {
    window.bds.getMediaWaveform({ uuid: pm.uuid, filePath: pm.filepath, duration: pm.duration || 0, peaksPerSecond: pps, streamIndex: 0 })
      .then((wf) => { if (wf && wf.peaks) drawWaveform(canvas, wf.peaks); }).catch(() => {});
  });
}

const visibleMedia = () => ws.media.filter(matches);

/** Marca (ou desmarca) todos os arquivos visíveis: pasta aberta + filtro de tipo + busca. */
function setAllVisible(on) {
  for (const m of visibleMedia()) { if (on) ws.selected.add(m.pm_id); else ws.selected.delete(m.pm_id); }
  renderMedia();
}

/** Ctrl+A na aba Arquivos (fora de campos de texto). */
export function selectAllVisible() { setAllVisible(true); }

/** As caixas "Selecionar todos" acompanham a seleção: marcada (todos), traço (alguns) ou vazia. */
function syncSelectAll() {
  const list = visibleMedia();
  const n = list.filter((m) => ws.selected.has(m.pm_id)).length;
  for (const id of ['wsSelectAll', 'wsSelectAllTable']) {
    const cb = $(id);
    if (!cb) continue;
    cb.checked = list.length > 0 && n === list.length;
    cb.indeterminate = n > 0 && n < list.length;
    cb.disabled = list.length === 0;
  }
}

function toggleSelect(pmId, on) {
  if (on) ws.selected.add(pmId); else ws.selected.delete(pmId);
  renderMedia();
}

function renderSelectionBar() {
  const bar = $('wsSelectionBar');
  if (!bar) return;
  const n = ws.selected.size;
  bar.classList.toggle('hidden', n === 0);
  const total = visibleMedia().length;
  const t = $('wsSelCount');
  if (t) t.textContent = n > 1 && n === total ? `Todos os ${n} selecionados` : `${n} ${n === 1 ? 'selecionado' : 'selecionados'}`;
  syncSelectAll();
}

async function moveSelection() {
  if (!ws.selected.size) return;
  const options = [{ id: null, name: 'Sem pasta' }, ...ws.bins.map((b) => ({ id: b.id, name: pathOf(b) }))];
  const choice = await window.bdsModal.prompt(`Mover ${ws.selected.size} ${ws.selected.size === 1 ? 'arquivo' : 'arquivos'} para qual pasta?\n\n${options.map((o, i) => `${i}: ${o.name}`).join('\n')}\n\nDigite o número:`, '');
  if (choice === null || choice === '') return;
  const idx = Number(choice);
  if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) { window.bdsModal.alert('Número inválido.'); return; }
  try {
    for (const pmId of ws.selected) await window.bds.moveProjectMedia(pmId, options[idx].id);
    await refresh(); renderFiles();
  } catch (e) { window.bdsModal.alert(`Não foi possível mover: ${friendlyError(e)}`); }
}
const pathOf = (b) => { const parts = [b.name]; let p = b.parent_id; let guard = 0; while (p && guard++ < 20) { const pb = ws.bins.find((x) => x.id === p); if (!pb) break; parts.unshift(pb.name); p = pb.parent_id; } return parts.join(' / '); };

async function removeSelection() {
  if (!ws.selected.size) return;
  const ok = await window.bdsModal.confirm(`Remover ${ws.selected.size} ${ws.selected.size === 1 ? 'arquivo' : 'arquivos'} do projeto?\n\nOs arquivos continuam na Biblioteca e no disco.`);
  if (!ok) return;
  try {
    for (const pmId of ws.selected) await window.bds.removeProjectMedia(pmId);
    ws.selected.clear(); ws.inspected = null;
    await refresh(); renderFiles();
  } catch (e) { window.bdsModal.alert(`Não foi possível remover: ${friendlyError(e)}`); }
}

// ------------------------------------------------------------------ inspetor

function renderInspector() {
  const pm = inspected();
  // o painel de detalhes só ocupa espaço quando há um arquivo clicado
  $('wsFilesLayout')?.classList.toggle('has-inspector', !!pm);
  $('wsInspEmpty')?.classList.add('hidden');
  $('wsInspBody')?.classList.toggle('hidden', !pm);
  if (!pm) return;
  const kind = kindOf(pm);
  const prev = $('wsInspPreview');
  prev.textContent = '';
  const bg = thumbCss(pm);
  prev.style.backgroundImage = bg || 'none';
  if (!bg) prev.append(icon(kind === 'audio' ? 'graphic_eq' : kind === 'photo' ? 'image' : 'movie'));
  $('wsInspName').value = nameOf(pm);
  $('wsInspFolder').textContent = pm.bin_id ? pathOf(ws.bins.find((b) => b.id === pm.bin_id) || { name: '—' }) : 'Sem pasta';
  const rows = [
    ['Duração', !isPhoto(pm) && pm.duration ? secondsToTimecode(pm.duration, pm.fps || 30) : '—'],
    ['Resolução', pm.width && pm.height ? `${pm.width}×${pm.height}${pm.fps ? ` · ${pm.fps} fps` : ''}` : '—'],
    ['Tamanho', formatBytes(pm.filesize)],
    ['Codecs', [pm.video_codec, pm.audio_codec].filter(Boolean).join(' / ') || '—'],
    ['Gravado em', pm.recorded_at ? new Date(String(pm.recorded_at).replace(' ', 'T') + (String(pm.recorded_at).includes('Z') ? '' : 'Z')).toLocaleString('pt-BR') : '—'],
    ['Câmera', pm.bdsm_camera || '—'],
    ['Perfil / LUT', [pm.bdsm_profile, pm.bdsm_lut].filter(Boolean).join(' · ') || '—'],
    ['Local', pm.filepath || '—']
  ];
  const dl = $('wsInspRows'); dl.textContent = '';
  for (const [k, v] of rows) dl.append(mk('div', { class: 'ws-insp-row' }, [mk('span', { class: 'ws-insp-k', text: k }), mk('span', { class: `ws-insp-v${k === 'Local' ? ' is-path' : ''}`, text: v, title: v })]));
  const links = $('wsInspLinks'); links.textContent = '';
  if (synced().has(pm.id)) links.append(mk('span', { class: 'tone-ok' }, [icon('check_circle'), ' Sincronizado']));
  if (pm.missing) links.append(mk('span', { class: 'tone-warn' }, [icon('link_off'), ' Arquivo não encontrado']));
}

async function saveInspectedName() {
  const pm = inspected(); if (!pm) return;
  const name = $('wsInspName').value.trim();
  if (!name) return;
  try {
    // custom_name vive em project_media: o canal addProjectMedia reaproveita o vínculo e grava o nome
    await window.bds.addProjectMedia(ws.projectId, pm.bin_id, pm.id, name);
    await refresh(); renderFiles();
    setAppStatus('Nome salvo.', 'success');
  } catch (e) { window.bdsModal.alert(`Não foi possível salvar o nome: ${friendlyError(e)}`); }
}

// ------------------------------------------------------------------ arrastar e soltar

async function handleDrop(targetBinId) {
  if (!dragged) return;
  const item = dragged; dragged = null;
  try {
    if (item.type === 'library') await window.bds.addProjectMedia(ws.projectId, targetBinId, item.id, null);
    else if (item.type === 'media') {
      const ids = ws.selected.has(item.id) ? [...ws.selected] : [item.id];
      for (const id of ids) await window.bds.moveProjectMedia(id, targetBinId);
    } else if (item.type === 'bin' && targetBinId !== item.id) {
      const bin = ws.bins.find((b) => b.id === item.id);
      if (bin) await window.bds.updateProjectBin(bin.id, bin.name, targetBinId);
    }
  } catch (e) { window.bdsModal.alert(`Não foi possível mover: ${friendlyError(e)}`); }
  await refresh(); renderFiles();
}

function setupDropzone() {
  const pane = $('wsFilesCenter'); const overlay = $('wsDropOverlay');
  if (!pane || !overlay) return;
  let depth = 0;
  pane.addEventListener('dragenter', (e) => { if (!e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); depth++; overlay.classList.remove('hidden'); });
  pane.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files') || dragged) e.preventDefault(); });
  pane.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.classList.add('hidden'); });
  pane.addEventListener('drop', async (e) => {
    depth = 0; overlay.classList.add('hidden');
    if (e.dataTransfer?.files?.length) {
      e.preventDefault(); e.stopPropagation();
      const paths = [];
      for (const f of e.dataTransfer.files) { try { const p = window.bds.getPathForFile(f); if (p) paths.push(p); } catch (_) { /* ignora */ } }
      if (!paths.length) return;
      const binId = await pickBin(`${paths.length} ${paths.length === 1 ? 'arquivo vai ser adicionado' : 'arquivos vão ser adicionados'} ao projeto.`);
      if (binId === undefined) return;
      setAppStatus(`Importando ${paths.length} ${paths.length === 1 ? 'arquivo' : 'arquivos'}…`, 'info');
      try { showBin(binId); await handleImportResult(await window.bds.importDroppedFilesToProjectBin(ws.projectId, binId, paths)); }
      catch (err) { window.bdsModal.alert(`Erro ao importar: ${friendlyError(err)}`); }
    } else if (dragged && dragged.type === 'media') {
      e.preventDefault();
      // solto na área de mídias: vai para a pasta aberta
      handleDrop(typeof ws.currentBin === 'number' ? ws.currentBin : null);
    }
  });
}

// ------------------------------------------------------------------ pasta de destino

const NEW_BIN = '__nova';

/** Preenche um <select> com "Sem pasta", as pastas do projeto (caminho completo) e "Nova pasta…". */
function fillBinSelect(select, selected) {
  if (!select) return;
  select.textContent = '';
  select.append(mk('option', { value: '', text: 'Sem pasta' }));
  const bins = ws.bins.slice().sort((a, b) => pathOf(a).localeCompare(pathOf(b), 'pt-BR'));
  for (const b of bins) select.append(mk('option', { value: String(b.id), text: pathOf(b) }));
  select.append(mk('option', { value: NEW_BIN, text: '+ Nova pasta…' }));
  select.value = selected === null || selected === undefined ? '' : String(selected);
}

/** A pasta sugerida: a aberta na lista (ou nenhuma, em "Todos os arquivos" / "Sem pasta"). */
const suggestedBin = () => (typeof ws.currentBin === 'number' ? ws.currentBin : null);

/** Valor escolhido → id da pasta (null = sem pasta; undefined = desistiu ao criar uma nova). */
async function resolveBin(value) {
  if (value !== NEW_BIN) return value === '' ? null : Number(value);
  const name = await window.bdsModal.prompt('Nome da nova pasta:');
  if (!name || !String(name).trim()) return undefined;
  try {
    const id = await window.bds.createProjectBin(ws.projectId, null, String(name).trim());
    await refresh();
    return id;
  } catch (e) { window.bdsModal.alert(`Não foi possível criar a pasta: ${friendlyError(e)}`); return undefined; }
}

/**
 * Pergunta em qual pasta colocar o que vai ser importado. Resolve com o id da pasta, null (sem pasta) ou undefined
 * (cancelou).
 */
function pickBin(text) {
  if (pickResolve) finishPick(false);
  fillBinSelect($('wsPickBinSelect'), suggestedBin());
  const t = $('wsPickBinText'); if (t) t.textContent = text || '';
  $('wsPickBinModal')?.classList.remove('hidden');
  setTimeout(() => { try { $('wsPickBinSelect')?.focus(); } catch (_) { /* tela já fechada */ } }, 30);
  return new Promise((resolve) => { pickResolve = resolve; });
}

async function finishPick(ok) {
  const resolve = pickResolve;
  pickResolve = null;
  $('wsPickBinModal')?.classList.add('hidden');
  if (!resolve) return;
  if (!ok) { resolve(undefined); return; }
  resolve(await resolveBin($('wsPickBinSelect')?.value ?? ''));
}

/** Depois de importar, abre a pasta de destino para o usuário ver o que entrou. */
function showBin(binId) { ws.currentBin = binId === null || binId === undefined ? 'unfiled' : binId; ws.selected.clear(); }

// ------------------------------------------------------------------ importação

async function importFromComputer() {
  try {
    const binId = await pickBin('Escolha a pasta e, em seguida, os arquivos no computador.');
    if (binId === undefined) return;
    const result = await window.bds.importFilesToProjectBin(ws.projectId, binId);
    if (result && result.imported) showBin(binId);
    await handleImportResult(result);
  } catch (e) { window.bdsModal.alert(`Erro ao importar: ${friendlyError(e)}`); }
}

async function handleImportResult(result) {
  if (!result) return;
  const { imported = 0, skipped = 0, failed = 0, total = 0 } = result;
  setAppStatus(imported ? `${imported} ${imported === 1 ? 'arquivo importado' : 'arquivos importados'}.` : 'Nenhum arquivo novo foi importado.', imported ? 'success' : 'info');
  if (skipped || failed) {
    const parts = [];
    if (skipped) parts.push(`${skipped} ${skipped === 1 ? 'ignorado' : 'ignorados'} (já existentes ou não suportados)`);
    if (failed) parts.push(`${failed} com erro`);
    window.bdsModal.alert(`Importação: ${imported} de ${total}.\n${parts.join(' · ')}`);
  }
  await refresh(); renderFiles();
}

async function openImportModal() {
  importSelection = new Set();
  try { const res = await window.bds.searchLibrary({ limit: 1000 }); ws.library = Array.isArray(res) ? res : ((res && res.items) || []); } catch (_) { ws.library = []; }
  fillBinSelect($('wsImportModalBin'), suggestedBin());
  renderImportList();
  $('wsImportLibraryModal')?.classList.remove('hidden');
  $('wsImportModalSearch')?.focus();
}
function closeImportModal() { $('wsImportLibraryModal')?.classList.add('hidden'); }

/** Mídias da Biblioteca que ainda não estão no projeto e batem com a busca da janela. */
function importAvailable() {
  const q = ($('wsImportModalSearch')?.value || '').toLowerCase();
  const inProject = new Set(ws.media.map((m) => m.id));
  return ws.library.filter((m) => !inProject.has(m.id) && (m.filename || '').toLowerCase().includes(q));
}

function setAllImport(on) {
  for (const m of importAvailable()) { if (on) importSelection.add(m.id); else importSelection.delete(m.id); }
  renderImportList();
}

function renderImportList() {
  const list = $('wsImportModalList'); if (!list) return;
  const q = ($('wsImportModalSearch')?.value || '').toLowerCase();
  const available = importAvailable();
  list.textContent = '';
  if (!available.length) list.append(mk('div', { class: 'ws-empty-line', text: q ? 'Nenhuma mídia para essa busca.' : 'Todas as mídias da Biblioteca já estão no projeto.' }));
  for (const m of available) {
    const row = mk('label', { class: `ws-import-item${importSelection.has(m.id) ? ' checked' : ''}` }, [
      mk('input', { type: 'checkbox', checked: importSelection.has(m.id), onchange: (e) => { if (e.target.checked) importSelection.add(m.id); else importSelection.delete(m.id); row.classList.toggle('checked', e.target.checked); updateImportCount(); } }),
      (() => { const t = mk('span', { class: 'ws-import-thumb' }); const bg = thumbCss(m); if (bg) t.style.backgroundImage = bg; return t; })(),
      mk('span', { class: 'ws-import-name', text: m.filename, title: m.filename }),
      mk('span', { class: 'ws-import-meta', text: `${formatBytes(m.filesize)} · ${extLabel(m)}` })
    ]);
    list.append(row);
  }
  updateImportCount();
}
function updateImportCount() {
  const c = $('wsImportModalCount'); if (c) c.textContent = `${importSelection.size} ${importSelection.size === 1 ? 'selecionada' : 'selecionadas'}`;
  const all = $('wsImportSelectAll');
  if (all) {
    const available = importAvailable();
    const n = available.filter((m) => importSelection.has(m.id)).length;
    all.checked = available.length > 0 && n === available.length;
    all.indeterminate = n > 0 && n < available.length;
    all.disabled = available.length === 0;
  }
}

async function confirmImportFromLibrary() {
  if (!importSelection.size) { setAppStatus('Marque as mídias que vão para o projeto.', 'info'); return; }
  try {
    const binId = await resolveBin($('wsImportModalBin')?.value ?? '');
    if (binId === undefined) return;
    await window.bds.addProjectMediaBulk(ws.projectId, binId, [...importSelection]);
    showBin(binId);
    setAppStatus(`${importSelection.size} ${importSelection.size === 1 ? 'mídia adicionada' : 'mídias adicionadas'} ao projeto.`, 'success');
    closeImportModal();
    await refresh(); renderFiles();
  } catch (e) { window.bdsModal.alert(`Não foi possível adicionar: ${friendlyError(e)}`); }
}

// ------------------------------------------------------------------ ausentes / reconexão

function renderMissing() {
  const pill = $('wsMissingPill');
  if (!pill) return;
  const n = ws.missing.length;
  pill.classList.toggle('hidden', n === 0);
  if (n) pill.textContent = `${n} ${n === 1 ? 'ausente' : 'ausentes'} · localizar`;
}

async function openRelinkFlow() {
  if (!ws.missing.length) { setAppStatus('Nenhum arquivo ausente para reconectar.', 'info'); return; }
  const folder = await window.bds.selectFolder();
  const dir = Array.isArray(folder) ? folder[0] : folder;
  if (!dir) return;
  setAppStatus('Procurando arquivos na pasta…', 'info');
  try {
    const scanned = await window.bds.scanRelinkFolder(dir);
    const missingList = ws.missing.map((m) => ({ media_id: m.id, filename: m.filename, original_path: m.filepath, filesize: m.filesize }));
    const matches = await window.bds.matchMissingMedia(missingList, scanned);
    relinkResults = matches.map((r) => ({ media_id: r.missing.media_id, filename: r.missing.filename, resolvedPath: r.resolved && r.matched ? r.matched.filepath : null, matched: r.matched, confidence: r.confidence, resolved: r.resolved }));
    renderRelinkList();
    $('wsRelinkModal')?.classList.remove('hidden');
    setAppStatus(`${scanned.length} ${scanned.length === 1 ? 'arquivo encontrado' : 'arquivos encontrados'} na pasta. Revise antes de confirmar.`, 'success');
  } catch (e) { window.bdsModal.alert(`Erro ao procurar arquivos: ${friendlyError(e)}`); }
}

function renderRelinkList() {
  const list = $('wsRelinkList'); if (!list) return;
  list.textContent = '';
  relinkResults.forEach((r, index) => {
    let ic; let cls; let status;
    if (r.resolvedPath && r.resolved) { ic = 'check_circle'; cls = 'resolved'; status = `Encontrado (${r.confidence}% de confiança) — ${r.matched.filename}`; }
    else if (r.resolvedPath) { ic = 'check_circle'; cls = 'resolved'; status = `Escolhido manualmente — ${r.matched?.filename || r.resolvedPath.split(/[\\/]/).pop()}`; }
    else if (r.matched) { ic = 'help'; cls = 'uncertain'; status = `Possível correspondência (${r.confidence}%) — ${r.matched.filename}. Confirme manualmente.`; }
    else { ic = 'search_off'; cls = ''; status = 'Nenhuma correspondência encontrada.'; }
    list.append(mk('div', { class: 'ws-relink-row' }, [
      mk('span', { class: `material-symbols-rounded ws-relink-icon ${cls}`, text: ic }),
      mk('div', { class: 'ws-relink-info' }, [mk('span', { class: 'ws-relink-name', text: r.filename, title: r.filename }), mk('span', { class: `ws-relink-status ${cls}`, text: status })]),
      mk('button', { type: 'button', class: 'ws-btn-outline', onclick: () => pickRelinkFile(index) }, 'Escolher arquivo…')
    ]));
  });
  const c = $('wsRelinkCount'); if (c) c.textContent = `${relinkResults.filter((r) => r.resolvedPath).length} de ${relinkResults.length} resolvidos`;
}

async function pickRelinkFile(index) {
  try {
    const result = await window.bds.selectFile({ properties: ['openFile'] });
    const fp = Array.isArray(result) ? result[0] : result;
    if (!fp) return;
    relinkResults[index].resolvedPath = fp;
    relinkResults[index].matched = { filename: fp.split(/[\\/]/).pop() };
    relinkResults[index].resolved = true;
    renderRelinkList();
  } catch (_) { /* cancelou */ }
}

async function confirmRelink() {
  const apply = relinkResults.filter((r) => r.resolvedPath);
  if (!apply.length) { setAppStatus('Nenhum arquivo resolvido para reconectar.', 'info'); return; }
  try {
    for (const r of apply) await window.bds.relinkMedia(r.media_id, r.resolvedPath);
    $('wsRelinkModal')?.classList.add('hidden');
    setAppStatus(`${apply.length} ${apply.length === 1 ? 'arquivo reconectado' : 'arquivos reconectados'}.`, 'success');
    await refresh(); renderFiles();
  } catch (e) { window.bdsModal.alert(`Erro ao reconectar: ${friendlyError(e)}`); }
}

async function refresh() {
  await reloadMedia();
  await reloadMissing();
  emitChange('media');
}
