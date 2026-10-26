/**
 * Tela "Projetos" (.docs/BDS_TELA_PROJETOS.md): abas de situação com contagem, aviso de prazo próximo,
 * "Continuar de onde parou" (os 3 projetos com atividade mais recente, com o próximo passo de cada um) e a lista
 * dos demais em grade ou tabela; um botão principal "Novo projeto" (Importar fica no menu ▾ dele); formulário curto
 * (nome, cliente, prazo e pastas padrão; o resto em "Mais detalhes"); menu ⋮ por projeto. Abrir um projeto leva à
 * área interna (project_workspace). Textos entram por textContent.
 */

import { setAppStatus } from '../app.js';
import { enhanceModals } from '../utils/modal.js';
import { friendlyError } from '../utils/friendlyError.js';
import { daysUntilLocal, formatLocalDate } from '../utils/localDate.js';
import { toFileUrl } from '../utils/fileUrl.js';
import { setContextProvider } from '../utils/assistantContext.js';
import { STATUSES, STATUS_FILTERS, ACTIVE_STATUSES, normalizeStatus, statusInfo } from '../utils/projectStatus.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_COLOR = '#3b82f6';

/** Só aceita cor hexadecimal (#rgb, #rgba, #rrggbb, #rrggbbaa); qualquer outra coisa vira o padrão. */
function safeHexColor(value, fallback = DEFAULT_COLOR) {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ? value : fallback;
}

/** Os diálogos devolvem string, array de caminhos ou { filePaths }: normaliza para o 1º caminho (ou null). */
function firstDialogPath(res) {
  if (!res) return null;
  if (typeof res === 'string') return res;
  const list = Array.isArray(res) ? res : (res.canceled ? [] : res.filePaths);
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'disabled') el.disabled = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of (Array.isArray(children) ? children : [children])) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const icon = (name) => h('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true', text: name });

let projectsList = [];
let selectedProjectId = null;
let query = '';
let filter = 'active';   // a lista abre só com o que está em andamento
let sort = 'deadline';   // o que vence primeiro
let view = 'grid';       // 'grid' | 'list'
let formCoverPath = '';
let bound = false;
const VIEW_KEY = 'bds.projects.view';

