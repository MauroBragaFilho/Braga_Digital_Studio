// "Adicionar a um projeto…": escolher o projeto que recebe as LUTs marcadas (do cartão, da barra de seleção, de uma pasta
// ou do painel). Busca por nome ou cliente, projetos ativos primeiro (os arquivados ficam atrás de "Mostrar arquivados"),
// "Já tem" quando o projeto já contém todas as LUTs escolhidas. Os caminhos que seguem para o processo principal são
// sempre relativos à coleção (os que a lista de LUTs informou). Todo nome entra na tela por textContent.
// Sem estado de módulo: cada tela cria o seu seletor (createProjectPicker) com os elementos do seu HTML.

const ADD_CHUNK = 500; // caminhos por chamada (o canal aceita até 500; o projeto aceita no máximo 100 LUTs)
const ARCHIVED = 'Arquivado';
const NAMES_SHOWN = 3;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const searchKey = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const listNames = (names, max = NAMES_SHOWN) => {
    const shown = names.slice(0, max).join(', ');
    return names.length > max ? `${shown} e mais ${names.length - max}` : shown;
};

/**
 * @param {object} deps
 * @param {object} deps.els - elementos da janela: modal, what, search, list, archivedRow, archived, status, error, cancelBtn, closeBtn, confirmBtn
 * @param {() => object} deps.getBds - window.bds
 * @param {(text: string, tone?: string, autoHideMs?: number) => void} deps.showNotice
 * @param {(err: unknown) => string} deps.errMsg
 * @param {(result: object) => Promise<void>|void} [deps.onAdded] - chamado depois de adicionar (para atualizar o inspetor)
 */
