'use strict';
// Robustez de persistência e de entrada: bds.db (ausente/.bak/ordem de backups), migrações, históricos
// corrompidos, settings.json corrompido, LutSyncService (travessia), descoberta Sony (SSRF) e validação do DeviceManager.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-robust-'));
process.env.BMD_LOGS_DIR = path.join(tmpRoot, 'logs');

const DBManager = require('../src/core/database/database').constructor;
const HistoryService = require('../src/services/historyService');
const SettingsManager = require('../src/core/settings/SettingsManager');
const LutSyncService = require('../src/core/devices/LutSyncService');
const SonyCameraDiscovery = require('../src/infrastructure/network/sony/SonyCameraDiscovery');
const { cleanSegments, assertDestFolder } = require('../src/infrastructure/hardware/DeviceManager');
const { systemExe } = require('../src/infrastructure/hardware/systemExe');

test.after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

// ---------------- bds.db ----------------

test('init com bds.db ausente restaura do .bak em vez de criar banco vazio', async () => {
  const dir = path.join(tmpRoot, 'db-ausente');
  const m1 = new DBManager();
  await m1.init(dir);
  m1.db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'preservado\')');
  m1.persistSync();
  m1.persistSync(); // 2a gravação cria o .bak do arquivo válido
  m1.close();
  assert.ok(fs.existsSync(path.join(dir, 'bds.db.bak')), '.bak deveria existir');
  fs.unlinkSync(path.join(dir, 'bds.db')); // simula queda no meio da troca

  const m2 = new DBManager();
  await m2.init(dir);
  const r = m2.db.exec('SELECT v FROM t');
  assert.strictEqual(r[0].values[0][0], 'preservado');
  m2.close();
});

test('_listBackups ordena por data de modificação (não pelo nome)', async () => {
  const dir = path.join(tmpRoot, 'db-ordem');
  const m = new DBManager();
  await m.init(dir);
  fs.mkdirSync(m.backupDir, { recursive: true });
  const velho = path.join(m.backupDir, 'bds-zzz-velho.db');
  const novo = path.join(m.backupDir, 'bds-aaa-novo.db');
  fs.writeFileSync(velho, 'x');
  fs.writeFileSync(novo, 'x');
  const agora = Date.now() / 1000;
  fs.utimesSync(velho, agora - 1000, agora - 1000);
  fs.utimesSync(novo, agora, agora);
  assert.strictEqual(m._listBackups('bds-')[0], 'bds-aaa-novo.db');
  m.close();
});

test('falha ao trocar o arquivo não apaga o bds.db principal', async () => {
  const dir = path.join(tmpRoot, 'db-troca');
  const m = new DBManager();
  await m.init(dir);
  m.persistSync();
  const antes = fs.readFileSync(m.dbPath);
  const realRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
  let ok;
  try { ok = m.persistSync(); } finally { fs.renameSync = realRename; }
  assert.strictEqual(ok, false);
  assert.ok(fs.existsSync(m.dbPath), 'principal deve continuar existindo');
  assert.ok(fs.readFileSync(m.dbPath).equals(antes), 'principal intacto');
  m.close();
});

test('runMigrations devolve {ok, failedVersion}', async () => {
  const dbm = require('../src/core/database/database');
  const { runMigrations } = require('../src/core/database/migrations');
  await dbm.init(path.join(tmpRoot, 'db-mig'));
  const r = runMigrations();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.failedVersion, null);
  dbm.close();
});

// ---------------- históricos ----------------

test('historyService: downloads.db/conversions.db corrompidos vão para quarentena e o app abre', async () => {
  const dir = path.join(tmpRoot, 'hist');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'downloads.db'), 'isto nao e um banco sqlite, lixo lixo lixo lixo lixo');
  fs.writeFileSync(path.join(dir, 'conversions.db'), Buffer.alloc(300, 7));
  const h = await HistoryService.create(dir);
  h.addDownload({ titulo: 'a', url: 'u', tipo: 'mp4', pasta: 'p', status: 'ok' });
  h.flush();
  assert.strictEqual(h.listDownloads().length, 1);
  assert.deepStrictEqual(h.listConversions(), []);
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.startsWith('downloads.db.corrupt-')));
  assert.ok(files.some((f) => f.startsWith('conversions.db.corrupt-')));
  assert.ok(!files.some((f) => f.endsWith('.tmp')), 'sem .tmp sobrando');
  // reabre: dados gravados de forma atômica
  const h2 = await HistoryService.create(dir);
  assert.strictEqual(h2.listDownloads().length, 1);
});

test('historyService.flush grava pendências imediatamente', async () => {
  const dir = path.join(tmpRoot, 'hist-flush');
  const h = await HistoryService.create(dir);
  h.addConversion({ arquivoOrigem: 'a', arquivoSaida: 'b', formato: 'mp4', encoder: 'x', pasta: 'p', status: 'ok' });
  h.flush();
  const h2 = await HistoryService.create(dir);
  assert.strictEqual(h2.listConversions().length, 1);
});

// ---------------- settings ----------------