export function initScreen() {
  // Assistente de IA: o projeto selecionado na lista entra no contexto da tela (só o id)
  setContextProvider('projectSelected', () => selectedProjectId);
  try { view = localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch (_) { /* sem armazenamento */ }
  bindOnce();
  applyTabs();
  if ($('projSort')) $('projSort').value = sort;
  applyView();
  loadProjects();
  enhanceModals($('projectsView') || document, '.proj-modal-overlay');
}

function applyView() {
  $('projViewGrid')?.classList.toggle('active', view === 'grid');
  $('projViewList')?.classList.toggle('active', view === 'list');
  $('projViewGrid')?.setAttribute('aria-pressed', String(view === 'grid'));
  $('projViewList')?.setAttribute('aria-pressed', String(view === 'list'));
  $('projectsGrid')?.classList.toggle('hidden', view !== 'grid');
  $('projectsTable')?.classList.toggle('hidden', view !== 'list');
}

export async function onEnter() {
  await loadProjects();
}

export function onKeyDown(e) {
  if (e.key === 'Escape') { hideMenu(); }
}

// ------------------------------------------------------------------ utilitários

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// Datas 'YYYY-MM-DD' são dias de calendário: o parse como data local fica em utils/localDate.js
const formatDate = (iso) => formatLocalDate(iso);

/** Selo de prazo: texto e tom (cor só por --status-*). */
function deadlinePill(deadline, status) {
  if (!deadline) return { text: 'Sem prazo', tone: 'muted', icon: 'schedule' };
  if (status === 'Concluído' || status === 'Arquivado') return { text: `Entrega ${formatDate(deadline)}`, tone: 'muted', icon: 'event_available' };
  const d = daysUntilLocal(deadline);
  if (d === null) return { text: 'Sem prazo', tone: 'muted', icon: 'schedule' };
  if (d < 0) return { text: `${Math.abs(d)} ${Math.abs(d) === 1 ? 'dia' : 'dias'} de atraso`, tone: 'bad', icon: 'error' };
  if (d === 0) return { text: 'Entrega hoje', tone: 'bad', icon: 'warning' };
  if (d === 1) return { text: 'Entrega amanhã', tone: 'warn', icon: 'warning' };
  if (d <= 5) return { text: `Entrega em ${d} dias`, tone: 'warn', icon: 'schedule' };
  return { text: `Entrega ${formatDate(deadline)}`, tone: 'ok', icon: 'event' };
}

/** "Hoje, 22:41", "Ontem", "12/03/2026" a partir de um DATETIME do banco (UTC). */
function relativeActivity(value) {
  if (!value) return '';
  const d = new Date(String(value).includes('T') ? value : `${value}Z`.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Hoje, ${hm}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Ontem, ${hm}`;
  return d.toLocaleDateString('pt-BR');
}

// ------------------------------------------------------------------ dados

async function loadProjects() {
  const grid = $('projectsGrid');
  try {
    if (grid && projectsList.length === 0) {
      grid.setAttribute('aria-busy', 'true');
      grid.textContent = '';
      for (let i = 0; i < 3; i++) grid.append(h('div', { class: 'proj-card bds-skeleton', 'aria-hidden': 'true' }));
    }
    projectsList = (await window.bds.listProjects()) || [];
    renderGrid();
    renderTabs();
    renderDueBanner();
  } catch (e) {
    console.error('Erro ao listar projetos', e);
    setAppStatus('Erro ao carregar projetos', 'error');
    if (grid) grid.removeAttribute('aria-busy');
  }
}

function visibleProjects() {
  const q = query.trim().toLowerCase();
  const f = STATUS_FILTERS.find((x) => x.id === filter) || STATUS_FILTERS[0];
  let list = projectsList.filter((p) => {
    const st = normalizeStatus(p.status);
    if (f.statuses && !f.statuses.includes(st)) return false;
    if (filter === 'all' && st === 'Arquivado' && !q) return false; // arquivados só no filtro próprio (ou na busca)
    if (!q) return true;
    return [p.name, p.client, p.type, p.description, st, p.start_date, p.deadline].some((v) => String(v || '').toLowerCase().includes(q));
  });
  const byDate = (v) => (v ? new Date(String(v).includes('T') ? v : `${v}Z`.replace(' ', 'T')).getTime() || 0 : 0);
  const sorters = {
    recent: (a, b) => byDate(b.created_at) - byDate(a.created_at),
    oldest: (a, b) => byDate(a.created_at) - byDate(b.created_at),
    deadline: (a, b) => (a.deadline ? String(a.deadline) : '9999') .localeCompare(b.deadline ? String(b.deadline) : '9999'),
    name: (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR'),
    activity: (a, b) => byDate(b.last_activity_at || b.created_at) - byDate(a.last_activity_at || a.created_at)
  };
  list = list.slice().sort(sorters[sort] || sorters.recent);
  return list;
}

// ------------------------------------------------------------------ cartões

/** Os 3 projetos com atividade mais recente (só na aba "Em andamento", sem busca, e quando há mais de 3). */
function recentProjects(list) {
  if (filter !== 'active' || query.trim() || list.length <= 3) return [];
  const when = (p) => { const v = p.last_activity_at || p.created_at; return v ? new Date(String(v).includes('T') ? v : `${v}Z`.replace(' ', 'T')).getTime() || 0 : 0; };
  return list.slice().sort((a, b) => when(b) - when(a)).slice(0, 3);
}

function renderGrid() {
  const grid = $('projectsGrid');
  if (!grid) return;
  grid.removeAttribute('aria-busy');
  grid.textContent = '';
  const all = visibleProjects();
  const recent = recentProjects(all);
  const recentIds = new Set(recent.map((p) => p.id));
  const list = all.filter((p) => !recentIds.has(p.id));
  const count = $('projCount');
  const recentHost = $('projRecent');
  if (recentHost) {
    recentHost.textContent = '';
    for (const p of recent) recentHost.append(renderCard(p, { recent: true }));
  }
  $('projRecentSection')?.classList.toggle('hidden', recent.length === 0);
  const listLabel = $('projListLabel');
  if (listLabel) { listLabel.textContent = recent.length ? 'Os demais em andamento' : ''; listLabel.classList.toggle('hidden', !recent.length); }

  if (projectsList.length === 0) {
    if (count) count.textContent = '';
    renderTable([]);
    grid.append(h('div', { class: 'bds-empty proj-empty', role: 'status' }, [
      h('span', { class: 'material-symbols-rounded bds-empty-icon', 'aria-hidden': 'true', text: 'folder_special' }),
      h('strong', { class: 'bds-empty-title', text: 'Nenhum projeto ainda' }),
      h('span', { class: 'bds-empty-text', text: 'Cada projeto reúne as mídias, o cliente, as datas, os equipamentos e a entrega de um trabalho.' }),
      h('button', { type: 'button', class: 'bds-empty-action', 'data-empty-action': 'new-project', onclick: () => $('btnNewProject')?.click() }, 'Criar primeiro projeto')
    ]));
    return;
  }
  // contagem só quando ajuda: busca ativa (as abas já mostram o total de cada situação)
  if (count) count.textContent = query.trim() ? `${all.length} ${all.length === 1 ? 'projeto encontrado' : 'projetos encontrados'}` : '';
  renderTable(list);
  if (all.length === 0) {
    grid.append(h('div', { class: 'bds-empty proj-empty', role: 'status' }, [
      h('span', { class: 'material-symbols-rounded bds-empty-icon', 'aria-hidden': 'true', text: 'search_off' }),
      h('strong', { class: 'bds-empty-title', text: query.trim() ? 'Nenhum projeto encontrado' : 'Nenhum projeto nesta situação' }),
      h('span', { class: 'bds-empty-text', text: query.trim() ? 'Tente outra busca ou outra aba.' : 'Os projetos aparecem aqui quando mudam para esta situação.' })
    ]));
    return;
  }
  for (const p of list) grid.append(renderCard(p));
  grid.append(h('button', { type: 'button', class: 'proj-card proj-card-new', 'aria-label': 'Novo projeto', onclick: () => openForm(null) }, [icon('add'), h('span', { text: 'Novo projeto' })]));
}

/** Modo lista: uma linha por projeto. */
function renderTable(list) {
  const body = $('projectsTableBody');
  if (!body) return;
  body.textContent = '';
  for (const p of list) {
    const st = statusInfo(p.status);
    const pill = deadlinePill(p.deadline, st.id);
    const stripe = h('span', { class: 'proj-card-color', 'aria-hidden': 'true' });
    stripe.style.background = safeHexColor(p.color);
    const tr = h('tr', { class: p.id === selectedProjectId ? 'selected' : '', 'data-id': p.id, tabindex: '0' }, [
      h('td', {}, [h('div', { class: 'proj-td-name' }, [stripe, h('span', { class: 'proj-td-title', text: p.name, title: p.name })]), p.type ? h('div', { class: 'proj-td-sub', text: p.type }) : null]),
      h('td', { text: p.client || '—' }),
      h('td', {}, [h('span', { class: `proj-pill tone-${st.tone}` }, [icon(st.icon), st.id])]),
      h('td', {}, [h('span', { class: `proj-pill tone-${pill.tone}` }, [icon(pill.icon), pill.text])]),
      h('td', { class: 'proj-td-num', text: `${p.media_count || 0}${p.total_size ? ` · ${formatBytes(p.total_size)}` : ''}` }),
      h('td', { class: 'proj-td-muted', text: p.last_activity_at ? relativeActivity(p.last_activity_at) : '—' }),
      h('td', { class: 'proj-td-actions' }, [h('button', { class: 'proj-icon-btn', type: 'button', title: 'Mais ações', 'aria-label': `Ações de ${p.name}`, onclick: (e) => { e.stopPropagation(); showMenu(e.currentTarget, p); } }, [icon('more_vert')])])
    ]);
    tr.addEventListener('click', () => selectProject(p.id));
    tr.addEventListener('dblclick', () => openProjectWorkspace(p.id));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') openProjectWorkspace(p.id); });
    body.append(tr);
  }
}

/** Abas de situação: contagem de cada uma e a ativa marcada. */
function renderTabs() {
  const st = (p) => normalizeStatus(p.status);
  const counts = {
    active: projectsList.filter((p) => ACTIVE_STATUSES.includes(st(p))).length,
    waiting: projectsList.filter((p) => st(p) === 'Aguardando cliente').length,
    done: projectsList.filter((p) => st(p) === 'Concluído').length,
    archived: projectsList.filter((p) => st(p) === 'Arquivado').length
  };
  document.querySelectorAll('.proj-tab-count[data-count]').forEach((n) => { n.textContent = String(counts[n.dataset.count] || 0); });
  $('projTabs')?.classList.toggle('hidden', projectsList.length === 0);
  applyTabs();
}

function applyTabs() {
  document.querySelectorAll('.proj-tab[data-filter]').forEach((b) => {
    const on = b.dataset.filter === filter;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
}

/** Projetos em andamento com entrega nos próximos 7 dias (ou atrasada), do mais urgente ao menos. */
function dueSoon() {
  const st = (p) => normalizeStatus(p.status);
  return projectsList
    .filter((p) => p.deadline && st(p) !== 'Concluído' && st(p) !== 'Arquivado')
    .map((p) => ({ p, d: daysUntilLocal(p.deadline) }))
    .filter((x) => x.d !== null && x.d <= 7)
    .sort((a, b) => a.d - b.d);
}

/** Aviso de prazo: só aparece quando há entrega próxima; leva para a ordenação por prazo. */
function renderDueBanner() {
  const banner = $('projDueBanner');
  if (!banner) return;
  const due = dueSoon();
  banner.classList.toggle('hidden', due.length === 0);
  if (!due.length) return;
  const first = due[0];
  const when = first.d < 0 ? `${Math.abs(first.d)} ${Math.abs(first.d) === 1 ? 'dia' : 'dias'} de atraso` : first.d === 0 ? 'hoje' : first.d === 1 ? 'amanhã' : `em ${first.d} dias`;
  banner.classList.toggle('is-late', first.d <= 0);
  $('projDueText').textContent = `${due.length} ${due.length === 1 ? 'entrega' : 'entregas'} nos próximos 7 dias · ${first.p.name} ${when}`;
}

/** O que falta fazer no projeto, em uma frase (null quando concluído/arquivado). */
function nextStep(p) {
  const st = normalizeStatus(p.status);
  if (st === 'Concluído' || st === 'Arquivado') return null;
  const total = Number(p.delivery_total) || 0;
  const done = Number(p.delivery_done) || 0;
  if (!p.media_count) return 'Adicionar o material';
  if (!total) return 'Preparar a lista de entrega';
  if (done < total) return `Entrega: ${done} de ${total} itens prontos`;
  return 'Tudo pronto para entregar';
}

function renderCard(p, { recent = false } = {}) {
  const st = statusInfo(p.status);
  const pill = deadlinePill(p.deadline, st.id);
  const color = safeHexColor(p.color);
  const cover = h('div', { class: `proj-card-cover${p.cover_path ? '' : ' is-empty'}` });
  if (p.cover_path) cover.style.backgroundImage = `url("${toFileUrl(p.cover_path)}")`;
  else { cover.style.background = `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 35%, var(--card)))`; cover.append(icon('movie')); }

  const total = Number(p.delivery_total) || 0;
  const done = Number(p.delivery_done) || 0;
  let progress = null;
  if (total) {
    progress = h('div', { class: 'proj-card-progress', title: `Entrega: ${done} de ${total} itens`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done), 'aria-label': 'Progresso da entrega' });
    const fill = h('span', { class: 'proj-card-progress-fill' });
    fill.style.width = `${Math.round((done / total) * 100)}%`;
    progress.append(fill);
  }
  const step = nextStep(p);
  const activity = p.last_activity_at ? relativeActivity(p.last_activity_at) : '';
  const body = h('div', { class: 'proj-card-body' }, [
    h('h3', { class: 'proj-card-title', text: p.name, title: p.name }),
    h('p', { class: 'proj-card-client', text: [p.client, p.type].filter(Boolean).join(' · ') || 'Sem cliente' }),
    h('p', { class: `proj-card-when tone-${pill.tone}` }, [icon(pill.icon), pill.text]),
    h('div', { class: 'proj-card-meta' }, [h('span', { class: `proj-pill tone-${st.tone}` }, [icon(st.icon), st.id])]),
    progress,
    step ? h('button', {
      type: 'button', class: 'proj-card-next', title: 'Abrir o projeto',
      onclick: (e) => { e.stopPropagation(); openProjectWorkspace(p.id); }
    }, [h('span', { text: `Próximo: ${step}` }), icon('arrow_forward')]) : null,
    h('div', { class: 'proj-card-foot' }, [
      h('span', { text: `${p.media_count || 0} ${p.media_count === 1 ? 'arquivo' : 'arquivos'}${p.total_size ? ` · ${formatBytes(p.total_size)}` : ''}` }),
      h('span', { class: 'proj-card-activity', text: activity ? (recent ? `Mexido ${activity.toLowerCase()}` : activity) : '' })
    ])
  ]);
  body.style.borderLeftColor = color;
  const card = h('div', {
    class: `proj-card${recent ? ' is-recent' : ''}${p.id === selectedProjectId ? ' selected' : ''}${st.id === 'Arquivado' ? ' is-archived' : ''}`,
    role: 'listitem', tabindex: '0', 'data-id': p.id, 'aria-label': p.name
  }, [
    cover,
    h('button', { class: 'proj-card-menu', type: 'button', title: 'Mais ações', 'aria-label': `Ações de ${p.name}`, onclick: (e) => { e.stopPropagation(); showMenu(e.currentTarget, p); } }, [icon('more_vert')]),
    body
  ]);
  card.addEventListener('click', () => selectProject(p.id));
  card.addEventListener('dblclick', () => openProjectWorkspace(p.id));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openProjectWorkspace(p.id);
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); showMenu(card.querySelector('.proj-card-menu'), p); }
  });
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); selectProject(p.id); showMenu(card.querySelector('.proj-card-menu'), p); });
  return card;
}

function selectProject(id) {
  selectedProjectId = id;
  document.querySelectorAll('.proj-card[data-id], #projectsTableBody tr').forEach((c) => c.classList.toggle('selected', Number(c.dataset.id) === id));
}

// ------------------------------------------------------------------ menu ⋮

function showMenu(anchor, p) {
  const menu = $('projMenu');
  if (!menu || !anchor) return;
  selectProject(p.id);
  const st = normalizeStatus(p.status);
  const entries = [
    { icon: 'open_in_new', label: 'Abrir projeto', run: () => openProjectWorkspace(p.id) },
    { icon: 'edit', label: 'Renomear / editar', run: () => openForm(p) },
    { icon: 'image', label: 'Alterar capa', run: () => changeCover(p) },
    { icon: 'flag', label: 'Alterar status', submenu: STATUSES.map((s) => ({ icon: s.icon, label: s.id, selected: s.id === st, run: () => setStatus(p, s.id) })) },
    { icon: 'content_copy', label: 'Duplicar', run: () => duplicate(p) },
    { icon: 'description', label: 'Exportar informações', run: () => exportInfo(p) },
    { icon: 'inventory_2', label: 'Exportar pacote .bdspro', run: () => exportBdspro(p) },
    { separator: true },
    st === 'Arquivado'
      ? { icon: 'unarchive', label: 'Desarquivar', run: () => setStatus(p, 'Planejamento') }
      : { icon: 'archive', label: 'Arquivar', run: () => archive(p) },
    { icon: 'delete', label: 'Excluir', danger: true, run: () => remove(p) }
  ];
  openMenuAt(anchor, entries);
}

/** Abre o menu (#projMenu) junto do botão, sem sair da janela. */
function openMenuAt(anchor, entries) {
  const menu = $('projMenu');
  if (!menu || !anchor) return;
  renderMenu(menu, entries);
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth || 240;
  const hgt = menu.offsetHeight || 300;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - hgt - 8)}px`;
  menu.querySelector('button')?.focus();
}

