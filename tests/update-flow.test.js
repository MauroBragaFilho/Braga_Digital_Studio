'use strict';

// Fluxo de atualização: (1) um componente instalado cuja sondagem de versão falha não vira "não instalado"
// (era isso que mantinha o aviso de atualização para sempre); (2) em versão de desenvolvimento o app não se
// oferece para atualizar; (3) a nova versão é baixada e fica pronta, e a instalação fecha o BDS e abre o instalador.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { toolUpdater } = require('../src/infrastructure/external-tools/ToolUpdater');
const { DependencyManager } = require('../src/infrastructure/external-tools/DependencyManager');
const { appUpdateChecker } = require('../src/infrastructure/external-tools/AppUpdateChecker');
const UpdateService = require('../src/services/updateService');

function withPatched(obj, patches, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patches)) { saved[k] = obj[k]; obj[k] = v; }
  const restore = () => { for (const k of Object.keys(patches)) obj[k] = saved[k]; };
  return Promise.resolve().then(fn).finally(restore);
}

// ---------------------------------------------------------------- (1) verificação de componentes

test('check: binário presente com sondagem de versão falha continua "instalado" e usa a versão do manifesto', async () => {
  if (process.platform !== 'win32') return; // a fonte do spotdl é por plataforma; o teste usa o cenário do Windows
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-upd-'));
  fs.writeFileSync(path.join(dir, 'spotify-dlp.exe'), 'x');
  fs.mkdirSync(path.join(dir, '.component-manifests'));
  fs.writeFileSync(path.join(dir, '.component-manifests', 'spotdl.json'), JSON.stringify({ name: 'spotdl', version: 'v4.5.2' }));
  toolUpdater.init(dir);
  try {
    // Sondagem lenta/falha (null) e release remota igual à instalada
    const r = await withPatched(toolUpdater, {
      _getVersion: async () => null,
      _fetchLatestTag: async () => 'v4.5.2'
    }, () => toolUpdater.check('spotdl'));
    assert.equal(r.isInstalled, true);
    assert.equal(r.installed, 'v4.5.2', 'sem sondagem, mostra a versão do manifesto');
    assert.equal(r.needsUpdate, false);

    // O DependencyManager não pode tratar como "não instalado" (isso o punha na fila de Atualizar tudo)
    const dm = new DependencyManager();
    dm.init(dir);
    const statuses = await withPatched(toolUpdater, {
      _getVersion: async () => null,
      _fetchLatestTag: async () => 'v4.5.2',
      check: async (tool) => (tool === 'spotdl' ? r : { tool, isInstalled: true, installed: '1', latest: '1', needsUpdate: false })
    }, () => dm.getComponentsStatus());
    const spot = statuses.find((s) => s.canonicalTool === 'spotdl');
    assert.equal(spot.isInstalled, true);
    assert.equal(spot.needsUpdate, false);
    const summary = await withPatched(dm, { getComponentsStatus: async () => statuses }, () => dm.checkSystemUpdates());
    assert.equal(summary.hasUpdates, false, 'nada pendente: o aviso não pode aparecer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('check: versão nova de verdade continua sendo detectada', async () => {
  if (process.platform !== 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-upd-'));
  fs.writeFileSync(path.join(dir, 'spotify-dlp.exe'), 'x');
  toolUpdater.init(dir);
  try {
    const r = await withPatched(toolUpdater, {
      _getVersion: async () => '4.5.2',
      _fetchLatestTag: async () => 'v4.6.0'
    }, () => toolUpdater.check('spotdl'));
    assert.equal(r.isInstalled, true);
    assert.equal(r.needsUpdate, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- (2) e (3) atualização do app

function service({ packaged, appInfo }) {
  const s = Object.create(UpdateService.prototype);
  require('node:events').EventEmitter.call(s);
  s.paths = { tempDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bds-upd-')) };
  s.getSettings = () => ({});
  s.isPackaged = packaged;
  s._updating = false;
  s._downloadedInstallerPath = null;
  s._downloadedVersion = null;
  s._currentAppVersion = () => '1.0.5';
  s.updateAll = async () => ({ success: true, updatedCount: 0, errors: [] });
  s._appInfo = appInfo;
  return s;
}

test('versão de desenvolvimento: não consulta a release nem oferece instalar o app', async () => {
  const s = service({ packaged: false });
  let asked = false;
  const info = await withPatched(appUpdateChecker, { checkForUpdate: async () => { asked = true; return { hasUpdate: true }; } }, () => s.checkAppUpdate());
  assert.equal(asked, false);
  assert.deepEqual([info.hasUpdate, info.devBuild, info.currentVersion], [false, true, '1.0.5']);
  const r = await withPatched(appUpdateChecker, { checkForUpdate: async () => ({ hasUpdate: true }) }, () => s.updateEverything());
  assert.equal(r.appUpdate.devBuild, true);
  assert.equal(r.readyToInstall, false);
  fs.rmSync(s.paths.tempDir, { recursive: true, force: true });
});

test('app instalado: baixa e verifica, NÃO instala sozinho; instalar abre o instalador separado e fecha o BDS', async () => {
  if (process.platform !== 'win32') return;
  const s = service({ packaged: true });
  const appInfo = { hasUpdate: true, currentVersion: '1.0.5', latestVersion: '1.0.6', installerUrl: 'https://x/BragaDigitalStudioSetup.exe', installerDigest: 'sha256:abc' };
  let downloads = 0;
  let silentInstalls = 0;
  const launches = [];
  const patches = {
    checkForUpdate: async () => appInfo,
    downloadLatestInstaller: async (dest) => { downloads++; fs.writeFileSync(dest, Buffer.alloc(600000)); return { path: dest, size: 600000 }; },
    installSilently: async () => { silentInstalls++; return { success: true }; },
    launchInstallerDetached: (p, args) => { launches.push({ p, args }); return { launched: true }; }
  };
  await withPatched(appUpdateChecker, patches, async () => {
    const r1 = await s.updateEverything();
    assert.equal(r1.readyToInstall, true);
    assert.equal(r1.appUpdate.readyToInstall, true);
    assert.equal(r1.appUpdate.latestVersion, '1.0.6');
    assert.equal(r1.needsRestart, false);
    assert.equal(silentInstalls, 0, 'o instalador não roda com o BDS aberto');
    assert.ok(fs.existsSync(s._downloadedInstallerPath), 'instalador guardado para a instalação');

    // O usuário adiou e clicou de novo: não baixa outra vez
    const r2 = await s.updateEverything();
    assert.equal(r2.readyToInstall, true);
    assert.equal(downloads, 1);

    // Instalar: abre o instalador em processo próprio (com --force-run) e agenda o fechamento do app
    const inst = await s.installAppUpdate('C:\\qualquer\\coisa.exe');
    assert.equal(inst.success, true);
    assert.equal(launches.length, 1);
    assert.ok(launches[0].p.endsWith('.exe') && launches[0].p !== 'C:\\qualquer\\coisa.exe', 'ignora o caminho vindo do renderer');
    assert.equal(s._downloadedInstallerPath, null);

    const again = await s.installAppUpdate();
    assert.equal(again.success, false, 'sem instalador baixado não há o que abrir');
  });
  fs.rmSync(s.paths.tempDir, { recursive: true, force: true });
});

test('release SEM SHA-256: instalável, mas nunca anunciada como "verificada" (F-83), nem depois de adiar', async () => {
  if (process.platform !== 'win32') return;
  const s = service({ packaged: true });
  const messages = [];
  s.on('progress', (p) => messages.push(p.message));
  const appInfo = { hasUpdate: true, currentVersion: '1.0.5', latestVersion: '1.0.6', installerUrl: 'https://x/BragaDigitalStudioSetup.exe', installerDigest: null };
  const patches = {
    checkForUpdate: async () => appInfo,
    // sem digest: o download é aceito, mas o conferidor devolve verified:false
    downloadLatestInstaller: async (dest) => { fs.writeFileSync(dest, Buffer.alloc(600000)); return { path: dest, size: 600000, verified: false }; },
    launchInstallerDetached: () => ({ launched: true })
  };
  await withPatched(appUpdateChecker, patches, async () => {
    const r1 = await s.updateEverything();
    assert.equal(r1.appUpdate.readyToInstall, true);
    assert.equal(r1.appUpdate.digestVerified, false, 'o renderer precisa saber que não houve verificação');
    const ready = messages.filter((m) => /Pronta para instalar/.test(m)).pop();
    assert.match(ready, /sem verificação de integridade/);
    assert.doesNotMatch(ready, /baixada e verificada/);

    // O usuário adiou e voltou: o aviso continua valendo (não vira "verificada" por ter sido guardada)
    const r2 = await s.updateEverything();
    assert.equal(r2.appUpdate.readyToInstall, true);
    assert.equal(r2.appUpdate.digestVerified, false);
  });
  fs.rmSync(s.paths.tempDir, { recursive: true, force: true });
});

test('release COM SHA-256 conferido: aparece como "baixada e verificada" e o flag sobrevive ao adiamento', async () => {
  if (process.platform !== 'win32') return;
  const s = service({ packaged: true });
  const messages = [];
  s.on('progress', (p) => messages.push(p.message));
  const appInfo = { hasUpdate: true, currentVersion: '1.0.5', latestVersion: '1.0.6', installerUrl: 'https://x/BragaDigitalStudioSetup.exe', installerDigest: 'sha256:abc' };
  const patches = {
    checkForUpdate: async () => appInfo,
    downloadLatestInstaller: async (dest) => { fs.writeFileSync(dest, Buffer.alloc(600000)); return { path: dest, size: 600000, verified: true }; },
    launchInstallerDetached: () => ({ launched: true })
  };
  await withPatched(appUpdateChecker, patches, async () => {
    const r1 = await s.updateEverything();
    assert.equal(r1.appUpdate.digestVerified, true);
    assert.match(messages.filter((m) => /Pronta para instalar/.test(m)).pop(), /baixada e verificada/);
    const r2 = await s.updateEverything();
    assert.equal(r2.appUpdate.digestVerified, true);
    await s.installAppUpdate();
    assert.equal(s._downloadedDigestVerified, false, 'instalar zera o estado guardado');
  });
  fs.rmSync(s.paths.tempDir, { recursive: true, force: true });
});

test('launchInstallerDetached: recusa fora do Windows ou sem arquivo', () => {
  const r = appUpdateChecker.launchInstallerDetached(path.join(os.tmpdir(), 'nao-existe-bds.exe'));
  assert.equal(r.launched, false);
});
