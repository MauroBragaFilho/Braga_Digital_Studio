'use strict';

const EventEmitter = require('node:events');
const path = require('node:path');
const { cachedAsync } = require('./cachedAsync');

// Enumerar MTP/USB custa um PowerShell cada (~1 s): o resultado é reaproveitado (sidebar de armazenamento, tela
// Dispositivos) e chamadas simultâneas são deduplicadas. Com a "assinatura" do hardware (algo foi plugado ou removido?) a
// lista é refeita assim que ela muda e o tempo abaixo é só uma rede de segurança; sem a assinatura, o cache é curto.
const LIST_TTL_SIGNED_MS = 20000;
const LIST_TTL_UNSIGNED_MS = 8000;
const MTP_PENDING_TTL_MS = 4000;          // aparelho conectado mas sem armazenamento (celular bloqueado): confere de novo logo
const SIGNATURE_MIN_INTERVAL_MS = 1500;   // no máximo uma leitura da assinatura por intervalo, não importa quem pergunte

/** Aparelho MTP que ainda não mostrou o armazenamento (celular bloqueado, "permitir acesso" pendente). */
const hasNoStorage = (d) => !d || !Array.isArray(d.Storages) || d.Storages.length === 0;

/**
 * Valida a lista de segmentos de caminho/nomes vindos do renderer: só nomes simples
 * (sem separadores, '..', ':' ou bytes nulos). Segmentos vazios são descartados.
 * @returns {string[]}
 */
function cleanSegments(list, label = 'Caminho') {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 5000) throw new Error(`${label} inválido.`);
  const out = [];
  for (const seg of list) {
    if (seg == null || seg === '') continue;
    if (typeof seg !== 'string' || seg.length > 255 || /[\\/:\0]/.test(seg) || seg === '.' || seg === '..') {
      throw new Error(`${label} inválido: segmento não permitido.`);
    }
    out.push(seg);
  }
  return out;
}

/** Pasta de destino: caminho absoluto, sem bytes nulos e que não seja a raiz de um drive. */
function assertDestFolder(dest) {
  if (!dest || typeof dest !== 'string' || dest.includes('\0') || dest.length > 4096 || !path.isAbsolute(dest)) {
    throw new Error('Pasta de destino inválida.');
  }
  const resolved = path.resolve(dest);
  if (path.parse(resolved).root === resolved || path.parse(resolved).root === resolved + path.sep) {
    throw new Error('A pasta de destino não pode ser a raiz de um drive.');
  }
  return resolved;
}

const normBase = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();

/**
 * DeviceManager — Facade multiplataforma para acesso a dispositivos de hardware.
 *
 * Seleciona automaticamente o provider correto com base em process.platform:
 *   - win32  → Windows{Mtp,Storage}Provider
 *   - linux  → Linux{Mtp,Storage}Provider
 *   - darwin → LinuxStorageProvider (compativel com macOS via lsblk-like)
 *
 * Regra do roadmap (Sprint 5):
 *   MtpService e UsbService devem delegar TODA a logica de dispositivo ao DeviceManager.
 *   O DeviceManager e o UNICO ponto que conhece os providers de plataforma.
 *
 * Uso:
 *   const { deviceManager } = require('./DeviceManager');
 *   const devices = await deviceManager.getMtpDevices();
 *   deviceManager.on('progress', (data) => ...);
 */
class DeviceManager extends EventEmitter {
  /**
   * @param {{ readSignature?: () => Promise<string|null>, now?: () => number, providers?: { mtp: object, storage: object } }} [opts]
   *   (só os testes passam opções: relógio, leitor da assinatura e providers falsos)
   */
  constructor({ readSignature = null, now = Date.now, providers = null } = {}) {
    super();
    this._mtpProvider = null;
    this._storageProvider = null;
    this._initialized = false;
    this._now = now;
    this._readSignatureFn = readSignature;
    this._signature = null;
    this._signatureAt = -Infinity;
    this._signatureInflight = null;
    this._signatureWorks = false;
    this._mtpPending = false;
    this._busy = 0;
    this._mtpList = cachedAsync(async () => {
      this._ensureInit();
      const list = await this._mtpProvider.getDevices();
      this._mtpPending = list.some(hasNoStorage);
      return list;
    }, () => (this._mtpPending ? MTP_PENDING_TTL_MS : this._ttl()), now);
    this._storageList = cachedAsync(() => { this._ensureInit(); return this._storageProvider.getDevices(); }, () => this._ttl(), now);
    if (providers) this._useProviders(providers.mtp, providers.storage);
  }

