import { enhanceModalOverlay } from '../utils/modal.js';
import { friendlyError } from '../utils/friendlyError.js';
import { createImportFlow } from './luts/importFlow.js';
import { folderLabel, groupLuts, hasSubfolders, loadCollapsed, saveCollapsed, remapCollapsed, countLuts } from './luts/groups.js';
import { createSelection, summarize } from './luts/selection.js';
import { createProjectPicker } from './luts/projectPicker.js';
import { foldText, matchesQuery, sortLuts } from './luts/sorting.js';
import { applyLutToPixels, createByteLru, lutBytes, PARSED_CACHE_MAX_BYTES } from '../utils/lutCore.js';
// Importação com tratamento de erro (embora geralmente deva funcionar se o caminho estiver certo)
let escapeHtmlFunc;
let appState = null; // estado global do app (state.settings.lutPreviewImage)
try {
    // Certifique-se de que o caminho relativo está correto para a estrutura real
    // renderer/screens/luts.js -> renderer/app.js = ../app.js
    const { escapeHtml: importedEscapeHtml, state: importedState } = await import('../app.js');
    escapeHtmlFunc = importedEscapeHtml;
    appState = importedState;
    console.debug("[LUTS] Função escapeHtml importada com sucesso.");
} catch (e) {
    console.error("[LUTS] Erro ao importar escapeHtml de '../app.js':", e);
    // Fallback simples se o import falhar
    escapeHtmlFunc = (str) => {
        if (str == null) return '';
        return String(str).replace(/[&<>'"]/g,
            match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match])
        );
    };
}

// Função auxiliar para verificar dependências
function checkDependencies() {
    const missing = [];
    if (typeof window.bds === 'undefined') missing.push('window.bds');
    if (typeof window.bdsModal === 'undefined') missing.push('window.bdsModal');
    if (missing.length > 0) {
        console.error(`[LUTS] Dependências ausentes: ${missing.join(', ')}. Verifique o preload script.`);
        // Alerta o usuário (sem termos técnicos; o detalhe fica só no log do console)
        const text = 'Não foi possível abrir a tela de LUTs. Recarregue a tela ou reinicie o aplicativo.';
        if (window.bdsModal) window.bdsModal.alert(text); else alert(text);
        return false; // Indica falha
    }
    return true; // Todas as deps ok
}

let luts = [];
let filteredLuts = [];
const selection = createSelection(); // LUTs marcadas (Ctrl/Shift+clique, círculo do cartão, Ctrl+A)
let selectedLut = null;              // a "LUT ativa" do inspetor: só existe com exatamente uma marcada (com várias, o inspetor resume)
let currentViewMode = 'grid'; // 'grid', 'list', 'compact'
const collapsedFolders = new Set(); // pastas (grupos) que a pessoa recolheu; lembradas no navegador (carregadas em initScreen)
let importFlow = null;
let importMenu = null; // menu "Arquivos .cube… / Pasta…" do botão Importar
let groupMenu = null;  // menu das pastas (grupos) da grade
let projectPicker = null; // janela "Adicionar a um projeto…"
let onModulesChanged = null;
let usageToken = 0;    // a consulta "usada em N projetos" do inspetor: só vale a mais nova

// Referências DOM (inicializadas como null)
let domRefs = {};
let sliderInstances = {};

// Cache de imagem e dados de LUT para renderização Canvas
let cachedBaseImg = null;
let cachedBaseImgSrc = null;

// Cache dos dados parseados de cada .cube (evita reparsear o mesmo arquivo várias vezes). Limitado por BYTES (a tabela
// de uma LUT 65³ pesa ~3,3 MB e a de uma 17³, ~60 KB: contar itens não diz nada sobre a memória).
const parsedLutCache = createByteLru(PARSED_CACHE_MAX_BYTES); // path -> Promise<{ ok, data, size, ... }>
// Cache das miniaturas reais (data URL, ~320 px) já renderizadas, também limitado por bytes. A chave é o conteúdo da LUT
// (hash) quando ele já é conhecido: cópias idênticas e renomeadas dividem a mesma miniatura.
const THUMB_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const THUMB_MAX_DIM = 320;
const PREVIEW_MAX_DIM = 640;
const thumbnailCache = createByteLru(THUMB_CACHE_MAX_BYTES); // thumbKey(lut) -> dataURL

/** Chave da miniatura: o conteúdo (hash) se já é conhecido; senão o caminho com tamanho e data (muda se o arquivo mudar). */
function thumbKey(lut) {
    return lut.hash ? `h:${lut.hash}` : `p:${lut.path}|${lutSignature(lut)}`;
}

const failedParses = new Set(); // caminhos cuja leitura falhou (cartão e prévia mostram "inválida")

/**
 * Interpreta o .cube (pelo IPC), com cache. Sempre resolve: { ok: true, data, size, ... } ou { ok: false, reason }.
 * A falha também fica em cache (não refaz a chamada em laço a cada seleção ou miniatura): o cache do arquivo é
 * descartado quando ele muda (dropLutCaches) ou quando o usuário atualiza a lista (forgetParseFailures).
 */
function getParsedLut(path) {
    if (parsedLutCache.has(path)) return parsedLutCache.get(path);
    const call = window.bds?.parseLutCube ? window.bds.parseLutCube(path) : Promise.resolve(null);
    const promise = Promise.resolve(call)
        .then((result) => {
            if (result && result.ok === true && result.data && result.size) {
                parsedLutCache.setBytes(path, lutBytes(result)); // só agora se sabe quanto a tabela ocupa
                return result;
            }
            failedParses.add(path);
            return { ok: false, reason: (result && result.reason) || 'Não foi possível ler esta LUT.' };
        })
        .catch((err) => {
            console.warn('[LUTS] Falha ao ler a LUT para a prévia:', path, err);
            failedParses.add(path);
            return { ok: false, reason: errMsg(err) };
        });
    parsedLutCache.set(path, promise, 0);
    return promise;
}

/** Esquece as leituras que falharam, para a próxima tentativa (ao atualizar a lista). */
function forgetParseFailures() {
    for (const path of failedParses) parsedLutCache.delete(path);
    failedParses.clear();
}

const DEFAULT_BASE_IMAGE = './assets/lut_preview.jpg';
let baseImageSrc = DEFAULT_BASE_IMAGE; // imagem de referência atual (padrão ou a escolhida nas Configurações)
let baseImageSetting = '';             // valor da configuração que gerou baseImageSrc

function getBasePreviewImageUrl() {
    return baseImageSrc;
}

/**
 * Resolve a imagem de referência das Configurações (data URL, para o canvas poder ler os pixels).
 * Retorna true se a imagem mudou desde a última chamada.
 */
async function syncBaseImage() {
    const wanted = String(appState?.settings?.lutPreviewImage || '').trim();
    if (wanted === baseImageSetting) return false;
    baseImageSetting = wanted;
    let next = DEFAULT_BASE_IMAGE;
    if (wanted && window.bds?.getLutReferenceImage) {
        try { next = (await window.bds.getLutReferenceImage(wanted)) || DEFAULT_BASE_IMAGE; } catch (_) { /* usa a padrão */ }
    }
    if (next === baseImageSrc) return false;
    baseImageSrc = next;
    cachedBaseImg = null;
    cachedBaseImgSrc = null;
    thumbnailCache.clear();
    return true;
}

/** Depois de trocar a imagem de referência: volta os cartões ao estado "sem miniatura" e refaz sob demanda. */
function refreshAllThumbnails() {
    cardCache.forEach((card) => {
        const img = card.querySelector('.lut-card-img');
        if (!img) return;
        img.src = baseImageSrc;
        img.classList.add('lut-card-img-loading');
    });
    thumbQueue.length = 0;
    observePendingThumbs();
    if (selectedLut) updateInspector();
}

function loadBaseImage(src) {
    if (cachedBaseImg && cachedBaseImgSrc === src && cachedBaseImg.complete) {
        return Promise.resolve(cachedBaseImg);
    }
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            cachedBaseImg = img;
            cachedBaseImgSrc = src;
            resolve(img);
        };
        img.onerror = (err) => {
            console.warn('[LUTS] Falha ao carregar imagem base:', src, err);
            // Tenta fallback para o default
            if (src !== './assets/lut_preview.jpg') {
                loadBaseImage('./assets/lut_preview.jpg').then(resolve).catch(reject);
            } else {
                reject(err);
            }
        };
        img.src = src;
    });
}

/**
 * Desenha a imagem de referência (reduzida ao maior lado `maxDim`) no canvas e aplica a LUT de verdade nos pixels:
 * 3D trilinear ou 1D por canal, com o domínio de entrada da LUT (DOMAIN_MIN/DOMAIN_MAX, LUT_*_INPUT_RANGE). A conta
 * fica em renderer/utils/lutCore.js (a mesma das miniaturas dos projetos).
 * @param {{ data: Float32Array, size: number, is1D?: boolean, domainMin?: number[]|null, domainMax?: number[]|null, inputRange?: number[]|null }} lut - resultado de `parseLutCube`
 * @param {HTMLImageElement} sourceImg - Imagem fonte
 * @param {HTMLCanvasElement} targetCanvas - Canvas destino
 * @param {number} [maxDim] - maior lado, em pixels
 */
function applyLutToCanvas(lut, sourceImg, targetCanvas, maxDim = PREVIEW_MAX_DIM) {
    if (!targetCanvas || !sourceImg || !lut || !lut.data || !lut.size) return;

    let width = sourceImg.naturalWidth || sourceImg.width || 640;
    let height = sourceImg.naturalHeight || sourceImg.height || 360;

    if (width > maxDim || height > maxDim) {
        if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
        } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
        }
    }

    targetCanvas.width = width;
    targetCanvas.height = height;

    const ctx = targetCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(sourceImg, 0, 0, width, height);
    const imgData = ctx.getImageData(0, 0, width, height);
    applyLutToPixels(imgData.data, lut);
    ctx.putImageData(imgData, 0, 0);
}

