'use strict';

// Dispositivos (processo principal): detecção de cartão/pen drive/câmera/celular ao conectar.
//   - DeviceManager: a lista só é refeita quando o hardware muda (assinatura) ou vence; falha não vira "lista vazia" em cache;
//     celular bloqueado é reconsultado logo; durante uma cópia MTP nada é varrido.
//   - Provedores Windows: leitor de cartão vazio e servidor de mídia da rede NÃO são dispositivos.
//   - Descoberta de celulares: re-pergunta mDNS, sonda de novo serviços já vistos, adb sem espera longa, "atualizar" na ordem certa.
//   - Resposta do canal devices:get-all: { devices, issues }.

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const { DeviceManager } = require('../src/infrastructure/hardware/DeviceManager');
const { parseDrives, DRIVES_SCRIPT } = require('../src/infrastructure/hardware/windows/WindowsStorageProvider');
const { parseMtpDevices, isNetworkMediaServer, DEVICES_SCRIPT } = require('../src/infrastructure/hardware/windows/WindowsMtpProvider');
const { signatureFromOutputs, CLASSES } = require('../src/infrastructure/hardware/windows/hardwareSignature');

/** Provedor falso: devolve `result` (ou rejeita com `fail`) e conta as chamadas. */
function fakeProvider(result = []) {
  const p = new EventEmitter();
  p.calls = 0;
  p.result = result;
  p.fail = null;
  p.getDevices = async () => {
    p.calls++;
    if (p.fail) throw new Error(p.fail);
    return p.result;
  };
  return p;
}

function setup({ signature = 'A', withSignature = true } = {}) {
  const clock = { t: 1_000_000 };
  const state = { sig: signature, reads: 0 };
  const mtp = fakeProvider();
  const usb = fakeProvider();
  const dm = new DeviceManager({
    now: () => clock.t,
    readSignature: withSignature ? async () => { state.reads++; return state.sig; } : async () => null,
    providers: { mtp, storage: usb }
  });
  return { dm, clock, state, mtp, usb };
}

const card = (letter = 'E:', name = 'SD_CARD') => ({ id: letter, name, type: 'usb', storage: [{ name: 'Mass Storage', path: `${letter}\\`, capacity: 64e9, free: 10e9 }] });
const phone = (storages = [{ Name: 'Armazenamento interno' }]) => ({ Name: 'Galaxy A51', Type: 'Telefone', Storages: storages });

// ─── DeviceManager ───────────────────────────────────────────────────────────

test('a lista é refeita assim que o hardware muda, e não antes', async () => {
  const { dm, clock, state, usb } = setup();
  usb.result = [];
  assert.deepEqual((await dm.scan()).usb, []);
  assert.equal(usb.calls, 1);

  clock.t += 3000; // nada mudou: cache (nem o tempo de segurança de 20 s venceu)
  assert.deepEqual((await dm.scan()).usb, []);
  assert.equal(usb.calls, 1);

  usb.result = [card()];
  state.sig = 'B'; // pen drive plugado
  clock.t += 3000;
  const after = await dm.scan();
  assert.equal(usb.calls, 2, 'refez a enumeração por causa da assinatura');
  assert.equal(after.usb.length, 1);
  assert.equal(after.usb[0].name, 'SD_CARD');
});

test('sem assinatura (sistema sem pnputil), o cache é curto: 8 s', async () => {
  const { dm, clock, usb } = setup({ withSignature: false });
  await dm.scan();
  clock.t += 5000;
  await dm.scan();
  assert.equal(usb.calls, 1, 'dentro de 8 s: cache');
  clock.t += 4000; // 9 s no total
  await dm.scan();
  assert.equal(usb.calls, 2);
});

test('com assinatura em dia, o tempo de segurança é 20 s (rede de proteção)', async () => {
  const { dm, clock, usb } = setup();
  await dm.scan();
  clock.t += 19000;
  await dm.scan();
  assert.equal(usb.calls, 1);
  clock.t += 2000;
  await dm.scan();
  assert.equal(usb.calls, 2);
});

