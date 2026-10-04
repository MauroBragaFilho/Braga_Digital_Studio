'use strict';

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');
const logger = require('../../services/logService');
const { nextHop } = require('../../core/modules/FileDownloader');

const MAX_REDIRECTS = 5;

/**
 * ManifestClient — Consulta o manifest.json de um BDS Update Server central.
 *
 * Formato esperado do manifesto (ver update-server/README.md):
 * {
 *   "bdsVersion": "1.0.3",
 *   "generatedAt": "2026-08-25T12:00:00.000Z",
 *   "components": {
 *     "ffmpeg": {
 *       "version": "7.1.0",
 *       "platform": { "win32": { "url": "...", "sha256": "...", "isZip": true } }
 *     }
 *   }
 * }
 */
class ManifestClient {
  /**
   * @param {string} baseUrl - URL base do Update Server (ex: https://updates.bragadigital.com)
   * @param {number} [timeoutMs]
   */
  constructor(baseUrl, timeoutMs = 8000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this._cache = null;
    this._cacheAt = 0;
  }

  /**
   * Busca o manifest.json remoto. Usa um cache curto (60s) para não bater o servidor a cada
   * checagem de componente individual dentro da mesma sessão de verificação.
   */
  async fetchManifest({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._cache && (now - this._cacheAt) < 60000) {
      return this._cache;
    }

    const url = `${this.baseUrl}/manifest.json`;
    const data = await this._requestJson(url);
    this._cache = data;
    this._cacheAt = now;
    logger.info('ManifestClient:fetched', { url, componentCount: Object.keys(data.components || {}).length });
    return data;
  }

  /**
   * Retorna a entrada de um componente específico para a plataforma atual, ou null se o
   * Update Server não conhece esse componente (nesse caso, o BDS deve cair de volta para
   * o fluxo de checagem por componente individual, ex: GitHub releases).
   */
  async getComponentEntry(toolKey, platform = process.platform) {
    const manifest = await this.fetchManifest();
    const comp = manifest.components?.[toolKey];
    if (!comp) return null;

    const platformEntry = comp.platform?.[platform];
    if (!platformEntry) return null;

    return {
      version: comp.version,
      url: platformEntry.url,
      sha256: platformEntry.sha256,
      isZip: Boolean(platformEntry.isZip),
    };
  }

  _requestJson(urlString, redirects = 0) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(urlString);
      } catch (err) {
        return reject(new Error('O endereço do servidor de atualizações é inválido. Revise-o nas configurações.'));
      }

      const client = parsed.protocol === 'http:' ? http : https;
      const req = client.get(parsed, { headers: { 'User-Agent': 'BDS-UpdateClient' }, timeout: this.timeoutMs }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) return reject(new Error('O servidor de atualizações redirecionou demais. Tente novamente mais tarde.'));
          let hop;
          try { hop = nextHop(parsed, res.headers.location, {}); } catch (err) { return reject(err); }
          return this._requestJson(hop.url, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`O servidor de atualizações não respondeu corretamente (código ${res.statusCode}). Tente novamente mais tarde.`));
        }

        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error('O servidor de atualizações enviou uma resposta inválida. Tente novamente mais tarde.'));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error('O servidor de atualizações demorou demais para responder. Verifique sua conexão e tente de novo.'));
      });
      req.on('error', (err) => reject(/servidor de atualiza/i.test(err.message)
        ? err
        : new Error('Não foi possível conectar ao servidor de atualizações. Verifique a conexão e o endereço configurado.')));
    });
  }
}

module.exports = ManifestClient;
