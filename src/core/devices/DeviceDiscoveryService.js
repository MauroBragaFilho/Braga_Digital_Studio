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
        this.usbPollInterval = null;
        this.cleanupInterval = null;
    }

    start() {
        // --- 1. mDNS / Bonjour (Wi-Fi) ---
        try {
            this.bonjour = new Bonjour();
            this.bonjour.find({ type: 'bdsm' }, (service) => {
                logger.info(`[Discovery] Serviço BDSM via Wi-Fi encontrado: ${service.name}`);
                this.probeDevice(service.addresses[0], service.port, 'wifi');
            });
        } catch (e) {
            logger.error(`[Discovery] Falha ao iniciar Bonjour: ${e.message}`);
        }

        // --- 2. Polling USB (ADB) e Wi-Fi ---
        // Checa a cada 5 segundos para manter dispositivos vivos e descobrir via USB
        this.usbPollInterval = setInterval(() => this.pollAllDevices(), 5000);
        // Tenta disparar o adb forward logo na partida para garantir
        this.setupAdbForward();

        // --- 3. Cleanup Offline ---
        this.cleanupInterval = setInterval(() => this.cleanupDevices(), 15000);
    }

    setupAdbForward() {
        exec('adb forward tcp:8080 tcp:8080', (error, stdout, stderr) => {
            if (error) {
                // Ignore errors se adb não estiver instalado ou não houver devices.
            } else {
                logger.info('[Discovery] ADB forward configurado com sucesso na porta 8080');
            }
        });
    }

    async pollAllDevices() {
        this.setupAdbForward();
        // Polling USB
        await this.probeDevice('127.0.0.1', 8080, 'usb', true);
        
        // Polling Wi-Fi (manter vivos os dispositivos encontrados via Bonjour)
        for (const [id, device] of this.devices.entries()) {
            if (device.connection === 'wifi') {
                await this.probeDevice(device.ip, device.port, 'wifi', true);
            }
        }
    }

    async probeDevice(ip, port, connectionType, silentFail = false) {
        try {
            const client = new BdsmClient(ip, port);
            const info = await client.getInfo(silentFail);
            
            // O mobile nos retorna: deviceName, deviceModel, appVersion, batteryLevel, etc
            const deviceData = {
                id: info.deviceName + '_' + connectionType, // Geramos um ID unívoco
                name: info.deviceName || info.deviceModel || 'Smartphone BDSM',
                model: info.deviceModel || 'Unknown Model',
                ip: ip,
                port: port,
                battery: info.batteryLevel || 100,
                storage_total: info.totalStorageBytes || 0,
                storage_free: info.freeStorageBytes || 0,
                app_version: info.appVersion || '1.0.0',
                connection: connectionType,
                type: 'bdsm',
                last_seen: Date.now()
            };

            this.registerDevice(deviceData);
        } catch(e) {
            // Se falhar o fetch, o dispositivo não está disponível
            if (!silentFail) {
                logger.error(`[Discovery] Falha ao sondar dispositivo ${ip}:${port} - ${e.message}`);
            }
        }
    }

    stop() {
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        if (this.usbPollInterval) clearInterval(this.usbPollInterval);
        if (this.bonjour) {
            this.bonjour.destroy();
            this.bonjour = null;
        }
    }

    registerDevice(deviceData) {
        const existing = this.devices.get(deviceData.id);
        this.devices.set(deviceData.id, deviceData);

        if (!existing) {
            logger.info(`[Discovery] Novo dispositivo BDSM encontrado: ${deviceData.name} (${deviceData.connection})`);
            this.emit('device_added', deviceData);
        } else {
            this.emit('device_updated', deviceData);
        }
    }

    cleanupDevices() {
        const now = Date.now();
        const timeout = 15000; // 15 seconds sem dar sinal = offline
        
        for (const [id, device] of this.devices.entries()) {
            if (now - device.last_seen > timeout) {
                logger.info(`[Discovery] Dispositivo BDSM desconectado por inatividade: ${device.name}`);
                this.devices.delete(id);
                this.emit('device_removed', id);
            }
        }
    }

    getDevices() {
        return Array.from(this.devices.values());
    }

    async forceRescan() {
        // Limpamos o mapa para forçar uma rediscoberta imediata do USB
        this.devices.clear();
        await this.pollAllDevices();
        
        // Se houver wifi, forçamos um novo scan no Bonjour
        if (this.bonjour) {
            try {
                this.bonjour.find({ type: 'bdsm' }, (service) => {
                    this.probeDevice(service.addresses[0], service.port, 'wifi');
                });
            } catch (e) {}
        }
    }
}

module.exports = new DeviceDiscoveryService();
