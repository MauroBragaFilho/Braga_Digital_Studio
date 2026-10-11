/**
 * Aba Áudio: sincronização multicâmera no estilo PluralEyes.
 *  1. Fontes = pastas de 1º nível do projeto (cada câmera/gravador numa pasta); o usuário marca a fonte MESTRE.
 *  2. "Sincronizar" procura cada clipe das outras fontes dentro da linha mestre inteira (correlação de áudio).
 *  3. Linha do tempo: uma faixa por fonte, clipes na posição encontrada, cor pela confiança; clipes sem posição
 *     ficam listados com ajuste manual; qualquer clipe pode ser deslocado (digitando a posição) e a faixa inteira
 *     pode ser empurrada de uma vez.
 *  4. Exportar: sequência multicâmera em XML para o Premiere (aba Entrega também).
 */
import { ws, $, mk, icon, formatClock, formatDuration, relativeWhen, reloadSyncGroups, emitChange, setAppStatus, friendlyError } from './state.js';

let sources = [];
let masterId = null;
let model = null;        // MulticamSyncService.getModel
let running = false;
let unsubProgress = null;
let goTo = () => {};
let zoom = 1;

/** Liga os eventos aos elementos desta abertura (a tela é recriada a cada projeto aberto) e assina o progresso. */
export function bindAudio(navigate) {
  goTo = navigate;
  unbindAudio();
  sources = []; masterId = null; model = null; running = false; zoom = 1;
  $('wsSyncRun')?.addEventListener('click', runSync);
  $('wsSyncGroupSelect')?.addEventListener('change', async (e) => { const id = Number(e.target.value); if (id) await loadModel(id); });
  $('wsSyncDelete')?.addEventListener('click', deleteCurrent);
  $('wsSyncExport')?.addEventListener('click', exportMulticam);
  $('wsSyncGoFiles')?.addEventListener('click', () => goTo('files'));
  $('wsSyncZoomIn')?.addEventListener('click', () => { zoom = Math.min(8, zoom * 1.5); renderTimeline(); });
  $('wsSyncZoomOut')?.addEventListener('click', () => { zoom = Math.max(1, zoom / 1.5); renderTimeline(); });
  if (typeof window.bds.onAudioSyncProgress === 'function') {
    unsubProgress = window.bds.onAudioSyncProgress((p) => {
      if (!running || !p || (p.projectId && p.projectId !== ws.projectId)) return;
      const line = $('wsSyncProgress');
      if (!line) return;
      const stage = { master: 'Lendo o áudio da fonte mestre', extract: 'Lendo o áudio', correlate: 'Procurando na linha mestre', done: 'Posicionado' }[p.stage] || 'Processando';
      line.textContent = `${stage}: ${p.name || ''}${p.source ? ` (${p.source})` : ''}${p.stage === 'done' && p.confidence != null ? ` · confiança ${Math.round(p.confidence * 100)}%` : ''}`;
    });
  }
}

export function unbindAudio() { if (unsubProgress) { try { unsubProgress(); } catch (_) { /* noop */ } unsubProgress = null; } }

export async function renderAudio() {
  try { sources = (await window.bds.listProjectSyncSources(ws.projectId)) || []; } catch (e) { sources = []; console.error('[WORKSPACE] fontes:', e); }
  if (!masterId || !sources.some((s) => s.id === masterId)) {
    // sugestão: a fonte com áudio de maior duração total
    const withAudio = sources.filter((s) => s.has_audio).sort((a, b) => b.total_duration - a.total_duration);
    masterId = withAudio.length ? withAudio[0].id : null;
  }
  renderSources();
  renderGroups();
  if (!model && ws.syncGroups.length) await loadModel(ws.syncGroups[ws.syncGroups.length - 1].id);
  else renderTimeline();
}

