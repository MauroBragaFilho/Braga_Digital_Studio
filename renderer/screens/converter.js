import { setAppStatus } from '../app.js';

// Constantes de Status (Centralizadas para evitar typos)
const STATUS_WAITING = 'Aguardando';
const STATUS_CONVERTING = 'Convertendo';
const STATUS_DONE = 'Concluído';
const STATUS_CANCELLED = 'Cancelado';

let converterList = [];
let thumbsDir = '';
let exportConverterState = {
  active: false,
  completed: false,
  cancelled: false,
  current: 0,
  total: 0,
  percent: 0
};
let ipcListenersInitialized = false; // Previne duplicação de listeners em recargas de tela
let availableEncoders = null; // Lista de encoders disponíveis no FFmpeg (cache)
let addMenuDocClickListener = null; // Listener do document para fechar menu Adicionar
let overallProgressData = null; // Último payload do evento converter:overallProgress { percent, remainingSeconds }

// Extensões de mídia suportadas pelo conversor
const CONVERTER_SUPPORTED_EXTENSIONS = [
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mts', '.m2ts',
  '.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.wma', '.alac', '.aiff',
  '.ape', '.opus', '.amr', '.mid', '.midi', '.au', '.ra', '.dsf', '.dff',
  '.ac3', '.dts', '.3gp', '.mpg', '.mpeg', '.m4v', '.ts', '.vob', '.asf',
  '.rm', '.rmvb', '.ogv', '.f4v', '.mxf'
];

// Extensões exibidas no grid de extensões suportadas (empty state)
const CONVERTER_FORMAT_CHIPS = ['MP4', 'MKV', 'AVI', 'MOV', 'WEBM', 'MP3', 'AAC', 'FLAC', 'WAV', 'OGG'];

// Função para escapar HTML e prevenir XSS/quebra de atributos
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function logConverterScreen(msg, type = 'info') {
  if (type === 'error') {
    const banner = document.getElementById('converterDebugBanner');
    const output = document.getElementById('converterLogOutput');
    if (banner) {
      banner.classList.add('active');
      banner.classList.remove('hidden');
    }
    if (output) {
      const time = new Date().toLocaleTimeString('pt-BR');
      output.textContent = `❌ [ERRO DETECTADO] ${time} - ${msg}\n` + output.textContent;
    }
  }
  console.log(`[CONVERTER-${type.toUpperCase()}]:`, msg);
}

// ---------------------------------------------------------------------------
// HELPERS: Leitura de estado dos novos controles
// ---------------------------------------------------------------------------

/** Retorna 'mp4' ou 'mp3' a partir do toggle de formato */
function getConverterFormat() {
  const toggle = document.getElementById('converterFormatToggle');
  if (!toggle) return 'mp4';
  return toggle.classList.contains('mp3-active') ? 'mp3' : 'mp4';
}

/** Retorna o codec de vídeo selecionado ('libx264' ou 'libx265') */
function getConverterVideoCodec() {
  const active = document.querySelector('.converter-codec-btn.active');
  return active ? active.getAttribute('data-codec') : 'libx264';
}

/** Sincroniza slider ↔ input numérico (clamped 1–100) e atualiza label */
function syncVideoBitrate(value) {
  const val = Math.min(100, Math.max(1, Math.round(Number(value) || 10)));
  const slider = document.getElementById('rangeConverterBitrate');
  const input = document.getElementById('numConverterBitrate');
  const label = document.getElementById('converterBitrateValue');
  if (slider) slider.value = val;
  if (input) input.value = val;
  if (label) label.textContent = `${val} Mbps`;
}

/** Mostra/esconde blocos de vídeo/áudio conforme formato selecionado */
function updateConverterFormatVisibility() {
  const format = getConverterFormat();
  const isMp3 = format === 'mp3';
  const videoSettings = document.getElementById('converterVideoSettings');
  const audioCodecContainer = document.getElementById('converterAudioCodecContainer');

  if (videoSettings) videoSettings.classList.toggle('hidden', isMp3);
  if (audioCodecContainer) audioCodecContainer.classList.toggle('hidden', isMp3);

  // Atualiza estado PCM primeiro (pode esconder bitrate se codec = PCM)
  updateAudioCodecState();

  // Em MP3, áudio é sempre libmp3lame — garante bitrate visível
  // (override DEPOIS de updateAudioCodecState, que teria escondido por causa do PCM)
  if (isMp3) {
    const audioBitrateContainer = document.getElementById('converterAudioBitrateContainer');
    if (audioBitrateContainer) audioBitrateContainer.classList.remove('hidden');
  }
}

