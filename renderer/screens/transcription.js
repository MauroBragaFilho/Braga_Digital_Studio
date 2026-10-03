/**
 * Tela "Transcrição" — gera legendas (.srt) e transcrições com tempo (.md), um resultado por arquivo.
 *
 * Fluxo em quatro modos (atributo data-mode da tela):
 *   empty   → só a área de soltar arquivos
 *   ready   → lista + ajustes (formatos, legenda, destino) + botão Transcrever
 *   running → lista com o progresso de cada arquivo + andamento geral + Cancelar
 *   done    → resumo (arquivos gerados) com Abrir pasta / Nova transcrição
 *
 * A instalação do módulo (motor, modelos, GPU) fica em Configurações → Transcrição; aqui só se usa
 * o que já está instalado. A lógica pesada roda no processo principal (src/core/modules); esta tela
 * pede ações via window.bds.modules* e mostra o andamento. Textos entram sempre por textContent.
 */

const SUPPORTED_EXTS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4a', 'wav', 'mp3', 'flac', 'ogg'];
const VIDEO_EXTS = new Set(['mp4', 'mkv', 'mov', 'avi', 'webm']);
const PREFS_KEY = 'bds.transcription.opts';

const $ = (id) => document.getElementById(id);

let items = [];            // { id, path, name, ext, isVideo, durationSeconds, status, progress, outputs, error }
let nextId = 1;
let status = null;         // resposta de modulesGetStatus
let mode = 'empty';
let cancelling = false;
let sawFileEvents = false; // o motor informa o andamento de cada arquivo? (senão estimamos pelo geral)
let batchPercent = 0;
let lastMessage = '';
let unsubs = [];
let bound = false;
let dragDepth = 0;
const rowEls = new Map();  // id -> elementos da linha, para atualizar sem recriar a lista

const opts = { srt: true, md: true, maxWords: 0, lines: 2, forceCpu: false, outMode: 'side', outDir: '' };
const running = () => mode === 'running';

// ------------------------------------------------------------------ utilitários

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'disabled') el.disabled = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of (Array.isArray(children) ? children : [children])) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const icon = (name) => h('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true', text: name });
const baseName = (p) => String(p).split(/[\\/]/).pop();
const extOf = (p) => (baseName(p).split('.').pop() || '').toLowerCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return hh > 0
    ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${mm}:${String(ss).padStart(2, '0')}`;
}

/** Chama uma API { ok, data } do módulo e devolve o dado (lança com .code em caso de falha). */
async function call(fn, ...args) {
  if (typeof fn !== 'function') throw new Error('Recurso indisponível nesta versão do app.');
  const res = await fn(...args);
  if (!res || !res.ok) {
    const err = new Error(res?.error || 'Falha desconhecida.');
    err.code = res?.code || null;
    throw err;
  }
  return res.data;
}

function loadPrefs() {
  try {
    const s = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (typeof s.srt === 'boolean') opts.srt = s.srt;
    if (typeof s.md === 'boolean') opts.md = s.md;
    if (Number.isInteger(s.maxWords) && s.maxWords >= 0 && s.maxWords <= 40) opts.maxWords = s.maxWords;
    if (s.lines === 1 || s.lines === 2) opts.lines = s.lines;
    if (typeof s.forceCpu === 'boolean') opts.forceCpu = s.forceCpu;
    if (s.outMode === 'side' || s.outMode === 'dir') opts.outMode = s.outMode;
    if (typeof s.outDir === 'string') opts.outDir = s.outDir;
    if (opts.outMode === 'dir' && !opts.outDir) opts.outMode = 'side';
  } catch (_) { /* sem preferências salvas */ }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(opts)); } catch (_) { /* sem armazenamento */ }
}

// ------------------------------------------------------------------ aviso e menu

function showNotice(text, tone = 'info') {
  const box = $('trNotice');
  if (!box) return;
  if (!text) { box.classList.add('hidden'); return; }
  const icons = { info: 'info', success: 'check_circle', warning: 'warning', danger: 'error' };
  box.className = `tr-notice tone-${tone}`;
  $('trNoticeIcon').textContent = icons[tone] || 'info';
  $('trNoticeText').textContent = text;
}

/** Menu flutuante simples: entries = [{ icon, label, sub?, selected?, disabled?, run }] ou { separator: true }. */
function showMenu(anchor, entries) {
  const menu = $('trMenu');
  menu.textContent = '';
  for (const e of entries) {
    if (e.separator) { menu.append(h('hr', { class: 'tr-menu-sep' })); continue; }
    menu.append(h('button', {
      type: 'button', role: 'menuitem', class: e.selected ? 'selected' : '', disabled: e.disabled,
      onclick: () => { hideMenu(); e.run(); }
    }, [
      icon(e.icon),
      h('span', { class: 'tr-menu-text' }, [h('span', { text: e.label }), e.sub ? h('small', { text: e.sub }) : null])
    ]));
  }
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth || 220;
  const hgt = menu.offsetHeight || 100;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - hgt - 8)}px`;
  menu.querySelector('button')?.focus();
}
function hideMenu() { $('trMenu')?.classList.add('hidden'); }

