// Tela Envio: YouTube Studio embutido + fila de envio automático (opcional, Configurações → Mídia).
// A fila vive no processo principal (window.bds.youtubeUpload); aqui só se desenha o estado e se repassam cliques.

let waitTimer = null;
let unsubscribers = [];
let queueState = null;
let editingId = null;
const STATUS_LABEL = {
    queued: 'Na fila',
    uploading: 'Enviando',
    done: 'Enviado',
    failed: 'Falhou',
    cancelled: 'Cancelado'
};
const VISIBILITY_LABEL = { private: 'Privado', unlisted: 'Não listado', public: 'Público' };
const AUDIENCE_LABEL = { not_kids: 'Não é para crianças', kids: 'É para crianças' };

export function onLeave() {
    clearInterval(waitTimer);
    waitTimer = null;
    for (const off of unsubscribers) { try { off(); } catch (_) { /* já removido */ } }
    unsubscribers = [];
}

export async function initScreen() {
    console.log('[UPLOAD] Inicializando tela do YouTube Studio...');

    const webview = document.getElementById('youtubeStudioWebview');

    const overlay = document.getElementById('uploadOverlay');
    const setOverlay = (state, title, text) => {
        if (!overlay) return;
        overlay.classList.toggle('visible', state !== 'hidden');
        overlay.classList.toggle('is-error', state === 'error');
        document.getElementById('btnUploadRetry')?.classList.toggle('hidden', state !== 'error');
        if (title) document.getElementById('uploadOverlayTitle').textContent = title;
        if (text) document.getElementById('uploadOverlayText').textContent = text;
    };
    document.getElementById('btnUploadRetry')?.addEventListener('click', () => {
        setOverlay('loading', 'Carregando o YouTube Studio…', 'Se demorar, verifique sua conexão com a internet.');
        try { webview?.reload(); } catch (_) { try { webview.src = 'https://studio.youtube.com'; } catch (__) { /* sem webview */ } }
    });

    if (webview) {
        webview.addEventListener('did-start-loading', () => setOverlay('loading', 'Carregando o YouTube Studio…', 'Se demorar, verifique sua conexão com a internet.'));
        webview.addEventListener('did-stop-loading', () => setOverlay('hidden'));
        webview.addEventListener('did-fail-load', (e) => {
            // -3 = carregamento interrompido por uma nova navegação (não é erro); só importa a página principal
            if (e && (e.errorCode === -3 || e.isMainFrame === false)) return;
            setOverlay('error', 'Não foi possível abrir o YouTube Studio', 'Verifique sua conexão com a internet e tente novamente.');
        });
    }

    await initQueuePanel(webview);
}

/* ==========================================================================
   FILA DE ENVIO AUTOMÁTICO
   ========================================================================== */

const api = () => (window.bds && window.bds.youtubeUpload) || null;
const toast = (msg, type = 'info') => { try { window.bdsToast?.(msg, { type }); } catch (_) { /* sem toast */ } };

