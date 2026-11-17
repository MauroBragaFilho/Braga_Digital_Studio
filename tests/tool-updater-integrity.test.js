'use strict';

// ToolUpdater: SHA-256 vindo do arquivo de checksums oficial da release (P06), comparação com o
// Update Server para pacotes zip (P33), exiftool no ToolManifest (P34) e yt-dlp no fluxo comum (P41).
// Sem rede: o download é simulado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ToolUpdater } = require('../src/infrastructure/external-tools/ToolUpdater');
const { getExecutableName } = require('../src/infrastructure/external-tools/ToolManifest');

const HEX = 'a'.repeat(64);

function comSums(texto) {
  const u = new ToolUpdater();
  u._downloadFile = async (_url, dest) => { fs.writeFileSync(dest, texto); return { path: dest, size: texto.length, sha256: 'x' }; };
  return u;
}

test('P06: acha o SHA-256 no SHA2-256SUMS da release', async () => {
  const u = comSums(`${'b'.repeat(64)}  yt-dlp_linux\n${HEX}  yt-dlp.exe\n`);
  const release = { assets: [{ name: 'SHA2-256SUMS', browser_download_url: 'https://x/SHA2-256SUMS' }] };
  assert.equal(await u._findDigestInSumsFile(release, 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'), HEX);
});

test('P06: sem arquivo de checksums ou sem a linha do asset -> null (cai no NO_CHECKSUM)', async () => {
  const u = comSums(`${HEX}  outro.zip\n`);
  assert.equal(await u._findDigestInSumsFile({ assets: [] }, 'https://x/a.zip'), null);
  const release = { assets: [{ name: 'checksums.sha256', browser_download_url: 'https://x/checksums.sha256' }] };
  assert.equal(await u._findDigestInSumsFile(release, 'https://x/a.zip'), null);
});

test('P33: pacote zip do Update Server não fica sempre "pendente"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-tu-'));
  try {
    const u = new ToolUpdater();
    u.init(dir);
    const exe = path.join(u._toolsDir, getExecutableName('untrunc'));
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'binario');
    u._readManifest = () => ({ version: '1', packageSha256: HEX });
    const r = await u.checkAgainstManifest('untrunc', { version: '1', sha256: HEX.toUpperCase(), url: 'https://x/u.zip', isZip: true });
    assert.equal(r.needsUpdate, false);
    const r2 = await u.checkAgainstManifest('untrunc', { version: '2', sha256: 'c'.repeat(64), url: 'https://x/u.zip', isZip: true });
    assert.equal(r2.needsUpdate, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P34: exiftool tem nome de executável no ToolManifest', () => {
  assert.match(getExecutableName('exiftool'), /^exiftool(\.exe)?$/);
});

test('P41: o yt-dlp não usa mais o -U fora do pipeline', () => {
  assert.equal(typeof ToolUpdater.prototype._updateYtDlpSelf, 'undefined');
});
