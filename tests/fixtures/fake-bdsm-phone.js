'use strict';

/**
 * Celular falso do BDS Mobile para testes e validação manual.
 *
 * Implementa o contrato lido do código Kotlin do app (core-network/.../LinkModule.kt, auth/LinkAuthManager.kt,
 * sharing/MediaLibraryService.kt, sharing/LutLibraryService.kt, HttpRange.kt):
 *   GET  /api/discovery/info        sem token: { deviceName, deviceModel, appVersion, authRequired: true };
 *                                   com token válido: + batteryLevel, totalStorageBytes, freeStorageBytes, isCharging
 *   POST /api/pair/request          { clientId, clientName } -> { requestId, code, expiresInSec: 90 }
 *                                   429 'Pending pairing request exists' (pendente do mesmo IP, 3 pendentes ou cooldown)
 *   GET  /api/pair/status/{id}      só o mesmo IP; { state: PENDING|APPROVED|DENIED|EXPIRED, token? (UMA vez) }, senão 404
 *   GET  /api/media                 [{ id, filename, filesize, duration, width, height, fps, codec, createdAt }]
 *   GET  /api/media/{id}/download   Content-Length, Accept-Ranges, Range (206/416)
 *   GET  /api/media/{id}/thumbnail  imagem
 *   DELETE /api/media/{id}          200 / 404
 *   GET  /api/luts                  [{ name, relativePath, size, hash (SHA-256) }]
 *   POST /api/luts/upload           multipart: campo texto `relativePath` + arquivo; 400/409 {relativePath, existingHash, newHash}/413
 *   DELETE /api/luts/{path...}      segmentos separados; 400 'Invalid path' / 200 / 404
 *   Tudo sob /api (exceto /api/pair/* e /api/discovery/info) sem token válido: 401 'Pairing required'.
 *   NÃO existe download de LUT (404), como no app.
 *
 * Controle do operador (no celular real é um diálogo): phone.approve(id), phone.deny(id) ou `autoDecision`.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const PAIR_TTL_MS = 90_000;
const RETRY_COOLDOWN_MS = 5_000;
const MAX_PENDING = 3;
const PAIR_MAX_BODY_BYTES = 2048;
const LUT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hex = (n) => crypto.randomBytes(n).toString('hex');
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

/** Mesmas regras de LutLibraryService.resolveSafe (só a parte lógica de caminho). */
function lutPathValid(rel) {
  if (typeof rel !== 'string' || !rel.trim() || rel.length > 255 || rel.startsWith('/')) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(rel)) return false;
  const seg = rel.split('/');
  if (seg.length > 4 || seg.some((s) => s === '' || s === '.' || s === '..')) return false;
  return /\.cube$/i.test(rel);
}

/** Interpreta Range (RFC 7233, um intervalo) como HttpRange.kt: devolve { start, end } | 'full' | 'unsatisfiable'. */
function parseRange(header, length) {
  if (!header || !header.trim()) return 'full';
  const h = header.trim();
  if (!/^bytes=/i.test(h)) return 'full';
  const spec = h.slice(6).trim();
  if (!spec || spec.includes(',') || !spec.includes('-')) return 'full';
  const [first, last] = [spec.slice(0, spec.indexOf('-')).trim(), spec.slice(spec.indexOf('-') + 1).trim()];
  if (first === '') {
    const n = Number(last);
    if (!Number.isFinite(n)) return 'full';
    if (n <= 0 || length === 0) return 'unsatisfiable';
    return { start: Math.max(0, length - n), end: length - 1 };
  }
  const start = Number(first);
  if (!Number.isInteger(start) || start < 0) return 'full';
  const end = last === '' ? length - 1 : Number(last);
  if (!Number.isInteger(end)) return 'full';
  if (start >= length) return 'unsatisfiable';
  if (end < start) return 'full';
  return { start, end: Math.min(end, length - 1) };
}