/** Leva para Configurações → Transcrição, onde se instala o módulo. */
function goToTranscriptionSettings() {
  document.querySelector('.sidebar .tab-button[data-view="settings"]')?.click();
  let tries = 0;
  const timer = setInterval(() => {
    const tab = document.querySelector('.settings-tab[data-tab="settingsTranscriptionView"]');
    if (tab || ++tries > 30) { clearInterval(timer); tab?.click(); }
  }, 100);
}

// ------------------------------------------------------------------ estado do módulo

async function refreshStatus() {
  try {
    status = await call(window.bds?.modulesGetStatus);
  } catch (err) {
    status = null;
    showNotice(`Não foi possível verificar o módulo de transcrição: ${err.message}`, 'danger');
  }
  renderEngine();
  renderDeviceControl();
  updatePanel();
}

/** Por que ainda não dá para iniciar (texto curto abaixo do botão), ou '' se está tudo certo. */
function blockedReason() {
  if (!status) return 'Verificando o módulo…';
  if (!status.platformSupported) return 'Disponível apenas no Windows.';
  if (!status.whisper.engine.installed) return 'Instale o módulo em Configurações → Transcrição.';
  if (!status.whisper.activeModelId) return 'Baixe um modelo em Configurações → Transcrição.';
  if (!opts.srt && !opts.md) return 'Marque ao menos um formato.';
  if (opts.outMode === 'dir' && !opts.outDir) return 'Escolha a pasta de destino.';
  return '';
}

function renderEngine() {
  const dot = $('trEngineDot');
  const text = $('trEngineText');
  if (!status) { dot.className = 'tr-dot'; text.textContent = 'Módulo indisponível'; return; }
  const w = status.whisper;
  if (w.ready) {
    const model = w.models.find((m) => m.active);
    const gpu = w.cuda.installed && !opts.forceCpu;
    dot.className = 'tr-dot ok';
    text.textContent = `Pronto · ${model ? model.label : 'modelo'} · ${gpu ? 'GPU' : 'CPU'}`;
  } else {
    dot.className = 'tr-dot warn';
    text.textContent = !w.engine.installed ? 'Instalar o módulo' : 'Falta escolher um modelo';
  }
}

function renderDeviceControl() {
  // Sem CUDA instalado só há CPU: o seletor de processamento (e o bloco "Avançado") some.
  const gpu = Boolean(status && status.whisper.cuda.installed);
  $('trDeviceField').classList.toggle('hidden', !gpu);
  $('trAdvanced').classList.toggle('hidden', !gpu);
}

/** Abre a lista de modelos instalados no próprio botão de status (troca o modelo em uso). */
function openModelMenu(anchor) {
  if (!status || !status.whisper.engine.installed) { goToTranscriptionSettings(); return; }
  const installed = status.whisper.models.filter((m) => m.installed);
  const entries = installed.map((m) => ({
    icon: m.active ? 'radio_button_checked' : 'radio_button_unchecked',
    label: m.label,
    sub: `Velocidade ${m.speed} · Qualidade ${m.quality}/5`,
    selected: m.active,
    run: () => selectModel(m.id)
  }));
  if (!entries.length) entries.push({ icon: 'info', label: 'Nenhum modelo instalado', disabled: true, run: () => {} });
  entries.push({ separator: true });
  entries.push({ icon: 'tune', label: 'Gerenciar modelos…', sub: 'Baixar ou remover em Configurações', run: goToTranscriptionSettings });
  showMenu(anchor, entries);
}

