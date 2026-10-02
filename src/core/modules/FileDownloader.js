'use strict';

/**
 * FileDownloader — download robusto de arquivos grandes (modelos, CUDA, motores).
 *
 *  - Segue redirecionamentos (absolutos ou relativos, máx. 5).
 *  - Retoma downloads interrompidos (HTTP Range) a partir do arquivo ".part".
 *  - Calcula o SHA-256 durante o download e confere com o esperado.
 *  - Confere o tamanho final e só então move ".part" para o destino (gravação atômica).
 *  - Cancelável via AbortSignal (o ".part" é mantido para retomar depois).
 *  - Repete automaticamente falhas transitórias (queda, timeout, 5xx), retomando de onde parou.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { createHash } = require('node:crypto');

class DownloadError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const CANCELLED = 'CANCELLED';
const RETRYABLE = new Set(['TIMEOUT', 'INCOMPLETE', 'CHECKSUM', 'RANGE_RESET', 'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'EAI_AGAIN']);

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * Valida o próximo salto de um redirecionamento: bloqueia https -> http e remove
 * cabeçalhos de autenticação quando o host muda.
 * @returns {{ url: string, headers: object }}
 */
function nextHop(fromUrl, location, headers) {
  const next = new URL(location, fromUrl);
  if (fromUrl.protocol === 'https:' && next.protocol !== 'https:') {
    throw new DownloadError('Redirecionamento de HTTPS para HTTP bloqueado.', 'REDIRECT_DOWNGRADE');
  }
  if (next.protocol !== 'https:' && next.protocol !== 'http:') {
    throw new DownloadError('Redirecionamento para protocolo não suportado.', 'BAD_URL');
  }
  let nextHeaders = headers;
  if (next.host !== fromUrl.host) {
    nextHeaders = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (!SENSITIVE_HEADERS.includes(k.toLowerCase())) nextHeaders[k] = v;
    }
  }
  return { url: next.toString(), headers: nextHeaders };
}

function cancelledError() {
  return new DownloadError('Download cancelado.', CANCELLED);
}

/** Alimenta um Hash com o conteúdo de um arquivo, em fluxo. */
function hashInto(hash, filePath, signal) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    const onAbort = () => { stream.destroy(); reject(cancelledError()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); });
  });
}

/** SHA-256 de um arquivo (em fluxo). */
async function sha256File(filePath, signal) {
  const hash = createHash('sha256');
  await hashInto(hash, filePath, signal);
  return hash.digest('hex');
}

/**
 * Uma tentativa de download (com retomada se já existir "<dest>.part").
 * @returns {Promise<{path:string,size:number,sha256:string}>}
 */
