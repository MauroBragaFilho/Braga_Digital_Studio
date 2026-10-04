'use strict';

// Regressões da linguagem visual nova nas telas de produção (Recuperação e Montagem ficam de fora: em desenvolvimento).
// Garante: nenhum botão "fundo --accent + texto branco", hex soltos só nas exceções justificadas, fontes pelos tokens,
// var() sempre definidas e arquivos de fonte existentes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const lerCss = (rel) => fs.readFileSync(path.join(R, rel), 'utf8');

const TELAS = [
  'screens/home.css', 'screens/download.css', 'screens/settings.css', 'screens/library.css', 'screens/transcription.css',
  'screens/converter.css', 'screens/silence.css', 'screens/metadata.css', 'screens/luts.css', 'screens/devices.css',
  'screens/projects.css', 'screens/project_workspace.css', 'screens/upload.css',
  'components/ai-assistant.css', 'components/modules-panel.css',
  'components/preview/audio-preview.css', 'components/preview/photo-preview.css',
  'components/preview/preview-popup.css', 'components/preview/video-preview.css',
  'shell.css'
];

/** Limite de cores hex soltas por arquivo: só sobreposições sobre mídia/capa e véus (cada uma comentada no CSS). */
const LIMITE_HEX = {
  'screens/library.css': 6, 'screens/luts.css': 6, 'screens/converter.css': 2, 'screens/projects.css': 4,
  'screens/project_workspace.css': 6, 'screens/settings.css': 3, 'screens/home.css': 3, 'shell.css': 6,
  'components/preview/audio-preview.css': 22, 'components/preview/photo-preview.css': 34,
  'components/preview/preview-popup.css': 3, 'components/preview/video-preview.css': 24
};

/** Regras (seletor + corpo) sem comentários, ignorando @keyframes internos de forma simples. */
function regras(css) {
  const limpo = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(limpo))) out.push({ seletor: m[1].trim(), corpo: m[2] });
  return out;
}

// Elementos em que o acento puro como fundo é indicador (barra, trilho, ponto, interruptor), não botão com texto
const INDICADOR = /progress|fill|bar|dot|indicator|track|thumb|switch|toggle|slider|radio|check|marker|pulse|spinner|underline|handle|tick|ring|segment|line|badge-dot|range|update-badge|::before|::after/i;

test('nenhuma regra usa fundo --accent com texto branco (botão colorido usa --btn-bg ou --accent-solid)', () => {
  const falhas = [];
  for (const rel of [...TELAS, 'style.css']) {
    for (const r of regras(lerCss(rel))) {
      if (!/background(-color)?\s*:\s*var\(--accent\)\s*(;|$)/.test(r.corpo)) continue;
      const cor = r.corpo.match(/(?:^|;|\s)color\s*:\s*([^;]+)/);
      const branco = cor && /#fff\b|#ffffff|white|var\(--on-accent|var\(--text\)/i.test(cor[1]);
      if (branco || !INDICADOR.test(r.seletor)) falhas.push(`${rel}: ${r.seletor.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  assert.deepEqual(falhas, [], `fundo --accent em botão/texto:\n${falhas.join('\n')}`);
});

test('hex soltos só dentro do limite das exceções justificadas (resto usa tokens)', () => {
  for (const rel of TELAS) {
    const css = lerCss(rel).replace(/\/\*[\s\S]*?\*\//g, '');
    const n = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length;
    const limite = LIMITE_HEX[rel] ?? 0;
    assert.ok(n <= limite, `${rel}: ${n} cores hex soltas (limite ${limite}); use tokens ou documente a exceção e ajuste o limite`);
  }
});

test('fontes das telas vêm dos tokens (--font-title / --font-body) ou são monoespaçadas', () => {
  for (const rel of TELAS) {
    const css = lerCss(rel).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      assert.ok(/^var\(--font-(title|body)\)|^inherit$|monospace|material symbols/i.test(v), `${rel}: font-family fora dos tokens: ${v}`);
    }
  }
});

test('toda var(--x) usada nos CSS de tela está definida em algum lugar do renderer (CSS, JS ou HTML)', () => {
  const arquivos = [];
  const andar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'assets' && e.name !== 'vendor') andar(p); } else if (/\.(css|js|html)$/.test(e.name)) arquivos.push(p);
    }
  };
  andar(R);
  const tudo = arquivos.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const definidas = new Set([...tudo.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const m of tudo.matchAll(/setProperty\(\s*['"](--[\w-]+)['"]/g)) definidas.add(m[1]);
  const faltando = new Set();
  for (const rel of [...TELAS, 'style.css']) {
    for (const m of lerCss(rel).matchAll(/var\(\s*(--[\w-]+)\s*(,|\))/g)) {
      if (!definidas.has(m[1]) && m[2] === ')') faltando.add(`${rel}: ${m[1]}`);
    }
  }
  assert.deepEqual([...faltando], [], 'var() sem definição e sem valor reserva');
});

test('raio dos botões e campos nas telas usa tokens ou pílula (sem cantos antigos soltos em botões)', () => {
  const ruins = [];
  for (const rel of TELAS) {
    for (const r of regras(lerCss(rel))) {
      if (!/(btn|button)/i.test(r.seletor) || /icon|close|dot|badge|chip|switch|toggle|thumb|swatch|star|fav|check|menu-item|view-btn|mute|tool-btn|hist-btn|win-btn|focus-visible/i.test(r.seletor)) continue;
      const m = r.corpo.match(/border-radius\s*:\s*(\d+)px/);
      if (m && Number(m[1]) > 0 && Number(m[1]) < 8) ruins.push(`${rel}: ${r.seletor.slice(0, 70)} (${m[1]}px)`);
    }
  }
  assert.deepEqual(ruins, [], 'botões com raio < 8px');
});

test('interface de produção não cita motores internos nem "Spotify" nos HTML das telas', () => {
  const proibidos = /yt-dlp|ffmpeg|whisper|\bdeno\b|sqlite|electron|spotify/i;
  const dir = path.join(R, 'screens');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html') && !/recovery|montage/.test(x))) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8')
      .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    const textos = [...html.matchAll(/>([^<>]+)</g)].map((m) => m[1]).concat([...html.matchAll(/(?:title|placeholder|aria-label|alt)="([^"]*)"/g)].map((m) => m[1]));
    for (const t of textos) assert.doesNotMatch(t, proibidos, `${f}: texto visível cita motor interno: ${t.trim()}`);
  }
});

test('fontes referenciadas por qualquer CSS de renderer existem em disco', () => {
  for (const rel of [...TELAS, 'style.css']) {
    for (const m of lerCss(rel).matchAll(/url\(\s*['"]?([^'")]+\.(?:woff2?|ttf))['"]?\s*\)/g)) {
      assert.ok(fs.existsSync(path.join(R, path.dirname(rel), m[1])), `${rel}: fonte ausente ${m[1]}`);
    }
  }
});