async function selectModel(id) {
  if (running()) return;
  try {
    status = await call(window.bds.modulesSetActiveModel, id);
    renderEngine();
    updatePanel();
  } catch (err) {
    showNotice(err.message, 'danger');
    await refreshStatus();
  }
}

// ------------------------------------------------------------------ modos da tela

function setMode(next) {
  mode = next;
  $('trRoot').dataset.mode = next;
  $('trSetup').classList.toggle('hidden', next === 'running' || next === 'done');
  $('trRun').classList.toggle('hidden', next !== 'running');
  $('trDone').classList.toggle('hidden', next !== 'done');
  $('btnTrAdd').classList.toggle('hidden', next === 'running');
  $('btnTrClear').classList.toggle('hidden', next === 'running' || next === 'done');
  updatePanel();
}

function updatePanel() {
  const n = items.length;
  const start = $('btnTrStart');
  const reason = blockedReason();
  start.textContent = n ? `Transcrever ${plural(n, 'arquivo', 'arquivos')}` : 'Transcrever';
  start.disabled = Boolean(reason) || n === 0 || mode !== 'ready';
  $('trCtaHint').textContent = reason;
  $('trEngine').disabled = running();
  $('trEngine').title = running() ? 'O modelo só pode ser trocado fora de uma transcrição' : 'Escolher o modelo de transcrição';
}

// ------------------------------------------------------------------ fila

function newItem(filePath) {
  const ext = extOf(filePath);
  return {
    id: String(nextId++), path: filePath, name: baseName(filePath), ext,
    isVideo: VIDEO_EXTS.has(ext), durationSeconds: 0,
    status: 'pending', progress: 0, outputs: [], error: null
  };
}

async function addFiles(paths) {
  if (running()) return;
  if (mode === 'done') items = []; // adicionar depois de concluir começa uma nova fila
  const known = new Set(items.map((i) => i.path.toLowerCase()));
  const accepted = [];
  let ignored = 0;
  for (const p of paths) {
    if (!p) continue;
    if (!SUPPORTED_EXTS.includes(extOf(p))) { ignored++; continue; }
    if (known.has(p.toLowerCase())) continue;
    known.add(p.toLowerCase());
    accepted.push(newItem(p));
  }
  if (accepted.length) {
    items.push(...accepted);
    showNotice('');
    renderList();
    setMode('ready');
    probeDurations(accepted);
  } else if (mode === 'done') {
    renderList();
    setMode(items.length ? 'ready' : 'empty');
  }
  if (ignored) showNotice(`${plural(ignored, 'arquivo ignorado', 'arquivos ignorados')}: formato não suportado.`, 'warning');
  else if (!accepted.length && paths.length) showNotice('Esses arquivos já estão na lista.', 'info');
}

/** Lê a duração de cada arquivo em segundo plano (3 por vez) sem travar a tela. */
async function probeDurations(list) {
  if (!window.bds?.probeMetadataFile) return;
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const item = list[next++];
      try {
        const info = await window.bds.probeMetadataFile(item.path);
        const dur = parseFloat(info?.format?.duration);
        if (Number.isFinite(dur)) item.durationSeconds = dur;
      } catch (_) { /* sem duração: a linha simplesmente não mostra */ }
      if (items.includes(item)) { paintRow(item); updateListHead(); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));
}

async function pickFiles() {
  try {
    const picked = await window.bds.selectFile({
      title: 'Selecionar vídeos ou áudios',
      filters: [{ name: 'Vídeo e áudio', extensions: SUPPORTED_EXTS }],
      properties: ['openFile', 'multiSelections']
    });
    const list = Array.isArray(picked) ? picked : (picked?.filePaths || []);
    if (list.length) await addFiles(list);
  } catch (err) {
    showNotice(`Não foi possível abrir o seletor: ${err.message}`, 'danger');
  }
}