async function attemptDownload(opts) {
  const {
    url, dest, expectedSha256 = null, expectedSize = null, onProgress = null, signal = null,
    headers = {}, userAgent = 'BDS-Modules/1.0', maxRedirects = 5, idleTimeoutMs = 30000
  } = opts;

  if (signal && signal.aborted) throw cancelledError();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;

  let existing = 0;
  try { existing = fs.statSync(part).size; } catch (_) { existing = 0; }
  if (expectedSize && existing > expectedSize) { fs.rmSync(part, { force: true }); existing = 0; }

  let hash = createHash('sha256');
  if (existing > 0) await hashInto(hash, part, signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    let activeReq = null;
    let file = null;
    let received = existing;       // bytes já gravados (incluindo os de tentativas anteriores)
    let total = 0;
    let lastEmit = 0;
    const startedAt = Date.now();
    const startBytes = existing;

    const cleanupListeners = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    const settle = (fn, value) => { if (settled) return; settled = true; cleanupListeners(); fn(value); };

    // Falha mantendo o ".part" (para retomar), depois de descarregar o que já foi recebido.
    const failKeepPart = (err) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      try { if (activeReq) activeReq.destroy(); } catch (_) { /* noop */ }
      if (file && !file.destroyed) file.end(() => reject(err)); else reject(err);
    };
    const failDropPart = (err) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      try { if (activeReq) activeReq.destroy(); } catch (_) { /* noop */ }
      const done = () => { try { fs.rmSync(part, { force: true }); } catch (_) { /* noop */ } reject(err); };
      // No Windows o arquivo precisa estar fechado antes de ser apagado.
      if (file && !file.closed) { file.once('close', done); file.destroy(); } else done();
    };

    function onAbort() { failKeepPart(cancelledError()); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const emit = (force) => {
      if (!onProgress) return;
      const now = Date.now();
      if (!force && now - lastEmit < 200) return;
      lastEmit = now;
      const seconds = Math.max((now - startedAt) / 1000, 0.001);
      const speedBps = Math.round((received - startBytes) / seconds);
      onProgress({
        receivedBytes: received,
        totalBytes: total || expectedSize || 0,
        percent: (total || expectedSize) ? Math.min(100, (received / (total || expectedSize)) * 100) : null,
        speedBps
      });
    };

    const finalize = () => {
      const size = received;
      if (total > 0 && size !== total) {
        return failKeepPart(new DownloadError(`Download incompleto (${size} de ${total} bytes).`, 'INCOMPLETE'));
      }
      if (expectedSize && size !== expectedSize) {
        return failDropPart(new DownloadError(`Tamanho inesperado (${size} bytes; esperado ${expectedSize}).`, 'CHECKSUM'));
      }
      const actual = hash.digest('hex');
      if (expectedSha256 && actual.toLowerCase() !== expectedSha256.toLowerCase()) {
        return failDropPart(new DownloadError(
          `SHA-256 diferente do esperado (obtido ${actual.slice(0, 12)}…, esperado ${expectedSha256.slice(0, 12)}…).`, 'CHECKSUM'
        ));
      }
      try {
        fs.rmSync(dest, { force: true });
        fs.renameSync(part, dest);
      } catch (err) {
        return failKeepPart(err);
      }
      emit(true);
      settle(resolve, { path: dest, size, sha256: actual });
    };

    const doGet = (targetUrl, redirects, hopHeaders) => {
      let parsed;
      try { parsed = new URL(targetUrl); } catch (_) { return failKeepPart(new DownloadError('URL de download inválida.', 'BAD_URL')); }
      const client = parsed.protocol === 'http:' ? http : https;
      const reqHeaders = { 'User-Agent': userAgent, ...hopHeaders };
      if (received > 0) reqHeaders.Range = `bytes=${received}-`;

      const req = client.get(parsed, { headers: reqHeaders, timeout: idleTimeoutMs }, (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects >= maxRedirects) return failKeepPart(new DownloadError('Redirecionamentos demais.', 'REDIRECTS'));
          let hop;
          try { hop = nextHop(parsed, res.headers.location, hopHeaders); } catch (err) { return failKeepPart(err); }
          return doGet(hop.url, redirects + 1, hop.headers);
        }

        if (status === 416 && received > 0) {
          res.resume();
          // O servidor não aceita a faixa pedida: recomeça do zero na próxima tentativa.
          return failDropPart(new DownloadError('Faixa de retomada recusada pelo servidor.', 'RANGE_RESET'));
        }

        if (status !== 200 && status !== 206) {
          res.resume();
          return failKeepPart(new DownloadError(`HTTP ${status} ao baixar ${parsed.host}${parsed.pathname}`, `HTTP_${status}`, { status }));
        }

        let flags = 'a';
        if (status === 206) {
          const m = /bytes\s+(\d+)-\d+\/(\d+|\*)/i.exec(res.headers['content-range'] || '');
          const start = m ? parseInt(m[1], 10) : received;
          if (start !== received) return failDropPart(new DownloadError('Resposta de retomada inconsistente.', 'RANGE_RESET'));
          total = m && m[2] !== '*' ? parseInt(m[2], 10) : received + (parseInt(res.headers['content-length'] || '0', 10));
        } else {
          // 200: o servidor ignorou o Range (ou é o primeiro download) — recomeça do zero.
          if (received > 0) { hash = createHash('sha256'); received = 0; }
          flags = 'w';
          total = parseInt(res.headers['content-length'] || '0', 10);
        }

        file = fs.createWriteStream(part, { flags });
        file.on('error', (err) => failKeepPart(err));
        res.on('error', (err) => failKeepPart(new DownloadError(
          `Download incompleto: ${err.message === 'aborted' ? 'a conexão foi encerrada antes do fim.' : err.message}`, 'INCOMPLETE'
        )));
        res.on('data', (chunk) => { received += chunk.length; hash.update(chunk); emit(false); });
        res.on('close', () => {
          if (!res.complete) failKeepPart(new DownloadError('Download incompleto: a conexão foi encerrada antes do fim.', 'INCOMPLETE'));
        });
        // 'close' (e não 'finish'): no Windows o arquivo precisa estar fechado antes do rename.
        file.on('close', () => { if (!settled) finalize(); });
        res.pipe(file);
      });

      activeReq = req;
      req.on('timeout', () => req.destroy(new DownloadError('Tempo esgotado: o servidor parou de responder.', 'TIMEOUT')));
      req.on('error', (err) => failKeepPart(err instanceof DownloadError ? err : new DownloadError(err.message, err.code || 'NETWORK')));
    };

    doGet(url, 0, headers);
  });
}

