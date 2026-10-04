'use strict';

/**
 * verify-package-contents.js — pré-build (sem rede): garante que dados do usuário não entram no instalador.
 *
 * Falha (código 1) se:
 *  - a lista "build.files" do package.json incluir data/, database/, config/, settings.json ou bancos .db;
 *  - faltar a exclusão defensiva desses itens em "build.files";
 *  - alguma das pastas empacotadas (renderer, src, assets) tiver uma pasta "data", settings.json ou arquivo .db;
 *  - faltarem os arquivos que o app precisa (main.js, preload.js, sql-wasm.js e sql-wasm.wasm).
 *
 * Uso: `npm run verify:package` (os scripts build* chamam isto antes do electron-builder).
 * A conferência do arquivo final (app.asar) é feita por scripts/after-pack-check.js.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const files = (pkg.build && pkg.build.files) || [];
const problems = [];

const FORBIDDEN_INCLUDE = [/^data(\/|$)/, /^database(\/|$)/, /^config(\/|$)/, /settings\.json/i, /\.db(\.bak|\.tmp)?$/i, /^dist(\/|$)/];
for (const pattern of files) {
  if (typeof pattern !== 'string' || pattern.startsWith('!')) continue;
  const p = pattern.replace(/\\/g, '/');
  if (p === '**/*' || p === '*' || p === '**') problems.push(`"build.files" inclui tudo ("${pattern}"): liste apenas o que o app usa.`);
  if (FORBIDDEN_INCLUDE.some((re) => re.test(p))) problems.push(`"build.files" inclui "${pattern}" (dados do usuário/saída de build não podem entrar no instalador).`);
}

for (const required of ['!data/**', '!**/settings.json', '!**/*.db']) {
  if (!files.includes(required)) problems.push(`"build.files" precisa conter a exclusão "${required}".`);
}

function walk(dir, visit) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    visit(full, e);
    if (e.isDirectory()) walk(full, visit);
  }
}

for (const root of ['renderer', 'src', 'assets']) {
  walk(path.join(ROOT, root), (full, e) => {
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (e.isDirectory() && /^data$/i.test(e.name)) problems.push(`Pasta de dados dentro do pacote: ${rel}`);
    if (e.isFile() && (/^settings\.json$/i.test(e.name) || /\.db(\.bak|\.tmp)?$/i.test(e.name))) problems.push(`Arquivo de dados dentro do pacote: ${rel}`);
  });
}

for (const needed of ['main.js', 'preload.js', 'node_modules/sql.js/dist/sql-wasm.js', 'node_modules/sql.js/dist/sql-wasm.wasm']) {
  if (!fs.existsSync(path.join(ROOT, needed))) problems.push(`Arquivo necessário ausente: ${needed}`);
}

if (problems.length) {
  console.error('\nverify-package-contents: o build foi BLOQUEADO.');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('verify-package-contents: OK (nenhum dado do usuário no pacote).');