async function pickFolder() {
  try {
    const folder = await window.bds.selectFolder('');
    if (!folder) return;
    const files = (await window.bds.getLibraryFolderFiles(folder)) || [];
    const media = files.filter((f) => SUPPORTED_EXTS.includes(extOf(f)));
    if (!media.length) { showNotice('Nenhum vídeo ou áudio suportado nessa pasta.', 'warning'); return; }
    await addFiles(media);
  } catch (err) {
    showNotice(`Erro ao ler a pasta: ${err.message}`, 'danger');
  }
}

async function clearList() {
  if (running() || !items.length) return;
  if (items.length > 1) {
    const ok = await window.bdsModal.confirm(`Remover os ${items.length} arquivos da lista?`);
    if (!ok) return;
  }
  items = [];
  renderList();
  setMode('empty');
}

function removeItem(id) {
  if (running()) return;
  items = items.filter((i) => i.id !== id);
  renderList();
  setMode(items.length ? mode : 'empty');
}

function newTranscription() {
  items = [];
  showNotice('');
  renderList();
  setMode('empty');
}

// ------------------------------------------------------------------ lista

function renderList() {
  const list = $('trList');
  list.textContent = '';
  rowEls.clear();
  for (const item of items) {
    const sub = h('div', { class: 'tr-row-sub' });
    const dur = h('span', { class: 'tr-row-dur' });
    const fill = h('div', { class: 'tr-bar-fill' });
    const bar = h('div', { class: 'tr-bar hidden' }, [fill]);
    const remove = h('button', {
      class: 'tr-icon-btn tr-row-x', type: 'button', title: 'Remover da lista',
      'aria-label': `Remover ${item.name} da lista`, onclick: () => removeItem(item.id)
    }, [icon('close')]);
    const row = h('li', { class: 'tr-row', 'data-id': item.id }, [
      h('div', { class: `tr-row-icon${item.isVideo ? ' is-video' : ''}` }, [icon(item.isVideo ? 'movie' : 'graphic_eq')]),
      h('div', { class: 'tr-row-main' }, [
        h('div', { class: 'tr-row-top' }, [h('span', { class: 'tr-row-name', title: item.path, text: item.name }), dur]),
        sub, bar
      ]),
      remove
    ]);
    rowEls.set(item.id, { row, sub, dur, bar, fill, remove });
    list.append(row);
    paintRow(item);
  }
  updateListHead();
  updatePanel();
}

function paintRow(item) {
  const el = rowEls.get(item.id);
  if (!el) return;
  el.dur.textContent = item.durationSeconds > 0 ? fmtDuration(item.durationSeconds) : '';
  el.remove.disabled = running();

  const pct = Math.round(item.progress);
  const showBar = item.status === 'running' || (running() && item.status !== 'pending' && item.status !== 'error');
  el.bar.classList.toggle('hidden', !showBar);
  el.bar.className = `tr-bar${showBar ? '' : ' hidden'}${item.status === 'error' ? ' error' : item.status === 'done' ? ' done' : ''}`;
  el.fill.style.width = `${pct}%`;

  el.sub.textContent = '';
  const waiting = running() && item.status === 'pending';
  const label = {
    pending: waiting ? 'Aguardando' : 'Pronto para processar',
    running: `Transcrevendo… ${pct}%`,
    done: 'Concluído',
    error: item.error || 'Falhou',
    cancelled: 'Cancelado'
  }[item.status];
  el.sub.append(h('span', { class: `tr-state ${item.status}`, text: label }));
  if (item.status === 'done') {
    for (const o of item.outputs) {
      el.sub.append(h('button', {
        class: 'tr-out-link', type: 'button', title: `Mostrar ${baseName(o.path)} na pasta`,
        onclick: () => window.bds?.modulesReveal?.(o.path)
      }, o.kind.toUpperCase()));
    }
  }
}

