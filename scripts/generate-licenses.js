'use strict';

/**
 * generate-licenses.js — gera a lista e os textos de licença dos componentes de terceiros (sem rede).
 *
 * Lê package.json + LICENSE/NOTICE de cada pacote de produção (dependencies e as transitivas) em node_modules e
 * escreve:
 *   src/config/third-party-licenses.json     lista (incluídos no aplicativo + baixados em tempo de execução)
 *   assets/licenses/THIRD_PARTY_LICENSES.txt  texto completo, com um bloco por componente
 *
 * Os componentes baixados em tempo de execução (não empacotados) são declarados em RUNTIME abaixo; as licenças
 * foram conferidas nos repositórios oficiais (campo "source").
 *
 * Uso: `npm run generate:licenses` (e `--check` para falhar se os arquivos estiverem desatualizados).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_JSON = path.join(ROOT, 'src', 'config', 'third-party-licenses.json');
const OUT_TXT = path.join(ROOT, 'assets', 'licenses', 'THIRD_PARTY_LICENSES.txt');
const LICENSE_FILE_RE = /^(licen[cs]e|notice|copying)(\.(md|txt))?$/i;

const { RUNTIME, BUNDLED_FONTS } = require('./licenses-runtime-data');

function readIf(file) { try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim(); } catch (_) { return ''; } }

function resolvePkg(name, from) {
  let dir = from;
  for (;;) {
    const p = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(p)) return path.dirname(p);
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function collectBundled() {
  const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const found = new Map();
  const walk = (name, from) => {
    const dir = resolvePkg(name, from);
    if (!dir) return;
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const key = `${pj.name}@${pj.version}`;
    if (found.has(key)) return;
    found.set(key, { dir, pj });
    for (const dep of Object.keys(pj.dependencies || {})) walk(dep, dir);
  };
  for (const dep of Object.keys(root.dependencies || {})) walk(dep, ROOT);

  const items = [];
  for (const { dir, pj } of found.values()) {
    const files = fs.readdirSync(dir).filter((f) => LICENSE_FILE_RE.test(f));
    const text = files.map((f) => readIf(path.join(dir, f))).filter(Boolean).join('\n\n');
    let url = typeof pj.homepage === 'string' ? pj.homepage : '';
    const repo = typeof pj.repository === 'string' ? pj.repository : (pj.repository && pj.repository.url) || '';
    if (!/^https:\/\//.test(url)) {
      url = repo.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '');
      if (/^github:/.test(repo)) url = `https://github.com/${repo.slice(7)}`;
      if (/^[\w.-]+\/[\w.-]+$/.test(repo)) url = `https://github.com/${repo}`;
    }
    if (!/^https:\/\//.test(url)) url = `https://www.npmjs.com/package/${pj.name}`;
    const license = typeof pj.license === 'string' ? pj.license : (pj.license && pj.license.type) || 'Desconhecida';
    items.push({ id: `npm-${pj.name}-${pj.version}`.replace(/[^\w.-]/g, '_'), name: pj.name, version: pj.version, license, url, text: text || `Licença ${license} (arquivo de licença não encontrado no pacote).` });
  }

  // Electron (inclui o Chromium e o Node.js)
  const ePath = path.join(ROOT, 'node_modules', 'electron');
  const ePj = JSON.parse(fs.readFileSync(path.join(ePath, 'package.json'), 'utf8'));
  items.push({
    id: 'electron', name: 'Electron (inclui Chromium e Node.js)', version: ePj.version, license: ePj.license || 'MIT', url: 'https://www.electronjs.org/',
    text: `${readIf(path.join(ePath, 'LICENSE'))}\n\nO Chromium e as bibliotecas que ele inclui têm licenças próprias, listadas no arquivo LICENSES.chromium.html que acompanha o aplicativo instalado (pasta do programa).`
  });
  // Fontes empacotadas em renderer/assets/fonts (texto da licença OFL copiado dos arquivos oficiais)
  for (const f of BUNDLED_FONTS) {
    items.push({ id: f.id, name: f.name, version: f.version, license: f.license, url: f.url, text: readIf(path.join(ROOT, f.licenseFile)) || `Licença ${f.license}.` });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function build() {
  const bundled = collectBundled();
  const runtime = RUNTIME.map((r) => ({ ...r, text: `${r.text}\n\nFonte consultada: ${r.source}` }));
  const list = {
    bundled: bundled.map(({ text, ...rest }) => rest),
    runtime: runtime.map(({ text, ...rest }) => rest)
  };
  const blocks = [...bundled, ...runtime].map((i) => `================================================================================\n${i.name} ${i.version}\nLicença: ${i.license}\nProjeto: ${i.url}\nID: ${i.id}\n================================================================================\n\n${i.text}\n`);
  const header = 'BRAGA DIGITAL STUDIO - COMPONENTES DE TERCEIROS E LICENCAS\n\nEste arquivo e gerado por scripts/generate-licenses.js. Nao edite manualmente.\n\n';
  return { json: `${JSON.stringify(list, null, 2)}\n`, txt: header + blocks.join('\n') };
}

function main() {
  const { json, txt } = build();
  if (process.argv.includes('--check')) {
    if (readIf(OUT_JSON) !== json.trim() || readIf(OUT_TXT) !== txt.replace(/\r\n/g, '\n').trim()) {
      console.error('Licenças desatualizadas: rode `npm run generate:licenses`.');
      process.exit(1);
    }
    console.log('Licenças em dia.');
    return;
  }
  fs.mkdirSync(path.dirname(OUT_TXT), { recursive: true });
  fs.writeFileSync(OUT_JSON, json);
  fs.writeFileSync(OUT_TXT, txt);
  console.log(`Gerado: ${path.relative(ROOT, OUT_JSON)} e ${path.relative(ROOT, OUT_TXT)}`);
}

if (require.main === module) main();
module.exports = { build };
