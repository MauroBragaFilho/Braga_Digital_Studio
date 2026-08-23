const dgram = require('dgram');
const http = require('http');
const { EventEmitter } = require('events');
const logger = require('../../../services/logService');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SONY_SEARCH_TARGET = 'urn:schemas-sony-com:service:ScalarWebAPI:1';
const DEFAULT_SONY_ENDPOINT = 'http://192.168.122.1:8080/sony';

class SonyCameraDiscovery extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
        this.isScanning = false;
        this.discoveredCameras = new Map(); // endpointURL -> camera info
    }

    /**
     * Inicia a descoberta SSDP e a sonda de fallback
     */
    start() {
        this.startSsdp();
        this.probeDefaultEndpoint();
    }

    /**
     * Inicia escuta e envio de pacotes SSDP M-SEARCH
     */
    startSsdp() {
        if (this.socket) return;

        try {
            this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

            this.socket.on('message', (msg, rinfo) => {
                this.handleSsdpResponse(msg.toString(), rinfo);
            });

            this.socket.on('error', (err) => {
                logger.error(`[SonyDiscovery] Erro no socket SSDP: ${err.message}`);
            });

            this.socket.bind(() => {
                this.socket.setBroadcast(true);
                this.socket.setMulticastTTL(2);
                this.sendMSearch();
            });

            this.isScanning = true;
        } catch (err) {
            logger.error(`[SonyDiscovery] Falha ao iniciar SSDP: ${err.message}`);
        }
    }

    /**
     * Envia mensagem M-SEARCH para a rede
     */
    sendMSearch() {
        if (!this.socket) return;

        const msearch = [
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            'MX: 3',
            `ST: ${SONY_SEARCH_TARGET}`,
            '',
            ''
        ].join('\r\n');

        const message = Buffer.from(msearch);
        this.socket.send(message, 0, message.length, SSDP_PORT, SSDP_ADDRESS, (err) => {
            if (err) {
                logger.warn(`[SonyDiscovery] Falha ao enviar M-SEARCH: ${err.message}`);
            } else {
                logger.info('[SonyDiscovery] Pacote M-SEARCH SSDP enviado.');
            }
        });
    }

    /**
     * Trata a resposta SSDP de um dispositivo Sony
     */
    handleSsdpResponse(responseStr, rinfo) {
        if (!responseStr.includes('ScalarWebAPI')) return;

        const locationMatch = responseStr.match(/LOCATION:\s*([^\r\n]+)/i);
        if (!locationMatch) return;

        const locationUrl = locationMatch[1].trim();
        this.fetchDeviceDescription(locationUrl, rinfo.address);
    }

    /**
     * Baixa o XML descritivo do dispositivo (dd.xml) e extrai os serviços disponíveis
     */
    fetchDeviceDescription(ddUrl, fallbackIp) {
        try {
            http.get(ddUrl, { timeout: 3000 }, (res) => {
                if (res.statusCode !== 200) return;
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    this.parseDeviceDescription(data, ddUrl, fallbackIp);
                });
            }).on('error', (err) => {
                logger.warn(`[SonyDiscovery] Falha ao obter dd.xml de ${ddUrl}: ${err.message}`);
            });
        } catch (err) {
            logger.error(`[SonyDiscovery] Erro na requisição dd.xml: ${err.message}`);
        }
    }

    /**
     * Extrai endpoints de serviços do XML descritivo
     */
    parseDeviceDescription(xmlText, ddUrl, fallbackIp) {
        try {
            const friendlyNameMatch = xmlText.match(/<friendlyName>(.*?)<\/friendlyName>/i);
            const modelNameMatch = xmlText.match(/<modelName>(.*?)<\/modelName>/i);
            const endpointMatch = xmlText.match(/<av:X_ScalarWebAPI_ActionList_URL>(.*?)<\/av:X_ScalarWebAPI_ActionList_URL>/i);

            const friendlyName = friendlyNameMatch ? friendlyNameMatch[1] : 'Sony Digital Camera';
            const modelName = modelNameMatch ? modelNameMatch[1] : 'ILCE-6000';
            let endpointURL = endpointMatch ? endpointMatch[1] : null;

            if (!endpointURL) {
                const urlObj = new URL(ddUrl);
                endpointURL = `${urlObj.protocol}//${urlObj.hostname}:${urlObj.port || 8080}/sony`;
            }

            const cameraInfo = {
                id: `sony_${fallbackIp || 'cam'}`,
                name: friendlyName,
                model: modelName,
                endpointURL: endpointURL,
                ip: fallbackIp,
                type: 'sony_camera',
                last_seen: Date.now()
            };

            this.registerCamera(cameraInfo);
        } catch (err) {
            logger.error(`[SonyDiscovery] Erro ao parsear XML de descrição: ${err.message}`);
        }
    }

    /**
     * Sonda de fallback para o IP fixo padrão de Wi-Fi Direct da Sony (192.168.122.1:8080)
     */
    probeDefaultEndpoint() {
        const postData = JSON.stringify({
            method: 'getAvailableApiList',
            params: [],
            id: 1,
            version: '1.0'
        });

        const options = {
            hostname: '192.168.122.1',
            port: 8080,
            path: '/sony/camera',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 2500
        };

        const req = http.request(options, (res) => {
            if (res.statusCode === 200) {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    logger.info('[SonyDiscovery] Câmera Sony respondendo no endpoint padrão 192.168.122.1:8080');
                    this.registerCamera({
                        id: 'sony_192.168.122.1',
                        name: 'Sony Camera (Wi-Fi Direct)',
                        model: 'Sony Alpha / Cyber-shot',
                        endpointURL: DEFAULT_SONY_ENDPOINT,
                        ip: '192.168.122.1',
                        type: 'sony_camera',
                        last_seen: Date.now()
                    });
                });
            }
        });

        req.on('error', () => {
            // Silencioso se não houver resposta
        });

        req.on('timeout', () => {
            req.destroy();
        });

        req.write(postData);
        req.end();
    }

    registerCamera(cameraInfo) {
        const existing = this.discoveredCameras.get(cameraInfo.endpointURL);
        this.discoveredCameras.set(cameraInfo.endpointURL, cameraInfo);

        if (!existing) {
            logger.info(`[SonyDiscovery] Nova câmera Sony conectada: ${cameraInfo.name} (${cameraInfo.endpointURL})`);
            this.emit('camera_discovered', cameraInfo);
        } else {
            this.emit('camera_updated', cameraInfo);
        }
    }

    stop() {
        if (this.socket) {
            try {
                this.socket.close();
            } catch (_) {}
            this.socket = null;
        }
        this.isScanning = false;
    }
}

module.exports = SonyCameraDiscovery;
