const { EventEmitter } = require('events');
const logger = require('../../services/logService');
const { execFile } = require('child_process');
const { lanAddresses, isLanAddress } = require('../../infrastructure/network/lanAddresses');
const { probeInfo } = require('../integrations/bdsm/BdsmPairing');
const { isPrivateIp } = require('../../ipc/validate');
const { backoffDelay, deviceChanged } = require('./backoff');

/**
 * Intervalo entre 'adb devices' quando não há celular no cabo: 4 s, 8 s e depois 15 s. O 'adb devices' custa ~50 ms, e quem
 * pluga o celular espera vê-lo logo: o backoff longo do padrão (30 s, 60 s, 5 min) deixava o celular invisível por minutos.
 */
const ADB_POLL_STEPS_MS = [4000, 8000, 15000];

/**
 * Porta de teste (BDS_TEST_BDSM_PORT): só em desenvolvimento (app não empacotado), a sondagem "USB" vai para
 * 127.0.0.1:<porta> em vez de 8080 e o adb forward é ignorado. Serve para testar contra um celular falso.
 */
function testBdsmPort() {
    const port = Number(process.env.BDS_TEST_BDSM_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    try {
        const { app } = require('electron');
        if (app && app.isPackaged) return null;
    } catch (_) { /* fora do Electron (testes): não é empacotado */ }
    return port;
}

/** Entre conexões do mesmo aparelho (physicalId), fica a USB; sem USB, a Wi-Fi. Mantém a ordem original. */
function pickPreferredConnection(devices) {
    const hasUsb = new Set(
        devices.filter((d) => d.connection === 'usb' && d.physicalId).map((d) => d.physicalId)
    );
    return devices.filter((d) => !(d.connection !== 'usb' && d.physicalId && hasUsb.has(d.physicalId)));
}

class DeviceDiscoveryService extends EventEmitter {
    constructor() {
        super();
        this.devices = new Map(); // device_id -> device info
        this._mdns = [];        // uma busca mDNS por rede local: [{ ip, bonjour, browser }]
        this._mdnsKey = '';     // redes locais cobertas pelas buscas (quando muda, refaz)
        this.usbPollInterval = null;
        this.cleanupInterval = null;
        this._isPolling = false;
        this._lastAdbForwardDevice = null;
        this._adbCheckCounter = 0;
        this._started = false;
        // ADB: caminho resolvido uma única vez (null = não instalado) e backoff de 'adb devices'.
        this._adbPath = undefined;
        this._adbResolving = null;
        this._adbFailures = 0;
        this._adbNextAt = 0;
        this._adbRunning = false;
        this._mdnsSettleMs = 700; // espera, no "atualizar", pelas respostas mDNS (testes zeram)
    }

    start() {
        // Guarda contra start() duplo (evitaria timers e Bonjour duplicados)
        if (this._started) return;
        this._started = true;

        // --- 1. mDNS / Bonjour (Wi-Fi) ---
        this.startMdns();

        // --- 2. Polling USB (ADB) e Wi-Fi ---
        // Checa a cada 8s para manter dispositivos vivos sem sobrecarregar a CPU
        this.usbPollInterval = setInterval(() => this.pollAllDevices(), 8000);
        this.setupAdbForward().catch(() => {});

        // --- 3. Cleanup Offline ---
        this.cleanupInterval = setInterval(() => this.cleanupDevices(), 20000);
    }

    startMdns() {
        this._stopMdns();
        let Bonjour;
        try {
            // require tardio: o módulo só é carregado quando a descoberta realmente inicia
            ({ Bonjour } = require('bonjour-service'));
        } catch (e) {
            logger.error(`[Discovery] Falha ao iniciar Bonjour: ${e.message}`);
            return;
        }
        const addresses = lanAddresses();
        this._mdnsKey = addresses.join(',');
        // Uma busca por rede local (a pergunta sai pela interface escolhida); sem rede local conhecida, a busca padrão
        for (const ip of (addresses.length ? addresses : [null])) {
            try {
                const bonjour = new Bonjour(ip ? { interface: ip, bind: '0.0.0.0' } : {}, (err) => {
                    logger.warn(`[Discovery] mDNS${ip ? ` (${ip})` : ''}: ${err && err.message}`);
                });
                // 'error' sem ouvinte derrubaria o app (porta em uso, sem permissão): vira só um aviso no log
                try {
                    const mdns = bonjour.server && bonjour.server.mdns;
                    if (mdns && typeof mdns.on === 'function') {
                        mdns.on('error', (err) => logger.warn(`[Discovery] mDNS${ip ? ` (${ip})` : ''}: ${err && err.message}`));
                        mdns.on('warning', () => {});
                    }
                } catch (_) { /* sem como ouvir: segue */ }
                const browser = bonjour.find({ type: 'bdsm' }, (service) => this._onMdnsService(service));
                this._mdns.push({ ip, bonjour, browser });
            } catch (e) {
                logger.error(`[Discovery] Falha ao iniciar Bonjour${ip ? ` (${ip})` : ''}: ${e.message}`);
            }
        }
    }

    _onMdnsService(service) {
        logger.debug(`[Discovery] Serviço BDSM via Wi-Fi encontrado: ${service.name}`);
        const ip = this._extractBestIp(service);
        if (ip) {
            this.probeDevice(ip, service.port || 8080, 'wifi');
        } else {
            logger.warn(`[Discovery] Serviço BDSM ignorado: sem endereço da rede local (${service && service.name})`);
        }
    }

    _stopMdns() {
        for (const { bonjour, browser } of this._mdns) {
            try { if (browser) browser.stop(); } catch (_) {}
            try { if (bonjour) bonjour.destroy(); } catch (_) {}
        }
        this._mdns = [];
    }

    /**
     * Endereço do celular anunciado por mDNS. Só serve IP da rede local (privado ou link-local): um anúncio pode trazer qualquer
     * endereço, e o app manda o token de pareamento e o nome deste computador ao endereço que sondar. IP público e nome de host
     * (a resolução poderia sair da rede local) são descartados; o cabo (127.0.0.1) não passa por aqui.
     */
    _extractBestIp(service) {
        if (!service) return null;
        const usable = (a) => typeof a === 'string' && isPrivateIp(a) && !/^\[?(127\.|::1\]?$)/.test(a.trim());
        const bracket = (a) => (a.includes(':') && !a.startsWith('[') ? `[${a}]` : a);
        const list = Array.isArray(service.addresses) ? service.addresses.filter(usable) : [];
        // Prioriza IPv4; só com IPv6, formata para compor a URL
        const ipv4 = list.find((a) => a.includes('.'));
        if (ipv4) return ipv4;
        const ipv6 = list.find((a) => a.includes(':'));
        if (ipv6) return bracket(ipv6);
        if (service.referer && usable(service.referer.address)) return bracket(service.referer.address);
        if (usable(service.host)) return bracket(service.host);
        return null;
    }

    /**
     * Refaz a pergunta mDNS (por todas as redes locais) e descarta anúncios vencidos. Se as redes locais mudaram (Wi-Fi que
     * conectou depois, ponto de acesso do celular, VPN que ligou), refaz as buscas para cobrir a rede nova. Nunca lança.
     */
    _refreshMdns() {
        if (!this._started) return; // descoberta desligada (ou fora do app, como nos testes): não abre sockets por conta própria
        try {
            if (lanAddresses().join(',') !== this._mdnsKey) { this.startMdns(); return; }
            for (const { browser } of this._mdns) {
                if (!browser) continue;
                if (typeof browser.expire === 'function') browser.expire();
                if (typeof browser.update === 'function') browser.update();
            }
        } catch (e) {
            logger.debug(`[Discovery] Falha ao reconsultar o mDNS: ${e.message}`);
        }
    }

    /** Endereços (ip, porta) dos celulares anunciados na rede e ainda válidos (de todas as buscas, sem repetir). */
    _mdnsEndpoints() {
        const out = [];
        const seen = new Set();
        for (const { browser } of this._mdns) {
            const services = browser && Array.isArray(browser.services) ? browser.services : [];
            for (const service of services) {
                const ip = this._extractBestIp(service);
                if (!ip) continue;
                const port = service.port || 8080;
                const key = `${ip}:${port}`;
                if (!seen.has(key)) { seen.add(key); out.push({ ip, port }); }
            }
        }
        return out;
    }

    /** Resolve `where adb` uma única vez; devolve o caminho ou null se o adb não existe. */
    _resolveAdb() {
        if (this._adbPath !== undefined) return Promise.resolve(this._adbPath);
        if (this._adbResolving) return this._adbResolving;
        const finder = process.platform === 'win32' ? 'where' : 'which';
        this._adbResolving = new Promise((resolve) => {
            execFile(finder, ['adb'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
                const first = !err && stdout ? String(stdout).split(/\r?\n/).map(l => l.trim()).find(Boolean) : null;
                this._adbPath = first || null;
                if (!first) logger.debug('[Discovery] adb não encontrado: ciclo ADB desativado.');
                resolve(this._adbPath);
            });
        });
        return this._adbResolving;
    }

    /**
     * Executa 'adb devices' e configura o forward. Respeita o backoff exponencial (30 s, 60 s, 5 min)
     * quando o adb falha ou não há aparelhos; o adb ausente desliga o ciclo.
     */
    async setupAdbForward() {
        if (testBdsmPort()) return; // modo de teste: não mexe no adb
        if (this._adbRunning || Date.now() < this._adbNextAt) return;
        this._adbRunning = true;
        try {
            const adb = await this._resolveAdb();
            if (!adb) { this._adbNextAt = Infinity; return; }

            const stdout = await new Promise((resolve) => {
                execFile(adb, ['devices'], { windowsHide: true, timeout: 8000 }, (err, out) => resolve(err ? null : out));
            });

            const lines = stdout ? stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean) : [];
            const activeDevices = [];
            for (let i = 1; i < lines.length; i++) {
                const parts = lines[i].split(/\s+/);
                if (parts.length >= 2 && parts[1] === 'device') {
                    activeDevices.push(parts[0]);
                }
            }

            const targetDevice = activeDevices[0] || null;
            if (!targetDevice) {
                this._lastAdbForwardDevice = null;
                this._adbFailures++;
                this._adbNextAt = Date.now() + backoffDelay(this._adbFailures, ADB_POLL_STEPS_MS);
                return;
            }

            // Aparelho presente: zera o backoff
            this._adbFailures = 0;
            this._adbNextAt = 0;

            // Evita re-configurar ADB repetidamente se o dispositivo não mudou
            if (this._lastAdbForwardDevice === targetDevice) {
                return;
            }

            await new Promise((resolve) => {
                execFile(adb, ['-s', targetDevice, 'forward', 'tcp:8080', 'tcp:8080'], { windowsHide: true, timeout: 8000 }, (error) => {
                    if (!error) {
                        this._lastAdbForwardDevice = targetDevice;
                        logger.info(`[Discovery] ADB forward configurado no dispositivo ${targetDevice} (porta 8080)`);
                    }
                    resolve();
                });
            });
        } finally {
            this._adbRunning = false;
        }
    }

    async pollAllDevices() {
        if (this._isPolling) return;
        this._isPolling = true;

        try {
            // Executa setup ADB a cada 3 ciclos de polling (24s) ou se não houver dispositivo
            // (setupAdbForward aplica o backoff e é no-op sem adb instalado)
            this._adbCheckCounter++;
            if (this._adbCheckCounter % 3 === 0 || !this._lastAdbForwardDevice) {
                this.setupAdbForward().catch(() => {});
            }

            // Pergunta de novo na rede quem está anunciando e esquece anúncios vencidos (o navegador do Bonjour só pergunta
            // uma vez ao começar): sem isto, um celular que liga o Wi-Fi depois do app aberto só aparecia em "Atualizar".
            this._refreshMdns();

            // Endereços a sondar, sem repetir: USB (localhost), Wi-Fi já conhecidos (mantê-los vivos) e serviços anunciados na
            // rede. Os anunciados entram sempre: o Bonjour não repete o aviso de um serviço que já viu, então um celular que
            // saiu da lista por inatividade e voltou (app reaberto, Wi-Fi religado) nunca mais seria sondado.
            const targets = new Map();
            const add = (ip, port, connection) => { const key = `${ip}:${port}`; if (ip && !targets.has(key)) targets.set(key, [ip, port, connection]); };
            add('127.0.0.1', testBdsmPort() || 8080, 'usb');
            for (const device of this.devices.values()) {
                if (device.connection === 'wifi' && device.ip && device.ip !== '127.0.0.1') add(device.ip, device.port || 8080, 'wifi');
            }
            for (const ep of this._mdnsEndpoints()) add(ep.ip, ep.port, 'wifi');

            await Promise.allSettled([...targets.values()].map(([ip, port, connection]) => this.probeDevice(ip, port, connection, true)));
        } finally {
            this._isPolling = false;
        }
    }

    async probeDevice(ip, port, connectionType, silentFail = false) {
        if (!ip) return;
        try {
            // 2s de timeout para não travar o polling. Sem pareamento o celular só informa nome/modelo/versão;
            // com o token guardado, vêm também bateria e armazenamento.
            const probe = await probeInfo(ip, port, { silent: silentFail, timeout: 2000 });
            const info = probe.info;

            if (!info) return;

            const name = info.deviceName || info.name || info.deviceModel || info.model || 'Smartphone BDSM';
            const model = info.deviceModel || info.model || 'Mobile Device';
            const rawId = info.id || info.deviceId || info.serial || name; // mantém o id do card (histórico de importação)
            const full = probe.paired || !probe.authRequired;

            const deviceData = {
                id: `${rawId}_${connectionType}`.replace(/\s+/g, '_'),
                // identifica o aparelho, igual nas conexões por USB e Wi-Fi: "nome|modelo" (o celular não publica um id único)
                physicalId: probe.key || String(rawId),
                name: name,
                model: model,
                ip: ip,
                port: port,
                battery: full ? (info.batteryLevel ?? info.battery ?? null) : null,
                storage_total: full ? (info.totalStorageBytes || info.storage_total || 0) : 0,
                storage_free: full ? (info.freeStorageBytes || info.storage_free || 0) : 0,
                app_version: info.appVersion || info.version || '1.0.0',
                paired: probe.paired,
                authRequired: probe.authRequired,
                connection: connectionType,
                type: 'bdsm',
                last_seen: Date.now()
            };

            this.registerDevice(deviceData);
        } catch (e) {
            if (!silentFail) {
                logger.error(`[Discovery] Falha ao sondar dispositivo ${ip}:${port} (${connectionType}) - ${e.message}`);
            }
        }
    }

    /** Sonda de novo um endereço conhecido (depois de parear ou esquecer o pareamento), para a UI atualizar já. */
    async refreshEndpoint(ip, port) {
        const known = Array.from(this.devices.values()).find((d) => d.ip === ip && Number(d.port) === Number(port));
        const connection = known ? known.connection : (ip === '127.0.0.1' ? 'usb' : 'wifi');
        await this.probeDevice(ip, port, connection, true);
    }

    stop() {
        this._started = false;
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        if (this.usbPollInterval) clearInterval(this.usbPollInterval);
        this.cleanupInterval = null;
        this.usbPollInterval = null;
        this._stopMdns();
    }

    registerDevice(deviceData) {
        const existing = this.devices.get(deviceData.id);
        this.devices.set(deviceData.id, deviceData);

        if (!existing) {
            logger.info(`[Discovery] Novo dispositivo BDSM encontrado: ${deviceData.name} (${deviceData.connection} @ ${deviceData.ip}:${deviceData.port})`);
            this.emit('device_added', deviceData);
        } else if (deviceChanged(existing, deviceData)) {
            // last_seen muda a cada sondagem: só emite quando algo visível mudou de fato
            this.emit('device_updated', deviceData);
        }
    }

    cleanupDevices() {
        const now = Date.now();
        const timeout = 15000; // 15 seconds sem resposta = offline
        
        for (const [id, device] of this.devices.entries()) {
            if (now - device.last_seen > timeout) {
                logger.info(`[Discovery] Dispositivo BDSM desconectado por inatividade: ${device.name} (${id})`);
                this.devices.delete(id);
                this.emit('device_removed', id);
            }
        }
    }

    /**
     * Dispositivos conhecidos, um por aparelho físico. Se o mesmo aparelho responde por USB e por Wi-Fi, só a
     * conexão USB é listada (a Wi-Fi fica oculta e volta sozinha se o cabo for retirado).
     */
    getDevices() {
        return pickPreferredConnection(Array.from(this.devices.values()));
    }

    async forceRescan() {
        // Rescan pedido pelo usuário: ignora o backoff e reavalia se o adb existe
        this._adbNextAt = 0;
        this._adbFailures = 0;
        this._adbPath = undefined;
        this._adbResolving = null;
        this._lastAdbForwardDevice = null; // refaz o forward do cabo
        this.startMdns();
        // O forward do adb precisa existir ANTES da sondagem USB (senão o celular só aparecia na sondagem seguinte)
        await this.setupAdbForward().catch(() => {});
        // Dá um instante para os celulares da rede responderem à nova pergunta mDNS antes de sondar
        if (this._mdns.length && this._mdnsSettleMs > 0) await new Promise((resolve) => setTimeout(resolve, this._mdnsSettleMs));
        await this.pollAllDevices();
    }
}

module.exports = new DeviceDiscoveryService();
module.exports.pickPreferredConnection = pickPreferredConnection;
module.exports.testBdsmPort = testBdsmPort;
module.exports.lanAddresses = lanAddresses;
module.exports.isLanAddress = isLanAddress;