/** Atualiza estado do codec de áudio (PCM → esconde bitrate, aviso) */
function updateAudioCodecState() {
  const codecSelect = document.getElementById('selConverterAudioCodec');
  const bitrateContainer = document.getElementById('converterAudioBitrateContainer');
  const bitrateHint = document.getElementById('converterAudioBitrateHint');
  const codecHint = document.getElementById('converterAudioCodecHint');

  if (!codecSelect) return;

  const isPcm = codecSelect.value === 'pcm_s16le';

  if (bitrateContainer) bitrateContainer.classList.toggle('hidden', isPcm);
  if (bitrateHint) bitrateHint.classList.toggle('hidden', !isPcm);
  if (codecHint) codecHint.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// HELPERS: Menu Adicionar (+)
// ---------------------------------------------------------------------------

function closeConverterAddMenu() {
  const menu = document.getElementById('converterAddMenu');
  const btn = document.getElementById('btnAddConverterFiles');
  if (menu) menu.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleConverterAddMenu() {
  const menu = document.getElementById('converterAddMenu');
  const btn = document.getElementById('btnAddConverterFiles');
  if (!menu || !btn) return;
  const isOpen = !menu.classList.contains('hidden');
  if (isOpen) {
    closeConverterAddMenu();
  } else {
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  }
}

// ---------------------------------------------------------------------------
// HELPERS: Enfileiramento reutilizável
// ---------------------------------------------------------------------------

/**
 * Adiciona arquivos à fila de conversão usando o pipeline do backend.
 * Reutilizável por: botão Arquivo, Pasta, Biblioteca e drag-and-drop.
 */
async function enqueueConverterFiles(filePaths, { extractThumbs = false } = {}) {
  if (!filePaths || filePaths.length === 0) return 0;
  if (!window.bds || !window.bds.converterAddFiles) return 0;

  try {
    const res = await window.bds.converterAddFiles(filePaths);
    if (!res || !res.items || res.items.length === 0) return 0;

    for (const backendItem of res.items) {
      const fp = backendItem.file;
      const name = fp.split(/[\\/]/).pop();
      let thumbnail = './assets/podcast_thumb.jpg';

      if (extractThumbs && window.bds.extractMetadataThumb) {
        try {
          const tPath = await window.bds.extractMetadataThumb(fp);
          if (tPath) thumbnail = 'file:///' + tPath.replace(/\\/g, '/');
        } catch (e) {
          logConverterScreen(`Erro ao extrair thumbnail de ${name}: ${e.message}`, 'warn');
        }
      }

      converterList.push({
        id: String(backendItem.id),
        name,
        path: fp,
        thumbnail,
        durationSeconds: 0,
        progress: backendItem.progress || 0,
        status: backendItem.status || STATUS_WAITING
      });
    }

    renderConverterTable();
    updateConverterStepperVisuals();
    return res.items.length;
  } catch (err) {
    logConverterScreen(`Erro ao enfileirar arquivos: ${err.message}`, 'error');
    return 0;
  }
}

// ---------------------------------------------------------------------------
// HELPERS: Drag and Drop
// ---------------------------------------------------------------------------

function setupConverterDragAndDrop() {
  const zone = document.getElementById('converterQueueDropZone');
  if (!zone) return;
  if (zone._converterDragBound) return;
  zone._converterDragBound = true;

  let dragDepth = 0;

  const isFileDrag = (e) => {
    return e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files');
  };

  zone.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    zone.classList.add('drag-active');
  });

  zone.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  zone.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) zone.classList.remove('drag-active');
  });

  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    zone.classList.remove('drag-active');

    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;

    const paths = files
      .map(f => {
        if (window.bds?.getPathForFile) return window.bds.getPathForFile(f);
        return f.path || null;
      })
      .filter(Boolean);

    // Filtrar apenas extensões suportadas
    const mediaPaths = paths.filter(p => {
      const ext = '.' + p.split('.').pop().toLowerCase();
      return CONVERTER_SUPPORTED_EXTENSIONS.includes(ext);
    });

    if (mediaPaths.length === 0) {
      logConverterScreen('Nenhum arquivo de mídia suportado encontrado no drop.', 'warn');
      return;
    }

    await enqueueConverterFiles(mediaPaths, { extractThumbs: true });
  });
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

/** Chamado pelo app.js ao trocar de tela — limpa listeners temporários */
export function onLeave() {
  closeConverterAddMenu();
  if (addMenuDocClickListener) {
    document.removeEventListener('click', addMenuDocClickListener);
    addMenuDocClickListener = null;
  }
}

export async function initScreen() {
  logConverterScreen('Inicializando tela de Conversão de Mídias...', 'info');

  window.onerror = function(msg, url, lineNo, columnNo, error) {
    logConverterScreen(`Erro JS: ${msg} (Linha: ${lineNo})`, 'error');
    return false;
  };

  window.onunhandledrejection = function(event) {
    logConverterScreen(`Rejeição de Promessa: ${event.reason?.message || event.reason}`, 'error');
  };

  if (window.bds && window.bds.getThumbDir) {
    try {
      const rawDir = await window.bds.getThumbDir();
      thumbsDir = 'file:///' + rawDir.replace(/\\/g, '/');
    } catch (e) {
      logConverterScreen(`Erro ao buscar getThumbDir: ${e.message}`, 'warn');
    }
  }

  // Define pasta de destino padrão se o campo estiver vazio
  const outFolderInput = document.getElementById('outConverterFolder');
  if (outFolderInput && !outFolderInput.value) {
    if (window.bds && window.bds.getDefaultOutputDir) {
      try {
        const defaultDir = await window.bds.getDefaultOutputDir();
        if (defaultDir) outFolderInput.value = defaultDir;
      } catch (e) {
        // Ignora erro silenciosamente se não houver fallback
      }
    }
  }

  converterList = [];

  updateConverterFormatVisibility();
  await applyConverterEncoderAvailability();
  setupConverterDragAndDrop();
  renderConverterTable();
  bindConverterEvents();
  updateConverterStepperVisuals();
  setupConverterIPCListeners();
}

// ---------------------------------------------------------------------------
// HELPERS: Disponibilidade de encoders (validação runtime)
// ---------------------------------------------------------------------------

/**
 * Consulta o backend (FFmpeg) pelos encoders realmente compilados e ajusta
 * os controles: H265 fica desabilitado se libx265 não existir; codec de áudio
 * inválido é silenciado/removido.
 */
