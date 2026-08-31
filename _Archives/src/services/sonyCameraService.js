const EventEmitter = require('node:events');
const dgram = require('node:dgram');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const logger = require('./logService');

class SonyCameraService extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.deviceInfo = null;
    this.serviceUrls = {
      camera: 'http://192.168.122.1:8080/post/camera',
      accessControl: 'http://192.168.122.1:8080/post/accessControl',
      system: 'http://192.168.122.1:8080/post/system'
    };
    this.requestId = 1;
    this.eventPollTimer = null;
  }

  /**
   * Tenta descobrir a câmera Sony a6000 na rede via SSDP (UDP Multicast).
   * Se falhar por timeout, aplica fallback para o IP padrão de Hotspot da Sony (192.168.122.1:8080).
   */
  async discover(timeoutMs = 4000) {
    logger.info('[SonyCamera] Iniciando busca de câmera via SSDP...');

    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      let found = false;

      const ssdpTarget = 'urn:schemas-sony-com:service:ScalarWebAPI:1';
      const msearch = 
        'M-SEARCH * HTTP/1.1\r\n' +
        'HOST: 239.255.255.250:1900\r\n' +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 3\r\n' +
        `ST: ${ssdpTarget}\r\n` +
        '\r\n';

      const timer = setTimeout(async () => {
        if (!found) {
          try {
            socket.close();
          } catch (_) {}

          logger.info('[SonyCamera] Timeout no SSDP. Testando fallback para IP padrão (192.168.122.1)...');
          const ok = await this.pingFallback();
          if (ok) {
            this.connected = true;
            this.emit('connected', { mode: 'fallback', ip: '192.168.122.1' });
            this.startEventPolling();
            resolve({ success: true, mode: 'fallback', ip: '192.168.122.1' });
          } else {
            this.connected = false;
            resolve({ success: false, error: 'Câmera não encontrada na rede. Verifique o Wi-Fi da a6000.' });
          }
        }
      }, timeoutMs);

      socket.on('message', async (msg) => {
        const responseStr = msg.toString();
        if (responseStr.includes('LOCATION:') || responseStr.includes('location:')) {
          found = true;
          clearTimeout(timer);
          try {
            socket.close();
          } catch (_) {}

          const locationMatch = responseStr.match(/LOCATION:\s*(.+)/i);
          const locationUrl = locationMatch ? locationMatch[1].trim() : null;

          if (locationUrl) {
            logger.info(`[SonyCamera] Câmera localizada em: ${locationUrl}`);
            await this.parseDeviceDescription(locationUrl);
            this.connected = true;
            this.emit('connected', { mode: 'ssdp', location: locationUrl });
            this.startEventPolling();
            resolve({ success: true, mode: 'ssdp', location: locationUrl, info: this.deviceInfo });
          } else {
            this.connected = true;
            resolve({ success: true, mode: 'ssdp_basic' });
          }
        }
      });

      socket.on('error', (err) => {
        logger.error(`[SonyCamera] Erro no socket SSDP: ${err.message}`);
      });

      socket.bind(() => {
        try {
          socket.setBroadcast(true);
          const messageBuffer = Buffer.from(msearch);
          socket.send(messageBuffer, 0, messageBuffer.length, 1900, '239.255.255.250');
        } catch (e) {
          logger.error(`[SonyCamera] Falha ao enviar pacote SSDP: ${e.message}`);
        }
      });
    });
  }

  /**
   * Baixa e faz parse do dd.xml retornado pelo SSDP
   */
  async parseDeviceDescription(xmlUrl) {
    try {
      const responseText = await new Promise((resolve, reject) => {
        http.get(xmlUrl, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });

      const friendlyNameMatch = responseText.match(/<friendlyName>(.*?)<\/friendlyName>/i);
      const modelNameMatch = responseText.match(/<modelName>(.*?)<\/modelName>/i);
      const serviceUrlMatches = [...responseText.matchAll(/<av:X_ScalarWebAPI_ServiceType>(.*?)<\/av:X_ScalarWebAPI_ServiceType>\s*<av:X_ScalarWebAPI_ActionList_URL>(.*?)<\/av:X_ScalarWebAPI_ActionList_URL>/gi)];

      this.deviceInfo = {
        name: friendlyNameMatch ? friendlyNameMatch[1] : 'Sony Camera',
        model: modelNameMatch ? modelNameMatch[1] : 'a6000'
      };

      for (const match of serviceUrlMatches) {
        const type = match[1];
        const url = match[2];
        if (type === 'camera') this.serviceUrls.camera = `${url}/camera`;
        if (type === 'accessControl') this.serviceUrls.accessControl = `${url}/accessControl`;
        if (type === 'system') this.serviceUrls.system = `${url}/system`;
      }

      logger.info('[SonyCamera] Device Info parsed:', this.deviceInfo);
    } catch (err) {
      logger.error(`[SonyCamera] Erro ao obter XML de descrição: ${err.message}`);
    }
  }

  /**
   * Ping rápido no IP de hotspot padrão da Sony a6000 (192.168.122.1)
   */
  async pingFallback() {
    try {
      const res = await this.rpcCall('getVersions', [], 'camera');
      return Array.isArray(res);
    } catch (_) {
      return false;
    }
  }

  /**
   * Faz uma requisição JSON-RPC via HTTP POST para os serviços da câmera
   */
  rpcCall(method, params = [], serviceType = 'camera', version = '1.0') {
    return new Promise((resolve, reject) => {
      const urlString = this.serviceUrls[serviceType] || this.serviceUrls.camera;
      const parsedUrl = new URL(urlString);

      const payload = JSON.stringify({
        method,
        params,
        id: this.requestId++,
        version
      });

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 8080,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 8000
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.error) {
              const errCode = json.error[0];
              const errMsg = json.error[1] || 'Erro desconhecido na câmera';
              logger.error(`[SonyCamera] RPC Error (${method}): [${errCode}] ${errMsg}`);
              return reject(new Error(`[${errCode}] ${errMsg}`));
            }
            resolve(json.result);
          } catch (e) {
            reject(new Error(`Resposta inválida da câmera: ${e.message}`));
          }
        });
      });

      req.on('error', (e) => reject(e));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout de comunicação com a câmera'));
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Dispara a captura de foto (shutter)
   */
  async takePicture() {
    if (!this.connected) {
      throw new Error('Sony a6000 não está conectada');
    }
    logger.info('[SonyCamera] Disparando foto...');
    const result = await this.rpcCall('actTakePhoto', [], 'camera');
    if (result && result[0] && result[0][0]) {
      const photoUrl = result[0][0];
      this.emit('photo-taken', { photoUrl });
      return { success: true, photoUrl };
    }
    return { success: true, result };
  }

  /**
   * Inicia transmissão do Liveview
   */
  async startLiveview() {
    logger.info('[SonyCamera] Iniciando Liveview...');
    const result = await this.rpcCall('startLiveview', [], 'camera');
    if (result && result[0]) {
      return { success: true, liveviewUrl: result[0] };
    }
    return { success: false };
  }

  /**
   * Parar Liveview
   */
  async stopLiveview() {
    try {
      await this.rpcCall('stopLiveview', [], 'camera');
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Retorna os eventos e status atuais da câmera (Bateria, Modo, Status de Captura)
   */
  async getEvent(longPolling = false) {
    try {
      const result = await this.rpcCall('getEvent', [longPolling], 'camera');
      return { success: true, events: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Polling periódico para manter a conexão ativa e monitorar bateria/status
   */
  startEventPolling() {
    if (this.eventPollTimer) clearInterval(this.eventPollTimer);
    this.eventPollTimer = setInterval(async () => {
      if (!this.connected) return;
      try {
        const status = await this.getEvent(false);
        if (status.success && status.events) {
          this.emit('status-update', status.events);
        }
      } catch (_) {
        // Silencioso em caso de pequenas intermitências
      }
    }, 5000);
  }

  /**
   * Baixar arquivo de imagem/vídeo da câmera para uma pasta local
   */
  async downloadMedia(fileUrl, destPath) {
    return new Promise((resolve, reject) => {
      logger.info(`[SonyCamera] Baixando mídia de ${fileUrl} para ${destPath}`);
      const file = fs.createWriteStream(destPath);

      http.get(fileUrl, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Falha no download da mídia. Status: ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0) {
            const progress = Math.round((downloadedBytes / totalBytes) * 100);
            this.emit('download-progress', { fileUrl, progress, downloadedBytes, totalBytes });
          }
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close(() => {
            logger.info(`[SonyCamera] Download concluído com sucesso: ${destPath}`);
            resolve({ success: true, path: destPath });
          });
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
  }

  getStatus() {
    return {
      connected: this.connected,
      deviceInfo: this.deviceInfo,
      serviceUrls: this.serviceUrls
    };
  }

  disconnect() {
    if (this.eventPollTimer) clearInterval(this.eventPollTimer);
    this.connected = false;
    this.deviceInfo = null;
    this.emit('disconnected');
    logger.info('[SonyCamera] Câmera desconectada.');
    return { success: true };
  }
}

module.exports = new SonyCameraService();