export async function initScreen() {
    console.log('[LUTS] Inicializando tela...');

    // 1. Verifica dependências antes de continuar
    if (!checkDependencies()) {
        console.error('[LUTS] Falha na verificação de dependências. Encerrando initScreen.');
        return; // Sai da função, impedindo a inicialização
    }

    // 2. Captura referências DOM com tratamento de erro
    try {
        domRefs = {
            lutsGrid: document.getElementById('lutsGrid'),
            emptyState: document.getElementById('lutsEmptyState'),
            ftTotal: document.getElementById('ftTotal'),
            ftSelected: document.getElementById('ftSelected'),
            inspector: document.getElementById('inspectorContent'),

            searchInput: document.getElementById('lutSearchInput'),
            typeFilter: document.getElementById('lutTypeFilter'),
            sortFilter: document.getElementById('lutSortFilter'),

            // Botões de ação
            btnImport: document.getElementById('btnImportLut'),
            btnRefresh: document.getElementById('btnRefreshLuts'),
            btnCloseInspector: document.getElementById('btnCloseInspector'),
            btnReveal: document.getElementById('btnRevealLut'),
            btnOpenFolder: document.getElementById('btnOpenLutsFolder'),
            btnEmptyImport: document.getElementById('btnEmptyImport'),
            gridArea: document.getElementById('lutsGridArea'),
            dropZone: document.getElementById('lutsDropZone'),
            notice: document.getElementById('lutsNotice'),
            noticeText: document.getElementById('lutsNoticeText'),
            noticeIcon: document.getElementById('lutsNoticeIcon'),
            btnNoticeClose: document.getElementById('btnLutsNoticeClose'),
            cardMenu: document.getElementById('lutCardMenu'),
            emptyText: document.getElementById('lutsEmptyText'),
            emptyHint: document.getElementById('lutsEmptyHint'),
            btnFullscreen: document.getElementById('btnFullscreenLut'),
            btnRename: document.getElementById('btnRenameLut'),
            btnDelete: document.getElementById('btnDeleteLut'),
            insInvalid: document.getElementById('insInvalid'),
            insInvalidText: document.getElementById('insInvalidText'),
            insFolderRow: document.getElementById('insFolderRow'),
            insFolder: document.getElementById('insFolder'),

            // Seleção múltipla: barra de ações em lote e resumo no inspetor
            selectionBar: document.getElementById('lutSelectionBar'),
            selectionCount: document.getElementById('lutSelCount'),
            btnSelDelete: document.getElementById('btnSelDelete'),
            btnSelClear: document.getElementById('btnSelClear'),
            btnSelAddProject: document.getElementById('btnSelAddProject'),
            insProjectsRow: document.getElementById('insProjectsRow'),
            insProjects: document.getElementById('insProjects'),
            btnInsAddProject: document.getElementById('btnInsAddProject'),
            projectPickerModal: document.getElementById('lutProjectPicker'),
            inspectorPanel: document.getElementById('lutsInspector'),
            insMulti: document.getElementById('insMulti'),
            insMultiTitle: document.getElementById('insMultiTitle'),
            insMultiSize: document.getElementById('insMultiSize'),
            insMultiList: document.getElementById('insMultiList'),

            // Importar (menu e janela) e menu das pastas
            importMenu: document.getElementById('lutImportMenu'),
            groupMenu: document.getElementById('lutGroupMenu'),
            importModal: document.getElementById('lutImportModal'),

            // Sliders
            sliderContainer: document.getElementById('lutSliderContainer'),
            sliderOverlay: document.getElementById('lutSliderOverlay'),
            sliderDivider: document.getElementById('lutSliderDivider'),
            sliderBaseImg: document.getElementById('lutSliderBaseImg'),
            sliderTargetImg: document.getElementById('lutSliderTargetImg'),
            sliderCanvas: document.getElementById('lutSliderCanvas'),

            fsModal: document.getElementById('lutFullscreenModal'),
            fsSliderContainer: document.getElementById('fsSliderContainer'),
            fsSliderOverlay: document.getElementById('fsSliderOverlay'),
            fsSliderDivider: document.getElementById('fsSliderDivider'),
            fsSliderBaseImg: document.getElementById('fsSliderBaseImg'),
            fsSliderTargetImg: document.getElementById('fsSliderTargetImg'),
            fsSliderCanvas: document.getElementById('fsSliderCanvas'),
            fsLutName: document.getElementById('fsLutName'),
            btnFsClose: document.getElementById('btnFsClose'),

            // Seção "Arquivo .cube"
            cubeSection: document.getElementById('insCubeSection'),
            insTitle: document.getElementById('insTitle'),
            insLutSize: document.getElementById('insLutSize'),
            insLutEntries: document.getElementById('insLutEntries'),
            insLutDomain: document.getElementById('insLutDomain'),
            cubeRgbTable: document.getElementById('insCubeRgbTable'),
            btnViewCubeRaw: document.getElementById('btnViewCubeRaw'),

            // Modal de conteúdo raw do .cube
            cubeRawModal: document.getElementById('lutCubeRawModal'),
            cubeRawModalTitle: document.getElementById('cubeRawModalTitle'),
            cubeRawContent: document.getElementById('cubeRawContent'),
            btnCloseCubeRaw: document.getElementById('btnCloseCubeRaw'),
        };

        // Verifica se os elementos críticos existem
        const criticalElements = ['lutsGrid', 'ftTotal', 'ftSelected', 'inspector'];
        for (const elementName of criticalElements) {
            if (!domRefs[elementName]) {
                throw new Error(`Elemento crítico ausente: #${domRefs[elementName]?.id || elementName}`);
            }
        }
    } catch (e) {
        console.error('[LUTS] Erro ao capturar referências DOM:', e);
        if (window.bdsModal) {
            window.bdsModal.alert('Não foi possível montar a tela de LUTs. Recarregue a tela ou reinicie o aplicativo.');
        }
        return; // Sai da função
    }

    // 3. Adiciona Eventos com tratamento de erro
    try {
        domRefs.btnOpenFolder?.addEventListener('click', () => openLutsFolder());
        domRefs.btnNoticeClose?.addEventListener('click', hideNotice);
        const byId = (id) => document.getElementById(id);
        importFlow = createImportFlow({
            els: {
                modal: domRefs.importModal,
                scanSection: byId('importScanning'),
                summarySection: byId('importSummary'),
                progressSection: byId('importProgress'),
                scanText: byId('importScanText'),
                scanBar: byId('importScanBar'),
                scanCancel: byId('btnImportScanCancel'),
                summaryText: byId('importSummaryText'),
                notes: byId('importNotes'),
                filters: byId('importFilters'),
                groups: byId('importGroups'),
                options: byId('importOptions'),
                keepFolders: byId('importKeepFolders'),
                wrap: byId('importWrap'),
                wrapName: byId('importWrapName'),
                error: byId('importError'),
                closeBtn: byId('btnImportClose'),
                cancelBtn: byId('btnImportCancel'),
                confirmBtn: byId('btnImportConfirm'),
                progressText: byId('importProgressText'),
                progressBar: byId('importProgressBar'),
                stopBtn: byId('btnImportStop')
            },
            getBds: () => window.bds,
            showNotice,
            errMsg,
            onImported: afterImport,
            // aria-disabled (e não disabled) para o foco não se perder do botão enquanto importa
            onBusy: (busy) => { for (const b of [domRefs.btnImport, domRefs.btnEmptyImport]) b?.setAttribute('aria-disabled', busy ? 'true' : 'false'); }
        });
        importFlow.bind();
        projectPicker = createProjectPicker({
            els: {
                modal: domRefs.projectPickerModal,
                what: byId('projectPickerWhat'),
                search: byId('projectPickerSearch'),
                list: byId('projectPickerList'),
                archivedRow: byId('projectPickerArchivedRow'),
                archived: byId('projectPickerArchived'),
                status: byId('projectPickerStatus'),
                error: byId('projectPickerError'),
                cancelBtn: byId('btnProjectPickerCancel'),
                closeBtn: byId('btnProjectPickerClose'),
                confirmBtn: byId('btnProjectPickerConfirm')
            },
            getBds: () => window.bds,
            showNotice,
            errMsg,
            onAdded: () => updateUsageRow(selectedLut) // "Usada em N projetos" do painel acompanha
        });
        projectPicker.bind();
        // O módulo Projetos desligado esconde "Adicionar a um projeto…" (menus, barra e link do painel)
        onModulesChanged = () => { applyProjectActions(); updateUsageRow(selectedLut); };
        window.addEventListener('bds:modules-changed', onModulesChanged);
        bindPopupMenus();
        domRefs.btnImport?.addEventListener('click', () => toggleImportMenu(domRefs.btnImport));
        domRefs.btnEmptyImport?.addEventListener('click', () => toggleImportMenu(domRefs.btnEmptyImport));
        bindDragAndDrop();
        bindCardMenu();
        // Foco preso, Esc e retorno do foco nos modais (abertos/fechados pela classe 'hidden')
        for (const m of [domRefs.fsModal, domRefs.cubeRawModal, domRefs.importModal, domRefs.projectPickerModal]) enhanceModalOverlay(m, { isOpen: (el) => !el.classList.contains('hidden') });
        domRefs.btnRefresh?.addEventListener('click', () => {
          // Opcional: Dar feedback visual ao usuário (icone girando, por exemplo)
          const btn = domRefs.btnRefresh;
          btn.classList.add('loading'); // Adiciona classe para animação
          loadLuts().finally(() => {
              btn.classList.remove('loading'); // Remove quando terminar
          });
        });
        domRefs.btnCloseInspector?.addEventListener('click', closeInspector);

        domRefs.searchInput?.addEventListener('input', () => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(applyFilters, 180);
        });
        domRefs.typeFilter?.addEventListener('change', applyFilters);
        domRefs.sortFilter?.addEventListener('change', applyFilters);

        // Modos de Visualização
        document.getElementById('btnGridView')?.addEventListener('click', () => setViewMode('grid'));
        document.getElementById('btnListView')?.addEventListener('click', () => setViewMode('list'));
        document.getElementById('btnCompactView')?.addEventListener('click', () => setViewMode('compact'));

        // Inspector Actions
        domRefs.btnReveal?.addEventListener('click', () => revealLut(selectedLut));
        domRefs.btnDelete?.addEventListener('click', () => deleteLuts(selectedLut ? [selectedLut] : []));
        domRefs.btnRename?.addEventListener('click', () => renameLut(selectedLut));

        // Barra de ações em lote (2 ou mais LUTs selecionadas)
        domRefs.btnSelDelete?.addEventListener('click', () => deleteLuts(selectedLuts()));
        domRefs.btnSelClear?.addEventListener('click', () => clearSelection());
        domRefs.btnSelAddProject?.addEventListener('click', () => openProjectPicker(selectedLuts(), { returnTo: domRefs.btnSelAddProject }));
        domRefs.btnInsAddProject?.addEventListener('click', () => openProjectPicker(selectedLut ? [selectedLut] : [], { returnTo: domRefs.btnInsAddProject }));
        domRefs.btnFullscreen?.addEventListener('click', openFullscreen);

        domRefs.btnFsClose?.addEventListener('click', closeFullscreen);

        // Arquivo .cube - modal de conteúdo bruto
        domRefs.btnViewCubeRaw?.addEventListener('click', openCubeRawModal);
        domRefs.btnCloseCubeRaw?.addEventListener('click', closeCubeRawModal);
        domRefs.cubeRawModal?.addEventListener('click', (e) => {
            if (e.target === domRefs.cubeRawModal) closeCubeRawModal();
        });

    } catch (e) {
        console.error('[LUTS] Erro ao adicionar eventos:', e);
        if (window.bdsModal) {
            window.bdsModal.alert('Não foi possível preparar os controles da tela de LUTs. Recarregue a tela ou reinicie o aplicativo.');
        }
        return; // Sai da função
    }

    // 4. Setup Sliders com tratamento de erro
    bindSliders();
    for (const folder of loadCollapsed()) collapsedFolders.add(folder);
    applyProjectActions();

    // 5. Imagem de referência das Configurações e carga inicial das LUTs
    await syncBaseImage();
    await loadLuts(); // Chamada inicial

    // 6. A liberação de memória (modal .cube bruto) e dos listeners de window dos sliders
    // acontece em onLeave(), chamado pelo app.js ao trocar de tela.
}

function bindSliders() {
    try {
        destroySliders();
        if (domRefs.sliderContainer && domRefs.sliderOverlay && domRefs.sliderDivider) {
            sliderInstances.main = setupSlider(domRefs.sliderContainer, domRefs.sliderOverlay, domRefs.sliderDivider);
        }
        if (domRefs.fsSliderContainer && domRefs.fsSliderOverlay && domRefs.fsSliderDivider) {
            sliderInstances.fullscreen = setupSlider(domRefs.fsSliderContainer, domRefs.fsSliderOverlay, domRefs.fsSliderDivider);
        }
    } catch (e) {
        console.error('[LUTS] Erro ao configurar sliders:', e);
    }
}

function destroySliders() {
    if (sliderInstances.main?.destroy) sliderInstances.main.destroy();
    if (sliderInstances.fullscreen?.destroy) sliderInstances.fullscreen.destroy();
    sliderInstances = {};
}

/** Ao sair da tela: remove listeners de window dos sliders e libera o conteúdo pesado do modal .cube. */
export function onLeave() {
    destroySliders();
    // Interrompe a geração de miniaturas pendente (retomada em onEnter para os cards ainda sem miniatura)
    thumbQueue.length = 0;
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    clearTimeout(searchDebounce);
    hideCardMenu({ restoreFocus: false });
    importMenu?.hide({ restoreFocus: false });
    groupMenu?.hide({ restoreFocus: false });
    projectPicker?.close({ restore: false });
    if (onModulesChanged) { window.removeEventListener('bds:modules-changed', onModulesChanged); onModulesChanged = null; }
    usageToken++;
    dragDepth = 0;
    domRefs.dropZone?.classList.add('hidden');
    closeFullscreen();
    try { closeCubeRawModal(); } catch (_) { /* noop */ }
}

export function onEnter() {
    bindSliders();
    // A imagem de referência pode ter mudado nas Configurações; a pasta pode ter mudado (ex.: sincronização).
    syncBaseImage().then((changed) => {
        if (changed) refreshAllThumbnails(); else observePendingThumbs();
    });
    if (loadedOnce) loadLuts({ silent: true });
    else if (!loadsInFlight) loadLuts(); // a primeira carga falhou: tenta de novo ao voltar para a tela
}

/** true se algo está aberto por cima da tela (tela cheia, .cube completo, menu do cartão ou um diálogo). */
function isAnyLutModalOpen() {
    const open = (el) => !!el && !el.classList.contains('hidden');
    return open(domRefs.fsModal) || open(domRefs.cubeRawModal) || open(domRefs.cardMenu) || open(domRefs.importModal) || open(domRefs.projectPickerModal)
        || open(domRefs.importMenu) || open(domRefs.groupMenu)
        || !!document.querySelector('dialog[open]')
        || !!(window.bdsModal && typeof window.bdsModal.isOpen === 'function' && window.bdsModal.isOpen());
}

/** Atalhos da tela (o app.js roteia o teclado para a tela ativa). */
export function onKeyDown(e) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '') || e.target?.isContentEditable;
    if (e.key === 'Escape') {
        if (!domRefs.cardMenu?.classList.contains('hidden')) { e.preventDefault(); hideCardMenu(); return; }
        if (importMenu?.isOpen()) { e.preventDefault(); importMenu.hide(); return; }
        if (groupMenu?.isOpen()) { e.preventDefault(); groupMenu.hide(); return; }
        if (projectPicker?.isOpen()) { e.preventDefault(); projectPicker.close(); return; }
        if (domRefs.fsModal && !domRefs.fsModal.classList.contains('hidden')) { e.preventDefault(); closeFullscreen(); return; }
        if (domRefs.cubeRawModal && !domRefs.cubeRawModal.classList.contains('hidden')) { e.preventDefault(); closeCubeRawModal(); return; }
        // Só por último o Esc limpa a seleção (e nunca enquanto algo está aberto por cima ou num campo de texto)
        if (typing || isAnyLutModalOpen() || !selection.size) return;
        e.preventDefault();
        clearSelection();
        return;
    }
    // Ctrl/Cmd+A seleciona o que está visível; fica antes da trava de Ctrl abaixo e cede ao campo de texto e aos diálogos
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 'a') {
        if (typing || isAnyLutModalOpen()) return;
        e.preventDefault();
        selectAllVisible();
        return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isAnyLutModalOpen()) return; // com algo aberto por cima, Delete e F2 não agem sobre a LUT que está atrás
    if (!selection.size) return;
    if (e.key === 'Delete') { e.preventDefault(); deleteLuts(selectedLuts()); }
    else if (e.key === 'F2' && selectedLut) { e.preventDefault(); renameLut(selectedLut); } // renomear é de uma LUT por vez
}

function setViewMode(mode) {
    // Validação básica do modo
    if (!['grid', 'list', 'compact'].includes(mode)) {
        console.warn('[LUTS] Modo de visualização desconhecido:', mode);
        return;
    }

    currentViewMode = mode;

    // Atualiza a classe ativa no container do grid
    const gridArea = document.querySelector('.luts-grid-area'); // Ou guarde a referência em domRefs se preferir
    if (gridArea) {
        gridArea.className = 'luts-grid-area'; // Limpa classes anteriores
        if (mode !== 'grid') {
            gridArea.classList.add(`view-${mode}`);
        }
    }

    // Atualiza a classe 'active' nos botões
    document.querySelectorAll('.lut-view-mode-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeButtonMap = {
        'grid': 'btnGridView',
        'list': 'btnListView',
        'compact': 'btnCompactView'
    };
    const activeButtonId = activeButtonMap[mode];
    if (activeButtonId) {
        const activeButton = document.getElementById(activeButtonId);
        if (activeButton) activeButton.classList.add('active');
    }

    // Re-renderiza o grid para aplicar o layout correto
    renderGrid();
}

/**
 * Comparador antes/depois. O divisor é um controle de teclado (role="slider"): setas movem 1% (com Shift, 10%), Page Up
 * e Page Down 10%, Home e End vão às pontas. Clicar (ou tocar) em qualquer ponto da imagem posiciona o divisor ali e
 * arrastar o acompanha. `aria-valuenow` e `aria-valuetext` dizem quanto é "antes" e quanto é "depois".
 */