async function applyConverterEncoderAvailability() {
  if (!window.bds || typeof window.bds.checkEncoders !== 'function') return;

  try {
    if (availableEncoders === null) {
      availableEncoders = (await window.bds.checkEncoders()) || [];
    }
    const enc = availableEncoders;

    // H265 (libx265)
    const btnH265 = document.getElementById('btnCodecH265');
    const hint = document.getElementById('converterCodecHint');
    const has265 = enc.includes('libx265');
    if (btnH265) {
      btnH265.disabled = !has265;
      btnH265.title = has265
        ? 'H.265 / HEVC (menor tamanho, requer suporte no FFmpeg)'
        : 'H.265 não disponível neste build do FFmpeg';
    }
    if (hint) {
      if (!has265) {
        hint.textContent = 'H.265 não está disponível neste FFmpeg. Usando H.264.';
        hint.classList.remove('hidden');
      } else {
        hint.classList.add('hidden');
      }
    }

    // Codec de áudio
    const audioSelect = document.getElementById('selConverterAudioCodec');
    if (audioSelect) {
      ['libmp3lame', 'pcm_s16le'].forEach(codec => {
        const hasAudio = enc.includes(codec);
        const opt = audioSelect.querySelector(`option[value="${codec}"]`);
        if (opt) {
          opt.disabled = !hasAudio;
          opt.textContent = hasAudio
            ? opt.getAttribute('data-label-ok') || opt.textContent
            : `${opt.textContent} (indisponível)`;
        }
      });
    }
  } catch (err) {
    logConverterScreen(`Erro ao verificar encoders: ${err.message}`, 'warn');
  }
}

// Função auxiliar para atualizar os badges do Stepper (DRY - Don't Repeat Yourself)
function setStepBadge(badgeEl, subEl, titleEl, { isDone, isActive, text, subtitle, titleText }) {
  if (!badgeEl) return;
  
  if (isDone) {
    badgeEl.classList.add('step-badge-done');
    badgeEl.classList.remove('step-badge-active', 'step-badge-pending');
    badgeEl.textContent = '✓';
    if (subEl) {
      subEl.classList.add('step-text-done');
      subEl.classList.remove('step-text-pending');
    }
    if (titleEl) {
      titleEl.classList.add('step-text-done');
      titleEl.classList.remove('step-text-pending');
    }
  } else if (isActive) {
    badgeEl.classList.add('step-badge-active');
    badgeEl.classList.remove('step-badge-done', 'step-badge-pending');
    badgeEl.textContent = '⏳';
    if (subEl) {
      subEl.classList.add('step-text-done');
      subEl.classList.remove('step-text-pending');
    }
    if (titleEl) {
      titleEl.classList.add('step-text-done');
      titleEl.classList.remove('step-text-pending');
    }
  } else {
    badgeEl.classList.add('step-badge-pending');
    badgeEl.classList.remove('step-badge-done', 'step-badge-active');
    if (subEl) {
      subEl.classList.add('step-text-pending');
      subEl.classList.remove('step-text-done');
    }
    if (titleEl) {
      titleEl.classList.add('step-text-pending');
      titleEl.classList.remove('step-text-done');
    }
  }
  
  if (subEl && subtitle) subEl.textContent = subtitle;
  if (titleEl && titleText) titleEl.textContent = titleText;
}

function setConverterCancelButtonVisible(visible) {
  const btn = document.getElementById('btnCancelConverterQueue');
  if (!btn) return;
  btn.classList.toggle('hidden', !visible);
  // Enquanto a conversão estiver ativa, o botão de iniciar fica desabilitado
  const startBtn = document.getElementById('btnStartConverterQueue');
  if (startBtn) startBtn.disabled = visible;
}

function updateConverterStepperVisuals() {
  // PASSO 1: FILA DE ARQUIVOS
  const b1 = document.getElementById('step1BadgeConverter');
  const s1 = document.getElementById('step1SubConverter');
  
  if (b1 && s1) {
    if (converterList.length > 0) {
      setStepBadge(b1, s1, null, {
        isDone: true,
        isActive: false,
        subtitle: `${converterList.length} arquivo(s) na fila`
      });
    } else {
      setStepBadge(b1, s1, null, {
        isDone: false,
        isActive: false,
        subtitle: 'Adicione as mídias'
      });
      b1.textContent = '1'; // Número do passo quando pendente
    }
  }

  // PASSO 2: FORMATO & CODEC
  const b2 = document.getElementById('step2BadgeConverter');
  const s2 = document.getElementById('step2SubConverter');
  const outFormat = (getConverterFormat() || 'mp4').toUpperCase();
  const resolution = document.getElementById('selConverterResolution')?.value || 'original';

  if (b2 && s2) {
    setStepBadge(b2, s2, null, {
      isDone: true,
      isActive: false,
      subtitle: `Formato: ${outFormat} (${resolution})`
    });
  }

  // PASSO 3: CONVERTER & EXPORTAR
  const b3 = document.getElementById('step3BadgeConverter');
  const t3 = document.getElementById('step3TitleConverter');
  const s3 = document.getElementById('step3SubConverter');

  if (b3 && t3 && s3) {
    if (exportConverterState.completed && exportConverterState.cancelled) {
      setStepBadge(b3, s3, t3, {
        isDone: false,
        isActive: false,
        titleText: 'CANCELADO',
        subtitle: 'A conversão foi interrompida.'
      });
    } else if (exportConverterState.completed) {
      setStepBadge(b3, s3, t3, {
        isDone: true,
        isActive: false,
        titleText: 'CONCLUÍDO!',
        subtitle: 'Todos os arquivos foram convertidos!'
      });
    } else if (exportConverterState.active) {
      setStepBadge(b3, s3, t3, {
        isDone: false,
        isActive: true,
        titleText: `CONVERTENDO (${exportConverterState.current}/${exportConverterState.total})`,
        subtitle: `Progresso: ${Math.round(exportConverterState.percent)}%`
      });
    } else {
      setStepBadge(b3, s3, t3, {
        isDone: false,
        isActive: false,
        titleText: 'CONVERTER & EXPORTAR',
        subtitle: 'Inicie a conversão em lote'
      });
      b3.textContent = '3'; // Número do passo quando pendente
    }
  }
}

