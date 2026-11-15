// --- MÚLTIPLOS LINKS LOGIC ---
function showMultipleLinksModal() {
  const opener = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'multiple-links-overlay';
  overlay.id = 'multipleLinksOverlay';

  overlay.innerHTML = `
    <div class="multiple-links-modal">
      <div class="multiple-links-header">
        <span class="material-symbols-rounded" aria-hidden="true">list_alt</span>
        <h3 id="multipleLinksTitle">Adição de Múltiplos Links</h3>
      </div>
      <div class="multiple-links-body">
        <p class="multiple-links-hint">
          Cole sua lista de links abaixo. Insira <strong>um link por linha</strong>.<br>
          Linhas em branco ou anotações sem links serão ignoradas automaticamente.
        </p>
        <textarea 
          id="multipleLinksInput" 
          class="multiple-links-textarea" 
          placeholder="https://www.youtube.com/watch?v=...&#10;https://www.youtube.com/watch?v=...&#10;https://..."
          rows="8"
          spellcheck="false"
        ></textarea>
      </div>
      <div class="multiple-links-footer">
        <button class="btn-modal-cancel" id="cancelLinks">Cancelar</button>
        <button class="btn-modal-confirm" id="confirmLinks">Adicionar Links</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const modalBox = overlay.querySelector('.multiple-links-modal');
  modalBox.setAttribute('role', 'dialog');
  modalBox.setAttribute('aria-modal', 'true');
  modalBox.setAttribute('aria-labelledby', 'multipleLinksTitle');
  const textarea = overlay.querySelector('#multipleLinksInput');
  textarea.focus();
  // Ao fechar, devolve o foco ao botão que abriu o diálogo
  const closeOverlay = overlay.remove.bind(overlay);
  overlay.remove = () => {
    closeOverlay();
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
  };
  // Esc fecha; Ctrl+Enter adiciona; Tab fica preso dentro do diálogo; clique fora fecha
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); overlay.querySelector('#confirmLinks')?.click(); }
    else if (e.key === 'Tab') {
      const items = Array.from(overlay.querySelectorAll('textarea, button:not([disabled]), input:not([disabled])'))
        .filter((n) => n.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  overlay.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#cancelLinks').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#confirmLinks').addEventListener('click', () => {
    const rawText = textarea.value || '';

    // Divide por quebras de linha e limpa espaços
    const lines = rawText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    // Filtra apenas linhas que começam com http:// ou https://
    const validLinks = lines.filter(line => /^https?:\/\//i.test(line));

    if (validLinks.length === 0) {
      setStatus('Nenhum link válido encontrado. Certifique-se de que os links começam com http:// ou https://');
      textarea.focus();
      return;
    }

    // Fecha na hora: os cartões aparecem na fila e as informações (título, miniatura...) chegam depois, um link por vez
    overlay.remove();
    enqueueManyLinks(validLinks);
  });

  // Fechar ao clicar fora do modal
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}
import { els, state, setStatus, escapeHtml } from '../app.js';

/** Mensagem de erro em português simples, sem prefixos técnicos nem nomes de motores. */
function ipcMsg(err) {
  return friendlyError(err, '');
}
import { friendlyError } from '../utils/friendlyError.js';

let metadataTimer = null;
let metadataSeq = 0;

/** Metadados em cache só valem para a URL em que foram buscados (evita aplicar dados de outro link). */
function metadataFor(url) {
  return state.metadata && state.metadataUrl === url ? state.metadata : null;
}

export function initScreen() {
  console.log('[DOWNLOAD] Inicializando tela...');
  setStatus('Pronto.');
  setControlsEnabled(true);

  if (els.urlInput) {
    els.urlInput.addEventListener('input', () => {
      clearTimeout(metadataTimer);
      metadataTimer = setTimeout(loadMetadata, 300);
    });

    // Enter adiciona o link à fila (menos um clique)
    els.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addToQueue(); }
    });

    els.urlInput.addEventListener('paste', () => {
      clearTimeout(metadataTimer);
      metadataTimer = setTimeout(loadMetadata, 100);
    });
  }

  if (els.metadataButton) {
    els.metadataButton.addEventListener('click', addToQueue);
  }
  if (els.mp3Button) {
    els.mp3Button.addEventListener('click', () => startDownloadDirect('MP3'));
  }
  if (els.mp4Button) {
    els.mp4Button.addEventListener('click', () => startDownloadDirect('MP4'));
  }
  if (els.stopButton) {
    els.stopButton.addEventListener('click', pauseQueue);
  }

  const btnStartQueue = document.getElementById('btnStartQueue');
  const btnPauseQueue = document.getElementById('btnPauseQueue');
  const btnClearCompleted = document.getElementById('btnClearCompleted');
  const btnClearAll = document.getElementById('btnClearAll');
  const btnQueueAllMp3 = document.getElementById('btnQueueAllMp3');
  const btnQueueAllMp4 = document.getElementById('btnQueueAllMp4');
  const btnMultipleLinks = document.getElementById('btnMultipleLinks');

  if (btnStartQueue) btnStartQueue.addEventListener('click', startQueue);
  if (btnPauseQueue) btnPauseQueue.addEventListener('click', pauseQueue);
  if (btnClearCompleted) btnClearCompleted.addEventListener('click', clearCompleted);
  if (btnClearAll) btnClearAll.addEventListener('click', clearAllQueue);
  if (btnQueueAllMp3) btnQueueAllMp3.addEventListener('click', () => convertAllQueueTo('MP3'));
  if (btnQueueAllMp4) btnQueueAllMp4.addEventListener('click', () => convertAllQueueTo('MP4'));
  if (btnMultipleLinks) btnMultipleLinks.addEventListener('click', showMultipleLinksModal);
  // O menu "Mais ações" fecha ao escolher uma ação
  document.querySelector('.queue-more')?.addEventListener('click', (e) => {
    if (e.target.closest('.queue-btn-menu')) e.currentTarget.open = false;
  });

  if (state.metadata) {
    renderMetadata(state.metadata);
  }

  document.getElementById('btnSkipWait')?.addEventListener('click', () => {
    window.bds.downloads.skipWait?.();
  });
  bindWaitEvents();
  refreshSessionNote();
  refreshWaitState();

  fetchQueue();
}

// ---- Sessão do YouTube e pausa entre downloads ----
let waitTimer = null;
let waitBound = false;

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Mostra a contagem da pausa entre downloads (until = instante final em ms; null esconde). */
function showWait(until) {
  const box = document.getElementById('downloadWaitNote');
  const text = document.getElementById('downloadWaitText');
  clearInterval(waitTimer);
  waitTimer = null;
  if (!box || !text) return;
  if (!until) { box.classList.add('hidden'); return; }
  const tick = () => {
    const left = (until - Date.now()) / 1000;
    if (left <= 0) { box.classList.add('hidden'); clearInterval(waitTimer); waitTimer = null; return; }
    text.textContent = `Aguardando ${fmtClock(left)} antes do próximo download (pausa entre os itens da lista).`;
    box.classList.remove('hidden');
  };
  tick();
  waitTimer = setInterval(tick, 1000);
}

function bindWaitEvents() {
  if (waitBound || !window.bds.downloads.onWait) return;
  waitBound = true;
  window.bds.downloads.onWait((data) => showWait(data && data.until));
}

async function refreshWaitState() {
  try {
    const st = await window.bds.downloads.getWaitState?.();
    showWait(st && st.until);
  } catch (_) { /* sem pausa em andamento */ }
}

/** Linha discreta: há sessão do YouTube válida (downloads autenticados) ou não. */
async function refreshSessionNote() {
  const el = document.getElementById('downloadSessionNote');
  if (!el) return;
  try {
    const st = await window.bds.downloads.cookiesStatus?.();
    if (st && st.valid) {
      const until = st.expiresAt ? ` (válida até ${new Date(st.expiresAt).toLocaleDateString('pt-BR')})` : '';
      el.textContent = `Sessão do YouTube ativa${until}: os downloads usam a sua conta.`;
      el.classList.add('active');
    } else {
      el.textContent = 'Sem sessão do YouTube. Entre na conta pela aba Envio para baixar vídeos que exigem login.';
      el.classList.remove('active');
    }
  } catch (_) { el.textContent = ''; }
}


function getDownloadsApi() {
  return window.bds.downloads; // o preload sempre expõe a API de downloads
}

async function fetchQueue() {
  try {
    const api = getDownloadsApi();
    const queue = await api.getQueue();
    state.downloadQueue = queue || [];
    renderDownloadQueue(state.downloadQueue);
  } catch (err) {
    console.error('[DOWNLOAD] Erro ao buscar fila:', err);
  }
}

// As assinaturas de progresso/fila (onProgress/onUpdated) ficam SOMENTE em app.js (um unico assinante),
// que repassa para renderDownloadQueue / updateProgressVisuals exportados aqui.

export function onLeave() {
  clearInterval(waitTimer);
  waitTimer = null;
  clearTimeout(metadataTimer);
  metadataTimer = null;
}

export function onEnter() {
  // Atualiza a fila (pode ter mudado enquanto a tela estava oculta)
  fetchQueue();
  refreshSessionNote();
  refreshWaitState();
}

// ---- Renderização da fila: diff por item.id (apenas linhas alteradas são recriadas) ----
const rowCache = new Map();   // id -> { sig, el, fill, pct, bytes, speed }
let queueEmptyShown = false;
let queueDelegated = false;

function buildRowHtml(item, dyn) {
  const prog = dyn ? (item.progress || 0) : 0;
  const speed = dyn ? (item.speed || '--') : '--';
  const eta = dyn ? item.eta : '';
    let statusBadge = '';
    let actionsHtml = '';
    let cardClass = 'download-card';
    const loadingInfo = Boolean(item.infoLoading) && item.status === 'queued';
    if (loadingInfo) cardClass += ' is-loading';

    if (item.status === 'queued') {
      statusBadge = `<span class="status-badge status-badge-queued">Aguardando</span>`;
      actionsHtml = `
        <button type="button" class="card-action-btn card-action-btn-default" data-action="reorder-up" data-id="${item.id}" title="Mover para cima">
          <span class="material-symbols-rounded">arrow_upward</span>
        </button>
        <button type="button" class="card-action-btn card-action-btn-default" data-action="reorder-down" data-id="${item.id}" title="Mover para baixo">
          <span class="material-symbols-rounded">arrow_downward</span>
        </button>
        <button type="button" class="card-action-btn card-action-btn-danger" data-action="remove" data-id="${item.id}" title="Remover">
          <span class="material-symbols-rounded">close</span>
        </button>
      `;
    } else if (item.status === 'downloading') {
      statusBadge = `<span class="status-badge status-badge-downloading">Baixando</span>`;
      cardClass += ' status-downloading';
      actionsHtml = `
        <button type="button" class="card-action-btn card-action-btn-danger" data-action="cancel" data-id="${item.id}" title="Cancelar">
          <span class="material-symbols-rounded">cancel</span>
        </button>
      `;
    } else if (item.status === 'paused') {
      statusBadge = `<span class="status-badge status-badge-paused">Pausado</span>`;
      actionsHtml = `
        <button type="button" class="card-action-btn card-action-btn-warning" data-action="retry" data-id="${item.id}" title="Retomar">
          <span class="material-symbols-rounded">play_arrow</span>
        </button>
        <button type="button" class="card-action-btn card-action-btn-default" data-action="remove" data-id="${item.id}" title="Remover">
          <span class="material-symbols-rounded">close</span>
        </button>
      `;
    } else if (item.status === 'completed') {
      const isSkipped = item.error && item.error.includes('já existe');
      statusBadge = isSkipped
        ? `<span class="status-badge status-badge-skipped" title="${escapeHtml(friendlyError(item.error, "Já existe na pasta de destino."))}">↷ Já existe</span>`
        : `<span class="status-badge status-badge-completed">✓ Concluído</span>`;
      actionsHtml = `
        ${item.outputPath ? `<button type="button" class="card-action-btn card-action-btn-info" data-action="open-path" data-path="${escapeAttr(item.outputPath)}" title="Abrir arquivo">
          <span class="material-symbols-rounded">play_arrow</span>
        </button>
        <button type="button" class="card-action-btn card-action-btn-info" data-action="reveal-path" data-path="${escapeAttr(item.outputPath)}" title="Mostrar na pasta">
          <span class="material-symbols-rounded">folder_open</span>
        </button>` : ''}
        <button type="button" class="card-action-btn card-action-btn-default" data-action="remove" data-id="${item.id}" title="Remover">
          <span class="material-symbols-rounded">close</span>
        </button>
      `;
    } else if (item.status === 'failed' || item.status === 'cancelled') {
      const isFailed = item.status === 'failed';
      statusBadge = `<span class="status-badge ${isFailed ? 'status-badge-failed' : 'status-badge-cancelled'}" title="${escapeHtml(friendlyError(item.error, "Não foi possível baixar. Confira o link e tente de novo."))}">${isFailed ? '✕ Falhou' : 'Cancelado'}</span>`;
      actionsHtml = `
        <button type="button" class="card-action-btn card-action-btn-warning" data-action="retry" data-id="${item.id}" title="Tentar novamente">
          <span class="material-symbols-rounded">replay</span>
        </button>
        <button type="button" class="card-action-btn card-action-btn-default" data-action="remove" data-id="${item.id}" title="Remover">
          <span class="material-symbols-rounded">close</span>
        </button>
      `;
    }

    const thumbHtml = item.thumbnail
      ? `<img src="${escapeHtml(item.thumbnail)}" class="download-card-thumb" loading="lazy" decoding="async" alt="" />`
      : `<div class="download-card-thumb-placeholder"><span class="material-symbols-rounded">movie</span></div>`;

    let formatAndQualitySelectors = '';
    if (item.status === 'queued') {
      const isSpot = isSpotify(item.url || '');
      const isMp3 = item.format === 'MP3' || isSpot;
      const qualityOptions = isMp3 ? `
        <option value="320kbps" ${item.quality === '320kbps' || item.quality === 'best' ? 'selected' : ''}>320 kbps</option>
        <option value="256kbps" ${item.quality === '256kbps' ? 'selected' : ''}>256 kbps</option>
        <option value="192kbps" ${item.quality === '192kbps' ? 'selected' : ''}>192 kbps</option>
        <option value="128kbps" ${item.quality === '128kbps' ? 'selected' : ''}>128 kbps</option>
      ` : `
        <option value="best" ${item.quality === 'best' ? 'selected' : ''}>Melhor disponível</option>
        <option value="2160p" ${item.quality === '2160p' ? 'selected' : ''}>2160p (4K)</option>
        <option value="1440p" ${item.quality === '1440p' ? 'selected' : ''}>1440p (2K)</option>
        <option value="1080p" ${item.quality === '1080p' ? 'selected' : ''}>1080p (FHD)</option>
        <option value="720p" ${item.quality === '720p' ? 'selected' : ''}>720p (HD)</option>
        <option value="480p" ${item.quality === '480p' ? 'selected' : ''}>480p</option>
        <option value="360p" ${item.quality === '360p' ? 'selected' : ''}>360p</option>
      `;

      formatAndQualitySelectors = `
        <div class="download-card-selectors">
          <select class="download-card-select" data-action="toggle-format" data-id="${item.id}" ${isSpot ? 'disabled title="Links de música são suportados apenas em MP3"' : ''}>
            <option value="MP4" ${!isMp3 ? 'selected' : ''}>MP4</option>
            <option value="MP3" ${isMp3 ? 'selected' : ''}>MP3</option>
          </select>
          <select class="download-card-select" data-action="update-quality" data-id="${item.id}">
            ${qualityOptions}
          </select>
        </div>
      `;
    } else {
      formatAndQualitySelectors = `
        <span class="download-card-format-badge">
          ${escapeHtml(item.format)} • ${escapeHtml(item.quality)}${item.videoCodec ? ` • ${escapeHtml(item.videoCodec)}` : ''}
        </span>
      `;
    }

    const channelText = item.channel ? escapeHtml(item.channel) : escapeHtml(friendlyPlatform(item.platform));
    const durationText = item.duration ? formatDuration(item.duration) : '';
    const platformText = escapeHtml(friendlyPlatform(item.platform));
    const metaSubtitle = loadingInfo
      ? `${platformText} • <span class="dl-skeleton">Carregando informações...</span>`
      : `${channelText}${platformText === channelText ? '' : ' • ' + platformText}${durationText ? ' • ' + durationText : ''}`;

    return `
      <div class="${cardClass}" data-item-id="${item.id}">
        <div class="download-card-top">
          <div class="download-card-info">
            ${thumbHtml}
            <div class="download-card-details">
              <span class="download-card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
              <span class="download-card-subtitle">${metaSubtitle}</span>
            </div>
          </div>
          ${formatAndQualitySelectors}
        </div>

        <div class="download-card-bottom">
          <div class="download-card-progress-section">
            <div class="download-card-progress-track">
              <div class="download-card-progress-fill dl-row-fill" style="width: ${prog}%;"></div>
            </div>
            <div class="download-card-progress-info">
              <span class="dl-row-pct">${Math.round(prog)}%</span>
              <span class="dl-row-bytes">${dyn ? escapeHtml(bytesText(item)) : ''}</span>
              <span class="speed-info">${escapeHtml(speed)} ${eta ? '• Restante ' + escapeHtml(eta) : ''}</span>
            </div>
          </div>
          <div class="download-card-actions">
            ${statusBadge}
            <div class="download-card-buttons">
              ${actionsHtml}
            </div>
          </div>
        </div>
      </div>
    `;
}

function bindQueueDelegation(container) {
  if (queueDelegated) return;
  queueDelegated = true;
  const onClick = (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'SELECT') return;
    e.stopPropagation();
    handleQueueAction(btn.dataset.action, btn.dataset.id, btn.dataset.path);
  };
  container.addEventListener('click', onClick);
  container.addEventListener('change', (e) => {
    const select = e.target.closest('select[data-action]');
    if (!select) return;
    if (select.dataset.action === 'toggle-format') toggleItemFormat(select.dataset.id, select.value);
    else if (select.dataset.action === 'update-quality') updateItemQuality(select.dataset.id, select.value);
  });
}

function rowFromHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

/** "12,3 MB / 80 MB" (vazio enquanto o tamanho total é desconhecido). */
function bytesText(item) {
  return item.totalBytes ? `${formatBytes(item.downloadedBytes)} / ${formatBytes(item.totalBytes)}` : '';
}

function patchRowProgress(entry, item) {
  if (typeof item.progress !== 'number') return;
  if (entry.fill) entry.fill.style.width = `${item.progress}%`;
  if (entry.pct) entry.pct.textContent = `${Math.round(item.progress)}%`;
  if (entry.bytes) entry.bytes.textContent = bytesText(item);
  if (entry.speed) entry.speed.textContent = `${item.speed || '--'} ${item.eta ? '• Restante ' + item.eta : ''}`;
}

export function renderDownloadQueue(queue) {
  const container = document.getElementById('downloadQueueContainer');
  if (!container) return;

  const items = queue || [];

  // Tela oculta: não gasta DOM; onEnter busca a fila de novo e desenha
  const viewEl = container.closest('.view');
  if (viewEl && viewEl.classList.contains('hidden')) return;
  bindQueueDelegation(container);

  // Métricas (uma passada)
  let queuedCount = 0, completedCount = 0, failedCount = 0, activeItem = null;
  for (const i of items) {
    if (i.status === 'queued') queuedCount++;
    else if (i.status === 'completed') completedCount++;
    else if (i.status === 'failed') failedCount++;
    else if (i.status === 'downloading' && !activeItem) activeItem = i;
  }
  const total = items.length;
  const activeCount = activeItem ? 1 : 0;
  const setText = (id, v) => { const el = document.getElementById(id); if (el && el.textContent !== String(v)) el.textContent = v; };
  document.querySelector('.queue-metrics')?.classList.toggle('hidden', total === 0);
  setText('metricTotal', total);
  setText('metricQueued', queuedCount);
  setText('metricActive', activeCount);
  setText('metricCompleted', completedCount);
  setText('metricFailed', failedCount);

  if (items.length === 0) {
    rowCache.clear();
    container.innerHTML = `<div class="queue-empty-state">Nenhum download na fila.<br>Cole um link de vídeo ou música no campo acima e pressione <strong>Enter</strong>.<br>Para vários links de uma vez, use <strong>Múltiplos Links</strong>.</div>`;
    queueEmptyShown = true;
    setBusy(false);
    return;
  }
  if (queueEmptyShown) { container.innerHTML = ''; queueEmptyShown = false; }

  const seen = new Set();
  items.forEach((item, idx) => {
    const key = String(item.id);
    seen.add(key);
    const sig = buildRowHtml(item, false);
    let entry = rowCache.get(key);
    if (!entry || entry.sig !== sig || entry.el.parentNode !== container) {
      const el = rowFromHtml(buildRowHtml(item, true));
      if (!el) return;
      if (entry && entry.el.parentNode === container) container.replaceChild(el, entry.el);
      entry = {
        sig, el,
        fill: el.querySelector('.dl-row-fill'),
        pct: el.querySelector('.dl-row-pct'),
        bytes: el.querySelector('.dl-row-bytes'),
        speed: el.querySelector('.speed-info')
      };
      rowCache.set(key, entry);
    } else if (item.status === 'downloading') {
      patchRowProgress(entry, item);
    }
    const ref = container.children[idx];
    if (ref !== entry.el) container.insertBefore(entry.el, ref || null);
  });
  for (const [key, entry] of rowCache) {
    if (!seen.has(key)) { entry.el.remove(); rowCache.delete(key); }
  }
  while (container.children.length > items.length) container.lastElementChild.remove();

  setBusy(activeCount > 0);
}

async function handleQueueAction(action, id, path) {
  switch (action) {
    case 'cancel':
      await cancelDownload(id);
      break;
    case 'remove':
      await removeQueueItem(id);
      break;
    case 'retry':
      await retryQueueItem(id);
      break;
    case 'reorder-up':
      await reorderQueue(id, 'up');
      break;
    case 'reorder-down':
      await reorderQueue(id, 'down');
      break;
    case 'open-path':
      openPath(path);
      break;
    case 'reveal-path':
      revealPath(path);
      break;
  }
}

export function updateProgressVisuals(payload) {
  if (!payload || !payload.id) return;
  const row = rowCache.get(String(payload.id));
  if (row) patchRowProgress(row, payload);
}

export function setControlsEnabled(enabled) {
  if (els.mp3Button) els.mp3Button.disabled = !enabled;
  if (els.mp4Button) els.mp4Button.disabled = !enabled;
  if (els.metadataButton) els.metadataButton.disabled = !enabled;
  if (els.urlInput) els.urlInput.disabled = !enabled;
  if (els.resolutionSelect) els.resolutionSelect.disabled = !enabled;
}

async function loadMetadata() {
  if (!els.urlInput) return;
  const url = els.urlInput.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) { state.metadata = null; setStatus('Isso não parece um link. Cole um endereço que comece com http:// ou https://'); return; }

  // Token de requisição: só a resposta mais recente (e para a URL ainda digitada) é aplicada
  const seq = ++metadataSeq;
  const isStale = () => seq !== metadataSeq || !els.urlInput || els.urlInput.value.trim() !== url;

  try {
    setStatus('Buscando informações da mídia...');
    const metadata = await window.bds.getMetadata(url);
    if (isStale()) return;
    state.metadata = metadata;
    state.metadataUrl = url;

    if (els.mediaTitle) {
      renderMetadata(metadata);
    }
    setStatus('Informações carregadas.');
  } catch (error) {
    if (isStale()) return;
    state.metadata = null;
    state.metadataUrl = null;
    setStatus(ipcMsg(error) || 'Não foi possível carregar a miniatura.');
  }
}

function renderMetadata(metadata) {
  if (!els.mediaTitle) return;
  
  els.mediaTitle.textContent = metadata.title || 'Mídia sem título';
  els.mediaChannel.textContent = metadata.channel || 'Canal não informado';
  els.mediaDuration.textContent = formatDuration(metadata.duration);
  els.mediaType.textContent = metadata.type === 'playlist' 
    ? 'Playlist' 
    : detectSource(metadata.webpageUrl || els.urlInput.value);

  if (metadata.thumbnail) {
    els.thumbnail.src = metadata.thumbnail;
    els.thumbnail.classList.remove('hidden');
    els.thumbnailPlaceholder.classList.add('hidden');
  } else {
    els.thumbnail.removeAttribute('src');
    els.thumbnail.classList.add('hidden');
    els.thumbnailPlaceholder.classList.remove('hidden');
  }
}

// --- Playlist: "só este item" ou "playlist inteira" ---
/** true se o link aponta para um item específico dentro de uma playlist (ex.: watch?v=ID&list=...). */
export function isItemInsidePlaylist(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.get('list')) return false;
    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return u.pathname.length > 1;
    return /(^|\.)youtube\.com$/.test(host) && u.searchParams.has('v');
  } catch (_) {
    return false;
  }
}

/** Diálogo simples com duas escolhas. Devolve 'single', 'playlist' ou 'cancel' (Esc ou clicar fora). */
function askPlaylistScope() {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'bds-modal playlist-choice';
    dlg.setAttribute('aria-labelledby', 'playlistChoiceTitle');
    dlg.setAttribute('aria-describedby', 'playlistChoiceText');

    const content = document.createElement('div');
    content.className = 'bds-modal-content';

    const header = document.createElement('div');
    header.className = 'bds-modal-header';
    const icon = document.createElement('span');
    icon.className = 'material-symbols-rounded bds-modal-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'queue_music';
    const title = document.createElement('h3');
    title.id = 'playlistChoiceTitle';
    title.textContent = 'Este link faz parte de uma playlist';
    header.append(icon, title);

    const body = document.createElement('div');
    body.className = 'bds-modal-body';
    const text = document.createElement('p');
    text.id = 'playlistChoiceText';
    text.textContent = 'Quer baixar só este item ou todos os itens da playlist?';
    body.append(text);

    const footer = document.createElement('div');
    footer.className = 'bds-modal-footer';
    const btnAll = document.createElement('button');
    btnAll.type = 'button';
    btnAll.className = 'bds-btn-secondary';
    btnAll.textContent = 'Playlist inteira';
    const btnOne = document.createElement('button');
    btnOne.type = 'button';
    btnOne.className = 'bds-btn-primary';
    btnOne.textContent = 'Só este item';
    footer.append(btnAll, btnOne);

    content.append(header, body, footer);
    dlg.append(content);

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { dlg.close(); } catch (_) { /* já fechado */ }
      dlg.remove();
      resolve(value);
    };
    btnOne.addEventListener('click', () => finish('single'));
    btnAll.addEventListener('click', () => finish('playlist'));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish('cancel'); });
    dlg.addEventListener('close', () => finish('cancel'));
    // Clicar na área escura (fora do conteúdo) cancela
    dlg.addEventListener('click', (e) => { if (e.target === dlg) finish('cancel'); });

    document.body.append(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    btnOne.focus();
  });
}

/** 'auto' (link comum: segue o fluxo normal), 'single', 'playlist' ou 'cancel'. */
async function choosePlaylistScope(url) {
  if (!isItemInsidePlaylist(url)) return 'auto';
  return askPlaylistScope();
}

// ---- Adição de links: o cartão aparece na hora (nome do site + "Carregando informações...") ----
let adding = false;     // trava: Enter duplo / Enter + clique não geram cópias
let lastAddAt = 0;

/** Link que provavelmente é uma playlist/álbum inteiro: só esses passam pela análise antes de virar cartões. */
export function looksLikePlaylist(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^(www|m|music|open)\./, '');
    if (host === 'spotify.com') return /^\/(?:intl-[a-z-]+\/)?(album|playlist|artist)\//.test(u.pathname);
    if (host === 'youtu.be' || /(^|\.)youtube\.com$/.test(host)) {
      return u.pathname.startsWith('/playlist') || (u.searchParams.has('list') && !u.searchParams.has('v') && host !== 'youtu.be');
    }
    return /\/sets\//.test(u.pathname) && /soundcloud\.com$/.test(host);
  } catch (_) {
    return false;
  }
}

function dlQuality() {
  return els.resolutionSelect?.value || 'best';
}

/** Envia um link ao processo principal. Devolve { added: true } ou { duplicate: true, message, existingId }. */
async function addLink(payload) {
  const res = await getDownloadsApi().add(payload);
  if (res && res.duplicate) return { duplicate: true, message: res.error || 'Este link já está na fila.', existingId: res.existingId || null };
  return { added: true };
}

/** Aviso discreto de link repetido + destaque (e rolagem) do cartão que já existe. */
function notifyDuplicate(result) {
  const message = result.message || 'Este link já está na fila.';
  setStatus(message);
  if (typeof window.bdsToast === 'function') window.bdsToast(message, { type: 'info', duration: 4500 });
  highlightQueueItem(result.existingId);
}

function highlightQueueItem(id) {
  if (!id) return;
  const container = document.getElementById('downloadQueueContainer');
  if (!container) return;
  const el = Array.from(container.children).find((c) => c.dataset && c.dataset.itemId === String(id));
  if (!el) return;
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('dl-highlight');
  setTimeout(() => el.classList.remove('dl-highlight'), 2200);
}

/** "3 adicionados, 1 já estavam na fila ou já baixados." */
function addSummary(added, skipped, failed = 0) {
  const parts = [];
  if (!skipped && !failed) return `${added} ${added === 1 ? 'link adicionado' : 'links adicionados'} à fila.`;
  parts.push(`${added} adicionados`);
  if (skipped) parts.push(`${skipped} já estavam na fila ou já baixados`);
  if (failed) parts.push(`${failed} não puderam ser adicionados`);
  return `${parts.join(', ')}.`;
}

/** Lista de links (Múltiplos Links ou itens de playlist): duplicados são pulados e o resumo diz quantos. */
async function enqueueManyLinks(urls, { format = null, items = null } = {}) {
  let added = 0; let skipped = 0; let failed = 0;
  const list = items || urls.map((url) => ({ url }));
  setStatus(`Adicionando ${list.length} link(s) à fila...`);
  for (const it of list) {
    const isSpot = isSpotify(it.url);
    try {
      const r = await addLink({
        url: it.url,
        format: isSpot ? 'MP3' : (format || els.formatSelect?.value || 'MP4'),
        quality: dlQuality(),
        title: it.title || '',
        thumbnail: it.thumbnail || '',
        channel: it.channel || '',
        duration: it.duration || null,
        playlistTitle: it.playlistTitle || '',
        playlistThumbnail: it.playlistThumbnail || ''
      });
      if (r.duplicate) skipped++; else added++;
    } catch (err) {
      failed++;
      console.error('[DOWNLOAD] Falha ao adicionar link:', it.url, err);
    }
  }
  const text = addSummary(added, skipped, failed);
  setStatus(text);
  if (skipped && typeof window.bdsToast === 'function') window.bdsToast(text, { type: 'info', duration: 5000 });
  fetchQueue();
}

async function addToQueue() { return submitUrl(null, 'Cole um link antes de adicionar.'); }
async function startDownloadDirect(format) { return submitUrl(format, 'Cole uma URL primeiro.'); }

/**
 * Enter, "Adicionar à Fila" e MP3/MP4: limpa o campo e cria o cartão na hora. A trava impede cópias (Enter duplo,
 * Enter + clique) e é solta logo depois da escolha "Só este item / Playlist inteira", antes de qualquer trabalho
 * demorado; o próximo link já pode ser colado. A regra de link repetido vive no processo principal.
 */
async function submitUrl(format, emptyMessage) {
  if (adding) return;
  const url = (els.urlInput?.value || '').trim();
  if (!url) {
    if (Date.now() - lastAddAt < 1500) return; // segundo Enter/clique logo após adicionar: não apaga o aviso de sucesso
    setStatus(emptyMessage);
    return;
  }
  if (!/^https?:\/\//i.test(url)) { setStatus('Isso não parece um link. Cole um endereço que comece com http:// ou https://'); return; }

  adding = true;
  let released = false;
  const release = () => { if (!released) { released = true; adding = false; } };
  try {
    // Link de um item que está dentro de uma playlist: pergunta se é só o item ou a playlist inteira.
    const scope = await choosePlaylistScope(url);
    if (scope === 'cancel') {
      setStatus('Adição cancelada.');
      return;
    }
    const cached = metadataFor(url);
    clearInputForm();
    lastAddAt = Date.now();
    release();

    const fmt = isSpotify(url) ? 'MP3' : (format || 'MP4');
    if (scope === 'playlist' || (scope === 'auto' && looksLikePlaylist(url))) {
      await addPlaylistLinks(url, scope, fmt);
    } else {
      await addSingleLink(url, fmt, cached);
    }
  } catch (error) {
    setStatus(ipcMsg(error) || 'Erro ao adicionar à fila.');
  } finally {
    release();
  }
}

async function addSingleLink(url, fmt, cached) {
  const r = await addLink({
    url,
    format: fmt,
    quality: dlQuality(),
    title: cached?.title || '',
    thumbnail: cached?.thumbnail || '',
    channel: cached?.channel || '',
    duration: cached?.duration || null
  });
  if (r.duplicate) { notifyDuplicate(r); return; }
  setStatus('Item adicionado à fila.');
  fetchQueue();
}

async function addPlaylistLinks(url, scope, fmt) {
  let isPlaylist = scope === 'playlist';
  if (scope === 'auto' && window.bds && window.bds.inspectPlaylist) {
    try {
      const playlistInfo = await window.bds.inspectPlaylist(url);
      isPlaylist = Boolean(playlistInfo && playlistInfo.isPlaylist);
    } catch (e) { /* sem análise: trata como link comum */ }
  }
  if (isPlaylist && window.bds && window.bds.expandPlaylist) {
    setStatus('Expandindo playlist...');
    const items = await window.bds.expandPlaylist(url);
    if (Array.isArray(items) && items.length > 0) {
      await enqueueManyLinks(null, { format: fmt, items: items.map((i) => ({ ...i, url: i.url || url })) });
      return;
    }
  }
  await addSingleLink(url, fmt, null);
}

async function startQueue() {
  try {
    setStatus('Iniciando fila...');
    const api = getDownloadsApi();
    await api.start();
  } catch (err) {
    setStatus('Não foi possível iniciar a fila. Tente novamente.');
  }
}

async function pauseQueue() {
  try {
    setStatus('Fila pausada.');
    const api = getDownloadsApi();
    await api.pause();
  } catch (err) {
    setStatus('Não foi possível pausar a fila.');
  }
}

async function clearCompleted() {
  try {
    const api = getDownloadsApi();
    await api.clearCompleted();
    fetchQueue();
  } catch (err) {}
}

async function cancelDownload(id) {
  const api = getDownloadsApi();
  await api.cancel(id);
  fetchQueue();
}

async function removeQueueItem(id) {
  const api = getDownloadsApi();
  await api.remove(id);
  fetchQueue();
}

async function retryQueueItem(id) {
  const api = getDownloadsApi();
  await api.retry(id);
  fetchQueue();
}

async function reorderQueue(id, direction) {
  const api = getDownloadsApi();
  await api.reorder(id, direction);
  fetchQueue();
}

async function toggleItemFormat(id, newFormat) {
  const api = getDownloadsApi();
  if (api.toggleFormat) {
    await api.toggleFormat(id, newFormat);
    fetchQueue();
  }
}

async function convertAllQueueTo(targetFormat) {
  const queuedItems = (state.downloadQueue || []).filter(item => item.status === 'queued');
  
  if (queuedItems.length === 0) {
    setStatus('Nenhum item aguardando na fila.');
    return;
  }

  setStatus(`Convertendo formato da fila para ${targetFormat}...`);
  for (const item of queuedItems) {
    if (isSpotify(item.url || '')) {
      if (item.format !== 'MP3') {
        await toggleItemFormat(item.id, 'MP3');
      }
      continue;
    }

    if (item.format !== targetFormat) {
      await toggleItemFormat(item.id, targetFormat);
    }
  }

  setStatus(`Formato da fila alterado para ${targetFormat} (links de música mantidos em MP3).`);
  fetchQueue();
}

async function updateItemQuality(id, newQuality) {
  const api = getDownloadsApi();
  if (api.updateQuality) {
    await api.updateQuality(id, newQuality);
    fetchQueue();
  }
}

async function clearAllQueue() {
  try {
    const total = document.querySelectorAll('#downloadQueueContainer .download-card').length;
    if (total > 0 && window.bdsModal?.confirm) {
      const ok = await window.bdsModal.confirm(`Remover todos os ${total} itens da fila? Downloads em andamento serão cancelados. Os arquivos já baixados não são apagados.`);
      if (!ok) return;
    }
    const api = getDownloadsApi();
    if (api.clearAll) {
      await api.clearAll();
    } else {
      await api.clearCompleted();
    }
    fetchQueue();
    setStatus('Fila limpa por completo.');
  } catch (err) {
    console.error('[DOWNLOAD] Erro ao limpar fila:', err);
    setStatus('Não foi possível limpar a fila. Tente novamente.');
  }
}

function openPath(filePath) {
  if (window.bds && window.bds.openLocalPath) {
    window.bds.openLocalPath(filePath);
  }
}

function revealPath(filePath) {
  if (window.bds && window.bds.revealLocalPath) {
    window.bds.revealLocalPath(filePath);
  }
}

function clearInputForm() {
  if (els.urlInput) els.urlInput.value = '';
  metadataSeq++; // descarta qualquer busca de metadados ainda em andamento
  state.metadata = null;
  state.metadataUrl = null;
  if (els.thumbnail) {
    els.thumbnail.removeAttribute('src');
    els.thumbnail.classList.add('hidden');
  }
  if (els.thumbnailPlaceholder) els.thumbnailPlaceholder.classList.remove('hidden');
  if (els.mediaTitle) els.mediaTitle.textContent = 'Aguardando URL';
  if (els.mediaChannel) els.mediaChannel.textContent = 'Cole um link para carregar título, canal e duração.';
  if (els.mediaDuration) els.mediaDuration.textContent = '--';
  if (els.mediaType) els.mediaType.textContent = '--';
}

function setBusy(busy) {
  if (!els.stateDot) return;
  els.stateDot.classList.toggle('busy', busy);
  if (els.stateText) els.stateText.textContent = busy ? 'Baixando' : 'Pronto';
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function formatDuration(seconds) {
  if (!seconds) return '--';
  const total = Number(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function detectSource(url) {
  if (isSpotify(url)) return 'Música';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '--';
  }
}

function isSpotify(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'spotify.com' || host.endsWith('.spotify.com');
  } catch {
    return false;
  }
}
/** Rótulo de plataforma para a interface: marcas de música viram "Música" (o dado salvo não muda). */
function friendlyPlatform(p) {
  const s = String(p || '').trim();
  if (!s) return 'YouTube';
  return /spotify/i.test(s) ? 'Música' : s;
}