export function createProjectPicker({ els, getBds, showNotice, errMsg, onAdded = () => {} }) {
    let context = null;        // { relPaths, folders, names, label, restoreFocus }
    let projects = [];
    let usage = new Map();     // relPath -> Set(id de projeto): onde a LUT já está
    let picked = null;         // id do projeto escolhido
    let busy = false;
    let bound = false;
    let seq = 0;

    const setHidden = (el, hidden) => { if (el) el.classList.toggle('hidden', hidden); };
    const text = (el, value) => { if (el) el.textContent = value; };
    const isOpen = () => !!els.modal && !els.modal.classList.contains('hidden');

    /** O projeto já tem TODAS as LUTs escolhidas? (pelo conteúdo, informado pelo processo principal) */
    function hasAll(projectId) {
        if (!context || !context.relPaths.length) return false;
        return context.relPaths.every((rel) => { const ids = usage.get(rel); return !!ids && ids.has(projectId); });
    }

    function updateConfirm() {
        if (!els.confirmBtn) return;
        const chosen = projects.find((p) => p.id === picked);
        els.confirmBtn.disabled = busy || !chosen || hasAll(chosen.id);
    }

    function visibleProjects() {
        const q = searchKey(els.search ? els.search.value : '').trim();
        const showArchived = !!(els.archived && els.archived.checked);
        return projects
            .filter((p) => showArchived || p.status !== ARCHIVED)
            .filter((p) => !q || searchKey(`${p.name} ${p.client || ''}`).includes(q))
            .sort((a, b) => (a.status === ARCHIVED) - (b.status === ARCHIVED)
                || String(b.last_activity_at || b.created_at || '').localeCompare(String(a.last_activity_at || a.created_at || ''))
                || a.id - b.id);
    }

    function render() {
        const list = els.list;
        if (!list) return;
        list.textContent = '';
        const hasArchived = projects.some((p) => p.status === ARCHIVED);
        setHidden(els.archivedRow, !hasArchived);
        if (!projects.length) {
            const empty = document.createElement('p');
            empty.className = 'lut-project-empty';
            empty.textContent = 'Você ainda não tem projetos.';
            list.appendChild(empty);
            updateConfirm();
            return;
        }
        const rows = visibleProjects();
        if (!rows.length) {
            const empty = document.createElement('p');
            empty.className = 'lut-project-empty';
            const onlyArchived = !projects.some((p) => p.status !== ARCHIVED) && !(els.archived && els.archived.checked);
            empty.textContent = onlyArchived ? 'Só há projetos arquivados. Marque "Mostrar arquivados" para vê-los.' : 'Nenhum projeto para essa busca.';
            list.appendChild(empty);
            updateConfirm();
            return;
        }
        for (const project of rows) {
            const had = hasAll(project.id);
            const label = document.createElement('label');
            label.className = `lut-project-item${had ? ' is-disabled' : ''}${project.status === ARCHIVED ? ' is-archived' : ''}`;
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'lutProjectPick';
            radio.value = String(project.id);
            radio.checked = project.id === picked && !had;
            radio.disabled = had;
            radio.addEventListener('change', () => { picked = project.id; updateConfirm(); });
            const name = document.createElement('span');
            name.className = 'lut-project-name';
            name.textContent = project.name;
            name.title = project.name;
            const meta = document.createElement('span');
            meta.className = 'lut-project-meta';
            meta.textContent = [project.client, project.status === ARCHIVED ? 'Arquivado' : null].filter(Boolean).join(' · ');
            label.append(radio, name, meta);
            if (had) {
                const tag = document.createElement('span');
                tag.className = 'lut-project-has';
                tag.textContent = context && context.relPaths.length > 1 ? 'Já tem todas' : 'Já tem';
                label.appendChild(tag);
            }
            list.appendChild(label);
        }
        updateConfirm();
    }

    function describe(ctx) {
        if (ctx.label) return ctx.label;
        const names = ctx.names;
        return names.length === 1 ? `1 LUT: ${names[0]}` : `${plural(names.length, 'LUT', 'LUTs')}: ${listNames(names)}`;
    }

    /**
     * Abre a janela.
     * @param {{ relPaths: string[], folders?: string[], names: string[], label?: string, restoreFocus?: () => void }} ctx
     *   relPaths: TODAS as LUTs escolhidas (caminho relativo); folders: se informado, é o que o processo principal
     *   expande ao adicionar (as relPaths servem então só para o "Já tem"); names: nomes para o texto da janela.
     */
    async function open(ctx) {
        if (busy || !ctx || !Array.isArray(ctx.relPaths) || !ctx.relPaths.length) return;
        const bds = getBds();
        if (!bds || typeof bds.listProjects !== 'function' || typeof bds.addProjectLuts !== 'function') {
            showNotice('Adicionar LUTs a projetos não está disponível nesta versão.', 'danger');
            return;
        }
        const mine = ++seq;
        context = { folders: [], label: '', restoreFocus: null, ...ctx };
        projects = [];
        usage = new Map();
        picked = null;
        text(els.what, describe(context));
        text(els.error, '');
        setHidden(els.error, true);
        text(els.status, 'Lendo os projetos…');
        if (els.search) els.search.value = '';
        if (els.archived) els.archived.checked = false;
        render();
        setHidden(els.modal, false);

        try {
            const list = await bds.listProjects();
            if (mine !== seq) return;
            projects = (Array.isArray(list) ? list : []).filter((p) => p && Number.isInteger(p.id) && typeof p.name === 'string');
        } catch (err) {
            if (mine !== seq) return;
            text(els.error, `Não foi possível ler os projetos: ${errMsg(err)}`);
            setHidden(els.error, false);
        }
        text(els.status, '');
        render();

        // Onde as LUTs já estão (para "Já tem"): chega depois e só atualiza a lista
        if (projects.length && typeof bds.lutsUsage === 'function') {
            try {
                const entries = await bds.lutsUsage(context.folders.length ? [] : context.relPaths, context.folders);
                if (mine !== seq) return;
                for (const entry of Array.isArray(entries) ? entries : []) {
                    if (!entry || typeof entry.relPath !== 'string') continue;
                    usage.set(entry.relPath, new Set((entry.projects || []).map((p) => p.id)));
                }
                render();
            } catch (err) {
                console.warn('[LUTS] Não foi possível conferir onde as LUTs já estão:', err);
            }
        }
    }

    function close({ restore = true } = {}) {
        if (!isOpen()) return;
        seq++;
        setHidden(els.modal, true);
        const back = context && context.restoreFocus;
        context = null;
        projects = [];
        usage = new Map();
        picked = null;
        if (restore && typeof back === 'function') {
            // depois que o foco automático do modal terminar de voltar ao último elemento (que pode ter sumido)
            setTimeout(() => { try { back(); } catch (_) { /* tela descartada */ } }, 0);
        }
    }

    /** Texto do resultado: "3 LUTs adicionadas ao projeto X; 1 já estava." */
    function summarize(total, projectName) {
        const lines = [];
        const head = total.added
            ? `${plural(total.added, 'LUT adicionada', 'LUTs adicionadas')} ao projeto "${projectName}"`
            : '';
        const had = total.already ? plural(total.already, 'já estava', 'já estavam') : '';
        if (head) lines.push(`${head}${had ? `; ${had}` : ''}.`);
        else if (had) lines.push(`Nenhuma LUT nova: ${had} no projeto "${projectName}".`);
        if (total.overLimit) lines.push(`O projeto aceita até 100 LUTs; ${plural(total.overLimit, 'LUT não foi adicionada', 'LUTs não foram adicionadas')}.`);
        if (total.invalid.length) {
            const shown = total.invalid.slice(0, 2).map((i) => `${i.name} (${i.reason})`).join('; ');
            lines.push(`${plural(total.invalid.length, 'LUT não pôde ser adicionada', 'LUTs não puderam ser adicionadas')}: ${shown}${total.invalid.length > 2 ? ` e mais ${total.invalid.length - 2}` : ''}.`);
        }
        if (!lines.length) lines.push('Nenhuma LUT foi adicionada.');
        const problem = total.overLimit || total.invalid.length;
        const tone = total.added && !problem ? 'success' : (total.added || total.already ? 'warning' : 'danger');
        return { message: lines.join('\n'), tone };
    }

    async function confirm() {
        const project = projects.find((p) => p.id === picked);
        if (!project || busy || !context || hasAll(project.id)) return;
        const ctx = context;
        const bds = getBds();
        busy = true;
        updateConfirm();
        text(els.error, '');
        setHidden(els.error, true);
        const total = { added: 0, already: 0, overLimit: 0, invalid: [] };
        const merge = (res) => {
            total.added += (res && res.added) || 0;
            total.already += (res && res.already) || 0;
            total.overLimit += (res && res.overLimit) || 0;
            if (res && Array.isArray(res.invalid)) total.invalid.push(...res.invalid);
        };
        try {
            if (ctx.folders.length) {
                merge(await bds.addProjectLuts(project.id, [], ctx.folders));
            } else {
                for (let i = 0; i < ctx.relPaths.length; i += ADD_CHUNK) {
                    merge(await bds.addProjectLuts(project.id, ctx.relPaths.slice(i, i + ADD_CHUNK)));
                }
            }
        } catch (err) {
            busy = false;
            updateConfirm();
            text(els.error, `Não foi possível adicionar as LUTs: ${errMsg(err)}`);
            setHidden(els.error, false);
            return;
        }
        busy = false;
        close();
        const { message, tone } = summarize(total, project.name);
        showNotice(message, tone, tone === 'success' ? 6000 : 0);
        try { await onAdded({ projectId: project.id, projectName: project.name, ...total }); } catch (_) { /* a tela se atualiza na próxima carga */ }
    }

    function bind() {
        if (bound) return;
        bound = true;
        els.search?.addEventListener('input', render);
        els.archived?.addEventListener('change', render);
        els.cancelBtn?.addEventListener('click', () => close());
        els.closeBtn?.addEventListener('click', () => close());
        els.confirmBtn?.addEventListener('click', confirm);
        els.modal?.addEventListener('click', (e) => { if (e.target === els.modal) close(); });
    }

    return { bind, open, close, isOpen };
}