test('a assinatura é lida no máximo uma vez por 1,5 s, não importa quantos perguntem', async () => {
  const { dm, clock, state } = setup();
  await Promise.all([dm.scan(), dm.scan(), dm.getStorageDevices(), dm.getMtpDevices()]);
  assert.equal(state.reads, 1, 'chamadas simultâneas compartilham a leitura');
  clock.t += 500;
  await dm.scan();
  assert.equal(state.reads, 1, 'dentro de 1,5 s não lê de novo');
  clock.t += 1500;
  await dm.scan();
  assert.equal(state.reads, 2);
});

test('falha na enumeração NÃO vira lista vazia em cache: avisa e tenta de novo na vez seguinte', async () => {
  const { dm, usb } = setup();
  usb.fail = 'A consulta às unidades demorou demais.';
  const first = await dm.scan();
  assert.deepEqual(first.usb, []);
  assert.deepEqual(first.issues, [{ source: 'usb', message: 'A consulta às unidades demorou demais.' }]);

  usb.fail = null;
  usb.result = [card()];
  const second = await dm.scan(); // logo em seguida, sem esperar TTL
  assert.equal(second.usb.length, 1, 'não ficou preso no vazio');
  assert.deepEqual(second.issues, []);
  assert.equal(usb.calls, 2);
});

test('falhou depois de uma lista boa e o hardware NÃO mudou: o aparelho não some da tela, mas há aviso', async () => {
  const { dm, clock, usb } = setup();
  usb.result = [card()];
  await dm.scan();
  clock.t += 25000; // vencido
  usb.fail = 'demorou';
  const r = await dm.scan();
  assert.equal(r.usb.length, 1, 'mantém a última lista boa');
  assert.equal(r.issues.length, 1);
});

test('falhou e o hardware MUDOU: não mostra uma lista que já não vale', async () => {
  const { dm, clock, state, usb } = setup();
  usb.result = [card()];
  await dm.scan();
  state.sig = 'B'; // cartão retirado
  clock.t += 3000;
  usb.fail = 'demorou';
  const r = await dm.scan();
  assert.deepEqual(r.usb, [], 'sem lista boa para mostrar');
  assert.equal(r.issues.length, 1);
});

test('uma fonte falhando não derruba a outra', async () => {
  const { dm, mtp, usb } = setup();
  mtp.fail = 'sem resposta';
  usb.result = [card()];
  const r = await dm.scan();
  assert.equal(r.usb.length, 1);
  assert.deepEqual(r.mtp, []);
  assert.deepEqual(r.issues.map((i) => i.source), ['mtp']);
});

test('celular bloqueado (sem armazenamento) é reconsultado em 4 s, e depois volta ao tempo normal', async () => {
  const { dm, clock, mtp } = setup();
  mtp.result = [phone([])];
  await dm.scan();
  clock.t += 3000;
  await dm.scan();
  assert.equal(mtp.calls, 1);
  clock.t += 1500; // 4,5 s
  mtp.result = [phone()]; // o usuário liberou o acesso no aparelho
  const r = await dm.scan();
  assert.equal(mtp.calls, 2);
  assert.equal(r.mtp[0].Storages.length, 1);
  clock.t += 6000;
  await dm.scan();
  assert.equal(mtp.calls, 2, 'com armazenamento, vale o tempo normal');
});

test('durante uma cópia/navegação MTP nenhuma enumeração é feita (serve a última lista)', async () => {
  const { dm, clock, mtp, usb } = setup();
  mtp.result = [phone()];
  await dm.scan();
  clock.t += 60000; // tudo vencido
  let during;
  await dm.track(async () => { during = await dm.scan({ force: true }); });
  assert.equal(mtp.calls, 1);
  assert.equal(usb.calls, 1);
  assert.equal(during.mtp.length, 1, 'continua mostrando o aparelho');
  await dm.scan();
  assert.equal(mtp.calls, 2, 'terminou a cópia: volta a conferir');
});