function updateListHead() {
  $('trCount').textContent = plural(items.length, 'arquivo', 'arquivos');
  const total = items.reduce((s, i) => s + (i.durationSeconds || 0), 0);
  $('trTotal').textContent = total > 0 ? `· ${fmtDuration(total)} no total` : '';
}

// ------------------------------------------------------------------ transcrição

function setRun(percent, message) {
  batchPercent = Math.max(0, Math.min(100, percent ?? batchPercent));
  $('trRunFill').style.width = `${batchPercent}%`;
  $('trRunBar').setAttribute('aria-valuenow', String(Math.round(batchPercent)));
  if (message !== undefined) { lastMessage = message; $('trRunMsg').textContent = message; }
  const done = items.filter((i) => i.status === 'done' || i.status === 'error').length;
  const current = Math.min(items.length, done + 1);
  $('trRunTitle').textContent = `${current} de ${items.length}`;
}

function onProgress(p) {
  if (!running() || p.kind !== 'transcribe') return;

  if (p.file) {
    sawFileEvents = true;
    const item = items[p.file.index];
    if (item) {
      if (p.file.state === 'start') { item.status = 'running'; item.progress = 0; item.error = null; }
      else if (p.file.state === 'progress') { item.status = 'running'; item.progress = p.file.percent ?? item.progress; }
      else if (p.file.state === 'done') { item.status = 'done'; item.progress = 100; }
      else if (p.file.state === 'error') { item.status = 'error'; item.error = p.file.message || 'Falha ao transcrever.'; }
      paintRow(item);
      setRun(batchPercent);
    }
    return;
  }

  if (typeof p.percent === 'number') {
    setRun(p.percent, p.device ? `Usando ${p.device}` : lastMessage);
    // Motor sem eventos por arquivo: estima o andamento de cada um pelo geral.
    if (!sawFileEvents && items.length) {
      const exact = (p.percent / 100) * items.length;
      items.forEach((item, i) => {
        if (item.status === 'done' || item.status === 'error') return;
        item.progress = Math.max(0, Math.min(100, (exact - i) * 100));
        item.status = item.progress > 0 ? 'running' : 'pending';
        paintRow(item);
      });
    }
  } else if (p.device) {
    setRun(undefined, `Usando ${p.device}`);
  } else if (p.message && !p.log) {
    setRun(undefined, p.message);
  }
}

async function startTranscription() {
  if (mode !== 'ready' || !items.length) return;
  const reason = blockedReason();
  if (reason) { showNotice(reason, 'warning'); return; }

  items.forEach((i) => { i.status = 'pending'; i.progress = 0; i.outputs = []; i.error = null; });
  cancelling = false;
  sawFileEvents = false;
  showNotice('');
  setMode('running');
  renderList();
  setRun(0, 'Preparando o motor…');

  let result = null;
  let failure = null;
  try {
    result = await call(window.bds.modulesTranscribe, {
      files: items.map((i) => i.path),
      srt: opts.srt, md: opts.md, maxWords: opts.maxWords, lines: opts.lines,
      outDir: opts.outMode === 'dir' ? opts.outDir : null,
      forceCpu: opts.forceCpu
    });
  } catch (err) {
    failure = err;
  }

  if (result) reconcile(result);
  else for (const i of items) if (i.status === 'running' || i.status === 'pending') i.status = failure?.code === 'CANCELLED' ? 'cancelled' : 'error';

  if (failure && failure.code === 'CANCELLED') {
    showNotice('Transcrição cancelada. O que já estava pronto foi mantido.', 'info');
    finish(null, true);
  } else if (failure) {
    items.forEach((i) => { if (i.status === 'error' && !i.error) i.error = failure.message; });
    showNotice(`A transcrição falhou: ${failure.message}`, 'danger');
    finish(null);
  } else {
    finish(result);
  }
  await refreshStatus();
}