/** Parser multipart mínimo: devolve [{ name, filename?, data:Buffer }]. */
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const delimiter = Buffer.from(`--${m[1] || m[2]}`);
  const parts = [];
  let pos = body.indexOf(delimiter);
  while (pos !== -1) {
    const next = body.indexOf(delimiter, pos + delimiter.length);
    if (next === -1) break;
    let chunk = body.subarray(pos + delimiter.length, next);
    if (chunk.subarray(0, 2).toString() === '\r\n') chunk = chunk.subarray(2);
    if (chunk.subarray(chunk.length - 2).toString() === '\r\n') chunk = chunk.subarray(0, chunk.length - 2);
    const sep = chunk.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const headers = chunk.subarray(0, sep).toString('utf8');
      const disp = /content-disposition:[^\r\n]*/i.exec(headers);
      const name = disp && /\bname="([^"]*)"/i.exec(disp[0]);
      const filename = disp && /filename="([^"]*)"/i.exec(disp[0]);
      parts.push({ name: name ? name[1] : '', filename: filename ? filename[1] : undefined, data: chunk.subarray(sep + 4) });
    }
    pos = next;
  }
  return parts;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.deviceName]
 * @param {string} [opts.deviceModel]
 * @param {Array<{id:string, filename:string, content?:Buffer|string, duration?:number}>} [opts.media]
 * @param {Array<{relativePath:string, content:Buffer|string}>} [opts.luts]
 * @param {'manual'|'approve'|'deny'|'expire'} [opts.autoDecision='manual'] decisão aplicada após `decisionAfterPolls` consultas de status
 * @param {number} [opts.decisionAfterPolls=1]
 * @param {number} [opts.cooldownMs=5000]
 * @param {number} [opts.lutMaxUploadBytes]
 * @param {Map} [opts.clients] cadastro de clientes pareados (compartilhe entre dois fakes para simular o mesmo aparelho)
 * @param {string} [opts.code] código fixo (padrão: aleatório de 4 dígitos)
 * @param {number} [opts.port=0]
 */