test('"atualizar" (force) ignora o cache', async () => {
  const { dm, usb } = setup();
  await dm.scan();
  await dm.scan({ force: true });
  assert.equal(usb.calls, 2);
});

test('getStorageDevices / getMtpDevices nunca rejeitam (barra lateral e verificações de unidade)', async () => {
  const { dm, mtp, usb } = setup();
  mtp.fail = 'x';
  usb.fail = 'y';
  assert.deepEqual(await dm.getMtpDevices(), []);
  assert.deepEqual(await dm.getStorageDevices(), []);
});

// ─── Provedores Windows (interpretação da saída) ──────────────────────────────

test('leitor de cartão vazio, volume virtual da câmera e letras repetidas não viram dispositivo', () => {
  const rows = [
    { id: 'E:', name: null, size: null, free: null },                 // leitor sem cartão
    { id: 'F:', name: 'EOS_DIGITAL', size: 64e9, free: 20e9 },         // cartão da câmera
    { id: 'G:', name: null, size: 32e9, free: 1e9 },                   // pen drive sem nome
    { id: 'H:', name: 'PMHOME', size: 1e6, free: 0 },                  // volume virtual
    { id: 'F:', name: 'EOS_DIGITAL', size: 64e9, free: 20e9 },         // duplicado (duas partições listadas)
    { id: 'Z', name: 'sem dois pontos', size: 1e9, free: 0 }           // não é letra de unidade
  ];
  const out = parseDrives(JSON.stringify(rows));
  assert.deepEqual(out.map((d) => d.id), ['F:', 'G:']);
  assert.equal(out[0].name, 'EOS_DIGITAL');
  assert.equal(out[1].name, 'Unidade USB (G:)');
  assert.deepEqual(out[0].storage[0], { name: 'Mass Storage', path: 'F:\\', capacity: 64e9, free: 20e9 });
  assert.equal(out[0].type, 'usb');
});

test('parseDrives: objeto único (PowerShell desembrulha), vazio e JSON inválido', () => {
  assert.equal(parseDrives(JSON.stringify({ id: 'E:', name: 'X', size: 8e9, free: 1e9 })).length, 1);
  assert.deepEqual(parseDrives('  \r\n'), []);
  assert.deepEqual(parseDrives('[]'), []);
  assert.throws(() => parseDrives('{quebrado'));
});

test('a consulta de unidades não pergunta o tamanho de cada letra (leitor vazio leva 2 s ou mais para responder)', () => {
  assert.doesNotMatch(DRIVES_SCRIPT, /Win32_LogicalDisk\b(?!ToPartition)/, 'só chega às letras pelos discos físicos');
  assert.match(DRIVES_SCRIPT, /Win32_DiskDrive/);
  assert.match(DRIVES_SCRIPT, /Win32_LogicalDiskToPartition/);
});

test('servidor de mídia da rede (UPnP/DLNA) não é câmera nem celular', () => {
  assert.ok(isNetworkMediaServer({ Name: 'PC-SALA', Type: 'Media Server', Path: '::{20D04FE0}\\uuid:20768dd0' }));
  assert.ok(isNetworkMediaServer({ Name: 'PC-SALA', Type: 'Servidor de mídia' }));
  assert.ok(isNetworkMediaServer({ Name: 'PC-SALA', Type: 'X', Path: '::{20D04FE0}\\uuid:abc' }));
  assert.ok(!isNetworkMediaServer({ Name: 'Galaxy A51', Type: 'Telefone', Path: '::{20D04FE0}\\\\?\\usb#vid_04e8' }));
  assert.match(DEVICES_SCRIPT, /uuid:/, 'o script também pula o servidor antes de abrir a pasta dele');
});

