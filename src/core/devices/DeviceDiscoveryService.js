const { EventEmitter } = require('events');
const logger = require('../../services/logService');
const { exec } = require('child_process');
const { Bonjour } = require('bonjour-service');
const BdsmClient = require('./BdsmClient');

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
    }

    start() {
        // --- 1. mDNS / Bonjour (Wi-Fi) ---
        this.startMdns();

        // --- 2. Polling USB (ADB) e Wi-Fi ---
        // Checa a cada 8s para manter dispositivos vivos sem sobrecarregar a CPU
        this.usbPollInterval = setInterval(() => this.pollAllDevices(), 8000);
        this.setupAdbForward();

        // --- 3. Cleanup Offline ---
        this.cleanupInterval = setInterval(() => this.cleanupDevices(), 20000);
    }

    startMdns() {
        try {
            if (!this.bonjour) {
                this.bonjour = new Bonjour();
            }
            if (this.bonjourBrowser) {
                try { this.bonjourBrowser.stop(); } catch (_) {}
            }

            this.bonjourBrowser = this.bonjour.find({ type: 'bdsm' }, (service) => {
                logger.info(`[Discovery] Serviço BDSM via Wi-Fi encontrado: ${service.name}`);
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

    setupAdbForward() {
        exec('adb devices', (err, stdout) => {
            if (err || !stdout) {
                return;
            }

            const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
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
                return;
            }

            // Evita re-configurar ADB repetidamente se o dispositivo não mudou
            if (this._lastAdbForwardDevice === targetDevice) {
                return;
            }

            exec(`adb -s ${targetDevice} forward tcp:8080 tcp:8080`, (error) => {
                if (!error) {
                    this._lastAdbForwardDevice = targetDevice;
                    logger.info(`[Discovery] ADB forward configurado no dispositivo ${targetDevice} (porta 8080)`);
                }
            });
        });
    }

    async pollAllDevices() {
        if (this._isPolling) return;
        this._isPolling = true;

        try {
            // Executa setup ADB a cada 3 ciclos de polling (24s) ou se não houver dispositivo
            this._adbCheckCounter++;
            if (this._adbCheckCounter % 3 === 0 || !this._lastAdbForwardDevice) {
                this.setupAdbForward();
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
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        if (this.usbPollInterval) clearInterval(this.usbPollInterval);
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
        } else {
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
        this.startMdns();
        await this.pollAllDevices();
    }
}

module.exports = new DeviceDiscoveryService();
