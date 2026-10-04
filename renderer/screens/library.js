import { escapeHtml, escapeAttr } from '../utils/escape.js';
import { enhanceModals } from '../utils/modal.js';
import { originLabel } from '../utils/originLabel.js';
import { friendlyError } from '../utils/friendlyError.js';
import { t } from '../strings.js';
import { toFileUrl, joinFileUrl } from '../utils/fileUrl.js';
import { setContextProvider } from '../utils/assistantContext.js';
import {
  computeColumns, groupConsecutive, buildRows, rowTops, rowAt, visibleRange, itemPosition,
  scrollToReveal, navigateIndex, rangeBetween, diffById, scrollTopForAnchor
} from '../utils/virtualWindow.js';

const PAGE_SIZE = 300;

// --- Janela virtual: só as linhas visíveis (mais uma margem) existem no DOM; o resto é espaçador ---
const GRID_MIN_COL = 220;       // igual ao minmax(220px, 1fr) da grade original
const GRID_GAP = 16;
const CARD_H = 210;             // altura fixa do card (miniatura 124 + informações); o CSS usa a mesma
const GRID_ROW_H = CARD_H + GRID_GAP;
const LIST_ROW_H = 52;          // altura fixa da linha da lista
const LIST_HEAD_H = 40;         // cabeçalho (colunas) fixo da lista
const GROUP_HEADER_H = 56;      // cabeçalho de grupo (data / faixa de tamanho)
const OVERSCAN_PX = 600;        // margem desenhada acima e abaixo da área visível
const LOAD_AHEAD_PX = 1200;     // pede a próxima página quando faltar isso para o fim
const THUMB_DEBOUNCE_MS = 80;   // miniaturas só carregam quando a rolagem assenta
let viewMode = 'grid'; // 'grid' | 'list'
let mediaItems = [];
let thumbsDir = '';
let currentSearch = '';
let currentFilters = {
  types: [],
  origins: [],
  albums: [],
  resolutions: [],
  fps: [],
  dates: [],
  projects: [],
  tags: [],
  favorites: false
};
let selectedIds = new Set();
let lastSelectedId = null;
let currentSort = 'recorded_at';
let currentSortOrder = 'DESC';
let currentInspectorMedia = null;

// --- Estado de paginação / carregamento ---
let totalCount = null;      // total no backend (null = desconhecido)
let hasMore = false;
let isLoading = false;
let loadError = null;
let fetchSeq = 0;           // descarta respostas obsoletas
let everLoaded = false;
let libraryDirty = false;   // algo mudou enquanto a tela estava oculta

// --- Ciclo de vida ---
let cleanups = [];          // listeners globais/IPC/observers ativos
let awayUnsubs = [];        // marcadores leves enquanto a tela está oculta
let thumbsRegenTimer = null;
let importDebounceTimer = null;
let importCooldownTimer = null;   // janela de agrupamento dos eventos de importação (watcher)
let importPending = false;        // chegou evento durante a janela: refaz uma vez ao fim dela
const IMPORT_REFRESH_WINDOW_MS = 2000;
let loadMoreObserver = null;

// --- Estado da janela virtual ---
let lastQuerySig = null;          // consulta (busca/filtros/ordem) da lista carregada: mudou = lista nova (rolagem volta ao topo)
let vRoot = null;                 // contêiner da janela virtual dentro de #libContentArea
let vSpacer = null;               // espaçador com a altura total; as linhas ficam posicionadas dentro dele
let vLayout = null;               // { mode, cols, groups, rows, rowOfItem, tops, rowH, total }
let vRowEls = new Map();          // índice da linha -> elemento
let vCardEls = new Map();         // id -> elemento do card/linha (reaproveitado enquanto não muda)
let vIdIndex = new Map();         // id -> índice em mediaItems
let vRange = { first: 0, last: -1 };
let vLayoutTimer = null;
let thumbTimer = null;
let lastScrollTop = 0;
const waveformCache = new Map();  // uuid -> picos (evita pedir de novo ao rolar de volta)

export async function initScreen() {
  console.log('[LIBRARY] Inicializando tela...');
  // Assistente de IA: a seleção atual entra no contexto da tela (só ids; o assistente nunca age sem confirmação)
  setContextProvider('librarySelection', () => Array.from(selectedIds));

  if (window.bds && window.bds.getThumbDir) {
    try {
      thumbsDir = await window.bds.getThumbDir();
      thumbsDir = toFileUrl(thumbsDir);
    } catch (e) {
      console.warn('[LIBRARY] Não foi possível obter thumbsDir:', e);
    }
  }

  bindGlobalListeners();

  // View toggles
  document.getElementById('btnViewGrid')?.addEventListener('click', () => setViewMode('grid'));
  document.getElementById('btnViewList')?.addEventListener('click', () => setViewMode('list'));
  
  const btnReload = document.getElementById('btnReloadLibrary');
  if (btnReload) {
    btnReload.addEventListener('click', async () => {
      if (window.bds && window.bds.rescanAllLibrary) {
        await window.bds.rescanAllLibrary();
      }
      fetchMedia();
    });
  }

  const selectSort = document.getElementById('selectSort');
  if (selectSort) {
    selectSort.value = currentSort;
    selectSort.addEventListener('change', (e) => {
      currentSort = e.target.value;
      fetchMedia();
    });
  }

  const btnSortOrder = document.getElementById('btnSortOrder');
  if (btnSortOrder) {
    btnSortOrder.addEventListener('click', () => {
      currentSortOrder = currentSortOrder === 'DESC' ? 'ASC' : 'DESC';
      btnSortOrder.textContent = currentSortOrder === 'DESC' ? 'arrow_downward' : 'arrow_upward';
      fetchMedia();
    });
  }

  // A pesquisa global é tratada em app.js (um único listener, que não depende desta tela).
  // Ao abrir a Biblioteca, aplica o texto que já estiver no campo.
  currentSearch = (document.getElementById('globalSearch')?.value || '').trim();

  // Inspector Buttons
  document.getElementById('closeInspectorBtn')?.addEventListener('click', closeInspector);
  document.getElementById('btnPlayMedia')?.addEventListener('click', () => {
    if (currentInspectorMedia && window.openPreview) {
      window.openPreview(currentInspectorMedia, mediaItems);
    }
  });

  // Clique na thumbnail do inspetor também abre o preview
  document.getElementById('inspectorThumbnail')?.addEventListener('click', (e) => {
    if (e.target.closest('#closeInspectorBtn')) return;
    if (currentInspectorMedia && window.openPreview) {
      window.openPreview(currentInspectorMedia, mediaItems);
    }
  });

  // Ações do estado vazio (delegação: o conteúdo é recriado a cada consulta)
  document.getElementById('libContentArea')?.addEventListener('click', (e) => {
    const act = e.target.closest?.('[data-empty-action]')?.dataset.emptyAction;
    if (act === 'clear-filters') {
      const gs = document.getElementById('globalSearch');
      if (gs && gs.value) { gs.value = ''; gs.dispatchEvent(new Event('input', { bubbles: true })); }
      document.getElementById('btnLimparFiltros')?.click();
    } else if (act === 'add-source') {
      document.getElementById('btnAddCustomSourceBtn')?.click();
    }
  });

  // Limpar Filtros
  const btnLimpar = document.getElementById('btnLimparFiltros');
  if (btnLimpar) {
    btnLimpar.addEventListener('click', () => {
      document.querySelectorAll('.lib-filter-chk').forEach(chk => {
        chk.checked = false;
        const icon = chk.nextElementSibling;
        if (icon) icon.textContent = 'check_box_outline_blank';
      });
      updateFilters();
      fetchMedia();
    });
  }

  enhanceModals(document.getElementById('libraryView') || document, '.lib-modal-overlay');
  setupCustomSourceModal();
  setupAddToProjectModal();
  setupDelegatedMediaClicks();
  setupVirtualScroll();
  await loadFilterOptions();
  fetchMedia();
  bindInspectorEvents();
}

