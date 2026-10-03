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
        // Opcional: Alertar o usuário via modal global
        if (window.bdsModal) {
             window.bdsModal.alert(`Erro Crítico: Recursos necessários ausentes (${missing.join(', ')}). A tela de LUTs não pode ser carregada. Verifique o console.`);
        } else {
            alert(`Erro Crítico: Recursos necessários ausentes (${missing.join(', ')}). A tela de LUTs não pode ser carregada. Verifique o console.`);
        }
        return false; // Indica falha
    }
    return true; // Todas as deps ok
}

let luts = [];
let filteredLuts = [];
let selectedLut = null;
let currentViewMode = 'grid'; // 'grid', 'list', 'compact'

// Referências DOM (inicializadas como null)
let domRefs = {};
let sliderInstances = {};

// Cache de imagem e dados de LUT para renderização Canvas
let cachedBaseImg = null;
let cachedBaseImgSrc = null;

// Cache dos dados parseados de cada .cube (evita reparsear o mesmo arquivo várias vezes)
const parsedLutCache = new Map(); // path -> Promise<{data, size} | null>
// Cache das miniaturas reais (data URL) já renderizadas para cada LUT
const thumbnailCache = new Map(); // path -> dataURL
const LUT_CACHE_MAX = 100; // LRU: Map preserva a ordem de inserção; o mais antigo sai primeiro

function lruSet(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > LUT_CACHE_MAX) map.delete(map.keys().next().value);
}

function lruGet(map, key) {
    if (!map.has(key)) return undefined;
    const value = map.get(key);
    map.delete(key);
    map.set(key, value); // marca como recém-usado
    return value;
}