  _ttl() { return this._signatureWorks ? LIST_TTL_SIGNED_MS : LIST_TTL_UNSIGNED_MS; }

  _useProviders(mtp, storage) {
    this._mtpProvider = mtp;
    this._storageProvider = storage;
    // Repassa eventos de progresso dos providers para os listeners do DeviceManager
    mtp.on('progress', (data) => this.emit('progress', data));
    storage.on('progress', (data) => this.emit('progress', data));
    this._initialized = true;
  }

  /**
   * Inicializa os providers corretos para a plataforma atual.
   * Chamado automaticamente na primeira operacao.
   */
  _ensureInit() {
    if (this._initialized) return;

    const platform = process.platform;

    if (platform === 'win32') {
      const { WindowsMtpProvider } = require('./windows/WindowsMtpProvider');
      const { WindowsStorageProvider } = require('./windows/WindowsStorageProvider');
      if (!this._readSignatureFn) this._readSignatureFn = require('./windows/hardwareSignature').readSignature;
      this._useProviders(new WindowsMtpProvider(), new WindowsStorageProvider());
    } else {
      // Linux e macOS: MTP via stub (futuro), Storage via lsblk/fs (sem assinatura: o cache por tempo é mais curto)
      const { LinuxMtpProvider } = require('./linux/LinuxMtpProvider');
      const { LinuxStorageProvider } = require('./linux/LinuxStorageProvider');
      this._useProviders(new LinuxMtpProvider(), new LinuxStorageProvider());
    }
  }

  // ─── Mudanças no hardware ─────────────────────────────────────────────────

  /**
   * Confere (no máximo uma vez por SIGNATURE_MIN_INTERVAL_MS) se algo foi plugado ou removido; se foi, descarta as listas em
   * cache para a próxima consulta já refazer a enumeração. Nunca lança.
   */
  _syncSignature() {
    if (this._signatureInflight) return this._signatureInflight;
    if (this._now() - this._signatureAt < SIGNATURE_MIN_INTERVAL_MS) return Promise.resolve();
    this._ensureInit();
    const read = this._readSignatureFn || (() => Promise.resolve(null));
    this._signatureInflight = (async () => {
      let sig = null;
      try { sig = await read(); } catch (_) { sig = null; }
      this._signatureAt = this._now();
      this._signatureWorks = sig != null;
      if (sig != null) {
        if (this._signature != null && sig !== this._signature) this.invalidateDeviceCache();
        this._signature = sig;
      }
    })().finally(() => { this._signatureInflight = null; });
    return this._signatureInflight;
  }

  /**
   * Executa `fn` marcando o DeviceManager como ocupado (cópia ou navegação em um aparelho MTP). Enquanto houver operação em
   * andamento, nenhuma enumeração nova é feita: o Windows atende o aparelho um pedido de cada vez e a varredura atrasaria a cópia.
   */
  async track(fn) {
    this._busy++;
    try { return await fn(); } finally { this._busy--; }
  }

  // ─── MTP ──────────────────────────────────────────────────────────────────

  /** @returns {Promise<Array>} nunca rejeita: se a consulta falhar, devolve a última lista boa ou vazio */
  async getMtpDevices({ force = false } = {}) {
    return this._list(this._mtpList, { force });
  }

  /** Lista de um tipo de dispositivo com a assinatura em dia; em caso de falha, a última lista boa (ou vazio). */
  async _list(list, { force }) {
    this._ensureInit();
    if (this._busy === 0) await this._syncSignature();
    try { return await list.get({ force: force && this._busy === 0 }); } catch (_) { const last = list.peek(); return last !== undefined ? last : []; }
  }

