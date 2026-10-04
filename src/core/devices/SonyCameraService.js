const { EventEmitter } = require('events');
const logger = require('../../services/logService');
const SonyCameraDiscovery = require('../../infrastructure/network/sony/SonyCameraDiscovery');
const SonyCameraProvider = require('./providers/SonyCameraProvider');

class SonyCameraService extends EventEmitter {
    constructor() {
        super();
        this.discovery = new SonyCameraDiscovery();
        this.providers = new Map(); // cameraId -> SonyCameraProvider
        this.telemetryInterval = null;
    }

    start() {
        this.discovery.on('camera_discovered', async (cameraInfo) => {
            const provider = new SonyCameraProvider(cameraInfo);
            await provider.initialize();
            this.providers.set(cameraInfo.id, provider);
            
            logger.info(`[SonyCameraService] Câmera registrada: ${cameraInfo.name} (${cameraInfo.id})`);
            this.emit('camera_connected', {
                ...cameraInfo,
                provider
            });
        });

        // Câmera sem sinal: remove o provider (evita acumular providers e telemetria de câmeras ausentes)
        this.discovery.on('camera_lost', (cameraInfo) => {
            this.providers.delete(cameraInfo.id);
            this.emit('camera_disconnected', cameraInfo);
        });

        this.discovery.start();

        // Polling de telemetria a cada 10 segundos
        this.telemetryInterval = setInterval(async () => {
            for (const [id, provider] of this.providers.entries()) {
                try {
                    const status = await provider.getDeviceStatus();
                    this.emit('camera_status_updated', status);
                } catch (e) {
                    logger.warn(`[SonyCameraService] Erro ao obter telemetria de ${id}: ${e.message}`);
                }
            }
        }, 10000);
    }

    /** Repete a busca de câmeras agora (botão "Procurar novamente"). */
    rescan() {
        try { this.discovery.rescan(); } catch (e) { logger.warn(`[SonyCameraService] Falha ao repetir a busca: ${e.message}`); }
    }

    getProvider(cameraId) {
        return this.providers.get(cameraId);
    }

    getCameras() {
        return Array.from(this.discovery.discoveredCameras.values());
    }

    stop() {
        if (this.telemetryInterval) {
            clearInterval(this.telemetryInterval);
            this.telemetryInterval = null;
        }
        this.discovery.stop();
        this.providers.clear();
    }
}

module.exports = new SonyCameraService();
