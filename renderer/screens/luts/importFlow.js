// Fluxo "Importar LUTs" (arquivos ou pasta): procura em segundo plano, mostra o resumo antes de copiar, importa só o
// marcado e permite cancelar. Os caminhos de origem ficam no processo principal: aqui só existem números de item.
// Sem estado de módulo: cada tela cria o seu fluxo (createImportFlow) com os elementos do seu HTML.
import { countLuts } from './groups.js';
import { createShiftRange } from '../../utils/shiftRange.js';

const GROUP_PAGE = 300; // linhas criadas por grupo antes de "Ver mais" (a lista pode ter milhares)
const FILTERS = [
    { id: 'new', label: (n) => `${n} ${n === 1 ? 'nova' : 'novas'}` },
    { id: 'exists', label: (n) => `${n} já ${n === 1 ? 'existe' : 'existem'}` },
    { id: 'repeated', label: (n) => `${n} ${n === 1 ? 'repetida' : 'repetidas'}` },
    { id: 'invalid', label: (n) => `${n} ${n === 1 ? 'inválida' : 'inválidas'}` }
];
const MAX_FOLDER_LEVELS = 3; // níveis de pasta que a coleção aceita (o excedente é agrupado)

/**
 * @param {object} deps
 * @param {object} deps.els - elementos do modal: modal, scanSection, summarySection, progressSection, scanText, scanBar,
 *   scanCancel, summaryText, notes, filters, groups, options, keepFolders, wrap, wrapName, error, closeBtn, cancelBtn,
 *   confirmBtn, progressText, progressBar, stopBtn
 * @param {() => object} deps.getBds - window.bds
 * @param {(text: string, tone?: string, autoHideMs?: number) => void} deps.showNotice
 * @param {(err: unknown) => string} deps.errMsg
 * @param {(out: object) => Promise<void>|void} deps.onImported - chamado depois de uma importação (inclusive cancelada)
 * @param {(busy: boolean) => void} [deps.onBusy]
 */