function renderMenu(menu, entries) {
  menu.textContent = '';
  for (const e of entries) {
    if (e.separator) { menu.append(h('hr', { class: 'proj-menu-sep' })); continue; }
    if (e.submenu) {
      const details = h('details', { class: 'proj-menu-sub' }, [
        h('summary', { role: 'menuitem' }, [icon(e.icon), h('span', { text: e.label }), icon('chevron_right')])
      ]);
      for (const s of e.submenu) {
        details.append(h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(!!s.selected), class: s.selected ? 'selected' : '', onclick: () => { hideMenu(); s.run(); } }, [icon(s.icon), s.label]));
      }
      menu.append(details);
      continue;
    }
    menu.append(h('button', { type: 'button', role: 'menuitem', class: e.danger ? 'danger' : '', onclick: () => { hideMenu(); e.run(); } }, [icon(e.icon), e.label]));
  }
}
function hideMenu() { $('projMenu')?.classList.add('hidden'); }

// ------------------------------------------------------------------ ações do menu

async function setStatus(p, status) {
  try {
    await window.bds.updateProject(p.id, { status });
    setAppStatus(`Status alterado para ${status}.`, 'success');
    await loadProjects();
  } catch (e) { window.bdsModal.alert(`Não foi possível alterar o status: ${friendlyError(e)}`); }
}

