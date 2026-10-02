/**
 * Tela "Módulos" — instala e usa módulos opcionais (hoje: Whisper para legendas e transcrição).
 * Toda a lógica vive no processo principal (src/core/modules); esta tela só pede ações via
 * window.bds.modules* e mostra o estado e o progresso. Textos entram sempre por textContent.
 */

let status = null;
let unsubs = [];
let transcribeResult = null;

// Estado do formulário de transcrição (preservado entre atualizações da tela)
const form = { files: [], srt: true, md: false, maxWords: 0, outMode: 'side', outDir: '', forceCpu: false };
let acceptCuda = false;

const VIDEO_EXTS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4a', 'wav', 'mp3', 'flac', 'ogg'];
const $ = (id) => document.getElementById(id);

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
    const err = new Error(res?.error || 'Falha desconhecida.');
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
  catch (err) { notice(`Não foi possível carregar os módulos: ${err.message}`, 'error'); }
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

function section(title, iconName, children, extraClass = '') {
  return h('div', { class: `mod-section ${extraClass}`.trim() }, [
    h('h4', { class: 'mod-section-title' }, [icon(iconName), title]),
    ...children
  ]);
}

function renderHead() {
  const w = status.whisper;
  const chip = w.ready ? ['Pronto para usar', 'ok'] : (w.engine.installed ? ['Falta escolher um modelo', 'warn'] : ['Não instalado', 'off']);
  return h('div', { class: 'mod-head' }, [
    h('div', { class: 'mod-head-icon' }, [icon('closed_caption')]),
    h('div', { class: 'mod-head-text' }, [
      h('h3', { text: w.name }),
      h('p', { text: w.description })
    ]),
    h('span', { class: `mod-state mod-state-${chip[1]}`, text: chip[0] })
  ]);
}

function renderEngine() {
  const w = status.whisper;
  const b = busy();
  const children = [];

  if (!status.platformSupported) {
    children.push(h('p', { class: 'mod-warning' }, [icon('info'), 'Este módulo está disponível apenas no Windows nesta versão.']));
    return section('Motor', 'settings_suggest', children);
  }

  if (w.engine.installed) {
    children.push(h('div', { class: 'mod-row' }, [
      h('div', { class: 'mod-row-text' }, [
        h('strong', { text: `Instalado${w.engine.version ? ` · versão ${w.engine.version}` : ''}` }),
        h('span', { class: 'mod-muted', text: w.engine.source === 'zip' ? 'Instalado a partir de um arquivo .zip.' : 'Instalado pelo servidor de módulos.' })
      ]),
      h('div', { class: 'mod-actions' }, [
        h('button', { class: 'mod-btn mod-btn-ghost', type: 'button', disabled: b, onclick: () => installEngine(false) }, [icon('upgrade'), status.manifestConfigured ? 'Reinstalar / atualizar' : 'Reinstalar de um .zip']),
        h('button', { class: 'mod-btn mod-btn-danger', type: 'button', disabled: b, onclick: removeEngine }, [icon('delete'), 'Remover'])
      ])
    ]));
  } else {
    children.push(h('p', { class: 'mod-muted' }, 'O motor é o programa que faz o reconhecimento de fala. Os modelos e a aceleração por GPU são baixados à parte, abaixo.'));
    children.push(h('div', { class: 'mod-actions' }, [
      status.manifestConfigured
        ? h('button', { class: 'mod-btn mod-btn-primary', type: 'button', disabled: b, onclick: () => installEngine(false) }, [icon('download'), 'Instalar o motor'])
        : null,
      h('button', { class: `mod-btn ${status.manifestConfigured ? 'mod-btn-ghost' : 'mod-btn-primary'}`, type: 'button', disabled: b, onclick: () => installEngine(true) }, [icon('folder_zip'), 'Instalar a partir de um .zip…'])
    ]));
    if (!status.manifestConfigured) {
      children.push(h('p', { class: 'mod-hint' }, 'A publicação do motor ainda não foi configurada neste app (manifestUrl). Por enquanto, instale a partir do arquivo .zip do motor.'));
    }
  }
  return section('Motor', 'settings_suggest', children);
}

