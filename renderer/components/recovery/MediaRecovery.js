/**
 * MediaRecovery — recuperação de fotos (JPG e RAW) e vídeos corrompidos, ligada aos serviços reais
 * (window.bds.recovery.*, recovery.raw.*, recovery.jpg.*).
 *
 * Fluxo: escolher/arrastar o arquivo → diagnóstico automático → "Recuperar" → resultado.
 * Referência, pasta de saída e nível ficam recolhidos em "Opções avançadas".
 * Todo texto entra por textContent (via h()); nada vindo dos arquivos é interpretado como HTML.
 */

import { h, icon, clear, formatBytes } from './recoveryUtils.js';

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mts', 'm2ts', 'avi', 'mkv', 'mxf', '3gp', 'mpg', 'mpeg', 'webm'];
const JPG_EXT = ['jpg', 'jpeg'];
const RAW_EXT = ['cr2', 'cr3', 'crw', 'arw', 'sr2', 'srf', 'nef', 'nrw', 'raf', 'orf', 'rw2', 'pef', 'srw', '3fr', 'erf', 'kdc', 'mrw', 'dng'];

const KINDS = {
  video: { label: 'Vídeo', icon: 'movie', api: (b) => b.recovery, refLabel: 'Vídeo de referência (mesma câmera)', refExt: VIDEO_EXT },
  jpg: { label: 'Foto JPG', icon: 'image', api: (b) => b.recovery.jpg, refLabel: null, refExt: [] },
  raw: { label: 'Foto RAW', icon: 'photo_camera', api: (b) => b.recovery.raw, refLabel: 'RAW de referência (mesma câmera)', refExt: RAW_EXT },
};

const STRATEGY_TEXT = {
  NENHUM_REPARO: 'A foto parece íntegra; nenhum reparo deve ser necessário.',
  LIMPEZA: 'A foto está completa, mas há bytes extras que serão removidos.',
  FECHAR_ARQUIVO: 'A foto foi cortada. O que existe será mantido e o arquivo fechado; a parte final da imagem se perde.',
  EXTRAIR_MINIATURA: 'A imagem principal não pode ser usada. Será extraída a miniatura embutida.',
  IMPOSSIVEL: 'Não foi encontrada nenhuma imagem aproveitável neste arquivo.',
  DIRECT_RECOVERY: 'Os dados de imagem estão acessíveis e serão exportados diretamente.',
  REFERENCE_RECOVERY: 'A estrutura será reconstruída usando o RAW de referência.',
  PREVIEW_RECOVERY: 'Será extraída a pré-visualização JPEG embutida no RAW (os dados originais do sensor não são reconstruídos).',
  EXPORT_RECOVERY: 'Será feita uma exportação tolerante a falhas dos dados disponíveis.',
  NIVEL_1_RAPIDO: 'O vídeo tem estrutura legível: será feita uma recuperação rápida do contêiner.',
  NIVEL_2_ESTRUTURAL: 'A estrutura do vídeo está danificada. Um vídeo de referência da mesma câmera aumenta muito a chance de sucesso.',
};

