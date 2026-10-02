/**
 * MediaPreviewSystem — Visualizador padrão do BDS (foto / vídeo / áudio).
 *
 * Centraliza os três viewers (PhotoPreview, VideoPreview, AudioPreview) e oferece
 * uma API única para toda a aplicação:
 *   - open(media, collection): galeria. Fotos e vídeos navegam juntos; o vídeo aparece
 *     como miniatura com botão de play e só carrega a interface de vídeo ao dar play.
 *     Áudios abrem direto no player de áudio.
 *   - playVideo(media): abre a interface de vídeo já reproduzindo (sem galeria).
 * Os viewers são montados no mesmo contêiner pai e apenas um fica visível por vez,
 * sempre em formato de pop-up sobre um fundo escurecido.
 */
import { PhotoPreview } from './PhotoPreview.js';
import { VideoPreview } from './VideoPreview.js';
import { AudioPreview } from './AudioPreview.js';

const AUDIO_EXTS = /^(mp3|wav|flac|aac|ogg|opus|m4a|wma|aiff|aif|alac|ac3|amr)$/i;
const VIDEO_EXTS = /^(mp4|mov|mkv|avi|webm|mxf|mts|m2ts|ts|mpg|mpeg|3gp|m4v|wmv|flv)$/i;

function pathOf(m) {
  return typeof m === 'string' ? m : (m?.filepath || m?.path || m?.url || '');
}

function kindOf(m) {
  const ext = (pathOf(m).split('.').pop() || '').toLowerCase();
  if (VIDEO_EXTS.test(ext)) return 'video';
  if (AUDIO_EXTS.test(ext)) return 'audio';
  return 'photo';
}

class MediaPreviewSystem {
  constructor() {
    this.container = document.body;
    this.photo = null;
    this.video = null;
    this.audio = null;
    this.active = null;
    this.backdrop = null;
    this._returnTo = null; // galeria a reabrir quando o vídeo iniciado por ela for fechado
  }

  /** Fundo escurecido atrás do pop-up; clicar nele fecha o visualizador. */
  _backdrop() {
    if (!this.backdrop) {
      this.backdrop = document.createElement('div');
      this.backdrop.className = 'preview-backdrop hidden';
      this.backdrop.addEventListener('click', () => this.close());
      this.container.appendChild(this.backdrop);
    }
    return this.backdrop;
  }

  /** Garante o contêiner e monta os viewers uma única vez. */
  _ensure() {
    if (!this.photo) {
      this.photo = new PhotoPreview({
        container: this.container,
        onClose: () => this._deactivate('photo'),
        onPlayVideo: (media, collection) => this._playFromGallery(media, collection)
      });
      this.photo.mount(this.container);
      // PhotoPreview cria seu root visível por padrão (display:flex);
      // como montamos todos os viewers eager, escondemos até open() ser chamado.
      this.photo.dom?.root?.classList.add('hidden');
    }
    if (!this.video) {
      this.video = new VideoPreview({ onClose: () => this._onVideoClosed() });
      this.video.mount(this.container);
    }
    if (!this.audio) {
      this.audio = new AudioPreview({ onClose: () => this._deactivate('audio') });
      this.audio.mount(this.container);
    }
  }

  /** Fecha o viewer ativo (sem reabrir a galeria) para partir de um estado limpo. */
  _closeActive() {
    this._returnTo = null;
    const kind = this.active;
    this.active = null;
    try {
      if (kind === 'video') this.video.close();
      else if (kind === 'audio') this.audio.close();
      else if (kind === 'photo') this.photo.close();
    } catch (_) { /* ignora */ }
  }

  /** Abre a galeria (fotos + vídeos) ou o player de áudio, conforme o item. */
  open(media, collection = []) {
    if (!media) return;
    this._ensure();
    this._closeActive();

    if (kindOf(media) === 'audio') {
      this.active = 'audio';
      this._backdrop().classList.remove('hidden');
      this.audio.open(media, collection);
      return;
    }

    // Galeria mista: fotos e vídeos juntos (áudios ficam de fora)
    const list = (Array.isArray(collection) && collection.length ? collection : [media])
      .filter(m => kindOf(m) !== 'audio');
    const target = pathOf(media);
    if (!list.some(m => pathOf(m) === target)) list.unshift(media);

    this._showGallery(media, list);
  }

  _showGallery(media, list) {
    this.active = 'photo';
    this._backdrop().classList.remove('hidden');
    // open() é async e não revela o root; revelamos aqui antes de carregar.
    this.photo.dom?.root?.classList.remove('hidden');
    this.photo.open(media, list);
  }

  /** Abre a interface de vídeo já reproduzindo, sem passar pela galeria. */
  playVideo(media) {
    if (!media) return;
    this._ensure();
    this._closeActive();
    this.active = 'video';
    this._backdrop().classList.remove('hidden');
    this.video.open(media, [media], { autoplay: true });
  }

  /** Play numa miniatura da galeria: carrega a interface de vídeo por cima. */
  _playFromGallery(media, collection) {
    if (!media) return;
    this._returnTo = { media, collection };
    this.photo.dom?.root?.classList.add('hidden');
    this.active = 'video';
    this.video.open(media, [media], { autoplay: true });
  }

  /** Vídeo fechado: volta para a galeria de onde veio (se houver), senão encerra. */
  _onVideoClosed() {
    if (this.active === 'video') this.active = null;
    const back = this._returnTo;
    this._returnTo = null;
    if (!back) {
      this._backdrop().classList.add('hidden');
      return;
    }
    // Adiado para o mesmo Esc não fechar também a galeria que acabou de reaparecer.
    setTimeout(() => {
      if (this.active) return;
      this._showGallery(back.media, back.collection);
    }, 0);
  }

  /** Limpa o estado ativo quando um viewer fecha por conta própria. */
  _deactivate(kind) {
    if (this.active === kind) {
      this.active = null;
      this._backdrop().classList.add('hidden');
    }
  }

  /** Força o fechamento do visualizador ativo (API pública). */
  close() {
    this._ensure();
    this._closeActive();
    this._backdrop().classList.add('hidden');
  }
}

/** Instância única exportada — a app importa de './components/preview/MediaPreviewSystem.js'. */
export const mediaPreviewSystem = new MediaPreviewSystem();