async function initQueuePanel(webview) {
    const panel = document.getElementById('uploadQueuePanel');
    const expandBtn = document.getElementById('btnUploadQueueExpand');
    if (!panel || !api()) return;

    // O recurso é opcional e desligado por padrão: sem ele a tela fica só com o YouTube Studio
    let enabled = false;
    try {
        const s = await window.bds.getSettings?.();
        enabled = !!(s && s.uploadAutoEnabled);
    } catch (_) { enabled = false; }
    if (!enabled) { panel.classList.add('hidden'); expandBtn?.classList.add('hidden'); return; }

    const collapsed = readCollapsed();
    panel.classList.toggle('hidden', collapsed);
    expandBtn?.classList.toggle('hidden', !collapsed);

    document.getElementById('btnUploadQueueCollapse')?.addEventListener('click', () => setCollapsed(true));
    expandBtn?.addEventListener('click', () => setCollapsed(false));

    document.getElementById('btnUploadAdd')?.addEventListener('click', async () => {
        try {
            const added = await api().pick();
            if (Array.isArray(added) && added.length) toast(added.length === 1 ? '1 vídeo adicionado à fila.' : `${added.length} vídeos adicionados à fila.`, 'success');
        } catch (err) { toast(err?.message || 'Não foi possível adicionar os vídeos.', 'error'); }
    });
    document.getElementById('btnUploadStart')?.addEventListener('click', () => startQueue(webview));
    document.getElementById('btnUploadResume')?.addEventListener('click', () => startQueue(webview));
    document.getElementById('btnUploadPause')?.addEventListener('click', async () => {
        try { await api().pause(); } catch (_) { /* estado chega pelo evento */ }
    });
    document.getElementById('btnUploadSkipWait')?.addEventListener('click', async () => {
        try { await api().skipWait(); } catch (_) { /* ignorado */ }
    });
    document.getElementById('btnUploadClearDone')?.addEventListener('click', async () => {
        try { await api().clearCompleted(); } catch (_) { /* ignorado */ }
    });

    // Padrões para todos os vídeos (descrição e playlist)
    document.getElementById('uploadDefaultsForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const applyEl = document.getElementById('uploadDefaultsApply');
        const payload = {
            description: document.getElementById('uploadDefaultsDescription')?.value || '',
            playlist: (document.getElementById('uploadDefaultsPlaylist')?.value || '').trim(),
            audience: document.getElementById('uploadDefaultsAudience')?.value || '',
            applyToQueued: !!applyEl?.checked
        };
        try {
            const r = await api().setDefaults(payload);
            if (r && r.ok === false) { toast(r.error || 'Não foi possível salvar os padrões.', 'error'); return; }
            if (applyEl) applyEl.checked = false;
            toast(payload.applyToQueued ? 'Padrões salvos e aplicados aos vídeos da fila.' : 'Padrões salvos para os próximos vídeos.', 'success');
        } catch (err) { toast(err?.message || 'Não foi possível salvar os padrões.', 'error'); }
    });

    // Arrastar arquivos para a fila
    panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('is-dragover'); });
    panel.addEventListener('dragleave', () => panel.classList.remove('is-dragover'));
    panel.addEventListener('drop', async (e) => {
        e.preventDefault();
        panel.classList.remove('is-dragover');
        const files = [...(e.dataTransfer?.files || [])];
        const paths = files.map((f) => { try { return window.bds.getPathForFile?.(f); } catch (_) { return null; } }).filter(Boolean);
        if (!paths.length) return;
        try {
            const added = await api().add(paths);
            if (!added?.length) toast('Nenhum arquivo de vídeo reconhecido.', 'error');
        } catch (err) { toast(err?.message || 'Não foi possível adicionar os vídeos.', 'error'); }
    });

    // Lista: editar / remover / tentar de novo (delegação)
    const list = document.getElementById('uploadQueueList');
    list?.addEventListener('click', onListClick);
    list?.addEventListener('submit', onEditSubmit);

    bindQueueEvents();
    try { renderQueue(await api().getState()); } catch (_) { /* fila indisponível */ }
}

function readCollapsed() {
    try { return localStorage.getItem('bds.uploadQueue.collapsed') === '1'; } catch (_) { return false; }
}
function setCollapsed(on) {
    try { localStorage.setItem('bds.uploadQueue.collapsed', on ? '1' : '0'); } catch (_) { /* sem storage */ }
    document.getElementById('uploadQueuePanel')?.classList.toggle('hidden', on);
    document.getElementById('btnUploadQueueExpand')?.classList.toggle('hidden', !on);
}

async function startQueue(webview) {
    let id = 0;
    try { id = webview?.getWebContentsId?.() || 0; } catch (_) { id = 0; }
    if (!id) { toast('A página do YouTube Studio ainda não carregou. Aguarde e tente de novo.', 'error'); return; }
    try {
        const r = await api().start(id);
        if (r && r.ok === false) toast(r.error || 'Não foi possível iniciar a fila.', 'error');
    } catch (err) { toast(err?.message || 'Não foi possível iniciar a fila.', 'error'); }
}