test('parseMtpDevices: filtra servidor de mídia, aceita objeto único e normaliza os armazenamentos', () => {
  const raw = JSON.stringify([
    { Name: 'PC-SALA', Type: 'Media Server', Path: '::{x}\\uuid:1', Storages: [] },
    { Name: 'Galaxy A51', Type: 'Telefone', Path: '::{x}\\\\?\\usb#vid_04e8', Storages: { Name: 'Armazenamento interno', TotalSize: null, FreeSpace: null } },
    { Name: 'Sony A7', Type: 'Câmera', Path: '::{x}\\\\?\\usb#vid_054c' }
  ]);
  const out = parseMtpDevices(raw);
  assert.deepEqual(out.map((d) => d.Name), ['Galaxy A51', 'Sony A7']);
  assert.equal(out[0].Storages.length, 1, 'objeto único vira lista');
  assert.deepEqual(out[1].Storages, [], 'sem armazenamento: lista vazia (celular bloqueado)');
  assert.equal(parseMtpDevices(JSON.stringify({ Name: 'Só um', Type: 'Telefone', Storages: [] })).length, 1);
  assert.deepEqual(parseMtpDevices(''), []);
});

// ─── Assinatura do hardware ───────────────────────────────────────────────────

test('assinatura: igual para a mesma lista (em qualquer ordem), diferente se entrou ou saiu algo', () => {
  const pnp = 'Instance ID:  USB\\VID_1&PID_2\\x\nClass Name: USB\n';
  const mounts = '\\\\?\\Volume{aaa}\\\n    E:\\\n';
  const a = pnp + mounts;
  const b = mounts + pnp;
  const penDriveNovo = `${a}Instance ID:  USB\\VID_9&PID_9\\y\n`;
  const cartaoNoMesmoLeitor = a.replace('Volume{aaa}', 'Volume{bbb}'); // mesma letra E:, outro volume (a mídia trocou)
  assert.equal(signatureFromOutputs(a), signatureFromOutputs(b));
  assert.notEqual(signatureFromOutputs(a), signatureFromOutputs(penDriveNovo), 'aparelho novo');
  assert.notEqual(signatureFromOutputs(a), signatureFromOutputs(cartaoNoMesmoLeitor), 'cartão inserido num leitor que já estava ligado');
  assert.equal(signatureFromOutputs('nada reconhecível aqui'), null);
  assert.equal(signatureFromOutputs(''), null);
});

test('assinatura: pnputil só com classe (sem /class leva mais de 10 s) e mountvol para volumes e letras', () => {
  assert.deepEqual([...CLASSES].sort(), ['USB', 'WPD']);
  const src = require('node:fs').readFileSync(require.resolve('../src/infrastructure/hardware/windows/hardwareSignature.js'), 'utf8');
  assert.match(src, /\/enum-devices \/connected \/class \$\{cls\}/);
  assert.match(src, /systemExe\('mountvol'\)/);
});

// ─── Descoberta de celulares (BDS Mobile) ─────────────────────────────────────

const discovery = require('../src/core/devices/DeviceDiscoveryService');

function resetDiscovery() {
  discovery.devices.clear();
  discovery._mdns = [];
  discovery._mdnsKey = '';
  discovery._started = false;
  discovery._isPolling = false;
  discovery._adbRunning = false;
  discovery._adbFailures = 0;
  discovery._adbNextAt = 0;
  discovery._adbPath = undefined;
  discovery._adbResolving = null;
  discovery._lastAdbForwardDevice = null;
  discovery._mdnsSettleMs = 0;
}