/** ESC fecha o inspector da biblioteca (e, sem inspector aberto, limpa a seleção) (roteado pelo despachante central do app.js). */
export function onKeyDown(e) {
  const isSelectAll = (e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 'a';
  if (e.key !== 'Escape' && !isSelectAll) return;
  const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (document.querySelector('.lib-modal-overlay.active')) return;
  if (isSelectAll) {
    if (!mediaItems.length) return;
    e.preventDefault();
    selectAllLoaded();
    return;
  }
  const inspector = document.getElementById('libraryInspector');
  if (inspector && inspector.classList.contains('active')) { e.preventDefault(); closeInspector(); return; }
  if (selectedIds.size > 0) { e.preventDefault(); selectedIds.clear(); updateSelectionVisuals(); }
}

/** Listeners globais (document / IPC / observers): registrados aqui e removidos em onLeave. */
function bindGlobalListeners() {
  if (window.bds && window.bds.onMediaImported) {
    // Agrupa os eventos: o 1º atualiza quase na hora e os seguintes (importação em massa, 1 evento por
    // arquivo) viram uma única atualização ao fim da janela, em vez de recarregar a lista a cada arquivo.
    const refreshAfterImport = () => {
      importDebounceTimer = setTimeout(() => {
        importDebounceTimer = null;
        loadFilterOptions();
        loadMedia(false, { keepLoaded: true });
        importCooldownTimer = setTimeout(() => {
          importCooldownTimer = null;
          if (importPending) { importPending = false; refreshAfterImport(); }
        }, IMPORT_REFRESH_WINDOW_MS);
      }, 50);
    };
    const onChanged = () => {
      if (importDebounceTimer || importCooldownTimer) { importPending = true; return; }
      refreshAfterImport();
    };
    const unsub = window.bds.onMediaImported(onChanged);
    if (typeof unsub === 'function') cleanups.push(unsub);
    // Mídias alteradas por fora da tela (ex.: etiquetas e favoritos aplicados pelo assistente)
    const unsubUpdated = typeof window.bds.onMediaUpdated === 'function' ? window.bds.onMediaUpdated(onChanged) : null;
    if (typeof unsubUpdated === 'function') cleanups.push(unsubUpdated);
  }

  // Atualiza a biblioteca PROGRESSIVAMENTE durante a regeneração de thumbnails (com debounce)
  if (window.bds && window.bds.onThumbsRegenProgress) {
    const unsub = window.bds.onThumbsRegenProgress((data) => {
      if (!data || !data.total) return;
      clearTimeout(thumbsRegenTimer);
      thumbsRegenTimer = setTimeout(() => { refreshThumbnails(); }, data.processed >= data.total ? 800 : 3000);
    });
    if (typeof unsub === 'function') cleanups.push(unsub);
  }

  // Redimensionamento da janela / do painel: recalcula as colunas e a janela visível
  const content = document.getElementById('libContentArea');
  const onResize = () => scheduleLayout();
  window.addEventListener('resize', onResize);
  cleanups.push(() => window.removeEventListener('resize', onResize));
  if (content && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(onResize);
    ro.observe(content);
    cleanups.push(() => ro.disconnect());
  }

  cleanups.push(() => {
    clearTimeout(importDebounceTimer); importDebounceTimer = null;
    clearTimeout(importCooldownTimer); importCooldownTimer = null; importPending = false;
    clearTimeout(thumbsRegenTimer); thumbsRegenTimer = null;
    clearTimeout(thumbTimer); thumbTimer = null;
    clearTimeout(vLayoutTimer); vLayoutTimer = null;
    if (loadMoreObserver) { loadMoreObserver.disconnect(); loadMoreObserver = null; }
  });
}

export function onLeave() {
  cleanups.forEach((fn) => { try { fn(); } catch (_) { /* noop */ } });
  cleanups = [];
  fetchSeq++; // invalida requisições em andamento
  isLoading = false;
  // Marcadores leves: apenas registram que há dados novos, para refazer o fetch ao voltar
  const markDirty = () => { libraryDirty = true; };
  awayUnsubs.forEach((fn) => { try { fn(); } catch (_) { /* noop */ } });
  awayUnsubs = [];
  [window.bds?.onMediaImported, window.bds?.onMediaUpdated, window.bds?.onThumbsRegenProgress].forEach((sub) => {
    if (typeof sub !== 'function') return;
    const unsub = sub.call(window.bds, markDirty);
    if (typeof unsub === 'function') awayUnsubs.push(unsub);
  });
}

export function onEnter() {
  awayUnsubs.forEach((fn) => { try { fn(); } catch (_) { /* noop */ } });
  awayUnsubs = [];
  if (!cleanups.length) bindGlobalListeners();
  const search = (document.getElementById('globalSearch')?.value || '').trim();
  if (search !== currentSearch) { currentSearch = search; libraryDirty = true; }
  if (libraryDirty || !everLoaded || loadError) {
    libraryDirty = false;
    fetchMedia();
  } else {
    // A tela voltou a ficar visível: remede (a largura pode ter mudado) e restaura a rolagem
    const content = document.getElementById('libContentArea');
    if (content && lastScrollTop && content.scrollTop !== lastScrollTop) content.scrollTop = lastScrollTop;
    relayout({ keepAnchor: true });
    attachLoadMoreObserver();
  }
}

export function resetFilters() {
  currentFilters = {
    types: [],
    origins: [],
    albums: [],
    resolutions: [],
    fps: [],
    dates: [],
    projects: [],
    tags: [],
    favorites: false
  };
  currentSearch = '';
  selectedIds.clear();
  document.querySelectorAll('.lib-filter-chk').forEach(chk => {
    chk.checked = false;
    const icon = chk.nextElementSibling;
    if (icon) icon.textContent = 'check_box_outline_blank';
  });
  const searchInput = document.getElementById('globalSearch');
  if (searchInput) searchInput.value = '';
}


function setupCustomSourceModal() {
  const modal = document.getElementById('modalAddCustomSource');
  const btnOpen = document.getElementById('btnAddCustomSourceBtn');
  const btnClose = document.getElementById('btnCloseCustomSourceModal');
  const btnCancel = document.getElementById('btnCancelAddCustomSource');
  const btnBrowse = document.getElementById('btnBrowseCustomSourceFolder');
  const btnConfirm = document.getElementById('btnConfirmAddCustomSource');

  const closeModal = () => {
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('active');
    }
  };

  const openModal = () => {
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('active');
    }
  };

  if (btnOpen) btnOpen.addEventListener('click', openModal);
  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

  if (btnBrowse) {
    btnBrowse.addEventListener('click', async () => {
      if (window.bds && window.bds.selectFolder) {
        const folder = await window.bds.selectFolder();
        if (folder) {
          const pathInput = document.getElementById('inputCustomSourcePath');
          if (pathInput) pathInput.value = folder;
        }
      }
    });
  }

  if (btnConfirm) {
    btnConfirm.addEventListener('click', async () => {
      const nameInput = document.getElementById('inputCustomSourceName');
      const pathInput = document.getElementById('inputCustomSourcePath');
      
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
          btnConfirm.innerHTML = '<span class="material-symbols-rounded">hourglass_top</span> Indexando Mídias...';

          await window.bds.addCustomSource({ name: sourceName, folderPath: folderPath });

          btnConfirm.disabled = false;
          btnConfirm.innerHTML = '<span class="material-symbols-rounded">check_circle</span> Cadastrar & Importar Mídias';

          closeModal();

          nameInput.value = '';
          pathInput.value = '';

          await loadFilterOptions();
          await fetchMedia();

          window.bdsModal.alert(`Sucesso! A fonte personalizada "${sourceName}" foi cadastrada e suas mídias foram indexadas na biblioteca!`);
        } catch (err) {
          btnConfirm.disabled = false;
          btnConfirm.innerHTML = '<span class="material-symbols-rounded">check_circle</span> Cadastrar & Importar Mídias';
          window.bdsModal.alert('Não foi possível cadastrar a pasta: ' + friendlyError(err));
        }
      }
    });
  }
}

/**
 * Resultado de ação em lote (RK-089): se houve falhas, informa "N concluídos, M falharam" com os motivos
 * e deixa selecionados só os itens que falharam. Retorna true quando houve falha.
 */
function reportBatchResult(result, doneCount) {
  const failed = result && Array.isArray(result.failed) ? result.failed : [];
  if (failed.length === 0) return false;
  const reasons = Array.from(new Set(failed.map((f) => f && f.error).filter(Boolean))).slice(0, 3).join('; ');
  selectedIds = new Set(failed.map((f) => f.id).filter((id) => id != null));
  window.bdsModal.alert(`${doneCount || 0} concluído(s), ${failed.length} falharam.${reasons ? ' Motivos: ' + reasons : ''}`);
  return true;
}

function setViewMode(mode) {
  viewMode = mode;
  document.getElementById('btnViewGrid')?.classList.toggle('active', mode === 'grid');
  document.getElementById('btnViewList')?.classList.toggle('active', mode === 'list');
  relayout({ keepAnchor: true });
}

function updateFilters() {
  const getChecked = (name) => Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map(el => el.value);
  currentFilters.types = getChecked('type');
  currentFilters.origins = getChecked('origin');
  currentFilters.albums = getChecked('album');
  currentFilters.resolutions = getChecked('res').map(Number);
  currentFilters.fps = getChecked('fps').map(Number);
  currentFilters.dates = getChecked('date');
  currentFilters.projects = getChecked('project').map(Number);
  currentFilters.tags = getChecked('tag').map(Number);
  currentFilters.favorites = getChecked('favorite').length > 0;
}

export async function applyGlobalSearch(query) {
  currentSearch = query || '';
  const searchInput = document.getElementById('globalSearch');
  if (searchInput && searchInput.value !== currentSearch) {
    searchInput.value = currentSearch;
  }
  await fetchMedia();
}

export function fetchMedia() {
  return loadMedia(false);
}

function buildSearchOptions(limit, offset) {
  return {
    query: currentSearch,
    types: currentFilters.types,
    origins: currentFilters.origins,
    albums: currentFilters.albums,
    resolutions: currentFilters.resolutions,
    fps: currentFilters.fps,
    dates: currentFilters.dates,
    projects: currentFilters.projects,
    tags: currentFilters.tags,
    favorites: currentFilters.favorites,
    sort: currentSort,
    order: currentSortOrder,
    limit,
    offset
  };
}

/**
 * Regeneração de thumbnails: busca o mesmo intervalo já carregado e troca apenas as
 * imagens que mudaram (sem reconstruir a grade). Se a lista divergiu, recarrega tudo.
 */
async function refreshThumbnails() {
  if (!window.bds || !window.bds.searchLibrary || isLoading || !mediaItems.length) return;
  const seq = fetchSeq;
  try {
    const res = (await window.bds.searchLibrary(buildSearchOptions(mediaItems.length, 0))) || {};
    if (seq !== fetchSeq || isLoading) return;
    const items = res.items || [];
    const sameList = items.length === mediaItems.length && items.every((m, i) => m.id === mediaItems[i].id);
    if (!sameList) { fetchMedia(); return; }
    const container = document.getElementById('libContentArea');
    items.forEach((fresh, i) => {
      const old = mediaItems[i];
      if (old.thumbnail === fresh.thumbnail) return;
      old.thumbnail = fresh.thumbnail;
      const el = container?.querySelector(`.media-clickable[data-id="${CSS.escape(String(old.id))}"]`);
      if (!el) return;
      const url = fresh.thumbnail ? joinFileUrl(thumbsDir, fresh.thumbnail) : '';
      const holder = el.querySelector('.lib-card-thumb');
      if (holder) {
        let img = holder.querySelector('.lib-card-img');
        if (!url) { img?.remove(); return; }
        if (!img) {
          img = document.createElement('img');
          img.className = 'lib-card-img';
          img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.draggable = false;
          holder.prepend(img);
          holder.classList.remove('audio-placeholder');
          holder.querySelector('.lib-card-waveform')?.remove();
        }
        img.removeAttribute('data-src');
        img.src = url;
        const ce = vCardEls.get(old.id);
        if (ce) ce.__sig = cardSig(old);
      } else {
        const lt = el.querySelector('.lib-list-thumb');
        if (lt) {
          lt.removeAttribute('data-thumb');
          lt.style.backgroundImage = url ? `url('${url}')` : '';
          const ce = vCardEls.get(old.id);
          if (ce) ce.__sig = cardSig(old);
        }
      }
    });
  } catch (err) {
    console.warn('[LIBRARY] Falha ao atualizar thumbnails:', err);
  }
}

/**
 * @param {boolean} append  carrega a próxima página (true) ou recarrega a lista (false)
 * @param {{keepLoaded?: boolean}} [opts]  keepLoaded: no recarregamento, busca tantos itens quanto já estavam
 *   carregados (até um teto), para a atualização por importação não "encolher" a lista rolada pelo usuário
 */