async function archive(p) {
  const ok = await window.bdsModal.confirm(`Arquivar o projeto "${p.name}"?\n\nEle sai da lista principal (fica no filtro "Arquivados") e nada é apagado.`);
  if (ok) await setStatus(p, 'Arquivado');
}

async function duplicate(p) {
  try {
    setAppStatus('Duplicando projeto…', 'info');
    const newId = await window.bds.duplicateProject(p.id);
    await loadProjects();
    selectProject(newId);
    setAppStatus('Projeto duplicado.', 'success');
  } catch (e) { window.bdsModal.alert(`Não foi possível duplicar: ${friendlyError(e)}`); }
}

async function exportInfo(p) {
  try {
    const r = await window.bds.exportProjectInfo(p.id);
    if (r && r.filePath) setAppStatus('Informações do projeto exportadas.', 'success');
  } catch (e) { window.bdsModal.alert(`Não foi possível exportar as informações: ${friendlyError(e)}`); }
}

async function exportBdspro(p) {
  try {
    const destFolder = firstDialogPath(await window.bds.selectFolder());
    if (!destFolder) return;
    // O processo principal monta o caminho (nome sanitizado + path.join) e confirma a sobrescrita
    setAppStatus('Exportando pacote .bdspro…', 'info');
    const result = await window.bds.exportBdspro(p.id, { folder: destFolder, name: p.name });
    if (result && result.success) {
      setAppStatus(`Projeto "${p.name}" exportado.`, 'success');
      window.bdsModal.alert(`Pacote .bdspro exportado.\n\nSalvo em: ${result.filePath}`);
    }
  } catch (e) {
    setAppStatus('Erro ao exportar pacote .bdspro', 'error');
    window.bdsModal.alert(`Erro ao exportar: ${friendlyError(e)}`);
  }
}