function setupSlider(container, overlay, divider) {
    if (!container || !overlay || !divider) {
        console.error('[LUTS] Elementos do slider ausentes para setupSlider.');
        return { destroy: () => {}, set: () => {}, get position() { return 50; } }; // objeto vazio, mas com a mesma forma
    }

    let isDragging = false;
    let position = 50;

    const setPosition = (value) => {
        const p = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 50));
        position = p;
        const shown = Math.round(p);
        if (overlay.style) overlay.style.clipPath = `inset(0 0 0 ${p}%)`;
        if (divider.style) divider.style.left = `${p}%`;
        divider.setAttribute('aria-valuenow', String(shown));
        divider.setAttribute('aria-valuetext', `Antes ${shown}%, depois ${100 - shown}%`);
    };

    const moveToClientX = (clientX) => {
        if (clientX === undefined) return; // toque sem coordenadas
        const rect = container.getBoundingClientRect();
        if (!rect.width) return; // container ainda não desenhado
        setPosition(((clientX - rect.left) / rect.width) * 100);
    };
    const clientXOf = (e) => (e.type.includes('mouse') ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : undefined));

    const onDrag = (e) => {
        if (!isDragging) return;
        e.preventDefault();
        moveToClientX(clientXOf(e));
    };

    const onPointerDown = (e) => {
        isDragging = true;
        moveToClientX(clientXOf(e)); // o clique já posiciona o divisor
    };
    const onPointerUp = () => { isDragging = false; };

    const onKeyDown = (e) => {
        if (e.target !== divider || e.ctrlKey || e.metaKey || e.altKey) return;
        const step = e.shiftKey ? 10 : 1;
        let next = null;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = position - step;
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = position + step;
        else if (e.key === 'PageDown') next = position - 10;
        else if (e.key === 'PageUp') next = position + 10;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = 100;
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation(); // as setas não podem mover a seleção da grade nem rolar a tela
        setPosition(next);
    };

    container.addEventListener('mousedown', onPointerDown);
    container.addEventListener('touchstart', onPointerDown, { passive: true });
    divider.addEventListener('keydown', onKeyDown);

    window.addEventListener('mouseup', onPointerUp);
    window.addEventListener('touchend', onPointerUp);

    window.addEventListener('mousemove', onDrag);
    window.addEventListener('touchmove', onDrag, { passive: false });

    setPosition(position);

    return {
        set: setPosition,
        get position() { return position; },
        destroy: () => {
            container.removeEventListener('mousedown', onPointerDown);
            container.removeEventListener('touchstart', onPointerDown);
            divider.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('mouseup', onPointerUp);
            window.removeEventListener('touchend', onPointerUp);
            window.removeEventListener('mousemove', onDrag);
            window.removeEventListener('touchmove', onDrag);
        }
    };
}

/** Volta o divisor ao meio (o comparador de uma LUT nova ou o da tela cheia que acabou de abrir). */
function resetSlider(which) {
    const instance = sliderInstances[which];
    if (instance) { instance.set(50); return; }
    const overlay = which === 'main' ? domRefs.sliderOverlay : domRefs.fsSliderOverlay;
    if (overlay && overlay.style) overlay.style.clipPath = 'inset(0 0 0 50%)';
}

let loadedOnce = false;
let loadSeq = 0;
let loadsInFlight = 0;        // cargas em andamento (uma nova só é pedida ao reentrar se não houver nenhuma)
let placeholderShown = false; // a grade mostra "Carregando..." ou o erro: uma carga silenciosa não pode deixá-lo para trás
let lastProblemsSig = '';     // arquivos que a pasta tem e a lista não pôde ler (aviso só quando muda)

/** Assinatura de uma LUT: muda se o arquivo for substituído/editado (invalida miniatura e interpretação). */
function lutSignature(l) { return `${l.size}:${l.modifiedAt}`; }

/**
 * Carrega a lista do disco. Com { silent: true } mantém os cartões na tela e só aplica as diferenças
 * (usado ao voltar para a tela e depois de importar/renomear/excluir).
 * Cargas que se atropelam: vale a mais nova. Uma carga silenciosa nunca deixa para trás o "Carregando..." de
 * uma carga normal que ela ultrapassou.
 */
async function loadLuts({ silent = false } = {}) {
    const seq = ++loadSeq;
    loadsInFlight++;
    try {
        if (!silent) {
            forgetParseFailures(); // atualizar também tenta de novo as LUTs que falharam
            resetCards();
            domRefs.lutsGrid.innerHTML = '<div class="luts-loading" role="status">Carregando LUTs...</div>';
            placeholderShown = true;
            domRefs.emptyState?.classList.add('hidden');
        }

        const res = await window.bds.listLuts();
        if (seq !== loadSeq) return; // uma carga mais nova já foi pedida: ela cuida da tela
        const fresh = Array.isArray(res?.items) ? res.items : [];
        const problems = Array.isArray(res?.problems) ? res.problems : [];
        const problemsSig = problems.map((p) => `${p.name}:${p.reason}`).join('|');
        const problemsChanged = problemsSig !== lastProblemsSig;
        lastProblemsSig = problemsSig;

        const before = new Map(luts.map((l) => [l.path, lutSignature(l)]));
        const sameList = before.size === fresh.length && fresh.every((l) => before.get(l.path) === lutSignature(l));
        if (silent && sameList && !placeholderShown) { // nada mudou: não mexe na tela
            if (problems.length && problemsChanged) showProblems(problems);
            return;
        }

        // O tipo (1D/3D) vem do cabeçalho que a lista já traz (nada é interpretado para filtrar); mantém o que a leitura
        // da prévia já descobriu e a marca de inválida; descarta caches de arquivos alterados ou removidos
        const known = new Map(luts.map((l) => [l.path, l]));
        const freshPaths = new Set(fresh.map((l) => l.path));
        for (const l of fresh) {
            l.type = typeLabel(l.kind);
            const old = known.get(l.path);
            if (old && lutSignature(old) === lutSignature(l)) {
                if (!l.type) l.type = old.type;
                if (silent) l.invalidReason = old.invalidReason;
                continue;
            }
            if (old) dropLutCaches(l.path, old);
        }
        for (const [path, old] of known) {
            if (!freshPaths.has(path)) dropLutCaches(path, old);
        }

        const previouslySelected = selectedLut;
        const previousSelection = selection.paths();
        luts = fresh;
        loadedOnce = true;
        lutByPath.clear();
        luts.forEach((l) => lutByPath.set(l.path, l));
        // A seleção acompanha as LUTs que ainda existem (agora apontando para os objetos novos); o que sumiu sai dela
        const selectionShrank = selection.prune((p) => lutByPath.has(p));
        syncActive();
        placeholderShown = false;
        applyFilters();
        if (selectionShrank) commitSelection(previousSelection);
        else if (selectedLut && selectedLut !== previouslySelected) updateInspector(); // a prévia em curso era do objeto antigo
        else if (selection.size > 1) updateInspector(); // o resumo (tamanho total) pode ter mudado
        if (problems.length && (!silent || problemsChanged)) showProblems(problems);
    } catch (err) {
        console.error('[LUTS] Erro ao carregar LUTs:', err);
        if (seq !== loadSeq) return;
        if (silent && !placeholderShown) { showNotice(`Não foi possível atualizar a lista: ${errMsg(err)}`, 'danger'); return; }
        domRefs.lutsGrid.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'luts-error';
        box.setAttribute('role', 'alert');
        box.innerHTML = '<span class="luts-error-text"></span><button type="button" class="lut-btn-outline" data-action="retry">Tentar novamente</button>';
        box.querySelector('.luts-error-text').textContent = `Erro ao carregar as LUTs: ${errMsg(err)}`;
        domRefs.lutsGrid.appendChild(box);
        placeholderShown = true;
        domRefs.emptyState?.classList.add('hidden');
    } finally {
        loadsInFlight--;
    }
}

/** Aviso (sem esconder as demais LUTs) dos arquivos da pasta que não puderam ser lidos. */
function showProblems(problems) {
    const items = problems.map((p) => (p.name ? `${p.name} (${p.reason})` : p.reason));
    const head = problems.length === 1 ? 'Um arquivo da pasta de LUTs não pôde ser lido' : `${problems.length} arquivos da pasta de LUTs não puderam ser lidos`;
    showNotice(`${head}: ${listNames(items, 3)}.`, 'warning');
}

/** Esquece cartão, interpretação e miniatura de um arquivo (renomeado, substituído ou excluído). */
function dropLutCaches(path, lut) {
    const card = cardCache.get(path);
    if (card) { card.remove(); cardCache.delete(path); }
    parsedLutCache.delete(path);
    failedParses.delete(path);
    if (lut) thumbnailCache.delete(thumbKey(lut));
}

/** Rótulo do tipo a partir do `kind` que a lista traz ('3D', '1D'); sem cabeçalho legível, não há tipo. */
function typeLabel(kind) {
    return kind === '1D' ? 'LUT 1D' : kind === '3D' ? 'LUT 3D' : null;
}

/** Mensagem legível de um erro vindo do IPC (remove o prefixo "Error invoking remote method"). */
function errMsg(err) {
    return friendlyError(err, 'Falha desconhecida.');
}

function applyFilters() {
    const query = foldText(domRefs.searchInput?.value); // sem acento nem caixa; também procura no nome da pasta
    const type = domRefs.typeFilter?.value || 'all';
    const sort = domRefs.sortFilter?.value || 'recent';

    if (!luts) {
        console.warn('[LUTS] applyFilters chamado, mas luts não está definido.');
        filteredLuts = [];
        renderGrid();
        return;
    }

    filteredLuts = luts.filter(lut => {
        // O tipo vem do cabeçalho que a lista já traz (nada é interpretado para filtrar): LUT sem tipo conhecido não
        // entra nos filtros 3D e 1D, e a LUT inválida só aparece em "Todos os tipos"
        let matchesType = true;
        if (type === '3d') matchesType = !lut.invalidReason && lut.type === 'LUT 3D';
        else if (type === '1d') matchesType = !lut.invalidReason && lut.type === 'LUT 1D';
        return matchesType && matchesQuery(lut, query);
    });

    sortLuts(filteredLuts, sort);

    // O que o filtro (ou a busca) esconde sai da seleção: uma ação em lote nunca age sobre o que a pessoa não vê
    const visiblePaths = new Set(filteredLuts.map((l) => l.path));
    const previousSelection = selection.paths();
    if (selection.prune((p) => visiblePaths.has(p))) commitSelection(previousSelection);

    renderGrid();
}

/** Cartões que a pessoa vê agora: fora os escondidos pelo filtro e os de grupos recolhidos (ordem da tela). */
function visibleCards() {
    return domRefs.lutsGrid ? Array.from(domRefs.lutsGrid.querySelectorAll('.lut-card:not(.hidden):not(.lut-collapsed)')) : [];
}

/** Só mostra grupos quando há subpastas e nenhuma busca (com busca a lista é plana e o cartão diz em que pasta está). */
function groupingActive() {
    return !(domRefs.searchInput?.value || '').trim() && hasSubfolders(luts);
}

/**
 * Redesenha a grade. O foco nunca se perde: cartões e cabeçalhos de grupo são movidos/recriados, então o elemento que
 * estava focado (ou o equivalente do grupo) recebe o foco de volta.
 */
function renderGrid() {
    const grid = domRefs.lutsGrid;
    const active = grid && document.activeElement && grid.contains(document.activeElement) ? document.activeElement : null;
    const head = active ? active.closest('.lut-group-head') : null;
    const memo = head ? { folder: head.dataset.folder || '', action: active.dataset.action || '' } : null;
    renderGridContent();
    if (!active) return;
    let target = active;
    if (memo) {
        const fresh = Array.from(grid.querySelectorAll('.lut-group-head')).find((h) => (h.dataset.folder || '') === memo.folder);
        target = fresh ? (fresh.querySelector(`[data-action="${memo.action}"]`) || fresh.querySelector('[data-action="toggle"]')) : null;
    }
    if (target && target.isConnected && document.activeElement !== target) {
        try { target.focus({ preventScroll: true }); } catch (_) { /* tela descartada */ }
    }
}

function renderGridContent() {
    if (!domRefs.lutsGrid) {
        console.error('[LUTS] renderGrid chamado, mas domRefs.lutsGrid não está definido.');
        return;
    }

    // Os cabeçalhos de grupo são recriados a cada desenho; placeholders ("Atualizando...", erros) também saem
    domRefs.lutsGrid.querySelectorAll('.lut-group-head').forEach((el) => el.remove());
    Array.from(domRefs.lutsGrid.children).forEach((el) => { if (!el.classList.contains('lut-card')) el.remove(); });

    if (!filteredLuts || filteredLuts.length === 0) {
        cardCache.forEach((card) => card.classList.add('hidden'));
        const emptyEl = domRefs.emptyState;
        if (emptyEl) {
            emptyEl.classList.remove('hidden');
            emptyEl.classList.add('active');
        }
        // Biblioteca vazia → convida a importar; busca/filtro sem resultado → só informa
        const libraryEmpty = !luts || luts.length === 0;
        if (domRefs.emptyText) domRefs.emptyText.textContent = libraryEmpty ? 'Sua biblioteca de LUTs está vazia.' : 'Nenhuma LUT corresponde à busca ou ao filtro.';
        if (domRefs.emptyHint) domRefs.emptyHint.textContent = libraryEmpty ? 'Importe arquivos .cube ou uma pasta, ou arraste-os para esta tela.' : 'Limpe a busca ou escolha "Todos os tipos".';
        domRefs.btnEmptyImport?.classList.toggle('hidden', !libraryEmpty);
        domRefs.ftTotal.textContent = '0 LUTs';
        // ✅ CORREÇÃO (Maximum call stack size exceeded): antes chamava selectLut(null) aqui,
        // que por sua vez chama renderGrid() de volta — com a lista vazia e selectedLut já
        // null, isso formava uma recursão infinita entre renderGrid() <-> selectLut() e
        // estourava a pilha assim que a tela de LUTs abria sem nenhum arquivo .cube.
        // Agora apenas limpamos o estado e atualizamos o Inspector diretamente, sem
        // re-chamar renderGrid() (commitSelection nunca redesenha a grade).
        if (selection.size) {
            const previous = selection.paths();
            selection.clear();
            commitSelection(previous);
        }
        return;
    }

    const emptyEl = domRefs.emptyState;
    if (emptyEl) {
        emptyEl.classList.add('hidden');
        emptyEl.classList.remove('active');
    }
    domRefs.ftTotal.textContent = `${filteredLuts.length} LUT${filteredLuts.length !== 1 ? 's' : ''}`;

    bindGridDelegation();

    // Reaproveita os cards já criados: os que não passam no filtro ficam ocultos (sem recriar DOM)
    const frag = document.createDocumentFragment();
    const shown = new Set();
    const grouped = groupingActive();
    const placeCard = (lut, collapsed) => {
        const card = getCard(lut);
        card.classList.remove('hidden');
        card.classList.toggle('lut-collapsed', collapsed); // recolher não é o mesmo que esconder pelo filtro
        setFolderTag(card, lut, !grouped);
        markSelected(card, selection.has(lut.path));
        shown.add(lut.path);
        frag.appendChild(card);
    };
    if (grouped) {
        for (const group of groupLuts(filteredLuts)) {
            const collapsed = collapsedFolders.has(group.folder);
            frag.appendChild(createGroupHead(group, collapsed));
            group.luts.forEach((lut) => placeCard(lut, collapsed));
        }
    } else {
        filteredLuts.forEach((lut) => placeCard(lut, false));
    }
    // Cartões escondidos (filtro) ficam guardados para voltar sem recriar o DOM, mas só até um teto: acima dele os mais
    // antigos são descartados (getCard cria de novo se precisar)
    const hiddenCards = [...cardCache].filter(([path]) => !shown.has(path));
    const dropCount = Math.max(0, hiddenCards.length - MAX_HIDDEN_CARDS);
    hiddenCards.forEach(([path, card], i) => {
        if (i < dropCount) {
            cardCache.delete(path);
            thumbObserver?.unobserve(card);
            card.remove();
            return;
        }
        card.classList.add('hidden');
        frag.appendChild(card);
    });
    domRefs.lutsGrid.appendChild(frag);
    syncRoving();
}

