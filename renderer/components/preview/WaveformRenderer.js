/**
 * WaveformRenderer — Renderizador de waveforms reais em canvas.
 * Reutilizável entre VideoPreview (painel de áudio) e AudioPreview.
 *
 * Recebe dados de peaks já processados (do WaveformService via IPC)
 * e desenha uma forma de onda simétrica sobre um <canvas>.
 *
 * Fases:
 *   1. Estático: desenha o waveform uma única vez (setPeaks)
 *   2. Playhead: atualiza a posição do cursor em tempo real (updatePlayhead)
 */

export class WaveformRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} [options]
   * @param {string} [options.color='rgba(120,180,255,0.85)'] — cor da forma de onda
   * @param {string} [options.playheadColor='#ffffff'] — cor do playhead
   * @param {string} [options.backgroundColor='rgba(0,0,0,0.0)'] — cor de fundo
   * @param {number} [options.playheadWidth=2] — largura do playhead em px
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.peaks = null;
    this.duration = 0;
    this.color = options.color || 'rgba(120,180,255,0.85)';
    this.playheadColor = options.playheadColor || '#ffffff';
    this.backgroundColor = options.backgroundColor || 'rgba(0,0,0,0.0)';
    this.playheadWidth = options.playheadWidth || 2;
    this._lastPlayheadX = -1;
    this._animFrame = null;

    // Observer de resize para redesenhar quando o canvas mudar de tamanho
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => {
        if (this.peaks) this._drawStatic();
      });
      this._resizeObserver.observe(canvas);
    }
  }

  /**
   * Define os dados de amplitude e renderiza o waveform estático.
   * @param {number[]} peaks — array de amplitudes normalizadas (0.0–1.0)
   * @param {number} duration — duração em segundos
   */
  setPeaks(peaks, duration) {
    this.peaks = peaks;
    this.duration = duration || (peaks.length > 0 ? peaks.length / 100 : 0);
    this._drawStatic();
  }

  /**
   * Atualiza a posição do playhead sem redesenhar o waveform.
   * @param {number} progress — 0.0 a 1.0
   */
  updatePlayhead(progress) {
    if (!this.peaks || !this.canvas.width) return;
    const w = this.canvas.width;
    const x = Math.round(progress * w);
    if (x === this._lastPlayheadX) return; // evita redesenho desnecessário
    this._lastPlayheadX = x;
    this._drawFrame(x);
  }

  /** Limpa o canvas e para animações pendentes. */
  clear() {
    this.peaks = null;
    this.duration = 0;
    this._lastPlayheadX = -1;
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
  }

  destroy() {
    this.clear();
    this._base = null;
    this._played = null;
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
  }

  // ── Privados ─────────────────────────────────────────────

  /** Pinta as barras da forma de onda numa camada (canvas offscreen) com a cor dada. */
  _paintLayer(layer, w, h, color, withBackground) {
    const lctx = layer.getContext('2d');
    lctx.clearRect(0, 0, w, h);
    if (withBackground && this.backgroundColor !== 'rgba(0,0,0,0.0)') {
      lctx.fillStyle = this.backgroundColor;
      lctx.fillRect(0, 0, w, h);
    }
    const mid = h / 2;
    const step = this.peaks.length / w;
    lctx.fillStyle = color;
    for (let x = 0; x < w; x++) {
      const idx = Math.floor(x * step);
      const amp = this.peaks[idx] || 0;
      const barH = Math.max(1, amp * (mid - 2));
      lctx.fillRect(x, mid - barH, 1, barH * 2);
    }
  }

  /**
   * Redesenha waveform estático + playhead atual.
   * A forma de onda é pintada UMA vez em canvases offscreen (normal e "já reproduzido");
   * por quadro só há drawImage + a linha do playhead.
   */
  _drawStatic() {
    if (!this.peaks || !this.peaks.length) return;
    const { canvas, ctx } = this;
    const w = canvas.width = canvas.clientWidth || 200;
    const h = canvas.height = canvas.clientHeight || 60;

    this._base = this._base || document.createElement('canvas');
    this._played = this._played || document.createElement('canvas');
    this._base.width = this._played.width = w;
    this._base.height = this._played.height = h;
    this._paintLayer(this._base, w, h, this.color, true);
    this._paintLayer(this._played, w, h, 'rgba(180,210,255,0.95)', true);

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this._base, 0, 0);

    // Redesenha playhead se já existia
    if (this._lastPlayheadX >= 0) {
      this._drawPlayheadLine(this._lastPlayheadX);
    }
  }

  /** Quadro: parte já reproduzida (clara) + restante (cor normal) + linha do playhead. */
  _drawFrame(playheadX) {
    if (!this.peaks) return;
    const { canvas, ctx } = this;
    const w = canvas.width;
    const h = canvas.height;
    if (!this._base || this._base.width !== w || this._base.height !== h) { this._drawStatic(); return; }

    const px = Math.max(0, Math.min(w, playheadX));
    ctx.clearRect(0, 0, w, h);
    if (px < w) ctx.drawImage(this._base, px, 0, w - px, h, px, 0, w - px, h);
    if (px > 0) ctx.drawImage(this._played, 0, 0, px, h, 0, 0, px, h);

    // Playhead
    this._drawPlayheadLine(playheadX);
  }

  /** Desenha a linha vertical do playhead. */
  _drawPlayheadLine(x) {
    const { ctx, canvas } = this;
    ctx.save();
    // Sem shadowBlur (caro por quadro): um traço escuro mais largo atrás simula a sombra
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = this.playheadWidth + 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
    ctx.strokeStyle = this.playheadColor;
    ctx.lineWidth = this.playheadWidth;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
    ctx.restore();
  }
}