async function changeCover(p) {
  try {
    const fp = firstDialogPath(await window.bds.selectFile({ properties: ['openFile'], filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] }));
    if (!fp) return;
    await window.bds.updateProject(p.id, { cover_path: fp });
    await loadProjects();
  } catch (e) { window.bdsModal.alert(`Não foi possível alterar a capa: ${friendlyError(e)}`); }
}

async function remove(p) {
  const ok = await window.bdsModal.confirm(`Excluir o projeto "${p.name}"?\n\nAs mídias continuam na Biblioteca e no disco. Se quiser só tirá-lo da lista, use "Arquivar".`);
  if (!ok) return;
  try {
    await window.bds.deleteProject(p.id);
    if (selectedProjectId === p.id) selectedProjectId = null;
    setAppStatus('Projeto excluído.', 'success');
    await loadProjects();
  } catch (e) { window.bdsModal.alert(`Não foi possível excluir: ${friendlyError(e)}`); }
}

// ------------------------------------------------------------------ formulário

function openForm(p = null) {
  $('modalProjectTitle').textContent = p ? 'Editar projeto' : 'Novo projeto';
  $('btnSaveProjForm').textContent = p ? 'Salvar' : 'Criar projeto';
  $('projFormId').value = p ? p.id : '';
  $('projFormName').value = p ? p.name || '' : '';
  $('projFormClient').value = p ? p.client || '' : '';
  $('projFormType').value = p ? p.type || '' : '';
  $('projFormStart').value = p && p.start_date ? String(p.start_date).slice(0, 10) : '';
  $('projFormDeadline').value = p && p.deadline ? String(p.deadline).slice(0, 10) : '';
  $('projFormStatus').value = p ? normalizeStatus(p.status) : 'Planejamento';
  $('projFormColor').value = safeHexColor(p ? p.color : DEFAULT_COLOR);
  $('projFormNotes').value = p ? p.description || '' : '';
  formCoverPath = p ? p.cover_path || '' : '';
  renderFormCover();
  // Novo: só o essencial à vista (pastas padrão marcadas). Editar: abre os detalhes, que são o que se costuma mudar.
  $('projFormDefaultBinsRow')?.classList.toggle('hidden', !!p);
  if ($('projFormDefaultBins')) $('projFormDefaultBins').checked = true;
  if ($('projFormMore')) $('projFormMore').open = !!p;
  $('modalProjectForm').classList.add('open');
  const nameInput = $('projFormName');
  setTimeout(() => { try { nameInput?.focus(); } catch (_) { /* tela já fechada */ } }, 50);
}

