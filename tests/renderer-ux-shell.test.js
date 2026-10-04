'use strict';

// Auditoria de UX das telas Home, Biblioteca, Projetos, Workspace, Dispositivos e LUTs:
// estados vazios com orientação/ação, ausência de nomes de motores/marcas nos textos que o usuário lê.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const R = path.join(__dirname, '..', 'renderer');
const ARQUIVOS = ['index.html', 'app.js', 'strings.js'].map((f) => path.join(R, f));
for (const t of ['home', 'library', 'projects', 'project_workspace', 'devices', 'luts']) {
  for (const ext of ['html', 'js']) ARQUIVOS.push(path.join(R, 'screens', `${t}.${ext}`));
}

// Nomes de motores/marcas internos que o usuário nunca deve ler
const PROIBIDOS = /yt-?dlp|youtube-dl|ffmpeg|ffprobe|whisper|ggml|\bdeno\b|spot(?:ify|dl)|untrunc|exiftool|libraw|rawpy|sql\.?js|sqlite|cuda|cublas|large-v3/i;

/** Remove comentários e console.* para sobrar só o que pode ser exibido. */
function textoVisivel(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l) && !/console\.(log|warn|error|info|debug)/.test(l))
    .join('\n');
}

test('telas do shell: nenhum nome de motor/marca nos textos visíveis', () => {
  for (const f of ARQUIVOS) {
    const linhas = textoVisivel(fs.readFileSync(f, 'utf8')).split('\n');
    linhas.forEach((l, i) => {
      // identificadores internos (import, require, chaves de API) não são texto exibido
      if (/^\s*(import|const .*require)/.test(l)) return;
      const m = l.match(PROIBIDOS);
      if (m && /['"`>]/.test(l) && !/window\.bds\.|bds\.\w*(ffmpeg|whisper)/i.test(l)) {
        assert.fail(`${path.basename(f)}:${i + 1} cita "${m[0]}": ${l.trim().slice(0, 100)}`);
      }
    });
  }
});

test('Biblioteca vazia: orientação e ação "Adicionar pasta" abre o cadastro de fonte', async () => {
  const h = await mountScreen('library');
  try {
    await settle(60);
    const area = h.document.getElementById('libContentArea');
    assert.ok(area.querySelector('.bds-empty-title'), 'título do estado vazio');
    const btn = area.querySelector('[data-empty-action="add-source"]');
    assert.ok(btn, 'botão de ação');
    let clicou = false;
    h.document.getElementById('btnAddCustomSourceBtn').addEventListener('click', () => { clicou = true; });
    btn.dispatchEvent(new h.window.Event('click', { bubbles: true }));
    assert.equal(clicou, true);
    assert.doesNotMatch(area.textContent, PROIBIDOS);
  } finally { await h.cleanup(); }
});

test('Projetos vazio: botão "Criar primeiro projeto" aciona Novo Projeto', async () => {
  const h = await mountScreen('projects');
  try {
    await settle(60);
    const btn = h.document.querySelector('[data-empty-action="new-project"]');
    assert.ok(btn, 'ação no estado vazio');
    let clicou = false;
    h.document.getElementById('btnNewProject').addEventListener('click', () => { clicou = true; });
    btn.dispatchEvent(new h.window.Event('click', { bubbles: true }));
    assert.equal(clicou, true);
  } finally { await h.cleanup(); }
});

test('Dispositivos: textos de conexão sem jargão (ADB/MTP)', async () => {
  const src = fs.readFileSync(path.join(R, 'screens', 'devices.js'), 'utf8');
  const visivel = textoVisivel(src);
  assert.doesNotMatch(visivel, /Camera Remote API|ADB,|\(ADB\)|\(MTP\)/);
});

test('ícones sem texto da Biblioteca e Dispositivos têm nome acessível', async () => {
  for (const tela of ['library', 'devices']) {
    const h = await mountScreen(tela);
    try {
      await settle(40);
      const sem = [...h.document.querySelectorAll('button')]
        .filter((b) => !(b.getAttribute('aria-label') || b.getAttribute('title') || '').trim()
          && !b.textContent.replace(/\b(check_box|arrow_\w+|add|close|search|refresh)\b/g, '').trim())
        .map((b) => b.id || b.className);
      assert.deepEqual(sem, [], `${tela}: botões sem nome`);
    } finally { await h.cleanup(); }
  }
});

// ---------------------------------------------------------------------------
// Utilitários globais novos (toast, atalhos, erros amigáveis, rótulos de origem, contraste)
// ---------------------------------------------------------------------------

const { pathToFileURL } = require('node:url');
const importUtil = (nome) => import(`${pathToFileURL(path.join(R, 'utils', nome)).href}?t=${Date.now()}`);

test('friendlyError: tira o prefixo do IPC e esconde nomes de motores', async () => {
  const { friendlyError } = await importUtil('friendlyError.js');
  assert.match(friendlyError(new Error("Error invoking remote method 'x:y': Error: ffmpeg falhou")), /^motor de mídia falhou$/i);
  assert.doesNotMatch(friendlyError('yt-dlp não encontrado'), /yt-?dlp/i);
  assert.equal(friendlyError(null, 'padrão'), 'padrão');
});

test('originLabel: Spotify e motores viram termos genéricos; valores internos ficam em português', async () => {
  const { originLabel } = await importUtil('originLabel.js');
  assert.equal(originLabel('Spotify'), 'Música');
  assert.equal(originLabel('spotDL'), 'Música');
  assert.equal(originLabel('LOCAL'), 'Computador');
  assert.equal(originLabel('DOWNLOAD'), 'Download');
  assert.equal(originLabel('BDSM Mobile'), 'Celular');
  assert.equal(originLabel(''), 'Computador');
  assert.doesNotMatch(originLabel('ffmpeg'), /ffmpeg/i);
});

test('toast: mostra o aviso, "Desfazer" executa a ação e some; texto passa pelo mascaramento', async () => {
  const h = await mountScreen('home');
  try {
    const { showToast } = await importUtil('toast.js');
    let desfez = 0;
    showToast('Salvo por yt-dlp', { actionLabel: 'Desfazer', onAction: () => { desfez++; }, duration: 0 });
    const toast = h.document.querySelector('.bds-toast');
    assert.ok(toast, 'toast renderizado');
    assert.doesNotMatch(toast.textContent, /yt-?dlp/i);
    toast.querySelector('.bds-toast-action').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    assert.equal(desfez, 1);
    assert.equal(h.document.querySelector('.bds-toast'), null, 'some depois da ação');
    assert.equal(h.document.getElementById('bdsToasts').getAttribute('aria-live'), 'polite');
  } finally { await h.cleanup(); }
});

test('modal acessível: Esc fecha pelo botão de fechar e o foco volta a quem abriu', async () => {
  const h = await mountScreen('home');
  try {
    const { enhanceModalOverlay } = await importUtil('modal.js');
    const d = h.document;
    d.body.insertAdjacentHTML('beforeend',
      '<button id="abre">abrir</button><div id="ov" class="hidden"><h2>Título</h2><button id="btnClose">x</button><button id="ok">ok</button></div>');
    const ov = d.getElementById('ov');
    const abre = d.getElementById('abre');
    enhanceModalOverlay(ov, { isOpen: (el) => !el.classList.contains('hidden') });
    assert.equal(ov.getAttribute('role'), 'dialog');
    assert.equal(ov.getAttribute('aria-modal'), 'true');
    d.getElementById('btnClose').addEventListener('click', () => ov.classList.add('hidden'));
    abre.focus();
    ov.classList.remove('hidden');
    await settle(30);
    const esc = new h.window.Event('keydown', { bubbles: true });
    esc.key = 'Escape';
    ov.dispatchEvent(esc);
    assert.ok(ov.classList.contains('hidden'), 'Esc fechou');
  } finally { await h.cleanup(); }
});

test('contraste: tokens padrão do style.css cumprem WCAG AA nos dois temas', async () => {
  const { contrastRatio } = await importUtil('contrast.js');
  const css = fs.readFileSync(path.join(R, 'style.css'), 'utf8');
  const bloco = (re) => { const m = css.match(re); assert.ok(m, `bloco ${re}`); return m[1]; };
  const tok = (b, n) => { const m = b.match(new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{6})`)); assert.ok(m, `token ${n}`); return m[1]; };
  const dark = bloco(/:root,\s*\[data-theme="dark"\]\s*\{([\s\S]*?)\r?\n\}/);
  const light = bloco(/\n\[data-theme="light"\]\s*\{([\s\S]*?)\r?\n\}/);
  const pares = [
    ['escuro', dark, [['text', 'bg'], ['text', 'card'], ['muted', 'bg'], ['muted', 'card'], ['accent-text', 'card'], ['on-accent', 'accent-solid']]],
    ['claro', light, [['text', 'bg'], ['text', 'card'], ['muted', 'bg'], ['muted', 'card'], ['accent-text', 'bg'], ['on-accent', 'accent-solid']]]
  ];
  for (const [nome, b, lista] of pares) {
    for (const [a, c] of lista) {
      const r = contrastRatio(tok(b, a), tok(b, c));
      assert.ok(r >= 4.5, `${nome}: --${a} sobre --${c} = ${r.toFixed(2)} (< 4,5)`);
    }
  }
});

test('toneForContrast: cor de destaque personalizada ganha variante legível', async () => {
  const { toneForContrast, contrastRatio } = await importUtil('contrast.js');
  const solido = toneForContrast('#ff9800', '#ffffff', 4.5, '#000000');
  assert.ok(contrastRatio(solido, '#ffffff') >= 4.5);
  const texto = toneForContrast('#3366ff', '#3a2020', 4.6, '#ffffff');
  assert.ok(contrastRatio(texto, '#3a2020') >= 4.6);
});
