import { els, setAppStatus, escapeHtml } from '../app.js';


let projectsList = [];
let selectedProjectId = null;

export function initScreen() {
    loadProjects();
    setupEventListeners();
}

function formatBytes(bytes) {
    if (bytes === 0 || !bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    return d.toLocaleDateString('pt-BR');
}

function getDeadlinePill(deadlineStr) {
    if (!deadlineStr) return { text: 'Sem Prazo', color: 'gray', icon: 'schedule' };
    
    const deadline = new Date(deadlineStr);
    const now = new Date();
    
    deadline.setHours(0,0,0,0);
    now.setHours(0,0,0,0);
    
    const diffTime = deadline - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
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
    
    if (projectsList.length === 0) {
        grid.innerHTML = '<div class="proj-empty-state">Nenhum projeto encontrado.</div>';
        return;
    }
    
    projectsList.forEach(proj => {
        const pill = getDeadlinePill(proj.deadline);
        const bgSize = proj.cover_path ? `url('file:///${proj.cover_path.replace(/\\/g, '/')}')` : 'none';
        const displayCount = proj.media_count || 0;
        const displaySize = formatBytes(proj.total_size);
        
        // Cor do gradiente baseada na cor do projeto
        const bgColor = proj.color || '#3b82f6';
        
        const card = document.createElement('div');
        card.className = `proj-card ${selectedProjectId === proj.id ? 'selected' : ''}`;
        card.innerHTML = `
            <div class="proj-card-cover" style="background-image: ${bgSize};">
                <div class="proj-card-cover-gradient" style="background: linear-gradient(0deg, ${bgColor}33 0%, transparent 100%);"></div>
                <div class="proj-card-pill">
                    <span style="color: ${pill.color};">●</span> ${pill.text}
                </div>
            </div>
            <div class="proj-card-info" style="background: linear-gradient(180deg, transparent 0%, ${bgColor}11 100%);">
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
        
        card.addEventListener('click', () => selectProject(proj.id));
        card.addEventListener('dblclick', () => openProjectWorkspace(proj.id));
        
        grid.appendChild(card);
    });
}

function selectProject(id) {
    selectedProjectId = id;
    renderGrid(); // update selection highlight
    
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
        renderGrid();
    });
    
    document.getElementById('inspectorProjCover')?.addEventListener('click', async () => {
        if (!selectedProjectId) return;
        const res = await window.bds.selectFile({
            properties: ['openFile'],
            filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
        });
        if (res && res.filePaths && res.filePaths.length > 0) {
            try {
                await window.bds.updateProject(selectedProjectId, { cover_path: res.filePaths[0] });
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
}

function openProjectWorkspace(id) {
    // Para abrir o workspace, usamos a lógica parecida com a sidebar no app.js
    // Mas o workspace será uma tela completamente nova que substitui o visual
    // Precisamos injetar essa tela.
    
    // Armazena no state global do app.js
    import('../app.js').then(app => {
        app.state.currentProjectId = id;
        
        // Simula clique num "tab-button" fantasma
        const contentContainer = document.getElementById('dynamic-content');
        fetch('./screens/project_workspace.html').then(res => res.text()).then(htmlContent => {
            contentContainer.innerHTML = '';
            const viewSection = document.createElement('section');
            viewSection.id = `project_workspaceView`;
            viewSection.className = 'view active'; 
            viewSection.innerHTML = htmlContent;
            contentContainer.appendChild(viewSection);
            
            document.getElementById('globalPageTitle').textContent = 'Workspace do Projeto';
            
            import('./project_workspace.js').then(m => {
                if (m.initScreen) m.initScreen();
            }).catch(e => console.error("Failed to load workspace JS", e));
        });
    });
}