function closeForm() { $('modalProjectForm').classList.remove('open'); }

function renderFormCover() {
  const prev = $('projFormCoverPreview');
  if (!prev) return;
  prev.style.backgroundImage = formCoverPath ? `url("${toFileUrl(formCoverPath)}")` : 'none';
  prev.classList.toggle('is-empty', !formCoverPath);
  $('btnProjFormCoverClear')?.classList.toggle('hidden', !formCoverPath);
}

async function saveForm() {
  const id = $('projFormId').value;
  const data = {
    name: $('projFormName').value.trim(),
    client: $('projFormClient').value.trim(),
    type: $('projFormType').value.trim(),
    start_date: $('projFormStart').value || null,
    deadline: $('projFormDeadline').value || null,
    status: normalizeStatus($('projFormStatus').value),
    color: safeHexColor($('projFormColor').value),
    description: $('projFormNotes').value.trim(),
    cover_path: formCoverPath || ''
  };
  if (!data.name) { window.bdsModal.alert('O nome do projeto é obrigatório.'); $('projFormName')?.focus(); return; }
  try {
    let newId = null;
    if (id) await window.bds.updateProject(Number(id), data);
    else newId = await window.bds.createProject(data);
    if (newId && $('projFormDefaultBins')?.checked && typeof window.bds.createProjectDefaultBins === 'function') {
      try { await window.bds.createProjectDefaultBins(newId); } catch (e) { console.error('Pastas padrão não criadas', e); }
    }
    closeForm();
    await loadProjects();
    if (newId) selectProject(newId);
    setAppStatus(id ? 'Projeto salvo.' : 'Projeto criado.', 'success');
  } catch (e) {
    window.bdsModal.alert(`Não foi possível salvar o projeto: ${friendlyError(e)}`);
  }
}

