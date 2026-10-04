'use strict';

// AppUpdateChecker: seleção de asset por SO, conferência de digest e a política sem assinatura:
//   - digest presente  -> SEMPRE conferido (diferente = rejeita e apaga o arquivo; formato inválido = rejeita);
//   - digest ausente   -> INSTALA com verified:false (decisão do responsável enquanto não há Authenticode).
// Servidor HTTP local e arquivos temporários; nenhuma rede externa. Complementa a seleção por SO já
// testada em tool-sources-by-platform.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AppUpdateChecker } = require('../src/infrastructure/external-tools/AppUpdateChecker');

const payload = Buffer.from('instalador-falso-'.repeat(500));
const sha = (alg) => createHash(alg).update(payload).digest('hex');
let server;
let base;
let tmp;

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-appupd-'));
  server = http.createServer((req, res) => {
    if (req.url === '/setup.exe') { res.writeHead(200, { 'Content-Length': payload.length }); return res.end(payload); }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Executa fn simulando um sistema operacional (o download automático é só-Windows). */
async function comPlataforma(platform, fn) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', orig); }
}

const dest = (n) => path.join(tmp, n);

// ---- seleção de asset / versão ------------------------------------------------

test('_findInstallerUrl/_findInstallerDigest preferem BragaDigitalStudioSetup.exe e ignoram outros formatos', () => {
  const c = new AppUpdateChecker();
  const release = { assets: [
    { name: 'outro.exe', browser_download_url: 'https://x/outro.exe', digest: 'sha256:aa' },
    { name: 'BragaDigitalStudioSetup.deb', browser_download_url: 'https://x/d.deb', digest: 'sha256:bb' },
    { name: 'BragaDigitalStudioSetup.exe', browser_download_url: 'https://x/setup.exe', digest: 'sha256:cc' }
  ] };
  assert.equal(c._findInstallerUrl(release), 'https://x/setup.exe');
  assert.equal(c._findInstallerDigest(release), 'sha256:cc');
  assert.equal(c._findInstallerUrl({ assets: [{ name: 'a.deb', browser_download_url: 'u' }] }), null);
  assert.equal(c._findInstallerUrl({}), null);
  assert.equal(c._findInstallerDigest({ assets: [{ name: 'BragaDigitalStudioSetup.exe', browser_download_url: 'u' }] }), null);
});

test('_isNewer compara major.minor.patch numericamente', () => {
  const c = new AppUpdateChecker();
  assert.equal(c._isNewer('1.0.10', '1.0.9'), true);
  assert.equal(c._isNewer('1.0.2', '1.0.2'), false);
  assert.equal(c._isNewer('1.0', '1.0.1'), false);
  assert.equal(c._isNewer('2.0.0', '1.99.99'), true);
});

test('checkForUpdate: no Windows expõe installerUrl/digest; no Linux só o asset informativo', async () => {
  const release = {
    tag_name: 'v9.9.9', html_url: 'https://github.com/x/y/releases/tag/v9.9.9', body: 'notas',
    assets: [
      { name: 'BragaDigitalStudioSetup.exe', browser_download_url: 'https://x/e.exe', digest: 'sha256:aa' },
      { name: 'BragaDigitalStudioSetup.deb', browser_download_url: 'https://x/d.deb', digest: 'sha256:bb' }
    ]
  };
  const c = new AppUpdateChecker();
  c._getLatestRelease = async () => release;

  const win = await comPlataforma('win32', () => c.checkForUpdate('1.0.0'));
  assert.equal(win.hasUpdate, true);
  assert.equal(win.latestVersion, '9.9.9');
  assert.equal(win.installerUrl, 'https://x/e.exe');
  assert.equal(win.installerDigest, 'sha256:aa');
  assert.equal(win.platformAsset.kind, 'installer');

  const lin = await comPlataforma('linux', () => c.checkForUpdate('1.0.0'));
  assert.equal(lin.hasUpdate, true);
  assert.equal(lin.installerUrl, null, 'Linux nunca recebe URL de instalação automática');
  assert.equal(lin.installerDigest, null);
  assert.equal(lin.platformAsset.kind, 'manual');

  const same = await comPlataforma('win32', () => c.checkForUpdate('9.9.9'));
  assert.equal(same.hasUpdate, false);
});

test('checkForUpdate: falha de rede vira checkFailed (não "já está atualizado")', async () => {
  const c = new AppUpdateChecker();
  c._getLatestRelease = async () => { throw new Error('rate limit'); };
  const r = await c.checkForUpdate('1.0.0');
  assert.equal(r.hasUpdate, false);
  assert.equal(r.checkFailed, true);
  assert.match(r.error, /rate limit/);
});

// ---- download + digest --------------------------------------------------------

test('digest presente e correto (sha256) -> instala, verified:true', async () => {
  const c = new AppUpdateChecker();
  const d = dest('ok-256.exe');
  const r = await comPlataforma('win32', () => c.downloadLatestInstaller(d, null, `sha256:${sha('sha256')}`, `${base}/setup.exe`));
  assert.equal(r.verified, true);
  assert.equal(r.sha256, sha('sha256'));
  assert.ok(fs.readFileSync(d).equals(payload));
});

test('digest em maiúsculas e sha512 também são aceitos', async () => {
  const c = new AppUpdateChecker();
  const r1 = await comPlataforma('win32', () => c.downloadLatestInstaller(dest('up.exe'), null, `SHA256:${sha('sha256').toUpperCase()}`, `${base}/setup.exe`));
  assert.equal(r1.verified, true);
  const r2 = await comPlataforma('win32', () => c.downloadLatestInstaller(dest('512.exe'), null, `sha512:${sha('sha512')}`, `${base}/setup.exe`));
  assert.equal(r2.verified, true);
});

test('digest presente e DIFERENTE -> rejeita e remove o arquivo', async () => {
  const c = new AppUpdateChecker();
  const d = dest('ruim.exe');
  const errado = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(
    () => comPlataforma('win32', () => c.downloadLatestInstaller(d, null, errado, `${base}/setup.exe`)),
    /verificação de integridade do instalador falhou/
  );
  assert.equal(fs.existsSync(d), false, 'arquivo adulterado não pode ficar no disco');
});

test('digest com algoritmo fraco/formato inválido -> rejeita e remove o arquivo', async () => {
  const c = new AppUpdateChecker();
  for (const [i, ruim] of [`md5:${'a'.repeat(32)}`, `sha1:${'a'.repeat(40)}`, 'semdoispontos', 'sha256:xyz', ':abc'].entries()) {
    const d = dest(`invalido-${i}.exe`);
    await assert.rejects(
      () => comPlataforma('win32', () => c.downloadLatestInstaller(d, null, ruim, `${base}/setup.exe`)),
      /não é de um tipo compatível|não pôde ser verificada/,
      ruim
    );
    assert.equal(fs.existsSync(d), false);
  }
});

test('digest AUSENTE -> política atual: INSTALA com verified:false (arquivo mantido)', async () => {
  const c = new AppUpdateChecker();
  const d = dest('sem-digest.exe');
  const r = await comPlataforma('win32', () => c.downloadLatestInstaller(d, null, null, `${base}/setup.exe`));
  assert.equal(r.verified, false);
  assert.equal(r.sha256, sha('sha256'), 'o hash calculado continua disponível para o chamador');
  assert.ok(fs.readFileSync(d).equals(payload));
});

test('sem installerUrl, consulta a release uma única vez e usa URL + digest da MESMA release', async () => {
  const c = new AppUpdateChecker();
  let consultas = 0;
  c._getLatestRelease = async () => {
    consultas += 1;
    return { assets: [{ name: 'BragaDigitalStudioSetup.exe', browser_download_url: `${base}/setup.exe`, digest: `sha256:${sha('sha256')}` }] };
  };
  const r = await comPlataforma('win32', () => c.downloadLatestInstaller(dest('mesma.exe')));
  assert.equal(consultas, 1);
  assert.equal(r.verified, true);
});

test('release sem .exe -> erro claro; sistemas que não são Windows nunca baixam', async () => {
  const c = new AppUpdateChecker();
  c._getLatestRelease = async () => ({ assets: [{ name: 'so.deb', browser_download_url: 'https://x/so.deb' }] });
  await assert.rejects(() => comPlataforma('win32', () => c.downloadLatestInstaller(dest('x.exe'))), /Nenhum instalador/);
  await assert.rejects(() => comPlataforma('linux', () => c.downloadLatestInstaller(dest('y.exe'), null, null, `${base}/setup.exe`)), /só no Windows/);
  assert.equal(fs.existsSync(dest('y.exe')), false);
});

test('HTTP 404 no download -> rejeita sem deixar arquivo parcial', async () => {
  const c = new AppUpdateChecker();
  const d = dest('404.exe');
  await assert.rejects(() => comPlataforma('win32', () => c.downloadLatestInstaller(d, null, null, `${base}/nao-existe.exe`)));
  assert.equal(fs.existsSync(d), false);
  assert.equal(fs.existsSync(`${d}.part`), false);
});
