'use strict';

/**
 * verify-package-contents.js — pré-build (sem rede): garante que dados do usuário não entram no instalador.
 *
 * Falha (código 1) se:
 *  - a lista "build.files" do package.json incluir data/, database/, config/, settings.json ou bancos .db;
 *  - faltar a exclusão defensiva desses itens em "build.files";
 *  - alguma das pastas empacotadas (renderer, src, assets) tiver uma pasta "data", settings.json ou arquivo .db;
 *  - faltarem os arquivos que o app precisa (main.js, preload.js, sql-wasm.js e sql-wasm.wasm);
 *  - as LUTs embutidas (resources/luts-embutidas) tiverem aviso de copyright no cabeçalho, arquivo fora de
 *    PROCEDENCIA.json ou conteúdo diferente do SHA-256 registrado.
 *
 * Em modo de release (`--release` ou BDS_RELEASE=1; os scripts build* usam `--release`) falha também se a
 * procedência das LUTs embutidas ainda estiver "a-confirmar" ou se faltar alguma delas. Fora do release isso só avisa.
 *
 * Uso: `npm run verify:package` (os scripts build* chamam isto antes do electron-builder).
 * A conferência do arquivo final (app.asar e recursos) é feita por scripts/after-pack-check.js.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BUNDLED_LUTS_DIR = path.join(ROOT, 'resources', 'luts-embutidas');
const PROVENANCE_STATUSES = ['a-confirmar', 'confirmada'];
// Aviso de direitos autorais no começo do arquivo (as 4 LUTs utilitárias da Adobe ficaram de fora por isso)
const COPYRIGHT_HEADER = /adobe|copyright|©|\(c\)/i;

/**
 * Confere a pasta das LUTs embutidas contra o PROCEDENCIA.json. Só lê arquivos; nunca altera nada.
 * Pasta sem .cube (clone limpo: as .cube ainda não são versionadas) não é erro fora do release.
 * @param {{ dir?: string, release?: boolean }} [options]
 * @returns {{ problems: string[], warnings: string[] }}
 */
function checkBundledLuts({ dir = BUNDLED_LUTS_DIR, release = false } = {}) {
  const problems = [];
  const warnings = [];
  const label = 'resources/luts-embutidas';
  // O que só impede o release vira erro no release e aviso no desenvolvimento
  const releaseOnly = (msg) => (release ? problems : warnings).push(msg);

  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) {
    problems.push(`Pasta ausente: ${label}`);
    return { problems, warnings };
  }
  let provenance = null;
  try { provenance = JSON.parse(fs.readFileSync(path.join(dir, 'PROCEDENCIA.json'), 'utf8')); } catch (_) {
    problems.push(`${label}/PROCEDENCIA.json ausente ou inválido.`);
    return { problems, warnings };
  }
  const listed = Array.isArray(provenance.arquivos) ? provenance.arquivos : [];
  const byName = new Map(listed.map((a) => [a && a.nome, a]));
  const excluded = new Set((Array.isArray(provenance.excluidas) ? provenance.excluidas : []).map((a) => a && a.nome));

  const cubes = names.filter((n) => n.toLowerCase().endsWith('.cube')).sort();
  for (const name of cubes) {
    const full = path.join(dir, name);
    if (excluded.has(name)) problems.push(`${label}/${name}: está na lista de LUTs excluídas (copyright) e não pode ir no pacote.`);
    const entry = byName.get(name);
    if (!entry) problems.push(`${label}/${name}: não consta em PROCEDENCIA.json.`);
    let data = null;
    try { data = fs.readFileSync(full); } catch (_) { problems.push(`${label}/${name}: não foi possível ler.`); continue; }
    if (COPYRIGHT_HEADER.test(data.subarray(0, 2048).toString('latin1'))) problems.push(`${label}/${name}: o cabeçalho traz aviso de copyright.`);
    if (entry && crypto.createHash('sha256').update(data).digest('hex') !== entry.sha256) problems.push(`${label}/${name}: o conteúdo não confere com o SHA-256 de PROCEDENCIA.json.`);
  }

  const present = new Set(cubes);
  const missing = listed.map((a) => a && a.nome).filter((n) => !present.has(n));
  if (missing.length === listed.length && listed.length > 0) {
    releaseOnly(`${label}: nenhuma das ${listed.length} LUTs embutidas está na pasta (as .cube não são versionadas): o instalador sairia sem LUTs.`);
  } else if (missing.length) {
    releaseOnly(`${label}: faltam ${missing.length} das ${listed.length} LUTs embutidas (ex.: ${missing[0]}).`);
  }

  const pending = listed.filter((a) => !a || a.status !== 'confirmada');
  for (const a of listed) {
    if (!a || !PROVENANCE_STATUSES.includes(a.status)) problems.push(`${label}/PROCEDENCIA.json: status inválido em "${a && a.nome}".`);
  }
  if (pending.length) {
    releaseOnly(`${label}: procedência/licença de ${pending.length} LUT(s) ainda "a-confirmar" em PROCEDENCIA.json (confirme com quem forneceu as LUTs antes de distribuir).`);
  } else if (provenance.release !== true) {
    problems.push(`${label}/PROCEDENCIA.json: todas confirmadas, mas "release" não está true.`);
  }
  if (pending.length && provenance.release === true) problems.push(`${label}/PROCEDENCIA.json: "release": true com LUTs ainda "a-confirmar".`);
  return { problems, warnings };
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

function main() {
  const release = process.argv.includes('--release') || process.env.BDS_RELEASE === '1';
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = (pkg.build && pkg.build.files) || [];
  const problems = [];
  const warnings = [];

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

  // As LUTs embutidas vão como recurso fora do asar (a pasta data/ continua fora do pacote)
  const extra = (pkg.build && pkg.build.extraResources) || [];
  if (!extra.some((r) => r && r.from === 'resources/luts-embutidas' && r.to === 'luts-embutidas')) {
    problems.push('"build.extraResources" precisa levar resources/luts-embutidas para luts-embutidas.');
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

  const luts = checkBundledLuts({ release });
  problems.push(...luts.problems);
  warnings.push(...luts.warnings);

  for (const w of warnings) console.warn(`verify-package-contents: AVISO - ${w}`);
  if (problems.length) {
    console.error(`\nverify-package-contents: o build foi BLOQUEADO${release ? ' (modo release)' : ''}.`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('verify-package-contents: OK (nenhum dado do usuário no pacote).');
}

if (require.main === module) main();

module.exports = { checkBundledLuts };