/**
 * Uma só parada de Tab para a grade: só o cartão "atual" tem tabindex 0 (os outros, -1) e as setas andam entre eles.
 * O atual é o preferido, o último com foco, o âncora da seleção, o primeiro selecionado visível ou o primeiro visível.
 */
let rovingPath = null;
function syncRoving(preferred = null) {
    const visible = visibleCards();
    const byPath = (path) => (path ? visible.find((c) => c.dataset.path === path) : null);
    const target = byPath(preferred) || byPath(rovingPath) || byPath(selection.anchor)
        || visible.find((c) => selection.has(c.dataset.path)) || visible[0] || null;
    cardCache.forEach((card) => { card.tabIndex = card === target ? 0 : -1; });
    rovingPath = target ? target.dataset.path : null;
}

/** O cartão alvo de uma tecla de navegação (setas, Home, End), a partir do cartão atual. Cima e Baixo seguem o layout real. */
function navigationTarget(visible, card, key) {
    const i = visible.indexOf(card);
    if (key === 'Home') return visible[0];
    if (key === 'End') return visible[visible.length - 1];
    if (key === 'ArrowRight') return visible[Math.min(i + 1, visible.length - 1)];
    if (key === 'ArrowLeft') return visible[Math.max(i - 1, 0)];
    const tops = visible.map((c) => Number(c.offsetTop) || 0);
    if (new Set(tops).size < 2) return visible[Math.min(Math.max(i + (key === 'ArrowDown' ? 1 : -1), 0), visible.length - 1)]; // sem layout em linhas (ex.: lista): um por vez
    const top = tops[i];
    const left = Number(card.offsetLeft) || 0;
    const down = key === 'ArrowDown';
    let rowTop = null;
    tops.forEach((t) => { if (down ? t > top && (rowTop === null || t < rowTop) : t < top && (rowTop === null || t > rowTop)) rowTop = t; });
    if (rowTop === null) return card; // já está na primeira ou na última linha
    let best = null;
    visible.forEach((c, j) => {
        if (tops[j] !== rowTop) return;
        if (!best || Math.abs((Number(c.offsetLeft) || 0) - left) < Math.abs((Number(best.offsetLeft) || 0) - left)) best = c;
    });
    return best;
}

// --- Cards reaproveitáveis, delegação de clique e miniaturas sob demanda ---
const cardCache = new Map();   // path -> elemento .lut-card
const lutByPath = new Map();   // path -> objeto lut
let thumbObserver = null;
const thumbQueue = [];
let thumbActive = 0;
const THUMB_CONCURRENCY = 2;
const MAX_HIDDEN_CARDS = 300; // cartões escondidos pelo filtro que continuam guardados (acima disso os mais antigos saem)
let searchDebounce = null;

function resetCards() {
    cardCache.clear();
    thumbQueue.length = 0;
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
}

function getThumbObserver() {
    if (thumbObserver || typeof IntersectionObserver === 'undefined') return thumbObserver;
    thumbObserver = new IntersectionObserver((entries, obs) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            obs.unobserve(entry.target);
            thumbQueue.push(entry.target);
        }
        pumpThumbs();
    }, { root: null, rootMargin: '200px' });
    return thumbObserver;
}

function observePendingThumbs() {
    cardCache.forEach((card) => {
        if (card.querySelector('.lut-card-img-loading')) getThumbObserver()?.observe(card);
    });
}

function pumpThumbs() {
    while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
        const card = thumbQueue.shift();
        const lut = lutByPath.get(card.dataset.path);
        const imgEl = card.querySelector('.lut-card-img');
        if (!lut || !imgEl || !card.isConnected) continue;
        thumbActive++;
        renderCardThumbnail(lut, imgEl).finally(() => { thumbActive--; pumpThumbs(); });
    }
}

function getCard(lut) {
    let card = cardCache.get(lut.path);
    if (card && card.dataset.mode === currentViewMode) return card;
    const dateObj = lut.modifiedAt ? new Date(lut.modifiedAt) : new Date();
    const fresh = !card;
    if (!card) {
        card = document.createElement('div');
        card.dataset.path = lut.path; // Para facilitar a seleção
        card.tabIndex = -1; // uma só parada de Tab para a grade inteira (syncRoving); as setas andam entre os cartões
        card.setAttribute('role', 'option');
        card.setAttribute('aria-selected', 'false');
        card.innerHTML = renderLutCard(lut, dateObj.toLocaleDateString('pt-BR'));
        const cardImg = card.querySelector('.lut-card-img');
        if (cardImg) {
            if (baseImageSrc !== DEFAULT_BASE_IMAGE) cardImg.src = baseImageSrc;
            cardImg.addEventListener('error', () => { cardImg.style.visibility = 'hidden'; });
        }
        cardCache.set(lut.path, card);
    }
    card.dataset.mode = currentViewMode;
    card.className = `lut-card view-${currentViewMode}`;
    applyCardValidity(card, lut);
    if (fresh) {
        const imgEl = card.querySelector('.lut-card-img');
        const cached = thumbnailCache.get(thumbKey(lut));
        if (cached && imgEl) {
            imgEl.src = cached;
            imgEl.classList.remove('lut-card-img-loading');
        } else {
            // Miniatura real só é gerada quando o card se aproxima da área visível
            getThumbObserver()?.observe(card);
        }
    }
    return card;
}

/** Na lista plana (busca), o cartão diz em que pasta a LUT está ("em A / B"); nos grupos, o cabeçalho já diz. */
function setFolderTag(card, lut, show) {
    const tag = card.querySelector('.lut-card-folder');
    if (!tag) return;
    const label = show && lut.folder ? `em ${folderLabel(lut.folder)}` : '';
    tag.textContent = label;
    if (label) { tag.removeAttribute('hidden'); tag.title = label; } else { tag.setAttribute('hidden', ''); tag.removeAttribute('title'); }
}

/** Cabeçalho de um grupo (pasta): recolher/expandir, nome, quantas LUTs passam no filtro e o menu da pasta. */
function createGroupHead(group, collapsed) {
    const head = document.createElement('div');
    head.className = collapsed ? 'lut-group-head collapsed' : 'lut-group-head';
    head.dataset.folder = group.folder;
    head.setAttribute('role', 'presentation');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'lut-icon-btn lut-icon-btn-small lut-group-toggle';
    toggle.dataset.action = 'toggle';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute('aria-label', `${collapsed ? 'Mostrar' : 'Recolher'} as LUTs de ${group.label}`);
    toggle.title = collapsed ? 'Mostrar' : 'Recolher';
    const arrow = document.createElement('span');
    arrow.className = 'material-symbols-rounded';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = 'expand_more';
    toggle.appendChild(arrow);
    head.appendChild(toggle);

    const icon = document.createElement('span');
    icon.className = 'material-symbols-rounded lut-group-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = group.folder ? 'folder' : 'folder_open';
    head.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'lut-group-name';
    name.textContent = group.label;
    name.title = group.label;
    head.appendChild(name);

    const count = document.createElement('span');
    count.className = 'lut-group-count';
    count.textContent = countLuts(group.luts.length);
    head.appendChild(count);

    const spacer = document.createElement('span');
    spacer.className = 'lut-group-spacer';
    head.appendChild(spacer);

    if (group.folder) { // a raiz da coleção ("Sem pasta") não tem o que renomear nem excluir
        const menu = document.createElement('button');
        menu.type = 'button';
        menu.className = 'lut-icon-btn lut-icon-btn-small';
        menu.dataset.action = 'group-menu';
        menu.title = 'Mais opções da pasta';
        menu.setAttribute('aria-label', `Mais opções da pasta ${group.label}`);
        menu.setAttribute('aria-haspopup', 'menu');
        const dots = document.createElement('span');
        dots.className = 'material-symbols-rounded';
        dots.setAttribute('aria-hidden', 'true');
        dots.textContent = 'more_vert';
        menu.appendChild(dots);
        head.appendChild(menu);
    }
    return head;
}

function toggleGroup(folder) {
    if (collapsedFolders.has(folder)) collapsedFolders.delete(folder); else collapsedFolders.add(folder);
    saveCollapsed(collapsedFolders);
    // O que o grupo recolhido esconde sai da seleção: uma ação em lote nunca age sobre o que a pessoa não vê
    const shown = new Set(visibleLuts().map((lut) => lut.path));
    const previousSelection = selection.paths();
    if (selection.prune((p) => shown.has(p))) commitSelection(previousSelection);
    renderGrid();
}

function bindGridDelegation() {
    const grid = domRefs.lutsGrid;
    if (!grid || grid.dataset.delegated) return;
    grid.dataset.delegated = '1';
    grid.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="retry"]')) { loadLuts(); return; }
        const head = e.target.closest('.lut-group-head');
        if (head && grid.contains(head)) {
            const folder = head.dataset.folder || '';
            const menuButton = e.target.closest('[data-action="group-menu"]');
            if (menuButton) { e.stopPropagation(); openGroupMenu(folder, menuButton); return; }
            toggleGroup(folder);
            return;
        }
        const card = e.target.closest('.lut-card');
        if (!card || !grid.contains(card)) return;
        const lut = lutByPath.get(card.dataset.path);
        if (!lut) return;
        if (e.target.closest('[data-action="menu"]')) {
            e.stopPropagation();
            const r = e.target.closest('[data-action="menu"]').getBoundingClientRect();
            if (!selection.has(lut.path)) selectLut(lut); // numa seleção múltipla o menu age sobre ela toda
            openCardMenu(lut, card, r);
            return;
        }
        // Círculo do cartão ou Ctrl/Cmd+clique alternam; Shift+clique marca o intervalo; clique comum marca só esta
        if (e.target.closest('.lut-checkbox') || e.ctrlKey || e.metaKey) {
            if (e.shiftKey && !e.target.closest('.lut-checkbox')) { selectRangeTo(lut, { additive: true }); return; }
            toggleSelected(lut);
            return;
        }
        if (e.shiftKey) { selectRangeTo(lut); return; }
        selectLut(lut);
    });
    // Shift+clique não pode virar seleção de texto na página
    grid.addEventListener('mousedown', (e) => { if (e.shiftKey && e.target.closest('.lut-card')) e.preventDefault(); });
    grid.addEventListener('dblclick', (e) => {
        const card = e.target.closest('.lut-card');
        const lut = card && lutByPath.get(card.dataset.path);
        if (lut) { selectLut(lut); openFullscreen(); }
    });
    grid.addEventListener('contextmenu', (e) => {
        const card = e.target.closest('.lut-card');
        const lut = card && lutByPath.get(card.dataset.path);
        if (!lut) return;
        e.preventDefault();
        if (!selection.has(lut.path)) selectLut(lut); // clicar com o botão direito dentro da seleção a mantém
        // Pelo teclado (tecla Menu, Shift+F10) não há ponto de clique: o menu sai junto do cartão
        openCardMenu(lut, card, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : card.getBoundingClientRect());
    });
    grid.addEventListener('keydown', (e) => {
        const card = e.target.closest?.('.lut-card');
        if (!card || e.target !== card || isAnyLutModalOpen()) return;
        const lut = lutByPath.get(card.dataset.path);
        if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            // Menu de ações pelo teclado (o botão ⋮ do cartão fica fora do Tab: a grade tem uma só parada)
            e.preventDefault();
            if (!lut) return;
            if (!selection.has(lut.path)) selectLut(lut);
            openCardMenu(lut, card, card.getBoundingClientRect());
        } else if (e.key === 'Enter' || e.key === ' ') {
            // Enter/Espaço marcam só esta; com Ctrl alternam; com Shift marcam até ela (como o clique)
            e.preventDefault();
            if (!lut) return;
            if (e.ctrlKey || e.metaKey) toggleSelected(lut);
            else if (e.shiftKey) selectRangeTo(lut);
            else selectLut(lut);
        } else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            const visible = visibleCards();
            const target = navigationTarget(visible, card, e.key);
            if (!target) return;
            if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
                // Shift+seta estende a seleção a partir da âncora (ou, sem âncora visível, da LUT em foco)
                if (!selection.anchor || !visible.some((c) => c.dataset.path === selection.anchor)) selection.setAnchor(card.dataset.path);
                const to = lutByPath.get(target.dataset.path);
                if (to) selectRangeTo(to);
            }
            target.focus();
            syncRoving(target.dataset.path);
        }
    });
    // Quem recebe o foco (teclado ou clique) passa a ser a parada de Tab da grade
    grid.addEventListener('focusin', (e) => {
        const card = e.target && e.target.closest ? e.target.closest('.lut-card') : null;
        if (card && e.target === card && grid.contains(card) && card.dataset.path !== rovingPath) syncRoving(card.dataset.path);
    });
}

function markSelected(card, on) {
    card.classList.toggle('selected', on);
    card.setAttribute('aria-selected', on ? 'true' : 'false');
}

/** Mostra (ou limpa) no cartão que a LUT é inválida: classe, selo "Inválida" e o motivo no title. */
function applyCardValidity(card, lut) {
    if (!card) return;
    const reason = lut.invalidReason;
    card.classList.toggle('lut-card-invalid', !!reason);
    const badge = card.querySelector('.lut-badge-3d');
    if (badge) {
        badge.classList.toggle('lut-badge-invalid', !!reason);
        badge.textContent = reason ? 'Inválida' : (lut.type || 'LUT');
    }
    if (reason) {
        card.title = `LUT inválida: ${reason}`;
        card.querySelector('.lut-card-img')?.classList.remove('lut-card-img-loading'); // sem miniatura a gerar
    } else {
        card.removeAttribute('title');
    }
}