/** Aplica o resultado final: saídas por arquivo e erros (o motor identifica o arquivo pelo nome). */
function reconcile(result) {
  for (const item of items) {
    item.outputs = (result.outputs || []).filter((o) => String(o.source).toLowerCase() === item.path.toLowerCase())
      .map((o) => ({ kind: o.kind, path: o.path }));
    const errLine = (result.errors || []).find((e) => e.startsWith(`${item.name}:`));
    if (item.outputs.length && !errLine) { item.status = 'done'; item.progress = 100; item.error = null; }
    else if (errLine || item.status === 'error') { item.status = 'error'; item.error = errLine ? errLine.slice(item.name.length + 1).trim() : (item.error || 'Falha ao transcrever.'); }
    else if (item.status !== 'done') { item.status = 'error'; item.error = 'Nenhum resultado foi gerado.'; }
  }
}

/** Fecha o lote: mostra o resumo (ou volta aos ajustes quando nada foi gerado). */
function finish(result, cancelled = false) {
  const ok = items.filter((i) => i.status === 'done');
  const failed = items.filter((i) => i.status === 'error').length;
  const generated = ok.flatMap((i) => i.outputs);
  if (!generated.length) {
    setMode('ready');
    renderList();
    return;
  }
  const srt = generated.filter((o) => o.kind === 'srt').length;
  const md = generated.filter((o) => o.kind === 'md').length;
  $('trDoneIcon').className = `material-symbols-rounded tr-done-icon${failed || cancelled ? ' warn' : ''}`;
  $('trDoneIcon').textContent = failed || cancelled ? 'warning' : 'check_circle';
  $('trDoneTitle').textContent = cancelled ? 'Transcrição cancelada' : failed ? 'Concluído com falhas' : 'Transcrição concluída';
  const parts = [`${plural(ok.length, 'arquivo transcrito', 'arquivos transcritos')}`];
  if (failed) parts.push(plural(failed, 'com falha', 'com falha'));
  const kinds = [srt ? `SRT ${srt}` : null, md ? `MD ${md}` : null].filter(Boolean).join(' · ');
  $('trDoneSub').textContent = `${parts.join(', ')}\n${plural(generated.length, 'arquivo gerado', 'arquivos gerados')} (${kinds})${result && result.device ? `\n${result.device}` : ''}`;
  $('trDoneSub').style.whiteSpace = 'pre-line';
  setMode('done');
  renderList();
}

async function cancelTranscription() {
  if (!running() || cancelling) return;
  const ok = await window.bdsModal.confirm('Deseja realmente cancelar a transcrição em andamento?');
  if (!ok) return;
  cancelling = true;
  $('btnTrCancel').disabled = true;
  try { await call(window.bds.modulesCancel); } catch (_) { /* o fim da operação chega pelo resultado */ }
  $('btnTrCancel').disabled = false;
}

function openResultFolder() {
  const first = items.find((i) => i.outputs.length);
  if (first) window.bds?.modulesReveal?.(first.outputs[0].path);
}

// ------------------------------------------------------------------ ajustes

