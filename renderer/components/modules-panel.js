/**
 * Painel "Transcrição" das Configurações — um botão instala o recurso (e pergunta da aceleração NVIDIA quando há placa) e uma tabela gerencia os modelos.
 * Toda a lógica vive no processo principal (src/core/modules); este painel só pede ações via
 * window.bds.modules* e mostra o estado e o progresso. Textos entram sempre por textContent.
 * A tela de Transcrição (renderer/screens/transcription.*) é quem usa o módulo para transcrever.
 */

let status = null;
let unsubs = [];
let root = null;
let nvidiaDetected = false;
let advancedOpen = false;   // "Ajustes avançados" aberto: o bloco é refeito a cada evento de status, então o estado fica aqui
let pickedId = null;        // modelo marcado na lista (D10); fica marcado até a pessoa baixar, usar ou marcar outro
let activating = false;     // ativando um modelo já baixado (os botões ficam desabilitados até acabar)

const $ =(id) => (root ? root.querySelector(`#${id}`) : null);

// ------------------------------------------------------------------ utilitários

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'disabled' || k === 'checked' || k === 'hidden') el[k] = !!v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of (Array.isArray(children) ? children : [children])) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const icon = (name) => h('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true', text: name });
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${(v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)).toString().replace('.', ',')} ${u[i]}`;
}

async function call(fn, ...args) {
  if (typeof fn !== 'function') throw new Error('Recurso indisponível nesta versão do app.');
  const res = await fn(...args);
  if (!res || !res.ok) {
    const err = new Error(res?.error || 'Algo deu errado. Tente novamente.');
    err.code = res?.code || null;
    throw err;
  }
  return res.data;
}

function notice(text, kind = 'info') {
  const el = $('modNotice');
  if (!el) return;
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = text;
  el.className = `mod-notice mod-notice-${kind}`;
}

/** Executa uma ação, mostrando o erro (exceto cancelamentos) e atualizando o estado depois. */
async function act(fn, ...args) {
  notice('');
  try {
    const data = await call(fn, ...args);
    if (data && data.whisper) { status = data; render(); }
    return data;
  } catch (err) {
    if (err.code !== 'CANCELLED') notice(err.message, 'error');
    await refresh();
    return null;
  }
}

async function refresh() {
  try { status = await call(window.bds?.modulesGetStatus); render(); }
  catch (err) { notice(`Não foi possível carregar a transcrição: ${err.message}`, 'error'); }
}

// ------------------------------------------------------------------ progresso

function onProgress(p) {
  const panel = $('modProgress');
  if (!panel) return;

  if (p.phase === 'done' || p.phase === 'error' || p.phase === 'cancelled') {
    panel.classList.add('hidden');
    if (p.phase === 'error') notice(p.message, 'error');
    else if (p.phase === 'cancelled') notice('Operação cancelada.', 'info');
    return;
  }

  panel.classList.remove('hidden');
  $('modProgressLabel').textContent = p.label || 'Em andamento';
  $('modProgressMsg').textContent = p.message || '';
  const pct = p.percent;
  const fill = $('modBarFill');
  const bar = $('modBar');
  if (pct == null) {
    fill.classList.add('mod-indeterminate');
    fill.style.width = '40%';
    bar.removeAttribute('aria-valuenow');
  } else {
    fill.classList.remove('mod-indeterminate');
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  }
  const stats = [];
  if (p.totalBytes) stats.push(`${fmtBytes(p.receivedBytes || 0)} de ${fmtBytes(p.totalBytes)}`);
  if (p.speedBps > 0) stats.push(`${fmtBytes(p.speedBps)}/s`);
  if (pct != null) stats.push(`${Math.round(pct)}%`);
  $('modProgressStats').textContent = stats.join(' · ');
}

// ------------------------------------------------------------------ seções

function busy() { return Boolean((status && status.busy) || activating); }

/** Estrelas de 1 a 5 (texto acessível: "3 de 5"). */
function stars(level, max = 5) {
  const n = Math.max(0, Math.min(max, Number(level) || 0));
  return h('span', { class: 'mod-stars', role: 'img', 'aria-label': `${n} de ${max}` }, [
    h('span', { class: 'mod-stars-on', 'aria-hidden': 'true', text: '★'.repeat(n) }),
    h('span', { class: 'mod-stars-off', 'aria-hidden': 'true', text: '★'.repeat(max - n) })
  ]);
}

/** Há placa NVIDIA neste computador? (só então oferecemos a aceleração) */
async function detectNvidia() {
  try {
    const info = await window.bds?.getHardwareInfo?.();
    const gpus = (info && (info.gpus || info.data?.gpus)) || [];
    nvidiaDetected = gpus.some((g) => String(g.vendor || '').toLowerCase() === 'nvidia');
  } catch (_) { nvidiaDetected = false; }
}

function renderHead() {
  const w = status.whisper;
  let chip;
  if (!status.platformSupported) chip = ['Indisponível', 'off'];
  else if (w.ready) chip = ['Pronto', 'ok'];
  else if (w.engine.installed) chip = ['Falta um modelo', 'warn'];
  else chip = ['Não instalado', 'off'];
  return h('div', { class: 'mod-head' }, [
    h('div', { class: 'mod-head-icon' }, [icon('closed_caption')]),
    h('div', { class: 'mod-head-text' }, [
      h('p', { class: 'mod-head-lead', text: 'Gera legendas e textos a partir de áudio e vídeo, no seu computador.' })
    ]),
    h('span', { class: `mod-state mod-state-${chip[1]}`, text: chip[0] })
  ]);
}

/** Bloco principal: um botão para instalar (e perguntar da NVIDIA) ou o estado atual. */
function renderMain() {
  const w = status.whisper;
  const b = busy();
  const children = [];

  if (!status.platformSupported) {
    children.push(h('p', { class: 'mod-warning' }, [icon('info'), (w.engine.unavailableReason || 'Transcrição ainda não disponível neste sistema.')]));
    return h('div', { class: 'mod-section' }, children);
  }

  if (!w.engine.installed) {
    children.push(h('div', { class: 'mod-row' }, [
      h('div', { class: 'mod-row-text' }, [
        h('strong', { text: 'Instale para começar' }),
        h('span', { class: 'mod-muted', text: `Download de cerca de ${fmtBytes(w.engine.downloadBytes)}. Depois escolha um modelo abaixo.` })
      ]),
      h('div', { class: 'mod-actions' }, [
        h('button', { class: 'mod-btn mod-btn-primary', type: 'button', disabled: b, onclick: installFlow }, [icon('download'), 'Instalar']),
        h('button', { class: 'mod-btn mod-btn-link', type: 'button', disabled: b, onclick: () => installEngine(true) }, 'Usar um arquivo…')
      ])
    ]));
    return h('div', { class: 'mod-section' }, children);
  }

  // Instalado: só o estado; remover a transcrição e a aceleração ficam em "Ajustes avançados"
  children.push(h('div', { class: 'mod-row' }, [
    h('div', { class: 'mod-row-text' }, [h('strong', { text: 'Transcrição instalada' })])
  ]));

  // Aceleração NVIDIA: só aparece com placa NVIDIA detectada (ou se já estiver instalada, para poder remover)
  const c = w.cuda;
  if (c.available !== false && (nvidiaDetected || c.installed)) {
    children.push(h('div', { class: 'mod-row' }, [
      h('div', { class: 'mod-row-text' }, [
        h('strong', { text: c.installed ? 'Aceleração NVIDIA ativa' : 'Placa NVIDIA detectada' }),
        h('span', { class: 'mod-muted', text: c.installed ? 'A transcrição usa a placa de vídeo.' : 'A aceleração deixa a transcrição bem mais rápida.' })
      ]),
      c.installed ? null : h('div', { class: 'mod-actions' }, [
        h('button', { class: 'mod-btn mod-btn-primary mod-btn-sm', type: 'button', disabled: b, onclick: askNvidia }, [icon('bolt'), 'Ativar aceleração'])
      ])
    ]));
  }
  children.push(renderAdvanced(c, b));
  return h('div', { class: 'mod-section' }, children);
}

/** Ações raras (remover a transcrição e a aceleração) num bloco recolhido; as confirmações continuam em cada ação. */
function renderAdvanced(c, b) {
  const row = (title, hint, label, onclick) => h('div', { class: 'mod-row' }, [
    h('div', { class: 'mod-row-text' }, [h('strong', { text: title }), h('span', { class: 'mod-muted', text: hint })]),
    h('div', { class: 'mod-actions' }, [
      h('button', { class: 'mod-btn mod-btn-ghost mod-btn-sm', type: 'button', disabled: b, title: label, 'aria-label': label, onclick }, [icon('delete'), label])
    ])
  ]);
  const rows = [row('Remover a transcrição', 'Os modelos e a aceleração já baixados continuam no disco.', 'Remover a transcrição', removeEngine)];
  if (c.installed) rows.push(row('Remover a aceleração NVIDIA', 'A transcrição volta a usar só o processador.', 'Remover a aceleração NVIDIA', removeCuda));
  const details = h('details', { class: 'st-advanced mod-advanced', open: advancedOpen }, [
    h('summary', { text: 'Ajustes avançados' }),
    h('div', { class: 'mod-advanced-body' }, rows)
  ]);
  details.addEventListener('toggle', () => { advancedOpen = details.hasAttribute('open'); });
  return details;
}

// ===== Lista de escolha de modelos (D10): início do bloco. Reverter = trocar este bloco pela tabela original =====

/** Modelo que a lista mostra marcado: o que a pessoa marcou por último (mesmo depois de baixar), senão o que está em uso. */
function selectedModelId() {
  const models = status.whisper.models;
  const picked = models.find((m) => m.id === pickedId);
  if (picked) return picked.id;
  const active = models.find((m) => m.active);
  return active ? active.id : null;
}

/** Marcar só marca (as setas do teclado marcam a cada passo): baixar ou usar é um clique no botão contextual embaixo. */
function chooseModel(m) {
  pickedId = m.id;
  render();
}

/** Passa a usar o modelo marcado, que já está baixado; depois a marca volta para o que está em uso (agora ele mesmo). */
async function useModel(m) {
  if (busy()) return;
  activating = true;
  render();
  let done = false;
  try { done = Boolean(await act(window.bds.modulesSetActiveModel, m.id)); }
  finally { activating = false; if (done) pickedId = null; render(); }
}

function modelChoice(m, selected, b) {
  const size = fmtBytes(m.sizeOnDisk || m.sizeBytes);
  const state = m.active
    ? h('span', { class: 'mod-badge mod-badge-ok', text: 'Em uso' })
    : (m.installed ? h('span', { class: 'mod-badge mod-muted', text: 'Baixado' }) : null);
  return h('div', { class: `mod-choice${m.id === selected ? ' selected' : ''}${m.installed ? ' installed' : ''}${m.active ? ' active' : ''}` }, [
    h('label', { class: 'mod-choice-main' }, [
      h('input', { type: 'radio', name: 'modModel', value: m.id, checked: m.id === selected, onchange: () => chooseModel(m) }),
      h('span', { class: 'mod-choice-name' }, [
        h('strong', { text: m.label }),
        h('span', { class: 'mod-muted', text: m.description })
      ]),
      h('span', { class: 'mod-choice-meta' }, [
        h('span', { class: 'mod-choice-stat' }, [h('span', { class: 'mod-muted', text: 'Velocidade' }), stars(m.speedLevel)]),
        h('span', { class: 'mod-choice-stat' }, [h('span', { class: 'mod-muted', text: 'Precisão' }), stars(m.quality)]),
        h('span', { class: 'mod-choice-size', text: size })
      ])
    ]),
    state,
    m.installed ? h('button', {
      id: `modDelete-${m.id}`, class: 'mod-icon-btn mod-icon-danger', type: 'button', disabled: b,
      title: `Apagar ${m.label} (libera ${size})`, 'aria-label': `Apagar o modelo ${m.label}`,
      onclick: () => removeModel(m)
    }, [icon('delete')]) : null
  ]);
}

/**
 * Lista de escolha de modelos: um único botão contextual para o modelo marcado, sempre no mesmo lugar:
 * "Baixar <nome> (<tamanho>)" se ainda falta baixar, "Usar <nome>" se já foi baixado e não está em uso.
 */
function renderModels() {
  const w = status.whisper;
  const b = busy();
  const selected = selectedModelId();
  const sel = w.models.find((m) => m.id === selected);

  let action = null;
  if (sel && !sel.installed) {
    action = w.engine.installed
      ? h('button', { id: 'modDownloadModel', class: 'mod-btn mod-btn-primary', type: 'button', disabled: b, onclick: () => act(window.bds.modulesInstallModel, sel.id) }, [icon('download'), `Baixar ${sel.label} (${fmtBytes(sel.sizeBytes)})`])
      : h('p', { class: 'mod-muted', text: 'Instale a transcrição para baixar modelos.' });
  } else if (sel && !sel.active) {
    action = h('button', { id: 'modUseModel', class: 'mod-btn mod-btn-primary', type: 'button', disabled: b, onclick: () => useModel(sel) }, [icon('check_circle'), `Usar ${sel.label}`]);
  }

  return h('div', { class: 'mod-section' }, [
    h('h4', { id: 'modModelsTitle', class: 'mod-section-title' }, [icon('neurology'), 'Modelos']),
    h('div', { class: 'mod-choice-list', role: 'radiogroup', 'aria-labelledby': 'modModelsTitle' }, w.models.map((m) => modelChoice(m, selected, b))),
    h('div', { class: 'mod-choice-action', 'aria-live': 'polite' }, action)
  ]);
}

/** A lista é refeita a cada evento de status: guarda onde estava o foco e o devolve (ou leva ao modelo marcado, se o botão sumiu). */
function modelsFocusKey() {
  const a = document.activeElement;
  const host = $('modModels');
  if (!a || !host || !host.contains(a)) return null;
  return a.matches('input[type="radio"]') ? 'radio' : (a.id || 'radio');
}
function restoreModelsFocus(key) {
  if (!key) return;
  const host = $('modModels');
  let el = key === 'radio' ? null : host.querySelector(`#${key}`);
  if (el && el.disabled) el = null;
  const all = [...host.querySelectorAll('input[type="radio"]')];
  el = el || all.find((r) => r.checked) || all[0];
  if (el) el.focus();
}