/** A LUT não pôde ser lida: guarda o motivo e atualiza o cartão, o inspetor (se for a selecionada) e o filtro de tipo. */
function markLutInvalid(lut, reason) {
    if (lut.invalidReason === reason) return;
    lut.invalidReason = reason;
    applyCardValidity(cardCache.get(lut.path), lut);
    if (selectedLut && selectedLut.path === lut.path) applyInspectorValidity(lut);
    if ((domRefs.typeFilter?.value || 'all') !== 'all') applyFiltersSoon();
}

/**
 * Prévia e inspetor de uma LUT inválida: some o antes/depois (só a imagem base fica) e aparece "LUT inválida: motivo".
 * Para uma LUT válida desfaz tudo isso.
 */
function applyInspectorValidity(lut) {
    const reason = lut?.invalidReason || '';
    for (const container of [domRefs.sliderContainer, domRefs.fsSliderContainer]) container?.classList.toggle('lut-slider-invalid', !!reason);
    if (reason) {
        for (const canvas of [domRefs.sliderCanvas, domRefs.fsSliderCanvas]) canvas?.classList.add('hidden');
        if (domRefs.sliderTargetImg) domRefs.sliderTargetImg.style.display = '';
        if (domRefs.fsSliderTargetImg) domRefs.fsSliderTargetImg.style.display = '';
    }
    if (reason) domRefs.btnInsAddProject?.classList.add('hidden'); // LUT inválida não vai para projeto
    if (domRefs.insInvalid) domRefs.insInvalid.classList.toggle('hidden', !reason);
    if (domRefs.insInvalidText) domRefs.insInvalidText.textContent = reason ? `LUT inválida: ${reason}` : '';
    const badge = document.getElementById('insBadge');
    if (badge) {
        badge.classList.toggle('lut-badge-invalid', !!reason);
        if (lut) badge.textContent = reason ? 'Inválida' : (lut.type || 'LUT');
    }
    if (domRefs.btnFullscreen) domRefs.btnFullscreen.disabled = !lut || !!reason;
    if (reason && domRefs.fsModal && !domRefs.fsModal.classList.contains('hidden')) closeFullscreen();
}

// --- Aviso (substitui os alertas): sucesso, atenção e erro ---
let noticeTimer = null;
function showNotice(text, tone = 'info', autoHideMs = 0) {
    if (!domRefs.notice) return;
    clearTimeout(noticeTimer);
    const icons = { info: 'info', success: 'check_circle', warning: 'warning', danger: 'error' };
    domRefs.notice.className = `luts-notice tone-${tone}`;
    if (domRefs.noticeIcon) domRefs.noticeIcon.textContent = icons[tone] || 'info';
    if (domRefs.noticeText) domRefs.noticeText.textContent = text;
    if (autoHideMs > 0) noticeTimer = setTimeout(hideNotice, autoHideMs);
}
function hideNotice() {
    clearTimeout(noticeTimer);
    domRefs.notice?.classList.add('hidden');
}

// --- Menu de ações do cartão (Renomear / Mostrar na pasta / Excluir) ---
let cardMenu = null; // mesmo menu flutuante dos outros (setas, Home/End, Esc devolve o foco ao cartão de origem)

/** Abre o menu da LUT: `card` recebe o foco de volta ao fechar; `at` é o ponto do clique ou o retângulo do botão/cartão. */
function openCardMenu(lut, card, at) {
    const menu = domRefs.cardMenu;
    if (!menu || !cardMenu) return;
    // Dentro de uma seleção múltipla o menu age sobre todas: só "Excluir N LUTs" faz sentido (renomear e mostrar são de uma só)
    const many = selection.size > 1 && selection.has(lut.path);
    for (const action of ['rename', 'reveal']) menu.querySelector(`[data-action="${action}"]`)?.classList.toggle('hidden', many);
    menu.querySelector('[data-action="add-project"]')?.classList.toggle('hidden', !projectsOn()); // vale também para a seleção toda
    const deleteLabel = menu.querySelector('[data-action="delete"] .lut-menu-label');
    if (deleteLabel) deleteLabel.textContent = many ? `Excluir ${selection.size} LUTs` : 'Excluir';
    cardMenu.open(card, lut, at);
}
/** Fecha o menu da LUT; por padrão o foco volta ao cartão de origem (Esc), `{ restoreFocus: false }` deixa onde está. */
function hideCardMenu(options) {
    cardMenu?.hide(options);
}
function bindCardMenu() {
    if (cardMenu || !domRefs.cardMenu) return;
    cardMenu = createPopupMenu(domRefs.cardMenu, (action, lut) => {
        if (!lut) return;
        const many = selection.size > 1 && selection.has(lut.path);
        if (action === 'add-project') openProjectPicker(many ? selectedLuts() : [lut]);
        else if (action === 'rename') renameLut(lut);
        else if (action === 'reveal') revealLut(lut);
        else if (action === 'delete') deleteLuts(many ? selectedLuts() : [lut]);
    });
    // O cartão de origem é a âncora do foco; o clique em qualquer lugar fora do menu (inclusive nesse cartão) fecha
    document.addEventListener('pointerdown', (e) => {
        if (cardMenu.isOpen() && !cardMenu.contains(e.target)) cardMenu.hide({ restoreFocus: false });
    }, true);
    window.addEventListener('blur', () => cardMenu.hide({ restoreFocus: false }));
}

// --- Arrastar e soltar .cube para importar ---
let dragDepth = 0;
let dndBound = false;
function bindDragAndDrop() {
    const root = domRefs.gridArea?.closest('.luts-screen-container');
    if (dndBound || !root) return;
    dndBound = true;
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    root.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        domRefs.dropZone?.classList.remove('hidden');
    });
    root.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    root.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) domRefs.dropZone?.classList.add('hidden');
    });
    root.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        domRefs.dropZone?.classList.add('hidden');
        const paths = Array.from(e.dataTransfer.files)
            .map((f) => (window.bds?.getPathForFile ? window.bds.getPathForFile(f) : f.path || ''))
            .filter(Boolean);
        if (paths.length) importFlow?.start({ paths }); // arquivos e pastas soltos passam pelo mesmo resumo do botão Importar
    });
}

function applyFiltersSoon() {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(applyFilters, 50);
}

function idleYield() {
    return new Promise((resolve) => {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 200 });
        else setTimeout(resolve, 16);
    });
}

// ✅ Função separada para renderizar o card, usando escapeHtmlFunc
function renderLutCard(lut, dateStr) {
    const escapedName = escapeHtmlFunc(lut.name);
    const lutType = lut.type || 'LUT';
    // Enquanto a miniatura real (com a LUT aplicada) é gerada, mostra a imagem base "crua"
    return `
        <img src="${DEFAULT_BASE_IMAGE}" class="lut-card-img lut-card-img-loading" alt="" draggable="false">
        <span class="lut-badge-3d">${escapeHtmlFunc(lutType)}</span>
        <div class="lut-checkbox" aria-hidden="true"><span class="material-symbols-rounded">check</span></div>

        <div class="lut-card-body">
            <div class="lut-card-info">
                <span class="lut-card-title" title="${escapedName}">${escapedName}</span>
                <div class="lut-card-meta">
                    <span>.cube</span>
                    <span>${dateStr}</span>
                    <span class="lut-card-folder" hidden></span>
                </div>
            </div>
            <button type="button" class="lut-icon-btn lut-icon-btn-small" data-action="menu" tabindex="-1" aria-hidden="true" title="Mais opções" aria-label="Mais opções de ${escapedName}" aria-haspopup="menu">
                <span class="material-symbols-rounded">more_vert</span>
            </button>
        </div>
    `;
}

// Gera (ou reaproveita do cache) uma miniatura real do card aplicando a LUT .cube
// de fato sobre a imagem base, via Canvas offscreen (~320 px), sem escurecer nem clarear a imagem por CSS.
// Cópias idênticas (mesmo hash) dividem o trabalho: a que chega enquanto a outra está sendo feita espera por ela.
const thumbJobs = new Map(); // chave da miniatura -> Promise<string|null> (data URL)

/** Desenha a miniatura de uma LUT já lida. Nunca lança: sem miniatura (imagem ou canvas indisponíveis) devolve null. */
async function buildThumbnail(lut, key, parsed) {
    try {
        const sourceImg = await loadBaseImage(getBasePreviewImageUrl());
        await idleYield(); // cede a thread antes do trabalho pesado de pixels
        const offscreen = document.createElement('canvas');
        applyLutToCanvas(parsed, sourceImg, offscreen, THUMB_MAX_DIM);
        const url = offscreen.toDataURL('image/jpeg', 0.85);
        thumbnailCache.set(key, url, url.length);
        return url;
    } catch (err) {
        console.warn('[LUTS] Falha ao gerar miniatura real para', lut.name, err);
        return null; // a LUT abre (o tipo vale), só a miniatura não saiu: fica a imagem base
    }
}

async function renderCardThumbnail(lut, imgEl) {
    if (!imgEl) return;

    const key = thumbKey(lut);
    const cached = thumbnailCache.get(key);
    if (cached) {
        imgEl.src = cached;
        imgEl.classList.remove('lut-card-img-loading');
        return;
    }

    try {
        const parsed = await getParsedLut(lut.path);
        if (!parsed.ok) { markLutInvalid(lut, parsed.reason); return; } // o cartão passa a dizer "Inválida" (imagem crua)

        // O tipo normalmente já veio do cabeçalho da lista; a leitura completa é a palavra final (e habilita o filtro por tipo)
        const learned = typeLabel(parsed.is1D ? '1D' : '3D');
        const typeChanged = lut.type !== learned;
        lut.type = learned;
        const badgeEl = imgEl.closest('.lut-card')?.querySelector('.lut-badge-3d');
        if (badgeEl && !lut.invalidReason) badgeEl.textContent = lut.type;
        if (typeChanged && (domRefs.typeFilter?.value || 'all') !== 'all') applyFiltersSoon();

        let job = thumbJobs.get(key);
        if (!job) {
            job = buildThumbnail(lut, key, parsed).finally(() => thumbJobs.delete(key));
            thumbJobs.set(key, job);
        }
        const url = await job;
        // Só aplica se o elemento ainda estiver na tela
        if (url && imgEl.isConnected) {
            imgEl.src = url;
            imgEl.classList.remove('lut-card-img-loading');
        }
    } catch (err) {
        console.warn('[LUTS] Falha ao gerar miniatura real para', lut.name, err);
        // Mantém a imagem base visível em caso de erro
    }
}


// --- Seleção (uma ou várias LUTs) ---

/** Marca só esta LUT (ou limpa a seleção, com null). */
function selectLut(lut) {
    mutateSelection(() => selection.replace(lut ? [lut.path] : [], lut ? lut.path : null));
}

/** Botão X do inspetor: limpa a seleção (o painel some) e devolve o foco ao cartão em que a pessoa estava. */
function closeInspector() {
    const anchorPath = selection.anchor || selection.paths()[0] || null;
    selectLut(null);
    focusCard(anchorPath);
}

/** Ctrl/Cmd+clique e círculo do cartão: alterna esta LUT sem mexer nas outras. */
function toggleSelected(lut) {
    mutateSelection(() => selection.toggle(lut.path));
}

/** Shift+clique: marca o intervalo entre a âncora e esta LUT, na ordem da tela (pula as escondidas e as recolhidas). */
function selectRangeTo(lut, { additive = false } = {}) {
    const order = visibleCards().map((card) => card.dataset.path);
    const previous = selection.paths();
    if (selection.selectRange(order, lut.path, { additive })) commitSelection(previous);
    else selectLut(lut); // sem âncora visível o Shift+clique vale como clique comum
}

/** Ctrl/Cmd+A: tudo que está visível (sem as LUTs de grupos recolhidos). */
function selectAllVisible() {
    const paths = visibleCards().map((card) => card.dataset.path);
    if (!paths.length) return;
    mutateSelection(() => selection.replace(paths, selection.anchor && paths.includes(selection.anchor) ? selection.anchor : paths[0]));
}

function clearSelection() {
    const bar = domRefs.selectionBar;
    const focusWasInBar = !!(bar && document.activeElement && bar.contains(document.activeElement));
    const anchorPath = selection.anchor || selection.paths()[0] || null;
    mutateSelection(() => selection.clear());
    if (focusWasInBar) focusCard(anchorPath); // a barra some: o foco volta para o cartão em que a pessoa estava
}

/** Executa uma mudança na seleção e atualiza cartões, inspetor, rodapé e barra de ações. */
function mutateSelection(change) {
    const previous = selection.paths();
    change();
    commitSelection(previous);
}

/** Depois de qualquer mudança na seleção (nunca redesenha a grade): LUT ativa, marcas dos cartões, inspetor e barra. */
function commitSelection(previous) {
    syncActive();
    // Só alterna a classe nos cartões afetados (sem reconstruir a grade)
    for (const path of previous) { const c = cardCache.get(path); if (c) markSelected(c, selection.has(path)); }
    for (const path of selection.paths()) { const c = cardCache.get(path); if (c) markSelected(c, true); }
    updateInspector(); // painel lateral e rodapé
    updateSelectionBar();
}

/** A "LUT ativa" (a do inspetor): só existe com exatamente uma LUT marcada. */
function syncActive() {
    const only = selection.only();
    selectedLut = only ? (lutByPath.get(only) || null) : null;
}

/** As LUTs que a pessoa vê, na ordem da tela: sem as escondidas pelo filtro nem as de grupos recolhidos. */
function visibleLuts() {
    if (!groupingActive()) return filteredLuts;
    return groupLuts(filteredLuts).filter((g) => !collapsedFolders.has(g.folder)).flatMap((g) => g.luts);
}

/** As LUTs marcadas, na ordem em que aparecem na tela (nunca as de um grupo recolhido). */
function selectedLuts() {
    if (!selection.size) return [];
    return visibleLuts().filter((lut) => selection.has(lut.path));
}

/** Foca o cartão de uma LUT (se estiver visível) ou, na falta dele, o primeiro cartão visível. */
function focusCard(path) {
    const target = (path && cardCache.get(path)) || null;
    const usable = target && target.isConnected && !target.classList.contains('hidden') && !target.classList.contains('lut-collapsed');
    const card = usable ? target : visibleCards()[0];
    try { card?.focus({ preventScroll: true }); } catch (_) { /* tela descartada */ }
}

