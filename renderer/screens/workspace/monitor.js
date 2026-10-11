/**
 * Monitor de origem como sobreposição (abre a partir de um arquivo em Arquivos): reprodução, marcas In/Out,
 * J/K/L, formas de onda por linha de áudio (até 3) com mudo independente. Esc fecha.
 */
import { $, mk, nameOf, isAudioOnly, secondsToTimecode, toFileUrl, drawWaveform, setAppStatus } from './state.js';

const MAX_TRACKS = 3;
let media = null;
let el = null;
let isAudio = false;
let markIn = 0; let markOut = 0; let hasOut = false;
let extraTracks = [];

export const monitorOpen = () => !$('wsMonitorOverlay')?.classList.contains('hidden');

/** Liga os eventos aos elementos desta abertura (a tela é recriada a cada projeto aberto). */
export function bindMonitor() {
  media = null; el = null; extraTracks = [];
  $('wsMonitorClose')?.addEventListener('click', closeMonitor);
  $('wsMonitorOverlay')?.addEventListener('click', (e) => { if (e.target.id === 'wsMonitorOverlay') closeMonitor(); });
  $('wsBtnMarkIn')?.addEventListener('click', markInNow);
  $('wsBtnMarkOut')?.addEventListener('click', markOutNow);
  $('wsBtnPlayPause')?.addEventListener('click', togglePlay);
  $('wsBtnFrameBack')?.addEventListener('click', () => stepFrame(-1));
  $('wsBtnFrameFwd')?.addEventListener('click', () => stepFrame(1));
  $('wsScrubber')?.addEventListener('input', (e) => { if (el) el.currentTime = Number(e.target.value) / 1000; });
}

export async function openMonitor(pm) {
  try {
    teardownTracks();
    media = pm;
    markIn = 0; markOut = pm.duration || 0; hasOut = false;
    $('wsMonitorOverlay')?.classList.remove('hidden');
    $('wsMonitorFileName').textContent = nameOf(pm);
    const videoEl = $('wsVideoEl'); const audioEl = $('wsAudioEl'); const audioIcon = $('wsAudioOnlyIcon');
    isAudio = isAudioOnly(pm);
    const url = toFileUrl(pm.filepath || '');
    videoEl.pause(); audioEl.pause();
    videoEl.removeAttribute('src'); audioEl.removeAttribute('src');
    videoEl.load(); audioEl.load();
    if (isAudio) { videoEl.classList.add('hidden'); audioIcon.classList.remove('hidden'); audioEl.src = url; el = audioEl; }
    else { videoEl.classList.remove('hidden'); audioIcon.classList.add('hidden'); videoEl.src = url; el = videoEl; }
    el.onloadedmetadata = () => {
      markOut = el.duration || pm.duration || 0;
      $('wsTcDuration').textContent = secondsToTimecode(el.duration, pm.fps || 30);
      $('wsScrubber').max = String(Math.floor((el.duration || 0) * 1000));
      updateIo();
    };
    el.ontimeupdate = () => {
      $('wsTcCurrent').textContent = secondsToTimecode(el.currentTime, pm.fps || 30);
      $('wsScrubber').value = String(Math.floor(el.currentTime * 1000));
      extraTracks.forEach((t) => { if (t && Math.abs(t.currentTime - el.currentTime) > 0.25) t.currentTime = el.currentTime; });
    };
    el.onplay = () => { $('wsPlayIcon').textContent = 'pause'; extraTracks.forEach((t) => { if (t) { t.currentTime = el.currentTime; t.play().catch(() => {}); } }); };
    el.onpause = () => { $('wsPlayIcon').textContent = 'play_arrow'; extraTracks.forEach((t) => { if (t) t.pause(); }); };
    el.onseeked = () => { extraTracks.forEach((t) => { if (t) t.currentTime = el.currentTime; }); };
    $('wsMonitorClose')?.focus();
    loadWaveforms(pm);
  } catch (e) {
    console.error('[WORKSPACE] monitor:', e);
    setAppStatus('Erro ao abrir a mídia no monitor.', 'error');
  }
}

export function closeMonitor() {
  try { if (el) el.pause(); } catch (_) { /* já parado */ }
  teardownTracks();
  $('wsMonitorOverlay')?.classList.add('hidden');
  media = null; el = null;
}

function teardownTracks() {
  extraTracks.forEach((t) => { try { t.pause(); t.src = ''; t.remove(); } catch (_) { /* noop */ } });
  extraTracks = [];
}