function getParsedLut(path) {
    if (parsedLutCache.has(path)) return lruGet(parsedLutCache, path);
    {
        const promise = (window.bds?.parseLutCube ? window.bds.parseLutCube(path) : Promise.resolve(null))
            .then((result) => {
                if (!result) {
                    // Não guarda falha permanentemente: remove do cache para permitir
                    // uma nova tentativa na próxima seleção/renderização.
                    parsedLutCache.delete(path);
                }
                return result;
            })
            .catch((err) => {
                console.warn('[LUTS] Falha ao parsear LUT para thumbnail/preview:', path, err);
                parsedLutCache.delete(path);
                return null;
            });
        lruSet(parsedLutCache, path, promise);
    }
    return parsedLutCache.get(path);
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
 * Aplica uma LUT 3D nos pixels de uma imagem de referência desenhando num Canvas
 * @param {Array<Array<number>>} lutData - Array de pontos [R, G, B] (0.0 a 1.0)
 * @param {number} lutSize - Tamanho da LUT (ex: 17, 33, 64)
 * @param {HTMLImageElement} sourceImg - Imagem fonte
 * @param {HTMLCanvasElement} targetCanvas - Canvas destino
 */
function applyLutToCanvas(lutData, lutSize, sourceImg, targetCanvas, is1D) {
    if (!targetCanvas || !sourceImg || !lutData || !lutData.length || !lutSize) return;

    // LUT 1D (LUT_1D_SIZE): a curva é aplicada em cada canal de forma independente.
    if (is1D) {
        applyLut1DToCanvas(lutData, lutSize, sourceImg, targetCanvas);
        return;
    }

    const maxDim = 640;
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
    const pixels = imgData.data;
    const len = pixels.length;

    const size = lutSize;
    const maxIdx = size - 1;
    const sizeSq = size * size;

    for (let i = 0; i < len; i += 4) {
        const rNorm = (pixels[i] / 255) * maxIdx;
        const gNorm = (pixels[i + 1] / 255) * maxIdx;
        const bNorm = (pixels[i + 2] / 255) * maxIdx;

        const r0 = Math.floor(rNorm);
        const g0 = Math.floor(gNorm);
        const b0 = Math.floor(bNorm);

        const r1 = Math.min(r0 + 1, maxIdx);
        const g1 = Math.min(g0 + 1, maxIdx);
        const b1 = Math.min(b0 + 1, maxIdx);

        const rf = rNorm - r0;
        const gf = gNorm - g0;
        const bf = bNorm - b0;

        // Trilinear Interpolation
        // Índice .cube: index = r + g * size + b * size * size
        const idx000 = (r0 + g0 * size + b0 * sizeSq);
        const idx100 = (r1 + g0 * size + b0 * sizeSq);
        const idx010 = (r0 + g1 * size + b0 * sizeSq);
        const idx110 = (r1 + g1 * size + b0 * sizeSq);
        const idx001 = (r0 + g0 * size + b1 * sizeSq);
        const idx101 = (r1 + g0 * size + b1 * sizeSq);
        const idx011 = (r0 + g1 * size + b1 * sizeSq);
        const idx111 = (r1 + g1 * size + b1 * sizeSq);

        const c000 = lutData[idx000] || [0, 0, 0];
        const c100 = lutData[idx100] || c000;
        const c010 = lutData[idx010] || c000;
        const c110 = lutData[idx110] || c000;
        const c001 = lutData[idx001] || c000;
        const c101 = lutData[idx101] || c000;
        const c011 = lutData[idx011] || c000;
        const c111 = lutData[idx111] || c000;

        // Interpola R
        const r00 = c000[0] * (1 - rf) + c100[0] * rf;
        const r01 = c001[0] * (1 - rf) + c101[0] * rf;
        const r10 = c010[0] * (1 - rf) + c110[0] * rf;
        const r11 = c011[0] * (1 - rf) + c111[0] * rf;
        const r0_interp = r00 * (1 - gf) + r10 * gf;
        const r1_interp = r01 * (1 - gf) + r11 * gf;
        const finalR = r0_interp * (1 - bf) + r1_interp * bf;

        // Interpola G
        const g00 = c000[1] * (1 - rf) + c100[1] * rf;
        const g01 = c001[1] * (1 - rf) + c101[1] * rf;
        const g10 = c010[1] * (1 - rf) + c110[1] * rf;
        const g11 = c011[1] * (1 - rf) + c111[1] * rf;
        const g0_interp = g00 * (1 - gf) + g10 * gf;
        const g1_interp = g01 * (1 - gf) + g11 * gf;
        const finalG = g0_interp * (1 - bf) + g1_interp * bf;

        // Interpola B
        const b00 = c000[2] * (1 - rf) + c100[2] * rf;
        const b01 = c001[2] * (1 - rf) + c101[2] * rf;
        const b10 = c010[2] * (1 - rf) + c110[2] * rf;
        const b11 = c011[2] * (1 - rf) + c111[2] * rf;
        const b0_interp = b00 * (1 - gf) + b10 * gf;
        const b1_interp = b01 * (1 - gf) + b11 * gf;
        const finalB = b0_interp * (1 - bf) + b1_interp * bf;

        pixels[i] = Math.min(255, Math.max(0, Math.round(finalR * 255)));
        pixels[i + 1] = Math.min(255, Math.max(0, Math.round(finalG * 255)));
        pixels[i + 2] = Math.min(255, Math.max(0, Math.round(finalB * 255)));
    }

    ctx.putImageData(imgData, 0, 0);
}

/**
 * Aplica uma LUT 1D (.cube com LUT_1D_SIZE) nos pixels da imagem de referência.
 * Cada canal (R, G, B) é mapeado independentemente pela curva da LUT 1D.
 * @param {Array<Array<number>>} lutData - Array de pontos [R, G, B] (0.0 a 1.0)
 * @param {number} lutSize - Número de pontos da curva 1D (ex: 2, 256, 1024)
 * @param {HTMLImageElement} sourceImg - Imagem fonte
 * @param {HTMLCanvasElement} targetCanvas - Canvas destino
 */
function applyLut1DToCanvas(lutData, lutSize, sourceImg, targetCanvas) {
    if (!targetCanvas || !sourceImg || !lutData || !lutData.length || !lutSize) return;

    const maxDim = 640;
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
    const pixels = imgData.data;
    const len = pixels.length;

    const maxIdx = lutSize - 1;
    const table = lutData;

    for (let i = 0; i < len; i += 4) {
        for (let c = 0; c < 3; c++) {
            const t = (pixels[i + c] / 255) * maxIdx;
            const i0 = Math.floor(t);
            const i1 = Math.min(i0 + 1, maxIdx);
            const frac = t - i0;
            const row0 = table[i0] || [0, 0, 0];
            const row1 = table[i1] || row0;
            const v = row0[c] * (1 - frac) + row1[c] * frac;
            pixels[i + c] = Math.min(255, Math.max(0, Math.round(v * 255)));
        }
    }

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
            window.bdsModal.alert('Erro interno: Elementos da interface não encontrados. Verifique o console.');
        }
        return; // Sai da função
    }

    // 3. Adiciona Eventos com tratamento de erro
    try {
        domRefs.btnImport?.addEventListener('click', () => importLut());
        domRefs.btnEmptyImport?.addEventListener('click', () => importLut());
        domRefs.btnOpenFolder?.addEventListener('click', () => { if (luts[0]) revealLut(luts[0]); });
        domRefs.btnNoticeClose?.addEventListener('click', hideNotice);
        bindDragAndDrop();
        bindCardMenu();
        domRefs.btnRefresh?.addEventListener('click', () => {
          // Opcional: Dar feedback visual ao usuário (icone girando, por exemplo)
          const btn = domRefs.btnRefresh;
          btn.classList.add('loading'); // Adiciona classe para animação
          loadLuts().finally(() => {
              btn.classList.remove('loading'); // Remove quando terminar
          });
        });
        domRefs.btnCloseInspector?.addEventListener('click', () => selectLut(null));

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
        domRefs.btnDelete?.addEventListener('click', () => deleteLut(selectedLut));
        domRefs.btnRename?.addEventListener('click', () => renameLut(selectedLut));
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
            window.bdsModal.alert('Erro interno: Falha ao configurar controles da interface. Verifique o console.');
        }
        return; // Sai da função
    }

    // 4. Setup Sliders com tratamento de erro
    bindSliders();

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
    hideCardMenu();
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
}

