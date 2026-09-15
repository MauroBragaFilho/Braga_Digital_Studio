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
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
  }

  // ── Privados ─────────────────────────────────────────────

  /** Redesenha waveform estático + playhead atual. */
  _drawStatic() {
    if (!this.peaks || !this.peaks.length) return;
    const { canvas, ctx } = this;
    const w = canvas.width = canvas.clientWidth || 200;
    const h = canvas.height = canvas.clientHeight || 60;
    ctx.clearRect(0, 0, w, h);

    // Fundo
    if (this.backgroundColor !== 'rgba(0,0,0,0.0)') {
      ctx.fillStyle = this.backgroundColor;
      ctx.fillRect(0, 0, w, h);
    }

    const mid = h / 2;
    const step = this.peaks.length / w;

    ctx.fillStyle = this.color;
    for (let x = 0; x < w; x++) {
      const idx = Math.floor(x * step);
      const amp = this.peaks[idx] || 0;
      const barH = Math.max(1, amp * (mid - 2));
      ctx.fillRect(x, mid - barH, 1, barH * 2);
    }

    // Redesenha playhead se já existia
    if (this._lastPlayheadX >= 0) {
      this._drawPlayheadLine(this._lastPlayheadX);
    }
  }

  /** Desenha apenas a frame de playhead (sobrepõe ao waveform). */
  _drawFrame(playheadX) {
    // Redesenha waveform + playhead em uma única chamada (rápido para canvas pequeno)
    if (!this.peaks) return;
    const { canvas, ctx } = this;
    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;
    const step = this.peaks.length / w;

    ctx.clearRect(0, 0, w, h);

    // Fundo
    if (this.backgroundColor !== 'rgba(0,0,0,0.0)') {
      ctx.fillStyle = this.backgroundColor;
      ctx.fillRect(0, 0, w, h);
    }

    // Desenha waveform: parte à esquerda do playhead fica mais clara
    for (let x = 0; x < w; x++) {
      const idx = Math.floor(x * step);
      const amp = this.peaks[idx] || 0;
      const barH = Math.max(1, amp * (mid - 2));

      if (x < playheadX) {
        ctx.fillStyle = 'rgba(180,210,255,0.95)'; // já reproduzido
      } else {
        ctx.fillStyle = this.color;
      }
      ctx.fillRect(x, mid - barH, 1, barH * 2);
    }

    // Playhead
    this._drawPlayheadLine(playheadX);
  }

  /** Desenha a linha vertical do playhead. */
  _drawPlayheadLine(x) {
    const { ctx, canvas } = this;
    ctx.save();
    ctx.strokeStyle = this.playheadColor;
    ctx.lineWidth = this.playheadWidth;
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
    ctx.restore();
  }
}