function renderConverterTable() {
  const tbody = document.getElementById('converterMainBody');
  const countEl = document.getElementById('converterMainCount');
  const totalDurEl = document.getElementById('converterTotalDuration');

  if (countEl) countEl.textContent = converterList.length;

  let totalSec = 0;
  let hasValidDuration = false;
  converterList.forEach(item => {
    if (item.durationSeconds > 0) {
      totalSec += item.durationSeconds;
      hasValidDuration = true;
    }
  });
  if (totalDurEl) {
    totalDurEl.textContent = hasValidDuration ? formatSecondsToHHMMSS(totalSec) : '—';
  }

  if (!tbody) return;

  if (converterList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="converter-empty-state">
          <div class="converter-empty-content">
            <span class="material-symbols-rounded converter-empty-icon" aria-hidden="true">sync</span>
            <strong>Fila de conversão vazia</strong>
            <span>Clique em "+ Adicionar" ou arraste arquivos para cá. Formatos suportados:</span>
            <div class="converter-empty-formats">
              ${CONVERTER_FORMAT_CHIPS.map(c => `<span class="converter-format-chip">${c}</span>`).join('')}
            </div>
          </div>
        </td>
      </tr>
    `;
    updateConverterBatchProgress();
    return;
  }

  const outFormatVal = (getConverterFormat() || 'mp4').toUpperCase();

  tbody.innerHTML = converterList.map((item, index) => {
    const ext = item.name.split('.').pop().toUpperCase();
    const isAudio = item.isAudio || ['MP3', 'WAV', 'M4A', 'AAC', 'FLAC', 'OGG'].includes(ext);

    const pct = Math.round(item.progress || 0);
    const statusText = item.status || STATUS_WAITING;
    const isDone = item.status === STATUS_DONE || pct >= 100;
    const isConverting = item.status === STATUS_CONVERTING;
    const isCancelled = item.status === STATUS_CANCELLED;
    
    // Correção: Classes CSS dinâmicas para cores diferentes de status
    const barColorClass = isDone ? 'converter-progress-fill-done' : (isConverting ? 'converter-progress-fill-active' : 'converter-progress-fill-pending');
    const statusColorClass = isCancelled ? 'converter-status-cancelled' : (isDone ? 'converter-status-done' : (isConverting ? 'converter-status-active' : 'converter-status-pending'));

    const safeName = escapeHtml(item.name);
    const safeThumb = escapeHtml(item.thumbnail);
    
    // Correção: Duração fake -> Mostra "—" se não houver duração real
    const durationDisplay = (item.durationSeconds && item.durationSeconds > 0) 
      ? formatSecondsToHHMMSS(item.durationSeconds) 
      : '—';

    const thumbHtml = isAudio 
      ? `<div class="converter-thumb-audio">ÁUDIO</div>`
      : `<div class="converter-thumb-video">
          <img src="${safeThumb}" class="converter-thumb-img" onError="this.style.display='none'" />
          <span class="material-symbols-rounded converter-thumb-fallback">movie</span>
         </div>`;

    return `
      <tr class="converter-table-row">
        <td class="converter-table-cell converter-cell-index">${index + 1}</td>
        
        <td class="converter-table-cell">
          <div class="converter-file-info">
            ${thumbHtml}
            <div class="converter-file-details">
              <div class="converter-file-name" title="${safeName}">${safeName}</div>
              <div class="converter-file-duration">Duração: ${durationDisplay}</div>
            </div>
          </div>
        </td>

        <td class="converter-table-cell converter-cell-ext">${ext}</td>
        <td class="converter-table-cell converter-cell-out-format">${outFormatVal}</td>

        <td class="converter-table-cell">
          <div class="converter-progress-container">
            <div class="converter-progress-header">
              <span class="${statusColorClass}">${statusText}</span>
              <span class="converter-progress-pct">${pct}%</span>
            </div>
            <div class="converter-progress-bar">
              <div class="converter-progress-fill ${barColorClass}" style="width: ${pct}%;"></div>
            </div>
          </div>
        </td>

        <td class="converter-table-cell converter-cell-actions">
          <button class="btn-remove-converter-item" data-index="${index}" title="Remover item" aria-label="Remover ${safeName} da fila" type="button">
            <span class="material-symbols-rounded" aria-hidden="true">delete</span>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('.btn-remove-converter-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(btn.getAttribute('data-index'), 10);
      if (!isNaN(idx)) {
        converterList.splice(idx, 1);
        if (window.bds && window.bds.converterRemoveFile) {
          window.bds.converterRemoveFile(idx);
        }
        renderConverterTable();
        updateConverterStepperVisuals();
      }
    });
  });

  updateConverterBatchProgress();
}

/**
 * Atualiza a barra de progresso geral do lote (todos os arquivos somados).
 * Calcula a média ponderada do progresso por arquivo e atualiza os elementos
 * de resumo (status, contagem e barra) em conformidade com ARIA.
 */
