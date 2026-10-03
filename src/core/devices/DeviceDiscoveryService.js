const { EventEmitter } = require('events');
const logger = require('../../services/logService');
const { execFile } = require('child_process');
const BdsmClient = require('./BdsmClient');
const { backoffDelay, deviceChanged } = require('./backoff');

class DeviceDiscoveryService extends EventEmitter {
    constructor() {
        super();
        this.devices = new Map(); // device_id -> device info
        this.bonjour = null;
        this.bonjourBrowser = null;
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
        try {
            if (!this.bonjour) {
                // require tardio: o módulo só é carregado quando a descoberta realmente inicia
                const { Bonjour } = require('bonjour-service');
                this.bonjour = new Bonjour();
            }
            if (this.bonjourBrowser) {
                try { this.bonjourBrowser.stop(); } catch (_) {}
            }

            this.bonjourBrowser = this.bonjour.find({ type: 'bdsm' }, (service) => {
                logger.debug(`[Discovery] Serviço BDSM via Wi-Fi encontrado: ${service.name}`);
                const ip = this._extractBestIp(service);
                if (ip) {
                    this.probeDevice(ip, service.port || 8080, 'wifi');
                } else {
                    logger.warn(`[Discovery] Serviço BDSM encontrado sem endereço IPv4 válido: ${service.name}`);
                }
            });
        } catch (e) {
            logger.error(`[Discovery] Falha ao iniciar Bonjour: ${e.message}`);
        }
    }

    _extractBestIp(service) {
        if (!service) return null;
        if (Array.isArray(service.addresses) && service.addresses.length > 0) {
            // Prioriza IPv4
            const ipv4 = service.addresses.find(a => typeof a === 'string' && a.includes('.') && !a.startsWith('127.'));
            if (ipv4) return ipv4;

            // Se apenas IPv6, formata adequadamente
            const ipv6 = service.addresses.find(a => typeof a === 'string' && a.includes(':'));
            if (ipv6) return ipv6.startsWith('[') ? ipv6 : `[${ipv6}]`;
        }
        if (service.referer && service.referer.address) {
            return service.referer.address;
        }
        if (service.host) {
            return service.host;
        }
        return null;
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
                this._adbNextAt = Date.now() + backoffDelay(this._adbFailures);
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

            const probePromises = [];

            // 1. Polling USB (localhost)
            probePromises.push(this.probeDevice('127.0.0.1', 8080, 'usb', true));

            // 2. Polling Wi-Fi (manter vivos os dispositivos encontrados via Bonjour ou sondagem anterior)
            for (const [id, device] of this.devices.entries()) {
                if (device.connection === 'wifi' && device.ip && device.ip !== '127.0.0.1') {
                    probePromises.push(this.probeDevice(device.ip, device.port || 8080, 'wifi', true));
                }
            }

            await Promise.allSettled(probePromises);
        } finally {
            this._isPolling = false;
        }
    }

    async probeDevice(ip, port, connectionType, silentFail = false) {
        if (!ip) return;
        try {
            const client = new BdsmClient(ip, port);
            const info = await client.getInfo(silentFail, 2000); // 2s timeout para não travar o polling

            if (!info) return;

            const name = info.deviceName || info.name || info.deviceModel || info.model || 'Smartphone BDSM';
            const model = info.deviceModel || info.model || 'Mobile Device';
            const rawId = info.id || info.deviceId || info.serial || name;

            const deviceData = {
                id: `${rawId}_${connectionType}`.replace(/\s+/g, '_'),
                name: name,
                model: model,
                ip: ip,
                port: port,
                battery: info.batteryLevel ?? info.battery ?? 100,
                storage_total: info.totalStorageBytes || info.storage_total || 0,
                storage_free: info.freeStorageBytes || info.storage_free || 0,
                app_version: info.appVersion || info.version || '1.0.0',
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

    stop() {
        this._started = false;
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        if (this.usbPollInterval) clearInterval(this.usbPollInterval);
        this.cleanupInterval = null;
        this.usbPollInterval = null;
        if (this.bonjourBrowser) {
            try { this.bonjourBrowser.stop(); } catch (_) {}
            this.bonjourBrowser = null;
        }
        if (this.bonjour) {
            try { this.bonjour.destroy(); } catch (_) {}
            this.bonjour = null;
        }
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

    getDevices() {
        return Array.from(this.devices.values());
    }

    async forceRescan() {
        // Rescan pedido pelo usuário: ignora o backoff e reavalia se o adb existe
        this._adbNextAt = 0;
        this._adbFailures = 0;
        this._adbPath = undefined;
        this._adbResolving = null;
        this.startMdns();
        await this.pollAllDevices();
    }
}

module.exports = new DeviceDiscoveryService();