function renderSources() {
  const host = $('wsSyncSources'); if (!host) return;
  host.textContent = '';
  if (!sources.length) {
    host.append(mk('p', { class: 'ws-empty-line', text: 'Nenhum vídeo ou áudio no projeto. Adicione em Arquivos, uma pasta por câmera ou gravador (ex.: Câmera da TV, Câmera do Quadro, Gravação do PC).' }));
    $('wsSyncRun').disabled = true;
    return;
  }
  const onlyOne = sources.length < 2;
  for (const s of sources) {
    const radio = mk('input', { type: 'radio', name: 'wsSyncMaster', value: String(s.id), checked: s.id === masterId, disabled: !s.has_audio, 'aria-label': `Usar ${s.name} como mestre`, onchange: () => { masterId = s.id; renderSources(); } });
    host.append(mk('label', { class: `ws-source${s.id === masterId ? ' is-master' : ''}${!s.has_audio ? ' no-audio' : ''}` }, [
      radio,
      icon(s.kind === 'audio' ? 'mic' : 'videocam'),
      mk('div', { class: 'ws-source-text' }, [
        mk('b', { text: s.name }),
        mk('span', { text: `${s.items.length} ${s.items.length === 1 ? 'clipe' : 'clipes'} · ${formatDuration(s.total_duration)}${s.has_audio ? '' : ' · sem áudio (segue a cadeia ou ajuste manual)'}` })
      ]),
      s.id === masterId ? mk('span', { class: 'ws-source-badge', text: 'mestre' }) : null
    ]));
  }
  const run = $('wsSyncRun');
  run.disabled = onlyOne || !masterId || running;
  const hint = $('wsSyncHint');
  if (hint) hint.textContent = onlyOne ? 'Com uma única fonte não há o que sincronizar: coloque cada câmera ou gravador numa pasta própria em Arquivos.' : 'A mestre fixa a linha do tempo (escolha a que tem o melhor áudio contínuo). Os clipes das outras fontes são procurados dentro dela.';
}

function renderGroups() {
  const sel = $('wsSyncGroupSelect'); if (!sel) return;
  sel.textContent = '';
  for (const g of ws.syncGroups) sel.append(mk('option', { value: String(g.id), text: g.name }));
  if (model) sel.value = String(model.group.id);
  $('wsSyncResult')?.classList.toggle('hidden', !ws.syncGroups.length);
  $('wsSyncDelete').disabled = !model;
  $('wsSyncExport').disabled = !model;
}

async function runSync() {
  if (running || !masterId) return;
  running = true;
  $('wsSyncRun').disabled = true;
  $('wsSyncProgressBox')?.classList.remove('hidden');
  $('wsSyncProgress').textContent = 'Preparando…';
  try {
    const r = await window.bds.runMulticamSync({ projectId: ws.projectId, masterSourceId: masterId });
    await reloadSyncGroups();
    emitChange('sync');
    model = r;
    renderGroups();
    renderTimeline();
    const placed = r.lanes.reduce((n, l) => n + l.clips.filter((c) => c.placed).length, 0);
    const total = r.lanes.reduce((n, l) => n + l.clips.length, 0);
    setAppStatus(`Sincronização concluída: ${placed} de ${total} clipes posicionados.`, placed === total ? 'success' : 'warning');
  } catch (e) {
    window.bdsModal.alert(`A sincronização falhou: ${friendlyError(e)}`);
  } finally {
    running = false;
    $('wsSyncProgressBox')?.classList.add('hidden');
    renderSources();
  }
}

async function loadModel(groupId) {
  try { model = await window.bds.getMulticamModel(ws.projectId, groupId); }
  catch (e) { model = null; console.error('[WORKSPACE] modelo multicam:', e); }
  renderGroups();
  renderTimeline();
}