/**
 * Download com repetição automática de falhas transitórias (retoma de onde parou).
 * @param {object} opts  { url, dest, expectedSha256?, expectedSize?, onProgress?, signal?, headers?, attempts?, backoffMs?, onRetry? }
 */
async function downloadFile(opts) {
  const attempts = opts.attempts || 4;
  const backoffMs = opts.backoffMs ?? 1500;
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await attemptDownload(opts);
    } catch (err) {
      lastError = err;
      if (err.code === CANCELLED) throw err;
      const status = err.status || 0;
      const transient = RETRYABLE.has(err.code) || status >= 500 || status === 408 || status === 429;
      if (!transient || i === attempts) break;
      if (opts.onRetry) opts.onRetry({ attempt: i, error: err });
      await new Promise((r) => setTimeout(r, backoffMs * i));
      if (opts.signal && opts.signal.aborted) throw cancelledError();
    }
  }
  throw lastError;
}

/** GET de JSON (segue redirecionamentos, inclusive relativos). */
function fetchJson(url, { timeoutMs = 15000, headers = {}, maxRedirects = 5, userAgent = 'BDS-Modules/1.0' } = {}) {
  return new Promise((resolve, reject) => {
    const go = (target, redirects, hopHeaders) => {
      let parsed;
      try { parsed = new URL(target); } catch (_) { return reject(new DownloadError('URL inválida.', 'BAD_URL')); }
      const client = parsed.protocol === 'http:' ? http : https;
      const req = client.get(parsed, { headers: { 'User-Agent': userAgent, Accept: 'application/json', ...hopHeaders }, timeout: timeoutMs }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects >= maxRedirects) return reject(new DownloadError('Redirecionamentos demais.', 'REDIRECTS'));
          let hop;
          try { hop = nextHop(parsed, res.headers.location, hopHeaders); } catch (err) { return reject(err); }
          return go(hop.url, redirects + 1, hop.headers);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('error', reject);
        res.on('end', () => {
          if (status !== 200) return reject(new DownloadError(`HTTP ${status} ao consultar ${parsed.host}${parsed.pathname}`, `HTTP_${status}`, { status }));
          try { resolve(JSON.parse(body)); } catch (_) { reject(new DownloadError('Resposta inválida (JSON esperado).', 'BAD_JSON')); }
        });
      });
      req.on('timeout', () => req.destroy(new DownloadError('Tempo esgotado ao consultar o servidor.', 'TIMEOUT')));
      req.on('error', (err) => reject(err instanceof DownloadError ? err : new DownloadError(err.message, err.code || 'NETWORK')));
    };
    go(url, 0, headers);
  });
}

module.exports = { downloadFile, attemptDownload, fetchJson, sha256File, nextHop, DownloadError, CANCELLED };
