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

const $ = (id) => (root ? root.querySelector(`#${id}`) : null);

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

function busy() { return Boolean(status && status.busy); }

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

  // Instalado: estado + remover
  children.push(h('div', { class: 'mod-row' }, [
    h('div', { class: 'mod-row-text' }, [h('strong', { text: 'Transcrição instalada' })]),
    h('div', { class: 'mod-actions' }, [
      h('button', { class: 'mod-btn mod-btn-ghost mod-btn-sm', type: 'button', disabled: b, onclick: removeEngine }, [icon('delete'), 'Remover'])
    ])
  ]));

  // Aceleração NVIDIA: só aparece com placa NVIDIA detectada (ou se já estiver instalada, para poder remover)
  const c = w.cuda;
  if (c.available !== false && (nvidiaDetected || c.installed)) {
    children.push(h('div', { class: 'mod-row' }, [
      h('div', { class: 'mod-row-text' }, [
        h('strong', { text: c.installed ? 'Aceleração NVIDIA ativa' : 'Placa NVIDIA detectada' }),
        h('span', { class: 'mod-muted', text: c.installed ? 'A transcrição usa a placa de vídeo.' : 'A aceleração deixa a transcrição bem mais rápida.' })
      ]),
      h('div', { class: 'mod-actions' }, [
        c.installed
          ? h('button', { class: 'mod-btn mod-btn-ghost mod-btn-sm', type: 'button', disabled: b, onclick: removeCuda }, [icon('delete'), 'Remover'])
          : h('button', { class: 'mod-btn mod-btn-primary mod-btn-sm', type: 'button', disabled: b, onclick: askNvidia }, [icon('bolt'), 'Ativar aceleração'])
      ])
    ]));
  }
  return h('div', { class: 'mod-section' }, children);
}

/** Tabela de modelos: nome, velocidade e precisão em estrelas, tamanho e ações. */
function renderModels() {
  const w = status.whisper;
  const b = busy();

  const rows = w.models.map((m) => {
    const size = fmtBytes(m.sizeOnDisk || m.sizeBytes);
    let actions;
    if (m.installed) {
      actions = [
        m.active
          ? h('span', { class: 'mod-badge mod-badge-ok', text: 'Em uso' })
          : h('button', { class: 'mod-btn mod-btn-secondary mod-btn-sm', type: 'button', disabled: b, onclick: () => act(window.bds.modulesSetActiveModel, m.id) }, 'Usar'),
        h('button', {
          class: 'mod-icon-btn mod-icon-danger', type: 'button', disabled: b,
          title: `Apagar ${m.label} (libera ${size})`, 'aria-label': `Apagar o modelo ${m.label}`,
          onclick: () => removeModel(m)
        }, [icon('delete')])
      ];
    } else {
      actions = [h('button', { class: 'mod-btn mod-btn-primary mod-btn-sm', type: 'button', disabled: b || !w.engine.installed, title: w.engine.installed ? '' : 'Instale a transcrição primeiro', onclick: () => act(window.bds.modulesInstallModel, m.id) }, [icon('download'), 'Baixar'])];
    }

    return h('tr', { class: `mod-trow${m.active ? ' active' : ''}${m.installed ? ' installed' : ''}` }, [
      h('th', { scope: 'row', class: 'mod-tcell-name' }, [
        h('strong', { text: m.label }),
        h('span', { class: 'mod-muted', text: m.description })
      ]),
      h('td', { class: 'mod-tcell-stars', 'data-label': 'Velocidade' }, [stars(m.speedLevel)]),
      h('td', { class: 'mod-tcell-stars', 'data-label': 'Precisão' }, [stars(m.quality)]),
      h('td', { class: 'mod-tcell-size', 'data-label': 'Tamanho', text: size }),
      h('td', { class: 'mod-tcell-actions' }, [h('div', { class: 'mod-actions' }, actions)])
    ]);
  });

  const table = h('table', { class: 'mod-table' }, [
    h('thead', {}, [h('tr', {}, [
      h('th', { scope: 'col', text: 'Modelo' }),
      h('th', { scope: 'col', text: 'Velocidade' }),
      h('th', { scope: 'col', text: 'Precisão' }),
      h('th', { scope: 'col', text: 'Tamanho' }),
      h('th', { scope: 'col', class: 'mod-sr', text: 'Ações' })
    ])]),
    h('tbody', {}, rows)
  ]);

  return h('div', { class: 'mod-section' }, [
    h('h4', { class: 'mod-section-title' }, [icon('neurology'), 'Modelos']),
    h('div', { class: 'mod-table-wrap' }, [table])
  ]);
}

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
  if (!status) return;
  clear($('modWhisperHead')).append(renderHead());
  clear($('modMain')).append(renderMain());
  clear($('modModels')).append(renderModels());
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
}