test('cada volta da busca refaz a pergunta mDNS, sonda os serviços já vistos e não repete endereços', async (t) => {
  resetDiscovery();
  t.after(resetDiscovery);
  const probed = [];
  const originalProbe = discovery.probeDevice;
  discovery.probeDevice = async (ip, port, connection) => { probed.push(`${ip}:${port}:${connection}`); };
  t.after(() => { discovery.probeDevice = originalProbe; });
  discovery._adbNextAt = Infinity; // sem adb nesta volta

  let updates = 0; let expires = 0;
  discovery._started = true;
  discovery._mdnsKey = discovery.lanAddresses().join(','); // mesmas redes de agora: não refaz as buscas
  discovery._mdns = [{
    ip: null,
    browser: {
      update() { updates++; },
      expire() { expires++; },
      services: [
        { addresses: ['192.168.0.20'], port: 8081, name: 'Celular A' },       // anunciado e ainda não conhecido
        { addresses: ['192.168.0.30'], port: 8080, name: 'Celular B' },       // anunciado e já conhecido (duplicata)
        { addresses: [], name: 'sem endereço' }
      ]
    }
  }];
  discovery.devices.set('B_wifi', { id: 'B_wifi', connection: 'wifi', ip: '192.168.0.30', port: 8080, last_seen: Date.now() });

  await discovery.pollAllDevices();

  assert.equal(updates, 1, 'perguntou de novo na rede');
  assert.equal(expires, 1, 'esqueceu anúncios vencidos');
  assert.deepEqual(probed.sort(), ['127.0.0.1:8080:usb', '192.168.0.20:8081:wifi', '192.168.0.30:8080:wifi']);
});

test('celular que saiu da lista por inatividade e voltou é sondado de novo (o Bonjour não repete o aviso)', async (t) => {
  resetDiscovery();
  t.after(resetDiscovery);
  const probed = [];
  const originalProbe = discovery.probeDevice;
  discovery.probeDevice = async (ip, port, connection) => { probed.push(`${ip}:${port}:${connection}`); };
  t.after(() => { discovery.probeDevice = originalProbe; });
  discovery._adbNextAt = Infinity;
  discovery._started = true;
  discovery._mdnsKey = discovery.lanAddresses().join(',');
  discovery._mdns = [{ ip: null, browser: { update() {}, expire() {}, services: [{ addresses: ['192.168.0.40'], port: 8080 }] } }];

  assert.equal(discovery.devices.size, 0, 'não está na lista de conhecidos (removido por inatividade)');
  await discovery.pollAllDevices();
  assert.ok(probed.includes('192.168.0.40:8080:wifi'));
});

test('"atualizar": o forward do adb é feito ANTES da sondagem USB', async (t) => {
  resetDiscovery();
  t.after(resetDiscovery);
  const order = [];
  const keep = { startMdns: discovery.startMdns, setupAdbForward: discovery.setupAdbForward, pollAllDevices: discovery.pollAllDevices };
  discovery.startMdns = () => { order.push('mdns'); };
  discovery.setupAdbForward = async () => { order.push('adb'); };
  discovery.pollAllDevices = async () => { order.push('poll'); };
  t.after(() => Object.assign(discovery, keep));

  discovery._adbNextAt = 123456;
  discovery._adbFailures = 7;
  discovery._lastAdbForwardDevice = 'ABC123';
  await discovery.forceRescan();

  assert.deepEqual(order, ['mdns', 'adb', 'poll']);
  assert.equal(discovery._adbNextAt, 0, 'ignora a espera');
  assert.equal(discovery._adbFailures, 0);
  assert.equal(discovery._lastAdbForwardDevice, null, 'refaz o forward');
});

