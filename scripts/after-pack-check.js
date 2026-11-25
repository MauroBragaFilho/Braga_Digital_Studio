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

/**
 * Arquivos do Chromium dispensáveis neste app (redução do instalador, ~8 MB comprimidos):
 *  - dxcompiler.dll / dxil.dll: compilador de shaders do WebGPU (Dawn/DirectX 12). O app não usa WebGPU; WebGL, a
 *    aceleração de vídeo e o modo de software (SwiftShader) funcionam sem eles (testado com e sem a placa de vídeo;
 *    ver .docs/INSTALADOR.md). Se o Chromium precisar deles, ele cai para o compilador antigo (d3dcompiler_47.dll).
 * Ficam, de propósito, vk_swiftshader.dll/vulkan-1.dll (renderização por software em PCs sem placa de vídeo) e
 * LICENSES.chromium.html (aviso de licenças do Chromium). BDS_KEEP_CHROMIUM_FILES=1 desliga esta remoção.
 */
const REMOVABLE_CHROMIUM_FILES = ['dxcompiler.dll', 'dxil.dll'];

function trimChromiumFiles(appOutDir) {
  if (process.env.BDS_KEEP_CHROMIUM_FILES === '1') return;
  for (const name of REMOVABLE_CHROMIUM_FILES) {
    try { fs.rmSync(path.join(appOutDir, name), { force: true }); } catch (_) { /* já ausente */ }
  }
}

/** Nomes (ordenados) dos .cube de uma pasta; vazio se ela não existe. */
function listCubes(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.cube')).sort(); } catch (_) { return []; }
}

/**
 * As LUTs embutidas ficam fora do asar (extraResources → resources/luts-embutidas): o pacote final precisa ter
 * exatamente as .cube de resources/luts-embutidas do projeto. Sem nenhuma, o app instalado abriria sem LUTs
 * (clone limpo: as .cube só são versionadas depois de a procedência ser confirmada): aviso, e erro com BDS_RELEASE=1.
 * @returns {{ problems: string[], warnings: string[] }}
 */
function checkBundledLutsInPackage({ resourcesDir, sourceDir, release = false }) {
  const problems = [];
  const warnings = [];
  const packed = listCubes(path.join(resourcesDir, 'luts-embutidas'));
  const source = listCubes(sourceDir);
  if (packed.length !== source.length || packed.some((n, i) => n !== source[i])) {
    problems.push(`LUTs embutidas diferentes do projeto: ${packed.length} no pacote, ${source.length} em resources/luts-embutidas.`);
  }
  if (packed.length === 0) (release ? problems : warnings).push('o pacote não leva nenhuma LUT embutida (resources/luts-embutidas sem .cube).');
  return { problems, warnings };
}

exports.checkBundledLutsInPackage = checkBundledLutsInPackage;

exports.default = async function afterPackCheck(context) {
  // licença do instalador (a partir do LICENSE da raiz): ver scripts/installer-license.js
  if (context.electronPlatformName === 'win32') {
    require('./installer-license').writeInstallerLicense({ projectDir: context.packager.projectDir, buildResourcesDir: context.packager.buildResourcesDir });
    trimChromiumFiles(context.appOutDir);
  }
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
  // Integridade do próprio app.asar: cada arquivo do app (fora node_modules e package.json, que o empacotador
  // reescreve) precisa ser idêntico ao do projeto. Já vimos o empacotador gravar o conteúdo de um arquivo no lugar de
  // outro (leitura falha/instável do disco): sem esta conferência o app sairia quebrado ("SyntaxError" ao abrir).
  const projectDir = context.packager.projectDir;
  for (const e of entries) {
    if (e.startsWith('node_modules/') || e === 'package.json') continue;
    const source = path.join(projectDir, e);
    let isFile = false;
    try { isFile = fs.statSync(source).isFile(); } catch (_) { /* arquivo gerado no build: ignora */ }
    if (!isFile) continue;
    let packed;
    try { packed = asar.extractFile(asarPath, e.split('/').join(path.sep)); } catch (_) { packed = null; }
    if (!packed || !packed.equals(fs.readFileSync(source))) problems.push(`conteúdo do app.asar diferente do original: ${e} (refaça o build)`);
  }
  if (!fs.existsSync(path.join(res, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'))) {
    problems.push('faltando fora do asar: node_modules/sql.js/dist/sql-wasm.wasm');
  }

  const luts = checkBundledLutsInPackage({
    resourcesDir: res,
    sourceDir: path.join(projectDir, 'resources', 'luts-embutidas'),
    release: process.env.BDS_RELEASE === '1'
  });
  problems.push(...luts.problems);
  for (const w of luts.warnings) console.warn(`  • after-pack-check: AVISO - ${w}`);

  if (problems.length) {
    throw new Error(`after-pack-check: pacote inválido.\n  - ${problems.slice(0, 20).join('\n  - ')}`);
  }
  console.log(`  • after-pack-check: OK (${entries.length} entradas no app.asar)`);
};