// ------------------------------------------------------------------ eventos

function bindOnce() {
  if (bound) return;
  bound = true;
  $('btnNewProject')?.addEventListener('click', () => openForm(null));
  $('btnCancelProjForm')?.addEventListener('click', closeForm);
  $('btnSaveProjForm')?.addEventListener('click', saveForm);
  $('btnProjFormCover')?.addEventListener('click', async () => {
    const fp = firstDialogPath(await window.bds.selectFile({ properties: ['openFile'], filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] }));
    if (fp) { formCoverPath = fp; renderFormCover(); }
  });
  $('btnProjFormCoverClear')?.addEventListener('click', () => { formCoverPath = ''; renderFormCover(); });
  $('projFormName')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveForm(); });

  $('projSearch')?.addEventListener('input', (e) => { query = e.target.value; renderGrid(); });
  $('projSort')?.addEventListener('change', (e) => { sort = e.target.value; renderGrid(); });
  const setView = (v) => { view = v; try { localStorage.setItem(VIEW_KEY, view); } catch (_) { /* sem armazenamento */ } applyView(); };
  $('projViewGrid')?.addEventListener('click', () => setView('grid'));
  $('projViewList')?.addEventListener('click', () => setView('list'));
  document.querySelectorAll('.proj-tab[data-filter]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.filter; applyTabs(); renderGrid(); }));
  // aviso de prazo: mostra os em andamento, do prazo mais próximo ao mais distante
  $('projDueBanner')?.addEventListener('click', () => {
    filter = 'active'; sort = 'deadline'; query = '';
    if ($('projSearch')) $('projSearch').value = '';
    if ($('projSort')) $('projSort').value = sort;
    applyTabs(); renderGrid();
  });
  $('btnNewProjectMore')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenuAt(e.currentTarget, [
      { icon: 'add', label: 'Novo projeto', run: () => openForm(null) },
      { icon: 'archive', label: 'Importar pacote .bdspro…', run: importBdspro }
    ]);
  });

  document.addEventListener('pointerdown', (e) => {
    const menu = $('projMenu');
    if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target)) hideMenu();
  }, true);

  setupRelinkModalListeners();
}

// --- Importar .bdspro (menu ▾ do botão Novo projeto) ---
async function importBdspro() {
  try {
    const bdsproPath = firstDialogPath(await window.bds.selectFile({ properties: ['openFile'], filters: [{ name: 'Pacote de projeto (*.bdspro)', extensions: ['bdspro'] }] }));
    if (!bdsproPath) return;
    setAppStatus('Inspecionando pacote .bdspro…', 'info');
    const inspectData = await window.bds.inspectBdspro(bdsproPath);
    openRelinkModal(bdsproPath, inspectData);
  } catch (e) {
    setAppStatus('Erro ao ler pacote .bdspro', 'error');
    window.bdsModal.alert(`Erro ao inspecionar pacote .bdspro: ${friendlyError(e)}`);
  }
}

// ------------------------------------------------------------------ importação / reconexão (.bdspro)

let currentRelinkContext = null;

function openRelinkModal(bdsproPath, data) {
  currentRelinkContext = { bdsproPath, data, relinkMap: {}, missingList: data.missingFiles || [], matches: [] };
  const modal = $('modalRelinkBdspro');
  if (!modal) return;
  const meta = data.metadata || {};
  $('relinkProjectName').textContent = meta.name || 'Projeto';
  $('relinkProjectDesc').textContent = meta.description || 'Sem observações';
  const coverEl = $('relinkProjectCover');
  coverEl.style.backgroundImage = meta.cover_path && !meta.cover_relative_path ? `url("${toFileUrl(meta.cover_path)}")` : 'none';
  $('pillTotalMedia').textContent = `${data.totalMedia} mídias`;
  const pillMissing = $('pillMissingMedia');
  if (data.missingMediaCount > 0) { pillMissing.textContent = `${data.missingMediaCount} ausentes`; pillMissing.className = 'relink-pill relink-pill--warning'; }
  else { pillMissing.className = 'relink-pill relink-pill--success'; pillMissing.textContent = 'Mídias 100% OK'; }
  $('relinkMissingAlert').classList.toggle('hidden', !(data.missingMediaCount > 0));
  renderRelinkTable();
  modal.classList.add('open');
}

