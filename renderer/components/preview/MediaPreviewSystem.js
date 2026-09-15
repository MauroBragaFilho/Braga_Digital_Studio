/**
 * MediaPreviewSystem — Dispatcher único de visualizações (foto / vídeo / áudio).
 *
 * Centraliza os três viewers (PhotoPreview, VideoPreview, AudioPreview) e oferece
 * uma API única `open(media, collection)` para a aplicação. Os viewers são
 * montados no mesmo contêiner pai e apenas um fica visível por vez.
 */
import { PhotoPreview } from './PhotoPreview.js';
import { VideoPreview } from './VideoPreview.js';
import { AudioPreview } from './AudioPreview.js';

const PHOTO_EXTS = /^(jpg|jpeg|png|gif|bmp|webp|tif|tiff|cr2|cr3|arw|nef|dng|raf|orf|rw2|svg)$/i;
const AUDIO_EXTS = /^(mp3|wav|flac|aac|ogg|opus|m4a|wma|aiff|aif|alac|ac3|amr)$/i;
const VIDEO_EXTS = /^(mp4|mov|mkv|avi|webm|mxf|mts|m2ts|ts|mpg|mpeg|3gp|m4v|wmv|flv)$/i;

class MediaPreviewSystem {
  constructor() {
    this.container = document.body;
    this.photo = null;
    this.video = null;
    this.audio = null;
    this.active = null;
  }

  /** Garante o contêiner e monta os viewers uma única vez. */
  _ensure() {
    if (!this.photo) {
      this.photo = new PhotoPreview({ container: this.container, onClose: () => this._deactivate('photo') });
      this.photo.mount(this.container);
      // PhotoPreview cria seu root visível por padrão (display:flex);
      // como montamos todos os viewers eager, escondemos até open() ser chamado.
      this.photo.dom?.root?.classList.add('hidden');
    }
    if (!this.video) {
      this.video = new VideoPreview({ onClose: () => this._deactivate('video') });
      this.video.mount(this.container);
    }
    if (!this.audio) {
      this.audio = new AudioPreview({ onClose: () => this._deactivate('audio') });
      this.audio.mount(this.container);
    }
  }

  /** Fecha todos e reativa o visualizador apropriado para o tipo de mídia. */
  open(media, collection = []) {
    if (!media) return;
    this._ensure();
    // Fecha tudo para garantir estado limpo entre tipos diferentes
    if (this.active === 'video') { try { this.video.close(); } catch (_) {} }
    if (this.active === 'audio') { try { this.audio.close(); } catch (_) {} }
    if (this.active === 'photo') { try { this.photo.close(); } catch (_) {} }
    this.active = null;

    const fp = media.filepath || media.path || media.url || '';
    const ext = (fp.split('.').pop() || '').toLowerCase();
    let viewer = null;
    let kind = 'photo';
    if (VIDEO_EXTS.test(ext)) { viewer = this.video; kind = 'video'; }
    else if (AUDIO_EXTS.test(ext)) { viewer = this.audio; kind = 'audio'; }
    else { viewer = this.photo; kind = 'photo'; }

    this.active = kind;
    if (kind === 'photo') {
      // open() é async e não revela o root; revelamos aqui antes de carregar.
      this.photo.dom?.root?.classList.remove('hidden');
      this.photo.open(media, collection);
    } else {
      viewer.open(media, collection);
    }
  }

  /** Limpa o estado ativo quando um viewer fecha por conta própria. */
  _deactivate(kind) {
    if (this.active === kind) this.active = null;
  }

  /** Força o fechamento do visualizador ativo (API pública). */
  close() {
    this._ensure();
    if (this.active === 'video') this.video.close();
    else if (this.active === 'audio') this.audio.close();
    else if (this.active === 'photo') this.photo.close();
    this.active = null;
  }
}

/** Instância única exportada — a app importa de './components/preview/MediaPreviewSystem.js'. */
export const mediaPreviewSystem = new MediaPreviewSystem();