test('sem celular no cabo, o adb é consultado de novo em 4 s, 8 s e depois 15 s (antes eram 30 s, 60 s e 5 min)', async (t) => {
  resetDiscovery();
  t.after(resetDiscovery);
  delete process.env.BDS_TEST_BDSM_PORT;
  discovery._adbPath = process.execPath; // "adb" que não lista aparelho nenhum: o node falha rápido com um script inexistente
  const delays = [];
  for (let i = 0; i < 4; i++) {
    discovery._adbNextAt = 0;
    const before = Date.now();
    await discovery.setupAdbForward();
    delays.push(Math.round((discovery._adbNextAt - before) / 1000));
  }
  // atraso medido com folga de alguns segundos pelo tempo que cada chamada leva
  assert.ok(delays[0] >= 4 && delays[0] <= 6, `1ª falha: ${delays[0]} s`);
  assert.ok(delays[1] >= 8 && delays[1] <= 10, `2ª falha: ${delays[1]} s`);
  assert.ok(delays[2] >= 15 && delays[2] <= 17, `3ª falha: ${delays[2]} s`);
  assert.ok(delays[3] >= 15 && delays[3] <= 17, `4ª falha: ${delays[3]} s (estabiliza em 15 s)`);
});

// ─── mDNS por rede local (VPN no computador não pode esconder o celular do Wi-Fi) ──────────────────

/** Troca os adaptadores de rede vistos pelo Node durante o teste. */
function fakeNetwork(t, adapters) {
  const os = require('node:os');
  const original = os.networkInterfaces;
  os.networkInterfaces = () => adapters;
  t.after(() => { os.networkInterfaces = original; });
}

const v4 = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, ...extra });

test('só redes locais entram: VPN (Radmin, Tailscale), loopback, link-local e IPv6 ficam de fora', (t) => {
  fakeNetwork(t, {
    'Radmin VPN': [v4('26.177.83.160')],
    Tailscale: [v4('100.126.122.60')],
    'Wi-Fi': [v4('192.168.15.6'), { address: 'fe80::1', family: 'IPv6', internal: false }],
    Ethernet: [v4('10.0.0.5')],
    Hotspot: [v4('172.20.10.2')],
    'Rede virtual': [v4('172.40.0.1'), v4('169.254.3.4')],
    Loopback: [v4('127.0.0.1', { internal: true })]
  });
  assert.deepEqual(discovery.lanAddresses(), ['10.0.0.5', '172.20.10.2', '192.168.15.6']);
  assert.ok(discovery.isLanAddress('172.16.0.1') && discovery.isLanAddress('172.31.255.1'));
  assert.ok(!discovery.isLanAddress('172.32.0.1') && !discovery.isLanAddress('100.64.0.1') && !discovery.isLanAddress('8.8.8.8'));
});

test('o mesmo utilitário de redes locais serve ao mDNS dos celulares e ao SSDP das câmeras Sony', () => {
  const shared = require('../src/infrastructure/network/lanAddresses');
  assert.equal(discovery.lanAddresses, shared.lanAddresses);
  assert.equal(discovery.isLanAddress, shared.isLanAddress);
  assert.ok(!shared.isLanAddress('192.168.1.256') && !shared.isLanAddress('not an ip') && !shared.isLanAddress(''));
});

test('câmera Sony: o M-SEARCH sai por cada rede local (a "padrão" do Windows pode ser a VPN)', (t) => {
  fakeNetwork(t, { 'Radmin VPN': [v4('26.177.83.160')], 'Wi-Fi da câmera': [v4('192.168.122.2')], Ethernet: [v4('10.0.0.5')] });
  const SonyCameraDiscovery = require('../src/infrastructure/network/sony/SonyCameraDiscovery');
  const d = new SonyCameraDiscovery();
  const calls = [];
  d.socket = {
    setMulticastInterface(ip) { if (ip === '10.0.0.5') throw new Error('EINVAL'); calls.push(['interface', ip]); },
    send(msg, offset, length, port, address, cb) { calls.push(['send', port, address, /M-SEARCH \*/.test(String(msg)), /ScalarWebAPI/.test(String(msg))]); cb(null); }
  };
  d.sendMSearch();
  // a interface que falha não impede as outras; a VPN nunca é usada
  assert.deepEqual(calls, [['interface', '192.168.122.2'], ['send', 1900, '239.255.255.250', true, true]]);

  // sem nenhuma rede local conhecida: uma vez pela interface padrão
  fakeNetwork(t, { 'Radmin VPN': [v4('26.177.83.160')] });
  calls.length = 0;
  d.sendMSearch();
  assert.deepEqual(calls, [['send', 1900, '239.255.255.250', true, true]]);
});

