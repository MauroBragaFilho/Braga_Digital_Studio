'use strict';

/**
 * redact — remoção de dados pessoais/sensíveis de textos e objetos antes de logar, gravar
 * relatórios de erro ou enviá-los para fora da máquina.
 *
 * Remove/substitui:
 *  - diretório do usuário (os.homedir(), %USERPROFILE%, C:\Users\<nome>, /home/<nome>, /Users/<nome>)
 *  - query strings (e fragmentos) de URLs http(s)
 *  - tokens "Bearer ...", cabeçalhos Authorization
 *  - e-mails (exceto o do desenvolvedor) — varredura linear, sem regex quadrática
 *  - cookie=..., set-cookie: ...
 *  - pares chave=valor de segredos (token, api_key, password, secret ...)
 *  - em objetos (redactDeep): qualquer valor cuja CHAVE tenha nome sensível (password, token,
 *    apiKey, secret, authorization, cookie...), independentemente do formato do valor
 *  - chaves longas (>= 32 caracteres alfanuméricos, exceto hashes hexadecimais — SHA-256 etc.
 *    não são segredos e ajudam no diagnóstico)
 *
 * Entradas de texto acima de MAX_INPUT_CHARS são truncadas antes do processamento (limita o custo
 * no processo principal; um registro de log/relatório legítimo nunca chega perto disso).
 */

const os = require('node:os');

/** Teto de caracteres processados por chamada (~64 KB). */
const MAX_INPUT_CHARS = 64 * 1024;

let developerEmail = '';
try { developerEmail = String(require('../config/appInfo').DEVELOPER_EMAIL || '').toLowerCase(); } catch (_) { /* sem appInfo */ }

/** Nomes de chave cujo valor nunca deve sair da máquina. */
const SENSITIVE_KEY_RE = /pass(?:word|wd|phrase)?$|^pwd$|token|secret|api[_-]?key|apikey|authorization|^cookies?$|set-cookie|credential|private[_-]?key|session[_-]?id/i;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Variantes do diretório home (com \ e /), da mais longa para a mais curta. */
function homeDirVariants() {
  const raw = new Set();
  const add = (p) => { if (p && String(p).length > 3) raw.add(String(p)); };
  try { add(os.homedir()); } catch (_) { /* noop */ }
  add(process.env.USERPROFILE);
  add(process.env.HOME);
  const out = new Set();
  for (const p of raw) {
    out.add(p);
    out.add(p.replace(/\\/g, '/'));
    out.add(p.replace(/\//g, '\\'));
    out.add(p.replace(/\\/g, '\\\\')); // forma escapada em JSON
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function isLocalChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || code === 46 || code === 95 || code === 37 || code === 43 || code === 45; // . _ % + -
}

function isLabelChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45;
}

/**
 * Substitui e-mails por [email] em tempo linear: parte de cada '@' e expande no máximo
 * 64 caracteres à esquerda e 255 à direita (limites do RFC), em vez de uma regex que reavalia
 * a parte local a cada posição (quadrática em textos sem '@').
 */
function redactEmails(text) {
  let at = text.indexOf('@');
  if (at === -1) return text;
  let out = '';
  let last = 0;
  while (at !== -1) {
    let start = at;
    while (start > last && at - start < 64 && isLocalChar(text.charCodeAt(start - 1))) start--;

    let end = at + 1;
    let labels = 0;
    const limit = Math.min(text.length, at + 1 + 255);
    for (;;) {
      const labelStart = end;
      while (end < limit && isLabelChar(text.charCodeAt(end))) end++;
      if (end === labelStart) break;
      labels++;
      if (end < limit - 1 && text.charCodeAt(end) === 46 && isLabelChar(text.charCodeAt(end + 1))) end++;
      else break;
    }

    if (start < at && labels >= 2) {
      const match = text.slice(start, end);
      out += text.slice(last, start);
      out += (developerEmail && match.toLowerCase() === developerEmail) ? match : '[email]';
      last = end;
      at = text.indexOf('@', end);
    } else {
      at = text.indexOf('@', at + 1);
    }
  }
  return out + text.slice(last);
}

/**
 * @param {unknown} input
 * @returns {string} texto sem dados sensíveis (não-strings são convertidas com String())
 */
function redact(input) {
  if (input === null || input === undefined) return input;
  let text = typeof input === 'string' ? input : String(input);
  if (!text) return text;

  let truncatedNote = '';
  if (text.length > MAX_INPUT_CHARS) {
    truncatedNote = `…[truncado: ${text.length - MAX_INPUT_CHARS} caracteres]`;
    text = text.slice(0, MAX_INPUT_CHARS);
  }

  // 1) diretório home exato
  for (const variant of homeDirVariants()) {
    text = text.replace(new RegExp(escapeRegExp(variant), 'gi'), '~');
  }
  // 2) padrões genéricos de pasta de usuário (outras contas/máquinas, caminhos em stacks)
  text = text
    .replace(/([a-zA-Z]:[\\/]+Users[\\/]+)[^\\/\s"'<>|:*?]+/gi, '$1<user>')
    .replace(/(\/(?:home|Users)\/)[^/\s"'<>|:]+/g, '$1<user>');

  // 3) query string e fragmento de URLs
  text = text.replace(/(https?:\/\/[^\s"'<>?#`]+)[?#][^\s"'<>`]*/gi, '$1?[redacted]');

  // 4) Authorization / Bearer
  text = text
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:bearer|basic|token)?\s*[^\s"',;]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');

  // 5) cookies
  text = text.replace(/((?:set-)?cookie["']?\s*[:=]\s*["']?)[^"'\r\n]*/gi, '$1[redacted]');

  // 6) segredos chave=valor
  text = text.replace(
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|passw(?:or)?d|pwd)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    '$1[redacted]'
  );

  // 7) e-mails (exceto o do desenvolvedor)
  text = redactEmails(text);

  // 8) chaves longas (não mexe em hashes hexadecimais)
  text = text.replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) => (/^[0-9a-f]+$/i.test(m) ? m : '[redacted-key]'));

  return text + truncatedNote;
}

/**
 * Cópia profunda de `value` com todas as strings passadas por redact().
 * - Erros viram objetos simples (name/message/stack/code).
 * - Date vira ISO; Buffer/TypedArray viram um marcador com o tamanho; Map/Set viram objeto/array;
 *   URL e RegExp viram string; bigint vira string.
 * - Valores cuja chave tem nome sensível (password, token, apiKey, secret...) são mascarados.
 * - Profundidade limitada e ciclos seguros.
 */
function redactDeep(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.toString();
  if (typeof value !== 'object') return value;

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`;
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
  if (typeof URL !== 'undefined' && value instanceof URL) return redact(value.href);
  if (value instanceof RegExp) return redact(String(value));

  if (depth > 6) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  try {
    if (value instanceof Error) {
      const out = { name: value.name, message: redact(value.message), stack: redact(value.stack || '') };
      if (value.code !== undefined) out.code = redactDeep(value.code, depth + 1, seen);
      return out;
    }
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1, seen));
    if (value instanceof Set) return [...value].map((v) => redactDeep(v, depth + 1, seen));

    const source = value instanceof Map
      ? Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), v]))
      : value;
    const out = {};
    for (const key of Object.keys(source)) {
      const raw = source[key];
      if (SENSITIVE_KEY_RE.test(key) && raw !== null && raw !== undefined && typeof raw !== 'boolean' && typeof raw !== 'number') {
        out[key] = '[redacted]';
      } else {
        out[key] = redactDeep(raw, depth + 1, seen);
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

module.exports = { redact, redactDeep, redactEmails, MAX_INPUT_CHARS };