test('settings.json corrompido é preservado como .corrupt-<ts> antes de recriar', () => {
  const cfg = path.join(tmpRoot, 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'settings.json'), '{ quebrado');
  const sm = new SettingsManager(cfg, tmpRoot);
  const s = sm.load();
  assert.strictEqual(s.theme, 'dark');
  const files = fs.readdirSync(cfg);
  const corrupt = files.find((f) => f.startsWith('settings.json.corrupt-'));
  assert.ok(corrupt, 'cópia .corrupt deve existir');
  assert.strictEqual(fs.readFileSync(path.join(cfg, corrupt), 'utf8'), '{ quebrado');
  // nomes temporários únicos
  assert.notStrictEqual(sm._tmpName(), sm._tmpName());
});

// ---------------- LutSyncService ----------------

test('LutSyncService._safeDest rejeita travessia, absolutos e extensões fora de .cube/.3dl', () => {
  const luts = path.join(tmpRoot, 'luts');
  const svc = new LutSyncService(luts);
  assert.ok(svc._safeDest('a/b.cube').startsWith(luts));
  assert.ok(svc._safeDest('x.3DL').startsWith(luts));
  for (const bad of ['../x.cube', 'a/../../x.cube', '/etc/x.cube', 'C:/x.cube', 'a\\..\\..\\x.cube', 'x.exe', 'a//b.cube', '', null, 'a\0.cube']) {
    assert.throws(() => svc._safeDest(bad), undefined, `deveria rejeitar: ${JSON.stringify(bad)}`);
  }
});

// ---------------- Sony discovery ----------------

test('Sony: isPrivateIPv4 e LOCATION precisa ser do IP de quem respondeu', () => {
  const { isPrivateIPv4 } = SonyCameraDiscovery;
  assert.ok(isPrivateIPv4('192.168.122.1'));
  assert.ok(isPrivateIPv4('10.1.2.3'));
  assert.ok(isPrivateIPv4('172.16.0.9'));
  assert.ok(!isPrivateIPv4('8.8.8.8'));
  assert.ok(!isPrivateIPv4('172.32.0.1'));
  assert.ok(!isPrivateIPv4('abc'));

  const d = new SonyCameraDiscovery();
  const chamadas = [];
  d.fetchDeviceDescription = (url, ip) => chamadas.push([url, ip]);
  const resp = (loc) => `HTTP/1.1 200 OK\r\nST: urn:schemas-sony-com:service:ScalarWebAPI:1\r\nLOCATION: ${loc}\r\n\r\n`;
  d.handleSsdpResponse(resp('http://192.168.122.1:64321/dd.xml'), { address: '192.168.122.1' });
  d.handleSsdpResponse(resp('http://169.254.169.254/dd.xml'), { address: '192.168.122.1' }); // outro host
  d.handleSsdpResponse(resp('http://8.8.8.8/dd.xml'), { address: '8.8.8.8' });               // origem pública
  assert.deepStrictEqual(chamadas, [['http://192.168.122.1:64321/dd.xml', '192.168.122.1']]);
});

test('Sony: endpoint do XML em outro host é substituído pelo IP que respondeu; câmeras expiram', () => {
  const d = new SonyCameraDiscovery();
  const vistas = [];
  d.on('camera_discovered', (c) => vistas.push(c));
  const xml = '<friendlyName>A</friendlyName><av:X_ScalarWebAPI_ActionList_URL>http://10.9.9.9:8080/sony</av:X_ScalarWebAPI_ActionList_URL>';
  d.parseDeviceDescription(xml, 'http://192.168.122.1:64321/dd.xml', '192.168.122.1');
  assert.strictEqual(vistas.length, 1);
  assert.strictEqual(new URL(vistas[0].endpointURL).hostname, '192.168.122.1');

  const perdidas = [];
  d.on('camera_lost', (c) => perdidas.push(c));
  d.discoveredCameras.get(vistas[0].endpointURL).last_seen = Date.now() - 10 * 60 * 1000;
  d.expireStale();
  assert.strictEqual(perdidas.length, 1);
  assert.strictEqual(d.discoveredCameras.size, 0);
});

// ---------------- DeviceManager / systemExe ----------------

test('DeviceManager: cleanSegments e assertDestFolder', () => {
  assert.deepStrictEqual(cleanSegments(['DCIM', '', 'a.mp4']), ['DCIM', 'a.mp4']);
  assert.deepStrictEqual(cleanSegments(null), []);
  for (const bad of [['..'], ['a/b'], ['a\\b'], ['C:'], ['a\0']]) assert.throws(() => cleanSegments(bad));
  assert.throws(() => assertDestFolder('relativo/x'));
  assert.throws(() => assertDestFolder(path.parse(tmpRoot).root));
  assert.strictEqual(assertDestFolder(tmpRoot), path.resolve(tmpRoot));
});

test('systemExe resolve System32 no Windows e devolve o nome nos demais casos', () => {
  const r = systemExe('reg');
  if (process.platform === 'win32') assert.ok(/system32[\\/]reg\.exe$/i.test(r), r);
  else assert.strictEqual(r, 'reg');
  assert.strictEqual(systemExe('programa-que-nao-existe'), process.platform === 'win32' ? 'programa-que-nao-existe' : 'programa-que-nao-existe');
});