async function loadWaveforms(pm) {
  const container = $('wsWaveformsContainer');
  if (!container) return;
  container.textContent = '';
  teardownTracks();
  if (!pm.audio_codec && !isAudio) return;
  if (!pm.uuid || !pm.filepath) return;
  let streams = [];
  try { streams = (await window.bds.probeAudioStreams(pm.filepath)) || []; } catch (_) { streams = []; }
  if (!streams.length) streams = [{ index: 0, title: '', codec_name: '' }];
  const visible = streams.slice(0, MAX_TRACKS);
  if (streams.length > MAX_TRACKS) container.append(mk('div', { class: 'ws-empty-line', text: `Mostrando ${MAX_TRACKS} de ${streams.length} linhas de áudio.` }));
  visible.forEach((stream, i) => {
    const streamIndex = stream.index ?? i;
    const wrap = mk('div', { class: 'ws-wave-track' });
    let muted = false;
    const mute = mk('button', { type: 'button', class: 'ws-icon-btn', title: `Silenciar linha ${i + 1}` }, [mk('span', { class: 'material-symbols-rounded', text: 'volume_up' })]);
    mute.addEventListener('click', () => {
      muted = !muted;
      if (i === 0) { if (el) el.muted = muted; } else if (extraTracks[i]) extraTracks[i].muted = muted;
      mute.querySelector('span').textContent = muted ? 'volume_off' : 'volume_up';
      mute.title = muted ? `Ativar linha ${i + 1}` : `Silenciar linha ${i + 1}`;
    });
    wrap.append(mk('div', { class: 'ws-wave-label' }, [mk('span', { class: 'ws-track-tag', text: `A${i + 1}` }), mk('span', { text: stream.title || '' }), mute]));
    const canvas = mk('canvas', { class: 'ws-waveform-canvas', height: '36' });
    wrap.append(canvas);
    container.append(wrap);
    window.bds.getMediaWaveform({ uuid: pm.uuid, filePath: pm.filepath, duration: pm.duration || 0, peaksPerSecond: 100, streamIndex })
      .then((wf) => { if (media && media.pm_id === pm.pm_id && wf && wf.peaks) drawWaveform(canvas, wf.peaks); })
      .catch(() => {});
    if (i > 0 && window.bds.getTrackAudioPath) {
      window.bds.getTrackAudioPath({ uuid: pm.uuid, filePath: pm.filepath, streamIndex }).then((url) => {
        if (!media || media.pm_id !== pm.pm_id || !el) return;
        const t = new Audio(url); t.preload = 'auto'; t.currentTime = el.currentTime || 0;
        if (el.paused) t.pause(); else t.play().catch(() => {});
        extraTracks[i] = t;
      }).catch(() => {});
    }
  });
}

function updateIo() {
  if (!el || !media) return;
  const dur = el.duration || media.duration || 1;
  const fps = media.fps || 30;
  const range = $('wsIoRange');
  if (range) { range.style.left = `${Math.min(100, (markIn / dur) * 100)}%`; range.style.width = `${Math.max(0, Math.min(100, ((hasOut ? markOut : dur) / dur) * 100) - (markIn / dur) * 100)}%`; }
  $('wsInLabel').textContent = secondsToTimecode(markIn, fps);
  $('wsOutLabel').textContent = hasOut ? secondsToTimecode(markOut, fps) : '--:--:--:--';
  $('wsSelDurationLabel').textContent = hasOut ? secondsToTimecode(Math.max(0, markOut - markIn), fps) : '--:--:--:--';
}
function markInNow() { if (!el) return; markIn = el.currentTime; if (hasOut && markIn > markOut) markOut = markIn; updateIo(); }
function markOutNow() { if (!el) return; markOut = el.currentTime; hasOut = true; if (markOut < markIn) markIn = markOut; updateIo(); }
function togglePlay() { if (!el) return; if (el.paused) el.play(); else el.pause(); }
function stepFrame(dir) { if (!el || !media) return; el.pause(); el.currentTime = Math.max(0, el.currentTime + dir / (media.fps || 30)); }

/** Teclado enquanto o monitor está aberto: Esc fecha; espaço/K play-pause; J/L recua/avança; I/O marcam. */
export function monitorKey(e) {
  if (!monitorOpen()) return false;
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') { closeMonitor(); return true; }
  if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); return true; }
  if (k === 'j') { stepFrame(-1); return true; }
  if (k === 'l') { stepFrame(1); return true; }
  if (k === 'i') { markInNow(); return true; }
  if (k === 'o') { markOutNow(); return true; }
  return false;
}
