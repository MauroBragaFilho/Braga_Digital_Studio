'use strict';

// O usuário nunca deve ver nomes de programas/motores internos (yt-dlp, ffmpeg, whisper, untrunc, exiftool, CUDA,
// SQLite, Electron, "Spotify"...) nem jargão técnico (SHA-256, manifest, smoke-test) na interface. Este teste varre:
//   (a) os .html de renderer/ (texto visível e atributos title/placeholder/aria-label/alt);
//   (b) os literais de string de renderer/**/*.js que parecem texto de interface;
//   (c) os literais de src/**/*.js que parecem mensagens ao usuário (erros, status, notificações, diálogos).
// A rede de segurança (renderer/utils/engineNames.js, src/services/engineNames.js) continua existindo, mas a fonte
// do texto deve estar limpa.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TERMS = /yt-?dlp|ffmpeg|ffprobe|whisper|ggml|\bdeno\b|spotdl|spotify|untrunc|exiftool|libraw|rawpy|sql\.js|sqlite|electron|chromium|\bnode\.?js\b|cuda|cublas|smoke-?test|staging|manifest|sha-?256/i;

// ALLOWLIST permanente: arquivos onde o termo é esperado (e nunca aparece na tela de forma solta).
const ALLOW_FILES = [
  /renderer\/utils\/engineNames\.js$/,   // o mascaramento em si lista os nomes que precisa trocar
  /src\/services\/engineNames\.js$/,
  /src\/services\/spotifyValidator\.js$/, // detecção por URL (hostname) e campos internos
  /src\/ipc\/channels\.js$/,              // campo "returns": documentação da tabela, não vai à tela
  /src\/config\/third-party-licenses\.json$/,
  /src\/ipc\/licensesHandlers\.js$/,
  /src\/infrastructure\/external-tools\/adapters\/[A-Za-z]+Tool\.js$/, // erros de programador (toolsDir não configurado)
  /src\/infrastructure\/external-tools\/ToolManifest\.js$/,            // idem
  /src\/core\/database\//,                                             // SQL e erros que só vão ao log
  /src\/services\/historyService\.js$/                                  // SQL (sqlite_master)
];
// Linhas ignoradas: logs, SQL, imports, comandos e comentários (comentários são removidos antes).
const IGNORE_LINE = /console\.|logger\.|logUpdater|logRecovery|\blog(Info|Warn|Error)\(|require\(|^\s*import |SELECT |PRAGMA |INSERT |CREATE /i;

// TODO(strict): exceções conhecidas em arquivos de OUTROS responsáveis (telas de Downloads/Conversor/Silêncio/
// Metadados/Transcrição/Envio e shell/Home/Biblioteca/Projetos/Workspace/Dispositivos/LUTs). Remover cada entrada
// quando o texto for corrigido na fonte; o teste então passa a valer para o arquivo inteiro.
// Só as telas de desenvolvimento ficam fora (serão revisadas quando chegar a vez delas)
const TODO_OTHER_AGENTS = [
  /renderer\/screens\/(montage|recovery)\.(js|html)$/
];

function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, ext, out);
    else if (ext.test(e.name)) out.push(full);
  }
  return out;
}
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const skipped = (r) => ALLOW_FILES.some((re) => re.test(r)) || TODO_OTHER_AGENTS.some((re) => re.test(r));

function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

// Um literal "parece texto de interface" se tem espaço e letras (frases); caminhos, comandos e identificadores
// (sem espaço) não contam.
function uiLiterals(src) {
  const found = [];
  stripJsComments(src).split('\n').forEach((line, i) => {
    if (IGNORE_LINE.test(line)) return;
    const re = /(['"`])((?:\\.|(?!\1).)*)\1/g;
    let m;
    while ((m = re.exec(line))) {
      const s = m[2].replace(/\$\{[^}]*\}/g, '${}'); // identificadores dentro de ${} não são texto
      if (!TERMS.test(s) || !/\s/.test(s)) continue;
      if ((/[\\/]|\.exe\b|^--/.test(s)) && !/[a-zà-ú]{4,} [a-zà-ú]{3,}/i.test(s)) continue;
      found.push({ line: i + 1, text: s.slice(0, 120) });
    }
  });
  return found;
}

function htmlVisible(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const texts = clean.replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
  const attrs = [...clean.matchAll(/\b(?:title|placeholder|aria-label|alt)="([^"]*)"/gi)].map((m) => m[1]);
  return [...texts, ...attrs];
}

test('HTML de renderer/: nenhum texto visível cita motores ou jargão interno', () => {
  const bad = [];
  for (const f of walk(path.join(ROOT, 'renderer'), /\.html$/)) {
    if (skipped(rel(f))) continue;
    for (const t of htmlVisible(fs.readFileSync(f, 'utf8'))) if (TERMS.test(t)) bad.push(`${rel(f)}: ${t.slice(0, 100)}`);
  }
  assert.deepEqual(bad, []);
});

test('JS de renderer/: nenhum literal de texto de interface cita motores ou jargão interno', () => {
  const bad = [];
  for (const f of walk(path.join(ROOT, 'renderer'), /\.js$/)) {
    if (skipped(rel(f))) continue;
    for (const l of uiLiterals(fs.readFileSync(f, 'utf8'))) bad.push(`${rel(f)}:${l.line}: ${l.text}`);
  }
  assert.deepEqual(bad, []);
});

test('JS de src/: mensagens ao usuário (erros, status, notificações, diálogos) não citam motores ou jargão', () => {
  const bad = [];
  for (const f of walk(path.join(ROOT, 'src'), /\.js$/)) {
    if (skipped(rel(f))) continue;
    for (const l of uiLiterals(fs.readFileSync(f, 'utf8'))) bad.push(`${rel(f)}:${l.line}: ${l.text}`);
  }
  assert.deepEqual(bad, []);
});

test('main.js: diálogos nativos não citam motores ou jargão', () => {
  const bad = uiLiterals(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')).map((l) => `main.js:${l.line}: ${l.text}`);
  assert.deepEqual(bad, []);
});

test('a lista de exceções (TODO) só aponta para arquivos que existem', () => {
  // Evita que uma exceção esquecida esconda um arquivo renomeado: cada padrão precisa casar com ao menos um arquivo.
  const all = [...walk(path.join(ROOT, 'renderer'), /\.(js|html)$/)].map(rel);
  for (const re of TODO_OTHER_AGENTS) assert.ok(all.some((f) => re.test(f)), `exceção sem arquivo: ${re}`);
});
