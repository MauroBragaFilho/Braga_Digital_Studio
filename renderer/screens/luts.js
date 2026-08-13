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
            sliderTargetImg: document.getElementById('lutSliderTargetImg'),

            fsModal: document.getElementById('lutFullscreenModal'),
            fsSliderContainer: document.getElementById('fsSliderContainer'),
            fsSliderOverlay: document.getElementById('fsSliderOverlay'),
            fsSliderDivider: document.getElementById('fsSliderDivider'),
            fsSliderTargetImg: document.getElementById('fsSliderTargetImg'),
            fsLutName: document.getElementById('fsLutName'),
            btnFsClose: document.getElementById('btnFsClose'),
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

    } catch (e) {
        console.error('[LUTS] Erro ao adicionar eventos:', e);
        if (window.bdsModal) {
            window.bdsModal.alert('Erro interno: Falha ao configurar controles da interface. Verifique o console.');
        }
        return; // Sai da função
    }

    // 4. Setup Sliders com tratamento de erro
    try {
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
        if (!selectedLut) selectLut(null);
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

        // Filtro visual mockado
        const visualFilter = `hue-rotate(${lut.name.length * 10}deg) saturate(${100 + (lut.size % 50)}%)`;

        // ✅ CORREÇÃO: Função para renderizar o card (melhora legibilidade e segurança)
        card.innerHTML = renderLutCard(lut, dateStr, visualFilter);

        card.addEventListener('click', (e) => {
            if (e.target.closest('.lut-icon-btn')) {
                // Ações do menu "Mais opções" aqui, se necessário
                console.log('[LUTS] Clicado no botão de mais opções do card:', lut.name);
                return; // Não seleciona se clicar no botão
            }
            selectLut(lut); // Seleciona o LUT
        });

        domRefs.lutsGrid.appendChild(card);
    });
}

// ✅ Função separada para renderizar o card, usando escapeHtmlFunc
function renderLutCard(lut, dateStr, visualFilter) {
    const escapedName = escapeHtmlFunc(lut.name);
    const lutType = lut.type || '3D';
    return `
        <img src="./assets/lut_preview.jpg" class="lut-card-img" style="filter: ${visualFilter};" onerror="this.style.display='none'">
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
        const lutType = selectedLut.type || '3D';
        badgeEl.textContent = lutType.toUpperCase();
       } else {
        // Reseta o badge quando nenhum LUT está selecionado
        const badgeEl = document.querySelector('.lut-badge-3d');
        if (badgeEl) {
          badgeEl.textContent = '--'; // ou '3D' se preferir
        }
      }
        domRefs.ftSelected.textContent = '0 LUTs';
        document.getElementById('insName').textContent = 'Selecione um LUT';
        document.getElementById('insType').textContent = '--';
        document.getElementById('insSize').textContent = '--';
        document.getElementById('insRes').textContent = '--'; // ✅ Agora atualiza!
        document.getElementById('insDate').textContent = '--';
        // document.getElementById('insPath').textContent = '--'; // ✅ Removido

        // Reset sliders (usando uma referência segura)
        if (domRefs.sliderOverlay && domRefs.sliderOverlay.style) domRefs.sliderOverlay.style.clipPath = 'inset(0 0 0 50%)';
        if (domRefs.fsSliderOverlay && domRefs.fsSliderOverlay.style) domRefs.fsSliderOverlay.style.clipPath = 'inset(0 0 0 50%)';

        if (btnApply) btnApply.disabled = true;
        if (btnFullscreen) btnFullscreen.disabled = true;
        if (btnRename) btnRename.disabled = true;
        if (btnDelete) btnDelete.disabled = true;
        return;
    }

    domRefs.ftSelected.textContent = '1 LUT';
    const dateObj = selectedLut.modifiedAt ? new Date(selectedLut.modifiedAt) : new Date();

    // Usando escapeHtmlFunc para o nome
    document.getElementById('insName').textContent = escapeHtmlFunc(selectedLut.name);
    document.getElementById('insType').textContent = selectedLut.type || '3D LUT';
    document.getElementById('insSize').textContent = formatBytes(selectedLut.size);

    // ✅ CORREÇÃO: Preenche resolução se existir no objeto LUT
    document.getElementById('insRes').textContent = selectedLut.resolution || '--';

    document.getElementById('insDate').textContent =
        dateObj.toLocaleDateString('pt-BR') + ' ' +
        dateObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    // document.getElementById('insPath').textContent = selectedLut.path; // ✅ Removido

    // Aplica o filtro visual ao preview
    const hueRotation = (selectedLut.name.length * 10) % 360;
    const saturation = 100 + (selectedLut.size % 50);
    const visualFilter = `hue-rotate(${hueRotation}deg) saturate(${saturation}%)`;
    if (domRefs.sliderTargetImg && domRefs.sliderTargetImg.style) domRefs.sliderTargetImg.style.filter = visualFilter;
    if (domRefs.fsSliderTargetImg && domRefs.fsSliderTargetImg.style) domRefs.fsSliderTargetImg.style.filter = visualFilter;

    if (btnApply) btnApply.disabled = false;
    if (btnFullscreen) btnFullscreen.disabled = false;
    if (btnRename) btnRename.disabled = false;
    if (btnDelete) btnDelete.disabled = false;
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

    const hueRotation = (selectedLut.name.length * 10) % 360;
    const saturation = 100 + (selectedLut.size % 50);
    const visualFilter = `hue-rotate(${hueRotation}deg) saturate(${saturation}%)`;
    if (domRefs.fsSliderTargetImg && domRefs.fsSliderTargetImg.style) domRefs.fsSliderTargetImg.style.filter = visualFilter;

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