async function deleteCurrent() {
  if (!model) return;
  const ok = await window.bdsModal.confirm(`Excluir a sincronização "${model.group.name}"? Os arquivos não são afetados.`);
  if (!ok) return;
  try {
    await window.bds.deleteProjectSyncGroup(model.group.id);
    model = null;
    await reloadSyncGroups(); emitChange('sync');
    renderGroups(); renderTimeline();
  } catch (e) { window.bdsModal.alert(`Não foi possível excluir: ${friendlyError(e)}`); }
}

async function exportMulticam() {
  if (!model) return;
  try {
    setAppStatus('Gerando XML…', 'info');
    const r = await window.bds.exportProjectXmeml(ws.projectId, { mode: 'multicam', groupId: model.group.id });
    if (!r) { setAppStatus('Exportação cancelada.', 'info'); return; }
    setAppStatus('XML exportado.', 'success');
    window.bdsModal.alert(`Sequência multicâmera exportada.\n\n${r.filePath}\n\n${r.videoTracks} camadas de vídeo, ${r.audioTracks} trilhas de áudio, ${r.clips} clipes.\n\nNo Premiere: Arquivo → Importar e escolha este XML.`);
  } catch (e) { window.bdsModal.alert(`Não foi possível exportar: ${friendlyError(e)}`); }
}

// ------------------------------------------------------------------ linha do tempo

const confTone = (c) => (c >= 0.6 ? 'ok' : c >= 0.3 ? 'warn' : 'bad');

function renderTimeline() {
  const host = $('wsSyncTimeline'); const pending = $('wsSyncPending');
  if (!host || !pending) return;
  host.textContent = ''; pending.textContent = '';
  const meta = $('wsSyncMeta');
  if (!model) {
    if (meta) meta.textContent = '';
    host.append(mk('p', { class: 'ws-empty-line', text: ws.syncGroups.length ? 'Escolha uma sincronização acima.' : 'Nenhuma sincronização ainda. Marque a fonte mestre e clique em Sincronizar.' }));
    return;
  }
  const start = model.start || 0; const span = Math.max(1, model.duration || 1);
  if (meta) meta.textContent = `${model.group.name} · ${formatDuration(span)} · ${model.lanes.length} fontes`;

  // régua
  const ruler = mk('div', { class: 'ws-tl-ruler' });
  const stepCandidates = [10, 30, 60, 300, 600, 1800, 3600];
  const target = span / (8 * zoom);
  const step = stepCandidates.find((s) => s >= target) || 3600;
  for (let t = 0; t <= span; t += step) {
    const tick = mk('span', { class: 'ws-tl-tick', text: formatClock(start + t).replace(/\.\d$/, '') });
    tick.style.left = `${(t / span) * 100}%`;
    ruler.append(tick);
  }
  const inner = mk('div', { class: 'ws-tl-inner' });
  inner.style.width = `${zoom * 100}%`;
  inner.append(mk('div', { class: 'ws-tl-row ws-tl-head' }, [mk('div', { class: 'ws-tl-label' }), mk('div', { class: 'ws-tl-lane' }, [ruler])]));

  for (const lane of model.lanes) {
    const laneEl = mk('div', { class: 'ws-tl-lane' });
    for (const c of lane.clips) {
      if (!c.placed) continue;
      const block = mk('button', {
        type: 'button', class: `ws-tl-clip tone-${lane.is_master ? 'master' : confTone(c.confidence)}`,
        title: `${c.name}\nInício: ${formatClock(c.offset)} · Duração: ${formatDuration(c.duration)}${lane.is_master ? '' : ` · Confiança: ${Math.round(c.confidence * 100)}%`}`,
        onclick: () => editClip(lane, c)
      }, [mk('span', { class: 'ws-tl-clip-name', text: c.name })]);
      block.style.left = `${((c.offset - start) / span) * 100}%`;
      block.style.width = `${Math.max(0.3, (c.duration / span) * 100)}%`;
      laneEl.append(block);
    }
    const label = mk('div', { class: 'ws-tl-label' }, [
      mk('b', {}, [lane.is_master ? icon('star') : null, lane.name]),
      mk('span', { text: `${lane.clips.filter((c) => c.placed).length}/${lane.clips.length} clipes` }),
      lane.is_master ? null : mk('button', { type: 'button', class: 'ws-link', onclick: () => shiftLane(lane) }, 'Empurrar faixa…')
    ]);
    inner.append(mk('div', { class: 'ws-tl-row' }, [label, laneEl]));

    for (const c of lane.clips.filter((x) => !x.placed)) {
      pending.append(mk('li', { class: 'ws-pending-item' }, [
        icon(c.kind === 'audio' ? 'mic' : 'videocam'),
        mk('span', { class: 'ws-pending-name', text: `${c.name} (${lane.name})` }),
        mk('span', { class: 'ws-pending-why', text: c.has_audio ? 'não encontrado na mestre' : 'sem áudio' }),
        mk('button', { type: 'button', class: 'ws-btn-outline', onclick: () => placeManually(lane, c) }, 'Posicionar…')
      ]));
    }
  }
  const scroller = mk('div', { class: 'ws-tl-scroll' }, [inner]);
  host.append(scroller);
  $('wsSyncPendingBox')?.classList.toggle('hidden', pending.children.length === 0);
}