function stars(level, max = 5) {
  return h('span', { class: 'mod-dots', 'aria-label': `${level} de ${max}` },
    Array.from({ length: max }, (_, i) => h('span', { class: `mod-dot${i < level ? ' on' : ''}` })));
}

function renderModels() {
  const w = status.whisper;
  const b = busy();
  const cudaOn = w.cuda.installed;

  const rows = w.models.map((m) => {
    const badges = [];
    if (m.recommendedFor === 'gpu') badges.push(h('span', { class: 'mod-badge mod-badge-accent', text: 'Recomendado com GPU' }));
    if (m.recommendedFor === 'cpu') badges.push(h('span', { class: 'mod-badge mod-badge-accent', text: 'Recomendado sem GPU' }));
    if (m.active) badges.push(h('span', { class: 'mod-badge mod-badge-ok', text: 'Em uso' }));

    let actions;
    if (m.installed) {
      actions = [
        m.active ? null : h('button', { class: 'mod-btn mod-btn-secondary mod-btn-sm', type: 'button', disabled: b, onclick: () => act(window.bds.modulesSetActiveModel, m.id) }, 'Usar este'),
        h('button', { class: 'mod-btn mod-btn-ghost mod-btn-sm', type: 'button', disabled: b, title: 'Remover do disco', 'aria-label': `Remover ${m.label}`, onclick: () => removeModel(m) }, [icon('delete')])
      ];
    } else {
      actions = [h('button', { class: 'mod-btn mod-btn-primary mod-btn-sm', type: 'button', disabled: b, onclick: () => act(window.bds.modulesInstallModel, m.id) }, [icon('download'), `Baixar (${fmtBytes(m.sizeBytes)})`])];
    }

    return h('div', { class: `mod-model${m.active ? ' active' : ''}${m.installed ? ' installed' : ''}` }, [
      h('div', { class: 'mod-model-main' }, [
        h('div', { class: 'mod-model-title' }, [h('strong', { text: m.label }), ...badges]),
        h('p', { class: 'mod-muted mod-model-desc', text: m.description }),
        h('div', { class: 'mod-model-meta' }, [
          h('span', { title: 'Tamanho do download' }, [icon('database'), fmtBytes(m.sizeBytes)]),
          h('span', { title: 'Velocidade relativa (referência do projeto Whisper)' }, [icon('speed'), `Velocidade ${m.speed}`, stars(m.speedLevel)]),
          h('span', { title: 'Qualidade relativa da transcrição' }, [icon('verified'), 'Qualidade', stars(m.quality)]),
          h('span', { title: 'Memória de vídeo de referência (GPU)' }, [icon('memory'), `~${m.vramGb} GB de VRAM`])
        ])
      ]),
      h('div', { class: 'mod-model-actions' }, actions.filter(Boolean))
    ]);
  });

  return section('Modelos', 'neurology', [
    h('p', { class: 'mod-muted' }, `Escolha qual modelo usar. Cada um é baixado do Hugging Face (fonte oficial) só quando você pedir, e fica no seu computador. ${cudaOn ? '' : 'Sem placa NVIDIA (ou sem o CUDA instalado), prefira o Small: os maiores ficam lentos na CPU.'}`),
    h('div', { class: 'mod-models' }, rows),
    h('p', { class: 'mod-hint', text: w.referenceNote })
  ]);
}

