'use strict';

/**
 * build-manifest.js
 *
 * Varre a pasta `components/<nome>/<versao>/<arquivo>` e gera `manifest.json` com o
 * checksum SHA-256 de cada pacote, pronto para ser publicado pelo server.js.
 *
 * Estrutura esperada:
 *   components/
 *   ├── ffmpeg/
 *   │   └── 7.1.0/
 *   │       ├── win32.zip
 *   │       └── linux.tar.xz
 *   ├── rawrecoveryengine/
 *   │   └── 1.0.0/
 *   │       └── win32.exe
 *   └── untrunc/
 *       └── 2024.1/
 *           └── win32.zip
 *
 * O nome do arquivo dentro da pasta de versão DEVE começar com a plataforma-alvo:
 * win32, linux ou darwin (ex: win32.exe, win32.zip, linux.tar.xz).
 *
 * Uso:
 *   node build-manifest.js [--base-url https://updates.suaempresa.com] [--bds-version 1.0.3]
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COMPONENTS_DIR = path.join(__dirname, 'components');
const OUTPUT_PATH = path.join(__dirname, 'manifest.json');

const PLATFORMS = ['win32', 'linux', 'darwin'];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { baseUrl: process.env.BDS_UPDATE_BASE_URL || 'http://localhost:8787', bdsVersion: '1.0.0' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base-url') out.baseUrl = args[++i];
    if (args[i] === '--bds-version') out.bdsVersion = args[++i];
  }
  out.baseUrl = out.baseUrl.replace(/\/+$/, '');
  return out;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function sortVersions(versions) {
  // Ordenação simples semver-like (funciona para "1.0.0", "2024.1", "v1.2.3" etc.)
  return versions.sort((a, b) => {
    const na = a.replace(/^v/, '').split(/[.\-]/).map(Number);
    const nb = b.replace(/^v/, '').split(/[.\-]/).map(Number);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
      const diff = (na[i] || 0) - (nb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

function build() {
  const { baseUrl, bdsVersion } = parseArgs();

  if (!fs.existsSync(COMPONENTS_DIR)) {
    console.error(`Pasta de componentes não encontrada: ${COMPONENTS_DIR}`);
    console.error('Crie components/<nome>/<versao>/<plataforma>.<ext> antes de rodar este script.');
    process.exit(1);
  }

  const manifest = {
    bdsVersion,
    generatedAt: new Date().toISOString(),
    components: {},
  };

  const componentNames = fs.readdirSync(COMPONENTS_DIR).filter(n =>
    fs.statSync(path.join(COMPONENTS_DIR, n)).isDirectory()
  );

  for (const name of componentNames) {
    const compDir = path.join(COMPONENTS_DIR, name);
    const versions = fs.readdirSync(compDir).filter(v =>
      fs.statSync(path.join(compDir, v)).isDirectory()
    );

    if (versions.length === 0) continue;

    const [latestVersion] = sortVersions(versions).slice(-1);
    const versionDir = path.join(compDir, latestVersion);
    const files = fs.readdirSync(versionDir);

    const platformEntries = {};
    for (const file of files) {
      const platform = PLATFORMS.find(p => file.toLowerCase().startsWith(p));
      if (!platform) {
        console.warn(`Aviso: ${name}/${latestVersion}/${file} não começa com uma plataforma reconhecida (${PLATFORMS.join(', ')}) — ignorado.`);
        continue;
      }
      const filePath = path.join(versionDir, file);
      const sha256 = sha256File(filePath);
      const isZip = file.toLowerCase().endsWith('.zip');

      platformEntries[platform] = {
        url: `${baseUrl}/components/${encodeURIComponent(name)}/${encodeURIComponent(latestVersion)}/${encodeURIComponent(file)}`,
        sha256,
        isZip,
        sizeBytes: fs.statSync(filePath).size,
      };
    }

    if (Object.keys(platformEntries).length === 0) continue;

    manifest.components[name] = {
      version: latestVersion,
      platform: platformEntries,
    };

    console.log(`✓ ${name} @ ${latestVersion} — plataformas: ${Object.keys(platformEntries).join(', ')}`);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\nmanifest.json gerado com ${Object.keys(manifest.components).length} componente(s): ${OUTPUT_PATH}`);
}

build();