function updateConverterBatchProgress() {
  const barEl = document.getElementById('converterBatchProgress');
  const fillEl = document.getElementById('converterBatchProgressFill');
  const statusEl = document.getElementById('converterBatchStatus');
  const countEl = document.getElementById('converterBatchCount');
  const etaEl = document.getElementById('converterBatchEta');

  if (!barEl || !fillEl || !statusEl || !countEl) return;

  if (converterList.length === 0) {
    barEl.classList.add('hidden');
    statusEl.textContent = 'Aguardando';
    countEl.textContent = '0/0';
    if (etaEl) {
      etaEl.textContent = '';
      etaEl.classList.add('hidden');
    }
    return;
  }

  const doneCount = converterList.filter(i => i.status === STATUS_DONE || i.progress >= 100).length;
  // Usa o progresso geral do backend (ponderado por duração, evento converter:overallProgress)
  // quando disponível; senão cai para a média simples do progresso por arquivo.
  const hasOverall = overallProgressData && overallProgressData.percent != null && exportConverterState.active;
  const totalPct = hasOverall
    ? Math.min(100, Math.max(0, overallProgressData.percent))
    : converterList.reduce((acc, i) => acc + (i.progress || 0), 0) / converterList.length;

  countEl.textContent = `${doneCount}/${converterList.length}`;

  if (exportConverterState.active) {
    barEl.classList.remove('hidden');
    statusEl.textContent = 'Convertendo…';
  } else if (exportConverterState.completed && !exportConverterState.cancelled && doneCount === converterList.length) {
    barEl.classList.remove('hidden');
    statusEl.textContent = 'Concluído';
  } else if (exportConverterState.cancelled) {
    barEl.classList.remove('hidden');
    statusEl.textContent = 'Cancelado';
  } else {
    barEl.classList.add('hidden');
    statusEl.textContent = 'Aguardando';
  }

  const targetPct = Math.round(totalPct);
  fillEl.style.width = `${targetPct}%`;
  barEl.setAttribute('aria-valuenow', String(targetPct));

  // Tempo restante estimado pelo backend (throughput real; ~1 evento a cada 500ms)
  if (etaEl) {
    const remaining = overallProgressData && overallProgressData.remainingSeconds;
    if (exportConverterState.active && remaining != null && remaining > 0) {
      etaEl.textContent = `Tempo restante: ~${formatSecondsToHHMMSS(remaining)}`;
      etaEl.classList.remove('hidden');
    } else if (exportConverterState.active) {
      etaEl.textContent = 'Tempo restante: calculando…';
      etaEl.classList.remove('hidden');
    } else {
      etaEl.textContent = '';
      etaEl.classList.add('hidden');
    }
  }
}