/** A barra de ações só existe com 2 ou mais selecionadas; os círculos dos cartões ficam à mostra enquanto há seleção. */
function updateSelectionBar() {
    const count = selection.size;
    domRefs.lutsGrid?.classList.toggle('has-selection', count > 0);
    const bar = domRefs.selectionBar;
    if (!bar) return;
    const show = count >= 2;
    const focusWasInBar = !show && !!document.activeElement && bar.contains(document.activeElement);
    bar.classList.toggle('hidden', !show);
    domRefs.btnSelAddProject?.classList.toggle('hidden', !projectsOn());
    if (domRefs.selectionCount) domRefs.selectionCount.textContent = `${count} selecionadas`;
    if (focusWasInBar) focusCard(selection.anchor || selection.paths()[0] || null); // o foco nunca se perde com a barra
}

/** Resumo no inspetor quando há várias LUTs marcadas (no lugar do antes/depois e dos detalhes de uma só). */
function renderSelectionSummary() {
    const multiple = selection.size > 1;
    domRefs.inspectorPanel?.classList.toggle('inspector-multiple', multiple);
    domRefs.insMulti?.classList.toggle('hidden', !multiple);
    if (!multiple) return;
    const info = summarize(selectedLuts());
    if (domRefs.insMultiTitle) domRefs.insMultiTitle.textContent = `${info.count} LUTs selecionadas`;
    if (domRefs.insMultiSize) domRefs.insMultiSize.textContent = `Tamanho total: ${formatBytes(info.totalBytes)}`;
    const list = domRefs.insMultiList;
    if (!list) return;
    list.textContent = '';
    for (const name of info.names) {
        const li = document.createElement('li');
        li.textContent = name; // nome de arquivo: sempre por textContent
        list.appendChild(li);
    }
    if (info.more) {
        const li = document.createElement('li');
        li.className = 'inspector-multi-more';
        li.textContent = `e mais ${info.more}`;
        list.appendChild(li);
    }
}

// ✅ Função separada para atualizar o inspector, usando escapeHtmlFunc
function updateInspector() {
    const btnReveal = domRefs.btnReveal;
    const btnFullscreen = domRefs.btnFullscreen;
    const btnRename = domRefs.btnRename;
    const btnDelete = domRefs.btnDelete;

    domRefs.ftSelected.textContent = countLuts(selection.size); // "Selecionado: 0 LUTs / 1 LUT / 5 LUTs"
    domRefs.inspectorPanel?.classList.toggle('hidden', selection.size === 0); // o painel só existe com alguma LUT marcada
    renderSelectionSummary(); // com várias marcadas o inspetor mostra o resumo no lugar dos detalhes de uma só

    if (!selectedLut) {
        const badgeEl = document.getElementById('insBadge');
        if (badgeEl) badgeEl.textContent = '--';
        document.getElementById('insName').textContent = 'Selecione uma LUT';
        document.getElementById('insType').textContent = '--';
        document.getElementById('insSize').textContent = '--';
        document.getElementById('insDate').textContent = '--';
        domRefs.insFolderRow?.classList.add('hidden');

        // Esconder canvas de preview real e mostrar img padrão
        if (domRefs.sliderCanvas) domRefs.sliderCanvas.classList.add('hidden');
        if (domRefs.sliderTargetImg) domRefs.sliderTargetImg.style.display = '';
        if (domRefs.fsSliderCanvas) domRefs.fsSliderCanvas.classList.add('hidden');
        if (domRefs.fsSliderTargetImg) domRefs.fsSliderTargetImg.style.display = '';

        // Reset sliders
        resetSlider('main');
        resetSlider('fullscreen');

        if (btnReveal) btnReveal.disabled = true;
        if (btnFullscreen) btnFullscreen.disabled = true;
        if (btnRename) btnRename.disabled = true;
        if (btnDelete) btnDelete.disabled = true;

        applyInspectorValidity(null);
        updateUsageRow(null);
        if (domRefs.cubeSection) domRefs.cubeSection.classList.add('hidden');
        return;
    }

    const dateObj = selectedLut.modifiedAt ? new Date(selectedLut.modifiedAt) : new Date();

    document.getElementById('insName').textContent = selectedLut.name;
    const insBadge = document.getElementById('insBadge');
    if (insBadge) insBadge.textContent = selectedLut.type || 'LUT';
    document.getElementById('insType').textContent = selectedLut.type || 'LUT';
    document.getElementById('insSize').textContent = formatBytes(selectedLut.size);
    document.getElementById('insDate').textContent =
        dateObj.toLocaleDateString('pt-BR') + ' ' +
        dateObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (domRefs.insFolder) domRefs.insFolder.textContent = selectedLut.folder ? folderLabel(selectedLut.folder) : '--';
    domRefs.insFolderRow?.classList.toggle('hidden', !selectedLut.folder);

    // Atualiza imagem base (ANTES) de acordo com a configuração do usuário
    const baseImgSrc = getBasePreviewImageUrl();
    if (domRefs.sliderBaseImg && domRefs.sliderBaseImg.src !== baseImgSrc) domRefs.sliderBaseImg.src = baseImgSrc;
    if (domRefs.sliderTargetImg && domRefs.sliderTargetImg.src !== baseImgSrc) domRefs.sliderTargetImg.src = baseImgSrc;
    if (domRefs.fsSliderBaseImg && domRefs.fsSliderBaseImg.src !== baseImgSrc) domRefs.fsSliderBaseImg.src = baseImgSrc;
    if (domRefs.fsSliderTargetImg && domRefs.fsSliderTargetImg.src !== baseImgSrc) domRefs.fsSliderTargetImg.src = baseImgSrc;

    // Aplicação real da LUT no slider via Canvas
    renderRealLutPreview(selectedLut, baseImgSrc);

    if (btnReveal) btnReveal.disabled = false;
    if (btnFullscreen) btnFullscreen.disabled = false;
    if (btnRename) btnRename.disabled = false;
    if (btnDelete) btnDelete.disabled = false;
    applyInspectorValidity(selectedLut); // LUT já sabida como inválida: banner na hora, "Tela cheia" desativado
    updateUsageRow(selectedLut);         // "Usada em N projetos" e o link para adicionar a um projeto

    // Atualiza a seção "Arquivo .cube"
    updateCubeSection(selectedLut);
}

// Renderiza a LUT real no Canvas do slider
let currentRenderToken = 0;
async function renderRealLutPreview(lut, baseImgSrc) {
    const renderToken = ++currentRenderToken;
    const canvas = domRefs.sliderCanvas;
    const targetImg = domRefs.sliderTargetImg;

    if (!canvas) return;

    try {
        // A imagem e a leitura da LUT andam juntas; mas uma LUT inválida não depende da imagem para ser mostrada assim
        const imagePromise = loadBaseImage(baseImgSrc);
        imagePromise.catch(() => {}); // se a LUT for inválida a imagem nem é esperada
        const parsed = await getParsedLut(lut.path);
        if (renderToken !== currentRenderToken || selectedLut !== lut) return;

        if (parsed.ok) {
            const sourceImg = await imagePromise;
            if (renderToken !== currentRenderToken || selectedLut !== lut) return;
            applyLutToCanvas(parsed, sourceImg, canvas);
            canvas.classList.remove('hidden');
            if (targetImg) targetImg.style.display = 'none';

            // Também prepara para fullscreen se o canvas fullscreen existir
            if (domRefs.fsSliderCanvas) {
                applyLutToCanvas(parsed, sourceImg, domRefs.fsSliderCanvas);
            }
        } else {
            // Nunca deixa a prévia da LUT anterior sob o nome desta: some o antes/depois e aparece o motivo
            markLutInvalid(lut, parsed.reason);
            applyInspectorValidity(lut);
        }
    } catch (err) {
        console.error('[LUTS] Erro ao renderizar preview real da LUT:', err);
        // Fallback: mantém a imagem original visível
        if (canvas) canvas.classList.add('hidden');
        if (targetImg) targetImg.style.display = '';
    }
}

// ✅ Seção "Arquivo .cube": carrega header + preview das entradas RGB
async function updateCubeSection(lut) {
    if (!domRefs.cubeSection) return;

    // Guarda uma referência ao LUT solicitado para evitar condição de corrida
    // (usuário troca de seleção rápido antes da resposta do IPC chegar)
    const requestedLut = lut;

    if (!window.bds?.getLutHeader) {
        console.warn('[LUTS] window.bds.getLutHeader indisponível.');
        domRefs.cubeSection.classList.add('hidden');
        return;
    }

    try {
        const header = await window.bds.getLutHeader(lut.path);

        // Se o usuário já trocou de LUT enquanto aguardávamos a resposta, ignora
        if (selectedLut !== requestedLut) return;

        if (!header || header.ok === false) { showCubeReadError((header && header.reason) || 'Não foi possível ler este arquivo .cube.'); return; }

        if (domRefs.insTitle) domRefs.insTitle.textContent = header.title || '—';
        if (domRefs.insLutSize) {
            domRefs.insLutSize.textContent = header.size
                ? (header.is1D ? `${header.size}` : `${header.size}³`)
                : '—';
        }

        // ✅ CORREÇÃO (bug 3): header.totalEntries agora reflete a contagem REAL de linhas
        // RGB válidas lidas do arquivo (não mais size³ assumido). Se divergir do valor
        // esperado, é sinal de arquivo truncado/corrompido — avisamos visualmente.
        if (domRefs.insLutEntries) {
            const expected = header.size ? (header.is1D ? header.size : header.size * header.size * header.size) : null;
            // Arquivo grande: o painel lê só o começo e não conta as linhas (totalEntries nulo); a leitura completa da
            // prévia diz se a tabela está certa (LUT inválida), então aqui vale o tamanho declarado, sem alarme
            const partial = header.totalEntries == null && expected != null;
            const countLabel = partial ? expected.toLocaleString('pt-BR') : (header.totalEntries != null ? header.totalEntries.toLocaleString('pt-BR') : '—');
            if (!partial && expected != null && header.totalEntries !== expected) {
                domRefs.insLutEntries.textContent = `${countLabel} (esperado: ${expected.toLocaleString('pt-BR')})`;
                domRefs.insLutEntries.classList.add('cube-meta-value-warning');
            } else {
                domRefs.insLutEntries.textContent = countLabel;
                domRefs.insLutEntries.classList.remove('cube-meta-value-warning');
            }
        }

        if (domRefs.insLutDomain) {
            if (header.domainMin && header.domainMax) {
                const fmt = (arr) => arr.map(v => v.toFixed(2)).join(', ');
                domRefs.insLutDomain.textContent = `[${fmt(header.domainMin)}] – [${fmt(header.domainMax)}]`;
            } else if (Array.isArray(header.inputRange) && header.inputRange.length === 2) {
                domRefs.insLutDomain.textContent = `${header.inputRange[0].toFixed(2)} – ${header.inputRange[1].toFixed(2)}`;
            } else {
                domRefs.insLutDomain.textContent = '0.0 – 1.0 (padrão)';
            }
        }

        renderCubeRgbTable(header.preview || []);

        domRefs.cubeSection.classList.remove('hidden');
    } catch (err) {
        console.error('[LUTS] Erro ao carregar cabeçalho do .cube:', err);
        if (selectedLut !== requestedLut) return;
        showCubeReadError('Não foi possível ler este arquivo .cube.');
    }
}

/** A seção "Arquivo .cube" quando o cabeçalho não pôde ser lido: o motivo no lugar dos metadados. */
function showCubeReadError(message) {
    if (domRefs.insTitle) domRefs.insTitle.textContent = '—';
    if (domRefs.insLutSize) domRefs.insLutSize.textContent = '—';
    if (domRefs.insLutDomain) domRefs.insLutDomain.textContent = '—';
    if (domRefs.insLutEntries) {
        domRefs.insLutEntries.textContent = message;
        domRefs.insLutEntries.classList.add('cube-meta-value-warning');
    }
    if (domRefs.cubeRgbTable) {
        domRefs.cubeRgbTable.innerHTML = '<div class="cube-rgb-empty">Não foi possível ler este arquivo .cube.</div>';
    }
    domRefs.cubeSection.classList.remove('hidden');
}

// ✅ Renderiza a tabela de preview das entradas RGB com swatches
function renderCubeRgbTable(entries) {
    const container = domRefs.cubeRgbTable;
    if (!container) return;

    if (!entries.length) {
        container.innerHTML = '<div class="cube-rgb-empty">Nenhuma entrada disponível.</div>';
        return;
    }

    const PREVIEW_LIMIT = 50;
    const rows = entries.slice(0, PREVIEW_LIMIT).map(([r, g, b], index) => {
        const clamp = (v) => Math.min(1, Math.max(0, v));
        const toByte = (v) => Math.round(clamp(v) * 255);
        const swatchColor = `rgb(${toByte(r)}, ${toByte(g)}, ${toByte(b)})`;
        return `
            <div class="cube-rgb-row">
                <span class="cube-rgb-index">${index}</span>
                <span class="cube-swatch" style="background:${swatchColor}"></span>
                <span class="cube-rgb-value">${r.toFixed(4)}</span>
                <span class="cube-rgb-value">${g.toFixed(4)}</span>
                <span class="cube-rgb-value">${b.toFixed(4)}</span>
            </div>
        `;
    }).join('');

    container.innerHTML = rows;
}

// ✅ Abre o modal com o conteúdo raw completo do .cube
async function openCubeRawModal() {
    if (!selectedLut || !domRefs.cubeRawModal) return;

    if (domRefs.cubeRawModalTitle) {
        domRefs.cubeRawModalTitle.textContent = selectedLut.name; // textContent já protege: escapar de novo mostraria "A&amp;B"
    }
    if (domRefs.cubeRawContent) {
        domRefs.cubeRawContent.textContent = 'Carregando...';
    }
    domRefs.cubeRawModal.classList.remove('hidden');

    try {
        const { rawContent, truncated, totalBytes } = await window.bds.getLutRaw(selectedLut.path);
        renderCubeRawContent(rawContent, { truncated, totalBytes });
    } catch (err) {
        console.error('[LUTS] Erro ao carregar conteúdo bruto do .cube:', err);
        if (domRefs.cubeRawContent) {
            domRefs.cubeRawContent.textContent = 'Erro ao carregar o conteúdo do arquivo.';
        }
    }
}