test('a pergunta mDNS sai por CADA rede local (com VPN, a "padrão" do Windows não é o Wi-Fi)', (t) => {
  resetDiscovery();
  t.after(resetDiscovery);
  fakeNetwork(t, { 'Radmin VPN': [v4('26.177.83.160')], 'Wi-Fi': [v4('192.168.15.6')], Ethernet: [v4('10.0.0.5')] });

  const created = [];
  const bonjourPath = require.resolve('bonjour-service');
  const original = require.cache[bonjourPath];
  class FakeBonjour {
    constructor(opts) { this.opts = opts; this.server = { mdns: new EventEmitter() }; created.push(this); this.found = []; this.destroyed = false; }
    find(query) { const b = { query, stopped: false, services: [], stop() { this.stopped = true; } }; this.found.push(b); return b; }
    destroy() { this.destroyed = true; }
  }
  require.cache[bonjourPath] = { id: bonjourPath, filename: bonjourPath, loaded: true, exports: { Bonjour: FakeBonjour }, children: [], paths: [] };
  t.after(() => { if (original) require.cache[bonjourPath] = original; else delete require.cache[bonjourPath]; });

  discovery.startMdns();
  assert.deepEqual(created.map((b) => b.opts), [
    { interface: '10.0.0.5', bind: '0.0.0.0' },
    { interface: '192.168.15.6', bind: '0.0.0.0' }
  ], 'uma busca por rede local, nenhuma pela VPN');
  assert.ok(created.every((b) => b.found[0].query.type === 'bdsm'));
  assert.equal(discovery._mdns.length, 2);
  assert.equal(discovery._mdnsKey, '10.0.0.5,192.168.15.6');

  // 'error' do socket não derruba o app (sem ouvinte, o EventEmitter lançaria)
  assert.doesNotThrow(() => created[0].server.mdns.emit('error', new Error('EADDRINUSE')));

  // parar fecha todas as buscas
  discovery.stop();
  assert.ok(created.every((b) => b.destroyed && b.found[0].stopped));
  assert.deepEqual(discovery._mdns, []);

  // sem nenhuma rede local conhecida: a busca padrão de antes
  fakeNetwork(t, { 'Radmin VPN': [v4('26.177.83.160')] });
  created.length = 0;
  discovery.startMdns();
  assert.deepEqual(created.map((b) => b.opts), [{}]);
  discovery.stop();
});

test('rede local nova (Wi-Fi que conectou depois, ponto de acesso do celular): as buscas são refeitas', (t) => {
  resetDiscovery();
  t.after(resetDiscovery);
  const os = require('node:os');
  const original = os.networkInterfaces;
  os.networkInterfaces = () => ({ Ethernet: [v4('10.0.0.5')] });
  t.after(() => { os.networkInterfaces = original; });

  let restarts = 0;
  const keep = discovery.startMdns;
  discovery.startMdns = () => { restarts++; discovery._mdnsKey = discovery.lanAddresses().join(','); };
  t.after(() => { discovery.startMdns = keep; });
  discovery._mdnsKey = '10.0.0.5';

  discovery._refreshMdns();
  assert.equal(restarts, 0, 'descoberta desligada (ou teste fora do app): não abre sockets por conta própria');

  discovery._started = true;
  discovery._refreshMdns();
  assert.equal(restarts, 0, 'mesmas redes: só pergunta de novo');

  os.networkInterfaces = () => ({ Ethernet: [v4('10.0.0.5')], 'Wi-Fi': [v4('192.168.15.6')] }); // o Wi-Fi conectou
  discovery._refreshMdns();
  assert.equal(restarts, 1);
});