export function detectKind(filePath) {
  const ext = String(filePath || '').split('.').pop().toLowerCase();
  if (JPG_EXT.includes(ext)) return 'jpg';
  if (RAW_EXT.includes(ext)) return 'raw';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return null;
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop();
const dirName = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');
/** Tira o prefixo "Error invoking remote method ..." que o Electron coloca nas falhas do IPC. */
const friendly = (e) => String((e && e.message) || e || 'Falha inesperada.').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

function severityTone(text) {
  const s = String(text || '').toUpperCase();
  if (s.startsWith('LEVE')) return 'low';
  if (s.startsWith('MODERADA')) return 'medium';
  return 'high';
}

export function mountMediaRecovery(root) {
  const bds = window.bds;
  const s = {
    phase: 'idle', // idle | analyzing | ready | running | done | error
    file: null, kind: null, diag: null,
    reference: null, outputDir: null, level: 'AUTO', advOpen: false,
    progress: { percent: null, message: '' },
    result: null, error: null,
  };
  let unsubscribe = null;
  let destroyed = false;

  const available = () => Boolean(bds && bds.recovery);

  function set(patch) {
    if (destroyed) return;
    Object.assign(s, patch);
    render();
  }

  // ---------- ações ----------
  async function pickFile() {
    const files = await bds.selectFiles({
      title: 'Selecionar foto ou vídeo para recuperar',
      filters: [
        { name: 'Fotos e vídeos', extensions: [...JPG_EXT, ...RAW_EXT, ...VIDEO_EXT] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
      properties: ['openFile'],
    }).catch(() => []);
    if (files && files[0]) loadFile(files[0]);
  }

  async function pickReference() {
    const exts = KINDS[s.kind].refExt;
    const files = await bds.selectFiles({
      title: 'Selecionar arquivo de referência',
      filters: [{ name: 'Arquivo de referência', extensions: exts }],
      properties: ['openFile'],
    }).catch(() => []);
    if (files && files[0]) { s.reference = files[0]; await diagnose(); }
  }

  async function pickOutput() {
    const dir = await bds.selectFolder(s.outputDir || '').catch(() => null);
    if (dir) set({ outputDir: dir });
  }

  async function loadFile(filePath) {
    const kind = detectKind(filePath);
    if (!kind) {
      set({ phase: 'error', file: filePath, kind: null, error: 'Formato não reconhecido. Use um vídeo, uma foto JPG ou um RAW de câmera.', diag: null, result: null });
      return;
    }
    s.file = filePath; s.kind = kind; s.reference = null; s.result = null; s.error = null; s.diag = null;
    await diagnose();
  }

  async function diagnose() {
    set({ phase: 'analyzing', error: null });
    try {
      const api = KINDS[s.kind].api(bds);
      const diag = KINDS[s.kind].refLabel ? await api.diagnose(s.file, s.reference) : await api.diagnose(s.file);
      set({ phase: 'ready', diag });
    } catch (err) {
      set({ phase: 'error', error: friendly(err), diag: null });
    }
  }

  async function start() {
    const api = KINDS[s.kind].api(bds);
    set({ phase: 'running', progress: { percent: null, message: 'Iniciando...' }, result: null, error: null });
    unsubscribe = api.onProgress((p) => {
      if (!destroyed) set({ progress: { percent: typeof p?.percent === 'number' ? p.percent : null, message: p?.message || s.progress.message } });
    });
    try {
      const options = { corruptPath: s.file, referencePath: s.reference || '', outputDir: s.outputDir || '' };
      if (s.kind === 'video') options.preferredLevel = s.level;
      const result = await api.start(options);
      set({ phase: 'done', result });
    } catch (err) {
      const msg = friendly(err);
      set({ phase: /cancelad/i.test(msg) ? 'ready' : 'error', error: /cancelad/i.test(msg) ? null : msg });
    } finally {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    }
  }

  async function cancel() {
    try { await KINDS[s.kind].api(bds).cancel(); } catch (_) { /* o start() devolve o erro de cancelamento */ }
  }

  function reset() { set({ phase: 'idle', file: null, kind: null, diag: null, reference: null, result: null, error: null }); }

  function reveal(p) {
    if (bds.openLocalPath) bds.openLocalPath(dirName(p));
  }

  // ---------- visual ----------
  const field = (label, value) => h('div', { class: 'rc-field' }, [
    h('span', { class: 'rc-field-label', text: label }),
    h('span', { class: 'rc-field-value', text: value || '—' }),
  ]);

  function dropZone() {
    const zone = h('button', { class: 'rm-drop', type: 'button', onclick: pickFile }, [
      icon('upload_file', 'rm-drop-icon'),
      h('strong', { text: 'Escolher foto ou vídeo danificado' }),
      h('span', { class: 'rc-muted', text: 'ou arraste o arquivo para cá' }),
      h('span', { class: 'rm-formats', text: 'Vídeos (MP4, MOV, MTS…), fotos JPG e RAW (CR2, CR3, ARW, NEF, DNG, RAF…)' }),
    ]);
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      const p = f && (bds.getPathForFile ? bds.getPathForFile(f) : f.path);
      if (p) loadFile(p);
    });
    return zone;
  }

  function diagFields() {
    const c = s.diag.corrupted;
    const rows = [field('Tamanho', formatBytes(c.sizeBytes))];
    if (s.kind === 'video') {
      rows.push(field('Codec', c.codec), field('Resolução', c.resolution),
        field('Duração', c.durationSec ? `${Math.round(c.durationSec)} s` : 'Desconhecida'), field('Áudio', c.hasAudio ? 'Sim' : 'Não detectado'));
    } else if (s.kind === 'raw') {
      rows.push(field('Formato', c.format), field('Câmera', [c.manufacturer, c.camera].filter((x) => x && x !== 'Desconhecido').join(' ') || 'Desconhecida'),
        field('Pré-visualização embutida', c.previewAvailable ? c.previewResolution : 'Não encontrada'));
    } else {
      rows.push(field('Resolução', c.resolution || 'Não identificada'), field('Metadados (EXIF)', c.hasMetadata ? 'Presentes' : 'Ausentes'));
    }
    return rows;
  }

  function strategyKey() {
    return s.kind === 'video' ? s.diag.suggestedLevel : s.diag.suggestedStrategy;
  }

  function advanced() {
    const k = KINDS[s.kind];
    const body = [];
    body.push(h('div', { class: 'rm-adv-row' }, [
      h('span', { class: 'rc-field-label', text: 'Pasta de saída' }),
      h('span', { class: 'rm-adv-value', text: s.outputDir || 'Mesma pasta do arquivo' }),
      h('button', { class: 'rc-btn rc-btn-ghost', type: 'button', onclick: pickOutput, text: 'Escolher' }),
      s.outputDir ? h('button', { class: 'rc-btn rc-btn-ghost', type: 'button', onclick: () => set({ outputDir: null }), text: 'Padrão' }) : null,
    ]));
    if (k.refLabel) {
      body.push(h('div', { class: 'rm-adv-row' }, [
        h('span', { class: 'rc-field-label', text: k.refLabel }),
        h('span', { class: 'rm-adv-value', text: s.reference ? baseName(s.reference) : 'Nenhuma' }),
        h('button', { class: 'rc-btn rc-btn-ghost', type: 'button', onclick: pickReference, text: 'Escolher' }),
        s.reference ? h('button', { class: 'rc-btn rc-btn-ghost', type: 'button', onclick: () => { s.reference = null; diagnose(); }, text: 'Remover' }) : null,
      ]));
    }
    if (s.kind === 'video') {
      body.push(h('div', { class: 'rm-adv-row' }, [
        h('span', { class: 'rc-field-label', text: 'Método' }),
        h('select', { class: 'rc-select', 'aria-label': 'Método de recuperação', onchange: (e) => { s.level = e.target.value; } }, [
          ['AUTO', 'Automático (recomendado)'], ['NIVEL_1', 'Rápido (contêiner)'], ['NIVEL_2', 'Estrutural (precisa de referência)'],
        ].map(([v, t]) => h('option', { value: v, text: t, ...(v === s.level ? { selected: true } : {}) }))),
      ]));
    }
    const d = h('details', { class: 'rm-adv' }, [h('summary', { text: 'Opções avançadas' }), ...body]);
    d.open = s.advOpen;
    d.addEventListener('toggle', () => { s.advOpen = d.open; });
    return d;
  }

  function fileCard() {
    const k = KINDS[s.kind];
    const c = s.diag && s.diag.corrupted;
    const comp = s.diag && s.diag.compatibility;
    return h('section', { class: 'rc-card' }, [
      h('div', { class: 'rc-card-head' }, [
        h('span', { class: 'rc-card-title' }, [icon(k.icon), baseName(s.file)]),
        c ? h('span', { class: `rm-sev rm-sev-${severityTone(c.severity)}`, text: c.severity.split(' (')[0] }) : null,
      ]),
      c ? h('p', { class: 'rm-sev-detail rc-muted', text: c.severity.includes('(') ? c.severity.slice(c.severity.indexOf('(') + 1, -1) : k.label }) : null,
      c ? h('div', { class: 'rc-field-grid' }, diagFields()) : null,
      s.diag ? h('p', { class: 'rm-strategy' }, [icon('lightbulb'), STRATEGY_TEXT[strategyKey()] || '']) : null,
      s.diag && s.reference && comp && comp.status !== 'NENHUMA_REFERENCIA'
        ? h('p', { class: 'rm-compat rc-muted', text: `Referência: ${comp.badge}. ${comp.message}` }) : null,
      s.diag && s.kind === 'raw' && !c.engineAvailable
        ? h('p', { class: 'rm-compat rc-muted', text: 'O RAW em si não pode ser reconstruído neste computador; o resultado será um JPG com a melhor pré-visualização encontrada.' }) : null,
      s.diag ? advanced() : null,
      h('div', { class: 'rc-action-row rm-actions' }, [
        h('button', { class: 'rc-btn rc-btn-primary', type: 'button', disabled: s.phase !== 'ready' || strategyKey() === 'IMPOSSIVEL', onclick: start }, [icon('healing'), 'Recuperar']),
        h('button', { class: 'rc-btn rc-btn-secondary', type: 'button', onclick: pickFile, text: 'Trocar arquivo' }),
      ]),
    ]);
  }

  function runningCard() {
    const pct = s.progress.percent;
    const fill = h('div', { class: 'rc-progress-fill' });
    fill.style.width = `${pct === null ? 100 : Math.max(2, Math.min(100, pct))}%`;
    if (pct === null) fill.classList.add('rm-indeterminate');
    return h('section', { class: 'rc-card' }, [
      h('div', { class: 'rc-card-head' }, [h('span', { class: 'rc-card-title' }, [icon(KINDS[s.kind].icon), `Recuperando ${baseName(s.file)}`])]),
      h('div', { class: 'rc-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, ...(pct === null ? {} : { 'aria-valuenow': Math.round(pct) }) }, [fill]),
      h('div', { class: 'rc-progress-info' }, [h('span', { text: s.progress.message }), h('strong', { text: pct === null ? '' : `${Math.round(pct)}%` })]),
      h('div', { class: 'rc-action-row' }, [h('button', { class: 'rc-btn rc-btn-danger', type: 'button', onclick: cancel, text: 'Cancelar' })]),
    ]);
  }

  function resultCard() {
    const r = s.result;
    const partial = /PARCIAL/.test(r.resultQuality || '');
    const info = [
      field('Método', r.methodUsed), field('Resultado', r.resultQuality), field('Tamanho', formatBytes(r.sizeBytes)),
      field('Resolução', r.resolution && r.resolution !== 'Desconhecido' ? r.resolution : null),
    ];
    if (r.durationSec) info.push(field('Duração', `${Math.round(r.durationSec)} s`));
    return h('section', { class: 'rc-card' }, [
      h('div', { class: `rc-result ${partial ? 'rm-result-partial' : 'rc-result-ok'}` }, [
        icon(partial ? 'warning' : 'check_circle'),
        h('div', {}, [
          h('strong', { text: r.unchanged ? 'A foto já estava íntegra' : (partial ? 'Recuperação parcial' : 'Arquivo recuperado') }),
          h('span', { class: 'rc-muted', text: r.fileName }),
        ]),
      ]),
      h('div', { class: 'rc-field-grid' }, info),
      ...((r.warnings || []).map((w) => h('p', { class: 'rm-warning' }, [icon('info'), w]))),
      h('div', { class: 'rc-action-row rm-actions' }, [
        h('button', { class: 'rc-btn rc-btn-primary', type: 'button', onclick: () => reveal(r.outputPath) }, [icon('folder_open'), 'Mostrar na pasta']),
        h('button', { class: 'rc-btn rc-btn-secondary', type: 'button', onclick: reset, text: 'Recuperar outro arquivo' }),
      ]),
    ]);
  }

  function errorCard() {
    return h('section', { class: 'rc-card' }, [
      h('div', { class: 'rc-result rc-result-error' }, [
        icon('error'),
        h('div', {}, [h('strong', { text: 'Não foi possível concluir' }), h('span', { class: 'rc-muted', text: s.error })]),
      ]),
      h('div', { class: 'rc-action-row rm-actions' }, [
        s.diag && s.file ? h('button', { class: 'rc-btn rc-btn-secondary', type: 'button', onclick: () => set({ phase: 'ready', error: null }), text: 'Voltar' }) : null,
        h('button', { class: 'rc-btn rc-btn-primary', type: 'button', onclick: pickFile, text: 'Escolher outro arquivo' }),
      ]),
    ]);
  }

  function render() {
    clear(root);
    if (!available()) {
      root.append(h('div', { class: 'rc-card' }, [h('p', { class: 'rc-muted', text: 'Recursos de recuperação indisponíveis nesta janela.' })]));
      return;
    }
    const wrap = h('div', { class: 'rc-single rm-wrap' });
    if (s.phase === 'idle') {
      wrap.append(dropZone());
    } else if (s.phase === 'analyzing') {
      wrap.append(h('div', { class: 'rc-loading-inline' }, [h('span', { class: 'rc-spinner' }), `Analisando ${baseName(s.file)}...`]));
    } else if (s.phase === 'running') {
      wrap.append(runningCard());
    } else if (s.phase === 'done') {
      wrap.append(resultCard());
    } else if (s.phase === 'error') {
      wrap.append(errorCard());
    } else {
      wrap.append(fileCard());
    }
    root.append(wrap);
  }

  render();

  return {
    destroy() {
      destroyed = true;
      if (unsubscribe) unsubscribe();
      clear(root);
    },
  };
}
