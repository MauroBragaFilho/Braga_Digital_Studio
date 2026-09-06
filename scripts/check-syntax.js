'use strict';

/**
 * check-syntax.js — Validação de sintaxe de todos os arquivos JS do projeto.
 *
 * FASE 5 (qualidade): Verifica que nenhum arquivo JS introduz erro de sintaxe
 * antes de executar o app. Uso:
 *   node scripts/check-syntax.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', '_Archives', 'data', 'logs']);

let errors = [];
let total = 0;

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      total++;
      const res = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
      if (res.status !== 0) {
        errors.push({ file: path.relative(ROOT, full), error: (res.stderr || res.stdout || '').trim().split('\n')[0] });
      }
    }
  }
}

walk(ROOT);

console.log(`\n[check-syntax] Verificados ${total} arquivos JS.`);
if (errors.length === 0) {
  console.log('[check-syntax] \u2713 Nenhum erro de sintaxe encontrado.\n');
  process.exit(0);
} else {
  console.error(`[check-syntax] \u2717 ${errors.length} arquivo(s) com erro de sintaxe:`);
  for (const e of errors) {
    console.error(`  - ${e.file}: ${e.error}`);
  }
  console.error('');
  process.exit(1);
}