/** Posição digitada como segundos ou hh:mm:ss(.d). */
function parseClock(text) {
  const t = String(text || '').trim().replace(',', '.');
  if (!t) return null;
  const neg = t.startsWith('-');
  const parts = t.replace('-', '').split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let s = 0; for (const p of parts) s = s * 60 + p;
  return neg ? -s : s;
}

async function editClip(lane, c) {
  const v = await window.bdsModal.prompt(`Posição de "${c.name}" na linha do tempo (hh:mm:ss.d ou segundos):`, formatClock(c.offset));
  if (v === null) return;
  const sec = parseClock(v);
  if (sec === null) { window.bdsModal.alert('Posição inválida.'); return; }
  await setOffset(c.media_id, sec);
}

async function placeManually(lane, c) {
  const after = lane.clips.filter((x) => x.placed && x.chain_pos < c.chain_pos).sort((a, b) => b.chain_pos - a.chain_pos)[0];
  const suggested = after ? after.offset + (c.chain_pos - after.chain_pos) : (model.start || 0);
  const v = await window.bdsModal.prompt(`Onde começa "${c.name}"? (hh:mm:ss.d ou segundos)${after ? `\nSugestão: logo após ${after.name}.` : ''}`, formatClock(suggested));
  if (v === null) return;
  const sec = parseClock(v);
  if (sec === null) { window.bdsModal.alert('Posição inválida.'); return; }
  await setOffset(c.media_id, sec);
}

async function shiftLane(lane) {
  const v = await window.bdsModal.prompt(`Empurrar todos os clipes de "${lane.name}" em quantos segundos? (negativo = para trás)`, '0');
  if (v === null) return;
  const delta = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(delta) || !delta) return;
  try {
    for (const c of lane.clips.filter((x) => x.placed)) await window.bds.setSyncClipOffset(model.group.id, c.media_id, c.offset + delta);
    await afterManualChange();
  } catch (e) { window.bdsModal.alert(`Não foi possível deslocar: ${friendlyError(e)}`); }
}

async function setOffset(mediaId, sec) {
  try { await window.bds.setSyncClipOffset(model.group.id, mediaId, sec); await afterManualChange(); }
  catch (e) { window.bdsModal.alert(`Não foi possível posicionar: ${friendlyError(e)}`); }
}

async function afterManualChange() {
  await reloadSyncGroups(); emitChange('sync');
  await loadModel(model.group.id);
  setAppStatus('Posição ajustada.', 'success');
}

export const lastSyncLabel = () => (ws.syncGroups.length ? `${ws.syncGroups[ws.syncGroups.length - 1].name} · ${relativeWhen(ws.syncGroups[ws.syncGroups.length - 1].created_at)}` : '');