function bindConverterEvents() {
  // TOGGLE DE FORMATO (MP4 / MP3)
  document.getElementById('converterFormatToggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.converter-format-btn');
    if (!btn) return;
    const format = btn.getAttribute('data-format');
    const toggle = document.getElementById('converterFormatToggle');
    toggle.classList.toggle('mp4-active', format === 'mp4');
    toggle.classList.toggle('mp3-active', format === 'mp3');
    document.querySelectorAll('.converter-format-btn').forEach(b => {
      const pressed = b.getAttribute('data-format') === format;
      b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
    updateConverterFormatVisibility();
    renderConverterTable();
    updateConverterStepperVisuals();
  });

  // TOGGLE DE CODEC (H264 / H265)
  document.getElementById('converterCodecToggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.converter-codec-btn');
    if (!btn || btn.disabled || btn.classList.contains('active')) return;
    document.querySelectorAll('.converter-codec-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  // BITRATE DE VÍDEO (slider + input sincronizados)
  document.getElementById('rangeConverterBitrate')?.addEventListener('input', (e) => {
    syncVideoBitrate(e.target.value);
  });
  document.getElementById('numConverterBitrate')?.addEventListener('change', (e) => {
    syncVideoBitrate(e.target.value);
  });
  document.getElementById('numConverterBitrate')?.addEventListener('input', (e) => {
    syncVideoBitrate(e.target.value);
  });

  // CODEC DE ÁUDIO
  document.getElementById('selConverterAudioCodec')?.addEventListener('change', () => {
    updateAudioCodecState();
  });

  document.getElementById('selConverterResolution')?.addEventListener('change', () => {
    updateConverterStepperVisuals();
  });

  // Correção: Implementar ordenação da fila
  document.getElementById('selConverterSortOrder')?.addEventListener('change', (e) => {
    const sortOrder = e.target.value;
    if (sortOrder === 'default') {
      // Não faz nada, mantém a ordem original de importação
    } else if (sortOrder === 'name_asc') {
      converterList.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortOrder === 'duration_desc') {
      converterList.sort((a, b) => (b.durationSeconds || 0) - (a.durationSeconds || 0));
    }
    renderConverterTable();
  });

  // 1. Adicionar Arquivos do PC
  const btnAdd = document.getElementById('btnAddConverterFiles');
  if (btnAdd) {
    btnAdd.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleConverterAddMenu();
    });
  }

  // Menu dropdown do botão Adicionar
  const addMenu = document.getElementById('converterAddMenu');
  if (addMenu) {
    addMenu.querySelectorAll('.converter-add-menu-btn').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.getAttribute('data-action');
        closeConverterAddMenu();
        if (action === 'file') btnAddConverterFile();
        else if (action === 'library') openConverterLibraryModal();
        else if (action === 'folder') btnAddConverterFolderAction();
      });
    });

    // Fecha o menu ao clicar fora
    if (!addMenuDocClickListener) {
      addMenuDocClickListener = (e) => {
        const wrapper = document.querySelector('.converter-add-wrapper');
        if (wrapper && !wrapper.contains(e.target)) {
          closeConverterAddMenu();
        }
      };
      document.addEventListener('click', addMenuDocClickListener);
    }
  }

  // Ação: Adicionar arquivos do PC
  async function btnAddConverterFile() {
    if (!window.bds || !window.bds.selectFile) return;
    try {
      const files = await window.bds.selectFile({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Mídias', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mts', 'mpeg', 'mpg', 'vob', 'm4v', '3gp', 'mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'wma'] }]
      });
      if (files && files.length > 0) {
        await enqueueConverterFiles(files, { extractThumbs: true });
      }
    } catch (err) {
      logConverterScreen(`Erro ao selecionar arquivo: ${err.message}`, 'error');
    }
  }

  // Ação: Adicionar arquivos de uma Pasta
  async function btnAddConverterFolderAction() {
    if (!window.bds || !window.bds.selectFolder || !window.bds.getLibraryFolderFiles) return;
    try {
      const folder = await window.bds.selectFolder('');
      if (!folder) return;
      const files = await window.bds.getLibraryFolderFiles(folder);
      if (!files || files.length === 0) {
        if (window.bdsModal && window.bdsModal.alert) {
          window.bdsModal.alert(`Nenhum arquivo de mídia suportado encontrado na pasta:\n${folder}`);
        }
        return;
      }
      await enqueueConverterFiles(files, { extractThumbs: true });
    } catch (err) {
      logConverterScreen(`Erro ao adicionar arquivos da pasta: ${err.message}`, 'error');
    }
  }

  // 2. Modal da Biblioteca (Dinâmico)
  const modal = document.getElementById('converterLibraryModal');
  const btnClose = document.getElementById('btnCloseConverterLibModal');

  // Função reutilizável para abrir o modal (chamada pelo menu "+ Adicionar")
  async function openConverterLibraryModal() {
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('active');

    const modalList = document.getElementById('converterLibModalList');
    if (!modalList) return;

      modalList.innerHTML = `<div style="padding: 16px; text-align: center; color: var(--muted);">Carregando bibliotecas...</div>`;

      try {
        let libraries = [];
        if (window.bds && window.bds.getAllLibraries) {
          libraries = await window.bds.getAllLibraries();
        }

        let optionsHtml = '';

        if (libraries.length > 0) {
          libraries.forEach(lib => {
            const safeName = escapeHtml(lib.name);
            const safePath = escapeHtml(lib.path || 'Sem caminho definido');
            const safeType = escapeHtml(lib.type || lib.name);
            
            let icon = 'folder_special';
            if (lib.type === 'OBS' || lib.type === 'OBS Studio') icon = 'videocam';
            else if (lib.type === 'SHADOWPLAY' || lib.type === 'NVIDIA ShadowPlay') icon = 'sports_esports';
            else if (lib.type === 'BDSM_DEVICE' || lib.type === 'BDSM Devices') icon = 'smartphone';

            optionsHtml += `
              <button class="converter-lib-option" data-lib-type="${safeType}" data-lib-path="${safePath}" type="button">
                <div class="converter-lib-option-text">
                  <span class="material-symbols-rounded converter-lib-icon">${icon}</span>
                  <div style="display: flex; flex-direction: column; align-items: flex-start; text-align: left;">
                    <span style="font-weight: 700;">${safeName}</span>
                    <span style="font-size: 11px; color: var(--muted);">${safePath}</span>
                  </div>
                </div>
                <span class="material-symbols-rounded">chevron_right</span>
              </button>
            `;
          });
        }

        // Opções Globais Adicionais
        optionsHtml += `
          <button class="converter-lib-option" data-lib-type="ALL" type="button">
            <div class="converter-lib-option-text">
              <span class="material-symbols-rounded converter-lib-icon icon-all">video_library</span>
              <div style="display: flex; flex-direction: column; align-items: flex-start; text-align: left;">
                <span style="font-weight: 700;">Todas as Mídias da Biblioteca</span>
                <span style="font-size: 11px; color: var(--muted);">Carrega mídias cadastradas de todas as fontes</span>
              </div>
            </div>
            <span class="material-symbols-rounded">chevron_right</span>
          </button>
          
          <button class="converter-lib-option" data-action="BROWSE_SUBFOLDER" type="button" style="border-style: dashed;">
            <div class="converter-lib-option-text">
              <span class="material-symbols-rounded converter-lib-icon">folder_open</span>
              <div style="display: flex; flex-direction: column; align-items: flex-start; text-align: left;">
                <span style="font-weight: 700;">Selecionar subpasta de biblioteca...</span>
                <span style="font-size: 11px; color: var(--muted);">Escolha uma pasta específica no computador</span>
              </div>
            </div>
            <span class="material-symbols-rounded">folder</span>
          </button>
        `;

        modalList.innerHTML = optionsHtml;

        // Bind dos eventos de clique nas opções dinâmicas
        modalList.querySelectorAll('.converter-lib-option').forEach(optionBtn => {
          optionBtn.addEventListener('click', async () => {
            modal.classList.remove('active');
            modal.classList.add('hidden');

            const action = optionBtn.getAttribute('data-action');
            const libType = optionBtn.getAttribute('data-lib-type');
            const libPath = optionBtn.getAttribute('data-lib-path');

            if (action === 'BROWSE_SUBFOLDER') {
              // Selecionar subpasta local
              if (window.bds && window.bds.selectFolder && window.bds.getLibraryFolderFiles) {
                const folder = await window.bds.selectFolder('');
                if (folder) {
                  const files = await window.bds.getLibraryFolderFiles(folder);
                  if (files && files.length > 0 && window.bds.converterAddFiles) {
                    const res = await window.bds.converterAddFiles(files);
                    if (res && res.items) {
                      res.items.forEach(backendItem => {
                        const fp = backendItem.file;
                        const name = fp.split(/[\\/]/).pop();
                        converterList.push({
                          id: String(backendItem.id),
                          name: name,
                          path: fp,
                          thumbnail: './assets/podcast_thumb.jpg',
                          durationSeconds: 0,
                          progress: backendItem.progress || 0,
                          status: backendItem.status || STATUS_WAITING
                        });
                      });
                    }
                    renderConverterTable();
                    updateConverterStepperVisuals();
                  } else {
                    if (window.bdsModal && window.bdsModal.alert) {
                      window.bdsModal.alert(`Nenhum arquivo de mídia encontrado em:\n${folder}`);
                    }
                  }
                }
              }
              return;
            }

            // Importar por tipo / busca na biblioteca ou por pasta da biblioteca
            if (window.bds && window.bds.searchLibrary) {
              try {
                let items = [];
                if (libType === 'ALL') {
                  items = await window.bds.searchLibrary({ limit: 100 });
                } else if (libType) {
                  items = await window.bds.searchLibrary({ origins: [libType], limit: 100 });
                }

                // Se a busca por origin não retornou e temos um libPath válido, varremos a pasta da biblioteca
                if ((!items || items.length === 0) && libPath && window.bds.getLibraryFolderFiles) {
                  const folderFiles = await window.bds.getLibraryFolderFiles(libPath);
                  if (folderFiles && folderFiles.length > 0 && window.bds.converterAddFiles) {
                    const res = await window.bds.converterAddFiles(folderFiles);
                    if (res && res.items) {
                      res.items.forEach(backendItem => {
                        const fp = backendItem.file;
                        const name = fp.split(/[\\/]/).pop();
                        if (!converterList.some(v => v.path === fp)) {
                          converterList.push({
                            id: String(backendItem.id),
                            name: name,
                            path: fp,
                            thumbnail: './assets/podcast_thumb.jpg',
                            durationSeconds: 0,
                            progress: backendItem.progress || 0,
                            status: backendItem.status || STATUS_WAITING
                          });
                        }
                      });
                    }
                    renderConverterTable();
                    updateConverterStepperVisuals();
                    return;
                  }
                }

                if (items && items.length > 0) {
                  const addedPaths = [];
                  items.forEach(item => {
                    const exists = converterList.some(v => v.path === item.filepath);
                    if (!exists) {
                      addedPaths.push(item.filepath);
                    }
                  });

                  if (addedPaths.length > 0 && window.bds.converterAddFiles) {
                    const res = await window.bds.converterAddFiles(addedPaths);
                    if (res && res.items) {
                      res.items.forEach(backendItem => {
                        const fp = backendItem.file;
                        const itemInfo = items.find(v => v.filepath === fp);
                        converterList.push({
                          id: String(backendItem.id),
                          name: itemInfo ? itemInfo.filename : fp.split(/[\\/]/).pop(),
                          path: fp,
                          thumbnail: itemInfo && itemInfo.thumbnail ? `${thumbsDir}/${itemInfo.thumbnail}` : './assets/podcast_thumb.jpg',
                          durationSeconds: itemInfo ? (itemInfo.duration || 0) : 0,
                          progress: backendItem.progress || 0,
                          status: backendItem.status || STATUS_WAITING
                        });
                      });
                    }
                  }

                  renderConverterTable();
                  updateConverterStepperVisuals();
                } else {
                  if (window.bdsModal && window.bdsModal.alert) {
                    window.bdsModal.alert(`Nenhuma mídia encontrada na biblioteca selecionada.`);
                  }
                }
              } catch (e) {
                logConverterScreen(`Erro ao carregar biblioteca: ${e.message}`, 'error');
              }
            }
          });
        });

      } catch (err) {
        logConverterScreen(`Erro ao carregar lista de bibliotecas: ${err.message}`, 'error');
      }
  } // fim de openConverterLibraryModal

  if (btnClose && modal) {
    btnClose.addEventListener('click', () => {
      modal.classList.remove('active');
      modal.classList.add('hidden');
    });
  }

  // 3. Limpar Fila
  document.getElementById('btnClearConverterQueue')?.addEventListener('click', async () => {
    if (converterList.length === 0) return;
    const confirmed = window.bdsModal && window.bdsModal.confirm
      ? await window.bdsModal.confirm(`Tem certeza que deseja limpar os ${converterList.length} arquivos da fila de conversão?`)
      : true;
    if (!confirmed) return;
    converterList = [];
    if (window.bds && window.bds.converterClearQueue) {
      window.bds.converterClearQueue();
    }
    renderConverterTable();
    updateConverterStepperVisuals();
  });

  // 4. Selecionar Pasta de Destino
  document.getElementById('btnSelectConverterDestFolder')?.addEventListener('click', async () => {
    if (window.bds && window.bds.selectFolder) {
      const currentFolder = document.getElementById('outConverterFolder')?.value || '';
      const folder = await window.bds.selectFolder(currentFolder);
      if (folder) {
        const input = document.getElementById('outConverterFolder');
        if (input) input.value = folder;
        // Persiste a pasta escolhida para usá-la como padrão nas próximas vezes
        if (window.bds && window.bds.saveSettings) {
          try {
            await window.bds.saveSettings({ converterFolder: folder });
          } catch (e) {
            logConverterScreen(`Erro ao salvar pasta de destino: ${e.message}`, 'error');
          }
        }
      }
    }
  });

  // 5. INICIAR CONVERSÃO
  document.getElementById('btnStartConverterQueue')?.addEventListener('click', async () => {
    if (converterList.length === 0) {
      if (window.bdsModal && window.bdsModal.alert) {
        window.bdsModal.alert('Adicione pelo menos 1 arquivo de mídia para converter.');
      }
      return;
    }

    const format = getConverterFormat() || 'mp4';
    const codec = getConverterVideoCodec() || 'libx264';
    const resolution = document.getElementById('selConverterResolution')?.value || 'original';
    const preset = 'medium'; // Fixo internamente (removido da UI)
    const audioCodec = document.getElementById('selConverterAudioCodec')?.value || 'aac';
    const audioBitrate = document.getElementById('selConverterAudioBitrate')?.value || '192k';
    // No formato MP3, o áudio é sempre MP3 (libmp3lame)
    const effectiveAudioCodec = format === 'mp3' ? 'libmp3lame' : audioCodec;
    const bitrateMbps = Math.min(100, Math.max(1, parseInt(document.getElementById('numConverterBitrate')?.value || '10', 10)));
    const videoBitrate = format === 'mp3' ? null : `${bitrateMbps}M`;
    const outFolder = document.getElementById('outConverterFolder')?.value || '';

    if (!outFolder) {
      if (window.bdsModal && window.bdsModal.alert) {
        window.bdsModal.alert('Por favor, selecione uma pasta de destino antes de iniciar a conversão.');
      }
      return;
    }

    const config = {
      format,
      videoCodec: codec,
      videoResolution: resolution === 'original' ? null : parseInt(resolution, 10),
      videoBitrate: format === 'mp3' ? null : videoBitrate,
      preset,
      audioCodec: effectiveAudioCodec,
      audioBitrate,
      outFolder
    };

    if (window.bds && window.bds.converterStart) {
      try {
        exportConverterState = { active: true, completed: false, cancelled: false, current: 1, total: converterList.length, percent: 0 };
        overallProgressData = null;
        setConverterCancelButtonVisible(true);
        updateConverterStepperVisuals();
        updateConverterBatchProgress();
        setAppStatus('Convertendo…', 'info');

        await window.bds.converterStart(config);
      } catch (err) {
        exportConverterState.active = false;
        setConverterCancelButtonVisible(false);
        updateConverterStepperVisuals();
        updateConverterBatchProgress();
        setAppStatus('Erro ao iniciar conversão', 'error');
        logConverterScreen(`Erro ao iniciar conversão: ${err.message}`, 'error');
      }
    }
  });

  // 6. CANCELAR CONVERSÃO
  document.getElementById('btnCancelConverterQueue')?.addEventListener('click', async () => {
    if (!exportConverterState.active) return;
    const confirmed = window.bdsModal && window.bdsModal.confirm
      ? await window.bdsModal.confirm('Deseja realmente cancelar a conversão em andamento?')
      : true;
    if (!confirmed) return;
    if (window.bds && window.bds.converterCancel) {
      try {
        setAppStatus('Cancelando…', 'warning');
        await window.bds.converterCancel();
      } catch (err) {
        logConverterScreen(`Erro ao cancelar conversão: ${err.message}`, 'error');
      }
    }
  });


  // Fechar Banner de Debug
  document.getElementById('btnCloseDebugBanner')?.addEventListener('click', () => {
    const banner = document.getElementById('converterDebugBanner');
    if (banner) {
      banner.classList.add('hidden');
      banner.classList.remove('active');
    }
  });
}