function renderRelinkTable() {
  const tbody = $('relinkMediaTableBody');
  if (!tbody || !currentRelinkContext) return;
  tbody.textContent = '';
  const allMedia = currentRelinkContext.data.projectData?.media || [];
  if (allMedia.length === 0) {
    tbody.append(h('tr', {}, [h('td', { colspan: '4', class: 'relink-empty', text: 'Nenhuma mídia registrada no projeto.' })]));
    return;
  }
  for (const m of allMedia) {
    const origPath = m.original_path || m.filepath;
    const isMissingInitial = currentRelinkContext.data.missingFiles.some((mf) => mf.original_path === origPath);
    const relinkedPath = currentRelinkContext.relinkMap[origPath] || currentRelinkContext.relinkMap[m.filename];
    let badge; let displayPath = origPath; let confidence = '-';
    if (!isMissingInitial) { badge = h('span', { class: 'relink-badge-ok' }, [icon('check_circle'), ' Conectado']); confidence = '100%'; }
    else if (relinkedPath) {
      badge = h('span', { class: 'relink-badge-relinked' }, [icon('link'), ' Reconectado']);
      displayPath = relinkedPath;
      const match = currentRelinkContext.matches.find((x) => x.missing.original_path === origPath);
      confidence = match ? `${match.confidence}%` : 'Manual';
    } else { badge = h('span', { class: 'relink-badge-missing' }, [icon('error'), ' Não encontrado']); confidence = '0%'; }
    tbody.append(h('tr', {}, [
      h('td', {}, [badge]),
      h('td', { class: 'relink-name', text: m.filename || 'Sem nome' }),
      h('td', { class: 'relink-path', title: displayPath, text: displayPath }),
      h('td', { class: 'relink-conf', text: confidence })
    ]));
  }
}

function setupRelinkModalListeners() {
  const modal = $('modalRelinkBdspro');
  if (!modal) return;
  const close = () => { modal.classList.remove('open'); currentRelinkContext = null; };
  $('btnCloseRelinkModal')?.addEventListener('click', close);
  $('btnCancelRelink')?.addEventListener('click', close);

  $('btnSelectRelinkFolder')?.addEventListener('click', async () => {
    if (!currentRelinkContext) return;
    try {
      const searchFolder = firstDialogPath(await window.bds.selectFolder());
      if (!searchFolder) return;
      setAppStatus('Buscando mídias correspondentes…', 'info');
      const scannedFiles = await window.bds.scanRelinkFolder(searchFolder);
      const matches = await window.bds.matchMissingMedia(currentRelinkContext.missingList, scannedFiles);
      currentRelinkContext.matches = matches;
      let resolved = 0;
      for (const match of matches) {
        if (match.matched && match.resolved) {
          currentRelinkContext.relinkMap[match.missing.original_path] = match.matched.filepath;
          currentRelinkContext.relinkMap[match.missing.filename] = match.matched.filepath;
          resolved++;
        }
      }
      renderRelinkTable();
      setAppStatus(`Reconexão: ${resolved} de ${currentRelinkContext.missingList.length} mídias associadas`, 'success');
    } catch (e) {
      window.bdsModal.alert(`Erro ao procurar as mídias: ${friendlyError(e)}`);
    }
  });

  $('btnConfirmImportBdspro')?.addEventListener('click', async () => {
    if (!currentRelinkContext) return;
    try {
      setAppStatus('Importando projeto…', 'info');
      const res = await window.bds.importBdspro(currentRelinkContext.bdsproPath, currentRelinkContext.relinkMap);
      if (res && res.success) {
        setAppStatus(`Projeto "${res.projectName}" importado.`, 'success');
        close();
        await loadProjects();
        selectProject(res.projectId);
      }
    } catch (e) {
      setAppStatus('Erro ao importar projeto', 'error');
      window.bdsModal.alert(`Erro ao importar projeto: ${friendlyError(e)}`);
    }
  });
}

// ------------------------------------------------------------------ abrir a área interna

async function openProjectWorkspace(id) {
  hideMenu();
  // Reutiliza o fluxo de loadScreen (onLeave da tela atual, CSS/HTML, init) do app.js
  const app = await import('../app.js');
  app.state.currentProjectId = id;

  // Workspace em cache pertence a outro projeto: limpa (onLeave antes de remover) para recarregar
  const stale = document.getElementById('project_workspaceView');
  if (stale) {
    try {
      const m = await import('./project_workspace.js');
      if (typeof m.onLeave === 'function') await m.onLeave();
    } catch (e) { console.error('Falha ao finalizar workspace anterior', e); }
    stale.remove();
  }

  if (typeof window.bdsLoadScreen === 'function') {
    await window.bdsLoadScreen('project_workspace');
    const title = document.getElementById('globalPageTitle');
    if (title) title.textContent = 'Projetos';
  }
}