function closeCubeRawModal() {
    domRefs.cubeRawModal?.classList.add('hidden');
    // Libera a memória do conteúdo renderizado (pode ter centenas de milhares de nós
    // para LUTs grandes) assim que o modal é fechado, em vez de esperar a próxima abertura.
    if (domRefs.cubeRawContent) {
        domRefs.cubeRawContent.textContent = '';
    }
}

// ✅ Limite de linhas que recebem highlight individual (via <span>).
// Acima disso, o custo de criar um nó de DOM por linha (ex: 262k linhas em uma LUT 64³,
// ou +2M linhas em uma LUT 129³) pode travar a thread da UI e consumir memória excessiva.
// Nesses casos, cai para texto puro (ainda legível, só sem cores).
const CUBE_HIGHLIGHT_LINE_LIMIT = 5000;

// ✅ Renderiza o conteúdo bruto do .cube no <pre>, com highlight básico quando seguro
function renderCubeRawContent(rawContent, { truncated = false, totalBytes = null } = {}) {
    const container = domRefs.cubeRawContent;
    if (!container) return;

    container.textContent = '';

    // ✅ CORREÇÃO (bug 2): quando o backend truncou o conteúdo (arquivo maior que
    // RAW_CONTENT_MAX_BYTES), avisamos o usuário em vez de fingir que é o arquivo completo.
    if (truncated) {
        const notice = document.createElement('div');
        notice.className = 'cube-raw-truncated-notice';
        const sizeLabel = totalBytes != null ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB` : 'tamanho desconhecido';
        notice.textContent = `Arquivo grande (${sizeLabel}). Mostrando apenas o início do conteúdo para evitar travamentos.`;
        container.appendChild(notice);
    }

    const lines = rawContent.split(/\r?\n/);
    const dataNode = document.createElement('div');

    if (lines.length > CUBE_HIGHLIGHT_LINE_LIMIT) {
        // Arquivo grande: renderiza como texto puro (1 único nó de texto),
        // evitando criar um <span> por linha.
        dataNode.textContent = rawContent;
    } else {
        dataNode.innerHTML = highlightCubeContent(lines);
    }

    container.appendChild(dataNode);
}

// ✅ Highlight básico de sintaxe para o conteúdo do .cube (uso restrito a arquivos pequenos,
// veja CUBE_HIGHLIGHT_LINE_LIMIT em renderCubeRawContent)
function highlightCubeContent(lines) {
    return lines.map(line => {
        const escaped = escapeHtmlFunc(line);
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) {
            return `<span class="cube-line-comment">${escaped}</span>`;
        }
        if (/^(TITLE|LUT_3D_SIZE|LUT_1D_SIZE|DOMAIN_MIN|DOMAIN_MAX)\b/.test(trimmed)) {
            return `<span class="cube-line-directive">${escaped}</span>`;
        }
        if (trimmed === '') {
            return '';
        }
        return `<span class="cube-line-data">${escaped}</span>`;
    }).join('\n');
}

// AÇÕES (com tratamento de erro e uso de bdsModal)

let busyAction = false; // evita abrir dois diálogos (ex.: Delete repetido)

function listNames(items, max = 4) {
    const shown = items.slice(0, max).join(', ');
    return items.length > max ? `${shown} e mais ${items.length - max}` : shown;
}

/** "1 LUT importada" / "5 LUTs importadas". */
function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
}

/**
 * Depois de importar (inclusive quando a pessoa cancelou no meio): recarrega a lista, conta o que aconteceu e mostra
 * a primeira LUT importada.
 */
async function afterImport(out) {
    await loadLuts({ silent: true });
    const imported = out.imported || 0;
    const lines = [];
    if (out.canceled) lines.push('Importação cancelada; o que já tinha sido copiado ficou na biblioteca.');
    if (imported) lines.push(`${plural(imported, 'LUT importada', 'LUTs importadas')}${out.groupsCreated ? `, com ${plural(out.groupsCreated, 'pasta nova', 'pastas novas')}` : ''}.`);
    if (out.renamed) lines.push(`${plural(out.renamed, 'LUT foi salva', 'LUTs foram salvas')} com " (2)": já existia outra, diferente, com o mesmo nome.`);
    if (out.exists) lines.push(`${plural(out.exists, 'LUT já estava', 'LUTs já estavam')} na biblioteca.`);
    if (out.skippedChanged) lines.push(`${plural(out.skippedChanged, 'arquivo mudou', 'arquivos mudaram')} durante a importação e não ${out.skippedChanged === 1 ? 'foi copiado' : 'foram copiados'}.`);
    if (out.failed) {
        const names = (out.failures || []).map((f) => `${f.name} (${f.reason})`);
        lines.push(`${plural(out.failed, 'LUT não pôde', 'LUTs não puderam')} ser ${out.failed === 1 ? 'copiada' : 'copiadas'}${names.length ? `: ${listNames(names, 3)}` : ''}.`);
    }
    if (!lines.length) lines.push('Nada foi importado.');
    const tone = imported && !out.failed && !out.skippedChanged && !out.canceled ? 'success' : (imported || out.exists ? 'warning' : (out.canceled ? 'warning' : 'danger'));
    showNotice(lines.join('\n'), tone, tone === 'success' ? 6000 : 0);

    // Mostra (e seleciona) a primeira LUT importada, expandindo a pasta dela
    const first = out.firstImported && lutByPath.get(out.firstImported.path);
    if (first) {
        if (domRefs.searchInput?.value) domRefs.searchInput.value = '';
        if (domRefs.typeFilter) domRefs.typeFilter.value = 'all';
        if (first.folder && collapsedFolders.delete(first.folder)) saveCollapsed(collapsedFolders);
        applyFilters();
        selectLut(first);
        cardCache.get(first.path)?.scrollIntoView({ block: 'nearest' });
    }
}

// --- Menus flutuantes: "Importar" (arquivos ou pasta) e as opções de cada pasta ---

/**
 * Menu simples de botões com data-action: abre junto de um botão, setas e Home/End navegam, Esc fecha devolvendo o foco
 * ao botão, e um clique fora fecha.
 */
function createPopupMenu(menu, onAction) {
    let anchor = null;
    let context = null;
    const isOpen = () => !menu.classList.contains('hidden');
    // Só os itens à mostra entram na navegação (o menu esconde alguns pela classe "hidden")
    const shownItems = () => Array.from(menu.querySelectorAll('button:not(.hidden)'));

    function hide({ restoreFocus = true } = {}) {
        if (!isOpen()) return;
        menu.classList.add('hidden');
        const back = anchor;
        anchor = null;
        context = null;
        if (back && back.hasAttribute('aria-haspopup')) back.setAttribute('aria-expanded', 'false');
        if (restoreFocus && back && back.isConnected) {
            try { back.focus({ preventScroll: true }); } catch (_) { /* tela descartada */ }
        }
    }

    /**
     * Abre o menu. `anchorEl` é quem recebe o foco de volta ao fechar. `at` diz onde ele aparece: um ponto { x, y }
     * (botão direito) ou um retângulo (o menu fica abaixo dele, alinhado à direita); sem `at`, usa o próprio `anchorEl`.
     */
    function open(anchorEl, ctx, at = null) {
        hide({ restoreFocus: false });
        anchor = anchorEl;
        context = ctx;
        if (anchor.hasAttribute('aria-haspopup')) anchor.setAttribute('aria-expanded', 'true');
        menu.classList.remove('hidden');
        const w = menu.offsetWidth || 200;
        const h = menu.offsetHeight || 100;
        let left;
        let top;
        if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
            left = at.x;
            top = at.y + 4;
        } else {
            const rect = at || anchorEl.getBoundingClientRect();
            left = rect.right - w;
            top = rect.bottom + 4;
        }
        menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`;
        shownItems()[0]?.focus();
    }

    menu.addEventListener('click', (e) => {
        const button = e.target.closest('button[data-action]');
        if (!button) return;
        const ctx = context;
        hide();
        onAction(button.dataset.action, ctx);
    });
    menu.addEventListener('keydown', (e) => {
        const items = shownItems();
        const i = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
        else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
        else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); }
        else if (e.key === 'Tab') hide({ restoreFocus: false });
    });

    return {
        open,
        hide,
        isOpen,
        isAnchor: (node) => !!anchor && anchor.contains(node),
        contains: (node) => menu.contains(node),
        anchor: () => anchor
    };
}

let popupMenusBound = false;
function bindPopupMenus() {
    if (popupMenusBound || !domRefs.importMenu || !domRefs.groupMenu) return;
    popupMenusBound = true;
    importMenu = createPopupMenu(domRefs.importMenu, (action) => importFlow?.start({ mode: action === 'files' ? 'files' : 'folder' }));
    groupMenu = createPopupMenu(domRefs.groupMenu, (action, folder) => {
        if (typeof folder !== 'string') return;
        if (action === 'select-folder') selectFolderLuts(folder);
        else if (action === 'add-project-folder') openProjectPicker([], { folder });
        else if (action === 'rename-folder') renameFolderAction(folder);
        else if (action === 'open-folder') openLutsFolder(folder);
        else if (action === 'delete-folder') deleteFolderAction(folder);
    });
    document.addEventListener('pointerdown', (e) => {
        for (const m of [importMenu, groupMenu]) {
            if (m && m.isOpen() && !m.contains(e.target) && !m.isAnchor(e.target)) m.hide({ restoreFocus: false });
        }
    }, true);
    window.addEventListener('blur', () => { importMenu?.hide({ restoreFocus: false }); groupMenu?.hide({ restoreFocus: false }); });
}

function toggleImportMenu(anchorEl) {
    if (!importMenu || !anchorEl || anchorEl.getAttribute('aria-disabled') === 'true') return;
    if (importMenu.isOpen() && importMenu.anchor() === anchorEl) importMenu.hide(); else importMenu.open(anchorEl, null);
}

function openGroupMenu(folder, anchorEl) {
    domRefs.groupMenu?.querySelector('[data-action="add-project-folder"]')?.classList.toggle('hidden', !projectsOn());
    if (groupMenu) groupMenu.open(anchorEl, folder);
}

// --- LUTs de projeto: "Adicionar a um projeto…" e "Usada em N projetos" ---

/** O módulo Projetos está ligado? Sem ele, "Adicionar a um projeto…" não aparece em lugar nenhum. */
function projectsOn() {
    return window.bdsIsScreenAllowed ? window.bdsIsScreenAllowed('projects') === true : true;
}

/** Mostra ou esconde as ações de projeto que são fixas na tela (a barra de seleção e o link do painel). */
function applyProjectActions() {
    const on = projectsOn();
    domRefs.btnSelAddProject?.classList.toggle('hidden', !on);
    if (!on) { domRefs.btnInsAddProject?.classList.add('hidden'); domRefs.insProjectsRow?.classList.add('hidden'); }
}

/**
 * Abre a escolha do projeto para as LUTs dadas (ou, com `folder`, para todas as LUTs da pasta, de qualquer nível).
 * O foco volta ao elemento de origem quando ele ainda está na tela; senão, a um cartão.
 */
function openProjectPicker(targets, { folder = null, returnTo = null } = {}) {
    if (!projectPicker || !projectsOn()) return;
    const restoreFocus = () => {
        if (returnTo && returnTo.isConnected && !returnTo.classList.contains('hidden')) returnTo.focus({ preventScroll: true });
        else focusCard(selection.anchor || selection.paths()[0] || null);
    };
    if (folder !== null) {
        const inFolder = luts.filter((l) => (l.folder || '') === folder || (l.folder || '').startsWith(`${folder}/`));
        if (!inFolder.length) { showNotice(`A pasta "${folderLabel(folder)}" não tem LUTs.`, 'warning', 5000); return; }
        projectPicker.open({
            relPaths: inFolder.map((l) => l.relPath),
            folders: [folder],
            names: inFolder.map((l) => l.displayName || l.name),
            label: `Todas as LUTs da pasta "${folderLabel(folder)}" (${plural(inFolder.length, 'LUT', 'LUTs')})`,
            restoreFocus
        });
        return;
    }
    const list = (Array.isArray(targets) ? targets : []).filter((l) => l && l.relPath);
    if (!list.length) return;
    projectPicker.open({ relPaths: list.map((l) => l.relPath), names: list.map((l) => l.displayName || l.name), restoreFocus });
}

/** Painel de detalhes: "Usada em N projetos" (consulta ao processo principal) e o link para adicionar a um projeto. */
async function updateUsageRow(lut) {
    const token = ++usageToken;
    const row = domRefs.insProjectsRow;
    const link = domRefs.btnInsAddProject;
    const on = !!lut && projectsOn();
    row?.classList.toggle('hidden', !on);
    link?.classList.toggle('hidden', !on || !!lut.invalidReason);
    if (!on) return;
    if (domRefs.insProjects) { domRefs.insProjects.textContent = '--'; domRefs.insProjects.removeAttribute('title'); }
    if (!window.bds || typeof window.bds.lutsUsage !== 'function' || !lut.relPath) return;
    try {
        const entries = await window.bds.lutsUsage([lut.relPath]);
        if (token !== usageToken) return;
        const used = Array.isArray(entries) ? entries.find((e) => e && e.relPath === lut.relPath) : null;
        const names = used ? used.projects.map((p) => p.name) : [];
        if (domRefs.insProjects) {
            domRefs.insProjects.textContent = used ? `Usada em ${plural(names.length, 'projeto', 'projetos')}` : 'Nenhum projeto';
            if (used) domRefs.insProjects.title = names.join(', ');
        }
    } catch (err) {
        if (token !== usageToken) return;
        console.warn('[LUTS] Não foi possível conferir os projetos que usam a LUT:', err);
        row?.classList.add('hidden');
    }
}

/**
 * Aviso antes de excluir: as LUTs do conjunto que estão em projetos e não têm cópia idêntica fora do conjunto aparecem
 * como "LUT ausente" nos projetos. O usuário decide (nada é bloqueado). Falha na consulta: sem aviso, a exclusão segue.
 * @param {{ relPaths?: string[], folders?: string[] }} request
 * @param {'single'|'selection'|'folder'} scope
 */