/** Atalhos da tela (o app.js roteia o teclado para a tela ativa). */
export function onKeyDown(e) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '') || e.target?.isContentEditable;
    if (e.key === 'Escape') {
        if (!domRefs.cardMenu?.classList.contains('hidden')) { e.preventDefault(); hideCardMenu(); return; }
        if (domRefs.fsModal && !domRefs.fsModal.classList.contains('hidden')) { e.preventDefault(); closeFullscreen(); return; }
        if (domRefs.cubeRawModal && !domRefs.cubeRawModal.classList.contains('hidden')) { e.preventDefault(); closeCubeRawModal(); return; }
        return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return; // um diálogo (renomear/excluir) está aberto
    if (!selectedLut) return;
    if (e.key === 'Delete') { e.preventDefault(); deleteLut(selectedLut); }
    else if (e.key === 'F2') { e.preventDefault(); renameLut(selectedLut); }
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

function setupSlider(container, overlay, divider) {
    if (!container || !overlay || !divider) {
        console.error('[LUTS] Elementos do slider ausentes para setupSlider.');
        return { destroy: () => {} }; // Retorna um objeto vazio com método destroy
    }

    let isDragging = false;

    const onDrag = (e) => {
        if (!isDragging) return;
        e.preventDefault();

        const clientX = e.type.includes('mouse') ? e.clientX : e.touches[0]?.clientX;
        if (clientX === undefined) return; // Protege contra touch sem coordenadas

        const rect = container.getBoundingClientRect();
        if (!rect.width) return; // Protege contra erro se o container não estiver renderizado

        let x = clientX - rect.left;
        let percentage = (x / rect.width) * 100;

        if (percentage < 0) percentage = 0;
        if (percentage > 100) percentage = 100;

        // ✅ CORREÇÃO: Usando clip-path
        if (overlay.style) overlay.style.clipPath = `inset(0 0 0 ${percentage}%)`;
        if (divider.style) divider.style.left = `${percentage}%`;
    };

    const onMouseDown = () => isDragging = true;
    const onMouseUp = () => isDragging = false;

    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('touchstart', onMouseDown);

    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('touchend', onMouseUp);

    window.addEventListener('mousemove', onDrag);
    window.addEventListener('touchmove', onDrag);

    // Retorna função de cleanup se necessário
    return {
        destroy: () => {
            container.removeEventListener('mousedown', onMouseDown);
            container.removeEventListener('touchstart', onMouseDown);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('touchend', onMouseUp);
            window.removeEventListener('mousemove', onDrag);
            window.removeEventListener('touchmove', onDrag);
        }
    };
}

let loadedOnce = false;
let loadSeq = 0;

/** Assinatura de uma LUT: muda se o arquivo for substituído/editado (invalida miniatura e interpretação). */
function lutSignature(l) { return `${l.size}:${l.modifiedAt}:${l.id || ''}`; }

/**
 * Carrega a lista do disco. Com { silent: true } mantém os cartões na tela e só aplica as diferenças
 * (usado ao voltar para a tela e depois de importar/renomear/excluir).
 */
async function loadLuts({ silent = false } = {}) {
    const seq = ++loadSeq;
    try {
        if (!silent) {
            resetCards();
            domRefs.lutsGrid.innerHTML = '<div class="luts-loading" role="status">Carregando LUTs...</div>';
            domRefs.emptyState?.classList.add('hidden');
        }

        const fresh = (await window.bds.getLuts()) || [];
        if (seq !== loadSeq) return; // uma carga mais nova já foi pedida

        const before = new Map(luts.map((l) => [l.path, lutSignature(l)]));
        const sameList = before.size === fresh.length && fresh.every((l) => before.get(l.path) === lutSignature(l));
        if (silent && sameList) return; // nada mudou: não mexe na tela

        // Mantém o tipo (1D/3D) já descoberto; descarta caches de arquivos alterados ou removidos
        const known = new Map(luts.map((l) => [l.path, l]));
        const freshPaths = new Set(fresh.map((l) => l.path));
        for (const l of fresh) {
            const old = known.get(l.path);
            if (old && lutSignature(old) === lutSignature(l)) { l.type = old.type; continue; }
            if (old) dropLutCaches(l.path);
        }
        for (const path of known.keys()) {
            if (!freshPaths.has(path)) dropLutCaches(path);
        }

        luts = fresh;
        loadedOnce = true;
        lutByPath.clear();
        luts.forEach((l) => lutByPath.set(l.path, l));
        // Se o item selecionado ainda existe, aponta para o objeto novo
        if (selectedLut) selectedLut = lutByPath.get(selectedLut.path) || null;
        applyFilters();
        if (domRefs.btnOpenFolder) domRefs.btnOpenFolder.disabled = luts.length === 0;
    } catch (err) {
        console.error('[LUTS] Erro ao carregar LUTs:', err);
        if (silent) { showNotice(`Não foi possível atualizar a lista: ${errMsg(err)}`, 'danger'); return; }
        domRefs.lutsGrid.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'luts-error';
        box.setAttribute('role', 'alert');
        box.innerHTML = '<span class="luts-error-text"></span><button type="button" class="lut-btn-outline" data-action="retry">TENTAR NOVAMENTE</button>';
        box.querySelector('.luts-error-text').textContent = `Erro ao carregar as LUTs: ${errMsg(err)}`;
        domRefs.lutsGrid.appendChild(box);
        domRefs.emptyState?.classList.add('hidden');
    }
}

/** Esquece cartão, interpretação e miniatura de um arquivo (renomeado, substituído ou excluído). */
function dropLutCaches(path) {
    const card = cardCache.get(path);
    if (card) { card.remove(); cardCache.delete(path); }
    parsedLutCache.delete(path);
    thumbnailCache.delete(path);
}

/** Mensagem legível de um erro vindo do IPC (remove o prefixo "Error invoking remote method"). */
function errMsg(err) {
    const raw = typeof err === 'string' ? err : (err && err.message) || 'Falha desconhecida.';
    return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

function applyFilters() {
    const query = (domRefs.searchInput?.value || '').trim().toLowerCase();
    const type = domRefs.typeFilter?.value || 'all';
    const sort = domRefs.sortFilter?.value || 'recent';

    if (!luts) {
        console.warn('[LUTS] applyFilters chamado, mas luts não está definido.');
        filteredLuts = [];
        renderGrid();
        return;
    }

    filteredLuts = luts.filter(lut => {
        const matchesQuery = lut.name.toLowerCase().includes(query);
        let matchesType = true;
        // O tipo só é conhecido depois de interpretar o .cube (feito sob demanda); sem tipo, assume 3D
        if (type === '3d') matchesType = !lut.type || lut.type.toLowerCase().includes('3d');
        if (type === '1d') matchesType = !!lut.type && lut.type.toLowerCase().includes('1d');
        if (type === 'all') matchesType = true; // Permite todos se 'all'
        return matchesQuery && matchesType;
    });

    if (sort === 'name') {
        filteredLuts.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === 'size') {
        filteredLuts.sort((a, b) => b.size - a.size);
    } else { // recent (padrão)
        filteredLuts.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
    }

    if (type !== 'all') ensureLutTypes();

    // Se o selecionado nao esta no filtro, deseleciona
    if (selectedLut && !filteredLuts.find(l => l.path === selectedLut.path)) {
        selectLut(null);
    }

    renderGrid();
}

function renderGrid() {
    if (!domRefs.lutsGrid) {
        console.error('[LUTS] renderGrid chamado, mas domRefs.lutsGrid não está definido.');
        return;
    }

    // Remove placeholders ("Atualizando...", erros) que não são cards
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
        if (domRefs.emptyHint) domRefs.emptyHint.textContent = libraryEmpty ? 'Importe arquivos .cube ou arraste-os para esta tela.' : 'Limpe a busca ou escolha "Todos os tipos".';
        domRefs.btnEmptyImport?.classList.toggle('hidden', !libraryEmpty);
        domRefs.ftTotal.textContent = '0 LUTs';
        // ✅ CORREÇÃO (Maximum call stack size exceeded): antes chamava selectLut(null) aqui,
        // que por sua vez chama renderGrid() de volta — com a lista vazia e selectedLut já
        // null, isso formava uma recursão infinita entre renderGrid() <-> selectLut() e
        // estourava a pilha assim que a tela de LUTs abria sem nenhum arquivo .cube.
        // Agora apenas limpamos o estado e atualizamos o Inspector diretamente, sem
        // re-chamar renderGrid().
        if (selectedLut) {
            selectedLut = null;
            updateInspector();
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
    filteredLuts.forEach((lut) => {
        const card = getCard(lut);
        card.classList.remove('hidden');
        markSelected(card, !!(selectedLut && selectedLut.path === lut.path));
        shown.add(lut.path);
        frag.appendChild(card);
    });
    for (const [path, card] of cardCache) {
        if (shown.has(path)) continue;
        card.classList.add('hidden');
        frag.appendChild(card);
    }
    domRefs.lutsGrid.appendChild(frag);
}

// --- Cards reaproveitáveis, delegação de clique e miniaturas sob demanda ---
const cardCache = new Map();   // path -> elemento .lut-card
const lutByPath = new Map();   // path -> objeto lut
let thumbObserver = null;
const thumbQueue = [];
let thumbActive = 0;
const THUMB_CONCURRENCY = 2;
let searchDebounce = null;
let typeScanRunning = false;

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
        card.tabIndex = 0;
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
    if (fresh) {
        const imgEl = card.querySelector('.lut-card-img');
        const cached = lruGet(thumbnailCache, lut.path);
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

function bindGridDelegation() {
    const grid = domRefs.lutsGrid;
    if (!grid || grid.dataset.delegated) return;
    grid.dataset.delegated = '1';
    grid.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="retry"]')) { loadLuts(); return; }
        const card = e.target.closest('.lut-card');
        if (!card || !grid.contains(card)) return;
        const lut = lutByPath.get(card.dataset.path);
        if (!lut) return;
        if (e.target.closest('[data-action="menu"]')) {
            e.stopPropagation();
            const r = e.target.closest('[data-action="menu"]').getBoundingClientRect();
            selectLut(lut);
            openCardMenu(lut, r.right - 190, r.bottom);
            return;
        }
        selectLut(lut);
    });
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
        selectLut(lut);
        openCardMenu(lut, e.clientX, e.clientY);
    });
    grid.addEventListener('keydown', (e) => {
        const card = e.target.closest?.('.lut-card');
        if (!card || e.target !== card) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const lut = lutByPath.get(card.dataset.path);
            if (lut) selectLut(lut);
        } else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            const visible = Array.from(grid.querySelectorAll('.lut-card:not(.hidden)'));
            const i = visible.indexOf(card);
            const step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
            visible[Math.min(Math.max(i + step, 0), visible.length - 1)]?.focus();
        }
    });
}