  /**
   * MTP e USB de uma vez, com o que deu errado em cada fonte. Quem mostra a lista usa isto: "não há nada conectado" e
   * "não consegui consultar" são coisas diferentes e o usuário precisa saber qual das duas aconteceu.
   * Se a consulta falhar, a última lista boa continua valendo (o aparelho não some da tela por um tempo esgotado), mas só enquanto
   * o hardware não mudou; com o hardware mudado, falhou significa "não sei" e a lista daquela fonte vem vazia.
   * @returns {Promise<{ mtp: Array, usb: Array, issues: Array<{source: 'mtp'|'usb', message: string}> }>}
   */
  async scan({ force = false } = {}) {
    this._ensureInit();
    const busy = this._busy > 0;
    if (!busy) await this._syncSignature();
    const issues = [];
    const grab = async (source, list) => {
      if (busy) { const last = list.peek(); if (last !== undefined) return last; }
      try {
        return await list.get({ force: force && !busy });
      } catch (err) {
        issues.push({ source, message: err && err.message ? String(err.message) : 'Falha ao consultar.' });
        const last = list.peek();
        return last !== undefined ? last : [];
      }
    };
    const [mtp, usb] = await Promise.all([grab('mtp', this._mtpList), grab('usb', this._storageList)]);
    return { mtp, usb, issues };
  }

  /**
   * @param {string} deviceName
   * @param {string[]} pathArray
   * @returns {Promise<Array>}
   */
  listMtpFolder(deviceName, pathArray) {
    this._ensureInit();
    return this._mtpProvider.listFolder(deviceName, cleanSegments(pathArray));
  }

  /**
   * @param {string} deviceName
   * @param {string[]} pathArray
   * @param {string[]} itemNames
   * @param {string} destFolder
   * @returns {Promise<boolean>}
   */
  importMtpItems(deviceName, pathArray, itemNames, destFolder) {
    this._ensureInit();
    return this._mtpProvider.importItems(
      deviceName, cleanSegments(pathArray), cleanSegments(itemNames, 'Nome de arquivo'), assertDestFolder(destFolder)
    );
  }

  // ─── Storage / USB ────────────────────────────────────────────────────────

  /** @returns {Promise<Array>} nunca rejeita: se a consulta falhar, devolve a última lista boa ou vazio */
  async getStorageDevices({ force = false } = {}) {
    return this._list(this._storageList, { force });
  }

  /** Descarta as listas em cache (algo foi plugado/removido, ou o usuário pediu para procurar de novo). */
  invalidateDeviceCache() {
    this._mtpList.invalidate();
    this._storageList.invalidate();
  }

  /**
   * @param {string} basePath
   * @param {string[]} pathArray
   * @returns {Promise<{success: boolean, items: Array}>}
   */
  async listStorageFolder(basePath, pathArray) {
    this._ensureInit();
    const segments = cleanSegments(pathArray);
    const base = await this._assertListedStorage(basePath);
    return this._storageProvider.listFolder(base, segments);
  }

  /** basePath precisa ser exatamente uma unidade/ponto de montagem listado pelo provider. */
  async _assertListedStorage(basePath) {
    if (!basePath || typeof basePath !== 'string' || basePath.includes('\0') || !path.isAbsolute(basePath)) {
      throw new Error('Unidade inválida.');
    }
    const wanted = normBase(basePath);
    const find = (devices) => {
      for (const d of devices || []) {
        for (const s of d.storage || []) {
          if (s && s.path && normBase(s.path) === wanted) return s.path;
        }
      }
      return null;
    };
    let found = find(await this.getStorageDevices());
    if (!found) found = find(await this.getStorageDevices({ force: true })); // unidade recém-conectada
    if (!found) throw new Error('A unidade informada não está entre os dispositivos conectados.');
    return found;
  }

  /**
   * @param {string} basePath
   * @param {string[]} pathArray
   * @param {string[]} itemNames
   * @param {string} destFolder
   * @returns {Promise<boolean>}
   */
  async importStorageItems(basePath, pathArray, itemNames, destFolder) {
    this._ensureInit();
    const segments = cleanSegments(pathArray);
    const names = cleanSegments(itemNames, 'Nome de arquivo');
    const dest = assertDestFolder(destFolder);
    const base = await this._assertListedStorage(basePath);
    return this._storageProvider.importItems(base, segments, names, dest);
  }
}

// Singleton
const deviceManager = new DeviceManager();
module.exports = { DeviceManager, deviceManager, cleanSegments, assertDestFolder };