// ─── Canal devices:get-all ────────────────────────────────────────────────────

test('devices:get-all devolve { devices, issues } e esconde o MTP que é o mesmo aparelho do app BDS Mobile', async (t) => {
  const path = require('node:path');
  const here = (rel) => path.resolve(__dirname, '..', 'src', rel);
  const stubs = {};
  const stub = (rel, exports) => {
    const file = require.resolve(here(rel));
    stubs[file] = require.cache[file];
    require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
  };
  const handlers = {};
  const scanCalls = [];
  const rescans = { sony: 0, discovery: 0 };
  let discoveryFails = false;

  stub('ipc/channelRegistry.js', { handle: (name, fn) => { handlers[name] = fn; } });
  stub('services/logService.js', { debug() {}, info() {}, warn() {}, error() {} });
  stub('infrastructure/desktop/TaskProgressCenter.js', { reportIndeterminate() {}, reportIdle() {}, reportError() {} });
  stub('infrastructure/hardware/DeviceManager.js', {
    deviceManager: {
      scan: async (opts) => { scanCalls.push(opts); return { mtp: [{ Name: 'Scorpio', Type: 'Telefone', Storages: [] }, { Name: 'Sony A7', Type: 'Câmera', Storages: [] }], usb: [card()], issues: [{ source: 'mtp', message: 'demorou' }] }; },
      track: (fn) => fn()
    }
  });
  stub('core/modules/lazyService.js', { lazyService: (factory) => factory() });
  stub('core/devices/DeviceDiscoveryService.js', {
    getDevices: () => [{ id: 'Scorpio_usb', name: 'Scorpio', connection: 'usb', ip: '127.0.0.1', port: 8080 }],
    forceRescan: async () => { rescans.discovery++; if (discoveryFails) throw new Error('mDNS indisponível'); }
  });
  stub('core/devices/SonyCameraService.js', { getCameras: () => [], rescan: () => { rescans.sony++; } });
  stub('core/MtpService.js', {});
  stub('core/UsbService.js', {});
  const target = require.resolve(here('ipc/deviceListHandlers.js'));
  delete require.cache[target];
  t.after(() => {
    delete require.cache[target];
    for (const [file, original] of Object.entries(stubs)) { if (original) require.cache[file] = original; else delete require.cache[file]; }
  });

  require(target)();
  const normal = await handlers['devices:get-all']({}, false);
  assert.deepEqual(Object.keys(normal).sort(), ['devices', 'issues']);
  assert.deepEqual(normal.issues, [{ source: 'mtp', message: 'demorou' }]);
  assert.deepEqual(normal.devices.map((d) => `${d.type}:${d.name || d.Name}`), ['MTP:Sony A7', 'USB:SD_CARD', 'BDSM:Scorpio'], 'Scorpio (MTP) fica só como celular BDS Mobile');
  assert.deepEqual(scanCalls[0], { force: false });
  assert.deepEqual(rescans, { sony: 1, discovery: 0 }, 'a primeira pergunta já procura câmeras Sony; celulares seguem a busca própria');

  await handlers['devices:get-all']({}, false);
  assert.equal(rescans.sony, 1, 'perguntas seguidas (a tela pergunta a cada poucos segundos) não repetem a busca de câmeras antes de 8 s');

  await handlers['devices:get-all']({}, true);
  assert.deepEqual(scanCalls[2], { force: true });
  assert.deepEqual(rescans, { sony: 2, discovery: 1 }, '"atualizar" refaz a busca de celulares e de câmeras Sony na hora');

  // a busca de celulares falhando não derruba a lista do resto
  discoveryFails = true;
  const survived = await handlers['devices:get-all']({}, true);
  assert.equal(rescans.discovery, 2);
  assert.equal(survived.devices.length, 3, 'cartões, câmeras e celulares já vistos continuam na resposta');
});