function setupConverterIPCListeners() {
  // Previne duplicação de listeners em recargas de tela
  if (ipcListenersInitialized) return;
  ipcListenersInitialized = true;

  if (window.bds && window.bds.onConverterProgress) {
    window.bds.onConverterProgress((payload) => {
      if (payload && payload.id) {
        const item = converterList.find(i => String(i.id) === String(payload.id));
        if (item) {
          item.progress = payload.progress || 0;
          item.status = payload.status || STATUS_CONVERTING;
        }
        exportConverterState.active = true;
        exportConverterState.percent = payload.progress || 0;
        setConverterCancelButtonVisible(true);
        setAppStatus(`Convertendo ${Math.round(payload.progress || 0)}%…`, 'info');
        renderConverterTable();
        updateConverterStepperVisuals();
        updateConverterBatchProgress();
      }
    });
  }

  if (window.bds && window.bds.onConverterFileStarted) {
    window.bds.onConverterFileStarted((item) => {
      if (item && item.id) {
        const found = converterList.find(i => String(i.id) === String(item.id));
        if (found) {
          found.status = STATUS_CONVERTING;
          found.progress = 0;
        }
        exportConverterState.active = true;
        setConverterCancelButtonVisible(true);
        setAppStatus('Convertendo…', 'info');
        renderConverterTable();
        updateConverterBatchProgress();
      }
    });
  }

  if (window.bds && window.bds.onConverterFileFinished) {
    window.bds.onConverterFileFinished((item) => {
      if (item && item.id) {
        const found = converterList.find(i => String(i.id) === String(item.id));
        if (found) {
          // Respeita o status real vindo do backend ('Concluído', 'Cancelado', 'Erro')
          found.status = item.status || STATUS_DONE;
          found.progress = found.status === STATUS_DONE ? 100 : found.progress;
        }
        // Se o item atual foi cancelado, o backend encerra a fila — esconde o botão de cancelar
        if (item.status === 'Cancelado') {
          exportConverterState.active = false;
          exportConverterState.completed = false;
          exportConverterState.cancelled = true;
          setConverterCancelButtonVisible(false);
          setAppStatus('Cancelado', 'warning');
        }
        renderConverterTable();
        updateConverterBatchProgress();
      }
    });
  }

  if (window.bds && window.bds.onConverterOverallProgress) {
    window.bds.onConverterOverallProgress((data) => {
      if (data && data.percent != null) {
        overallProgressData = data;
        updateConverterBatchProgress();
      }
    });
  }

  if (window.bds && window.bds.onConverterFinished) {
    window.bds.onConverterFinished((payload) => {
      overallProgressData = null;
      exportConverterState.active = false;
      exportConverterState.completed = true;
      const wasCancelled = payload && (payload.status === 'cancelled' || payload.status === 'canceled');
      exportConverterState.cancelled = wasCancelled;
      setConverterCancelButtonVisible(false);
      if (wasCancelled) {
        setAppStatus('Cancelado', 'warning');
      } else {
        setAppStatus('Pronto', 'success');
      }
      if (!wasCancelled) {
        converterList.forEach(item => {
          item.status = STATUS_DONE;
          item.progress = 100;
        });
      }
      renderConverterTable();
      updateConverterStepperVisuals();
      updateConverterBatchProgress();

      const outFolder = document.getElementById('outConverterFolder')?.value || 'Pasta não definida';
      if (window.bdsModal && window.bdsModal.alert) {
        if (wasCancelled) {
          window.bdsModal.alert(`Conversão cancelada. A fila foi interrompida antes de concluir.\nPasta de destino: ${outFolder}`);
        } else {
          window.bdsModal.alert(`Sucesso! Todos os ${converterList.length} arquivos foram convertidos com sucesso em:\n${outFolder}`);
        }
      }
    });
  }
}

function formatSecondsToHHMMSS(totalSeconds) {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}