async function createFakePhone(opts = {}) {
  const info = {
    deviceName: opts.deviceName || 'Scorpio',
    deviceModel: opts.deviceModel || 'SM-A515F',
    appVersion: '1.0.0'
  };
  const cooldownMs = opts.cooldownMs ?? RETRY_COOLDOWN_MS;
  const lutMax = opts.lutMaxUploadBytes ?? LUT_MAX_UPLOAD_BYTES;

  const media = new Map();
  for (const m of opts.media || []) {
    const content = Buffer.isBuffer(m.content) ? m.content : Buffer.from(m.content ?? `video:${m.id}`);
    media.set(m.id, { id: m.id, filename: m.filename, content, duration: m.duration ?? 12.5, createdAt: m.createdAt || '2026-10-01T12:00:00Z' });
  }
  const luts = new Map(); // relativePath -> Buffer
  for (const l of opts.luts || []) luts.set(l.relativePath, Buffer.isBuffer(l.content) ? l.content : Buffer.from(l.content));

  const requests = new Map();   // id -> pedido
  const clients = opts.clients || new Map(); // sha256(token) -> { clientId, name, pairedAtMs } (compartilhável entre fakes)
  const lastRejectedAt = new Map();
  const log = [];               // { method, path, authorized } (nunca guarda token)
  const phone = {
    info, log, requests, clients, media, luts,
    autoDecision: opts.autoDecision || 'manual',
    decisionAfterPolls: opts.decisionAfterPolls ?? 1,
    pairRequestCount: 0,
    port: 0,
    url: '',
    /** Aprovação do operador no celular. */
    approve(id) {
      const r = requests.get(id);
      if (!r || r.state !== 'PENDING') return false;
      const token = hex(32);
      for (const [h, c] of clients) if (c.clientId === r.clientId) clients.delete(h); // um token por clientId
      clients.set(sha256(token), { clientId: r.clientId, name: r.clientName, pairedAtMs: Date.now() });
      r.state = 'APPROVED';
      r.token = token;
      return true;
    },
    deny(id) {
      const r = requests.get(id);
      if (!r || r.state !== 'PENDING') return false;
      r.state = 'DENIED';
      lastRejectedAt.set(r.remoteAddress, Date.now());
      return true;
    },
    expire(id) {
      const r = requests.get(id);
      if (!r || r.state !== 'PENDING') return false;
      r.state = 'EXPIRED';
      lastRejectedAt.set(r.remoteAddress, Date.now());
      return true;
    },
    /** Revoga todos os clientes (token deixa de valer: 401). */
    revokeAll() { clients.clear(); },
    pending() { return [...requests.values()].filter((r) => r.state === 'PENDING'); },
    close() {
      return new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    }
  };

  const isAuthorized = (token) => {
    if (!token || token.length > 128) return false;
    return clients.has(sha256(token));
  };
  const bearer = (req, url) => {
    const h = req.headers.authorization;
    if (h && /^bearer /i.test(h)) return h.slice(7).trim();
    return url.searchParams.get('token');
  };
  const remote = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  const expireOld = () => {
    const now = Date.now();
    for (const r of requests.values()) {
      if (r.state === 'PENDING' && now - r.createdAtMs > PAIR_TTL_MS) { r.state = 'EXPIRED'; lastRejectedAt.set(r.remoteAddress, now); }
    }
  };

  const text = (res, status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  const json = (res, status, obj) => text(res, status, JSON.stringify(obj), 'application/json');
  const empty = (res, status) => { res.writeHead(status, { 'Content-Length': 0 }); res.end(); };

  const readBody = (req, max) => new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (c) => {
      total += c.length;
      if (total > max) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });

  const mediaDto = (m) => ({
    id: m.id, filename: m.filename, filesize: m.content.length, duration: m.duration,
    width: 1920, height: 1080, fps: 30, codec: 'h264', createdAt: m.createdAt
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const p = url.pathname;
    const token = bearer(req, url);
    const open = p.startsWith('/api/pair/') || p === '/api/discovery/info';
    const authorized = isAuthorized(token);
    log.push({ method: req.method, path: p, authorized });

    if (!p.startsWith('/api/')) return empty(res, 404);
    if (!open && !authorized) return text(res, 401, 'Pairing required');

    // ---- descoberta e pareamento ----
    if (p === '/api/discovery/info' && req.method === 'GET') {
      if (authorized) {
        return json(res, 200, { ...info, batteryLevel: 87, totalStorageBytes: 128 * 1024 ** 3, freeStorageBytes: 64 * 1024 ** 3, isCharging: false });
      }
      return json(res, 200, { ...info, authRequired: true });
    }

    if (p === '/api/pair/request' && req.method === 'POST') {
      const len = Number(req.headers['content-length'] || 0);
      if (len > PAIR_MAX_BODY_BYTES) { req.resume(); return empty(res, 413); }
      const raw = await readBody(req, PAIR_MAX_BODY_BYTES);
      if (!raw) return empty(res, 413);
      let obj;
      try { obj = JSON.parse(raw.toString('utf8')); if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('obj'); } catch (_) { return text(res, 400, 'Invalid JSON'); }
      expireOld();
      const now = Date.now();
      const addr = remote(req);
      const active = [...requests.values()].filter((r) => r.state === 'PENDING');
      const rejected = lastRejectedAt.get(addr);
      if (active.length >= MAX_PENDING || active.some((r) => r.remoteAddress === addr) || (rejected != null && now - rejected < cooldownMs)) {
        return text(res, 429, 'Pending pairing request exists');
      }
      const clientId = String(obj.clientId ?? '').replace(/[^A-Za-z0-9\-_.:]/g, '').slice(0, 64) || hex(8);
      const clientName = String(obj.clientName ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Cliente desconhecido';
      const r = {
        id: hex(12), clientId, clientName, remoteAddress: addr, createdAtMs: now, state: 'PENDING', token: null,
        code: opts.code || String(crypto.randomInt(0, 10000)).padStart(4, '0'), polls: 0
      };
      requests.set(r.id, r);
      phone.pairRequestCount++;
      return json(res, 200, { requestId: r.id, code: r.code, expiresInSec: 90 });
    }

    const statusMatch = /^\/api\/pair\/status\/([^/]+)$/.exec(p);
    if (statusMatch && req.method === 'GET') {
      expireOld();
      const r = requests.get(decodeURIComponent(statusMatch[1]));
      if (!r || r.remoteAddress !== remote(req)) return empty(res, 404);
      if (r.state === 'PENDING') {
        r.polls++;
        if (phone.autoDecision !== 'manual' && r.polls >= phone.decisionAfterPolls) {
          if (phone.autoDecision === 'approve') phone.approve(r.id);
          else if (phone.autoDecision === 'deny') phone.deny(r.id);
          else phone.expire(r.id);
        }
      }
      const out = { state: r.state };
      if (r.state === 'APPROVED' && r.token) { out.token = r.token; r.token = null; } // o token aparece UMA vez
      return json(res, 200, out);
    }

    // ---- mídia ----
    if (p === '/api/media' && req.method === 'GET') return json(res, 200, [...media.values()].map(mediaDto));

    const dl = /^\/api\/media\/([^/]+)\/download$/.exec(p);
    if (dl && req.method === 'GET') {
      const m = media.get(decodeURIComponent(dl[1]));
      if (!m) return empty(res, 404);
      const length = m.content.length;
      const range = parseRange(req.headers.range, length);
      const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' };
      if (range === 'unsatisfiable') { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${length}`, 'Content-Length': 0 }); return res.end(); }
      if (range === 'full') {
        res.writeHead(200, { ...headers, 'Content-Length': length });
        return res.end(m.content);
      }
      const slice = m.content.subarray(range.start, range.end + 1);
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${length}`, 'Content-Length': slice.length });
      return res.end(slice);
    }

    const th = /^\/api\/media\/([^/]+)\/thumbnail$/.exec(p);
    if (th && req.method === 'GET') {
      if (!media.has(decodeURIComponent(th[1]))) return empty(res, 404);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length });
      return res.end(JPEG);
    }

    const del = /^\/api\/media\/([^/]+)$/.exec(p);
    if (del && req.method === 'DELETE') {
      return media.delete(decodeURIComponent(del[1])) ? empty(res, 200) : empty(res, 404);
    }

    // ---- LUTs ----
    if (p === '/api/luts' && req.method === 'GET') {
      return json(res, 200, [...luts.entries()].map(([relativePath, buf]) => ({
        name: relativePath.split('/').pop(), relativePath, size: buf.length, hash: sha256(buf)
      })));
    }

    if (p === '/api/luts/upload' && req.method === 'POST') {
      const raw = await readBody(req, lutMax + 1024 * 1024);
      if (!raw) return text(res, 413, 'File too large');
      const parts = parseMultipart(raw, req.headers['content-type']);
      if (!parts) return text(res, 400, 'Invalid multipart data');
      let relativePath = '';
      let file = null;
      for (const part of parts) {
        if (part.filename !== undefined) file = part.data;
        else if (part.name === 'relativePath') relativePath = part.data.toString('utf8');
      }
      if (file && file.length > lutMax) return text(res, 413, 'File too large');
      if (!relativePath.trim() || !file) return text(res, 400, 'Missing relativePath or file');
      if (!lutPathValid(relativePath)) return text(res, 400, 'Invalid relativePath');
      const newHash = sha256(file);
      const existing = luts.get(relativePath);
      if (existing && sha256(existing) !== newHash) {
        return json(res, 409, { relativePath, existingHash: sha256(existing), newHash });
      }
      luts.set(relativePath, Buffer.from(file));
      return empty(res, 200);
    }

    if (p.startsWith('/api/luts/') && req.method === 'DELETE') {
      const rel = p.slice('/api/luts/'.length).split('/').map((s) => decodeURIComponent(s)).join('/');
      if (!lutPathValid(rel)) return text(res, 400, 'Invalid path');
      return luts.delete(rel) ? empty(res, 200) : empty(res, 404);
    }

    return empty(res, 404);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', resolve);
  });
  phone.port = server.address().port;
  phone.url = `http://127.0.0.1:${phone.port}`;
  return phone;
}

module.exports = { createFakePhone, parseRange, lutPathValid };

// Uso manual: node tests/fixtures/fake-bdsm-phone.js [porta] [approve|deny|expire]
// (o "operador" aprova/recusa sozinho depois de 3 consultas de status, ~4,5 s). Para o app em desenvolvimento:
//   BDS_TEST_BDSM_PORT=<porta> npx electron .
if (require.main === module) {
  const port = Number(process.argv[2]) || 18080;
  const decision = process.argv[3] || 'approve';
  const luts = [{ relativePath: 'Remota/so-no-celular.cube', content: 'TITLE "remota"\nLUT_3D_SIZE 2\n' }];
  const media = [
    { id: 'rec-001', filename: 'VID_20261001_120000.mp4', content: Buffer.alloc(256 * 1024, 7) },
    { id: 'rec-002', filename: 'VID_20261001_121500.mp4', content: Buffer.alloc(128 * 1024, 9) }
  ];
  createFakePhone({ port, media, luts, autoDecision: decision, decisionAfterPolls: 3 }).then((phone) => {
    console.log(`Celular falso em ${phone.url} (decisão: ${decision})`);
  });
}
