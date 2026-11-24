/**
 * Remover silêncio dentro do projeto: a função da antiga tela "Remover Silêncio" agora vive aqui. Escolha arquivos na
 * aba Arquivos, clique em "Remover silêncio" na barra de seleção e ajuste o modo (remover ou reduzir). Sensibilidade e
 * duração mínima ficam em "Ajustes". Os arquivos novos vão para uma pasta de destino (o original nunca é alterado) e
 * o processamento é o mesmo serviço de antes (silence:process, com progresso em silence:progress e fim em silence:finished).
 * O botão está sempre disponível em Projetos; não há módulo nem tela própria para isso.
 */
import { ws, $, mk, nameOf, kindOf, formatDuration, setAppStatus, friendlyError } from './state.js';

const FOLDER_KEY = 'bds.silence.outFolder';
let items = [];      // { path, name, duration }
let skipped = 0;     // selecionados que não entram (fotos, sem arquivo)
let running = false;
let outFolder = '';
let unsub = [];

const cleanText = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

/** Liga os eventos desta abertura da tela do projeto. */
export function bindSilence() {
  running = false; items = []; unsub = [];
  $('wsSelSilence')?.addEventListener('click', openSilence);
  $('wsSilClose')?.addEventListener('click', closeSilence);
  $('wsSilenceModal')?.addEventListener('click', (e) => { if (e.target.id === 'wsSilenceModal') closeSilence(); });
  $('wsSilFolderBtn')?.addEventListener('click', pickFolder);
  $('wsSilRun')?.addEventListener('click', run);
  $('wsSilStop')?.addEventListener('click', stop);
  $('wsSilReveal')?.addEventListener('click', () => { if (outFolder) window.bds?.openLocalPath?.(outFolder); });
}

async function defaultFolder() {
  try { const saved = localStorage.getItem(FOLDER_KEY); if (saved) return saved; } catch (_) { /* sem armazenamento */ }
  try {
    const dir = (await window.bds?.getVideosPath?.()) || '';
    if (dir) return `${dir}${/[\\/]$/.test(dir) ? '' : (dir.includes('\\') ? '\\' : '/')}RemoverSilencio`;
  } catch (_) { /* usa vazio */ }
  return '';
}

async function openSilence() {
  const picked = [...ws.selected].map((id) => ws.media.find((m) => m.pm_id === id)).filter(Boolean);
  items = picked.filter((m) => kindOf(m) !== 'photo' && m.filepath)
    .map((m) => ({ path: m.filepath, name: nameOf(m), duration: Number(m.duration) || 0 }));
  skipped = picked.length - items.length;
  if (!items.length) { window.bdsModal.alert('Selecione vídeos ou áudios do projeto para remover o silêncio.'); return; }
  try {
    const st = await window.bds?.silenceGetState?.();
    if (st && st.running) { window.bdsModal.alert('Já há uma remoção de silêncio em andamento. Aguarde terminar.'); return; }
  } catch (_) { /* segue */ }
  outFolder = await defaultFolder();
  renderFiles();
  $('wsSilFolder').value = outFolder;
  showResult('');
  setProgress(0, '', false);
  setRunning(false);
  $('wsSilenceModal')?.classList.remove('hidden');
}

function renderFiles() {
  const list = $('wsSilFiles');
  list.replaceChildren(...items.map((it) => mk('li', {}, [mk('span', { class: 'ws-sil-name', text: it.name }), mk('span', { class: 'ws-muted', text: it.duration ? formatDuration(it.duration) : '' })])));
  const total = items.reduce((s, it) => s + it.duration, 0);
  $('wsSilSummary').textContent = `${items.length} ${items.length === 1 ? 'arquivo' : 'arquivos'}${total ? ` · ${formatDuration(total)}` : ''}${skipped ? ` (${skipped} ignorado${skipped === 1 ? '' : 's'}: foto ou sem arquivo)` : ''}`;
}

function setRunning(on) {
  running = on;
  $('wsSilRun').classList.toggle('hidden', on);
  $('wsSilStop').classList.toggle('hidden', !on);
  for (const id of ['wsSilMode', 'wsSilThreshold', 'wsSilMin', 'wsSilFolderBtn']) { const el = $(id); if (el) el.disabled = on; }
}

function setProgress(percent, text, visible = true) {
  $('wsSilProgress')?.classList.toggle('hidden', !visible);
  const bar = $('wsSilBar'); if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  const label = $('wsSilStatus'); if (label) label.textContent = text;
}