function syncOptionsUi() {
  for (const [id, key] of [['btnFmtSrt', 'srt'], ['btnFmtMd', 'md']]) {
    $(id).classList.toggle('active', opts[key]);
    $(id).setAttribute('aria-pressed', String(opts[key]));
  }
  $('trSrtBlock').classList.toggle('hidden', !opts.srt);
  $('rangeTrWords').value = String(opts.maxWords);
  $('trWordsValue').textContent = opts.maxWords === 0 ? 'Automático' : plural(opts.maxWords, 'palavra', 'palavras');

  const mark = (group, attr, value) => $(group).querySelectorAll('button').forEach((b) => {
    const on = b.dataset[attr] === String(value);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  mark('trLinesSeg', 'lines', opts.lines);
  mark('trDeviceSeg', 'cpu', opts.forceCpu ? 1 : 0);

  $('trDestText').textContent = opts.outMode === 'dir' && opts.outDir ? opts.outDir : 'Ao lado de cada arquivo';
  $('trDestText').title = opts.outMode === 'dir' ? opts.outDir : '';
  renderEngine();
  updatePanel();
}

async function chooseDestFolder() {
  try {
    const dir = await window.bds.selectFolder(opts.outDir || '');
    if (dir) { opts.outMode = 'dir'; opts.outDir = dir; savePrefs(); syncOptionsUi(); }
  } catch (err) { showNotice(`Não foi possível escolher a pasta: ${err.message}`, 'danger'); }
}

function bindOnce() {
  if (bound) return;
  bound = true;

  $('btnTrPick').addEventListener('click', pickFiles);
  $('btnTrFolder').addEventListener('click', pickFolder);
  $('btnTrClear').addEventListener('click', clearList);
  $('btnTrStart').addEventListener('click', startTranscription);
  $('btnTrCancel').addEventListener('click', cancelTranscription);
  $('btnTrOpen').addEventListener('click', openResultFolder);
  $('btnTrNew').addEventListener('click', newTranscription);
  $('trEngine').addEventListener('click', (e) => { e.stopPropagation(); openModelMenu(e.currentTarget); });
  $('trNoticeClose').addEventListener('click', () => showNotice(''));

  $('btnTrAdd').addEventListener('click', (e) => {
    e.stopPropagation();
    showMenu(e.currentTarget, [
      { icon: 'note_add', label: 'Arquivos…', run: pickFiles },
      { icon: 'folder', label: 'Pasta inteira…', run: pickFolder }
    ]);
  });
  $('btnTrDest').addEventListener('click', (e) => {
    e.stopPropagation();
    showMenu(e.currentTarget, [
      { icon: 'description', label: 'Ao lado de cada arquivo', selected: opts.outMode === 'side', run: () => { opts.outMode = 'side'; savePrefs(); syncOptionsUi(); } },
      { icon: 'folder_open', label: opts.outDir ? 'Outra pasta…' : 'Escolher pasta…', selected: opts.outMode === 'dir', run: chooseDestFolder }
    ]);
  });
  document.addEventListener('pointerdown', (e) => {
    const menu = $('trMenu');
    if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target)) hideMenu();
  }, true);

  for (const [id, key] of [['btnFmtSrt', 'srt'], ['btnFmtMd', 'md']]) {
    $(id).addEventListener('click', () => { opts[key] = !opts[key]; savePrefs(); syncOptionsUi(); });
  }
  $('rangeTrWords').addEventListener('input', (e) => { opts.maxWords = Number(e.target.value) || 0; savePrefs(); syncOptionsUi(); });
  $('trLinesSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lines]');
    if (!b) return;
    opts.lines = Number(b.dataset.lines) === 1 ? 1 : 2;
    savePrefs(); syncOptionsUi();
  });
  $('trDeviceSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cpu]');
    if (!b) return;
    opts.forceCpu = b.dataset.cpu === '1';
    savePrefs(); syncOptionsUi();
  });
  bindDragAndDrop();
}

/** Soltar arquivos em qualquer lugar da tela. */
function bindDragAndDrop() {
  const root = $('trRoot');
  const overlay = $('trDrop');
  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  root.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    root.classList.add('dragging');
    if (mode !== 'empty') overlay.classList.remove('hidden');
  });
  root.addEventListener('dragover', (e) => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = running() ? 'none' : 'copy'; } });
  root.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) { root.classList.remove('dragging'); overlay.classList.add('hidden'); }
  });
  root.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    root.classList.remove('dragging');
    overlay.classList.add('hidden');
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => (window.bds?.getPathForFile ? window.bds.getPathForFile(f) : f.path || ''))
      .filter(Boolean);
    if (paths.length) addFiles(paths);
  });
}

// ------------------------------------------------------------------ ciclo de vida

function subscribe() {
  unsubs.forEach((fn) => { try { fn(); } catch (_) { /* noop */ } });
  unsubs = [
    window.bds?.onModulesProgress?.(onProgress),
    window.bds?.onModulesStatus?.(refreshStatus)
  ].filter(Boolean);
}

export async function initScreen() {
  loadPrefs();
  bindOnce();
  syncOptionsUi();
  renderList();
  setMode('empty');
  subscribe();
  await refreshStatus();
}

export async function onEnter() {
  subscribe();
  await refreshStatus();
}

export function onLeave() {
  hideMenu();
  // Um lote em andamento continua recebendo o progresso mesmo com a tela fora de vista.
  if (running()) return;
  unsubs.forEach((fn) => { try { fn(); } catch (_) { /* noop */ } });
  unsubs = [];
}
