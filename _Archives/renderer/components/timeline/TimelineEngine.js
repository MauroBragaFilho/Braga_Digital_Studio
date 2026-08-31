/**
 * TimelineEngine
 * Motor de renderização da Mini Timeline em Canvas 2D.
 * Responsável por: régua de tempo, tracks (V1..Vn, A1..An), clipes,
 * waveforms em cache, playhead e marcadores. Não lida com interação
 * do usuário — isso é responsabilidade do TimelineControls.
 */

export const TRACK_HEIGHT = 56;
export const RULER_HEIGHT = 24;

export class TimelineEngine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} trackHeadersEl - Container onde os cabeçalhos de faixa (V1, A1...) são renderizados
   */
  constructor(canvas, trackHeadersEl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.trackHeadersEl = trackHeadersEl;

    this.pxPerSecond = 40;   // Nível de zoom horizontal
    this.tracks = [];        // [{ id, track_type, track_index, name, muted, locked, clips: [...] }]
    this.duration = 60;      // Duração total renderizada (segundos), com folga
    this.waveformCache = new Map(); // key -> peaks[] (key pode ser uuid ou `uuid_s${streamIndex}`)
    this.silences = [];             // [{ start, end, color }] - Regiões de silêncio
    this.fps = 30;
  }

  setData({ tracks, markers, silences, fps }) {
    this.tracks = tracks || [];
    this.markers = markers || [];
    this.silences = silences || [];
    if (fps) this.fps = fps;

    const maxEnd = this.tracks.reduce((max, t) => {
      const trackMax = (t.clips || []).reduce((m, c) => Math.max(m, c.end_time || 0), 0);
      return Math.max(max, trackMax);
    }, 0);
    this.duration = Math.max(60, maxEnd + 20);

    this.resize();
    this.renderTrackHeaders();
  }

  setWaveform(key, peaks) {
    this.waveformCache.set(key, peaks);
  }

  setSilences(silences) {
    this.silences = silences || [];
  }

  setZoom(pxPerSecond) {
    // Limite zoom horizontal para evitar extrapolar tamanho máximo seguro de Canvas em vídeos longos (ex: 3h+)
    const maxSafePxPerSecond = this.duration > 0 ? Math.floor(16384 / this.duration) : 100;
    const clampedPx = Math.min(Math.max(0.5, pxPerSecond), Math.max(10, maxSafePxPerSecond));
    this.pxPerSecond = clampedPx;
    this.resize();
  }

  setPlayhead(seconds) {
    this.playhead = Math.max(0, seconds);
  }

  timeToX(seconds) {
    return seconds * this.pxPerSecond;
  }

  xToTime(x) {
    return Math.max(0, x / this.pxPerSecond);
  }

  trackYOffset(index) {
    return RULER_HEIGHT + index * TRACK_HEIGHT;
  }

  resize() {
    const parentWidth = this.canvas.parentElement?.clientWidth || 800;
    // Limite superior de 16384px para manter performance e compatibilidade de hardware/canvas
    const width = Math.min(16384, Math.max(parentWidth, Math.ceil(this.timeToX(this.duration))));
    const height = Math.max(RULER_HEIGHT + TRACK_HEIGHT, RULER_HEIGHT + this.tracks.length * TRACK_HEIGHT);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.logicalWidth = width;
    this.logicalHeight = height;
  }

  renderTrackHeaders() {
    if (!this.trackHeadersEl) return;
    this.trackHeadersEl.innerHTML = '';
    this.trackHeadersEl.style.paddingTop = `${RULER_HEIGHT}px`;

    this.tracks.forEach(track => {
      const el = document.createElement('div');
      el.className = `ws-track-header ${track.track_type}`;
      el.style.height = `${TRACK_HEIGHT}px`;
      el.innerHTML = `
        <span>${escapeHtmlLocal(track.name || (track.track_type === 'video' ? 'V' : 'A') + track.track_index)}</span>
        <span class="ws-track-header-btns">
          <button data-action="mute" title="Mudo">${track.muted ? 'M' : '🔇'}</button>
          <button data-action="lock" title="Bloquear">${track.locked ? '🔒' : '🔓'}</button>
        </span>
      `;
      el.dataset.trackId = track.id;
      this.trackHeadersEl.appendChild(el);
    });
  }

  render() {
    const ctx = this.ctx;
    const w = this.logicalWidth;
    const h = this.logicalHeight;
    if (!w || !h) return;

    ctx.clearRect(0, 0, w, h);

    this._drawRuler(ctx, w);
    this._drawTracks(ctx, w);
    this._drawSilences(ctx, h);
    this._drawMarkers(ctx, w);
    this._drawPlayhead(ctx, h);
  }

  _drawSilences(ctx, h) {
    if (!this.silences || this.silences.length === 0) return;
    this.silences.forEach(s => {
      const x1 = this.timeToX(s.start);
      const x2 = this.timeToX(s.end);
      const width = Math.max(2, x2 - x1);
      ctx.fillStyle = s.color || 'rgba(239, 68, 68, 0.28)';
      ctx.fillRect(x1, RULER_HEIGHT, width, h - RULER_HEIGHT);

      ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x1, RULER_HEIGHT, width, h - RULER_HEIGHT);
    });
  }

  _drawRuler(ctx, w) {
    ctx.fillStyle = '#0c0d10';
    ctx.fillRect(0, 0, w, RULER_HEIGHT);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT);
    ctx.lineTo(w, RULER_HEIGHT);
    ctx.stroke();

    // Escolhe um intervalo "bonito" de segundos entre marcações, baseado no zoom
    const minPxBetweenLabels = 80;
    const secondsPerLabel = niceInterval(minPxBetweenLabels / this.pxPerSecond);

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'middle';

    for (let t = 0; t <= this.duration; t += secondsPerLabel) {
      const x = this.timeToX(t);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 6);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();
      ctx.fillText(secondsToHMS(t), x + 3, RULER_HEIGHT / 2);
    }
  }

  _drawTracks(ctx, w) {
    this.tracks.forEach((track, index) => {
      const y = this.trackYOffset(index);
      const isAudio = track.track_type === 'audio';

      ctx.fillStyle = index % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, y, w, TRACK_HEIGHT);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(0, y + TRACK_HEIGHT);
      ctx.lineTo(w, y + TRACK_HEIGHT);
      ctx.stroke();

      (track.clips || []).forEach(clip => this._drawClip(ctx, clip, y, isAudio));
    });
  }

  _drawClip(ctx, clip, trackY, isAudio) {
    const x = this.timeToX(clip.start_time);
    const width = Math.max(2, this.timeToX(clip.end_time - clip.start_time));
    const y = trackY + 4;
    const height = TRACK_HEIGHT - 8;
    const selected = clip.id === this.selectedClipId;

    const baseColor = isAudio ? '#22c55e' : '#6366f1';
    ctx.fillStyle = hexWithAlpha(baseColor, selected ? 0.45 : 0.28);
    ctx.strokeStyle = selected ? '#f59e0b' : hexWithAlpha(baseColor, 0.9);
    ctx.lineWidth = selected ? 2 : 1;
    roundRect(ctx, x, y, width, height, 4);
    ctx.fill();
    ctx.stroke();

    // Waveform (clipes de áudio)
    if (isAudio && (clip.waveform_key || clip.media_uuid)) {
      const key = clip.waveform_key || clip.media_uuid;
      const peaks = this.waveformCache.get(key);
      if (peaks && peaks.length > 0) this._drawClipWaveform(ctx, clip, x, y, width, height, peaks);
    }

    // Rótulo
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.fillStyle = '#fff';
    ctx.font = '11px Inter, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(clip.name || 'Clipe', x + 5, y + 4);
    ctx.restore();
  }

  _drawClipWaveform(ctx, clip, x, y, width, height, peaks) {
    // Assume peaks a 100/s (peaks_per_second do WaveformService)
    const peaksPerSecond = 100;
    const inIdx = Math.floor((clip.in_point || 0) * peaksPerSecond);
    const outIdx = Math.floor((clip.out_point || (clip.end_time - clip.start_time)) * peaksPerSecond);
    const span = Math.max(1, outIdx - inIdx);
    const mid = y + height / 2;

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    const step = span / width;
    for (let px = 0; px < width; px++) {
      const idx = inIdx + Math.floor(px * step);
      const amp = peaks[idx] || 0;
      const barH = Math.max(1, amp * (height / 2) * 0.9);
      ctx.fillRect(x + px, mid - barH, 1, barH * 2);
    }
  }

  _drawMarkers(ctx, w) {
    this.markers.forEach(marker => {
      const x = this.timeToX(marker.time);
      ctx.fillStyle = marker.color || '#f59e0b';
      ctx.beginPath();
      ctx.moveTo(x - 5, 0);
      ctx.lineTo(x + 5, 0);
      ctx.lineTo(x, 8);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = hexWithAlpha(marker.color || '#f59e0b', 0.5);
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, this.logicalHeight);
      ctx.stroke();
    });
  }

  _drawPlayhead(ctx, h) {
    const x = this.timeToX(this.playhead);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();

    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Encontra o clipe (e sua track) sob a coordenada (x, y) do canvas.
   */
  hitTest(x, y) {
    const trackIndex = Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
    if (trackIndex < 0 || trackIndex >= this.tracks.length) return null;
    const track = this.tracks[trackIndex];
    const time = this.xToTime(x);

    const clip = (track.clips || []).find(c => time >= c.start_time && time <= c.end_time);
    if (!clip) return { track, clip: null, time };
    return { track, clip, time };
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexWithAlpha(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function niceInterval(rawSeconds) {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const s of steps) if (s >= rawSeconds) return s;
  return 3600;
}

function secondsToHMS(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function escapeHtmlLocal(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
