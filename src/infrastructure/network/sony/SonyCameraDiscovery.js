const dgram = require('dgram');
const http = require('http');
const { EventEmitter } = require('events');
const logger = require('../../../services/logService');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SONY_SEARCH_TARGET = 'urn:schemas-sony-com:service:ScalarWebAPI:1';
const DEFAULT_SONY_ENDPOINT = 'http://192.168.122.1:8080/sony';
const RESCAN_INTERVAL_MS = 30000;   // repete M-SEARCH e a sonda do IP padrão
const CAMERA_TTL_MS = 120000;       // câmera sem sinal por este tempo é considerada ausente
const DD_MAX_BYTES = 256 * 1024;    // limite do dd.xml
const DD_TIMEOUT_MS = 3000;

/** IPv4 de rede local (RFC1918, link-local ou loopback). */
function isPrivateIPv4(ip) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127;
}

class SonyCameraDiscovery extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
        this.isScanning = false;
        this.discoveredCameras = new Map(); // endpointURL -> camera info
        this.rescanTimer = null;
        this.probing = false; // evita sobreposição de sondas
    }

    /**
     * Inicia a descoberta SSDP e a sonda de fallback
     */
    start() {
        this.startSsdp();
        this.probeDefaultEndpoint();
        if (!this.rescanTimer) {
            this.rescanTimer = setInterval(() => this.rescan(), RESCAN_INTERVAL_MS);
            if (this.rescanTimer.unref) this.rescanTimer.unref();
        }
    }

    /** Repete a busca (M-SEARCH + sonda do IP padrão) e expira câmeras sem sinal. */
    rescan() {
        this.expireStale();
        if (!this.socket) this.startSsdp(); else this.sendMSearch();
        this.probeDefaultEndpoint();
    }

    expireStale() {
        const now = Date.now();
        for (const [key, cam] of this.discoveredCameras.entries()) {
            if (now - (cam.last_seen || 0) > CAMERA_TTL_MS) {
                this.discoveredCameras.delete(key);
                logger.info(`[SonyDiscovery] Câmera sem sinal, removida: ${cam.name} (${key})`);
                this.emit('camera_lost', cam);
            }
        }
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

        // Anti-SSRF: só aceita respondentes em IP privado e LOCATION apontando para o próprio IP que respondeu.
        if (!rinfo || !isPrivateIPv4(rinfo.address)) {
            logger.warn(`[SonyDiscovery] Resposta SSDP ignorada (origem não privada): ${rinfo && rinfo.address}`);
            return;
        }
        let loc;
        try { loc = new URL(locationUrl); } catch (_) { return; }
        if (loc.protocol !== 'http:' || loc.hostname !== rinfo.address) {
            logger.warn(`[SonyDiscovery] LOCATION ignorado (host difere de quem respondeu): ${loc.hostname}`);
            return;
        }
        this.fetchDeviceDescription(locationUrl, rinfo.address);
    }

    /**
     * Baixa o XML descritivo do dispositivo (dd.xml) e extrai os serviços disponíveis
     */
    fetchDeviceDescription(ddUrl, fallbackIp) {
        try {
            const req = http.get(ddUrl, { timeout: DD_TIMEOUT_MS }, (res) => {
                if (res.statusCode !== 200) { res.resume(); return; }
                let data = '';
                let done = false;
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    data += chunk;
                    if (data.length > DD_MAX_BYTES) { done = true; req.destroy(); }
                });
                res.on('end', () => {
                    if (done) return;
                    done = true;
                    this.parseDeviceDescription(data, ddUrl, fallbackIp);
                });
                res.on('aborted', () => { done = true; });
                res.on('error', () => { done = true; });
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', (err) => {
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

            // O endpoint declarado no XML só vale se apontar para o IP que respondeu; senão reconstrói.
            let endpointOk = false;
            if (endpointURL) {
                try {
                    const e = new URL(endpointURL);
                    endpointOk = e.protocol === 'http:' && e.hostname === fallbackIp;
                } catch (_) { endpointOk = false; }
            }
            if (!endpointOk) {
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
        if (this.probing) return;
        this.probing = true;
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
            res.on('close', () => { this.probing = false; });
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
            } else {
                res.resume();
            }
        });

        req.on('error', () => {
            this.probing = false; // silencioso se não houver resposta
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
        if (this.rescanTimer) {
            clearInterval(this.rescanTimer);
            this.rescanTimer = null;
        }
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
module.exports.isPrivateIPv4 = isPrivateIPv4;
