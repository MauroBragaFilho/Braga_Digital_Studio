'use strict';

const logger = require('../../../services/logService');
const BdsmProtocol = require('./BdsmProtocol');
const BdsmClient = require('./BdsmClient');
const { BdsmError } = BdsmClient;
const bdsmAuth = require('./BdsmAuth');

const POLL_MS = 1500;
const MAX_POLL_FAILURES = 3;

/**
 * Sondagem de um aparelho: pergunta as informações SEM token (nunca se envia o token a um aparelho ainda
 * não identificado) e, se este aparelho já foi pareado, repete COM o token para obter bateria e armazenamento.
 * Se a resposta continua mínima, o token foi recusado neste endereço (tokenRejected) e o aparelho conta como não pareado.
 *
 * @returns {Promise<{info:object, key:string, paired:boolean, authRequired:boolean, tokenRejected:boolean}>}
 */
async function probeInfo(ip, port, { auth = bdsmAuth, timeout = 2000, silent = true } = {}) {
  const client = new BdsmClient(ip, port, { auth });
  const minimal = await client.getInfo(silent, timeout, false);
  if (!BdsmProtocol.validateDiscoveryInfo(minimal)) throw new BdsmError('DEVICE_ERROR');
  const key = BdsmProtocol.deviceKey(minimal);
  auth.rememberEndpoint(ip, port, key);

  if (BdsmProtocol.isFullInfo(minimal)) { // celular sem exigência de pareamento
    return { info: minimal, key, paired: true, authRequired: false, tokenRejected: false };
  }
  if (!auth.getToken(key)) {
    return { info: minimal, key, paired: false, authRequired: true, tokenRejected: false };
  }
  try {
    const full = await client.getInfo(silent, timeout, true);
    if (BdsmProtocol.isFullInfo(full)) return { info: full, key, paired: true, authRequired: true, tokenRejected: false };
    // O celular deste endereço não reconhece o token. NÃO é descartado aqui: dois aparelhos com o mesmo nome e modelo
    // (ou o mesmo aparelho por outro caminho) dividem a chave, e a sondagem não pode apagar o pareamento do outro.
    // O token só é descartado por um 401 numa operação real (BdsmClient) ou ao parear de novo / esquecer.
    return { info: minimal, key, paired: false, authRequired: true, tokenRejected: true };
  } catch (_) {
    // sem resposta agora: mantém o pareamento e as informações básicas
    return { info: minimal, key, paired: true, authRequired: true, tokenRejected: false };
  }
}

/**
 * BdsmPairing — Fluxo de pareamento (consentimento duplo): POST /api/pair/request, o operador confere o código
 * no celular e aprova; o status é consultado a cada 1,5 s até APPROVED/DENIED/EXPIRED e o token recebido é
 * guardado (criptografado) no BdsmAuth.
 */
class BdsmPairing {
  /**
   * @param {{auth?:object, pollMs?:number, onChange?:Function}} [opts]
   *   onChange({ ip, port, key, paired }) é chamado quando o pareamento muda (aprovado ou esquecido).
   */
  constructor({ auth = bdsmAuth, pollMs = POLL_MS, onChange = null } = {}) {
    this.auth = auth;
    this.pollMs = pollMs;
    this.onChange = onChange;
    this.sessions = new Map();   // "ip:porta" -> sessão em andamento
    this.resumable = new Map();  // "ip:porta" -> pedido cancelado que ainda vale no celular
  }

  _ep(ip, port) { return `${ip}:${port || BdsmProtocol.DEFAULT_PORT}`; }

  /** Estado de pareamento do aparelho que atende em ip:porta. */
  async status(ip, port) {
    const p = await probeInfo(ip, port, { auth: this.auth, silent: false, timeout: 4000 });
    return {
      deviceName: p.info.deviceName || '',
      deviceModel: p.info.deviceModel || '',
      paired: p.paired,
      authRequired: p.authRequired,
      tokenRejected: p.tokenRejected
    };
  }

  /**
   * Inicia o pareamento. Resolve assim que o celular mostra o código; o andamento sai por `emit` com
   * { state: PENDING|APPROVED|DENIED|EXPIRED|ERROR|CANCELED, code, secondsLeft, errorCode?, message? }.
   * @returns {Promise<{state:string, code?:string, secondsLeft?:number, alreadyPaired?:boolean}>}
   */
  async start(ip, port, emit = () => {}) {
    const ep = this._ep(ip, port);
    this.cancel(ip, port, { silent: true }); // reiniciar substitui o acompanhamento anterior

    const p = await probeInfo(ip, port, { auth: this.auth, silent: false, timeout: 4000 });
    if (p.paired) return { state: 'APPROVED', alreadyPaired: true };

    const client = new BdsmClient(ip, port, { auth: this.auth });
    let req = this.resumable.get(ep);
    if (req && (req.key !== p.key || req.expiresAt - Date.now() < 3000)) req = null;
    if (!req) {
      this.resumable.delete(ep);
      let created;
      try {
        created = await client.requestPairing({ clientId: this.auth.clientId, clientName: this.auth.clientName() });
      } catch (e) {
        if (e instanceof BdsmError && e.code === 'DEVICE_BUSY') {
          throw new BdsmError('DEVICE_BUSY', 'O celular ainda tem um pedido de pareamento aberto. Aprove ou recuse no celular, ou aguarde cerca de 1 minuto, e tente de novo.');
        }
        throw e;
      }
      req = { requestId: created.requestId, code: created.code, expiresAt: Date.now() + created.expiresInSec * 1000, key: p.key, name: p.info.deviceName };
    }

    const session = { ip, port, key: p.key, name: p.info.deviceName || '', requestId: req.requestId, code: req.code, expiresAt: req.expiresAt, canceled: false, timer: null, failures: 0, emit, client };
    this.sessions.set(ep, session);
    const secondsLeft = this._secondsLeft(session);
    emit({ ip, port, state: 'PENDING', code: session.code, secondsLeft });
    session.timer = setTimeout(() => this._tick(ep, session), this.pollMs);
    return { state: 'PENDING', code: session.code, secondsLeft };
  }