async function usageWarning(request, scope) {
    if (!window.bds || typeof window.bds.lutsUsage !== 'function') return '';
    let entries;
    try { entries = await window.bds.lutsUsage(request.relPaths || [], request.folders); } catch (err) {
        console.warn('[LUTS] Não foi possível conferir os projetos antes de excluir:', err);
        return '';
    }
    const hit = (Array.isArray(entries) ? entries : []).filter((e) => e && e.remainingCopies === 0 && Array.isArray(e.projects) && e.projects.length);
    if (!hit.length) return '';
    const projects = new Map();
    for (const e of hit) for (const p of e.projects) projects.set(p.id, p.name);
    const part = `${plural(projects.size, 'projeto', 'projetos')} (${listNames([...projects.values()], 3)})`;
    if (scope === 'single' && hit.length === 1) {
        return `Esta LUT é usada em ${part}. Nos projetos ela aparecerá como LUT ausente. Ela vai para a lixeira e pode ser recuperada.`;
    }
    const what = scope === 'folder'
        ? `${plural(hit.length, 'LUT desta pasta é usada', 'LUTs desta pasta são usadas')}`
        : `${plural(hit.length, 'LUT desta seleção é usada', 'LUTs desta seleção são usadas')}`;
    return `${what} em ${part}. Nos projetos ${hit.length === 1 ? 'ela aparecerá' : 'elas aparecerão'} como LUT ausente.${scope === 'folder' ? ' Elas ficam na lixeira e podem ser recuperadas.' : ''}`;
}

// --- Ações de pasta (grupo) ---

/**
 * "Selecionar as LUTs desta pasta": marca as LUTs do grupo (as que passam no filtro). Um grupo recolhido é aberto
 * para a pessoa ver o que ficou marcado.
 */
function selectFolderLuts(folder) {
    const inFolder = filteredLuts.filter((lut) => (lut.folder || '') === folder);
    if (!inFolder.length) {
        showNotice(`Nenhuma LUT da pasta "${folderLabel(folder)}" aparece com a busca ou o filtro atual.`, 'warning', 5000);
        return;
    }
    if (collapsedFolders.delete(folder)) {
        saveCollapsed(collapsedFolders);
        renderGrid();
    }
    mutateSelection(() => selection.replace(inFolder.map((lut) => lut.path), inFolder[0].path));
}

async function renameFolderAction(folder) {
    if (busyAction) return;
    if (!window.bds || typeof window.bds.renameLutFolder !== 'function') {
        showNotice('A renomeação de pastas não está disponível nesta versão.', 'danger');
        return;
    }
    busyAction = true;
    try {
        const current = folder.split('/').pop();
        const answer = await window.bdsModal.prompt(`Novo nome da pasta "${folderLabel(folder)}":`, current);
        const newName = (answer || '').trim();
        if (!newName || newName === current) return; // cancelou ou não mudou
        await window.bds.renameLutFolder(folder, newName);
        const parent = folder.split('/').slice(0, -1);
        remapCollapsed(collapsedFolders, folder, [...parent, newName].join('/'));
        saveCollapsed(collapsedFolders);
        await loadLuts({ silent: true }); // o caminho das LUTs da pasta mudou: a recarga tira da seleção as que não existem mais
        showNotice('Pasta renomeada.', 'success', 4000);
    } catch (err) {
        console.error('[LUTS] Erro ao renomear a pasta:', err);
        showNotice(`Erro ao renomear a pasta: ${errMsg(err)}`, 'danger');
    } finally {
        busyAction = false;
    }
}

async function deleteFolderAction(folder) {
    if (busyAction) return;
    if (!window.bds || typeof window.bds.deleteLutFolder !== 'function') {
        showNotice('A exclusão de pastas não está disponível nesta versão.', 'danger');
        return;
    }
    busyAction = true;
    try {
        const info = await window.bds.deleteLutFolder(folder, true); // só conta o que há, antes de perguntar
        const label = folderLabel(folder);
        if (!info || !info.luts) {
            showNotice(`A pasta "${label}" não tem LUTs para excluir.`, 'warning');
            return;
        }
        let message = `Mover ${plural(info.luts, 'LUT', 'LUTs')} da pasta "${label}" para a lixeira?`;
        if (info.others) {
            message += `\n\nA pasta tem também ${plural(info.others, 'outro item', 'outros itens')} que não ${info.others === 1 ? 'é' : 'são'} LUT: ${info.others === 1 ? 'ele fica' : 'eles ficam'} onde ${info.others === 1 ? 'está' : 'estão'} e a pasta não será removida.`;
        }
        const warning = await usageWarning({ folders: [folder] }, 'folder');
        if (warning) message += `\n\n${warning}`;
        const ok = await window.bdsModal.confirm(message);
        if (!ok) return;
        const res = await window.bds.deleteLutFolder(folder);
        await loadLuts({ silent: true }); // as LUTs que foram para a lixeira saem da seleção na recarga
        const lines = [`${plural(res.trashed, 'LUT movida', 'LUTs movidas')} para a lixeira.`];
        if (res.luts > res.trashed) lines.push(`${plural(res.luts - res.trashed, 'LUT não pôde', 'LUTs não puderam')} ser ${res.luts - res.trashed === 1 ? 'movida' : 'movidas'}.`);
        if (res.others) lines.push(`${plural(res.others, 'outro item ficou', 'outros itens ficaram')} na pasta.`);
        showNotice(lines.join('\n'), res.luts > res.trashed ? 'warning' : 'success', res.luts > res.trashed ? 0 : 5000);
    } catch (err) {
        console.error('[LUTS] Erro ao excluir a pasta:', err);
        showNotice(`Erro ao excluir a pasta: ${errMsg(err)}`, 'danger');
    } finally {
        busyAction = false;
    }
}

const DELETE_CHUNK = 500; // LUTs por chamada ao excluir em lote (o canal aceita até 5000; blocos dão andamento e respiro)
const DELETE_NAMES_SHOWN = 8;

/**
 * Move LUTs para a lixeira do sistema (recuperável). Uma LUT: pergunta pelo nome. Várias (seleção múltipla): UMA só
 * confirmação com a contagem e os primeiros nomes, envio em blocos e um resumo do que aconteceu; falha em uma LUT não
 * impede as outras.
 */
async function deleteLuts(list) {
    const targets = Array.isArray(list) ? list.filter(Boolean) : [];
    if (!targets.length || busyAction) return;
    const many = targets.length > 1;
    if (!window.bds || typeof window.bds[many ? 'deleteManyLuts' : 'deleteLut'] !== 'function') {
        showNotice('A exclusão de LUTs não está disponível nesta versão.', 'danger');
        return;
    }
    // Antes da janela de confirmação (que leva o foco): onde está o foco e qual cartão ocupa o primeiro lugar da seleção
    const restoreFocus = focusNeedsRestore();
    const focusIndex = Math.max(0, visibleCards().findIndex((card) => selection.has(card.dataset.path)));
    busyAction = true;
    try {
        // LUTs usadas em projetos: o aviso entra na própria confirmação (calculado sobre o conjunto inteiro); o usuário decide
        const warning = await usageWarning({ relPaths: targets.map((t) => t.relPath).filter(Boolean) }, many ? 'selection' : 'single');
        const question = many ? confirmDeleteMessage(targets) : `Mover "${targets[0].name}" para a lixeira?`;
        const ok = await window.bdsModal.confirm(warning ? `${question}\n\n${warning}` : question);
        if (!ok) return;
        if (many) await deleteMany(targets); else await deleteOne(targets[0]);
        if (restoreFocus) focusNearestCard(focusIndex);
    } catch (err) {
        console.error('[LUTS] Erro ao excluir:', err);
        showNotice(`Erro ao excluir: ${errMsg(err)}`, 'danger');
    } finally {
        busyAction = false;
    }
}

function confirmDeleteMessage(targets) {
    const shown = targets.slice(0, DELETE_NAMES_SHOWN).map((lut) => `• ${lut.name}`);
    const more = targets.length > shown.length ? `\ne mais ${targets.length - shown.length}` : '';
    return `Mover ${plural(targets.length, 'LUT', 'LUTs')} para a lixeira?\n\n${shown.join('\n')}${more}\n\nElas ficam na lixeira do sistema, de onde podem ser recuperadas.`;
}

async function deleteOne(lut) {
    const success = await window.bds.deleteLut(lut.path);
    await loadLuts({ silent: true }); // a LUT que foi para a lixeira sai da seleção na recarga
    showNotice(success ? `"${lut.name}" foi movida para a lixeira.` : `"${lut.name}" já não existe na pasta.`, success ? 'success' : 'warning', 5000);
}

async function deleteMany(targets) {
    const names = new Map(targets.map((lut) => [lut.path, lut.name]));
    const total = { trashed: 0, missing: 0, failed: [] };
    let stopped = null;
    for (let i = 0; i < targets.length; i += DELETE_CHUNK) {
        if (i > 0) showNotice(`Movendo para a lixeira… ${i} de ${targets.length}`, 'info');
        try {
            const res = await window.bds.deleteManyLuts(targets.slice(i, i + DELETE_CHUNK).map((lut) => lut.path));
            total.trashed += res?.trashed || 0;
            total.missing += res?.missing || 0;
            if (Array.isArray(res?.failed)) total.failed.push(...res.failed);
        } catch (err) {
            console.error('[LUTS] Erro ao excluir em lote:', err);
            stopped = errMsg(err); // o que já foi movido continua movido: a recarga e o resumo dizem quanto
            break;
        }
    }
    await loadLuts({ silent: true });
    showNotice(...deleteManySummary(total, names, stopped));
}

/** Resumo da exclusão em lote: "11 movidas", "1 já não existia", o que falhou e, se parou no meio, por quê. */
function deleteManySummary(total, names, stopped) {
    const lines = [];
    if (total.trashed) lines.push(`${plural(total.trashed, 'LUT movida', 'LUTs movidas')} para a lixeira.`);
    if (total.missing) lines.push(`${plural(total.missing, 'LUT já não existia', 'LUTs já não existiam')} na pasta.`);
    if (total.failed.length) {
        const items = total.failed.map((f) => `${names.get(f.path) || 'LUT'} (${f.reason})`);
        lines.push(`${plural(total.failed.length, 'LUT não pôde', 'LUTs não puderam')} ser ${total.failed.length === 1 ? 'movida' : 'movidas'}: ${listNames(items, 3)}.`);
    }
    if (stopped) lines.push(`A exclusão parou antes do fim: ${stopped}`);
    if (!lines.length) lines.push('Nenhuma LUT foi movida.');
    const clean = total.trashed && !total.failed.length && !stopped;
    const tone = clean ? 'success' : (total.trashed || total.missing ? 'warning' : 'danger');
    return [lines.join('\n'), tone, clean ? 6000 : 0];
}

/** O foco está na barra de ações, num cartão marcado ou em lugar nenhum? Esses lugares somem quando as LUTs são excluídas. */
function focusNeedsRestore() {
    const active = document.activeElement;
    if (!active || active === document.body) return true;
    if (domRefs.selectionBar?.contains(active)) return true;
    const cardEl = active.closest?.('.lut-card');
    return !!(cardEl && selection.has(cardEl.dataset.path));
}

/** Depois de excluir: o foco vai para o cartão que ocupa o lugar do primeiro excluído (ou, sem cartões, para "Importar LUT"). */
function focusNearestCard(index) {
    const cardsLeft = visibleCards();
    const target = cardsLeft[Math.min(index, cardsLeft.length - 1)] || domRefs.btnImport;
    try { target?.focus({ preventScroll: true }); } catch (_) { /* tela descartada */ }
}

async function renameLut(lut) {
    if (!lut || busyAction) return;
    if (!window.bds || typeof window.bds.renameLut !== 'function') {
        showNotice('A renomeação de LUTs não está disponível nesta versão.', 'danger');
        return;
    }
    busyAction = true;
    try {
        const current = lut.name.replace(/\.cube$/i, '');
        const answer = await window.bdsModal.prompt('Novo nome da LUT (sem a extensão .cube):', current);
        const newName = (answer || '').trim();
        if (!newName || newName === current) return; // cancelou ou não mudou

        const oldPaths = new Set(luts.map((l) => l.path));
        const success = await window.bds.renameLut(lut.path, newName);
        if (!success) { showNotice('A LUT não foi encontrada na pasta.', 'warning'); await loadLuts({ silent: true }); return; }
        await loadLuts({ silent: true });
        // O único caminho que não existia antes é o da LUT renomeada
        const renamed = luts.find((l) => !oldPaths.has(l.path));
        if (renamed) { selectLut(renamed); cardCache.get(renamed.path)?.scrollIntoView({ block: 'nearest' }); }
        else if (selectedLut && selectedLut.path === lut.path) selectLut(null);
        showNotice('LUT renomeada.', 'success', 4000);
    } catch (err) {
        console.error('[LUTS] Erro ao renomear:', err);
        showNotice(`Erro ao renomear: ${errMsg(err)}`, 'danger');
    } finally {
        busyAction = false;
    }
}

async function revealLut(lut) {
    if (!lut) return;
    try {
        await window.bds.revealLut(lut.path);
    } catch (err) {
        showNotice(`Não foi possível abrir a pasta: ${errMsg(err)}`, 'danger');
    }
}

/** Abre a pasta das LUTs no gerenciador de arquivos (também com a biblioteca vazia). */
async function openLutsFolder(relPath) {
    if (!window.bds || typeof window.bds.openLutsFolder !== 'function') {
        showNotice('Não foi possível abrir a pasta das LUTs nesta versão.', 'danger');
        return;
    }
    try {
        await window.bds.openLutsFolder(typeof relPath === 'string' ? relPath : undefined);
    } catch (err) {
        showNotice(errMsg(err) || 'Não foi possível abrir a pasta das LUTs.', 'danger');
    }
}

function openFullscreen() {
    if (!selectedLut || selectedLut.invalidReason) return; // LUT inválida não tem prévia para ampliar
    if (!domRefs.fsModal) {
        console.error('[LUTS] Elemento do modal fullscreen ausente.');
        return;
    }

    domRefs.fsLutName.textContent = selectedLut.name;

    const baseImgSrc = getBasePreviewImageUrl();
    if (domRefs.fsSliderBaseImg) domRefs.fsSliderBaseImg.src = baseImgSrc;

    // Se o canvas do slider principal já tem o preview, copia ou exibe o fsSliderCanvas
    if (domRefs.fsSliderCanvas) {
        domRefs.fsSliderCanvas.classList.remove('hidden');
        if (domRefs.fsSliderTargetImg) domRefs.fsSliderTargetImg.style.display = 'none';
    }

    // Reset slider position (usando referência segura)
    resetSlider('fullscreen');

    domRefs.fsModal.classList.remove('hidden');
    domRefs.fsModal.classList.add('active');
    domRefs.btnFsClose?.focus();
}

function closeFullscreen() {
    domRefs.fsModal?.classList.add('hidden');
    domRefs.fsModal?.classList.remove('active');
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}