function renderCuda() {
  const w = status.whisper;
  const c = w.cuda;
  const b = busy();
  if (c.installed) acceptCuda = false; // um novo download exige aceitar a licença de novo
  const children = [
    h('p', { class: 'mod-muted' }, 'Usa a placa de vídeo NVIDIA para transcrever bem mais rápido. É opcional: sem ele, tudo funciona na CPU.'),
    h('p', { class: 'mod-warning' }, [icon('info'), c.requirement])
  ];

  if (!status.platformSupported) return section('Aceleração por GPU (CUDA)', 'bolt', children);

  if (c.installed) {
    const v = c.versions || {};
    children.push(h('div', { class: 'mod-row' }, [
      h('div', { class: 'mod-row-text' }, [
        h('strong', { text: 'CUDA instalado' }),
        h('span', { class: 'mod-muted', text: [v.cublas ? `cuBLAS ${v.cublas}` : null, v.cudnn ? `cuDNN ${v.cudnn}` : null].filter(Boolean).join(' · ') })
      ]),
      h('div', { class: 'mod-actions' }, [
        h('button', { class: 'mod-btn mod-btn-danger', type: 'button', disabled: b, onclick: removeCuda }, [icon('delete'), 'Remover o CUDA'])
      ])
    ]));
  } else {
    children.push(h('div', { class: 'mod-license' }, [
      h('p', {}, [
        h('strong', { text: 'Origem: ' }),
        `as bibliotecas vêm diretamente do site oficial da NVIDIA (cuBLAS e cuDNN). Download de cerca de ${fmtBytes(c.approxDownloadBytes)}; ocupam bem menos depois de extraídas.`
      ]),
      h('p', { class: 'mod-muted' }, 'Elas são software da NVIDIA, com licença própria. Leia os termos antes de baixar:'),
      h('ul', { class: 'mod-links' }, c.licenseLinks.map((l) => h('li', {}, [
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.bds?.openExternal?.(l.url); } }, [icon('open_in_new'), l.label])
      ]))),
      h('label', { class: 'mod-check' }, [
        h('input', { type: 'checkbox', checked: acceptCuda, onchange: (e) => { acceptCuda = e.target.checked; renderCudaSection(); } }),
        h('span', { text: 'Li e aceito os termos de licença da NVIDIA' })
      ])
    ]));
    children.push(h('div', { class: 'mod-actions' }, [
      h('button', { class: 'mod-btn mod-btn-primary', type: 'button', disabled: b || !acceptCuda, onclick: () => act(window.bds.modulesInstallCuda, { acceptLicense: true }) }, [icon('download'), `Baixar o CUDA (~${fmtBytes(c.approxDownloadBytes)})`])
    ]));
  }
  return section('Aceleração por GPU (CUDA)', 'bolt', children);
}

function renderCudaSection() { if (status) { const el = $('modCuda'); clear(el).append(renderCuda()); } }