export function createImportFlow({ els, getBds, showNotice, errMsg, onImported, onBusy = () => {} }) {
    let state = 'idle'; // idle | scanning | summary | importing
    let busy = false;
    let scanId = null;
    let scan = null;
    let selected = new Set();
    const shiftRange = createShiftRange(); // Shift+clique marca o intervalo entre duas caixas
    let filter = 'new';
    const shownRows = new Map();
    let bound = false;

    const setHidden = (el, hidden) => { if (el) el.classList.toggle('hidden', hidden); };
    const text = (el, value) => { if (el) el.textContent = value; };

    function setBusy(value) {
        busy = value;
        onBusy(value);
    }

    function openModal() {
        setHidden(els.modal, false);
    }

    function closeModal() {
        setHidden(els.modal, true);
        state = 'idle';
        scan = null;
        scanId = null;
        selected = new Set();
        shiftRange.reset();
        shownRows.clear();
        setBusy(false);
    }

    function show(section) {
        setHidden(els.scanSection, section !== 'scanning');
        setHidden(els.summarySection, section !== 'summary');
        setHidden(els.progressSection, section !== 'importing');
        state = section;
    }

    function setBar(bar, value, max) {
        if (!bar) return;
        if (max > 0) { bar.max = max; bar.value = value; } else { bar.removeAttribute('value'); }
    }

    // ─── Progresso ────────────────────────────────────────────────────────────────────────────────

    function onScanProgress(p) {
        if (!p || typeof p !== 'object') return;
        if (p.phase === 'start') {
            scanId = p.scanId || null;
            if (busy && state !== 'summary') { show('scanning'); openModal(); }
            return;
        }
        if (state !== 'scanning' || (p.scanId && scanId && p.scanId !== scanId)) return;
        if (p.phase === 'walk') {
            text(els.scanText, `Procurando LUTs… ${countFound(p.found)}`);
            setBar(els.scanBar, 0, 0);
        } else if (p.phase === 'collection') {
            text(els.scanText, 'Conferindo as LUTs que você já tem…');
            setBar(els.scanBar, 0, 0);
        } else if (p.phase === 'read') {
            text(els.scanText, `Verificando as LUTs… ${p.processed} de ${p.total}`);
            setBar(els.scanBar, p.processed, p.total);
        }
    }

    function countFound(n) {
        return n === 1 ? '1 encontrada' : `${n || 0} encontradas`;
    }

    function onImportProgress(p) {
        if (!p || typeof p !== 'object' || state !== 'importing' || p.phase !== 'import') return;
        if (p.scanId && scan && p.scanId !== scan.scanId) return;
        text(els.progressText, p.current ? `Importando ${Math.min(p.done + 1, p.total)} de ${p.total}: ${p.current}` : `Importando… ${p.done} de ${p.total}`);
        setBar(els.progressBar, p.done, p.total);
    }

    // ─── Busca ────────────────────────────────────────────────────────────────────────────────────

    /**
     * Procura as LUTs. Sem `paths`, o processo principal abre o diálogo (`mode`: 'folder' ou 'files'); com `paths`
     * (arrastar e soltar), ele valida cada caminho.
     */
    async function start({ paths, mode } = {}) {
        if (busy) return;
        const bds = getBds();
        if (!bds || typeof bds.scanLuts !== 'function') {
            showNotice('A importação de LUTs não está disponível nesta versão.', 'danger');
            return;
        }
        setBusy(true);
        scanId = null;
        text(els.scanText, 'Procurando LUTs…');
        setBar(els.scanBar, 0, 0);
        if (els.scanCancel) { els.scanCancel.disabled = false; }
        state = 'scanning';
        try {
            const res = Array.isArray(paths) ? await bds.scanLuts(paths) : await bds.scanLuts(undefined, { mode });
            if (!res || res.canceled) { closeModal(); return; } // fechou o diálogo ou cancelou a busca: não é erro
            if (!res.summary || !res.summary.found) {
                closeModal();
                const extra = res && res.summary && res.summary.ignored3dl ? ' Os arquivos .3dl foram ignorados; o programa só aceita .cube.' : '';
                showNotice(`Nenhuma LUT .cube foi encontrada.${extra}`, 'warning');
                return;
            }
            scan = res;
            scanId = res.scanId;
            selected = new Set(res.items.filter((i) => i.status === 'new').map((i) => i.key));
            filter = res.summary.new ? 'new' : (FILTERS.find((f) => res.summary[f.id])?.id || 'new');
            shownRows.clear();
            renderSummary();
            show('summary');
            openModal();
            (els.confirmBtn && !els.confirmBtn.disabled ? els.confirmBtn : els.cancelBtn)?.focus();
        } catch (err) {
            console.error('[LUTS] Erro ao procurar LUTs:', err);
            closeModal();
            showNotice(`Não foi possível procurar as LUTs: ${errMsg(err)}`, 'danger');
        }
    }

    // ─── Resumo ───────────────────────────────────────────────────────────────────────────────────

    function summarySentence() {
        const s = scan.summary;
        const parts = [];
        if (s.new) parts.push(`${s.new} ${s.new === 1 ? 'nova' : 'novas'}`);
        if (s.exists) parts.push(`${s.exists} já ${s.exists === 1 ? 'existe' : 'existem'}`);
        if (s.repeated) parts.push(`${s.repeated} ${s.repeated === 1 ? 'repetida' : 'repetidas'}`);
        if (s.invalid) parts.push(`${s.invalid} ${s.invalid === 1 ? 'inválida' : 'inválidas'}`);
        return `Encontrei ${countLuts(s.found)}: ${parts.join(', ')}.`;
    }

    function hasSourceFolders() {
        return scan.items.some((i) => i.folder);
    }

    function wrapActive() {
        return !!(scan && scan.sourceName && els.wrap && els.wrap.checked);
    }

    function noteLines() {
        const s = scan.summary;
        const lines = [];
        if (s.ignored3dl) lines.push(`${s.ignored3dl} ${s.ignored3dl === 1 ? 'arquivo .3dl foi ignorado' : 'arquivos .3dl foram ignorados'}; o programa só aceita .cube.`);
        if (s.ignoredLinks) lines.push(`${s.ignoredLinks} ${s.ignoredLinks === 1 ? 'atalho (link) foi ignorado' : 'atalhos (links) foram ignorados'}.`);
        if (s.tooDeepSkipped) lines.push(`${s.tooDeepSkipped} ${s.tooDeepSkipped === 1 ? 'pasta funda demais foi ignorada' : 'pastas fundas demais foram ignoradas'}.`);
        if (s.truncated) lines.push('A busca foi interrompida porque a pasta tem arquivos demais ou demorou demais; só o que foi encontrado até aqui aparece.');
        if (s.bigForPhone) lines.push(`${s.bigForPhone} ${s.bigForPhone === 1 ? 'LUT passa de 32 MB: o celular não a recebe' : 'LUTs passam de 32 MB: o celular não as recebe'}.`);
        if (s.omitted) lines.push(`Há mais de ${(s.found - s.omitted).toLocaleString('pt-BR')} LUTs; só as primeiras aparecem. Importe em partes.`);
        const keep = !els.keepFolders || els.keepFolders.checked;
        if (keep && s.maxFolderDepth + (wrapActive() ? 1 : 0) > MAX_FOLDER_LEVELS) {
            lines.push(`Pastas com mais de ${MAX_FOLDER_LEVELS} níveis serão agrupadas em um só nível.`);
        }
        return lines;
    }

    function renderNotes() {
        if (!els.notes) return;
        els.notes.replaceChildren(...noteLines().map((line) => {
            const li = document.createElement('li');
            li.textContent = line;
            return li;
        }));
        setHidden(els.notes, !els.notes.childElementCount);
    }

    function renderOptions() {
        const keepRelevant = hasSourceFolders();
        const wrapRelevant = !!scan.sourceName;
        setHidden(els.options, !keepRelevant && !wrapRelevant);
        els.keepFolders?.closest('label')?.classList.toggle('hidden', !keepRelevant);
        els.wrap?.closest('label')?.classList.toggle('hidden', !wrapRelevant);
        setHidden(els.wrapName, !wrapRelevant);
        if (els.keepFolders) els.keepFolders.checked = true;
        if (els.wrap) els.wrap.checked = wrapRelevant;
        if (els.wrapName) { els.wrapName.value = scan.sourceName || ''; els.wrapName.disabled = !wrapRelevant; }
        els.options?.removeAttribute('open');
    }

    function renderFilters() {
        if (!els.filters) return;
        els.filters.replaceChildren(...FILTERS.filter((f) => scan.summary[f.id] > 0).map((f) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'lut-import-chip';
            button.dataset.filter = f.id;
            button.setAttribute('aria-pressed', f.id === filter ? 'true' : 'false');
            button.textContent = f.label(scan.summary[f.id]);
            return button;
        }));
    }

    function newKeysOf(folder) {
        return scan.items.filter((i) => i.status === 'new' && i.folder === folder).map((i) => i.key);
    }

    function groupLabel(folder) {
        if (folder) return folder.split('/').join(' / ');
        return scan.sourceName ? `${scan.sourceName} (arquivos da própria pasta)` : 'Arquivos soltos';
    }

    function reasonOf(item) {
        if (item.status === 'exists') return `Já existe na biblioteca como "${item.existsAs}".`;
        if (item.status === 'repeated') return `Repetida: mesmo conteúdo de "${item.existsAs}".`;
        if (item.status === 'invalid') return item.reason || 'LUT inválida.';
        return item.warning || '';
    }

    function renderItem(item) {
        const li = document.createElement('li');
        li.className = 'lut-import-item';
        const label = document.createElement('label');
        label.className = 'lut-import-check';
        if (item.status === 'new') {
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.dataset.key = String(item.key);
            box.checked = selected.has(item.key);
            box.setAttribute('aria-label', `Importar ${item.name}`);
            label.appendChild(box);
        }
        const name = document.createElement('span');
        name.className = 'lut-import-item-name';
        name.textContent = item.name;
        label.appendChild(name);
        li.appendChild(label);
        const reason = reasonOf(item);
        if (reason) {
            const note = document.createElement('span');
            note.className = item.status === 'invalid' ? 'lut-import-reason lut-import-reason-bad' : 'lut-import-reason';
            note.textContent = reason;
            li.appendChild(note);
        }
        return li;
    }

    /** Cria as linhas de um grupo, só as que ainda não existem (até GROUP_PAGE por vez). */
    function fillGroup(list, folder, items) {
        const done = shownRows.get(folder) || 0;
        const next = Math.min(items.length, done + GROUP_PAGE);
        list.querySelector('[data-role="more"]')?.remove();
        for (let i = done; i < next; i++) list.appendChild(renderItem(items[i]));
        shownRows.set(folder, next);
        if (next < items.length) {
            const li = document.createElement('li');
            li.dataset.role = 'more';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'lut-btn-outline';
            button.dataset.action = 'more';
            button.textContent = `Ver mais (${items.length - next})`;
            li.appendChild(button);
            list.appendChild(li);
        }
    }

    function syncGroupCheck(group) {
        const box = group.querySelector('[data-role="group-check"]');
        if (!box) return;
        const keys = newKeysOf(group.dataset.folder);
        const marked = keys.filter((k) => selected.has(k)).length;
        box.checked = keys.length > 0 && marked === keys.length;
        box.indeterminate = marked > 0 && marked < keys.length;
    }

    function renderGroups() {
        if (!els.groups) return;
        const items = scan.items.filter((i) => i.status === filter);
        shownRows.clear();
        const byFolder = new Map();
        for (const item of items) {
            if (!byFolder.has(item.folder)) byFolder.set(item.folder, []);
            byFolder.get(item.folder).push(item);
        }
        const flat = byFolder.size === 1 && byFolder.has('');
        const folders = [...byFolder.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' }));
        els.groups.replaceChildren(...folders.map((folder) => {
            const list = byFolder.get(folder);
            const group = document.createElement('div');
            group.className = 'lut-import-group';
            group.dataset.folder = folder;

            const ul = document.createElement('ul');
            ul.className = 'lut-import-items';

            if (!flat) {
                const head = document.createElement('div');
                head.className = 'lut-import-group-head';
                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = 'lut-icon-btn lut-icon-btn-small';
                toggle.dataset.action = 'toggle';
                toggle.setAttribute('aria-expanded', 'false');
                toggle.setAttribute('aria-label', `Mostrar as LUTs de ${groupLabel(folder)}`);
                toggle.title = 'Mostrar ou esconder';
                const arrow = document.createElement('span');
                arrow.className = 'material-symbols-rounded';
                arrow.setAttribute('aria-hidden', 'true');
                arrow.textContent = 'chevron_right';
                toggle.appendChild(arrow);
                head.appendChild(toggle);

                const label = document.createElement('label');
                label.className = 'lut-import-check lut-import-group-label';
                if (filter === 'new') {
                    const box = document.createElement('input');
                    box.type = 'checkbox';
                    box.dataset.role = 'group-check';
                    box.setAttribute('aria-label', `Marcar todas as LUTs de ${groupLabel(folder)}`);
                    label.appendChild(box);
                }
                const name = document.createElement('span');
                name.className = 'lut-import-group-name';
                name.textContent = groupLabel(folder);
                label.appendChild(name);
                head.appendChild(label);

                const count = document.createElement('span');
                count.className = 'lut-import-count';
                count.textContent = countLuts(list.length);
                head.appendChild(count);
                group.appendChild(head);
                ul.setAttribute('hidden', '');
            }
            group.appendChild(ul);
            if (flat) fillGroup(ul, folder, list);
            syncGroupCheck(group);
            return group;
        }));
        if (!items.length) {
            const empty = document.createElement('p');
            empty.className = 'lut-import-empty';
            empty.textContent = 'Nada aqui.';
            els.groups.appendChild(empty);
        }
    }

    function updateConfirm() {
        const n = selected.size;
        if (els.confirmBtn) {
            els.confirmBtn.disabled = n === 0;
            els.confirmBtn.textContent = n === 0 ? 'Importar' : `Importar ${countLuts(n)}`;
        }
    }

    function renderSummary() {
        text(els.summaryText, summarySentence());
        text(els.error, '');
        setHidden(els.error, true);
        renderOptions(); // antes dos avisos: o aviso de pastas fundas depende das opções
        renderNotes();
        renderFilters();
        renderGroups();
        updateConfirm();
    }

    function toggleGroup(group) {
        const folder = group.dataset.folder;
        const list = group.querySelector('.lut-import-items');
        const toggle = group.querySelector('[data-action="toggle"]');
        if (!list || !toggle) return;
        const open = list.hasAttribute('hidden');
        if (open && !list.childElementCount) fillGroup(list, folder, scan.items.filter((i) => i.status === filter && i.folder === folder));
        if (open) list.removeAttribute('hidden'); else list.setAttribute('hidden', '');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.querySelector('.material-symbols-rounded').textContent = open ? 'expand_more' : 'chevron_right';
    }

    // ─── Importar ─────────────────────────────────────────────────────────────────────────────────

    function showError(message) {
        text(els.error, message);
        setHidden(els.error, !message);
    }

    async function confirmImport() {
        if (state !== 'summary' || !scan || selected.size === 0) return;
        const bds = getBds();
        const useWrap = wrapActive();
        const rootGroup = useWrap ? (els.wrapName?.value || '').trim() : '';
        if (useWrap && !rootGroup) {
            showError('Informe o nome da pasta ou desmarque a opção.');
            els.options?.setAttribute('open', '');
            els.wrapName?.focus();
            return;
        }
        showError('');
        const keys = [...selected];
        const id = scan.scanId;
        text(els.progressText, `Importando… 0 de ${keys.length}`);
        setBar(els.progressBar, 0, keys.length);
        if (els.stopBtn) els.stopBtn.disabled = false;
        show('importing');
        els.stopBtn?.focus();
        try {
            const out = await bds.importScannedLuts(id, keys, {
                keepFolders: !els.keepFolders || els.keepFolders.checked,
                ...(rootGroup ? { rootGroup } : {})
            });
            const summary = scan;
            closeModal();
            await onImported(out, summary);
        } catch (err) {
            console.error('[LUTS] Erro ao importar:', err);
            // volta ao resumo para a pessoa corrigir (ex.: nome de pasta inválido); se o resumo foi consumido, o motivo explica
            show('summary');
            showError(errMsg(err));
            els.confirmBtn?.focus();
        }
    }

    // ─── Cancelar ─────────────────────────────────────────────────────────────────────────────────

    function cancel() {
        const bds = getBds();
        if (state === 'scanning') {
            text(els.scanText, 'Cancelando…');
            if (els.scanCancel) els.scanCancel.disabled = true;
            if (bds && typeof bds.cancelLutScan === 'function') bds.cancelLutScan(scanId || undefined);
        } else if (state === 'summary') {
            const id = scan && scan.scanId;
            closeModal();
            if (id && bds && typeof bds.cancelLutScan === 'function') bds.cancelLutScan(id); // libera o resumo guardado
        } else if (state === 'importing') {
            text(els.progressText, 'Cancelando… terminando o arquivo atual.');
            if (els.stopBtn) els.stopBtn.disabled = true;
            if (bds && typeof bds.cancelLutImport === 'function') bds.cancelLutImport(scan ? scan.scanId : undefined);
        }
    }

    // ─── Eventos ──────────────────────────────────────────────────────────────────────────────────

    function bind() {
        if (bound) return;
        bound = true;
        const bds = getBds();
        if (bds && typeof bds.onLutsScanProgress === 'function') bds.onLutsScanProgress(onScanProgress);
        if (bds && typeof bds.onLutsImportProgress === 'function') bds.onLutsImportProgress(onImportProgress);

        els.closeBtn?.addEventListener('click', cancel);
        els.scanCancel?.addEventListener('click', cancel);
        els.cancelBtn?.addEventListener('click', cancel);
        els.stopBtn?.addEventListener('click', cancel);
        els.confirmBtn?.addEventListener('click', confirmImport);

        els.filters?.addEventListener('click', (e) => {
            const button = e.target.closest('button[data-filter]');
            if (!button || !scan) return;
            filter = button.dataset.filter;
            renderFilters();
            renderGroups();
            els.filters.querySelector(`button[data-filter="${filter}"]`)?.focus();
        });

        els.groups?.addEventListener('click', (e) => {
            if (!scan) return;
            const group = e.target.closest('.lut-import-group');
            if (!group) return;
            if (e.target.closest('[data-action="toggle"]')) { toggleGroup(group); return; }
            const more = e.target.closest('[data-action="more"]');
            if (more) {
                const list = group.querySelector('.lut-import-items');
                const folder = group.dataset.folder;
                fillGroup(list, folder, scan.items.filter((i) => i.status === filter && i.folder === folder));
                list.querySelector('.lut-import-item:last-of-type input')?.focus();
            }
        });

        els.groups?.addEventListener('click', (e) => shiftRange.noteClick(e), true);
        els.groups?.addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); });
        els.groups?.addEventListener('change', (e) => {
            if (!scan) return;
            const group = e.target.closest('.lut-import-group');
            if (e.target.dataset.role === 'group-check' && group) {
                const keys = newKeysOf(group.dataset.folder);
                for (const k of keys) { if (e.target.checked) selected.add(k); else selected.delete(k); }
                group.querySelectorAll('input[data-key]').forEach((box) => { box.checked = e.target.checked; });
                syncGroupCheck(group);
            } else if (e.target.dataset.key !== undefined) {
                const key = Number(e.target.dataset.key);
                // Shift+clique: o intervalo desde a última caixa clicada (só as linhas à vista) ganha o estado desta
                const boxes = [...els.groups.querySelectorAll('input[data-key]')].filter((b) => !b.closest('ul[hidden]'));
                const keys = shiftRange.resolve(boxes.map((b) => Number(b.dataset.key)), key) || [key];
                const inRange = new Set(keys);
                for (const k of keys) { if (e.target.checked) selected.add(k); else selected.delete(k); }
                const touched = new Set();
                for (const b of boxes) {
                    if (!inRange.has(Number(b.dataset.key))) continue;
                    b.checked = e.target.checked;
                    const g = b.closest('.lut-import-group');
                    if (g) touched.add(g);
                }
                if (group) touched.add(group);
                for (const g of touched) syncGroupCheck(g);
            } else {
                return;
            }
            updateConfirm();
        });

        els.keepFolders?.addEventListener('change', () => { if (scan) renderNotes(); });
        els.wrap?.addEventListener('change', () => {
            if (els.wrapName) els.wrapName.disabled = !els.wrap.checked;
            if (scan) renderNotes();
        });
    }

    return { bind, start, cancel };
}
