'use strict';

/**
 * after-pack-check.js — hook "afterPack" do electron-builder: confere o app.asar já gerado.
 * Falha o build se dados do usuário (data/, settings.json, bancos .db), testes ou arquivos de design
 * entraram no pacote, ou se faltar algo que o app precisa. Sem rede.
 */

const fs = require('node:fs');
const path = require('node:path');

function resourcesDir(context) {
  const out = context.appOutDir;
  if (context.electronPlatformName === 'darwin') {
    const app = fs.readdirSync(out).find((n) => n.endsWith('.app'));
    return app ? path.join(out, app, 'Contents', 'Resources') : null;
  }
  return path.join(out, 'resources');
}

exports.default = async function afterPackCheck(context) {
  const res = resourcesDir(context);
  const asarPath = res && path.join(res, 'app.asar');
  if (!asarPath || !fs.existsSync(asarPath)) {
    throw new Error('after-pack-check: app.asar não encontrado — não dá para conferir o conteúdo do pacote.');
  }
  const asar = require('@electron/asar');
  const entries = asar.listPackage(asarPath).map((e) => e.replace(/\\/g, '/').replace(/^\//, ''));
  const has = (name) => entries.includes(name);
  const problems = [];

  for (const e of entries) {
    if (/^(data|database|config|tests|dist|logs)\//.test(e) && e !== 'logs/.gitkeep') problems.push(`pasta indevida no pacote: ${e}`);
    else if (/(^|\/)settings\.json$/i.test(e)) problems.push(`settings.json no pacote: ${e}`);
    else if (/\.db(\.bak|\.tmp)?$/i.test(e)) problems.push(`banco de dados no pacote: ${e}`);
    else if (/\.psd$/i.test(e)) problems.push(`arquivo de design no pacote: ${e}`);
  }
  for (const need of ['main.js', 'preload.js', 'package.json', 'node_modules/sql.js/dist/sql-wasm.js']) {
    if (!has(need)) problems.push(`faltando no pacote: ${need}`);
  }
  for (const dir of ['src', 'renderer']) {
    if (!entries.some((e) => e.startsWith(`${dir}/`))) problems.push(`pasta ausente no pacote: ${dir}/`);
  }
  if (!fs.existsSync(path.join(res, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'))) {
    problems.push('faltando fora do asar: node_modules/sql.js/dist/sql-wasm.wasm');
  }

  if (problems.length) {
    throw new Error(`after-pack-check: pacote inválido.\n  - ${problems.slice(0, 20).join('\n  - ')}`);
  }
  console.log(`  • after-pack-check: OK (${entries.length} entradas no app.asar)`);
};