function renderTranscribe() {
  const w = status.whisper;
  const b = busy();
  const ready = w.ready;
  const children = [];

  if (!ready) {
    children.push(h('p', { class: 'mod-hint' }, w.engine.installed
      ? 'Baixe e escolha um modelo para liberar a transcrição.'
      : 'Instale o motor e baixe um modelo para liberar a transcrição.'));
  }

  const fileList = form.files.length
    ? h('ul', { class: 'mod-files' }, form.files.map((f, i) => h('li', {}, [
        icon('movie'), h('span', { class: 'mod-file-name', title: f, text: f.split(/[\\/]/).pop() }),
        h('button', { class: 'mod-icon-btn', type: 'button', 'aria-label': 'Remover da lista', onclick: () => { form.files.splice(i, 1); renderTranscribeSection(); } }, [icon('close')])
      ])))
    : h('p', { class: 'mod-muted' }, 'Nenhum arquivo selecionado.');

  children.push(h('div', { class: 'mod-form' }, [
    h('div', { class: 'mod-form-block' }, [
      h('div', { class: 'mod-actions' }, [
        h('button', { class: 'mod-btn mod-btn-secondary', type: 'button', disabled: b || !ready, onclick: pickFiles }, [icon('add'), 'Adicionar arquivos…']),
        form.files.length ? h('button', { class: 'mod-btn mod-btn-ghost', type: 'button', onclick: () => { form.files = []; renderTranscribeSection(); } }, 'Limpar lista') : null
      ]),
      fileList
    ]),
    h('div', { class: 'mod-form-block mod-options' }, [
      h('label', { class: 'mod-check' }, [h('input', { type: 'checkbox', checked: form.srt, onchange: (e) => { form.srt = e.target.checked; } }), h('span', { text: 'Legenda (.srt)' })]),
      h('label', { class: 'mod-check' }, [h('input', { type: 'checkbox', checked: form.md, onchange: (e) => { form.md = e.target.checked; } }), h('span', { text: 'Transcrição com tempos (.md)' })]),
      h('label', { class: 'mod-field' }, [
        h('span', { text: 'Palavras por legenda' }),
        h('input', { type: 'number', min: '0', max: '40', value: String(form.maxWords), class: 'mod-input mod-input-short', onchange: (e) => { form.maxWords = Math.max(0, Math.min(40, Number(e.target.value) || 0)); e.target.value = String(form.maxWords); } }),
        h('small', { class: 'mod-muted', text: '0 = automático (até 2 linhas)' })
      ]),
      w.cuda.installed
        ? h('label', { class: 'mod-check' }, [h('input', { type: 'checkbox', checked: form.forceCpu, onchange: (e) => { form.forceCpu = e.target.checked; } }), h('span', { text: 'Usar só a CPU (ignorar a GPU)' })])
        : null
    ]),
    h('div', { class: 'mod-form-block' }, [
      h('strong', { class: 'mod-field-label', text: 'Onde salvar' }),
      h('label', { class: 'mod-check' }, [h('input', { type: 'radio', name: 'modOut', checked: form.outMode === 'side', onchange: () => { form.outMode = 'side'; renderTranscribeSection(); } }), h('span', { text: 'Ao lado de cada vídeo' })]),
      h('label', { class: 'mod-check' }, [h('input', { type: 'radio', name: 'modOut', checked: form.outMode === 'dir', onchange: () => { form.outMode = 'dir'; renderTranscribeSection(); } }), h('span', { text: 'Em outra pasta' })]),
      form.outMode === 'dir'
        ? h('div', { class: 'mod-folder' }, [
            h('input', { type: 'text', readonly: true, class: 'mod-input', value: form.outDir, placeholder: 'Escolha a pasta…' }),
            h('button', { class: 'mod-btn mod-btn-secondary', type: 'button', onclick: pickOutDir }, 'Escolher…')
          ])
        : null
    ])
  ]));

  children.push(h('div', { class: 'mod-actions' }, [
    h('button', { class: 'mod-btn mod-btn-primary', type: 'button', disabled: b || !ready || !form.files.length, onclick: startTranscribe }, [icon('play_arrow'), 'Iniciar'])
  ]));

  if (transcribeResult) {
    const r = transcribeResult;
    children.push(h('div', { class: 'mod-result' }, [
      h('strong', { text: `Concluído: ${r.ok} arquivo(s) com sucesso${r.failed ? `, ${r.failed} com falha` : ''}` }),
      h('span', { class: 'mod-muted', text: `Modelo ${r.model}${r.device ? ` · ${r.device}` : ''}` }),
      ...(r.errors || []).map((e) => h('p', { class: 'mod-error-line' }, [icon('error'), e])),
      r.outputs.length
        ? h('ul', { class: 'mod-outputs' }, r.outputs.map((o) => h('li', {}, [
            icon(o.kind === 'srt' ? 'closed_caption' : 'description'),
            h('span', { class: 'mod-file-name', title: o.path, text: o.path.split(/[\\/]/).pop() }),
            h('button', { class: 'mod-btn mod-btn-ghost mod-btn-sm', type: 'button', onclick: () => window.bds?.modulesReveal?.(o.path) }, [icon('folder_open'), 'Mostrar na pasta'])
          ])))
        : null
    ]));
  }

  return section('Gerar legendas e transcrição', 'subtitles', children);
}

function renderTranscribeSection() { if (status) { const el = $('modTranscribe'); clear(el).append(renderTranscribe()); } }

// ------------------------------------------------------------------ ações

