import { els, state, setStatus } from '../app.js';

let metadataTimer = null;

/**
 * Inicializa os eventos da tela de Download.
 * Chamada automaticamente pelo orquestrador (app.js) ao carregar esta tela.
 */
export function initScreen() {
  // Restaura o status textual e o estado dos controles baseado no progresso atual
  setStatus(state.running ? 'Baixando...' : 'Pronto para baixar.');
  setControlsEnabled(!state.running);

  // Vincula os ouvintes de eventos nos elementos da tela
  els.urlInput.addEventListener('input', () => {
    clearTimeout(metadataTimer);
    metadataTimer = setTimeout(loadMetadata, 650);
  });

  els.metadataButton.addEventListener('click', loadMetadata);
  els.mp3Button.addEventListener('click', () => startDownload('MP3'));
  els.mp4Button.addEventListener('click', () => startDownload('MP4'));
  els.stopButton.addEventListener('click', stopDownload);

  // Se o usuário alternou de aba, mas já existiam metadados na memória, re-renderiza a miniatura
  if (state.metadata) {
    renderMetadata(state.metadata);
  }
  
  // Se houver um download ativo correndo em background, força a atualização da barra
  if (state.running) {
    updateProgressVisuals({ percent: state.progressPercent });
  }
}

/**
 * Atualiza visualmente o progresso do download na interface.
 * Exportada para que o app.js (IPC listener) possa atualizá-la em tempo real.
 */
export function updateProgressVisuals(payload) {
  if (!els.progressPercent) return;
  
  const percent = typeof payload.percent === 'number' ? payload.percent : state.progressPercent;
  els.progressPercent.textContent = `${Math.round(percent)}%`;
  els.progressFill.style.width = `${percent}%`;
  els.progressDetails.textContent = `Velocidade ${payload.speed || '--'} | ETA ${payload.eta || '--'}`;
  
  if (payload.status) {
    setStatus(payload.status);
  }
  
  // Atualiza o estado visual da sidebar (dot/texto)
  setBusy(state.running);
}

/**
 * Altera a disponibilidade dos campos e botões dependendo se há um download ativo.
 */
export function setControlsEnabled(enabled) {
  if (!els.mp3Button) return;
  els.mp3Button.disabled = !enabled;
  els.mp4Button.disabled = !enabled;
  els.metadataButton.disabled = !enabled;
  els.urlInput.disabled = !enabled;
  els.resolutionSelect.disabled = !enabled;
  els.stopButton.disabled = enabled; // O botão Parar funciona de forma inversa
}

/**
 * Busca informações e metadados do link inserido chamando o backend do Electron.
 */
async function loadMetadata() {
  if (!els.urlInput) return;
  const url = els.urlInput.value.trim();
  if (!url) return;

  try {
    setStatus('Buscando informações da mídia...');
    const metadata = await window.bds.getMetadata(url);
    state.metadata = metadata;
    
    // Renderiza se o usuário ainda estiver nesta tela ao terminar o fetch
    if (els.mediaTitle) {
      renderMetadata(metadata);
    }
    setStatus('Informações carregadas.');
  } catch (error) {
    state.metadata = null;
    setStatus(error.message || 'Não foi possível carregar a miniatura.');
  }
}

/**
 * Renderiza os dados coletados (Título, canal, duração e imagem) nos painéis da UI.
 */
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
    els.thumbnail.hidden = false;
    els.thumbnailPlaceholder.hidden = true;
  } else {
    els.thumbnail.removeAttribute('src');
    els.thumbnail.hidden = true;
    els.thumbnailPlaceholder.hidden = false;
  }
}

/**
 * Valida as regras de negócio iniciais e dispara a requisição de download para o Main process.
 */
async function startDownload(type) {
  const url = els.urlInput.value.trim();
  if (!url) {
    setStatus('Cole uma URL antes de iniciar.');
    return;
  }

  // Validação de restrição de plataforma
  if (isSpotify(url) && type === 'MP4') {
    setStatus('Spotify está disponível apenas para MP3.');
    return;
  }

  try {
    // Inspeciona se a URL aponta para uma playlist completa
    const playlist = await window.bds.inspectPlaylist(url);
    if (playlist.isPlaylist) {
      const confirmed = await confirmPlaylist(playlist);
      if (!confirmed) {
        setStatus('Download de playlist cancelado.');
        return;
      }
    }

    // Configura os estados de início de processamento
    state.running = true;
    state.progressPercent = 0;
    setControlsEnabled(false);
    setBusy(true);
    
    updateProgressVisuals({ percent: 0, speed: '', eta: '', status: 'Preparando download...' });
    
    // Dispara a transferência
    await window.bds.startDownload({
      url,
      type,
      resolution: els.resolutionSelect.value,
      title: state.metadata?.title || ''
    });
  } catch (error) {
    state.running = false;
    setControlsEnabled(true);
    setBusy(false);
    setStatus(error.message || 'Erro ao iniciar download.');
  }
}

/**
 * Interrompe o download em execução mandando um sinal de cancelamento (ex: kill no processo do yt-dlp)
 */
async function stopDownload() {
  setStatus('Parando download...');
  await window.bds.cancelDownload();
}

/**
 * Abre o elemento HTML5 <dialog> nativo para confirmação de download de playlists em lote.
 */
async function confirmPlaylist(playlist) {
  els.playlistName.textContent = playlist.title || 'Playlist';
  els.playlistCount.textContent = playlist.itemCount || 'Não informado';
  els.playlistDialog.showModal();
  
  return new Promise((resolve) => {
    els.playlistDialog.addEventListener('close', () => {
      resolve(els.playlistDialog.returnValue === 'confirm');
    }, { once: true });
  });
}

/**
 * Atualiza as classes CSS do indicador de estado global na barra lateral.
 */
function setBusy(busy) {
  if (!els.stateDot) return;
  els.stateDot.classList.toggle('busy', busy);
  els.stateText.textContent = busy ? 'Baixando' : 'Pronto';
}

/* ==========================================================================
   Funções Utilitárias de Formatação e Detecção de Plataforma
   ========================================================================== */

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

function detectSource(url) {
  if (isSpotify(url)) return 'Spotify';
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