async function loadMedia(append, opts = {}) {
  if (!window.bds || !window.bds.searchLibrary) return;
  if (append && (isLoading || !hasMore)) return;

  const seq = ++fetchSeq;
  let appendFresh = null;
  let pendingItems = mediaItems;
  isLoading = true;
  loadError = null;
  const container = document.getElementById('libContentArea');
  // Mesma consulta da lista já carregada (recarga após importação, favorito em lote, renomear...): a lista é
  // atualizada de forma incremental, com o mesmo tamanho carregado e sem mexer na rolagem.
  const querySig = JSON.stringify(buildSearchOptions(0, 0));
  const sameQuery = !append && everLoaded && querySig === lastQuerySig && mediaItems.length > 0;
  if (!append) {
    hasMore = false;
    if (container) {
      container.setAttribute('aria-busy', 'true');
      if (mediaItems.length === 0) {
        unmountVirtual();
        container.innerHTML = `<div class="lib-loading" role="status"><span class="material-symbols-rounded lib-loading-spin">progress_activity</span> ${t('library.loading')}</div>`;
      }
    }
  } else {
    updateLoadMoreSentinel();
  }

  const keepSize = !append && (opts.keepLoaded || sameQuery);
  const refreshSize = keepSize ? Math.min(Math.max(PAGE_SIZE, mediaItems.length), 3000) : PAGE_SIZE;
  const options = buildSearchOptions(refreshSize, append ? mediaItems.length : 0);


  try {
    const searchResult = (await window.bds.searchLibrary(options)) || {};
    if (seq !== fetchSeq) return; // resposta obsoleta
    const items = searchResult.items || [];
    const total = Number.isFinite(searchResult.totalCount) ? searchResult.totalCount
      : (Number.isFinite(searchResult.total) ? searchResult.total : null);

    if (append) {
      // Compatível com backend sem suporte a offset: ignora itens repetidos
      const known = new Set(mediaItems.map(m => m.id));
      const fresh = items.filter(m => !known.has(m.id));
      appendFresh = fresh;
      pendingItems = mediaItems.concat(fresh);
      hasMore = fresh.length > 0 && items.length >= PAGE_SIZE;
    } else {
      pendingItems = items;
      hasMore = items.length >= refreshSize;
    }
    totalCount = total;
    if (typeof searchResult.hasMore === 'boolean') hasMore = searchResult.hasMore;
    else if (total !== null) hasMore = hasMore && pendingItems.length < total;
    everLoaded = true;
  } catch (err) {
    if (seq !== fetchSeq) return;
    console.error('[LIBRARY] Falha ao buscar mídias:', err);
    loadError = friendlyError(err, 'Falha desconhecida');
    hasMore = false;
  } finally {
    if (seq === fetchSeq) {
      isLoading = false;
      container?.removeAttribute('aria-busy');
    }
  }
  if (seq !== fetchSeq) return;

  if (loadError && !append) {
    updateMediaCount();
    unmountVirtual();
    renderLoadError(container);
    return;
  }
  if (loadError) { // falha ao carregar mais: mantém a lista e mostra "tentar de novo" no fim
    updateMediaCount();
    updateLoadMoreSentinel();
    return;
  }
  lastQuerySig = querySig;
  applyItems(pendingItems, { reset: !append && !sameQuery });
  updateMediaCount();
  if (!append || (appendFresh && appendFresh.length)) attachLoadMoreObserver();
}

/** Estado vazio com orientação: com filtro/busca ativos oferece limpar; sem nada, adicionar uma pasta. */
function buildEmptyStateHtml() {
  const filtering = !!currentSearch || document.querySelectorAll('.lib-filter-chk:checked').length > 0;
  if (filtering) {
    return '<div class="lib-empty-state bds-empty" role="status"><span class="material-symbols-rounded bds-empty-icon" aria-hidden="true">search_off</span>'
      + '<strong class="bds-empty-title">Nenhuma mídia corresponde à busca ou aos filtros</strong>'
      + '<span class="bds-empty-text">Tente outro termo ou remova alguns filtros.</span>'
      + '<button type="button" class="bds-empty-action" data-empty-action="clear-filters">Limpar filtros</button></div>';
  }
  return '<div class="lib-empty-state bds-empty" role="status"><span class="material-symbols-rounded bds-empty-icon" aria-hidden="true">video_library</span>'
    + '<strong class="bds-empty-title">Sua biblioteca ainda está vazia</strong>'
    + '<span class="bds-empty-text">Adicione uma pasta do computador para o BDS organizar seus vídeos, áudios e fotos. Você também pode baixar ou importar de um dispositivo.</span>'
    + '<button type="button" class="bds-empty-action" data-empty-action="add-source">Adicionar pasta</button></div>';
}

/**
 * Aplica a nova lista carregada. reset: consulta nova (rolagem volta ao topo e os cards são refeitos).
 * Sem reset a atualização é INCREMENTAL: cards que não mudaram são mantidos e a rolagem fica ancorada no item
 * que estava no topo da janela, mesmo que itens novos entrem acima dele.
 */
function applyItems(items, { reset = false } = {}) {
  const container = document.getElementById('libContentArea');
  if (!container) { mediaItems = items; return; }
  if (items.length === 0) {
    mediaItems = items;
    unmountVirtual();
    if (loadMoreObserver) { loadMoreObserver.disconnect(); loadMoreObserver = null; }
    container.innerHTML = buildEmptyStateHtml();
    return;
  }
  if (reset || !vRoot || !vLayout) {
    mediaItems = items;
    if (reset) { container.scrollTop = 0; lastScrollTop = 0; }
    relayout({ resetCards: reset, keepAnchor: false });
    return;
  }
  const anchor = captureAnchor();
  const diff = diffById(mediaItems, items);
  mediaItems = items;
  if (diff.unchanged) {
    // Mesma lista: só atualiza os cards cujos dados mudaram (e os dados usados nos cliques)
    rebuildIndex();
    syncVisibleCards();
    return;
  }
  relayout({ anchor });
}

function updateMediaCount() {
  const globalMediaCount = document.getElementById('globalMediaCount');
  if (!globalMediaCount) return;
  const loaded = mediaItems.length;
  const total = totalCount !== null ? totalCount : loaded;
  globalMediaCount.textContent = total > loaded
    ? t('library.countOf', { loaded: loaded.toLocaleString('pt-BR'), total: total.toLocaleString('pt-BR') })
    : t('library.countFound', { total: total.toLocaleString('pt-BR') });
}