function bindQueueEvents() {
    const a = api();
    if (!a) return;
    const sub = (fn, cb) => { if (typeof fn === 'function') { const off = fn(cb); if (typeof off === 'function') unsubscribers.push(off); } };
    sub(a.onUpdated, (state) => renderQueue(state));
    sub(a.onWait, (data) => showWait(data && data.until));
    sub(a.onAttention, (data) => toast(data?.message || 'A fila precisa da sua atenção.', 'error'));
    sub(a.onItemDone, (item) => toast(`Enviado: ${item?.title || item?.name || 'vídeo'}`, 'success'));
    sub(a.onItemFailed, (item) => toast(`Falhou: ${item?.name || 'vídeo'}. ${item?.error || ''}`.trim(), 'error'));
}

function fmtClock(sec) {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Contagem regressiva da pausa entre envios (until = instante final em ms; null esconde). */
function showWait(until) {
    const box = document.getElementById('uploadWaitNote');
    const text = document.getElementById('uploadWaitText');
    clearInterval(waitTimer);
    waitTimer = null;
    if (!box || !text) return;
    if (!until) { box.classList.add('hidden'); return; }
    const tick = () => {
        const left = (until - Date.now()) / 1000;
        if (left <= 0) { box.classList.add('hidden'); clearInterval(waitTimer); waitTimer = null; return; }
        text.textContent = `Próximo envio em ${fmtClock(left)}.`;
        box.classList.remove('hidden');
    };
    tick();
    waitTimer = setInterval(tick, 1000);
}

function renderQueue(state) {
    if (!state || !Array.isArray(state.items)) return;
    queueState = state;
    const items = state.items;
    const list = document.getElementById('uploadQueueList');
    const empty = document.getElementById('uploadQueueEmpty');
    const tpl = document.getElementById('uploadQueueItemTemplate');
    if (!list || !tpl) return;

    // Botões
    const running = !!state.running;
    const hasQueued = items.some((i) => i.status === 'queued');
    document.getElementById('btnUploadStart')?.classList.toggle('hidden', running);
    document.getElementById('btnUploadPause')?.classList.toggle('hidden', !running);
    const startBtn = document.getElementById('btnUploadStart');
    if (startBtn) startBtn.disabled = !hasQueued;
    document.getElementById('btnUploadClearDone')?.classList.toggle('hidden', !items.some((i) => ['done', 'failed', 'cancelled'].includes(i.status)));

    // Resumo
    const meta = document.getElementById('uploadQueueMeta');
    if (meta) {
        const done = items.filter((i) => i.status === 'done').length;
        const parts = [];
        if (items.length) parts.push(`${items.length} na fila${done ? `, ${done} enviado${done > 1 ? 's' : ''}` : ''}`);
        if (state.dailyLimit > 0) parts.push(`Hoje: ${state.doneToday} de ${state.dailyLimit}`);
        if (state.paused && !running) parts.push('Pausada');
        meta.textContent = parts.join(' · ');
    }

    // Padrões da fila: preenche o formulário só quando o usuário não está editando nele
    const d = state.defaults || { description: '', playlist: '', audience: '' };
    const descEl = document.getElementById('uploadDefaultsDescription');
    const plEl = document.getElementById('uploadDefaultsPlaylist');
    const audEl = document.getElementById('uploadDefaultsAudience');
    const form = document.getElementById('uploadDefaultsForm');
    if (form && !form.contains(document.activeElement)) {
        if (descEl) descEl.value = d.description || '';
        if (plEl) plEl.value = d.playlist || '';
        if (audEl) audEl.value = d.audience || '';
    }
    const hint = document.getElementById('uploadDefaultsHint');
    if (hint) {
        const bits = [];
        if (d.description) bits.push('descrição');
        if (d.playlist) bits.push(`playlist "${d.playlist}"`);
        if (AUDIENCE_LABEL[d.audience]) bits.push(AUDIENCE_LABEL[d.audience].toLowerCase());
        hint.textContent = bits.length ? bits.join(' · ') : '';
    }

    // Atenção (verificação do Google / limite diário)
    const att = document.getElementById('uploadAttentionNote');
    const attText = document.getElementById('uploadAttentionText');
    if (att && attText) {
        att.classList.toggle('hidden', !state.attention);
        if (state.attention) attText.textContent = state.attention.message || '';
        document.getElementById('btnUploadResume')?.classList.toggle('hidden', state.attention?.kind === 'limit');
    }
    if (!state.waitUntil) showWait(null); else showWait(state.waitUntil);

    // Lista (reaproveita <li> existentes pelo id para não perder o formulário aberto)
    const byId = new Map([...list.children].map((li) => [li.dataset.id, li]));
    const seen = new Set();
    items.forEach((item, idx) => {
        let li = byId.get(item.id);
        if (!li) {
            li = tpl.content.firstElementChild.cloneNode(true);
            li.dataset.id = item.id;
        }
        fillItem(li, item);
        seen.add(item.id);
        if (list.children[idx] !== li) list.insertBefore(li, list.children[idx] || null);
    });
    for (const [id, li] of byId) if (!seen.has(id)) li.remove();
    if (editingId && !seen.has(editingId)) editingId = null;

    empty?.classList.toggle('hidden', items.length > 0);
    const count = document.getElementById('uploadQueueExpandCount');
    if (count) {
        const pending = items.filter((i) => i.status === 'queued' || i.status === 'uploading').length;
        count.textContent = String(pending);
        count.classList.toggle('hidden', pending === 0);
    }
}

function fillItem(li, item) {
    li.dataset.status = item.status;
    li.dataset.audience = AUDIENCE_LABEL[item.audience] ? 'set' : 'missing';
    li.querySelector('.bds-upl-item-title').textContent = item.title || item.name;
    const sub = [STATUS_LABEL[item.status] || item.status];
    if (item.status === 'uploading') sub[0] = `${item.stage || 'Enviando'} ${item.progress ? `${item.progress}%` : ''}`.trim();
    if (item.status === 'failed' && item.error) sub.push(item.error);
    else if (item.status !== 'uploading') {
        sub.push(VISIBILITY_LABEL[item.visibility] || item.visibility);
        sub.push(AUDIENCE_LABEL[item.audience] || 'Escolher se é para crianças');
        if (item.playlist) sub.push(`playlist "${item.playlist}"`);
        if (item.thumbnail) sub.push('miniatura');
        if (Array.isArray(item.warnings) && item.warnings.length) sub.push(item.warnings.join(' '));
    }
    const subEl = li.querySelector('.bds-upl-item-sub');
    subEl.textContent = sub.join(' · ');
    subEl.title = subEl.textContent; // texto inteiro ao passar o mouse, caso a linha seja cortada
    const icon = li.querySelector('.bds-upl-item-icon');
    if (icon) icon.textContent = { done: 'check_circle', failed: 'error', cancelled: 'block', uploading: 'cloud_upload' }[item.status] || 'movie';

    const prog = li.querySelector('.bds-upl-progress');
    if (prog) {
        prog.classList.toggle('hidden', item.status !== 'uploading');
        prog.setAttribute('aria-valuenow', String(item.progress || 0));
        prog.querySelector('.bds-upl-progress-bar').style.width = `${item.progress || 0}%`;
    }
    const editable = item.status === 'queued' || item.status === 'failed';
    li.querySelector('.bds-upl-item-edit')?.classList.toggle('hidden', !editable);
    li.querySelector('.bds-upl-item-retry')?.classList.toggle('hidden', item.status !== 'failed');
    if (!editable && editingId === item.id) { editingId = null; li.querySelector('.bds-upl-item-form')?.classList.add('hidden'); }
}

function onListClick(e) {
    const li = e.target.closest('.bds-upl-item');
    if (!li) return;
    const id = li.dataset.id;
    const item = queueState?.items.find((i) => i.id === id);
    if (!item) return;
    if (e.target.closest('.bds-upl-item-remove')) {
        api()?.remove(id).catch(() => {});
    } else if (e.target.closest('.bds-upl-item-retry')) {
        api()?.retry(id).catch(() => {});
    } else if (e.target.closest('.bds-upl-item-edit')) {
        toggleEdit(li, item);
    } else if (e.target.closest('.bds-upl-f-cancel')) {
        li.querySelector('.bds-upl-item-form')?.classList.add('hidden');
        editingId = null;
    } else if (e.target.closest('.bds-upl-f-thumb-pick')) {
        pickThumbnail(li, id);
    } else if (e.target.closest('.bds-upl-f-thumb-clear')) {
        api()?.update(id, { thumbnail: '' }).then((r) => {
            if (r && r.ok === false) toast(r.error || 'Não foi possível remover a miniatura.', 'error');
            else renderThumbRow(li.querySelector('.bds-upl-item-form'), '');
        }).catch(() => {});
    }
}

async function pickThumbnail(li, id) {
    try {
        const r = await api().pickThumbnail(id);
        if (!r || r.cancelled) return;
        if (r.ok === false) { toast(r.error || 'Não foi possível usar essa imagem.', 'error'); return; }
        renderThumbRow(li.querySelector('.bds-upl-item-form'), r.thumbnail);
    } catch (err) { toast(err?.message || 'Não foi possível escolher a miniatura.', 'error'); }
}

/** Linha da miniatura no formulário: nome do arquivo (ou aviso de automática) e botões. */
function renderThumbRow(form, thumbnail) {
    if (!form) return;
    const name = form.querySelector('.bds-upl-f-thumb-name');
    const file = thumbnail ? String(thumbnail).split(/[\\/]/).pop() : '';
    if (name) name.textContent = file || 'Nenhuma (o YouTube escolhe)';
    if (name) name.title = thumbnail || '';
    form.querySelector('.bds-upl-f-thumb-clear')?.classList.toggle('hidden', !thumbnail);
}

function toggleEdit(li, item) {
    const form = li.querySelector('.bds-upl-item-form');
    if (!form) return;
    const open = form.classList.contains('hidden');
    // Só um formulário de vídeo aberto por vez (o de "Para todos os vídeos" é outro painel e não pode ser escondido aqui)
    document.querySelectorAll('.bds-upl-item .bds-upl-item-form:not(.hidden)').forEach((f) => f.classList.add('hidden'));
    if (!open) { editingId = null; return; }
    form.querySelector('.bds-upl-f-title').value = item.title || '';
    form.querySelector('.bds-upl-f-desc').value = item.description || '';
    form.querySelector('.bds-upl-f-vis').value = item.visibility || 'private';
    form.querySelector('.bds-upl-f-aud').value = item.audience || '';
    form.querySelector('.bds-upl-f-playlist').value = item.playlist || '';
    renderThumbRow(form, item.thumbnail);
    form.classList.remove('hidden');
    editingId = item.id;
    form.querySelector('.bds-upl-f-title')?.focus();
}

async function onEditSubmit(e) {
    const form = e.target.closest('.bds-upl-item-form');
    if (!form) return;
    e.preventDefault();
    const li = form.closest('.bds-upl-item');
    const id = li?.dataset.id;
    if (!id) return;
    const patch = {
        title: form.querySelector('.bds-upl-f-title').value.trim(),
        description: form.querySelector('.bds-upl-f-desc').value,
        visibility: form.querySelector('.bds-upl-f-vis').value,
        audience: form.querySelector('.bds-upl-f-aud').value,
        playlist: form.querySelector('.bds-upl-f-playlist').value.trim()
    };
    if (!patch.title) { toast('Informe um título para o vídeo.', 'error'); return; }
    try {
        const r = await api().update(id, patch);
        if (r && r.ok === false) { toast(r.error || 'Não foi possível salvar.', 'error'); return; }
        form.classList.add('hidden');
        editingId = null;
    } catch (err) { toast(err?.message || 'Não foi possível salvar.', 'error'); }
}