// ===== Lista de escolha de modelos (D10): fim do bloco =====

// ------------------------------------------------------------------ NVIDIA (pergunta + termos)

/** Pergunta se quer baixar a aceleração; clicar em "Baixar" vale como aceite dos termos da NVIDIA. */
function askNvidia() {
  const c = status.whisper.cuda;
  const size = fmtBytes(c.approxDownloadBytes);
  const link = (c.licenseLinks || [])[0];
  const dlg = h('dialog', { class: 'mod-dialog', 'aria-labelledby': 'modNvTitle' });
  const close = () => { try { dlg.close(); } catch (_) { /* já fechado */ } dlg.remove(); };
  dlg.append(
    h('h4', { id: 'modNvTitle', text: 'Baixar a aceleração NVIDIA?' }),
    h('p', { text: `Detectamos uma placa NVIDIA. Com a aceleração a transcrição fica bem mais rápida. Download de cerca de ${size}.` }),
    h('p', { class: 'mod-dialog-terms' }, [
      icon('gavel'),
      h('span', {}, [
        'Ao clicar em "Baixar e aceitar", você concorda com os ',
        link ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.bds?.openExternal?.(link.url); } }, 'termos de licença da NVIDIA') : 'termos de licença da NVIDIA',
        '.'
      ])
    ]),
    h('div', { class: 'mod-dialog-actions' }, [
      h('button', { class: 'mod-btn mod-btn-ghost', type: 'button', onclick: close }, 'Agora não'),
      h('button', { class: 'mod-btn mod-btn-primary', type: 'button', onclick: () => { close(); act(window.bds.modulesInstallCuda, { acceptLicense: true }); } }, [icon('download'), 'Baixar e aceitar'])
    ])
  );
  dlg.addEventListener('close', () => dlg.remove());
  (root || document.body).append(dlg);
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  dlg.querySelector('.mod-btn-ghost')?.focus();
}

