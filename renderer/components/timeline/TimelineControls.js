import { RULER_HEIGHT, TRACK_HEIGHT } from './TimelineEngine.js';

/**
 * TimelineControls
 * Liga eventos de mouse/teclado do canvas ao TimelineEngine e dispara
 * callbacks para persistir mudanças (mover clipe, dividir, selecionar,
 * buscar por timecode) via IPC, deixando o engine livre de I/O.
 */
export class TimelineControls {
  /**
   * @param {import('./TimelineEngine.js').TimelineEngine} engine
   * @param {HTMLCanvasElement} canvas
   * @param {Object} callbacks
   * @param {(seconds:number) => void} callbacks.onSeek
   * @param {(clipId:number|null) => void} callbacks.onSelectClip
   * @param {(clip:Object, newStartTime:number) => void} callbacks.onMoveClip
   * @param {(clip:Object, splitAtSeconds:number) => void} callbacks.onSplitClip
   * @param {() => void} callbacks.onRender - Solicita novo frame (engine.render())
   */
  constructor(engine, canvas, callbacks = {}) {
    this.engine = engine;
    this.canvas = canvas;
    this.callbacks = callbacks;

    this.tool = 'select'; // 'select' | 'blade'
    this.readOnly = !!callbacks.readOnly;
    this.dragState = null; // { clip, startX, originalStartTime }
    this.snapThresholdPx = 8;

    this._bindEvents();
  }

  setTool(tool) {
    if (this.readOnly) return;
    this.tool = tool;
    this.canvas.style.cursor = tool === 'blade' ? 'crosshair' : 'default';
  }

  _bindEvents() {
    this._boundMouseDown = this._onMouseDown.bind(this);
    this._boundMouseMove = this._onMouseMove.bind(this);
    this._boundMouseUp = this._onMouseUp.bind(this);
    this._boundDoubleClick = this._onDoubleClick.bind(this);

    this.canvas.addEventListener('mousedown', this._boundMouseDown);
    window.addEventListener('mousemove', this._boundMouseMove);
    window.addEventListener('mouseup', this._boundMouseUp);
    this.canvas.addEventListener('dblclick', this._boundDoubleClick);
  }

  destroy() {
    if (this._boundMouseDown) this.canvas.removeEventListener('mousedown', this._boundMouseDown);
    if (this._boundMouseMove) window.removeEventListener('mousemove', this._boundMouseMove);
    if (this._boundMouseUp) window.removeEventListener('mouseup', this._boundMouseUp);
    if (this._boundDoubleClick) this.canvas.removeEventListener('dblclick', this._boundDoubleClick);

    this._boundMouseDown = null;
    this._boundMouseMove = null;
    this._boundMouseUp = null;
    this._boundDoubleClick = null;
    this.callbacks = {};
  }

  _getCanvasPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _onMouseDown(e) {
    const { x, y } = this._getCanvasPos(e);

    // Clique na régua ou em qualquer área quando em modo sync = seek do playhead
    if (y < RULER_HEIGHT || this.readOnly) {
      const time = this.engine.xToTime(x);
      this.engine.setPlayhead(time);
      this.callbacks.onSeek?.(time);
      this.callbacks.onRender?.();
      return;
    }

    const hit = this.engine.hitTest(x, y);
    if (!hit) return;

    if (this.tool === 'blade') {
      if (hit.clip) {
        this.callbacks.onSplitClip?.(hit.clip, hit.time);
      }
      return;
    }

    // Ferramenta de seleção/movimento
    if (hit.clip) {
      this.engine.selectedClipId = hit.clip.id;
      this.callbacks.onSelectClip?.(hit.clip.id);
      this.dragState = {
        clip: hit.clip,
        startX: x,
        originalStartTime: hit.clip.start_time,
        originalEndTime: hit.clip.end_time
      };
    } else {
      this.engine.selectedClipId = null;
      this.callbacks.onSelectClip?.(null);
    }
    this.callbacks.onRender?.();
  }

  _onMouseMove(e) {
    if (!this.dragState || this.readOnly) return;
    const { x } = this._getCanvasPos(e);
    const deltaSeconds = (x - this.dragState.startX) / this.engine.pxPerSecond;

    let newStart = Math.max(0, this.dragState.originalStartTime + deltaSeconds);
    newStart = this._applySnap(newStart, this.dragState.clip);

    const duration = this.dragState.originalEndTime - this.dragState.originalStartTime;
    this.dragState.clip.start_time = newStart;
    this.dragState.clip.end_time = newStart + duration;

    this.callbacks.onRender?.();
  }

  _onMouseUp() {
    if (this.dragState && !this.readOnly) {
      const { clip } = this.dragState;
      this.callbacks.onMoveClip?.(clip, clip.start_time);
      this.dragState = null;
    }
  }

  _onDoubleClick(e) {
    if (this.readOnly) return;
    const { x, y } = this._getCanvasPos(e);
    if (y < RULER_HEIGHT) return;
    const hit = this.engine.hitTest(x, y);
    if (hit?.clip) this.callbacks.onOpenClip?.(hit.clip);
  }

  /**
   * Encaixa (snap) o início do clipe às bordas de outros clipes na mesma
   * track ou ao playhead, dentro de uma tolerância em pixels.
   */
  _applySnap(newStart, movingClip) {
    const thresholdSeconds = this.snapThresholdPx / this.engine.pxPerSecond;
    const track = this.engine.tracks.find(t => (t.clips || []).some(c => c.id === movingClip.id));
    if (!track) return newStart;

    const duration = movingClip.end_time - movingClip.start_time;
    const newEnd = newStart + duration;

    const snapCandidates = [];
    (track.clips || []).forEach(c => {
      if (c.id === movingClip.id) return;
      snapCandidates.push(c.start_time, c.end_time);
    });
    snapCandidates.push(this.engine.playhead);

    for (const candidate of snapCandidates) {
      if (Math.abs(newStart - candidate) < thresholdSeconds) return candidate;
      if (Math.abs(newEnd - candidate) < thresholdSeconds) return candidate - duration;
    }
    return newStart;
  }
}
