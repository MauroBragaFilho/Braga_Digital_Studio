'use strict';

// Linguagem visual nova: paleta fixa de cores de destaque (5 opções x 2 temas com contraste AA),
// migração/validação de accentColor, grupo de bolinhas acessível, fontes empacotadas e licenças.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const importUtil = (nome) => import(`${pathToFileURL(path.join(R, 'utils', nome)).href}?t=${Date.now()}`);
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// --- tokens do style.css -------------------------------------------------------------------------------------------
const css = read('renderer', 'style.css');
const bloco = (re) => { const m = css.match(re); assert.ok(m, `bloco ${re}`); return m[1]; };
const DARK = bloco(/:root,\s*\[data-theme="dark"\]\s*\{([\s\S]*?)\r?\n\}/);
const LIGHT = bloco(/\n\[data-theme="light"\]\s*\{([\s\S]*?)\r?\n\}/);
const tok = (b, n) => { const m = b.match(new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{6})`)); assert.ok(m, `token --${n}`); return m[1].toLowerCase(); };
const THEMES = { dark: DARK, light: LIGHT };

const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** Cor translúcida "rgba(r, g, b, a)" sobre um fundo hex opaco. */
function over(rgba, bg) {
  const m = rgba.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  assert.ok(m, `rgba inválido: ${rgba}`);
  const a = Number(m[4]);
  const b = toRgb(bg);
  return toHex([0, 1, 2].map((i) => Number(m[i + 1]) * a + b[i] * (1 - a)));
}

test('paleta: 5 opções fixas, Vermelho (#ff0000) é o padrão e a cor da marca', async () => {
  const { ACCENT_PALETTE, DEFAULT_ACCENT_ID } = await importUtil('accent-palette.js');
  assert.deepEqual(ACCENT_PALETTE.map((o) => o.name), ['Vermelho', 'Rosa', 'Azul', 'Verde', 'Laranja']);
  assert.equal(DEFAULT_ACCENT_ID, 'vermelho');
  assert.equal(ACCENT_PALETTE[0].hex, '#ff0000');
  assert.equal(ACCENT_PALETTE[0].dark.accent, '#ff0000');
});

test('contraste AA: 5 cores x 2 temas (texto em destaque, botão colorido, acento, translúcido)', async () => {
  const { contrastRatio } = await importUtil('contrast.js');
  const { ACCENT_PALETTE } = await importUtil('accent-palette.js');
  for (const [tema, b] of Object.entries(THEMES)) {
    const bg = tok(b, 'bg'); const card = tok(b, 'card'); const card2 = tok(b, 'card-2');
    for (const opt of ACCENT_PALETTE) {
      const t = opt[tema];
      const rot = `${opt.name}/${tema}`;
      for (const [nome, sup] of [['bg', bg], ['card', card], ['card-2', card2]]) {
        assert.ok(contrastRatio(t.text, sup) >= 4.5, `${rot}: texto em destaque sobre ${nome} = ${contrastRatio(t.text, sup).toFixed(2)}`);
        assert.ok(contrastRatio(t.text, over(t.light, sup)) >= 4.5, `${rot}: texto sobre o translúcido em ${nome} = ${contrastRatio(t.text, over(t.light, sup)).toFixed(2)}`);
        assert.ok(contrastRatio(t.accent, sup) >= 3, `${rot}: acento (não texto) sobre ${nome} = ${contrastRatio(t.accent, sup).toFixed(2)} (< 3)`);
      }
      assert.ok(contrastRatio('#ffffff', t.solid) >= 4.5, `${rot}: branco sobre botão colorido = ${contrastRatio('#ffffff', t.solid).toFixed(2)}`);
      assert.ok(contrastRatio('#ffffff', t.solidHover) >= 4.5, `${rot}: branco sobre botão colorido (hover)`);
      assert.ok(contrastRatio(t.hover, bg) >= 3, `${rot}: hover do acento sobre o fundo`);
    }
  }
});

test('contraste AA: texto, secundário, botão primário, estados e danger nos dois temas', async () => {
  const { contrastRatio } = await importUtil('contrast.js');
  for (const [tema, b] of Object.entries(THEMES)) {
    const sup = ['bg', 'card', 'card-2'].map((n) => [n, tok(b, n)]);
    for (const nome of ['text', 'muted', 'danger', 'danger-fg', 'status-warn', 'status-info', 'status-ok', 'status-bad', 'success', 'warning', 'info', 'accent-text']) {
      for (const [n, hex] of sup) {
        const r = contrastRatio(tok(b, nome), hex);
        assert.ok(r >= 4.5, `${tema}: --${nome} sobre --${n} = ${r.toFixed(2)} (< 4,5)`);
      }
    }
    assert.ok(contrastRatio(tok(b, 'btn-fg'), tok(b, 'btn-bg')) >= 4.5, `${tema}: botão primário`);
    assert.ok(contrastRatio(tok(b, 'btn-fg'), tok(b, 'btn-bg-hover')) >= 4.5, `${tema}: botão primário (hover)`);
    assert.ok(contrastRatio('#ffffff', tok(b, 'danger-solid')) >= 4.5, `${tema}: texto branco sobre botão destrutivo`);
    assert.ok(contrastRatio('#ffffff', tok(b, 'danger-solid-hover')) >= 4.5, `${tema}: botão destrutivo (hover)`);
    assert.ok(contrastRatio('#ffffff', tok(b, 'accent-solid')) >= 4.5, `${tema}: --on-accent sobre --accent-solid`);
  }
});

test('tokens do guia: fundos, superfícies, botão em pílula preto/branco e raios', () => {
  assert.equal(tok(DARK, 'bg'), '#000000');
  assert.equal(tok(DARK, 'card'), '#1c1c1c');
  assert.equal(tok(DARK, 'card-2'), '#262626');
  assert.equal(tok(DARK, 'text'), '#ffffff');
  assert.equal(tok(DARK, 'btn-bg'), '#ffffff');
  assert.equal(tok(DARK, 'btn-fg'), '#000000');
  assert.equal(tok(LIGHT, 'bg'), '#f4f4f4');
  assert.equal(tok(LIGHT, 'card'), '#ffffff');
  assert.equal(tok(LIGHT, 'text'), '#000000');
  assert.equal(tok(LIGHT, 'btn-bg'), '#000000');
  assert.equal(tok(LIGHT, 'btn-fg'), '#ffffff');
  for (const t of ['radius-sm: 8px', 'radius-md: 16px', 'radius-lg: 24px', 'radius-pill: 999px']) assert.match(css, new RegExp(`--${t}`));
  // nomes antigos continuam como aliases para as telas ainda não redesenhadas
  assert.match(DARK, /--accent-light:\s*rgba\(/);
  assert.match(LIGHT, /--accent-light:\s*rgba\(/);
  for (const alias of ['bg', 'card', 'card-2', 'accent', 'accent-hover', 'accent-solid', 'accent-text', 'on-accent', 'text', 'muted', 'line', 'border-color', 'danger', 'success', 'warning', 'info']) {
    tok(DARK, alias); tok(LIGHT, alias);
  }
});

test('migração: valores fora da paleta viram Vermelho ou a opção mais próxima (renderer e processo principal)', async () => {
  const { normalizeAccentHex, nearestAccentId, ACCENT_PALETTE } = await importUtil('accent-palette.js');
  const main = require('../src/core/settings/accentPalette');
  assert.deepEqual(main.ACCENT_PALETTE.map((o) => o.hex), ACCENT_PALETTE.map((o) => o.hex), 'listas coincidem');
  const casos = [
    ['#e53935', '#ff0000'], ['#E53935', '#ff0000'], ['#ff0400', '#ff0000'], ['#ff0000', '#ff0000'],
    ['#1a73e8', '#1a73e8'], ['#1e88e5', '#1a73e8'], ['#43a047', '#00a651'], ['#f25c05', '#ff6a00'],
    [undefined, '#ff0000'], [null, '#ff0000'], ['', '#ff0000'], ['vermelho', '#ff0000'], ['#fff', '#ff0000'], ['#zzzzzz', '#ff0000'], [123, '#ff0000'], [{}, '#ff0000']
  ];
  for (const [entrada, esperado] of casos) {
    assert.equal(main.normalizeAccentColor(entrada), esperado, `main: ${String(entrada)}`);
    assert.equal(normalizeAccentHex(entrada), esperado, `renderer: ${String(entrada)}`);
  }
  assert.equal(nearestAccentId('#e53935'), 'vermelho');
  for (const o of ACCENT_PALETTE) assert.equal(main.normalizeAccentColor(o.hex), o.hex);
});

test('SettingsManager: valida accentColor ao carregar (migra e regrava) e ao salvar', () => {
  const SettingsManager = require('../src/core/settings/SettingsManager');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-accent-'));
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ theme: 'dark', accentColor: '#e53935', modulesMigrated: true, enabledModules: {} }));
    const m = new SettingsManager(configDir, dataDir);
    m.safeStorage = null;
    assert.equal(m.load().accentColor, '#ff0000');
    assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')).accentColor, '#ff0000', 'migração gravada em disco');
    assert.equal(m.save({ accentColor: '#1a73e8' }).accentColor, '#1a73e8');
    assert.equal(m.save({ accentColor: '#123456' }).accentColor, '#1a73e8', 'cor livre vira a opção mais próxima');
    assert.equal(m.save({ accentColor: 'lixo' }).accentColor, '#ff0000', 'inválido volta ao padrão');
    assert.equal(m.save({ theme: 'light' }).accentColor, '#ff0000');
    assert.equal(m.defaultSettings.accentColor, '#ff0000');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Configurações: grupo de bolinhas (radio) acessível, sem seletor livre de cor', async () => {
  const { ACCENT_PALETTE } = await importUtil('accent-palette.js');
  const html = read('renderer', 'screens', 'settings.html');
  assert.doesNotMatch(html, /type="color"/i, 'sem input de cor livre');
  assert.match(html, /role="radiogroup"[^>]*aria-labelledby="accentColorLabel"/);
  assert.match(html, /id="accentColorLabel"/);
  const radios = [...html.matchAll(/<input[^>]*class="st-accent-radio"[^>]*>/g)].map((m) => m[0]);
  assert.equal(radios.length, ACCENT_PALETTE.length);
  for (const [i, o] of ACCENT_PALETTE.entries()) {
    assert.match(radios[i], /type="radio"/);
    assert.match(radios[i], new RegExp(`value="${o.hex}"`));
    assert.match(radios[i], new RegExp(`aria-label="${o.name}"`));
    assert.match(radios[i], /name="accentChoice"/);
  }
  const cssSt = read('renderer', 'screens', 'settings.css');
  assert.match(cssSt, /\.st-accent-radio:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring\)/);
  assert.match(css, /--focus-ring:\s*2px solid var\(--accent\)/);
});

test('@font-face: font-display swap, arquivos locais existentes e CSP permite fontes locais', () => {
  const faces = [...css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map((m) => m[1]);
  assert.equal(faces.length, 3, 'Inter 400, Inter 600/700 e Montserrat 700');
  const families = new Set();
  for (const f of faces) {
    families.add(f.match(/font-family:\s*'([^']+)'/)[1]);
    assert.match(f, /font-display:\s*swap/);
    const url = f.match(/url\('([^']+)'\)/)[1];
    assert.match(url, /^\.\/assets\/fonts\/[\w-]+\.woff2$/, 'caminho relativo e local, sem CDN');
    assert.ok(fs.existsSync(path.join(R, url)), `arquivo ausente: ${url}`);
  }
  assert.deepEqual([...families].sort(), ['Inter', 'Montserrat']);
  assert.match(css, /--font-title:\s*'Montserrat'/);
  assert.match(css, /--font-body:\s*'Inter'/);
  assert.match(css, /--font-body:[^;]*'Segoe UI'/, 'reserva do sistema');
  const csp = read('renderer', 'index.html').match(/Content-Security-Policy"\s+content="([^"]+)"/)[1];
  assert.match(csp, /font-src 'self'/);
  assert.doesNotMatch(css, /fonts\.googleapis|fonts\.gstatic|https?:\/\/[^)]*\.woff2?/i, 'nada de CDN');
  const pkg = require('../package.json');
  assert.ok(pkg.build.files.includes('renderer/**/*'));
  assert.ok(!pkg.build.files.some((f) => f.startsWith('!') && /woff|fonts/i.test(f)), 'fontes não são excluídas do pacote');
});

test('fontes: origem e SHA-256 documentados conferem com os arquivos; licenças OFL listadas', () => {
  const doc = read('renderer', 'assets', 'fonts', 'FONTES_ORIGEM.md');
  for (const f of ['Inter-Regular.woff2', 'Inter-SemiBold.woff2', 'Montserrat-Bold.woff2']) {
    const buf = fs.readFileSync(path.join(R, 'assets', 'fonts', f));
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', `${f} é woff2`);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    assert.ok(doc.includes(sha), `SHA-256 de ${f} não está em FONTES_ORIGEM.md`);
    assert.ok(doc.includes(f));
  }
  assert.match(doc, /github\.com\/rsms\/inter\/releases\/download\/v4\.1\/Inter-4\.1\.zip/);
  assert.match(doc, /JulietaUla\/Montserrat/);
  const list = JSON.parse(read('src', 'config', 'third-party-licenses.json'));
  for (const [id, nome] of [['font-inter', 'Inter'], ['font-montserrat', 'Montserrat']]) {
    const item = list.bundled.find((i) => i.id === id);
    assert.ok(item, `${nome} na lista de licenças`);
    assert.equal(item.license, 'OFL-1.1');
    assert.match(item.url, /^https:\/\/github\.com\//);
  }
  const txt = read('assets', 'licenses', 'THIRD_PARTY_LICENSES.txt');
  assert.match(txt, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(txt, /Inter Project Authors/);
  assert.match(txt, /Montserrat Project Authors/);
});