  _secondsLeft(s) { return Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 1000)); }

  _finish(ep, session, payload) {
    if (this.sessions.get(ep) !== session) return;
    clearTimeout(session.timer);
    this.sessions.delete(ep);
    this.resumable.delete(ep);
    try { session.emit({ ip: session.ip, port: session.port, code: session.code, secondsLeft: 0, ...payload }); } catch (_) { /* janela fechada */ }
  }

  async _tick(ep, session) {
    if (session.canceled || this.sessions.get(ep) !== session) return;
    let res;
    try {
      res = await session.client.pairingStatus(session.requestId);
      session.failures = 0;
    } catch (e) {
      if (e instanceof BdsmError && (e.code === 'NOT_FOUND')) return this._finish(ep, session, { state: 'EXPIRED' });
      if (e instanceof BdsmError && e.code === 'DEVICE_UNREACHABLE' && ++session.failures < MAX_POLL_FAILURES) return this._schedule(ep, session);
      return this._finish(ep, session, { state: 'ERROR', errorCode: (e && e.code) || 'DEVICE_ERROR', message: (e && e.message) || BdsmProtocol.ERRORS.DEVICE_ERROR });
    }
    if (session.canceled || this.sessions.get(ep) !== session) return;

    switch (res && res.state) {
      case 'APPROVED': {
        if (typeof res.token !== 'string' || !res.token) {
          return this._finish(ep, session, { state: 'ERROR', errorCode: 'TOKEN_LOST', message: 'O celular aprovou, mas o acesso não chegou. Tente parear de novo.' });
        }
        try {
          this.auth.saveToken(session.key, res.token, { name: session.name });
        } catch (e) {
          return this._finish(ep, session, { state: 'ERROR', errorCode: 'DEVICE_ERROR', message: 'Não foi possível guardar o pareamento neste computador.' });
        }
        logger.info(`[BdsmPairing] Celular pareado: ${session.name || 'aparelho'}`);
        this._finish(ep, session, { state: 'APPROVED' });
        this._notify(session, true);
        return;
      }
      case 'DENIED': return this._finish(ep, session, { state: 'DENIED' });
      case 'EXPIRED': return this._finish(ep, session, { state: 'EXPIRED' });
      case 'PENDING':
        if (Date.now() > session.expiresAt + 5000) return this._finish(ep, session, { state: 'EXPIRED' });
        try { session.emit({ ip: session.ip, port: session.port, state: 'PENDING', code: session.code, secondsLeft: this._secondsLeft(session) }); } catch (_) { /* janela fechada */ }
        return this._schedule(ep, session);
      default:
        return this._finish(ep, session, { state: 'ERROR', errorCode: 'DEVICE_ERROR', message: BdsmProtocol.ERRORS.DEVICE_ERROR });
    }
  }

  _schedule(ep, session) {
    if (session.canceled || this.sessions.get(ep) !== session) return;
    session.timer = setTimeout(() => this._tick(ep, session), this.pollMs);
  }

  _notify(session, paired) {
    if (typeof this.onChange !== 'function') return;
    try { this.onChange({ ip: session.ip, port: session.port, key: session.key, paired }); } catch (_) { /* observador opcional */ }
  }

  /** Para de acompanhar o pedido (o celular o descarta sozinho em até 90 s; um novo `start` o retoma se ainda valer). */
  cancel(ip, port, { silent = false } = {}) {
    const ep = this._ep(ip, port);
    const s = this.sessions.get(ep);
    if (!s) return false;
    s.canceled = true;
    clearTimeout(s.timer);
    this.sessions.delete(ep);
    this.resumable.set(ep, { requestId: s.requestId, code: s.code, expiresAt: s.expiresAt, key: s.key, name: s.name });
    if (!silent) { try { s.emit({ ip, port, state: 'CANCELED', code: s.code, secondsLeft: 0 }); } catch (_) { /* janela fechada */ } }
    return true;
  }

  /** Esquece o pareamento do aparelho que atende em ip:porta. */
  async forget(ip, port) {
    this.cancel(ip, port, { silent: true });
    let key = this.auth.keyForEndpoint(ip, port);
    if (!key) {
      try { key = (await probeInfo(ip, port, { auth: this.auth, silent: true, timeout: 3000 })).key; } catch (_) { key = null; }
    }
    if (key) {
      this.auth.forget(key);
      this._notify({ ip, port, key }, false);
    }
    return true;
  }

  /** Encerra todos os acompanhamentos (fim do app). */
  stopAll() {
    for (const s of this.sessions.values()) { s.canceled = true; clearTimeout(s.timer); }
    this.sessions.clear();
  }
}

let defaultPairing = null;

/** Instância única do app; ao mudar o pareamento a descoberta sonda o aparelho de novo (card atualiza na hora). */
function getPairing() {
  if (!defaultPairing) {
    defaultPairing = new BdsmPairing({
      onChange: ({ ip, port }) => {
        try { require('../../devices/DeviceDiscoveryService').refreshEndpoint(ip, port).catch(() => {}); } catch (_) { /* opcional */ }
      }
    });
  }
  return defaultPairing;
}

module.exports = { BdsmPairing, probeInfo, getPairing, POLL_MS };