function showResult(text, { reveal = false } = {}) {
  const box = $('wsSilResult');
  box.textContent = text;
  box.classList.toggle('hidden', !text);
  $('wsSilReveal')?.classList.toggle('hidden', !reveal);
}

async function pickFolder() {
  const folder = await window.bds?.selectFolder?.(outFolder || '');
  if (!folder) return;
  outFolder = folder;
  $('wsSilFolder').value = folder;
  try { localStorage.setItem(FOLDER_KEY, folder); } catch (_) { /* sem armazenamento */ }
}

function clampNumber(el, min, max, fallback) {
  const n = Number(String(el && el.value).replace(',', '.'));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function listen() {
  unlisten();
  unsub.push(window.bds.onSilenceProgress((p) => {
    if (!p) return;
    const idx = p.index || 1; const total = p.total || items.length;
    setProgress(p.percent || 0, `Arquivo ${idx} de ${total}: ${cleanText(p.message || p.status || 'Processando')}`);
    setAppStatus(`Removendo silêncio ${Math.round(p.percent || 0)}%…`, 'info');
  }));
  unsub.push(window.bds.onSilenceFinished((p) => { unlisten(); onFinished(p || {}); }));
}
function unlisten() { for (const off of unsub) { try { off(); } catch (_) { /* já removido */ } } unsub = []; }

function onFinished(p) {
  setRunning(false);
  const base = (f) => String(f || '').split(/[\\/]/).pop();
  const skip = p.skipped || []; const fail = p.failed || [];
  if (p.status === 'canceled') {
    setProgress(0, '', false); showResult('Cancelado. O que já foi feito fica na pasta de destino.', { reveal: true });
    setAppStatus('Cancelado', 'warning'); return;
  }
  if (p.status === 'success' || p.status === 'partial') {
    setProgress(100, 'Concluído');
    let msg = p.processedCount > 0
      ? `Silêncio removido de ${p.processedCount} ${p.processedCount === 1 ? 'arquivo' : 'arquivos'}.`
      : 'Nenhum silêncio foi detectado com esta sensibilidade; os arquivos foram copiados sem cortes. Se há pausas, tente uma sensibilidade mais alta (por exemplo, -25 dB).';
    if (skip.length) msg += `\nIgnorados: ${skip.map((s) => `${base(s.file)} (${cleanText(s.reason)})`).join('; ')}`;
    if (fail.length) msg += `\nCom erro: ${fail.map((s) => `${base(s.file)} (${friendlyError(s.error)})`).join('; ')}`;
    showResult(msg, { reveal: true });
    setAppStatus(p.status === 'success' ? 'Pronto' : 'Concluído com avisos', p.status === 'success' ? 'success' : 'warning');
    return;
  }
  setProgress(0, '', false);
  showResult(friendlyError(p.error, 'Não foi possível remover o silêncio deste arquivo.'));
  setAppStatus('Erro', 'error');
}

async function run() {
  if (running || !items.length) return;
  if (!outFolder) { window.bdsModal.alert('Escolha a pasta de destino.'); return; }
  const config = {
    files: items.map((it) => it.path),
    threshold: Math.round(clampNumber($('wsSilThreshold'), -60, -10, -30)),
    minDuration: clampNumber($('wsSilMin'), 0.1, 5, 0.5),
    mode: $('wsSilMode')?.value || 'remove',
    outFolder
  };
  showResult('');
  setRunning(true);
  setProgress(0, 'Iniciando…');
  setAppStatus('Removendo silêncio…', 'warning');
  listen();
  try {
    await window.bds.processSilence(config); // o resultado real chega em silence:finished
  } catch (err) {
    unlisten(); setRunning(false); setProgress(0, '', false);
    showResult(`Não foi possível remover o silêncio: ${friendlyError(err)}`);
    setAppStatus('Erro', 'error');
  }
}

async function stop() {
  const btn = $('wsSilStop'); if (btn) btn.disabled = true;
  try { await window.bds?.cancelSilence?.(); } catch (_) { /* o evento de fim confirma */ } finally { if (btn) btn.disabled = false; }
}

function closeSilence() {
  if (running) { window.bdsModal.alert('A remoção está em andamento. Use "Cancelar" para parar.'); return; }
  unlisten();
  $('wsSilenceModal')?.classList.add('hidden');
}