// ------------------------------------------------------------------ ações

/** Botão "Instalar": baixa a transcrição e, havendo placa NVIDIA, pergunta pela aceleração. */
async function installFlow() {
  const data = await installEngine(false);
  if (data && data.whisper && nvidiaDetected && data.whisper.cuda.available !== false && !data.whisper.cuda.installed) askNvidia();
}

async function installEngine(fromZip) {
  if (!fromZip) return act(window.bds.modulesInstallEngine, {});
  const picked = await window.bds.selectFile({
    title: 'Selecionar o pacote de transcrição',
    filters: [{ name: 'Pacote de transcrição', extensions: ['zip'] }],
    properties: ['openFile']
  });
  const list = Array.isArray(picked) ? picked : (picked?.filePaths || []);
  if (!list.length) return null;
  return act(window.bds.modulesInstallEngine, { zipPath: list[0] });
}

async function removeEngine() {
  const ok = await window.bdsModal.confirm('Remover a transcrição?\n\nOs modelos e a aceleração NVIDIA já baixados continuam no disco; apague-os separadamente se quiser liberar espaço.');
  if (ok) act(window.bds.modulesUninstallEngine);
}

async function removeModel(m) {
  const installed = status.whisper.models.filter((x) => x.installed);
  const last = installed.length === 1;
  const lines = [`Apagar o modelo ${m.label}?`, '', `Isso libera ${fmtBytes(m.sizeOnDisk || m.sizeBytes)}. Você pode baixá-lo de novo quando quiser.`];
  if (last) lines.push('', 'É o único modelo instalado: a transcrição só volta a funcionar depois que você baixar um modelo.');
  else if (m.active) lines.push('', 'Outro modelo instalado passará a ser usado.');
  const ok = await window.bdsModal.confirm(lines.join('\n'));
  if (ok) act(window.bds.modulesRemoveModel, m.id);
}

