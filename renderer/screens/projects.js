import { els, setAppStatus } from '../app.js';
import { escapeHtml } from '../utils/escape.js';
import { enhanceModals } from '../utils/modal.js';
import { friendlyError } from '../utils/friendlyError.js';
import { daysUntilLocal, formatLocalDate } from '../utils/localDate.js';
import { toFileUrl } from '../utils/fileUrl.js';

/** Só aceita cor hexadecimal (#rgb, #rgba, #rrggbb, #rrggbbaa); qualquer outra coisa vira o padrão. */
function safeHexColor(value, fallback = '#3b82f6') {
    return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ? value : fallback;
}

/** Os diálogos devolvem string, array de caminhos ou { filePaths }: normaliza para o 1º caminho (ou null). */
function firstDialogPath(res) {
    if (!res) return null;
    if (typeof res === 'string') return res;
    const list = Array.isArray(res) ? res : (res.canceled ? [] : res.filePaths);
    return Array.isArray(list) && list.length > 0 ? list[0] : null;
}


let projectsList = [];
let selectedProjectId = null;

export function initScreen() {
    loadProjects();
    setupEventListeners();
    enhanceModals(document.getElementById('projectsView') || document, '.proj-modal-overlay');
}

function formatBytes(bytes) {
    if (bytes === 0 || !bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Datas 'YYYY-MM-DD' são dias de calendário: o parse como data local fica em utils/localDate.js
function formatDate(isoStr) {
    return formatLocalDate(isoStr);
}

function getDeadlinePill(deadlineStr) {
    if (!deadlineStr) return { text: 'Sem Prazo', color: '#bdbdbd', icon: 'schedule' };

    const diffDays = daysUntilLocal(deadlineStr);
    if (diffDays === null) return { text: 'Sem Prazo', color: '#bdbdbd', icon: 'schedule' };

    if (diffDays < 0) {
        return { text: `${Math.abs(diffDays)} dias atrasado`, color: '#f44336', icon: 'error' }; // 🔴 Vermelho (Atrasado)
    } else if (diffDays === 0) {
        return { text: 'Hoje', color: '#f44336', icon: 'warning' }; // 🔴 Vermelho
    } else if (diffDays === 1) {
        return { text: 'Amanhã', color: '#ff9800', icon: 'warning' }; // 🟠 Laranja
    } else if (diffDays <= 5) {
        return { text: `${diffDays} dias`, color: '#ffc107', icon: 'schedule' }; // 🟡 Amarelo
    } else {
        return { text: `${diffDays} dias`, color: '#4caf50', icon: 'check_circle' }; // 🟢 Verde
    }
}

async function loadProjects() {
    try {
        const grid = document.getElementById('projectsGrid');
        if (grid && projectsList.length === 0) {
            // Primeira carga: esqueletos no lugar da grade (substituídos por renderGrid)
            grid.setAttribute('aria-busy', 'true');
            grid.innerHTML = '<div class="proj-card bds-skeleton" aria-hidden="true"></div>'.repeat(3);
        }
        projectsList = await window.bds.listProjects();
        renderGrid();
    } catch (e) {
        console.error('Erro ao listar projetos', e);
        setAppStatus('Erro ao carregar projetos', 'error');
    }
}

function renderGrid() {
    const grid = document.getElementById('projectsGrid');
    if (!grid) return;
    
    grid.innerHTML = '';
    grid.removeAttribute('aria-busy');
    bindGridDelegation();
    
    if (projectsList.length === 0) {
        grid.innerHTML = '<div class="proj-empty-state bds-empty" role="status"><span class="material-symbols-rounded bds-empty-icon" aria-hidden="true">create_new_folder</span>'
            + '<strong class="bds-empty-title">Nenhum projeto ainda</strong>'
            + '<span class="bds-empty-text">Projetos reúnem os arquivos de um trabalho (vídeos, áudios, fotos e prazos) em um só lugar.</span>'
            + '<button type="button" class="bds-empty-action" data-empty-action="new-project">Criar primeiro projeto</button></div>';
        return;
    }
    
    projectsList.forEach(proj => {
        const pill = getDeadlinePill(proj.deadline);
        const displayCount = proj.media_count || 0;
        const displaySize = formatBytes(proj.total_size);
        
        // Cor do gradiente baseada na cor do projeto
        const bgColor = safeHexColor(proj.color);
        
        const card = document.createElement('div');
        card.className = `proj-card ${selectedProjectId === proj.id ? 'selected' : ''}`;
        card.dataset.id = String(proj.id);
        card.innerHTML = `
            <div class="proj-card-cover">
                <div class="proj-card-cover-gradient"></div>
                <div class="proj-card-pill">
                    <span class="proj-card-pill-dot" aria-hidden="true">●</span> ${pill.text}
                </div>
            </div>
            <div class="proj-card-info">
                <h4 class="proj-card-title" title="${escapeHtml(proj.name)}">${escapeHtml(proj.name)}</h4>
                <div class="proj-card-dates">
                    <span>📅 Início: ${formatDate(proj.start_date)}</span>
                    <span>🎯 Entrega: ${formatDate(proj.deadline)}</span>
                </div>
                <div class="proj-card-stats">
                    <span title="Vídeos"><span class="material-symbols-rounded">movie</span> ${displayCount} mídias</span>
                    <span title="Espaço"><span class="material-symbols-rounded">hard_drive</span> ${displaySize}</span>
                </div>
            </div>
        `;
        
        // Valores dinâmicos (capa, cores) via setters DOM: nada de string interpolada em style=
        const cover = card.querySelector('.proj-card-cover');
        if (cover && proj.cover_path) cover.style.backgroundImage = `url(${JSON.stringify(toFileUrl(proj.cover_path))})`;
        const gradient = card.querySelector('.proj-card-cover-gradient');
        if (gradient) gradient.style.background = `linear-gradient(0deg, ${bgColor}33 0%, transparent 100%)`;
        const info = card.querySelector('.proj-card-info');
        if (info) info.style.background = `linear-gradient(180deg, transparent 0%, ${bgColor}11 100%)`;
        const dot = card.querySelector('.proj-card-pill-dot');
        if (dot) dot.style.color = pill.color; // constante interna de getDeadlinePill (não vem de dados do usuário)

        grid.appendChild(card);
    });
}

// Delegação única no grid (cliques/duplo clique) em vez de dois listeners por cartão
function bindGridDelegation() {
    const grid = document.getElementById('projectsGrid');
    if (!grid || grid.dataset.delegated) return;
    grid.dataset.delegated = '1';
    const idOf = (e) => {
        const card = e.target.closest('.proj-card');
        return card && grid.contains(card) ? Number(card.dataset.id) : null;
    };
    grid.addEventListener('click', (e) => {
        if (e.target.closest('[data-empty-action="new-project"]')) { document.getElementById('btnNewProject')?.click(); return; }
        const id = idOf(e); if (id !== null) selectProject(id); });
    grid.addEventListener('dblclick', (e) => { const id = idOf(e); if (id !== null) openProjectWorkspace(id); });
}

/** Atualiza só o destaque de seleção (cartão anterior e novo), sem reconstruir a grade. */
function updateCardSelection() {
    const grid = document.getElementById('projectsGrid');
    if (!grid) return;
    grid.querySelector('.proj-card.selected')?.classList.remove('selected');
    if (selectedProjectId !== null) {
        grid.querySelector(`.proj-card[data-id="${CSS.escape(String(selectedProjectId))}"]`)?.classList.add('selected');
    }
}

function selectProject(id) {
    selectedProjectId = id;
    updateCardSelection(); // update selection highlight
    
    const proj = projectsList.find(p => p.id === id);
    if (!proj) return;
    
    const inspector = document.getElementById('projectInspector');
    if (inspector) {
        inspector.classList.add('open');
        
        // Popula inspector
        const coverEl = document.getElementById('inspectorProjCover');
        coverEl.style.backgroundImage = proj.cover_path ? `url('file:///${proj.cover_path.replace(/\\/g, '/')}')` : 'none';
        
        document.getElementById('inspectorProjName').textContent = proj.name;
        document.getElementById('inspectorProjColor').value = proj.color || '#3b82f6';
        document.getElementById('inspectorProjStatus').textContent = proj.status || 'Ativo';
        document.getElementById('inspectorProjClient').textContent = proj.client || '-';
        document.getElementById('inspectorProjType').textContent = proj.type || '-';
        document.getElementById('inspectorProjStart').textContent = formatDate(proj.start_date);
        document.getElementById('inspectorProjDeadline').textContent = formatDate(proj.deadline);
        document.getElementById('inspectorProjCount').textContent = proj.media_count || 0;
        document.getElementById('inspectorProjSize').textContent = formatBytes(proj.total_size);
    }
}

/** ESC fecha o inspector de projetos (roteado pelo despachante central do app.js). */
export function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    // Ignora se estiver editando um campo de texto ou com modal aberto
    const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (document.querySelector('.proj-modal-overlay.open')) return;
    const inspector = document.getElementById('projectInspector');
    if (inspector && inspector.classList.contains('open')) {
        inspector.classList.remove('open');
        selectedProjectId = null;
        updateCardSelection();
    }
}

// Sem listeners globais próprios: onLeave/onEnter apenas atualizam a lista ao voltar
export function onLeave() {}

export function onEnter() {
    loadProjects();
}

function setupEventListeners() {
    document.getElementById('btnNewProject')?.addEventListener('click', () => {
        document.getElementById('modalProjectTitle').textContent = 'Novo Projeto';
        document.getElementById('projFormId').value = '';
        document.getElementById('projFormName').value = '';
        document.getElementById('projFormClient').value = '';
        document.getElementById('projFormType').value = '';
        document.getElementById('projFormStart').value = '';
        document.getElementById('projFormDeadline').value = '';
        document.getElementById('projFormStatus').value = 'Ativo';
        document.getElementById('projFormColor').value = '#3b82f6';
        document.getElementById('modalProjectForm').classList.add('open');
    });
    
    document.getElementById('btnCancelProjForm')?.addEventListener('click', () => {
        document.getElementById('modalProjectForm').classList.remove('open');
    });
    
    document.getElementById('btnSaveProjForm')?.addEventListener('click', async () => {
        const id = document.getElementById('projFormId').value;
        const data = {
            name: document.getElementById('projFormName').value,
            client: document.getElementById('projFormClient').value,
            type: document.getElementById('projFormType').value,
            start_date: document.getElementById('projFormStart').value || null,
            deadline: document.getElementById('projFormDeadline').value || null,
            status: document.getElementById('projFormStatus').value,
            color: document.getElementById('projFormColor').value
        };
        
        if (!data.name) return window.bdsModal.alert('O nome do projeto é obrigatório.');
        
        try {
            if (id) {
                await window.bds.updateProject(Number(id), data);
                setAppStatus('Projeto atualizado com sucesso');
            } else {
                await window.bds.createProject(data);
                setAppStatus('Projeto criado com sucesso');
            }
            document.getElementById('modalProjectForm').classList.remove('open');
            await loadProjects();
            if (id) selectProject(Number(id));
        } catch(e) {
            console.error(e);
            window.bdsModal.alert('Erro ao salvar o projeto.');
        }
    });
    
    document.getElementById('btnEditProject')?.addEventListener('click', () => {
        const proj = projectsList.find(p => p.id === selectedProjectId);
        if (!proj) return;
        
        document.getElementById('modalProjectTitle').textContent = 'Editar Projeto';
        document.getElementById('projFormId').value = proj.id;
        document.getElementById('projFormName').value = proj.name;
        document.getElementById('projFormClient').value = proj.client || '';
        document.getElementById('projFormType').value = proj.type || '';
        document.getElementById('projFormStart').value = proj.start_date ? proj.start_date.split('T')[0] : '';
        document.getElementById('projFormDeadline').value = proj.deadline ? proj.deadline.split('T')[0] : '';
        document.getElementById('projFormStatus').value = proj.status || 'Ativo';
        document.getElementById('projFormColor').value = proj.color || '#3b82f6';
        
        document.getElementById('modalProjectForm').classList.add('open');
    });
    
    document.getElementById('btnDeleteProject')?.addEventListener('click', async () => {
        const proj = projectsList.find(p => p.id === selectedProjectId);
        if (!proj) return;
        
        const conf = await window.bdsModal.confirm(`Deseja realmente excluir o projeto "${proj.name}"?\n(Isso não apagará as mídias do seu computador)`);
        if (conf) {
            try {
                await window.bds.deleteProject(proj.id);
                selectedProjectId = null;
                document.getElementById('projectInspector').classList.remove('open');
                await loadProjects();
                setAppStatus('Projeto excluído');
            } catch(e) {
                console.error(e);
                window.bdsModal.alert('Erro ao excluir projeto.');
            }
        }
    });
    
    document.getElementById('closeProjInspectorBtn')?.addEventListener('click', () => {
        document.getElementById('projectInspector').classList.remove('open');
        selectedProjectId = null;
        updateCardSelection();
    });
    
    document.getElementById('inspectorProjCover')?.addEventListener('click', async () => {
        if (!selectedProjectId) return;
        const res = await window.bds.selectFile({
            properties: ['openFile'],
            filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
        });
        const coverPath = firstDialogPath(res);
        if (coverPath) {
            try {
                await window.bds.updateProject(selectedProjectId, { cover_path: coverPath });
                await loadProjects();
                selectProject(selectedProjectId);
            } catch(e) {
                window.bdsModal.alert('Erro ao salvar a capa.');
            }
        }
    });
    
    document.getElementById('inspectorProjColor')?.addEventListener('change', async (e) => {
        if (!selectedProjectId) return;
        try {
            await window.bds.updateProject(selectedProjectId, { color: e.target.value });
            await loadProjects();
            selectProject(selectedProjectId);
        } catch(e) {}
    });
    
    document.getElementById('btnOpenProject')?.addEventListener('click', () => {
        if (selectedProjectId) openProjectWorkspace(selectedProjectId);
    });

    // --- Exportar .bdspro ---
    document.getElementById('btnExportBdspro')?.addEventListener('click', async () => {
        if (!selectedProjectId) return;
        const proj = projectsList.find(p => p.id === selectedProjectId);
        if (!proj) return;

        try {
            const destFolder = await window.bds.selectFolder(); // caminho escolhido, ou null se cancelou
            if (destFolder) {
                // O processo principal monta o caminho (nome sanitizado + path.join) e confirma a sobrescrita
                setAppStatus('Exportando pacote .bdspro...', 'info');
                const result = await window.bds.exportBdspro(selectedProjectId, { folder: destFolder, name: proj.name });
                if (result && result.success) {
                    setAppStatus(`Projeto "${proj.name}" exportado com sucesso!`, 'success');
                    window.bdsModal.alert(`Pacote .bdspro exportado com sucesso!\n\nSalvo em: ${result.filePath}`);
                }
            }
        } catch (e) {
            console.error('Erro ao exportar .bdspro:', e);
            setAppStatus('Erro ao exportar pacote .bdspro', 'error');
            window.bdsModal.alert(`Erro ao exportar projeto .bdspro: ${friendlyError(e)}`);
        }
    });

    // --- Importar .bdspro ---
    document.getElementById('btnImportBdspro')?.addEventListener('click', async () => {
        try {
            const fileRes = await window.bds.selectFile({
                properties: ['openFile'],
                filters: [{ name: 'Pacote de Projeto BDS (*.bdspro)', extensions: ['bdspro'] }]
            });

            const bdsproPath = firstDialogPath(fileRes);
            if (bdsproPath) {
                setAppStatus('Inspecionando pacote .bdspro...', 'info');
                const inspectData = await window.bds.inspectBdspro(bdsproPath);
                openRelinkModal(bdsproPath, inspectData);
            }
        } catch (e) {
            console.error('Erro ao abrir .bdspro:', e);
            setAppStatus('Erro ao ler pacote .bdspro', 'error');
            window.bdsModal.alert(`Erro ao inspecionar pacote .bdspro: ${friendlyError(e)}`);
        }
    });

    setupRelinkModalListeners();
}

// --- CONTROLE DO MODAL DE RELINK / IMPORTAÇÃO ---
let currentRelinkContext = null;

function openRelinkModal(bdsproPath, data) {
    currentRelinkContext = {
        bdsproPath,
        data,
        relinkMap: {},
        missingList: data.missingFiles || [],
        matches: []
    };

    const modal = document.getElementById('modalRelinkBdspro');
    if (!modal) return;

    // Popula informações gerais
    const meta = data.metadata || {};
    document.getElementById('relinkProjectName').textContent = meta.name || 'Projeto BDS';
    document.getElementById('relinkProjectDesc').textContent = meta.description || 'Sem descrição';

    const coverEl = document.getElementById('relinkProjectCover');
    if (meta.cover_path && !meta.cover_relative_path) {
        coverEl.style.backgroundImage = `url('file:///${meta.cover_path.replace(/\\/g, '/')}')`;
    } else {
        coverEl.style.backgroundImage = 'none';
    }

    // Pills de status
    document.getElementById('pillTotalMedia').textContent = `${data.totalMedia} mídias`;
    
    const pillMissing = document.getElementById('pillMissingMedia');
    pillMissing.textContent = `${data.missingMediaCount} ausentes`;
    if (data.missingMediaCount > 0) {
        pillMissing.className = 'relink-pill relink-pill--warning';
    } else {
        pillMissing.className = 'relink-pill relink-pill--success';
        pillMissing.textContent = 'Mídias 100% OK';
    }

    const alertBox = document.getElementById('relinkMissingAlert');
    if (data.missingMediaCount > 0) {
        alertBox.classList.remove('hidden');
    } else {
        alertBox.classList.add('hidden');
    }

    renderRelinkTable();
    modal.classList.add('open');
}

function renderRelinkTable() {
    const tbody = document.getElementById('relinkMediaTableBody');
    if (!tbody || !currentRelinkContext) return;
    tbody.innerHTML = '';

    const allMedia = currentRelinkContext.data.projectData?.media || [];
    if (allMedia.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--muted); padding: 20px;">Nenhuma mídia registrada no projeto.</td></tr>';
        return;
    }

    allMedia.forEach(m => {
        const origPath = m.original_path || m.filepath;
        const isMissingInitial = currentRelinkContext.data.missingFiles.some(mf => mf.original_path === origPath);
        const relinkedPath = currentRelinkContext.relinkMap[origPath] || currentRelinkContext.relinkMap[m.filename];
        
        let statusBadge = '';
        let displayPath = origPath;
        let confidenceText = '-';

        if (!isMissingInitial) {
            statusBadge = '<span class="relink-badge-ok"><span class="material-symbols-rounded">check_circle</span> Conectado</span>';
            confidenceText = '100%';
        } else if (relinkedPath) {
            statusBadge = '<span class="relink-badge-relinked"><span class="material-symbols-rounded">link</span> Reconectado</span>';
            displayPath = relinkedPath;
            const matchInfo = currentRelinkContext.matches.find(match => match.missing.original_path === origPath);
            confidenceText = matchInfo ? `${matchInfo.confidence}%` : 'Manual';
        } else {
            statusBadge = '<span class="relink-badge-missing"><span class="material-symbols-rounded">error</span> Não encontrado</span>';
            confidenceText = '0%';
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${statusBadge}</td>
            <td style="font-weight: 600;">${escapeHtml(m.filename || 'Sem nome')}</td>
            <td style="color: var(--muted); font-size: 11px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(displayPath)}">${escapeHtml(displayPath)}</td>
            <td style="text-align: center;">${confidenceText}</td>
        `;
        tbody.appendChild(tr);
    });
}

function setupRelinkModalListeners() {
    const modal = document.getElementById('modalRelinkBdspro');
    if (!modal) return;

    document.getElementById('btnCloseRelinkModal')?.addEventListener('click', () => {
        modal.classList.remove('open');
        currentRelinkContext = null;
    });

    document.getElementById('btnCancelRelink')?.addEventListener('click', () => {
        modal.classList.remove('open');
        currentRelinkContext = null;
    });

    // Localizar Pasta de Mídias
    document.getElementById('btnSelectRelinkFolder')?.addEventListener('click', async () => {
        if (!currentRelinkContext) return;
        try {
            const folderRes = await window.bds.selectFolder();
            const searchFolder = firstDialogPath(folderRes);
            if (searchFolder) {
                setAppStatus('Buscando mídias correspondentes...', 'info');

                const scannedFiles = await window.bds.scanRelinkFolder(searchFolder);
                const matches = await window.bds.matchMissingMedia(currentRelinkContext.missingList, scannedFiles);
                currentRelinkContext.matches = matches;

                let resolvedCount = 0;
                for (const match of matches) {
                    if (match.matched && match.resolved) {
                        currentRelinkContext.relinkMap[match.missing.original_path] = match.matched.filepath;
                        currentRelinkContext.relinkMap[match.missing.filename] = match.matched.filepath;
                        resolvedCount++;
                    }
                }

                renderRelinkTable();
                setAppStatus(`Reconexão concluída: ${resolvedCount} de ${currentRelinkContext.missingList.length} mídias associadas`, 'success');
            }
        } catch (e) {
            console.error('Erro ao buscar mídias para relink:', e);
            window.bdsModal.alert('Erro ao escanear pasta de mídias.');
        }
    });

    // Confirmar Importação
    document.getElementById('btnConfirmImportBdspro')?.addEventListener('click', async () => {
        if (!currentRelinkContext) return;
        try {
            setAppStatus('Importando projeto BDS...', 'info');
            const importRes = await window.bds.importBdspro(currentRelinkContext.bdsproPath, currentRelinkContext.relinkMap);
            if (importRes && importRes.success) {
                setAppStatus(`Projeto "${importRes.projectName}" importado com sucesso!`, 'success');
                modal.classList.remove('open');
                currentRelinkContext = null;
                await loadProjects();
                selectProject(importRes.projectId);
            }
        } catch (e) {
            console.error('Erro ao confirmar importação:', e);
            setAppStatus('Erro ao importar projeto', 'error');
            window.bdsModal.alert(`Erro ao importar projeto: ${friendlyError(e)}`);
        }
    });
}

async function openProjectWorkspace(id) {
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
        if (title) title.textContent = 'Workspace do Projeto';
    }
}