function renderLoadError(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="lib-empty-state lib-error-state" role="alert">
      <p>${t('library.loadError')}</p>
      <p class="lib-error-detail">${escapeHtml(loadError)}</p>
      <button type="button" class="bds-btn-secondary" data-action="retry-load">${t('common.retry')}</button>
    </div>`;
}

/** Sentinela no fim da lista: ao aparecer na tela carrega a próxima página. */
function updateLoadMoreSentinel() {
  const container = document.getElementById('libContentArea');
  if (!container) return;
  let el = container.querySelector('#libLoadMore');
  if (!hasMore && !isLoading && !loadError) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'libLoadMore';
    el.className = 'lib-load-more';
    container.appendChild(el);
  }
  if (loadError) {
    el.innerHTML = `<span class="lib-error-detail">${t('library.loadMoreError')}</span> <button type="button" class="bds-btn-secondary" data-action="retry-more">${t('common.retry')}</button>`;
  } else {
    el.innerHTML = isLoading
      ? `<span class="material-symbols-rounded lib-loading-spin">progress_activity</span> ${t('library.loadingMore')}`
      : '';
  }
}

function attachLoadMoreObserver() {
  if (loadMoreObserver) { loadMoreObserver.disconnect(); loadMoreObserver = null; }
  updateLoadMoreSentinel();
  const sentinel = document.getElementById('libLoadMore');
  if (!sentinel || !hasMore || typeof IntersectionObserver === 'undefined') return;
  loadMoreObserver = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) loadMedia(true);
  }, { root: null, rootMargin: '600px' });
  loadMoreObserver.observe(sentinel);
}

// --- Agrupamento (cabeçalhos de data / faixa de tamanho entre os itens) ---
function makeGroupCtx() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const limits = [1, 5, 10, 25, 50];
  let current = 50;
  for (let i = 0; i < 15; i++) { current *= 2; limits.push(current); }
  return { todayStr: today.toDateString(), yesterdayStr: yesterday.toDateString(), limits };
}

const pad2 = (n) => (n < 10 ? '0' : '') + n;

function getGroupInfo(media, ctx) {
  if (currentSort === 'filesize') {
    const GB = 1024 * 1024 * 1024;
    const sizeGB = (media.filesize || 0) / GB;
    const limits = ctx.limits;
    for (let i = 0; i < limits.length; i++) {
      if (sizeGB <= limits[i]) return { key: 'Até ' + limits[i] + ' GB' };
    }
    return { key: 'Mais de ' + limits[limits.length - 1] + ' GB' };
  }
  const rawDate = String(media[currentSort] || media.imported_at || '');
  const cleanDate = rawDate.replace(' ', 'T') + (rawDate.endsWith('Z') ? '' : 'Z');
  const dateObj = new Date(cleanDate);
  if (isNaN(dateObj)) return { key: 'Data Desconhecida' };
  const ds = dateObj.toDateString();
  if (ds === ctx.todayStr) return { key: 'Hoje' };
  if (ds === ctx.yesterdayStr) return { key: 'Ontem' };
  // mesmo formato de toLocaleDateString('pt-BR'), sem o custo do Intl a cada item
  return { key: `${pad2(dateObj.getDate())}/${pad2(dateObj.getMonth() + 1)}/${dateObj.getFullYear()}` };
}

// =====================================================================================
// Janela virtual
//   - A lista inteira (mediaItems) fica em memória; o DOM só tem as LINHAS visíveis + margem.
//   - Linhas têm altura previsível: cabeçalho de grupo, linha da grade (cols cards) ou linha da lista.
//   - Cards são reaproveitados por id enquanto seus dados não mudam (atualização incremental).
// =====================================================================================

/** Largura/altura úteis da área de rolagem (com valores padrão quando o ambiente não mede, como nos testes). */
function measureViewport(container) {
  const w = (vRoot && vRoot.clientWidth) || (container.clientWidth ? container.clientWidth - 48 : 0) || 1000;
  const h = container.clientHeight || 800;
  return { w, h };
}

function unmountVirtual() {
  clearTimeout(thumbTimer); thumbTimer = null;
  for (const el of vCardEls.values()) releaseCard(el);
  vCardEls.clear();
  vRowEls.clear();
  vRange = { first: 0, last: -1 };
  vLayout = null;
  vSpacer = null;
  vRoot = null;
  vIdIndex = new Map();
}

function ensureVirtualRoot(container, grid) {
  if (!vRoot || vRoot.parentNode !== container) {
    unmountVirtual();
    container.innerHTML = '';
    vRoot = document.createElement('div');
    container.insertBefore(vRoot, container.firstChild);
  }
  const mode = grid ? 'grid' : 'list';
  if (vRoot.getAttribute('data-mode') === mode && vSpacer && vSpacer.parentNode === vRoot) return;
  // (re)monta o esqueleto do modo: a lista tem cabeçalho de colunas fixo; a grade só o espaçador
  vRowEls.clear();
  vRoot.setAttribute('data-mode', mode);
  vRoot.className = grid ? 'lib-vroot lib-vgrid' : 'lib-vroot lib-vlist';
  vRoot.style.setProperty('--lib-card-h', CARD_H + 'px');
  vRoot.style.setProperty('--lib-list-row-h', LIST_ROW_H + 'px');
  vRoot.style.setProperty('--lib-grid-gap', GRID_GAP + 'px');
  vRoot.innerHTML = grid
    ? '<div class="lib-vspacer" role="presentation"></div>'
    : `<div class="lib-vhead" role="row"><div role="columnheader">Mídia</div><div role="columnheader">Origem</div><div role="columnheader">Resolução</div><div role="columnheader">FPS</div><div role="columnheader">Tamanho</div></div><div class="lib-vspacer" role="rowgroup"></div>`;
  if (grid) { vRoot.removeAttribute('role'); vRoot.removeAttribute('aria-multiselectable'); }
  else { vRoot.setAttribute('role', 'grid'); vRoot.setAttribute('aria-multiselectable', 'true'); }
  vSpacer = vRoot.querySelector('.lib-vspacer');
}

function rebuildIndex() {
  vIdIndex = new Map();
  for (let i = 0; i < mediaItems.length; i++) vIdIndex.set(mediaItems[i].id, i);
  if (vRoot && vRoot.getAttribute('data-mode') === 'list') vRoot.setAttribute('aria-rowcount', String(mediaItems.length + 1));
}

function mediaAtId(id) {
  const i = vIdIndex.get(id);
  return i === undefined ? undefined : mediaItems[i];
}

/** Item que está no topo da janela e a posição da linha dele em relação ao topo (para manter a posição quando o layout muda). */
function captureAnchor() {
  const container = document.getElementById('libContentArea');
  if (!container || !vLayout || !mediaItems.length) return null;
  const st = container.scrollTop || 0;
  if (st <= 0) return null; // no topo: itens novos aparecem normalmente
  const y = Math.max(0, st - vLayout.originY);
  let r = rowAt(vLayout.tops, y);
  while (r >= 0 && r < vLayout.rows.length && vLayout.rows[r].kind !== 'items') r++;
  if (r < 0 || r >= vLayout.rows.length) return null;
  const m = mediaItems[vLayout.rows[r].start];
  return m ? { id: m.id, offset: vLayout.tops[r] - y } : null; // posição da linha em relação ao topo da janela
}

/**
 * Recalcula colunas/linhas/posições e redesenha a janela. Chamada quando a lista, o modo ou a largura mudam.
 * @param {{anchor?: {id:any, offset:number}|null, keepAnchor?: boolean, resetCards?: boolean}} [opts]
 */
function relayout({ anchor, keepAnchor = false, resetCards = false } = {}) {
  const container = document.getElementById('libContentArea');
  if (!container || !mediaItems.length) return;
  if (vLayout && container.clientWidth === 0 && container.clientHeight === 0) return; // tela oculta: remede ao voltar
  if (anchor === undefined) anchor = keepAnchor ? captureAnchor() : null;
  const focusedId = container.contains(document.activeElement) ? document.activeElement.getAttribute('data-id') : null;

  const grid = viewMode === 'grid';
  const modeChanged = !!vLayout && vLayout.mode !== viewMode;
  if (resetCards || modeChanged) {
    for (const el of vCardEls.values()) releaseCard(el);
    vCardEls.clear();
  }
  ensureVirtualRoot(container, grid);
  for (const el of vRowEls.values()) el.remove();
  vRowEls.clear();

  const { w } = measureViewport(container);
  const cols = grid ? computeColumns(w, GRID_MIN_COL, GRID_GAP) : 1;
  const ctx = makeGroupCtx();
  const groups = groupConsecutive(mediaItems, (m) => getGroupInfo(m, ctx));
  const { rows, rowOfItem } = buildRows(groups, cols, mediaItems.length);
  const rowH = grid ? GRID_ROW_H : LIST_ROW_H;
  const tops = rowTops(rows, GROUP_HEADER_H, rowH);
  vSpacer.style.height = tops[rows.length] + 'px';
  const originY = typeof vSpacer.offsetTop === 'number' && vSpacer.offsetTop > 0 ? vSpacer.offsetTop : (24 + (grid ? 0 : LIST_HEAD_H));
  vLayout = { mode: viewMode, cols, groups, rows, rowOfItem, tops, rowH, total: mediaItems.length, originY, headH: grid ? 0 : LIST_HEAD_H };
  vRange = { first: 0, last: -1 };
  rebuildIndex();

  if (anchor) {
    const idx = vIdIndex.get(anchor.id);
    if (idx !== undefined) {
      const st = scrollTopForAnchor({ index: idx, offset: anchor.offset }, rowOfItem, tops);
      if (st !== null) container.scrollTop = st + originY;
    }
  }
  renderWindow(true);
  if (focusedId) vCardEls.get(mediaAtId(parseInt(focusedId, 10))?.id)?.focus();
}

/** Redimensionamento: refaz o layout só se as colunas mudaram; senão apenas completa a janela. */
function scheduleLayout() {
  if (vLayoutTimer) return;
  vLayoutTimer = setTimeout(() => {
    vLayoutTimer = null;
    const container = document.getElementById('libContentArea');
    if (!container || !vLayout) return;
    if (container.clientWidth === 0 && container.clientHeight === 0) return;
    const grid = viewMode === 'grid';
    const cols = grid ? computeColumns(measureViewport(container).w, GRID_MIN_COL, GRID_GAP) : 1;
    if (cols !== vLayout.cols || vLayout.mode !== viewMode) relayout({ keepAnchor: true });
    else renderWindow(true);
  }, 30);
}

function setupVirtualScroll() {
  const container = document.getElementById('libContentArea');
  if (!container || container.dataset.hasVirtualScroll) return;
  container.dataset.hasVirtualScroll = 'true';
  container.addEventListener('scroll', () => {
    lastScrollTop = container.scrollTop || 0;
    renderWindow(); // o navegador já dispara 'scroll' no máximo uma vez por quadro; sem custo quando o intervalo não muda
  }, { passive: true });
}

/** Desenha as linhas do intervalo visível (+ margem) e remove as que saíram. */
function renderWindow(force = false) {
  const container = document.getElementById('libContentArea');
  const L = vLayout;
  if (!container || !L || !vSpacer) return;
  const viewH = container.clientHeight || 800;
  const y = (container.scrollTop || 0) - L.originY;
  const range = visibleRange(L.tops, y, viewH, OVERSCAN_PX);
  if (!force && range.first === vRange.first && range.last === vRange.last) { maybeLoadMore(); return; }
  vRange = range;

  for (const [r, el] of vRowEls) {
    if (r < range.first || r > range.last) { el.remove(); vRowEls.delete(r); }
  }
  const used = new Set();
  for (let r = range.first; r <= range.last; r++) {
    const row = L.rows[r];
    let el = vRowEls.get(r);
    if (!el) {
      el = buildRowEl(r);
      // mantém a ordem do DOM = ordem da lista (tabulação e leitores de tela)
      let before = null;
      for (const [k, other] of vRowEls) if (k > r && (!before || k < before.k)) before = { k, el: other };
      vSpacer.insertBefore(el, before ? before.el : null);
      vRowEls.set(r, el);
    }
    if (row.kind === 'items') {
      for (let k = 0; k < row.count; k++) used.add(mediaItems[row.start + k].id);
    }
  }
  // Cards que saíram da janela: cancela a miniatura em andamento e descarta
  for (const [id, el] of vCardEls) {
    if (!used.has(id)) { releaseCard(el); vCardEls.delete(id); }
  }
  scheduleThumbs();
  maybeLoadMore();
}

function buildRowEl(r) {
  const L = vLayout;
  const row = L.rows[r];
  const el = document.createElement('div');
  el.className = 'lib-vrow';
  el.setAttribute('data-row', String(r));
  el.style.top = L.tops[r] + 'px';
  el.style.height = (L.tops[r + 1] - L.tops[r]) + 'px';
  if (row.kind === 'header') {
    el.classList.add('lib-vrow-header');
    if (L.mode === 'list') {
      el.setAttribute('role', 'row');
      el.innerHTML = `<div class="lib-date-header" role="rowheader">${escapeHtml(row.key)}</div>`;
    } else {
      el.innerHTML = `<div class="lib-date-header">${escapeHtml(row.key)}</div>`;
    }
    return el;
  }
  el.classList.add('lib-vrow-items');
  if (L.mode === 'grid') el.style.gridTemplateColumns = `repeat(${L.cols}, minmax(0, 1fr))`;
  fillRow(el, row);
  return el;
}

/** Garante que a linha contém exatamente os cards dos seus itens, na ordem (sem recriar os que não mudaram). */
function fillRow(rowEl, row) {
  const desired = [];
  for (let k = 0; k < row.count; k++) desired.push(getCardEl(row.start + k));
  for (let i = 0; i < desired.length; i++) {
    if (rowEl.children[i] !== desired[i]) rowEl.insertBefore(desired[i], rowEl.children[i] || null);
  }
  while (rowEl.children.length > desired.length) rowEl.removeChild(rowEl.lastElementChild);
}

/** Dados que mudam o desenho do card (a seleção é aplicada à parte, sem recriar). */
function cardSig(m) {
  return [m.filename, m.thumbnail, m.favorite ? 1 : 0, m.origin, m.height, m.fps, m.filesize, m.duration, m.video_codec, m.recorded_at, m.imported_at, m.uuid, m.filepath, viewMode].join('|');
}

function getCardEl(index) {
  const m = mediaItems[index];
  const sig = cardSig(m);
  let el = vCardEls.get(m.id);
  if (el && el.__sig === sig) return el;
  if (el) releaseCard(el);
  const tpl = document.createElement('div');
  tpl.innerHTML = viewMode === 'grid' ? renderGridCard(m) : renderListRow(m);
  el = tpl.firstElementChild;
  tpl.removeChild(el);
  el.__sig = sig;
  vCardEls.set(m.id, el);
  return el;
}

/** Descarta um card: cancela a miniatura que ainda estiver carregando. */
function releaseCard(el) {
  try {
    el.querySelectorAll('img').forEach((img) => { img.removeAttribute('src'); img.removeAttribute('data-src'); });
  } catch (_) { /* noop */ }
}

/** Mesma lista, dados novos: atualiza só os cards cujos dados mudaram. */
function syncVisibleCards() {
  if (!vLayout) return;
  for (const [r, el] of vRowEls) {
    const row = vLayout.rows[r];
    if (row && row.kind === 'items') fillRow(el, row);
  }
  scheduleThumbs();
}

// --- Miniaturas e waveforms: só depois que a rolagem assenta, e só dos cards que continuam na janela ---
function scheduleThumbs() {
  if (thumbTimer) return;
  thumbTimer = setTimeout(() => { thumbTimer = null; flushThumbs(); }, THUMB_DEBOUNCE_MS);
}

function flushThumbs() {
  for (const el of vRowEls.values()) {
    el.querySelectorAll('img[data-src]').forEach((img) => {
      img.src = img.getAttribute('data-src');
      img.removeAttribute('data-src');
    });
    el.querySelectorAll('.lib-list-thumb[data-thumb]').forEach((d) => {
      d.style.backgroundImage = `url('${d.getAttribute('data-thumb')}')`;
      d.removeAttribute('data-thumb');
    });
    el.querySelectorAll('.lib-card-waveform:not([data-loaded])').forEach(loadWaveform);
  }
}

/** Pede mais uma página quando a janela chega perto do fim do que já foi carregado. */
function maybeLoadMore() {
  if (!hasMore || isLoading || loadError || !vLayout) return;
  const container = document.getElementById('libContentArea');
  if (!container) return;
  const total = vLayout.originY + vLayout.tops[vLayout.rows.length];
  if ((container.scrollTop || 0) + (container.clientHeight || 800) >= total - LOAD_AHEAD_PX) loadMedia(true);
}

function selectAllLoaded() {
  selectedIds = new Set(mediaItems.map((m) => m.id));
  lastSelectedId = mediaItems.length ? mediaItems[mediaItems.length - 1].id : null;
  updateSelectionVisuals();
}

function setupDelegatedMediaClicks() {
  const container = document.getElementById('libContentArea');
  if (!container || container.dataset.hasDelegatedClick) return;
  container.dataset.hasDelegatedClick = 'true';

  // Miniatura ausente/corrompida: esconde o <img> (equivale ao background-image que falhava em silêncio)
  container.addEventListener('error', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('lib-card-img')) e.target.style.display = 'none';
  }, true);

  container.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="retry-load"]')) { fetchMedia(); return; }
    if (e.target.closest('[data-action="retry-more"]')) { loadError = null; hasMore = true; loadMedia(true); return; }
    const item = e.target.closest('.media-clickable');
    if (!item) return;

    const id = parseInt(item.getAttribute('data-id'));

    const favBadge = e.target.closest('.lib-card-badge-fav');
    if (favBadge) {
      toggleFavoriteLocal(id, !favBadge.classList.contains('active'));
      return;
    }

    const favBadgeList = e.target.closest('.lib-list-fav-btn');
    if (favBadgeList) {
      toggleFavoriteLocal(id, !favBadgeList.classList.contains('active'));
      return;
    }

    const isCheckbox = e.target.closest('.lib-card-checkbox');

    if (e.shiftKey && !isCheckbox && lastSelectedId != null) {
      // Seleção de intervalo: do último item clicado até este (ctrl+shift soma à seleção atual)
      const range = rangeBetween(mediaItems.map((m) => m.id), lastSelectedId, id);
      if (range) {
        if (!(e.ctrlKey || e.metaKey)) selectedIds = new Set();
        for (let i = range[0]; i <= range[1]; i++) selectedIds.add(mediaItems[i].id);
        updateSelectionVisuals();
        return;
      }
    }

    if (isCheckbox || e.ctrlKey || e.metaKey) {
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      lastSelectedId = id;
      updateSelectionVisuals(id);
    } else {
      lastSelectedId = id;
      const media = mediaAtId(id);
      if (media) openInspector(media);
    }
  });

  // Teclado: Enter abre o inspetor, Espaço alterna seleção, setas navegam entre os itens (índice, não DOM)
  container.addEventListener('keydown', (e) => {
    const item = e.target.closest && e.target.closest('.media-clickable');
    if (!item || e.target !== item) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: e.key === ' ' || e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey }));
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    if (!vLayout) return;
    const idx = vIdIndex.get(parseInt(item.getAttribute('data-id')));
    if (idx === undefined) return;
    const target = navigateIndex(e.key, idx, vLayout.rows, vLayout.rowOfItem, vLayout.total);
    if (target >= 0 && target !== idx) { e.preventDefault(); focusItemIndex(target); }
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) e.preventDefault();
  });

  // Duplo clique abre o Preview diretamente com a coleção
  container.addEventListener('dblclick', (e) => {
    const item = e.target.closest('.media-clickable');
    if (!item) return;
    if (e.target.closest('.lib-card-checkbox') || e.target.closest('.lib-card-badge-fav') || e.target.closest('.lib-list-fav-btn')) return;

    const id = parseInt(item.getAttribute('data-id'));
    const media = mediaAtId(id);
    if (media && window.openPreview) {
      window.openPreview(media, mediaItems);
    }
  });
}

/** Rola (se preciso) até o item, desenha a janela e foca o card: o alvo pode estar fora do DOM. */
function focusItemIndex(index) {
  const container = document.getElementById('libContentArea');
  const L = vLayout;
  if (!container || !L || index < 0 || index >= mediaItems.length) return;
  const pos = itemPosition(index, L.rowOfItem, L.tops);
  if (!pos) return;
  // se é a 1ª linha do grupo, revela também o cabeçalho do grupo; a lista tem cabeçalho de colunas fixo no topo
  const hasHeader = pos.row > 0 && L.rows[pos.row - 1].kind === 'header';
  const top = hasHeader ? L.tops[pos.row - 1] : pos.top;
  const height = pos.top + pos.height - top;
  let st = scrollToReveal(top + L.originY - L.headH, height + L.headH, container.scrollTop || 0, container.clientHeight || 800, 8);
  if (st !== null && pos.row <= 1) st = 0; // primeiro item: volta ao topo absoluto
  if (st !== null) { container.scrollTop = st; lastScrollTop = st; }
  renderWindow(true);
  const el = vCardEls.get(mediaItems[index].id);
  if (el) el.focus();
}

/** Alterna favorito no card/linha/inspetor sem refazer a lista. */
function applyFavoriteDom(id, isFav) {
  const m = mediaAtId(id);
  if (m) m.favorite = isFav ? 1 : 0;
  if (currentInspectorMedia && currentInspectorMedia.id === id) currentInspectorMedia.favorite = isFav ? 1 : 0;
  const container = document.getElementById('libContentArea');
  const el = container?.querySelector(`.media-clickable[data-id="${CSS.escape(String(id))}"]`);
  el?.querySelectorAll('.lib-card-badge-fav, .lib-list-fav-btn').forEach((b) => {
    b.classList.toggle('active', isFav);
    b.textContent = isFav ? 'star' : 'star_border';
    b.setAttribute('aria-label', isFav ? 'Remover dos favoritos' : 'Favoritar');
  });
  const cardEl = vCardEls.get(id);
  if (cardEl && m) cardEl.__sig = cardSig(m); // o DOM já está atualizado: não precisa recriar o card
  const favStar = document.getElementById('inspectorFavStar');
  if (favStar && currentInspectorMedia && currentInspectorMedia.id === id) {
    favStar.classList.toggle('active', isFav);
    favStar.textContent = isFav ? 'star' : 'star_border';
  }
}

let favFiltersTimer = null;
async function toggleFavoriteLocal(id, isFav) {
  if (!window.bds || !window.bds.toggleFavorite) return;
  applyFavoriteDom(id, isFav);
  try {
    await window.bds.toggleFavorite(id, isFav);
  } catch (err) {
    console.error('[LIBRARY] Falha ao alterar favorito:', err);
    applyFavoriteDom(id, !isFav);
    return;
  }
  if (currentFilters.favorites) fetchMedia(); // o item pode sair da lista filtrada
  // contadores dos filtros (ex.: total de favoritos) em segundo plano, sem bloquear o clique
  clearTimeout(favFiltersTimer);
  favFiltersTimer = setTimeout(() => loadFilterOptions(), 1200);
}

function updateSelectionVisuals(onlyId) {
  const container = document.getElementById('libContentArea');
  if (!container) return;
  
  const items = onlyId !== undefined
    ? container.querySelectorAll(`.media-clickable[data-id="${CSS.escape(String(onlyId))}"]`)
    : container.querySelectorAll('.media-clickable');
  items.forEach(item => {
    const id = parseInt(item.getAttribute('data-id'));
    const isSelected = selectedIds.has(id);
    item.classList.toggle('selected', isSelected);
    if (item.getAttribute('role') === 'button') item.setAttribute('aria-pressed', String(isSelected));
    else item.setAttribute('aria-selected', String(isSelected));
    const checkbox = item.querySelector('.lib-card-checkbox');
    if (checkbox) checkbox.checked = isSelected;
  });

  const actionBar = document.getElementById('libActionBar');
  const selectedCountLabel = document.getElementById('libSelectedCount');
  
  if (actionBar && selectedCountLabel) {
    if (selectedIds.size > 0) {
      actionBar.classList.remove('hidden');
      actionBar.classList.add('active');
      selectedCountLabel.textContent = `${selectedIds.size} selecionado${selectedIds.size > 1 ? 's' : ''}`;
    } else {
      actionBar.classList.add('hidden');
      actionBar.classList.remove('active');
    }
  }
}

// --- Waveforms de áudio na Biblioteca (reaproveita o cache do WaveformService) ---
const waveformPending = new Map(); // uuid -> Promise (evita pedido duplicado ao rolar de volta)

function loadWaveform(canvas) {
  if (!canvas || canvas.dataset.loaded) return;
  const uuid = canvas.dataset.uuid;
  const filePath = canvas.dataset.path;
  if (!uuid || !filePath || !window.bds?.getMediaWaveform) return;
  canvas.dataset.loaded = '1';
  const cached = waveformCache.get(uuid);
  if (cached) { drawLibWaveform(canvas, cached); return; }
  let p = waveformPending.get(uuid);
  if (!p) {
    p = Promise.resolve(window.bds.getMediaWaveform({ uuid, filePath, peaksPerSecond: 50, streamIndex: 0 }))
      .then((wf) => {
        if (wf && wf.peaks) {
          if (waveformCache.size >= 300) waveformCache.delete(waveformCache.keys().next().value);
          waveformCache.set(uuid, wf.peaks);
          return wf.peaks;
        }
        return null;
      })
      .catch(() => null /* mídia sem waveform disponível, mantém card em branco */)
      .finally(() => { waveformPending.delete(uuid); });
    waveformPending.set(uuid, p);
  }
  p.then((peaks) => {
    // o card pode ter saído da janela enquanto o pedido corria: ignora o desenho
    if (peaks && canvas.parentNode) drawLibWaveform(canvas, peaks);
  });
}

function drawLibWaveform(canvas, peaks) {
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width = canvas.clientWidth || 200;
  const h = canvas.height = canvas.clientHeight || 60;
  ctx.clearRect(0, 0, w, h);

  const step = Math.max(1, Math.floor(peaks.length / w));
  const mid = h / 2;
  ctx.fillStyle = 'rgba(167, 139, 250, 0.85)';

  for (let x = 0; x < w; x++) {
    const idx = x * step;
    let peak = 0;
    for (let j = idx; j < idx + step && j < peaks.length; j++) {
      if (peaks[j] > peak) peak = peaks[j];
    }
    const barH = Math.max(1, peak * (h - 4));
    ctx.fillRect(x, mid - barH / 2, 1, barH);
  }
}

function renderGridCard(media) {
  const thumbUrl = media.thumbnail ? joinFileUrl(thumbsDir, media.thumbnail) : '';
  const rawDate = media.recorded_at || media.imported_at;
  const cleanDate = rawDate ? rawDate.replace(' ', 'T') + (rawDate.endsWith('Z') ? '' : 'Z') : '';
  const dateObj = new Date(cleanDate);
  const dateStr = isNaN(dateObj) ? '-' : dateObj.toLocaleDateString('pt-BR');
  const isSelected = selectedIds.has(media.id);
  
  const isPhoto = media.filename && !!media.filename.match(/\.(jpg|jpeg|png|webp|gif|bmp|arw|cr2|cr3|nef|dng|raf|rw2|orf)$/i);
  const isAudio = media.filename && !!media.filename.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i);

  const originText = originLabel(media.origin);

  const favClass = media.favorite ? 'active' : '';
  const favIcon = media.favorite ? 'star' : 'star_border';

  const thumbClass = isAudio && !thumbUrl ? 'lib-card-thumb audio-placeholder' : 'lib-card-thumb';
  // data-src: o src só é atribuído quando a rolagem assenta (flushThumbs), para não baixar o que passa voando
  const thumbImg = thumbUrl ? `<img class="lib-card-img" data-src="${escapeAttr(thumbUrl)}" alt="" loading="lazy" decoding="async" draggable="false">` : '';
  const audioWaveform = isAudio && !thumbUrl
    ? `<canvas class="lib-card-waveform" data-uuid="${escapeAttr(media.uuid || '')}" data-path="${escapeAttr(media.filepath || '')}" width="200" height="60"></canvas>`
    : '';
  const durationBadge = (!isPhoto && !isAudio) ? `<div class="lib-card-duration">${formatDuration(media.duration)}</div>` : '';
  const audioDurationBadge = isAudio ? `<div class="lib-card-duration">${formatDuration(media.duration)}</div>` : '';

  return `
    <div class="lib-card media-clickable ${isSelected ? 'selected' : ''}" data-id="${escapeAttr(media.id)}" tabindex="0" role="button" aria-pressed="${isSelected}" aria-label="${escapeAttr(media.filename)}">
      <div class="${thumbClass}">
        ${thumbImg}
        <input type="checkbox" class="lib-card-checkbox" aria-label="Selecionar" ${isSelected ? 'checked' : ''}>
        <span class="material-symbols-rounded lib-card-badge-fav ${favClass}" role="button" aria-label="${media.favorite ? 'Remover dos favoritos' : 'Favoritar'}">${favIcon}</span>
        ${audioWaveform}
        ${durationBadge}
        ${audioDurationBadge}
      </div>
      <div class="lib-card-info">
        <div class="lib-card-title" title="${escapeAttr(media.filename)}">${escapeHtml(media.filename)}</div>
        <div class="lib-card-meta">
          <span>${dateStr}</span>
          <span>${isPhoto ? 'Foto' : (isAudio ? 'Áudio' : (media.video_codec ? media.height+'p' : ''))}</span>
          <span>${(!isPhoto && !isAudio && media.fps) ? media.fps+'fps' : ''}</span>
        </div>
        <div class="lib-card-origin">${escapeHtml(originText)}</div>
      </div>
    </div>
  `;
}

function renderListRow(media) {
  const thumbUrl = media.thumbnail ? joinFileUrl(thumbsDir, media.thumbnail) : '';
  const icon = (media.origin && media.origin.includes('BDSM')) ? 'smartphone' : 'computer';
  const isSelected = selectedIds.has(media.id);
  const favClass = media.favorite ? 'active' : '';
  const favIcon = media.favorite ? 'star' : 'star_border';
  // data-thumb: o background só é aplicado quando a rolagem assenta (flushThumbs)
  const thumbAttr = thumbUrl ? ` data-thumb="${escapeAttr(thumbUrl)}"` : '';

  return `
    <div class="media-clickable lib-list-row ${isSelected ? 'selected' : ''}" data-id="${escapeAttr(media.id)}" tabindex="0" role="row" aria-selected="${isSelected}" aria-label="${escapeAttr(media.filename)}">
      <div class="lib-list-cell" role="gridcell">
        <div class="lib-list-cell-content">
          <input type="checkbox" class="lib-card-checkbox" aria-label="Selecionar" ${isSelected ? 'checked' : ''}>
          <div class="lib-list-thumb"${thumbAttr}></div>
          <span class="material-symbols-rounded lib-list-fav-btn ${favClass}" role="button" aria-label="${media.favorite ? 'Remover dos favoritos' : 'Favoritar'}">${favIcon}</span>
          <span class="lib-list-filename" title="${escapeAttr(media.filename)}">${escapeHtml(media.filename)}</span>
        </div>
      </div>
      <div class="lib-list-cell" role="gridcell">
        <div class="lib-list-origin-cell">
          <span class="material-symbols-rounded">${icon}</span>
          <span class="lib-list-origin-text">${escapeHtml(originLabel(media.origin))}</span>
        </div>
      </div>
      <div class="lib-list-cell" role="gridcell">${media.height ? media.height + 'p' : '-'}</div>
      <div class="lib-list-cell" role="gridcell">${media.fps || '-'}</div>
      <div class="lib-list-cell" role="gridcell">${formatBytes(media.filesize)}</div>
    </div>
  `;
}

function openInspector(media) {
  currentInspectorMedia = media;
  const inspector = document.getElementById('libraryInspector');
  if (!inspector) return;
  
  const thumbUrl = media.thumbnail ? joinFileUrl(thumbsDir, media.thumbnail) : '';
  const thumbEl = document.getElementById('inspectorThumbnail');
  if (thumbEl) thumbEl.style.backgroundImage = `url('${thumbUrl}')`;
  
  const titleEl = document.getElementById('inspectorTitle');
  const titleEdit = document.getElementById('inspectorTitleEdit');
  if (titleEl) titleEl.textContent = media.filename;
  if (titleEdit) titleEdit.value = media.filename;
  if (titleEl) {
    titleEl.classList.remove('hidden');
    titleEl.style.display = 'block';
  }
  if (titleEdit) {
    titleEdit.classList.add('hidden');
    titleEdit.style.display = 'none';
  }
  
  const isPhoto = media.filename && !!media.filename.match(/\.(jpg|jpeg|png|webp|gif|bmp|arw|cr2|cr3|nef|dng|raf|rw2|orf)$/i);
  const isAudio = media.filename && !!media.filename.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i);

  const btnPlayMedia = document.getElementById('btnPlayMedia');
  if (btnPlayMedia) {
    btnPlayMedia.style.display = 'flex';
    const icon = btnPlayMedia.querySelector('.material-symbols-rounded');
    if (icon) {
      icon.textContent = isPhoto ? 'visibility' : 'play_arrow';
    }
  }

  const thumbDuration = document.getElementById('inspectorThumbDuration');
  if (thumbDuration) {
    thumbDuration.style.display = isPhoto ? 'none' : 'block';
  }

  const setEl = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setEl('inspectorSize', formatBytes(media.filesize));
  setEl('inspectorRes', media.width ? `${media.width}x${media.height}` : '-');
  setEl('inspectorVCodec', media.video_codec || '-');
  setEl('inspectorACodec', media.audio_codec || '-');
  setEl('inspectorFps', media.fps || '-');
  setEl('inspectorOrigin', originLabel(media.origin));
  
  const parseDBDate = (dateStr) => {
    if (!dateStr) return null;
    const cleanStr = dateStr.replace(' ', 'T') + (dateStr.endsWith('Z') ? '' : 'Z');
    const d = new Date(cleanStr);
    return isNaN(d) ? null : d;
  };

  const importedD = parseDBDate(media.imported_at);
  const recordedD = parseDBDate(media.recorded_at);

  setEl('inspectorDate', importedD ? importedD.toLocaleString('pt-BR') : '-');
  setEl('inspectorRecordDate', recordedD ? recordedD.toLocaleString('pt-BR') : '-');
  setEl('inspectorDuration', isPhoto ? '-' : formatDuration(media.duration));
  
  if (thumbDuration) {
    if (isPhoto) {
      thumbDuration.style.display = 'none';
    } else {
      thumbDuration.style.display = 'block';
      thumbDuration.textContent = formatDuration(media.duration);
    }
  }

  function formatBitrate(bps) {
    if (!bps) return '-';
    const kbps = bps / 1000;
    if (kbps > 1000) return (kbps / 1000).toFixed(1) + ' Mbps';
    return Math.round(kbps) + ' kbps';
  }

  const bitrateStr = formatBitrate(media.bitrate);
  
  if (isAudio) {
    setEl('inspectorVBitrate', '-');
    setEl('inspectorABitrate', bitrateStr);
  } else if (!isPhoto) {
    setEl('inspectorVBitrate', bitrateStr);
    setEl('inspectorABitrate', '-');
  } else {
    setEl('inspectorVBitrate', '-');
    setEl('inspectorABitrate', '-');
  }

  const toggleRow = (id, show) => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? 'flex' : 'none';
  };

  toggleRow('rowDuration', !isPhoto);
  toggleRow('rowFps', !isPhoto && !isAudio);
  toggleRow('rowVCodec', !isPhoto && !isAudio);
  toggleRow('rowVBitrate', !isPhoto && !isAudio);
  toggleRow('rowRes', !isAudio);
  toggleRow('rowACodec', !isPhoto);
  toggleRow('rowABitrate', !isPhoto);

  setEl('inspectorPath', media.filepath);
  
  const favStar = document.getElementById('inspectorFavStar');
  if (favStar) {
    if (media.favorite === 1) {
      favStar.classList.add('active');
      favStar.textContent = 'star';
    } else {
      favStar.classList.remove('active');
      favStar.textContent = 'star_border';
    }
  }

  setEl('inspectorProject', media.project_name ? media.project_name : 'Nenhum (Vincular)');

  loadMediaTags(media.id);
  
  inspector.classList.remove('hidden');
  inspector.classList.add('active');
}

async function loadMediaTags(mediaId) {
  const tagsContainer = document.getElementById('inspectorTags');
  const addBtn = document.getElementById('btnAddTag');
  if (!tagsContainer || !addBtn) return;
  
  tagsContainer.innerHTML = '';
  tagsContainer.appendChild(addBtn);

  if (!window.bds || !window.bds.getMediaTags) return;
  const tags = await window.bds.getMediaTags(mediaId);
  
  tags.forEach(tag => {
    const span = document.createElement('span');
    span.className = 'inspector-tag-chip';
    let displayName = tag.name;
    if (displayName.startsWith('TAG:creation_time=')) {
        displayName = 'Data da Gravação: ' + displayName.replace('TAG:creation_time=', '');
    }
    span.innerHTML = `
      ${escapeHtml(displayName)}
      <span class="material-symbols-rounded remove-tag" data-id="${escapeAttr(tag.id)}" role="button" aria-label="Remover tag">close</span>
    `;
    tagsContainer.insertBefore(span, addBtn);
  });

  tagsContainer.querySelectorAll('.remove-tag').forEach(el => {
    el.addEventListener('click', async (e) => {
      const tagId = e.target.getAttribute('data-id');
      if (tagId && window.bds && window.bds.removeMediaTag) {
        await window.bds.removeMediaTag(mediaId, tagId);
        loadMediaTags(mediaId);
        loadFilterOptions();
      }
    });
  });
}

function bindInspectorEvents() {
  const titleText = document.getElementById('inspectorTitle');
  const titleEdit = document.getElementById('inspectorTitleEdit');

  if (titleText && titleEdit) {
    titleText.addEventListener('click', () => {
      titleText.style.display = 'none';
      titleText.classList.add('hidden');
      titleEdit.style.display = 'block';
      titleEdit.classList.remove('hidden');
      titleEdit.focus();
    });

    titleEdit.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const newName = titleEdit.value.trim();
        if (newName && currentInspectorMedia) {
          // Renomeia o arquivo no disco (extensão preservada); erros vindos do backend são mostrados (RK-082)
          const previous = titleText.textContent;
          titleText.textContent = newName;
          if (window.bds && window.bds.renameMedia) {
            try {
              await window.bds.renameMedia(currentInspectorMedia.id, newName);
            } catch (err) {
              titleText.textContent = previous;
              window.bdsModal.alert('Não foi possível renomear: ' + friendlyError(err));
            }
          }
          fetchMedia();
        }
        titleEdit.style.display = 'none';
        titleEdit.classList.add('hidden');
        titleText.style.display = 'block';
        titleText.classList.remove('hidden');
      }
      if (e.key === 'Escape') {
        titleEdit.value = titleText.textContent;
        titleEdit.style.display = 'none';
        titleEdit.classList.add('hidden');
        titleText.style.display = 'block';
        titleText.classList.remove('hidden');
      }
    });
  }

  const favStar = document.getElementById('inspectorFavStar');
  if (favStar) {
    favStar.addEventListener('click', async () => {
      if (!currentInspectorMedia) return;
      // Mesmo caminho da estrela do card: atualiza o DOM, grava, reverte se falhar e refaz os contadores dos filtros
      await toggleFavoriteLocal(currentInspectorMedia.id, currentInspectorMedia.favorite !== 1);
    });
  }

  // Copiar caminho do arquivo
  const copyPathBtn = document.querySelector('.inspector-copy-btn');
  if (copyPathBtn) {
    copyPathBtn.setAttribute('role', 'button');
    copyPathBtn.setAttribute('tabindex', '0');
    const copyPath = async () => {
      const text = currentInspectorMedia?.filepath || '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        copyPathBtn.textContent = 'check';
        setTimeout(() => { copyPathBtn.textContent = 'content_copy'; }, 1200);
      } catch (err) {
        console.error('[LIBRARY] Falha ao copiar caminho:', err);
        window.bdsModal.alert('Não foi possível copiar o caminho.');
      }
    };
    copyPathBtn.addEventListener('click', copyPath);
    copyPathBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyPath(); } });
  }

  const btnAddTag = document.getElementById('btnAddTag');
  const tagEdit = document.getElementById('inspectorTagEdit');
  if (btnAddTag && tagEdit) {
    btnAddTag.addEventListener('click', () => {
      tagEdit.style.display = 'block';
      tagEdit.classList.remove('hidden');
      tagEdit.focus();
    });

    tagEdit.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const tagName = tagEdit.value.trim();
        if (tagName && currentInspectorMedia && window.bds && window.bds.addMediaTag) {
          await window.bds.addMediaTag(currentInspectorMedia.id, tagName);
          tagEdit.value = '';
          tagEdit.style.display = 'none';
          tagEdit.classList.add('hidden');
          loadMediaTags(currentInspectorMedia.id);
          loadFilterOptions();
        }
      }
      if (e.key === 'Escape') {
        tagEdit.value = '';
        tagEdit.style.display = 'none';
        tagEdit.classList.add('hidden');
      }
    });
  }

  // Vincular Projeto pelo Inspetor
  const inspectorProjectEl = document.querySelector('.inspector-value-project');
  if (inspectorProjectEl) {
    inspectorProjectEl.style.cursor = 'pointer';
    inspectorProjectEl.addEventListener('click', () => {
      if (currentInspectorMedia) {
        openAddToProjectModal([currentInspectorMedia.id]);
      }
    });
  }

  // Bulk Actions
  const btnDeleteBulk = document.getElementById('btnActionDelete');
  if (btnDeleteBulk) {
    btnDeleteBulk.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      // Informa os vínculos de projeto que serão apagados junto (RK-015)
      let linkInfo = '';
      try {
        const impact = window.bds && window.bds.getMediaProjectLinks ? await window.bds.getMediaProjectLinks(ids) : null;
        if (impact && impact.links > 0) linkInfo = `\n\nAtenção: isto também remove ${impact.text} (mídia, grupos de sincronização e timeline).`;
      } catch (_) { /* sem a contagem, segue só com o aviso padrão */ }
      const conf = await window.bdsModal.confirm(`Tem certeza que deseja excluir ${ids.length} arquivo(s)? Os arquivos vão para a Lixeira.${linkInfo}`);
      if (conf && window.bds && window.bds.deleteMediaBulk) {
        const res = await window.bds.deleteMediaBulk(ids);
        selectedIds.clear();
        reportBatchResult(res, res && res.deleted);
        updateSelectionVisuals();
        fetchMedia();
        loadFilterOptions();
      }
    });
  }

  const btnFavBulk = document.getElementById('btnActionFavorite');
  if (btnFavBulk) {
    btnFavBulk.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      const selectedMedia = mediaItems.filter(m => ids.includes(m.id));
      const favCount = selectedMedia.filter(m => m.favorite === 1).length;
      const isFav = favCount <= ids.length / 2;
      
      if (window.bds && window.bds.toggleFavoriteBulk) {
        await window.bds.toggleFavoriteBulk(ids, isFav);
        fetchMedia();
        loadFilterOptions();
        window.bdsToast?.(`${ids.length} ${ids.length === 1 ? 'item' : 'itens'} ${isFav ? 'adicionado(s) aos favoritos' : 'removido(s) dos favoritos'}.`, {
          type: 'success',
          actionLabel: 'Desfazer',
          onAction: async () => {
            // Restaura o estado exato de antes (parte dos itens já podia ser favorita)
            const eram = selectedMedia.filter((m) => m.favorite === 1).map((m) => m.id);
            const nao = ids.filter((id) => !eram.includes(id));
            if (eram.length) await window.bds.toggleFavoriteBulk(eram, true);
            if (nao.length) await window.bds.toggleFavoriteBulk(nao, false);
            fetchMedia();
            loadFilterOptions();
          }
        });
      }
    });
  }

  const btnRenameBulk = document.getElementById('btnActionRename');
  if (btnRenameBulk) {
    btnRenameBulk.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      const baseName = await window.bdsModal.prompt(`Renomear ${ids.length} arquivo(s) em lote.\nInforme o novo nome base:`);
      if (baseName && baseName.trim() && window.bds && window.bds.renameMediaBulk) {
        const res = await window.bds.renameMediaBulk(ids, baseName.trim());
        reportBatchResult(res, res && res.renamed);
        updateSelectionVisuals();
        fetchMedia();
      }
    });
  }

  const btnTagsBulk = document.getElementById('btnActionTags');
  if (btnTagsBulk) {
    btnTagsBulk.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      const tagName = await window.bdsModal.prompt(`Adicionar Tag a ${ids.length} arquivo(s):\nInforme o nome da tag:`);
      if (tagName && tagName.trim() && window.bds && window.bds.addMediaTagBulk) {
        await window.bds.addMediaTagBulk(ids, tagName.trim());
        fetchMedia();
        loadFilterOptions();
      }
    });
  }

  const btnMoveBulk = document.getElementById('btnActionMove');
  if (btnMoveBulk) {
    btnMoveBulk.addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      const folder = await window.bds.selectFolder();
      if (folder && window.bds && window.bds.moveMediaBulk) {
        const conf = await window.bdsModal.confirm(`Mover ${ids.length} arquivo(s) para a pasta:\n${folder}?`);
        if (conf) {
          const res = await window.bds.moveMediaBulk(ids, folder);
          selectedIds.clear();
          reportBatchResult(res, res && res.moved);
          updateSelectionVisuals();
          fetchMedia();
        }
      }
    });
  }

  const btnProjectBulk = document.getElementById('btnActionProject');
  if (btnProjectBulk) {
    btnProjectBulk.addEventListener('click', () => {
      if (selectedIds.size === 0) return;
      openAddToProjectModal(Array.from(selectedIds));
    });
  }
}

// --- MODAL DE ADICIONAR MÍDIAS AO PROJETO ---
let pendingAddToProjectMediaIds = [];

function setupAddToProjectModal() {
  const modal = document.getElementById('modalAddToProject');
  const btnClose = document.getElementById('btnCloseAddToProjectModal');
  const btnCancel = document.getElementById('btnCancelAddToProject');
  const btnConfirm = document.getElementById('btnConfirmAddToProject');
  const selectProj = document.getElementById('selectTargetProject');
  const selectBin = document.getElementById('selectTargetBin');
  const btnNewBin = document.getElementById('btnCreateBinInModal');

  const closeModal = () => {
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('active');
      pendingAddToProjectMediaIds = [];
    }
  };

  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

  if (selectProj) {
    selectProj.addEventListener('change', async () => {
      const projId = selectProj.value ? parseInt(selectProj.value, 10) : null;
      await loadBinsForProject(projId);
    });
  }

  if (btnNewBin) {
    btnNewBin.addEventListener('click', async () => {
      const projId = selectProj.value ? parseInt(selectProj.value, 10) : null;
      if (!projId) {
        window.bdsModal.alert('Selecione primeiro um projeto de destino.');
        return;
      }
      const binName = await window.bdsModal.prompt('Nome da nova pasta (Bin):');
      if (binName && binName.trim()) {
        try {
          const newBinId = await window.bds.createProjectBin(projId, null, binName.trim());
          await loadBinsForProject(projId);
          if (selectBin) selectBin.value = newBinId;
        } catch (e) {
          console.error(e);
          window.bdsModal.alert('Erro ao criar pasta no projeto.');
        }
      }
    });
  }

  if (btnConfirm) {
    btnConfirm.addEventListener('click', async () => {
      const projId = selectProj.value ? parseInt(selectProj.value, 10) : null;
      if (!projId) {
        window.bdsModal.alert('Selecione um projeto de destino.');
        return;
      }
      const binId = selectBin.value ? parseInt(selectBin.value, 10) : null;
      
      try {
        const addedCount = await window.bds.addProjectMediaBulk(projId, binId, pendingAddToProjectMediaIds);
        closeModal();
        selectedIds.clear();
        updateSelectionVisuals();
        fetchMedia();
        loadFilterOptions();
        window.bdsModal.alert(`${addedCount} mídia(s) adicionada(s) ao projeto com sucesso!`);
      } catch (e) {
        console.error('Erro ao adicionar mídias ao projeto:', e);
        window.bdsModal.alert('Erro ao vincular mídias ao projeto.');
      }
    });
  }
}

async function loadBinsForProject(projectId) {
  const selectBin = document.getElementById('selectTargetBin');
  if (!selectBin) return;
  selectBin.innerHTML = '<option value="">Raiz do Projeto (Sem pasta)</option>';
  if (!projectId) return;

  try {
    const bins = await window.bds.getProjectBins(projectId);
    (bins || []).forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = `📁 ${b.name}`;
      selectBin.appendChild(opt);
    });
  } catch (e) {
    console.error('Erro ao listar bins do projeto:', e);
  }
}

async function openAddToProjectModal(mediaIds = []) {
  if (!mediaIds || mediaIds.length === 0) return;
  pendingAddToProjectMediaIds = mediaIds;

  const modal = document.getElementById('modalAddToProject');
  const summary = document.getElementById('addToProjectSummary');
  const selectProj = document.getElementById('selectTargetProject');
  const selectBin = document.getElementById('selectTargetBin');

  if (!modal || !selectProj) return;

  if (summary) {
    summary.textContent = `Adicionar ${mediaIds.length} mídia(s) selecionada(s) como referências no projeto escolhido.`;
  }

  selectProj.innerHTML = '<option value="">Selecione um projeto...</option>';
  if (selectBin) selectBin.innerHTML = '<option value="">Raiz do Projeto (Sem pasta)</option>';

  try {
    const projects = await window.bds.listProjects();
    if (!projects || projects.length === 0) {
      selectProj.innerHTML = '<option value="">Nenhum projeto encontrado</option>';
      window.bdsModal.alert('Nenhum projeto encontrado. Crie um projeto primeiro na tela de Projetos.');
      return;
    }

    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.status || 'Ativo'})`;
      selectProj.appendChild(opt);
    });

    if (projects.length === 1) {
      selectProj.value = projects[0].id;
      await loadBinsForProject(projects[0].id);
    }

    modal.classList.remove('hidden');
    modal.classList.add('active');
  } catch (e) {
    console.error('Erro ao carregar projetos:', e);
    window.bdsModal.alert('Erro ao carregar lista de projetos.');
  }
}