function markSelected(card, on) {
    card.classList.toggle('selected', on);
    card.setAttribute('aria-selected', on ? 'true' : 'false');
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
let menuLut = null;
let menuBound = false;
function openCardMenu(lut, x, y) {
    const menu = domRefs.cardMenu;
    if (!menu) return;
    menuLut = lut;
    menu.classList.remove('hidden');
    const w = menu.offsetWidth || 200;
    const h = menu.offsetHeight || 130;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y + 4, window.innerHeight - h - 8))}px`;
    menu.querySelector('button')?.focus();
}
function hideCardMenu() {
    menuLut = null;
    domRefs.cardMenu?.classList.add('hidden');
}
function bindCardMenu() {
    if (menuBound || !domRefs.cardMenu) return;
    menuBound = true;
    domRefs.cardMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn || !menuLut) return;
        const lut = menuLut;
        hideCardMenu();
        if (btn.dataset.action === 'rename') renameLut(lut);
        else if (btn.dataset.action === 'reveal') revealLut(lut);
        else if (btn.dataset.action === 'delete') deleteLut(lut);
    });
    document.addEventListener('pointerdown', (e) => {
        if (!domRefs.cardMenu || domRefs.cardMenu.classList.contains('hidden')) return;
        if (!domRefs.cardMenu.contains(e.target)) hideCardMenu();
    }, true);
    window.addEventListener('blur', hideCardMenu);
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
        if (paths.length) importLut(paths);
    });
}

// Descobre o tipo (1D/3D) dos LUTs ainda não interpretados, em segundo plano (só com filtro de tipo ativo)
async function ensureLutTypes() {
    if (typeScanRunning) return;
    typeScanRunning = true;
    try {
        const pending = luts.filter((l) => !l.type);
        let changed = false;
        for (let i = 0; i < pending.length; i += THUMB_CONCURRENCY) {
            const batch = pending.slice(i, i + THUMB_CONCURRENCY);
            await Promise.all(batch.map(async (l) => {
                const parsed = await getParsedLut(l.path);
                if (parsed && parsed.size) { l.type = parsed.is1D ? 'LUT 1D' : 'LUT 3D'; changed = true; }
            }));
            await idleYield();
        }
        if (changed && (domRefs.typeFilter?.value || 'all') !== 'all') applyFiltersSoon();
    } finally {
        typeScanRunning = false;
    }
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
    const lutType = lut.type || '3D';
    // Enquanto a miniatura real (com a LUT aplicada) é gerada, mostra a imagem base "crua"
    return `
        <img src="${DEFAULT_BASE_IMAGE}" class="lut-card-img lut-card-img-loading" alt="" draggable="false">
        <span class="lut-badge-3d">${escapeHtmlFunc(lutType)}</span>
        <div class="lut-checkbox"><span class="material-symbols-rounded">check</span></div>

        <div class="lut-card-body">
            <div class="lut-card-info">
                <span class="lut-card-title" title="${escapedName}">${escapedName}</span>
                <div class="lut-card-meta">
                    <span>.cube</span>
                    <span>${dateStr}</span>
                </div>
            </div>
            <button type="button" class="lut-icon-btn lut-icon-btn-small" data-action="menu" title="Mais opções" aria-label="Mais opções de ${escapedName}" aria-haspopup="menu">
                <span class="material-symbols-rounded">more_vert</span>
            </button>
        </div>
    `;
}

// Gera (ou reaproveita do cache) uma miniatura real do card aplicando a LUT .cube
// de fato sobre a imagem base, via Canvas offscreen — substitui o antigo filtro CSS mockado.
async function renderCardThumbnail(lut, imgEl) {
    if (!imgEl) return;

    const cached = lruGet(thumbnailCache, lut.path);
    if (cached) {
        imgEl.src = cached;
        imgEl.classList.remove('lut-card-img-loading');
        return;
    }

    try {
        const baseImgSrc = getBasePreviewImageUrl();
        const [sourceImg, parsed] = await Promise.all([
            loadBaseImage(baseImgSrc),
            getParsedLut(lut.path)
        ]);

        if (!parsed || !parsed.data || !parsed.size) return; // mantém a imagem base como fallback

        // Corrige o tipo (1D/3D) exibido no card e habilita o filtro por tipo
        lut.type = parsed.is1D ? 'LUT 1D' : 'LUT 3D';
        const badgeEl = imgEl.closest('.lut-card')?.querySelector('.lut-badge-3d');
        if (badgeEl) badgeEl.textContent = lut.type;

        await idleYield(); // cede a thread antes do trabalho pesado de pixels
        if (!imgEl.isConnected) return;
        const offscreen = document.createElement('canvas');
        // applyLutToCanvas já limita as dimensões internamente (maxDim=640),
        // suficiente para uma miniatura nítida sem pesar na geração.
        applyLutToCanvas(parsed.data, parsed.size, sourceImg, offscreen, parsed.is1D);

        const dataUrl = offscreen.toDataURL('image/jpeg', 0.85);
        lruSet(thumbnailCache, lut.path, dataUrl);

        // Só aplica se o elemento ainda estiver na tela apontando para o mesmo LUT
        if (imgEl.isConnected) {
            imgEl.src = dataUrl;
            imgEl.classList.remove('lut-card-img-loading');
        }
    } catch (err) {
        console.warn('[LUTS] Falha ao gerar miniatura real para', lut.name, err);
        // Mantém a imagem base visível em caso de erro
    }
}


function selectLut(lut) {
    const previous = selectedLut;
    selectedLut = lut;
    // Só alterna a classe nos dois cards afetados (sem reconstruir a grade)
    if (previous) { const c = cardCache.get(previous.path); if (c) markSelected(c, false); }
    if (lut) { const c = cardCache.get(lut.path); if (c) markSelected(c, true); }
    updateInspector(); // Atualiza o painel lateral
}

// ✅ Função separada para atualizar o inspector, usando escapeHtmlFunc
function updateInspector() {
    const btnReveal = domRefs.btnReveal;
    const btnFullscreen = domRefs.btnFullscreen;
    const btnRename = domRefs.btnRename;
    const btnDelete = domRefs.btnDelete;

    if (!selectedLut) {
        const badgeEl = document.getElementById('insBadge');
        if (badgeEl) badgeEl.textContent = '--';
        domRefs.ftSelected.textContent = '0 LUTs';
        document.getElementById('insName').textContent = 'Selecione um LUT';
        document.getElementById('insType').textContent = '--';
        document.getElementById('insSize').textContent = '--';
        const insResEl = document.getElementById('insRes');
        if (insResEl) insResEl.textContent = '--';
        document.getElementById('insDate').textContent = '--';

        // Esconder canvas de preview real e mostrar img padrão
        if (domRefs.sliderCanvas) domRefs.sliderCanvas.classList.add('hidden');
        if (domRefs.sliderTargetImg) domRefs.sliderTargetImg.style.display = '';
        if (domRefs.fsSliderCanvas) domRefs.fsSliderCanvas.classList.add('hidden');
        if (domRefs.fsSliderTargetImg) domRefs.fsSliderTargetImg.style.display = '';

        // Reset sliders
        if (domRefs.sliderOverlay && domRefs.sliderOverlay.style) domRefs.sliderOverlay.style.clipPath = 'inset(0 0 0 50%)';
        if (domRefs.fsSliderOverlay && domRefs.fsSliderOverlay.style) domRefs.fsSliderOverlay.style.clipPath = 'inset(0 0 0 50%)';

        if (btnReveal) btnReveal.disabled = true;
        if (btnFullscreen) btnFullscreen.disabled = true;
        if (btnRename) btnRename.disabled = true;
        if (btnDelete) btnDelete.disabled = true;

        if (domRefs.cubeSection) domRefs.cubeSection.classList.add('hidden');
        return;
    }

    domRefs.ftSelected.textContent = '1 LUT';
    const dateObj = selectedLut.modifiedAt ? new Date(selectedLut.modifiedAt) : new Date();

    document.getElementById('insName').textContent = selectedLut.name;
    const insBadge = document.getElementById('insBadge');
    if (insBadge) insBadge.textContent = selectedLut.type || '3D LUT';
    document.getElementById('insType').textContent = selectedLut.type || '3D LUT';
    document.getElementById('insSize').textContent = formatBytes(selectedLut.size);
    const insResEl = document.getElementById('insRes');
    if (insResEl) insResEl.textContent = selectedLut.resolution || '--';
    document.getElementById('insDate').textContent =
        dateObj.toLocaleDateString('pt-BR') + ' ' +
        dateObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

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
        const [sourceImg, parsed] = await Promise.all([
            loadBaseImage(baseImgSrc),
            getParsedLut(lut.path)
        ]);

        if (renderToken !== currentRenderToken || selectedLut !== lut) return;

        if (parsed && parsed.data && parsed.size) {
            applyLutToCanvas(parsed.data, parsed.size, sourceImg, canvas, parsed.is1D);
            canvas.classList.remove('hidden');
            if (targetImg) targetImg.style.display = 'none';

            // Também prepara para fullscreen se o canvas fullscreen existir
            if (domRefs.fsSliderCanvas) {
                applyLutToCanvas(parsed.data, parsed.size, sourceImg, domRefs.fsSliderCanvas, parsed.is1D);
            }
        } else {
            console.warn('[LUTS] Não foi possível obter dados parseados da LUT para preview real:', lut.path, parsed);
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
            const countLabel = header.totalEntries != null ? header.totalEntries.toLocaleString('pt-BR') : '—';
            if (expected != null && header.totalEntries !== expected) {
                domRefs.insLutEntries.textContent = `${countLabel} (esperado: ${expected.toLocaleString('pt-BR')}) ⚠️`;
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
            } else {
                domRefs.insLutDomain.textContent = '0.0 – 1.0 (padrão)';
            }
        }

        renderCubeRgbTable(header.preview || []);

        domRefs.cubeSection.classList.remove('hidden');
    } catch (err) {
        console.error('[LUTS] Erro ao carregar cabeçalho do .cube:', err);
        if (selectedLut !== requestedLut) return;
        if (domRefs.insTitle) domRefs.insTitle.textContent = '—';
        if (domRefs.insLutEntries) domRefs.insLutEntries.textContent = 'Erro ao ler arquivo';
        if (domRefs.cubeRgbTable) {
            domRefs.cubeRgbTable.innerHTML = '<div class="cube-rgb-empty">Não foi possível ler este arquivo .cube.</div>';
        }
        domRefs.cubeSection.classList.remove('hidden');
    }
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
        domRefs.cubeRawModalTitle.textContent = escapeHtmlFunc(selectedLut.name);
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
        notice.textContent = `⚠️ Arquivo grande (${sizeLabel}). Mostrando apenas o início do conteúdo para evitar travamentos.`;
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

let importing = false;
let busyAction = false; // evita abrir dois diálogos (ex.: Delete repetido)

function listNames(items, max = 4) {
    const shown = items.slice(0, max).join(', ');
    return items.length > max ? `${shown} e mais ${items.length - max}` : shown;
}

/** Importa .cube pelo seletor de arquivos (sem argumento) ou pelos caminhos soltos na tela. */
async function importLut(droppedPaths) {
    if (importing) return;
    if (!window.bds || typeof window.bds.importLut !== 'function') {
        showNotice('A importação de LUTs não está disponível nesta versão.', 'danger');
        return;
    }
    importing = true;
    domRefs.btnImport?.setAttribute('disabled', '');
    try {
        const res = await window.bds.importLut(Array.isArray(droppedPaths) ? droppedPaths : undefined);
        if (!res) return; // o usuário fechou o seletor: não é erro

        const imported = res.imported || [];
        const renamed = res.renamed || [];
        const duplicates = res.duplicates || [];
        const invalid = res.invalid || [];
        await loadLuts({ silent: true });

        const lines = [];
        if (imported.length) lines.push(`${imported.length} LUT${imported.length > 1 ? 's importadas' : ' importada'}.`);
        if (renamed.length) lines.push(`Já existia outra com o mesmo nome; salva como: ${listNames(renamed.map((r) => r.to))}.`);
        if (duplicates.length) lines.push(`Já estava na biblioteca (conteúdo idêntico): ${listNames(duplicates)}.`);
        if (invalid.length) lines.push(`Recusada${invalid.length > 1 ? 's' : ''}: ${listNames(invalid.map((i) => `${i.name} (${i.reason})`), 3)}.`);
        if (!lines.length) lines.push('Nenhum arquivo para importar.');
        const tone = imported.length && !invalid.length ? 'success' : (imported.length || duplicates.length ? 'warning' : 'danger');
        showNotice(lines.join('\n'), tone, tone === 'success' ? 6000 : 0);

        // Seleciona (e mostra) a primeira LUT importada
        const first = imported[0] && lutByPath.get(imported[0].path);
        if (first) {
            if (domRefs.searchInput?.value) { domRefs.searchInput.value = ''; }
            if (domRefs.typeFilter) domRefs.typeFilter.value = 'all';
            applyFilters();
            selectLut(first);
            cardCache.get(first.path)?.scrollIntoView({ block: 'nearest' });
        }
    } catch (err) {
        console.error('[LUTS] Erro ao importar:', err);
        showNotice(`Erro ao importar: ${errMsg(err)}`, 'danger');
    } finally {
        importing = false;
        domRefs.btnImport?.removeAttribute('disabled');
    }
}

/** Move a LUT para a lixeira do sistema (recuperável). */
async function deleteLut(lut) {
    if (!lut || busyAction) return;
    if (!window.bds || typeof window.bds.deleteLut !== 'function') {
        showNotice('A exclusão de LUTs não está disponível nesta versão.', 'danger');
        return;
    }
    busyAction = true;
    try {
        const ok = await window.bdsModal.confirm(`Mover "${lut.name}" para a lixeira?`);
        if (!ok) return;
        const success = await window.bds.deleteLut(lut.path);
        if (selectedLut && selectedLut.path === lut.path) selectLut(null);
        await loadLuts({ silent: true });
        showNotice(success ? `"${lut.name}" foi movida para a lixeira.` : `"${lut.name}" já não existe na pasta.`, success ? 'success' : 'warning', 5000);
    } catch (err) {
        console.error('[LUTS] Erro ao excluir:', err);
        showNotice(`Erro ao excluir: ${errMsg(err)}`, 'danger');
    } finally {
        busyAction = false;
    }
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

function openFullscreen() {
    if (!selectedLut) return;
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
    if (domRefs.fsSliderOverlay && domRefs.fsSliderOverlay.style) domRefs.fsSliderOverlay.style.clipPath = 'inset(0 0 0 50%)';

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