async function installEngine(fromZip) {
  if (fromZip || !status.manifestConfigured) {
    const picked = await window.bds.selectFiles({
      title: 'Selecionar o pacote do motor (.zip)',
      filters: [{ name: 'Pacote do motor', extensions: ['zip'] }],
      properties: ['openFile']
    });
    const list = Array.isArray(picked) ? picked : (picked?.filePaths || []);
    if (!list.length) return;
    return act(window.bds.modulesInstallEngine, { zipPath: list[0] });
  }
  return act(window.bds.modulesInstallEngine, {});
}

async function removeEngine() {
  const ok = await window.bdsModal.confirm('Remover o motor do Whisper?\n\nOs modelos e o CUDA já baixados continuam no disco; remova-os separadamente se quiser liberar espaço.');
  if (ok) act(window.bds.modulesUninstallEngine);
}

async function removeModel(m) {
  const ok = await window.bdsModal.confirm(`Remover o modelo ${m.label}?\n\nIsso libera ${fmtBytes(m.sizeOnDisk || m.sizeBytes)}. Você pode baixá-lo de novo quando quiser.`);
  if (ok) act(window.bds.modulesRemoveModel, m.id);
}

async function removeCuda() {
  const ok = await window.bdsModal.confirm('Remover o CUDA?\n\nA transcrição continuará funcionando, mas na CPU (mais devagar).');
  if (ok) act(window.bds.modulesRemoveCuda);
}

async function pickFiles() {
  const picked = await window.bds.selectFiles({
    title: 'Selecionar vídeos ou áudios',
    filters: [{ name: 'Vídeo e áudio', extensions: VIDEO_EXTS }],
    properties: ['openFile', 'multiSelections']
  });
  const list = Array.isArray(picked) ? picked : (picked?.filePaths || []);
  for (const f of list) if (!form.files.includes(f)) form.files.push(f);
  transcribeResult = null;
  renderTranscribeSection();
}

async function pickOutDir() {
  const dir = await window.bds.selectFolder(form.outDir || '');
  if (dir) { form.outDir = dir; renderTranscribeSection(); }
}

async function startTranscribe() {
  if (!form.srt && !form.md) { notice('Marque ao menos uma saída: legenda (.srt) ou transcrição (.md).', 'error'); return; }
  if (form.outMode === 'dir' && !form.outDir) { notice('Escolha a pasta onde salvar.', 'error'); return; }
  transcribeResult = null;
  const result = await act(window.bds.modulesTranscribe, {
    files: form.files, srt: form.srt, md: form.md, maxWords: form.maxWords,
    outDir: form.outMode === 'dir' ? form.outDir : null, forceCpu: form.forceCpu
  });
  if (result) { transcribeResult = result; await refresh(); }
}

// ------------------------------------------------------------------ render geral

function render() {
  if (!status) return;
  const w = status.whisper;
  $('modDisk').textContent = status.disk.freeBytes != null ? `${fmtBytes(status.disk.freeBytes)} livres` : '—';
  clear($('modWhisperHead')).append(renderHead());
  clear($('modEngine')).append(renderEngine());
  clear($('modModels')).append(renderModels());
  clear($('modCuda')).append(renderCuda());
  clear($('modTranscribe')).append(renderTranscribe());
  $('modProgressCancel').disabled = !status.busy;
  if (!status.busy) $('modProgress').classList.add('hidden');
  void w;
}

function subscribe() {
  unsubs.forEach((fn) => { try { fn(); } catch (_) { /* noop */ } });
  unsubs = [
    window.bds?.onModulesProgress?.(onProgress),
    window.bds?.onModulesStatus?.(refresh)
  ].filter(Boolean);
}

export async function initScreen() {
  $('modProgressCancel')?.addEventListener('click', () => call(window.bds?.modulesCancel).catch(() => {}));
  subscribe();
  await refresh();
}

export async function onEnter() {
  subscribe();
  await refresh();
}

export function onLeave() {
  unsubs.forEach((fn) => { try { fn(); } catch (_) { /* noop */ } });
  unsubs = [];
}