function closeInspector() {
  const inspector = document.getElementById('libraryInspector');
  if (inspector) {
    inspector.classList.add('hidden');
    inspector.classList.remove('active');
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024, dm = 2, sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
  if (!seconds) return '00:00';
  const d = new Date(seconds * 1000);
  return d.toISOString().substring(11, 19).replace(/^00:/, '');
}

async function loadFilterOptions() {
  if (!window.bds || !window.bds.getLibraryFilterOptions) return;
  const options = await window.bds.getLibraryFilterOptions();
  
  // Se o banco foi limpo (total de tipos = 0), resetamos os filtros selecionados
  const totalItemsInDb = (options.types.video || 0) + (options.types.audio || 0) + (options.types.photo || 0);
  if (totalItemsInDb === 0) {
    resetFilters();
  }
  
  const createGroup = (title, items, name, valueKey, labelKey, countKey, formatter = v=>v) => {
    if (!items || items.length === 0) return '';
    let html = `
      <div class="filter-group-header">
        <h3 class="filter-group-title">${escapeHtml(title)}</h3>
      </div>
    `;
    items.forEach(item => {
      const isChecked = currentFilters[name + 's']?.includes(item[valueKey]) || currentFilters[name]?.includes(item[valueKey]);
      html += `
        <label class="lib-filter-row">
          <div class="lib-filter-row-inner">
            <input type="checkbox" name="${name}" value="${escapeAttr(item[valueKey])}" class="lib-filter-chk" ${isChecked ? 'checked' : ''}>
            <span class="lib-filter-custom-chk material-symbols-rounded">${isChecked ? 'check_box' : 'check_box_outline_blank'}</span>
            <span>${escapeHtml(formatter(item[labelKey]))}</span>
          </div>
          <span class="lib-filter-count">${escapeHtml(item[countKey])}</span>
        </label>
      `;
    });
    return html;
  };

  const bindEvents = (containerId) => {
    const container = document.getElementById(containerId);
    if (container) {
      container.querySelectorAll('.lib-filter-chk').forEach(chk => {
        chk.addEventListener('change', (e) => {
          const icon = e.target.nextElementSibling;
          if (e.target.checked) {
            icon.textContent = 'check_box';
          } else {
            icon.textContent = 'check_box_outline_blank';
          }
          updateFilters();
          fetchMedia();
        });
      });
    }
  };

  // Origins
  const originsHtml = createGroup('Origem', options.origins, 'origin', 'origin', 'origin', 'count', o => originLabel(o));
  const originsContainer = document.getElementById('filterOriginsContainer');
  if (originsContainer) {
    originsContainer.innerHTML = originsHtml;
    bindEvents('filterOriginsContainer');
  }

  // Albums
  const albumsHtml = createGroup('Álbuns / Pastas', options.albums, 'album', 'name', 'name', 'count');
  const albumsContainer = document.getElementById('filterAlbumsContainer');
  if (albumsContainer) {
    albumsContainer.innerHTML = albumsHtml;
    bindEvents('filterAlbumsContainer');
  }

  // Types
  const typeArr = [
    { typeVal: 'video', label: 'Vídeos', count: options.types.video },
    { typeVal: 'audio', label: 'Áudios', count: options.types.audio },
    { typeVal: 'photo', label: 'Fotos', count: options.types.photo }
  ].filter(t => t.count > 0);
  const typesHtml = createGroup('Tipos', typeArr, 'type', 'typeVal', 'typeVal', 'count', val => val === 'video' ? 'Vídeos' : (val === 'audio' ? 'Áudios' : 'Fotos'));
  const typesContainer = document.getElementById('filterTypesContainer');
  if (typesContainer) {
    typesContainer.innerHTML = typesHtml;
    bindEvents('filterTypesContainer');
  }

  // Resolutions
  const resHtml = createGroup('Resolução Vertical', options.resolutions, 'res', 'height', 'height', 'count', r => r + 'p');
  const resContainer = document.getElementById('filterResContainer');
  if (resContainer) {
    resContainer.innerHTML = resHtml;
    bindEvents('filterResContainer');
  }

  // FPS
  const fpsHtml = createGroup('FPS', options.fps, 'fps', 'fps', 'fps', 'count', f => f + ' fps');
  const fpsContainer = document.getElementById('filterFpsContainer');
  if (fpsContainer) {
    fpsContainer.innerHTML = fpsHtml;
    bindEvents('filterFpsContainer');
  }
  
  // Data
  const dateHtml = createGroup('Data de Gravação', options.dates, 'date', 'dt', 'dt', 'count', d => {
    const parts = d.split('-');
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  });
  const dateContainer = document.getElementById('filterDateContainer');
  if (dateContainer) {
    dateContainer.innerHTML = dateHtml;
    bindEvents('filterDateContainer');
  }

  // Projetos
  const projHtml = createGroup('Projetos', options.projects, 'project', 'id', 'name', 'count');
  const projContainer = document.getElementById('filterProjectsContainer');
  if (projContainer) {
    projContainer.innerHTML = projHtml;
    bindEvents('filterProjectsContainer');
  }

  // Tags
  const tagsHtml = createGroup('Tags', options.tags, 'tag', 'id', 'name', 'count');
  const tagsContainer = document.getElementById('filterTagsContainer');
  if (tagsContainer) {
    tagsContainer.innerHTML = tagsHtml;
    bindEvents('filterTagsContainer');
  }

  // Favorites
  const favContainer = document.getElementById('filterFavoritesContainer');
  if (favContainer) {
    if (options.favoritesCount > 0) {
      const isFav = currentFilters.favorites;
      favContainer.innerHTML = `
        <div class="filter-group-header">
          <h3 class="filter-group-title">Favoritos</h3>
        </div>
        <label class="lib-filter-row">
          <div class="lib-filter-row-inner">
            <input type="checkbox" name="favorite" value="1" class="lib-filter-chk" ${isFav ? 'checked' : ''}>
            <span class="lib-filter-custom-chk material-symbols-rounded" style="color: var(--accent);">${isFav ? 'check_box' : 'check_box_outline_blank'}</span>
            <span>Apenas Favoritos</span>
          </div>
          <span class="lib-filter-count">${options.favoritesCount}</span>
        </label>
      `;
      bindEvents('filterFavoritesContainer');
    } else {
      favContainer.innerHTML = '';
    }
  }
}