async function removeCuda() {
  const ok = await window.bdsModal.confirm('Remover a aceleração NVIDIA?\n\nA transcrição continua funcionando, mas na CPU (bem mais devagar nos modelos grandes).');
  if (ok) act(window.bds.modulesRemoveCuda);
}

// ------------------------------------------------------------------ render geral

function render() {
  if (!status || !root) return;
  clear($('modWhisperHead')).append(renderHead());
  clear($('modMain')).append(renderMain());
  const focusKey = modelsFocusKey();
  clear($('modModels')).append(renderModels());
  restoreModelsFocus(focusKey);
  $('modProgressCancel').disabled = !status.busy;
  if (!status.busy) $('modProgress').classList.add('hidden');
}

function subscribe() {
  unsubs.forEach((fn) => { try { fn(); } catch (_) { /* noop */ } });
  unsubs = [
    window.bds?.onModulesProgress?.(onProgress),
    window.bds?.onModulesStatus?.(refresh)
  ].filter(Boolean);
}

/** Constrói o esqueleto do painel dentro de `container` e carrega o estado. */
export async function mountModulesPanel(container) {
  root = container;
  advancedOpen = false;
  pickedId = null;
  activating = false;
  clear(root);
  root.append(
    h('div', { class: 'mod-screen mod-embedded' }, [
      h('div', { id: 'modNotice', class: 'mod-notice hidden', role: 'status', 'aria-live': 'polite' }),
      h('section', { id: 'modProgress', class: 'mod-progress hidden', 'aria-live': 'polite' }, [
        h('div', { class: 'mod-progress-head' }, [
          h('strong', { id: 'modProgressLabel', text: '—' }),
          h('button', { id: 'modProgressCancel', class: 'mod-btn mod-btn-danger mod-btn-sm', type: 'button', onclick: () => call(window.bds?.modulesCancel).catch(() => {}) }, [icon('stop_circle'), ' Cancelar'])
        ]),
        h('div', { id: 'modBar', class: 'mod-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, [h('div', { id: 'modBarFill', class: 'mod-bar-fill' })]),
        h('div', { class: 'mod-progress-info' }, [h('span', { id: 'modProgressMsg', text: '—' }), h('span', { id: 'modProgressStats', class: 'mod-muted' })])
      ]),
      h('section', { class: 'mod-card', 'aria-label': 'Transcrição' }, [
        h('div', { id: 'modWhisperHead' }), h('div', { id: 'modMain' }), h('div', { id: 'modModels' })
      ])
    ])
  );
  subscribe();
  await detectNvidia();
  await refresh();
}

/** Solta os ouvintes ao sair das Configurações (o conteúdo é descartado). */
export function unmountModulesPanel() {
  unsubs.forEach((fn) => { try { fn(); } catch (_) { /* noop */ } });
  unsubs = [];
  if (root) clear(root);
  root = null;
  advancedOpen = false;
  pickedId = null;
  activating = false;
}
