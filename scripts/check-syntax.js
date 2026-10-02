'use strict';

/**
 * check-syntax.js — Validação de sintaxe de todos os arquivos JS do projeto.
 *
 * Verifica que nenhum arquivo JS introduz erro de sintaxe antes de executar o app.
 * Roda `node --check` em paralelo (concorrência limitada). Arquivos com import/export
 * (módulos ES do renderer) são verificados como módulo, via stdin. Uso:
 *   node scripts/check-syntax.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', '_Archives', 'data', 'logs', '.freebuff']);
const isExcluded = (name) => EXCLUDED_DIRS.has(name) || name.startsWith('.Teste');
const ES_MODULE_RE = /^\s*(import\s[^('"]*?from\s|import\s*['"{*]|export\s)/m;

const files = [];
(function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isExcluded(entry.name)) walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
})(ROOT);

function checkFile(full) {
  return new Promise((resolve) => {
    let source = '';
    try { source = fs.readFileSync(full, 'utf8'); } catch (_) { /* tratado pelo node --check */ }
    const asModule = ES_MODULE_RE.test(source);
    const args = asModule ? ['--check', '--input-type=module', '-'] : ['--check', full];
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({ file: full, error: e.message }));
    child.on('close', (code) => {
      if (code === 0) return resolve(null);
      const lines = out.trim().split('\n');
      resolve({ file: full, error: (lines.find((l) => /Error/.test(l)) || lines[0] || '').trim() });
    });
    if (asModule) child.stdin.end(source); else child.stdin.end();
  });
}

async function main() {
  const errors = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(2, Math.min(os.cpus().length, 8)) }, async () => {
    while (next < files.length) {
      const res = await checkFile(files[next++]);
      if (res) errors.push({ file: path.relative(ROOT, res.file), error: res.error });
    }
  });
  await Promise.all(workers);
  errors.sort((a, b) => a.file.localeCompare(b.file));

  console.log(`\n[check-syntax] Verificados ${files.length} arquivos JS.`);
  if (errors.length === 0) {
    console.log('[check-syntax] \u2713 Nenhum erro de sintaxe encontrado.\n');
    process.exit(0);
  }
  console.error(`[check-syntax] \u2717 ${errors.length} arquivo(s) com erro de sintaxe:`);
  for (const e of errors) console.error(`  - ${e.file}: ${e.error}`);
  console.error('');
  process.exit(1);
}

main();
