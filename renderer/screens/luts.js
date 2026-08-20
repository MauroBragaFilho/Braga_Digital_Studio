// Importação com tratamento de erro (embora geralmente deva funcionar se o caminho estiver certo)
let escapeHtmlFunc;
try {
    // Certifique-se de que o caminho relativo está correto para a estrutura real
    // renderer/screens/luts.js -> renderer/app.js = ../app.js
    const { escapeHtml: importedEscapeHtml } = await import('../app.js');
    escapeHtmlFunc = importedEscapeHtml;
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

function getParsedLut(path) {
    if (!parsedLutCache.has(path)) {
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
        parsedLutCache.set(path, promise);
    }
    return parsedLutCache.get(path);
}

function getBasePreviewImageUrl() {
    try {
        const customImg = window.bds?.state?.settings?.lutPreviewImage;
        if (customImg && customImg.trim() !== '') {
            return `file://${customImg.replace(/\\/g, '/')}`;
        }
    } catch (_) {}
    return './assets/lut_preview.jpg';
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
function applyLutToCanvas(lutData, lutSize, sourceImg, targetCanvas) {
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
            btnApply: document.getElementById('btnSendLutToBDSM'),
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
        domRefs.btnImport?.addEventListener('click', importLut);
        domRefs.btnRefresh?.addEventListener('click', () => {
          // Opcional: Dar feedback visual ao usuário (icone girando, por exemplo)
          const btn = domRefs.btnRefresh;
          btn.classList.add('loading'); // Adiciona classe para animação
          loadLuts().finally(() => {
              btn.classList.remove('loading'); // Remove quando terminar
          });
        });
        domRefs.btnCloseInspector?.addEventListener('click', () => selectLut(null));

        domRefs.searchInput?.addEventListener('input', applyFilters);
        domRefs.typeFilter?.addEventListener('change', applyFilters);
        domRefs.sortFilter?.addEventListener('change', applyFilters);

        // Modos de Visualização
        document.getElementById('btnGridView')?.addEventListener('click', () => setViewMode('grid'));
        document.getElementById('btnListView')?.addEventListener('click', () => setViewMode('list'));
        document.getElementById('btnCompactView')?.addEventListener('click', () => setViewMode('compact'));

        // Inspector Actions
        domRefs.btnApply?.addEventListener('click', sendToBDSM);
        domRefs.btnDelete?.addEventListener('click', deleteLut);
        domRefs.btnRename?.addEventListener('click', renameLut);
        domRefs.btnFullscreen?.addEventListener('click', openFullscreen);

        // Evento de cópia de caminho (opcional, se for reativado)
        domRefs.inspector?.addEventListener('click', (e) => {
            if (e.target.classList.contains('inspector-copy-btn')) {
                const pathText = document.getElementById('insPath')?.textContent || '';
                if (pathText) {
                    navigator.clipboard.writeText(pathText).then(() => {
                        const btn = e.target;
                        const original = btn.textContent;
                        btn.textContent = 'check';
                        setTimeout(() => { btn.textContent = original; }, 2000);
                    }).catch(err => {
                         console.warn('[LUTS] Erro ao copiar caminho:', err);
                         // Opcional: alertar usuário
                     });
                }
            }
        });

        domRefs.btnFsClose?.addEventListener('click', () => { domRefs.fsModal?.classList.add('hidden'); });

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
    try {
        if (sliderInstances.main?.destroy) sliderInstances.main.destroy();
        if (sliderInstances.fullscreen?.destroy) sliderInstances.fullscreen.destroy();

        if (domRefs.sliderContainer && domRefs.sliderOverlay && domRefs.sliderDivider) {
            sliderInstances.main = setupSlider(domRefs.sliderContainer, domRefs.sliderOverlay, domRefs.sliderDivider);
        }
        if (domRefs.fsSliderContainer && domRefs.fsSliderOverlay && domRefs.fsSliderDivider) {
            sliderInstances.fullscreen = setupSlider(domRefs.fsSliderContainer, domRefs.fsSliderOverlay, domRefs.fsSliderDivider);
        }
    } catch (e) {
        console.error('[LUTS] Erro ao configurar sliders:', e);
        // Opcional: Desabilitar sliders no UI ou alertar, mas a tela pode continuar
    }


    // 5. Carrega LUTs
    await loadLuts(); // Chamada inicial

    // 6. ✅ CORREÇÃO (bug 5): como o app.js nunca desmonta telas já visitadas (apenas
    // esconde via classe 'hidden' e as mantém em cache no DOM), qualquer conteúdo pesado
    // que esta tela acumule (ex: o preview do arquivo .cube bruto, que pode ter até
    // RAW_CONTENT_MAX_BYTES de texto/nós) ficaria retido na memória indefinidamente,
    // mesmo com o usuário navegando para outras abas. Observamos a própria seção da tela
    // e, assim que ela for escondida, liberamos essa memória (fecha o modal e limpa o
    // conteúdo bruto). É reconstruído normalmente na próxima vez que o usuário abrir o
    // modal, então não há perda funcional.
    setupScreenHideCleanup();
}

function setupScreenHideCleanup() {
    const viewSection = document.getElementById('lutsView');
    if (!viewSection || typeof MutationObserver === 'undefined') return;

    const observer = new MutationObserver(() => {
        if (viewSection.classList.contains('hidden')) {
            closeCubeRawModal(); // já limpa domRefs.cubeRawContent
        }
    });

    observer.observe(viewSection, { attributes: true, attributeFilter: ['class'] });
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

async function loadLuts() {
  try {
    // Opcional: Limpar a lista antes de carregar (mostra loading)
    domRefs.lutsGrid.innerHTML = '<div class="luts-loading">Atualizando...</div>';
    domRefs.emptyState?.classList.add('hidden');

    console.log('[LUTS] Solicitando lista de LUTs ao backend...');
    luts = await window.bds.getLuts() || []; // Chama o backend
    console.log(`[LUTS] Backend retornou ${luts.length} LUTs.`);
    applyFilters(); // Aplica filtros e re-renderiza a grid
    console.log('[LUTS] Lista de LUTs atualizada na tela.');
  } catch (err) {
    console.error('[LUTS] Erro ao carregar LUTs no frontend:', err);
    // Opcional: Mostrar mensagem de erro na tela
    domRefs.lutsGrid.innerHTML = `<div class="luts-error">Erro ao carregar: ${err.message || 'Falha desconhecida'}</div>`;
    domRefs.emptyState?.classList.add('hidden');
    // Opcional: Alertar via bdsModal
    // window.bdsModal?.alert(`Erro ao carregar LUTs: ${err.message}`);
  }
}

function applyFilters() {
    const query = domRefs.searchInput?.value.toLowerCase() || '';
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
        if (type === '3d') matchesType = lut.type && lut.type.toLowerCase().includes('3d');
        if (type === '1d') matchesType = lut.type && lut.type.toLowerCase().includes('1d');
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

    domRefs.lutsGrid.innerHTML = '';

    if (!filteredLuts || filteredLuts.length === 0) {
        const emptyEl = domRefs.emptyState;
        if (emptyEl) {
            emptyEl.classList.remove('hidden');
            emptyEl.classList.add('active');
        }
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

    filteredLuts.forEach((lut) => {
        const isSelected = selectedLut && selectedLut.path === lut.path;

        const card = document.createElement('div');
        card.className = `lut-card ${isSelected ? 'selected' : ''} view-${currentViewMode}`;
        card.dataset.path = lut.path; // Para facilitar a seleção

        const dateObj = lut.modifiedAt ? new Date(lut.modifiedAt) : new Date();
        const dateStr = dateObj.toLocaleDateString('pt-BR');

        // ✅ CORREÇÃO: Função para renderizar o card (melhora legibilidade e segurança)
        card.innerHTML = renderLutCard(lut, dateStr);

        card.addEventListener('click', (e) => {
            if (e.target.closest('.lut-icon-btn')) {
                // Ações do menu "Mais opções" aqui, se necessário
                console.log('[LUTS] Clicado no botão de mais opções do card:', lut.name);
                return; // Não seleciona se clicar no botão
            }
            selectLut(lut); // Seleciona o LUT
        });

        domRefs.lutsGrid.appendChild(card);

        // Renderiza (ou reaproveita do cache) a miniatura REAL com a LUT aplicada
        const imgEl = card.querySelector('.lut-card-img');
        renderCardThumbnail(lut, imgEl);
    });
}

// ✅ Função separada para renderizar o card, usando escapeHtmlFunc
function renderLutCard(lut, dateStr) {
    const escapedName = escapeHtmlFunc(lut.name);
    const lutType = lut.type || '3D';
    // Enquanto a miniatura real (com a LUT aplicada) é gerada, mostra a imagem base "crua"
    return `
        <img src="./assets/lut_preview.jpg" class="lut-card-img lut-card-img-loading" onerror="this.style.display='none'">
        <span class="lut-badge-3d">${lutType}</span>
        <div class="lut-checkbox"><span class="material-symbols-rounded">check</span></div>

        <div class="lut-card-body">
            <div class="lut-card-info">
                <span class="lut-card-title" title="${escapedName}">${escapedName}</span>
                <div class="lut-card-meta">
                    <span>.cube</span>
                    <span>${dateStr}</span>
                </div>
            </div>
            <button class="lut-icon-btn lut-icon-btn-small" title="Mais opções">
                <span class="material-symbols-rounded">more_vert</span>
            </button>
        </div>
    `;
}

// Gera (ou reaproveita do cache) uma miniatura real do card aplicando a LUT .cube
// de fato sobre a imagem base, via Canvas offscreen — substitui o antigo filtro CSS mockado.
async function renderCardThumbnail(lut, imgEl) {
    if (!imgEl) return;

    const cached = thumbnailCache.get(lut.path);
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

        const offscreen = document.createElement('canvas');
        // applyLutToCanvas já limita as dimensões internamente (maxDim=640),
        // suficiente para uma miniatura nítida sem pesar na geração.
        applyLutToCanvas(parsed.data, parsed.size, sourceImg, offscreen);

        const dataUrl = offscreen.toDataURL('image/jpeg', 0.85);
        thumbnailCache.set(lut.path, dataUrl);

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
    selectedLut = lut;
    renderGrid(); // Atualiza seleção no grid
    updateInspector(); // Atualiza o painel lateral
}

// ✅ Função separada para atualizar o inspector, usando escapeHtmlFunc
function updateInspector() {
    const btnApply = domRefs.btnApply;
    const btnFullscreen = domRefs.btnFullscreen;
    const btnRename = domRefs.btnRename;
    const btnDelete = domRefs.btnDelete;

    if (!selectedLut) {
        const badgeEl = document.querySelector('.lut-badge-3d');
        if (badgeEl) {
            badgeEl.textContent = '--';
        }
        domRefs.ftSelected.textContent = '0 LUTs';
        document.getElementById('insName').textContent = 'Selecione um LUT';
        document.getElementById('insType').textContent = '--';
        document.getElementById('insSize').textContent = '--';
        document.getElementById('insRes').textContent = '--';
        document.getElementById('insDate').textContent = '--';

        // Esconder canvas de preview real e mostrar img padrão
        if (domRefs.sliderCanvas) domRefs.sliderCanvas.classList.add('hidden');
        if (domRefs.sliderTargetImg) domRefs.sliderTargetImg.style.display = '';
        if (domRefs.fsSliderCanvas) domRefs.fsSliderCanvas.classList.add('hidden');
        if (domRefs.fsSliderTargetImg) domRefs.fsSliderTargetImg.style.display = '';

        // Reset sliders
        if (domRefs.sliderOverlay && domRefs.sliderOverlay.style) domRefs.sliderOverlay.style.clipPath = 'inset(0 0 0 50%)';
        if (domRefs.fsSliderOverlay && domRefs.fsSliderOverlay.style) domRefs.fsSliderOverlay.style.clipPath = 'inset(0 0 0 50%)';

        if (btnApply) btnApply.disabled = true;
        if (btnFullscreen) btnFullscreen.disabled = true;
        if (btnRename) btnRename.disabled = true;
        if (btnDelete) btnDelete.disabled = true;

        if (domRefs.cubeSection) domRefs.cubeSection.style.display = 'none';
        return;
    }

    domRefs.ftSelected.textContent = '1 LUT';
    const dateObj = selectedLut.modifiedAt ? new Date(selectedLut.modifiedAt) : new Date();

    document.getElementById('insName').textContent = escapeHtmlFunc(selectedLut.name);
    document.getElementById('insType').textContent = selectedLut.type || '3D LUT';
    document.getElementById('insSize').textContent = formatBytes(selectedLut.size);
    document.getElementById('insRes').textContent = selectedLut.resolution || '--';
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

    if (btnApply) btnApply.disabled = false;
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
            applyLutToCanvas(parsed.data, parsed.size, sourceImg, canvas);
            canvas.classList.remove('hidden');
            if (targetImg) targetImg.style.display = 'none';

            // Também prepara para fullscreen se o canvas fullscreen existir
            if (domRefs.fsSliderCanvas) {
                applyLutToCanvas(parsed.data, parsed.size, sourceImg, domRefs.fsSliderCanvas);
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
        domRefs.cubeSection.style.display = 'none';
        return;
    }

    try {
        const header = await window.bds.getLutHeader(lut.path);

        // Se o usuário já trocou de LUT enquanto aguardávamos a resposta, ignora
        if (selectedLut !== requestedLut) return;

        if (domRefs.insTitle) domRefs.insTitle.textContent = header.title || '—';
        if (domRefs.insLutSize) domRefs.insLutSize.textContent = header.size ? `${header.size}³` : '—';

        // ✅ CORREÇÃO (bug 3): header.totalEntries agora reflete a contagem REAL de linhas
        // RGB válidas lidas do arquivo (não mais size³ assumido). Se divergir do valor
        // esperado, é sinal de arquivo truncado/corrompido — avisamos visualmente.
        if (domRefs.insLutEntries) {
            const expected = header.size ? header.size * header.size * header.size : null;
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

        domRefs.cubeSection.style.display = '';
    } catch (err) {
        console.error('[LUTS] Erro ao carregar cabeçalho do .cube:', err);
        if (selectedLut !== requestedLut) return;
        if (domRefs.insTitle) domRefs.insTitle.textContent = '—';
        if (domRefs.insLutEntries) domRefs.insLutEntries.textContent = 'Erro ao ler arquivo';
        if (domRefs.cubeRgbTable) {
            domRefs.cubeRgbTable.innerHTML = '<div class="cube-rgb-empty">Não foi possível ler este arquivo .cube.</div>';
        }
        domRefs.cubeSection.style.display = '';
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

async function importLut() {
  // 1. Verifica se o backend está disponível
  if (!window.bds || typeof window.bds.importLut !== 'function') {
    console.error('[LUTS] window.bds.importLut não está disponível.');
    // Opcional: Mostrar alerta amigável
    if (window.bdsModal) {
      window.bdsModal.alert(
        'Erro: A funcionalidade de importação de LUTs não está disponível.\n' +
        'Verifique se o sistema está inicializado corretamente.'
      );
    } else {
      alert('Erro: A funcionalidade de importação de LUTs não está disponível.');
    }
    return;
  }

  // 2. Executa a ação com try/catch completo
  try {
    console.log('[LUTS] Iniciando importação de LUT...');
    const success = await window.bds.importLut();
    console.log(`[LUTS] Importação concluída: ${success}`);

    if (success) {
      await loadLuts(); // Recarrega a lista
    } else {
      // O backend retornou false, mas não lançou erro
      console.warn('[LUTS] Importação foi cancelada ou falhou sem erro.');
      if (window.bdsModal) {
        window.bdsModal.alert('Importação cancelada ou falha silenciosa.');
      }
    }
  } catch (err) {
    console.error('[LUTS] Erro crítico ao importar LUT:', err);
    let errorMessage = 'Erro desconhecido.';
    if (err && typeof err.message === 'string') {
      errorMessage = err.message;
    } else if (err && typeof err === 'string') {
      errorMessage = err;
    }
    
    if (window.bdsModal) {
      window.bdsModal.alert(`Erro ao importar LUT:\n${errorMessage}`);
    } else {
      alert(`Erro ao importar LUT: ${errorMessage}`);
    }
  }
}

async function deleteLut() {
    if (!selectedLut) return;
    if (!window.bds || typeof window.bds.deleteLut !== 'function') {
        console.error('[LUTS] window.bds.deleteLut não está disponível.');
        if (window.bdsModal) window.bdsModal.alert('Erro: API de exclusão indisponível.');
        return;
    }

    let confirmDelete = false;
    if (window.bdsModal && window.bdsModal.confirm) {
         confirmDelete = await window.bdsModal.confirm(`Tem certeza que deseja excluir "${selectedLut.name}"?`);
    } else {
         confirmDelete = confirm(`Tem certeza que deseja excluir "${selectedLut.name}"?`);
    }

    if (!confirmDelete) return;

    try {
        const success = await window.bds.deleteLut(selectedLut.path);
        if (success) {
            selectedLut = null;
            await loadLuts(); // Recarrega após excluir
        }
    } catch (err) {
        console.error('[LUTS] Erro ao excluir LUT', err);
        if (window.bdsModal) window.bdsModal.alert('Erro ao excluir LUT: ' + err.message);
    }
}

async function renameLut() {
    if (!selectedLut) return;
    if (!window.bds || typeof window.bds.renameLut !== 'function') {
        console.error('[LUTS] window.bds.renameLut não está disponível.');
        if (window.bdsModal) window.bdsModal.alert('Erro: API de renomeação indisponível.');
        return;
    }

    let newName = "";
    if (window.bdsModal && window.bdsModal.prompt) {
         newName = await window.bdsModal.prompt('Digite o novo nome para o LUT (sem a extensão .cube):', selectedLut.name.replace('.cube', ''));
    } else {
         newName = prompt('Digite o novo nome para o LUT (sem a extensão .cube):', selectedLut.name.replace('.cube', ''));
    }

    if (!newName) return; // Cancelou

    if (newName.toLowerCase() === selectedLut.name.replace('.cube', '').toLowerCase()) return;

    try {
        const success = await window.bds.renameLut(selectedLut.path, newName);
        if (success) {
            selectedLut = null;
            await loadLuts(); // Recarrega após renomear
        }
    } catch (err) {
        console.error('[LUTS] Erro ao renomear LUT', err);
        if (window.bdsModal) window.bdsModal.alert('Erro ao renomear LUT: ' + err.message);
    }
}

function openFullscreen() {
    if (!selectedLut) return;
    if (!domRefs.fsModal) {
        console.error('[LUTS] Elemento do modal fullscreen ausente.');
        return;
    }

    domRefs.fsLutName.textContent = escapeHtmlFunc(selectedLut.name);

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
}

async function sendToBDSM() {
    if (!selectedLut) return;
    // Simula aplicacao por 1.5s ou chama API real (ex: window.bds.applyLutToBdsm(selectedLut.path))

    const btn = domRefs.btnApply;
    if (!btn) {
        console.error('[LUTS] Botão de aplicar LUT ausente.');
        return;
    }

    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-rounded">sync</span> APLICANDO...';
    btn.disabled = true;

    try {
        // Simula aplicacao por 1.5s
        await new Promise(resolve => setTimeout(resolve, 1500));
        // await window.bds.applyLutToBdsm(selectedLut.path); // Chamada real (exemplo)

        btn.innerHTML = '<span class="material-symbols-rounded">check</span> APLICADO!';
        setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.disabled = false;
        }, 2000);
    } catch (err) {
        console.error('[LUTS] Erro ao aplicar LUT', err);
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        if (window.bdsModal) window.bdsModal.alert('Erro ao aplicar LUT: ' + err.message);
    }
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}